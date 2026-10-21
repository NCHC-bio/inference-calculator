import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
// Relative import (not the @nchc/data package): @nchc/data depends on @nchc/core for `pnpm calibrate`,
// so a package-level devDependency back to it would form a workspace cycle.
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import {
  CoreInputError,
  estimateCapacity,
  estimateRequirements,
  explain,
  findFeasibleModels,
  predictMeasurement,
  quantOptions,
  resolveModel,
  resolvePlatform,
  verifyCommand,
  type ModelOverride,
  type QueryInput,
  type RequirementInput,
  type ExplainInput,
  CUSTOM_MODEL_WARNING,
} from '../src/api';
import { excludedOrgOf } from '../src/policy';
import { embeddingParams, expertParamsTotalB, expertsTouchedFraction, kvBytesPerSequence, slidingTransientKvBytes, weightsReadBytes } from '../src/model-math';

// Build the bundle in memory from config/ so the tests do not depend on `pnpm data:build`.
function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
/** vLLM steady-state KV allocation on the catalog's GPUs: 16-token blocks, sliding layers window + 15 (spec §5.1). */
const VLLM_BLOCKS = { blockTokens: 16, slidingExtraTokens: 15 };
const bundle = realBundle();
const realBundleTop = bundle;

/** Paths of every non-finite number (JSON.stringify would silently turn NaN into null). */
function nonFinite(x: unknown, path = '$'): string[] {
  if (typeof x === 'number') return Number.isFinite(x) ? [] : [path];
  if (x && typeof x === 'object') {
    return Object.entries(x).flatMap(([k, v]) => (typeof v === 'function' ? [] : nonFinite(v, `${path}.${k}`)));
  }
  return [];
}

// Llama 3.3 70B is gated and not imported into the catalog -> user override (Task 6 llama70b values).
const llama70b: ModelOverride = {
  name: 'Llama 3.3 70B',
  hfRepo: 'meta-llama/Llama-3.3-70B-Instruct',
  totalParamsB: 70.55,
  layers: 80,
  heads: 64,
  kvHeads: 8,
  headDim: 128,
  hidden: 8192,
  attention: 'gqa',
};
const query: RequirementInput = { model: llama70b, quant: 'fp8', workload: 'assist', speed: 'smooth', users: 15 };
/** The same query on the capacity path, which takes no users (final-review M16). */
const { users: _qUsers, ...capQuery } = query;

describe('estimateRequirements (assist, 15 users, llama70b override FP8, smooth, comm on)', () => {
  const r = estimateRequirements(bundle, query);

  it('best NCHC platform is nano4-h200 with at least 4 GPUs', () => {
    expect(r.best).toBe('nano4-h200');
    expect(r.bestCriterion).toBe('fewest-gpus');
    const h200 = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(h200.expected.ok).toBe(true);
    if (!h200.expected.ok) throw new Error('unreachable');
    expect(h200.expected.gpus).toBeGreaterThanOrEqual(4);
  });
  it('covers every platform in platforms.yaml order', () => {
    expect(r.perPlatform.map((p) => p.platform)).toEqual(Object.keys(bundle.platforms));
  });
  it('GB200 power is null with a note (TDP unverified), not NaN or 0', () => {
    const gb = r.perPlatform.find((p) => p.platform === 'nano4-gb200')!;
    expect(gb.powerKw).toBeNull();
    expect(gb.powerNote).toBe('功耗未查證');
    expect(gb.expected.ok).toBe(true);
  });
  it('H200 power = gpus x TDP / 1000', () => {
    const h = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    if (!h.expected.ok) throw new Error('unreachable');
    expect(h.powerKw).toBeCloseTo((h.expected.gpus * 700) / 1000, 10);
  });
  it('flags estimates and user values; basis carries provenance', () => {
    expect(r.hasEstimate).toBe(true);
    expect(r.hasUser).toBe(true);
    expect(r.dataVersion).toBe(bundle.meta.dataVersion);
    const inTok = r.basis.find((b) => b.path === 'workloads.assist.inputTokens');
    expect(inTok).toMatchObject({ status: 'measured', value: 126180, sourceIds: ['tracelab'] });
    expect(r.basis.find((b) => b.path === 'model.layers')).toMatchObject({ status: 'user', value: 80 });
    expect(r.basis.find((b) => b.path === 'quantization.fp8.kvBytesPerElem')).toMatchObject({ value: 1 });
    expect(r.basis.find((b) => b.path === 'hardware.gb200.tdpW')).toMatchObject({ status: 'unverified', value: null, lecRef: 'D1' });
    // η_bw has no lecture counterpart (lecture-formulas.md A4, B1): no lecRef, the text says it is the calculator's.
    const etaBw = r.basis.find((b) => b.path === 'calibration.nvidia-default.etaBw')!;
    expect(etaBw.lecRef).toBeUndefined();
    expect(etaBw.text).toContain('講義無對應項');
    // Comm values appear only when a chosen shape has tp > 1 (finding 7): H200 uses tp 4 (Ruling R34 tie-break; was 2 × 2).
    const h200 = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(h200.expected.ok && h200.expected.shape.tp).toBe(4);
    expect(r.basis.find((b) => b.path === 'calibration.nvidia-default.allreduceLatencyUs')).toMatchObject({ status: 'estimate' });
    expect(r.basis.find((b) => b.path === 'hardware.h200-sxm.nvlinkBidirGBs')).toMatchObject({ value: 900 });
    // Paths are unique.
    expect(new Set(r.basis.map((b) => b.path)).size).toBe(r.basis.length);
  });
  it('per-platform verify command uses the expected shape and adds the FP8 KV flag', () => {
    const h = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    // assist is an agent workload: generating = max(1, ceil(15 × 0.033)) = 1 (spec §8.3.3).
    expect(h.verifyCommand).toContain('--max-concurrency 1 ');
    expect(h.verifyCommand).toContain('同時在生成的請求數（研究助理類：15 個工作階段');
    // prefix = round(126180 × 0.957) = 120754; random part = 126180 − 120754 = 5426; one prefix per session (final-review I2).
    expect(h.verifyCommand).toContain(
      '--prefix-repetition-prefix-len 120754 --prefix-repetition-suffix-len 5426 --prefix-repetition-num-prefixes 15 --prefix-repetition-output-len 252',
    );
    // 15 prefixes × 10 prompts each.
    expect(h.verifyCommand).toContain('--num-prompts 150');
    expect(h.verifyCommand).toContain('--kv-cache-dtype fp8');
    expect(h.maxConcurrent).toBeGreaterThanOrEqual(15);
  });
  it('result is JSON-safe (no NaN / Infinity)', () => {
    expect(nonFinite(r)).toEqual([]);
  });
  it('catalog model without overrides has hasUser false', () => {
    const c = estimateRequirements(bundle, { ...query, model: 'phi-4', workload: 'chat' });
    expect(c.hasUser).toBe(false);
    expect(c.basis.find((b) => b.path === 'models.phi-4.totalParamsB')).toMatchObject({ status: 'official' });
  });
  it('workload override fields are marked user, the rest keep config provenance', () => {
    const c = estimateRequirements(bundle, { ...query, workload: { base: 'chat', outputTokens: 500 } });
    expect(c.basis.find((b) => b.path === 'workloads.chat.outputTokens')).toMatchObject({ status: 'user', value: 500 });
    expect(c.basis.find((b) => b.path === 'workloads.chat.inputTokens')).toMatchObject({ status: 'measured', value: 1020 });
  });
});

describe('input validation (zod at every entry point)', () => {
  const bad: Array<[string, unknown]> = [
    ['users 0', { ...query, users: 0 }],
    ['users 1.5', { ...query, users: 1.5 }],
    ['users 2e7', { ...query, users: 2e7 }],
    ['users negative', { ...query, users: -3 }],
    ['outputTokens 0', { ...query, workload: { base: 'chat', outputTokens: 0 } }],
    ['cacheHitRate 1', { ...query, workload: { base: 'chat', cacheHitRate: 1 } }],
    ['cacheHitRate negative', { ...query, workload: { base: 'chat', cacheHitRate: -0.1 } }],
    ['speed 0', { ...query, speed: { minTokPerSec: 0, maxTtftSec: 5 } }],
    ['override layers 0', { ...query, model: { ...llama70b, layers: 0 } }],
    ['override NaN', { ...query, model: { ...llama70b, totalParamsB: Number.NaN } }],
  ];
  it.each(bad)('estimateRequirements rejects %s with CoreInputError', (_label, input) => {
    expect(() => estimateRequirements(bundle, input as RequirementInput)).toThrow(CoreInputError);
  });
  it('findFeasibleModels takes no model field (finding 8); unknown keys are rejected, not stripped', () => {
    const base = { quant: 'fp8', workload: 'chat', speed: 'smooth', platform: 'nano4-h200', gpus: 8 };
    expect(() =>
      findFeasibleModels(bundle, { ...base, model: 'phi-4' } as unknown as Parameters<typeof findFeasibleModels>[1]),
    ).toThrow(CoreInputError);
    expect(findFeasibleModels(bundle, base).length).toBe(Object.keys(bundle.models).length);
  });
  it('every entry point rejects unknown top-level keys (a typo must not be silently ignored)', () => {
    const q = { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth' };
    expect(() => estimateRequirements(bundle, { ...q, users: 10, user: 20 } as unknown as RequirementInput)).toThrow(CoreInputError);
    expect(() =>
      estimateCapacity(bundle, { ...q, platform: 'nano4-h200', gpus: 8, gpu: 4 } as unknown as Parameters<typeof estimateCapacity>[1]),
    ).toThrow(CoreInputError);
  });
  it('ModelOverride: layerGroups counts (mamba included) must sum to layers (finding 11)', () => {
    const groups = [
      { kind: 'mamba' as const, count: 70, ssm: { heads: 64, headDim: 64, stateSize: 128 } },
      { kind: 'full' as const, count: 10 },
    ];
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: groups })).not.toThrow();
    const bad = [{ ...groups[0]!, count: 69 }, groups[1]!];
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: bad })).toThrow(CoreInputError);
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: bad })).toThrow(/sum to 79, but layers is 80/);
  });
  it('ModelOverride: heads must be a multiple of kvHeads, for the model and every layer group (review M-4)', () => {
    expect(() => resolveModel(bundle, { ...llama70b, kvHeads: 6 })).toThrow(/heads 64 is not a multiple of kvHeads 6/);
    expect(() => resolveModel(bundle, { ...llama70b, kvHeads: 128 })).toThrow(CoreInputError);
    const groups = [{ kind: 'sliding' as const, count: 40, window: 4096, kvHeads: 3 }, { kind: 'full' as const, count: 40 }];
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: groups })).toThrow(/layerGroups\.0\.kvHeads/);
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: [{ ...groups[0]!, kvHeads: 4 }, groups[1]!] })).not.toThrow();
  });
  it('ModelOverride: MLA with layerGroups or a sliding window is rejected as not supported yet (Ruling R22)', () => {
    const mla = { ...llama70b, attention: 'mla' as const, mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim: 128, vHeadDim: 128 } };
    expect(() => resolveModel(bundle, mla)).not.toThrow();
    expect(() => resolveModel(bundle, { ...mla, slidingWindow: null })).not.toThrow();
    const groups = [{ kind: 'sliding' as const, count: 40, window: 4096 }, { kind: 'full' as const, count: 40 }];
    expect(() => resolveModel(bundle, { ...mla, layerGroups: groups })).toThrow(CoreInputError);
    expect(() => resolveModel(bundle, { ...mla, layerGroups: groups })).toThrow(/architecture combination not supported yet: attention 'mla' with layerGroups/);
    expect(() => resolveModel(bundle, { ...mla, slidingWindow: 4096 })).toThrow(/architecture combination not supported yet: attention 'mla' with a non-null slidingWindow/);
    expect(() => estimateRequirements(bundle, { ...query, model: { ...mla, slidingWindow: 4096 } })).toThrow(CoreInputError);
    // GQA with the same fields stays valid.
    expect(() => resolveModel(bundle, { ...llama70b, layerGroups: groups, slidingWindow: 4096 })).not.toThrow();
  });
  it('the other entry points validate too', () => {
    const b = { ...query, users: 0 };
    expect(() => explain(bundle, b)).toThrow(CoreInputError);
    expect(() => estimateCapacity(bundle, { ...capQuery, platform: 'nano4-h200', gpus: 0 })).toThrow(CoreInputError);
    expect(() => findFeasibleModels(bundle, { ...query, platform: 'nano4-h200', gpus: 1.5 })).toThrow(CoreInputError);
    expect(() => estimateCapacity(bundle, { ...capQuery, platform: 'nano4-h200', gpus: 8, workload: { base: 'chat', cacheHitRate: 1 } })).toThrow(CoreInputError);
  });
  it('estimateRequirements requires users', () => {
    const { users: _u, ...noUsers } = query;
    // The parameter type requires users too (review M-3): the compiler rejects the call below.
    // @ts-expect-error users is required
    expect(() => estimateRequirements(bundle, noUsers)).toThrow(CoreInputError);
    // explain: either the capacity path (platform + gpus) or the requirement path (users).
    // @ts-expect-error neither users nor platform + gpus
    expect(() => explain(bundle, noUsers)).toThrow(CoreInputError);
    const cap: ExplainInput = { ...noUsers, platform: 'nano4-h200', gpus: 8 };
    expect(explain(bundle, cap).basis.length).toBeGreaterThan(0);
  });
  it('every user-input error is a CoreInputError with a code (review M-2)', () => {
    const codeOf = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof CoreInputError ? e.code : `not CoreInputError: ${String(e)}`;
      }
      return 'no throw';
    };
    expect(codeOf(() => estimateRequirements(bundle, { ...query, users: 0 }))).toBe('invalid-input');
    expect(codeOf(() => estimateRequirements(bundle, { ...query, model: 'nope' }))).toBe('unknown-id');
    expect(codeOf(() => estimateRequirements(bundle, { ...query, workload: 'nope' }))).toBe('unknown-id');
    expect(codeOf(() => estimateRequirements(bundle, { ...query, speed: 'nope' }))).toBe('unknown-id');
    expect(codeOf(() => findFeasibleModels(bundle, { workload: 'chat', speed: 'smooth', platform: 'nope', gpus: 1 }))).toBe('unknown-id');
    // A malformed hfRepo is an input-validity error (it protects the verify command).
    expect(codeOf(() => estimateRequirements(bundle, { ...query, model: { ...llama70b, hfRepo: 'deepseek-ai' } }))).toBe('invalid-input');
    try {
      estimateRequirements(bundle, { ...query, users: 0 });
    } catch (e) {
      expect((e as CoreInputError).issues[0]!.path).toEqual(['users']);
    }
  });
  it('unknown ids throw a clear error', () => {
    expect(() => estimateRequirements(bundle, { ...query, quant: 'nope' })).toThrow(/nope/);
    expect(() => estimateRequirements(bundle, { ...query, model: 'nope' })).toThrow(/nope/);
    expect(() => estimateCapacity(bundle, { ...capQuery, platform: 'nope', gpus: 8 })).toThrow(/nope/);
  });
});

describe('custom models are not origin-checked and carry CUSTOM_MODEL_WARNING (spec §2.2)', () => {
  const W = [CUSTOM_MODEL_WARNING];
  it('CUSTOM_MODEL_WARNING has the pinned code and text', () => {
    expect(CUSTOM_MODEL_WARNING.code).toBe('custom-model-supply-chain');
    expect(CUSTOM_MODEL_WARNING.text).toBe('國網中心規定禁止使用紅色供應鏈模型（發表者為中國、香港或澳門組織）。違反規定可能影響您的 iService 帳號，使用後果請用戶自行承擔。');
    expect(CUSTOM_MODEL_WARNING.text).toContain('國網中心規定禁止使用紅色供應鏈模型');
    expect(CUSTOM_MODEL_WARNING.text).toContain('使用後果請用戶自行承擔');
    expect(CUSTOM_MODEL_WARNING.text).not.toMatch(/推薦|建議/);
  });
  it('custom model with CN origin computes and carries the warning', () => {
    const cn = bundle.policy.excludedCountries[0]!;
    expect(cn).toBe('CN');
    const m = { ...llama70b, origin: { developer: 'X', country: cn } };
    const r = estimateRequirements(bundle, { ...query, model: m });
    expect(r.perPlatform.length).toBeGreaterThan(0);
    expect(r.warnings).toEqual(W);
    expect(resolveModel(bundle, m).model.origin).toEqual({ developer: 'X', country: 'CN' });
  });
  it('custom model whose hfRepo owner is in excludedOrgs computes and carries the warning', () => {
    for (const repo of ['Qwen/example-model', 'qwen/example-model']) {
      const m = { ...llama70b, hfRepo: repo };
      expect(estimateCapacity(bundle, { ...capQuery, model: m, platform: 'nano4-h200', gpus: 8 }).warnings, repo).toEqual(W);
      expect(estimateRequirements(bundle, { ...query, model: m }).warnings, repo).toEqual(W);
    }
  });
  it('custom model with US origin or no origin carries the warning', () => {
    const us = { ...llama70b, origin: { developer: 'Y', country: 'US' }, hfRepo: 'someone/fine-tune' };
    for (const m of [us, llama70b]) {
      expect(estimateRequirements(bundle, { ...query, model: m }).warnings).toEqual(W);
      expect(estimateCapacity(bundle, { ...capQuery, model: m, platform: 'nano4-h200', gpus: 8 }).warnings).toEqual(W);
      expect(explain(bundle, { ...query, model: m }).warnings).toEqual(W);
    }
    // The verify command carries it as a comment, since it is copied out on its own.
    const r = estimateRequirements(bundle, { ...query, model: us });
    const withCmd = r.perPlatform.filter((p) => p.verifyCommand !== '');
    expect(withCmd.length).toBeGreaterThan(0);
    for (const p of withCmd) expect(p.verifyCommand.split('\n')[0], p.platform).toBe(`# ${CUSTOM_MODEL_WARNING.text}`);
  });
  it('custom models with HK and MO origin compute and carry the warning', () => {
    expect(bundle.policy.excludedCountries).toContain('HK');
    expect(bundle.policy.excludedCountries).toContain('MO');
    const hk = { ...llama70b, origin: { developer: 'Example Org', country: 'HK' }, hfRepo: 'example-org/model' };
    const mo = { ...llama70b, origin: { developer: 'Example Org', country: 'MO' }, hfRepo: 'example-org/model' };
    for (const m of [hk, mo]) expect(explain(bundle, { ...query, model: m }).warnings).toEqual(W);
  });
  it('catalog models never get the warning', () => {
    const cat = { ...query, model: 'gemma-4-31b-it', quant: 'native' };
    const r = estimateRequirements(bundle, cat);
    expect(r.warnings).toEqual([]);
    for (const p of r.perPlatform) expect(p.verifyCommand).not.toContain(CUSTOM_MODEL_WARNING.text);
    expect(estimateCapacity(bundle, { ...capQuery, model: 'gemma-4-31b-it', quant: 'native', platform: 'nano4-h200', gpus: 8 }).warnings).toEqual([]);
    expect(explain(bundle, cat).warnings).toEqual([]);
    const input = { workload: 'chat', speed: 'ok', users: 10, platform: 'nano4-h200', gpus: 8 };
    for (const f of findFeasibleModels(bundle, input)) expect(f.basis.some((i) => i.text.includes(CUSTOM_MODEL_WARNING.text))).toBe(false);
  });
  it('lineage of a user model is still recorded', () => {
    const m = { ...llama70b, hfRepo: 'someone/fine-tune', baseModel: 'example-org/base', baseOrigin: { developer: 'X', country: 'CN' } };
    expect(resolveModel(bundle, m).model).toMatchObject({ baseModel: 'example-org/base', baseOrigin: { country: 'CN' } });
  });
});

describe('findFeasibleModels', () => {
  it('lists every catalog model x quant (or the one quant asked) with a reason when infeasible', () => {
    const input = { workload: 'chat', speed: 'ok', users: 10, platform: 'mac-mini-m6-32', gpus: 1 };
    const res = findFeasibleModels(bundle, input);
    const models = Object.values(bundle.models);
    const nModels = models.length;
    // Natively quantized checkpoints: their native format only; others: every format vLLM can apply (not nativeOnly).
    const applicable = Object.values(bundle.quantization).filter((q) => !q.vllmServe.nativeOnly).length;
    expect(res.length).toBe(models.reduce((sum, m) => sum + (m.nativeQuant ? 1 : applicable), 0));
    expect(res.some((x) => x.feasible)).toBe(true);
    const bad = res.filter((x) => !x.feasible);
    expect(bad.length).toBeGreaterThan(0);
    // why is the reason code, detail its text (final-review I3).
    expect(bad.every((x) => typeof x.why === 'string' && typeof x.detail === 'string' && x.detail.length > 0)).toBe(true);
    const fp8Only = findFeasibleModels(bundle, { ...input, quant: 'fp8' });
    expect(fp8Only.length).toBe(nModels);
  });
  it('over-budget results say how many GPUs are needed', () => {
    const res = findFeasibleModels(bundle, { quant: 'bf16', workload: 'chat', speed: 'smooth', users: 500, platform: 'nano4-h200', gpus: 1 });
    expect(res.find((x) => x.model === 'gpt-oss-120b')).toMatchObject({ feasible: false });
  });
});

describe('estimateCapacity', () => {
  it('returns expected >= conservative and a shape within the GPU budget', () => {
    const c = estimateCapacity(bundle, { ...capQuery, workload: 'chat', platform: 'nano4-h200', gpus: 8 });
    expect(c.expected.n).toBeGreaterThan(0);
    expect(c.conservative.n).toBeLessThanOrEqual(c.expected.n);
    expect(c.expected.shape!.tp * c.expected.shape!.replicas).toBeLessThanOrEqual(8);
    expect(c.hasUser).toBe(true);
    expect(c.hasEstimate).toBe(true);
    expect(c.basis.some((b) => b.path === 'hardware.h200-sxm.memGB')).toBe(true);
  });
});

describe('explain', () => {
  it('formula citations follow the rewritten lecture doc (review L5)', () => {
    const { formulas } = explain(bundle, query);
    // B5 is only the zero-reuse contrast: nothing cites it any more.
    expect(formulas.some((f) => f.includes('B5'))).toBe(false);
    const moe = formulas.find((f) => f.includes('topK/experts'))!;
    expect(moe).toContain('spec §5.2');
    const step = formulas.find((f) => f.startsWith('decode 單步時間'))!;
    expect(step).toMatch(/通訊時間 \[R-LEC F3, G1\]/);
    expect(step).toContain('t_fixed [R-LEC G2]');
  });
  it('is stateless: same input, equal output', () => {
    const a = explain(bundle, query);
    const b = explain(bundle, query);
    expect(a).toEqual(b);
    expect(a.formulas.some((f) => f.includes('[R-LEC B1'))).toBe(true);
    expect(a.basis.length).toBeGreaterThan(0);
  });
});

describe('resolvePlatform / resolveModel', () => {
  it('replica semantics match the solver stub (per-GPU x tp, eta modes, R3 latency)', () => {
    const { platform: p, basis } = resolvePlatform(bundle, 'nano4-gb200', 'fp8');
    const r = p.replicaFor(4, 'expected');
    expect(r.memBytes).toBe(186e9 * 4);
    expect(r.memBwBytesPerSec).toBe(8e12 * 4);
    expect(r.flopsPerSec).toBe(5000e12 * 4);
    expect(r.etaBw).toBe(0.7);
    expect(p.replicaFor(4, 'conservative').etaBw).toBe(0.55);
    expect(r.allreduceLatencySec).toBeCloseTo(11e-6, 15);
    expect(r.linkBwBytesPerSecPerDir).toBe(900e9);
    expect(p.tdpW).toBeNull();
    expect(basis.some((b) => b.path === 'hardware.gb200.tflops.fp8')).toBe(true);
  });
  it('bf16 compute dtype picks the bf16 peak; Mac falls back to effective', () => {
    expect(resolvePlatform(bundle, 'nano4-h200', 'bf16').platform.replicaFor(1, 'expected').flopsPerSec).toBe(989.5e12);
    const mac = resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8');
    expect(mac.platform.replicaFor(1, 'expected').flopsPerSec / 66.6e12).toBeCloseTo(1, 12);
    expect(mac.platform.replicaFor(1, 'expected').linkBwBytesPerSecPerDir).toBe(0);
    expect(mac.platform.engine).toBe('mlx');
  });
  it('engine comes from the calibration profile, not from which TFLOPS fields exist (review M-6)', () => {
    expect(resolvePlatform(bundle, 'nano4-h200', 'fp8').platform.engine).toBe('vllm');
    expect(resolvePlatform(bundle, 'dgx-spark', 'fp8').platform.engine).toBe('vllm');
    expect(resolvePlatform(bundle, 'mac-mini-m6-32', 'fp8').platform.engine).toBe('mlx');
    const b2: Bundle = structuredClone(bundle);
    b2.calibration['spark-default']!.engine = 'mlx';
    expect(resolvePlatform(b2, 'dgx-spark', 'fp8').platform.engine).toBe('mlx');
  });
  it('t_fixed is in the replica; its basis item appears only when it is non-zero (review L4)', () => {
    const q = { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 10 } as const;
    // Ruling R41: fitted on the NVIDIA fit points (derived); MLX keeps 0.
    expect(resolvePlatform(bundle, 'nano4-h200', 'fp8').platform.replicaFor(1, 'expected').tFixedSec).toBe(0.0029);
    expect(bundle.calibration['nvidia-default']!.tFixedSec).toMatchObject({ value: 0.0029, status: 'derived' });
    expect(bundle.calibration['mac-mlx']!.tFixedSec).toMatchObject({ value: 0, status: 'estimate' });
    const r = estimateRequirements(bundle, q);
    expect(r.basis.find((b) => b.path === 'calibration.nvidia-default.tFixedSec')).toMatchObject({ value: 0.0029, status: 'derived', lecRef: 'G2' });
    const b2: Bundle = structuredClone(bundle);
    b2.calibration['nvidia-default']!.tFixedSec.value = 0;
    expect(estimateRequirements(b2, q).basis.some((b) => b.path === 'calibration.nvidia-default.tFixedSec')).toBe(false);
    expect(r.perPlatform.find((p) => p.platform === 'mac-studio-m5u-512')!.basis.some((b) => b.path.endsWith('.tFixedSec'))).toBe(false);
  });
  it('the per-request TTFT overhead is in the replica; listed only when non-zero and only by TTFT users (Ruling R41)', () => {
    const q = { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 10 } as const;
    const b2: Bundle = structuredClone(bundle);
    b2.calibration['nvidia-default']!.ttftOverheadSec.value = 0;
    expect(estimateRequirements(b2, q).basis.some((b) => b.path.endsWith('.ttftOverheadSec'))).toBe(false);
    b2.calibration['nvidia-default']!.ttftOverheadSec.value = 0.05;
    expect(resolvePlatform(b2, 'nano4-h200', 'fp8').platform.replicaFor(1, 'expected').ttftOverheadSec).toBe(0.05);
    const r = estimateRequirements(b2, q);
    expect(r.basis.find((b) => b.path === 'calibration.nvidia-default.ttftOverheadSec')).toMatchObject({ value: 0.05 });
    const w = { inputTokens: 922, outputTokens: 922, cacheHitRate: 0 };
    const pm = { platform: 'nano5-h200', model: 'phi-4', quant: 'fp8', workload: w, concurrency: 4, tp: 1 } as const;
    b2.calibration['nvidia-default']!.ttftOverheadSec.value = 0;
    const off = predictMeasurement(b2, pm);
    b2.calibration['nvidia-default']!.ttftOverheadSec.value = 0.05;
    const on = predictMeasurement(b2, pm);
    expect(on.ttftSec! - off.ttftSec!).toBeCloseTo(0.05, 12);
    expect(on.decodeTokPerSec).toBe(off.decodeTokPerSec);
  });
  it('throws a clear error when the hardware has no usable peak', () => {
    const broken: Bundle = structuredClone(bundle);
    broken.hardware['h200-sxm']!.tflops = {};
    expect(() => resolvePlatform(broken, 'nano4-h200', 'fp8')).toThrow(/h200-sxm/);
  });
  it('rejects a model whose MoE split gives non-positive active parameters (Ruling R31d)', () => {
    // The removed Nemotron 3.5 Super-VL as imported before Ruling R31: expert formula 1488B vs 124B total.
    const broken: Bundle = structuredClone(bundle);
    broken.models['bad-moe'] = {
      ...structuredClone(bundle.models['phi-4']!),
      id: 'bad-moe',
      totalParamsB: { ...bundle.models['phi-4']!.totalParamsB, value: 124.45 },
      layers: 88,
      hidden: 4096,
      moe: { experts: 512, topK: 22, expertFfnDim: 2688 },
    };
    const q = { model: 'bad-moe', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 1 } as const;
    expect(() => estimateRequirements(broken, q)).toThrow(/bad-moe 的 MoE 參數不合理，啟用參數無法為正/);
    const { users: _q1, ...capQ } = q;
    expect(() => estimateCapacity(broken, { ...capQ, platform: 'nano4-h200', gpus: 8 })).toThrow(/啟用參數/);
    expect(() => findFeasibleModels(broken, { quant: 'fp8', workload: 'chat', speed: 'smooth', platform: 'nano4-h200', gpus: 8 })).toThrow(/啟用參數/);
    expect(() => predictMeasurement(broken, {
      platform: 'nano4-h200', model: 'bad-moe', quant: 'fp8', workload: { inputTokens: 1, outputTokens: 1, cacheHitRate: 0 }, concurrency: 1,
    })).toThrow(/啟用參數/);
    // A hand-built bundle with an MLA + layerGroups model is refused too (Ruling R22).
    const mlaBroken: Bundle = structuredClone(bundle);
    mlaBroken.models['bad-mla'] = {
      ...structuredClone(bundle.models['phi-4']!),
      id: 'bad-mla',
      attention: 'mla',
      mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim: 128, vHeadDim: 128 },
      slidingWindow: 4096,
    };
    expect(() => estimateRequirements(mlaBroken, { ...q, model: 'bad-mla' })).toThrow(/bad-mla 的架構組合尚未支援/);
  });
  it('override MoE check uses the shared core formula (expert parameters > total → CoreInputError)', () => {
    const bad = { ...llama70b, totalParamsB: 124.45, layers: 88, hidden: 4096, moe: { experts: 512, topK: 22, expertFfnDim: 2688 } };
    expect(() => resolveModel(bundle, bad)).toThrow(CoreInputError);
    expect(() => resolveModel(bundle, bad)).toThrow(/expert parameters 1488\.2B/);
    const ok = { ...llama70b, totalParamsB: 116.83, layers: 36, hidden: 2880, moe: { experts: 128, topK: 4, expertFfnDim: 2880 } };
    expect(() => resolveModel(bundle, ok)).not.toThrow();
  });
  it('override values are all status user', () => {
    const { basis } = resolveModel(bundle, llama70b);
    expect(basis.length).toBeGreaterThan(0);
    expect(basis.every((b) => b.status === 'user')).toBe(true);
  });
});

describe('verifyCommand', () => {
  const m = { ...resolveModel(bundle, 'phi-4').model };
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const q = (id: string) => bundle.quantization[id]!;
  const fp8 = { quant: q('fp8') };
  const bf16 = { quant: q('bf16') };
  const awq = { quant: q('int4-awq') };
  const serveLine = (cmd: string) => cmd.split('\n').find((l) => l.startsWith('vllm serve '))!;
  it('builds a vLLM bench command', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 15, bf16);
    expect(cmd).toContain('--tensor-parallel-size 2');
    expect(cmd).toContain('--max-concurrency 15');
    expect(cmd).toContain('--model microsoft/phi-4');
    expect(cmd).toContain('--random-input-len 1020');
    expect(cmd).toContain('--random-output-len 129');
    expect(cmd).toContain('--num-prompts 150');
    expect(serveLine(cmd)).not.toContain('--kv-cache-dtype');
    expect(verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 3, fp8)).toContain('--num-prompts 100');
    expect(verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 3, fp8)).toContain('--kv-cache-dtype fp8');
  });
  it('fp8: vLLM online dynamic FP8 of the BF16 repo, FP8 KV, memUtil and max-model-len pinned', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 15, fp8);
    // max-model-len = 1020 + 129 = 1149; memUtil = calibration nvidia-default (0.9).
    expect(serveLine(cmd)).toBe(
      'vllm serve microsoft/phi-4 --tensor-parallel-size 2 --quantization fp8_per_tensor --kv-cache-dtype fp8 --gpu-memory-utilization 0.92 --max-model-len 1149 --max-num-batched-tokens 8192',
    );
    expect(bundle.calibration['nvidia-default']!.memUtil.value).toBe(0.92);
    expect(cmd).toContain('# FP8 = vLLM 線上動態量化');
    expect(cmd).toContain('--max-model-len 1149 = 估算所用的上下文（輸入 1020 + 輸出 129）');
  });
  it('bf16: --dtype bfloat16, no FP8 KV', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 15, bf16);
    expect(serveLine(cmd)).toBe(
      'vllm serve microsoft/phi-4 --tensor-parallel-size 1 --dtype bfloat16 --gpu-memory-utilization 0.92 --max-model-len 1149 --max-num-batched-tokens 8192',
    );
  });
  it('int4-awq: an explicit AWQ placeholder (never the BF16 repo) and a note to replace it', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 15, awq);
    expect(serveLine(cmd)).toBe(
      'vllm serve <AWQ checkpoint of microsoft/phi-4> --tensor-parallel-size 1 --quantization awq --gpu-memory-utilization 0.92 --max-model-len 1149 --max-num-batched-tokens 8192',
    );
    expect(cmd).toContain('vllm bench serve --model <AWQ checkpoint of microsoft/phi-4> ');
    expect(cmd).toContain('# INT4（AWQ）：vLLM 不會線上轉成 AWQ，請把 <AWQ checkpoint of …> 換成');
    expect(cmd).not.toContain('vllm serve microsoft/phi-4');
  });
  it('int4-awq without hfRepo: one placeholder, not a placeholder nested in another (review M-9)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    const { hfRepo: _r, ...noRepo } = m;
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, noRepo, w, 15, awq);
    expect(serveLine(cmd)).toMatch(/^vllm serve <AWQ checkpoint of 模型路徑> /);
    expect(cmd).not.toContain('<<');
    expect(cmd).not.toContain('>>');
    expect(serveLine(verifyCommand(platform, { tp: 1, replicas: 1 }, noRepo, w, 15, bf16))).toMatch(/^vllm serve <模型路徑> /);
  });
  it('max-model-len = input + output of the (possibly overridden) workload, through estimateRequirements', () => {
    const r = estimateRequirements(bundle, { model: 'phi-4', quant: 'fp8', workload: { base: 'chat', inputTokens: 3000, outputTokens: 500 }, speed: 'smooth', users: 2 });
    const h = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    // 3000 + 500 + the workloads.yaml benchmark margin (256).
    expect(bundle.benchmark.maxModelLenMarginTokens.value).toBe(256);
    expect(h.verifyCommand).toContain('--max-model-len 3756');
    expect(h.verifyCommand).toContain('--max-model-len 3756 = 估算所用的上下文（輸入 3000 + 輸出 500） + 餘裕 256 token');
    expect(r.basis.find((b) => b.path === 'benchmark.maxModelLenMarginTokens')).toMatchObject({ status: 'estimate', value: 256 });
    expect(h.verifyCommand).toContain('--quantization fp8_per_tensor');
    expect(h.verifyCommand).toContain('--gpu-memory-utilization 0.92 ');
  });
  it('Mac gets an mlx_lm based instruction with the same parameters and states the assumptions', () => {
    const { platform } = resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 4, { ...fp8, kvBytesPerElem: 2 });
    expect(cmd).toContain('mlx_lm');
    expect(cmd).toContain('--max-concurrency 4');
    expect(cmd).toContain('--random-input-len 1020');
    // mac-mlx profile: memUtil 0.75; MLX keeps KV at 2 bytes (Ruling R32).
    expect(cmd).toContain('# mlx_lm.server 沒有量化、記憶體比例、上下文長度等啟動參數；本估算假設：權重為 FP8（每參數 1 bytes');
    expect(cmd).toContain('KV cache 每元素 2 bytes、可用記憶體 = 實體記憶體 × 0.75、每個請求的上下文 1149 token（輸入 1020 + 輸出 129）');
    expect(cmd).not.toContain('--gpu-memory-utilization');
    expect(cmd).not.toContain('--quantization');
    expect(cmd).not.toContain('vllm serve');
  });
  it('chat: --max-concurrency = N and the comment says so; no prefix flag at hit rate 0', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 40, { ...fp8, kind: 'chat', agentShare: 0.033 });
    expect(cmd).toContain('# --max-concurrency 40 = 同時在生成的人數（對話類：40 人都在生成）');
    expect(cmd).toContain('--max-concurrency 40 --dataset-name random --random-input-len 1020 --random-output-len 129 --num-prompts 400');
    expect(cmd).not.toContain('--random-prefix-len');
  });
  it('agent: --max-concurrency = ceil(N × share); one prefix of round(input × hit) per resident session (final-review I2)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const aw = { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 };
    // A 128k-context model: phi-4 (16k) cannot take the assist context (review C3).
    const long = bundle.models['mistral-small-3.1-24b-instruct-2503']!;
    const cmd = verifyCommand(platform, { tp: 2, replicas: 1 }, long, aw, 100, { ...fp8, kind: 'agent', agentShare: 0.033 });
    // ceil(100 × 0.033) = 4 generating; 100 resident sessions, each with its own cached prefix.
    expect(cmd).toContain(
      '--max-concurrency 4 --dataset-name prefix_repetition --prefix-repetition-prefix-len 120754 --prefix-repetition-suffix-len 5426' +
        ' --prefix-repetition-num-prefixes 100 --prefix-repetition-output-len 252 --ignore-eos --num-prompts 1000',
    );
    expect(cmd).not.toContain('--random-prefix-len');
    expect(cmd).toContain('100 個工作階段 × 同時生成比例 0.033');
    // The note says what is and is not reproduced, and how to warm the cache.
    expect(cmd).toContain('暖機');
    expect(cmd).toContain('未重現');
    // The context includes the prefix: 126180 + 252.
    expect(cmd).toContain('--max-model-len 126432');
    const mac = resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform;
    expect(verifyCommand(mac, { tp: 1, replicas: 1 }, long, aw, 100, { ...fp8, kind: 'agent', agentShare: 0.033 })).toContain(
      '--prefix-repetition-num-prefixes 100',
    );
  });
  it('several replicas: prefixes and concurrency are the replica share; num-prompts is a multiple of the prefixes (final-review I2)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const aw = { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 };
    const long = bundle.models['mistral-small-3.1-24b-instruct-2503']!;
    const cmd = verifyCommand(platform, { tp: 2, replicas: 3 }, long, aw, 1000, { ...fp8, kind: 'agent', agentShare: 0.033 });
    // 1000 sessions → 334 per replica; ceil(1000 × 0.033) = 33 generating → 11 per replica.
    expect(cmd).toContain('--max-concurrency 11 --dataset-name prefix_repetition');
    expect(cmd).toContain('--prefix-repetition-num-prefixes 334 ');
    expect(cmd).toContain('--num-prompts 3340');
  });
  it('chat with a cache hit rate: one prefix per user; agent without one: random dataset and a note on the idle sessions', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const chatHit = verifyCommand(platform, { tp: 1, replicas: 1 }, m, { ...w, cacheHitRate: 0.5 }, 40, { ...fp8, kind: 'chat', agentShare: 0.033 });
    expect(chatHit).toContain('--dataset-name prefix_repetition --prefix-repetition-prefix-len 510 --prefix-repetition-suffix-len 510 --prefix-repetition-num-prefixes 40 ');
    const agentNoHit = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 100, { ...fp8, kind: 'agent', agentShare: 0.033 });
    expect(agentNoHit).toContain('--dataset-name random');
    expect(agentNoHit).toContain('閒置');
  });
});

describe('basis lists only values used (finding 7)', () => {
  it('capacity path has no TDP; a tp 1 shape has no NVLink / all-reduce latency', () => {
    const c = estimateCapacity(bundle, { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', platform: 'nano4-h200', gpus: 1 });
    expect(c.expected.shape?.tp).toBe(1);
    expect(c.basis.some((b) => b.path.endsWith('.tdpW'))).toBe(false);
    expect(c.basis.some((b) => b.path.endsWith('nvlinkBidirGBs') || b.path.endsWith('allreduceLatencyUs'))).toBe(false);
  });
  it('a tp > 1 shape lists them, unless includeComm is off', () => {
    const q = { model: llama70b, quant: 'bf16', workload: 'chat', speed: 'smooth', platform: 'nano4-h200', gpus: 2 } as const;
    const on = estimateCapacity(bundle, q);
    expect(on.expected.shape?.tp).toBe(2);
    expect(on.basis.some((b) => b.path === 'hardware.h200-sxm.nvlinkBidirGBs')).toBe(true);
    expect(on.basis.some((b) => b.path === 'calibration.nvidia-default.allreduceLatencyUs')).toBe(true);
    const off = estimateCapacity(bundle, { ...q, includeComm: false });
    expect(off.basis.some((b) => b.path.endsWith('nvlinkBidirGBs') || b.path.endsWith('allreduceLatencyUs'))).toBe(false);
  });
  it('requirement path lists TDP for feasible platforms (power computed or unverified)', () => {
    const r = estimateRequirements(bundle, { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 1 });
    expect(r.basis.find((b) => b.path === 'hardware.h200-sxm.tdpW')).toMatchObject({ value: 700, lecRef: 'D1' });
    expect(r.basis.some((b) => b.path.endsWith('nvlinkBidirGBs'))).toBe(false);
  });
});

describe('no runnable verify command when the weights do not fit (finding 9)', () => {
  it("expected.why === 'weights' → verifyCommand '' with a verifyNote", () => {
    // OLMo 2 32B BF16 (an unquantized checkpoint): 64 GB of weights do not fit a 32 GB Mac mini.
    const r = estimateRequirements(bundle, { model: 'olmo-2-0325-32b', quant: 'bf16', workload: 'chat', speed: 'ok', users: 1 });
    const m6 = r.perPlatform.find((p) => p.platform === 'mac-mini-m6-32')!;
    expect(m6.expected).toMatchObject({ ok: false, why: 'weights' });
    expect(m6.verifyCommand).toBe('');
    expect(m6.verifyNote).toContain('沒有可執行的驗證指令');
    expect(m6.powerNote).toBe('沒有可行配置，未計算功耗');
    const h200 = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(h200.verifyCommand).not.toBe('');
    expect(h200.verifyNote).toBeUndefined();
  });
});

describe('predictMeasurement (calibration, spec §10.1)', () => {
  const wl = { inputTokens: 8192, outputTokens: 128, cacheHitRate: 0 };

  it('predicts decode tok/s, TTFT and memory capacity on the smallest TP whose weights fit', () => {
    const p = predictMeasurement(bundle, {
      platform: 'mac-studio-m5u-512', model: 'mistral-medium-3.5-128b', quant: 'fp8', workload: wl, concurrency: 1,
    });
    expect(p.shape).toEqual({ tp: 1, replicas: 1 });
    expect(p.decodeTokPerSec).toBeCloseTo(1 / p.step!.stepSec, 9);
    expect(p.bound).toBe(p.step!.bwSec >= p.step!.computeSec ? 'bw' : 'compute');
    expect(p.ttftSec).toBeGreaterThan(0);
    expect(p.maxConcurrent).toBeGreaterThan(1);
    expect(p.basis.some((b) => b.path === 'calibration.mac-mlx.etaBw')).toBe(true);
    expect(p.why).toBeNull();
    // n = 1: no prefill interference (Ruling R29), so the step is bandwidth-bound.
    expect(p.bound).toBe('bw');
    expect(nonFinite(p)).toEqual([]);
  });

  it('returns null predictions when the weights fit on no single-node shape', () => {
    const p = predictMeasurement(bundle, {
      platform: 'mac-mini-m6-32', model: 'mistral-medium-3.5-128b', quant: 'bf16', workload: wl, concurrency: 1,
    });
    expect(p).toMatchObject({ shape: null, decodeTokPerSec: null, ttftSec: null, maxConcurrent: null, bound: null, why: 'weights' });
  });

  it("flags 'mem' when the benchmark's concurrency does not fit beside the weights", () => {
    const p = predictMeasurement(bundle, {
      platform: 'mac-studio-m5u-512', model: 'mistral-medium-3.5-128b', quant: 'fp8', workload: wl, concurrency: 100000,
    });
    expect(p.why).toBe('mem');
    expect(p.maxConcurrent).toBeLessThan(100000);
  });

  it("evaluates the benchmark's own tp (one replica) instead of the smallest TP that fits", () => {
    const w = { inputTokens: 922, outputTokens: 922, cacheHitRate: 0 };
    const base = { platform: 'nano5-h100', model: 'gpt-oss-120b', quant: 'native', workload: w, concurrency: 4 } as const;
    const auto = predictMeasurement(bundle, base);
    expect(auto.shape).toEqual({ tp: 1, replicas: 1 });
    const two = predictMeasurement(bundle, { ...base, tp: 2 });
    expect(two.shape).toEqual({ tp: 2, replicas: 1 });
    // TP > 1 pays the all-reduce (spec §5.4); the basis lists the latency it used.
    expect(two.step!.commSec).toBeGreaterThan(0);
    expect(two.basis.some((b) => b.path === 'calibration.nvidia-default.allreduceLatencyUs')).toBe(true);
    expect(two.decodeTokPerSec).not.toBeCloseTo(auto.decodeTokPerSec!, 3);
    // tp 1 given explicitly is the same evaluation as the default here.
    expect(predictMeasurement(bundle, { ...base, tp: 1 })).toEqual(auto);
  });

  it('closed loop at B = concurrency: above the per-step budget the TTFT carries the queueing wait (Ruling R36)', () => {
    // 8192 / (1 + 8000 / 100) → decodingMax 101 < 400 concurrent requests, so 299 wait.
    const w = { inputTokens: 8000, outputTokens: 100, cacheHitRate: 0 };
    const p = predictMeasurement(bundle, { platform: 'nano5-h200', model: 'gpt-oss-120b', quant: 'native', workload: w, concurrency: 400, tp: 1 });
    const free = predictMeasurement(bundle, { platform: 'nano5-h200', model: 'gpt-oss-120b', quant: 'native', workload: w, concurrency: 101, tp: 1 });
    expect(p.decodeTokPerSec).toBeCloseTo(free.decodeTokPerSec!, 9);
    expect(p.ttftSec! - free.ttftSec!).toBeCloseTo((299 * 100) / (101 * free.decodeTokPerSec!), 6);
    expect(p.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(true);
  });

  it('rejects a tp the platform or the model does not allow (CoreInputError)', () => {
    const w = { inputTokens: 922, outputTokens: 922, cacheHitRate: 0 };
    // Mac platforms offer tp 1 only.
    expect(() => predictMeasurement(bundle, { platform: 'mac-studio-m5u-512', model: 'gpt-oss-120b', quant: 'native', workload: w, concurrency: 1, tp: 2 }))
      .toThrow(CoreInputError);
    // phi-4 has 40 heads / 10 KV heads: tp 8 divides neither (vLLM refuses it).
    expect(() => predictMeasurement(bundle, { platform: 'nano5-h100', model: 'phi-4', quant: 'fp8', workload: w, concurrency: 1, tp: 8 }))
      .toThrow(/tp 8/);
    expect(() => predictMeasurement(bundle, { platform: 'nano5-h100', model: 'phi-4', quant: 'fp8', workload: w, concurrency: 1, tp: 3 }))
      .toThrow(CoreInputError);
  });

  it("reports why 'weights' (no prediction) when the given tp cannot hold the weights", () => {
    const w = { inputTokens: 922, outputTokens: 922, cacheHitRate: 0 };
    const p = predictMeasurement(bundle, { platform: 'nano5-h100', model: 'mistral-medium-3.5-128b', quant: 'bf16', workload: w, concurrency: 1, tp: 1 });
    expect(p).toMatchObject({ shape: null, decodeTokPerSec: null, ttftSec: null, why: 'weights' });
  });

  it('rejects invalid input', () => {
    const base = { platform: 'dgx-spark', model: 'mistral-small-3.1-24b-instruct-2503', quant: 'fp8', workload: wl };
    expect(() => predictMeasurement(bundle, { ...base, concurrency: 0 })).toThrow(CoreInputError);
    expect(() => predictMeasurement(bundle, { ...base, concurrency: 1, workload: { ...wl, outputTokens: 0 } })).toThrow(CoreInputError);
    expect(() => predictMeasurement(bundle, { ...base, concurrency: 1, model: 'no-such' })).toThrow(/未知的模型/);
  });
});

describe('engine-aware KV bytes (Ruling R32)', () => {
  const q = { model: 'mistral-small-3.1-24b-instruct-2503', quant: 'fp8', workload: 'doc', speed: 'ok' } as const;

  it('Mac (MLX) fp8 capacity uses 2 bytes per KV element; the basis names the engine override, not the quant', () => {
    const mac = estimateCapacity(bundle, { ...q, platform: 'mac-studio-m5u-512', gpus: 1 });
    expect(mac.basis.find((b) => b.path === 'calibration.mac-mlx.kvBytesPerElemOverride')).toMatchObject({
      status: 'derived', value: 2, sourceIds: ['mlx-lm-kv-cache', 'mlx-lm-server-kv-bits'],
    });
    expect(mac.basis.some((b) => b.path === 'quantization.fp8.kvBytesPerElem')).toBe(false);

    // Same capacity as a copy of the bundle whose fp8 KV is 2 bytes and has no engine override.
    const noOverride: Bundle = structuredClone(bundle);
    delete noOverride.calibration['mac-mlx']!.kvBytesPerElemOverride;
    noOverride.quantization['fp8']!.kvBytesPerElem.value = 2;
    const ref = estimateCapacity(noOverride, { ...q, platform: 'mac-studio-m5u-512', gpus: 1 });
    expect(mac.expected).toEqual(ref.expected);
    // Memory-only capacity: 2-byte KV fits half as many sequences as the 1-byte KV the quant alone would give.
    const pm = { platform: 'mac-studio-m5u-512', model: q.model, quant: 'fp8', workload: { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 }, concurrency: 1 };
    const two = predictMeasurement(bundle, pm).maxConcurrent!;
    noOverride.quantization['fp8']!.kvBytesPerElem.value = 1;
    const one = predictMeasurement(noOverride, pm).maxConcurrent!;
    expect(two).toBeGreaterThan(0);
    expect(two / one).toBeCloseTo(0.5, 2);
  });

  it('NVIDIA platforms keep the quantization value (fp8 KV = 1 byte, vLLM --kv-cache-dtype fp8)', () => {
    const h = estimateCapacity(bundle, { ...q, platform: 'nano4-h200', gpus: 8 });
    expect(h.basis.find((b) => b.path === 'quantization.fp8.kvBytesPerElem')).toMatchObject({ value: 1 });
    expect(h.basis.some((b) => b.path.endsWith('kvBytesPerElemOverride'))).toBe(false);
  });

  it('estimateRequirements lists both when NVIDIA and Mac platforms are evaluated; predictMeasurement on Mac uses 2', () => {
    const r = estimateRequirements(bundle, { ...q, users: 5 });
    expect(r.basis.some((b) => b.path === 'quantization.fp8.kvBytesPerElem')).toBe(true);
    expect(r.basis.some((b) => b.path === 'calibration.mac-mlx.kvBytesPerElemOverride')).toBe(true);
    const p = predictMeasurement(bundle, {
      platform: 'mac-studio-m5u-512', model: q.model, quant: 'fp8', workload: { inputTokens: 8192, outputTokens: 128, cacheHitRate: 0 }, concurrency: 1,
    });
    expect(p.basis.some((b) => b.path === 'calibration.mac-mlx.kvBytesPerElemOverride')).toBe(true);
    expect(p.basis.some((b) => b.path === 'quantization.fp8.kvBytesPerElem')).toBe(false);
  });
});

describe('native quantization (Model.nativeQuant)', () => {
  const chat = { workload: 'chat', speed: 'smooth', users: 10 } as const;
  const serveLine = (cmd: string) => cmd.split('\n').find((l) => l.startsWith('vllm serve '))!;
  const h200 = (r: { perPlatform: Array<{ platform: string; verifyCommand: string; verifyNote?: string }> }) =>
    r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
  const GPT_OSS_BYTES = 65248893184;

  it("gpt-oss-120b native ('native' and 'mxfp4'): weights = the checkpoint's exact bytes, experts split out exactly", () => {
    const r = estimateRequirements(bundle, { model: 'gpt-oss-120b', quant: 'native', ...chat });
    expect(r.quant).toBe('mxfp4');
    expect(r.nativeQuant).toEqual({ method: 'mxfp4', quant: 'mxfp4', checkpointWeightBytes: GPT_OSS_BYTES });
    expect(r.requiresRequantizedCheckpoint).toBeUndefined();
    expect(r.basis.find((b) => b.path === 'models.gpt-oss-120b.nativeQuant.checkpointWeightBytes'))
      .toMatchObject({ status: 'official', value: GPT_OSS_BYTES, sourceIds: ['hf:openai/gpt-oss-120b@b5c939d'] });
    // Experts = expert params × MXFP4 bytes/param; the rest of the checkpoint is the BF16 non-expert part (review:
    // the average 0.56 B/param under-read the BF16 attention ~1.9x at low concurrency).
    const expertBytes = 114.6617856e9 * 0.53125;
    const ex = r.basis.find((b) => b.path === 'models.gpt-oss-120b.nativeQuant.expertBytes')!;
    expect(ex).toMatchObject({ status: 'derived' });
    expect(ex.value as number).toBeCloseTo(expertBytes, 0);
    expect(r.basis.some((b) => b.path === 'quantization.mxfp4.bytesPerParam')).toBe(true);
    // Non-expert bytes ≈ 2 bytes per non-expert parameter (BF16): (65.25 − 60.91) GB over 2.17 B params.
    expect((GPT_OSS_BYTES - expertBytes) / ((116.829156672 - 114.6617856) * 1e9)).toBeCloseTo(2.0, 1);
    const explicit = estimateRequirements(bundle, { model: 'gpt-oss-120b', quant: 'mxfp4', ...chat });
    expect(explicit.perPlatform).toEqual(r.perPlatform);
  });

  it('native weight memory and MoE read bytes enter the solver exactly', () => {
    const wl = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
    const p = predictMeasurement(bundle, { platform: 'nano4-h200', model: 'gpt-oss-120b', quant: 'native', workload: wl, concurrency: 1 });
    const m = bundle.models['gpt-oss-120b']!;
    const rep = resolvePlatform(bundle, 'nano4-h200', 'bf16').platform.replicaFor(p.shape!.tp, 'expected');
    // Capacity: sliding layers hold the window per sequence; the in-flight chunks (2 × 8192 on H200) are reserved once
    // per replica (review L9 fix).
    const ctxTok = wl.inputTokens + wl.outputTokens;
    const kv = kvBytesPerSequence(m, ctxTok, 2, 1, VLLM_BLOCKS);
    const reserve = slidingTransientKvBytes(m, ctxTok, 2 * 8192, 2, 1);
    expect(p.maxConcurrent).toBe(Math.floor((rep.memBytes * rep.memUtil - GPT_OSS_BYTES - reserve) / kv));
    const expert = expertParamsTotalB(m) * 1e9 * 0.53125;
    // The BF16 input embedding (201088 × 2880 × 2 B) is read only by the one row a decode token looks up (Ruling R39).
    const inEmb = 201088 * 2880 * 2;
    const read = GPT_OSS_BYTES - expert + expert * expertsTouchedFraction(128, 4, 1) - inEmb + 2880 * 2;
    const bw = (read + kvBytesPerSequence(m, wl.inputTokens + wl.outputTokens / 2, 2)) / (rep.memBwBytesPerSec * rep.etaBw);
    // About 1.9x the old average-bytes read (review); 1.76x once both sides read only the embedding rows (Ruling R39).
    const avg = GPT_OSS_BYTES / (m.totalParamsB.value * 1e9);
    expect(read / weightsReadBytes(m, avg, 1)).toBeCloseTo(1.76, 1);
    expect(p.basis.find((x) => x.path === 'models.gpt-oss-120b.inputEmbeddingBytes')).toMatchObject({ status: 'derived', value: inEmb });
    expect(p.step!.bwSec).toBeCloseTo(bw, 15);
    expect(p.quant).toBe('mxfp4');
  });

  it('gpt-oss-120b native verify command: no --quantization / --dtype / FP8 KV flag; the note says vLLM auto-detects', () => {
    const cmd = h200(estimateRequirements(bundle, { model: 'gpt-oss-120b', quant: 'native', ...chat })).verifyCommand;
    expect(serveLine(cmd)).toMatch(/^vllm serve openai\/gpt-oss-120b --tensor-parallel-size \d --gpu-memory-utilization 0\.92 --max-model-len 1405 --max-num-batched-tokens 8192 --async-scheduling$/);
    expect(cmd).toContain('# checkpoint 本身已是 MXFP4（config.json 有 quantization_config），vLLM 會自動偵測量化方式，所以不加 --quantization／--dtype');
    expect(serveLine(cmd)).not.toContain('--quantization');
    expect(serveLine(cmd)).not.toContain('--dtype');
    expect(serveLine(cmd)).not.toContain('--kv-cache-dtype');
    expect(cmd).not.toContain('線上動態量化');
  });

  it('gpt-oss-120b in BF16 or FP8: sized, but flagged — no verify command, a note on every platform', () => {
    for (const quant of ['bf16', 'fp8']) {
      const r = estimateRequirements(bundle, { model: 'gpt-oss-120b', quant, ...chat });
      expect(r.quant).toBe(quant);
      expect(r.requiresRequantizedCheckpoint).toBe(true);
      expect(r.quantNote).toContain('此模型在目錄中的 checkpoint（openai/gpt-oss-120b）是原生 MXFP4');
      expect(r.quantNote).toContain('需自行取得對應的 checkpoint');
      expect(r.nativeQuant?.quant).toBe('mxfp4');
      expect(r.basis.some((b) => b.path === `quantization.${quant}.bytesPerParam`)).toBe(true);
      for (const p of r.perPlatform) {
        expect(p.verifyCommand, p.platform).toBe('');
        expect(p.verifyNote).toBe(r.quantNote);
      }
    }
  });

  it("phi-4 (BF16 checkpoint): 'native' → bf16 with --dtype bfloat16; fp8 keeps vLLM online FP8 and its note", () => {
    const nat = estimateRequirements(bundle, { model: 'phi-4', quant: 'native', ...chat });
    expect(nat.quant).toBe('bf16');
    expect(nat.nativeQuant).toBeUndefined();
    expect(nat.requiresRequantizedCheckpoint).toBeUndefined();
    expect(serveLine(h200(nat).verifyCommand)).toBe(
      'vllm serve microsoft/phi-4 --tensor-parallel-size 1 --dtype bfloat16 --gpu-memory-utilization 0.92 --max-model-len 1405 --max-num-batched-tokens 8192',
    );
    const fp8 = h200(estimateRequirements(bundle, { model: 'phi-4', quant: 'fp8', ...chat })).verifyCommand;
    expect(serveLine(fp8)).toBe(
      'vllm serve microsoft/phi-4 --tensor-parallel-size 1 --quantization fp8_per_tensor --kv-cache-dtype fp8 --gpu-memory-utilization 0.92 --max-model-len 1405 --max-num-batched-tokens 8192',
    );
    expect(fp8).toContain('# FP8 = vLLM 線上動態量化（以 BF16 checkpoint 啟動，載入時轉 FP8）');
    expect(fp8).not.toContain('checkpoint 本身已是');
  });

  it('phi-4 in MXFP4: the calculator sizes only native MXFP4 checkpoints (nativeOnly) → flagged, no command', () => {
    const r = estimateRequirements(bundle, { model: 'phi-4', quant: 'mxfp4', ...chat });
    expect(r.requiresRequantizedCheckpoint).toBe(true);
    expect(r.quantNote).toContain('只估算原生的 MXFP4 checkpoint');
    expect(r.perPlatform.every((p) => p.verifyCommand === '' && p.verifyNote === r.quantNote)).toBe(true);
    expect(r.basis.find((b) => b.path === 'quantization.mxfp4.bytesPerParam')).toMatchObject({ status: 'derived', value: 0.53125 });
  });

  it('mistral-small-4 native FP8: no --quantization flag, FP8 KV flag kept, native note instead of the online-FP8 note', () => {
    const r = estimateRequirements(bundle, { model: 'mistral-small-4-119b-2603', quant: 'native', ...chat });
    expect(r.quant).toBe('fp8');
    expect(r.nativeQuant).toEqual({ method: 'fp8', quant: 'fp8', checkpointWeightBytes: 120922973936 });
    const cmd = h200(r).verifyCommand;
    expect(serveLine(cmd)).toMatch(/^vllm serve mistralai\/Mistral-Small-4-119B-2603 --tensor-parallel-size \d --kv-cache-dtype fp8 --gpu-memory-utilization 0\.92 --max-model-len 1405 --max-num-batched-tokens 8192$/);
    expect(cmd).toContain('# checkpoint 本身已是 FP8（config.json 有 quantization_config，或 ModelOpt 的 hf_quant_config.json），vLLM 會自動偵測量化方式');
    expect(serveLine(cmd)).not.toContain('--quantization');
    expect(cmd.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toContain('--quantization');
    expect(cmd).not.toContain('線上動態量化');
  });

  it('findFeasibleModels: native format by default for native checkpoints; quant "native" resolves per model', () => {
    const input = { workload: 'chat', speed: 'ok', users: 1, platform: 'nano4-h200', gpus: 8 };
    const def = findFeasibleModels(bundle, input);
    expect(def.filter((x) => x.model === 'gpt-oss-120b').map((x) => x.quant)).toEqual(['mxfp4']);
    expect(def.find((x) => x.model === 'gpt-oss-120b')).toMatchObject({ nativeQuant: { quant: 'mxfp4' } });
    expect(def.filter((x) => x.model === 'phi-4').map((x) => x.quant)).toEqual(['bf16', 'fp8', 'int4-awq']);
    expect(def.some((x) => x.requiresRequantizedCheckpoint)).toBe(false);
    const nat = findFeasibleModels(bundle, { ...input, quant: 'native' });
    expect(Object.fromEntries(nat.map((x) => [x.model, x.quant]))).toMatchObject({
      'gpt-oss-120b': 'mxfp4', 'gpt-oss-20b': 'mxfp4', 'mistral-medium-3.5-128b': 'fp8', 'phi-4': 'bf16',
    });
    const bf16 = findFeasibleModels(bundle, { ...input, quant: 'bf16' });
    expect(bf16.find((x) => x.model === 'gpt-oss-120b')).toMatchObject({ requiresRequantizedCheckpoint: true });
    expect(bf16.find((x) => x.model === 'phi-4')?.requiresRequantizedCheckpoint).toBeUndefined();
    expect(() => findFeasibleModels(bundle, { ...input, quant: 'no-such' })).toThrow(/未知的量化/);
  });

  it('verifyCommand called directly: mismatching native format → empty; Mac native states the checkpoint size', () => {
    const m = bundle.models['gpt-oss-120b']!;
    const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    expect(verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 1, { quant: bundle.quantization['bf16']! })).toBe('');
    const mac = resolvePlatform(bundle, 'mac-studio-m5u-512', 'bf16').platform;
    const cmd = verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 1, { quant: bundle.quantization['mxfp4']!, kvBytesPerElem: 2 });
    expect(cmd).toContain('權重為 MXFP4（以原生 checkpoint 大小 65.2 GB 估算，請選位元數相同的 MLX 量化版本）');
  });

  it('--max-model-len margin is capped at the model maxContext', () => {
    const m = bundle.models['phi-4']!;
    expect(m.maxContext).toBe(16384);
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'bf16');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, { inputTokens: 16000, outputTokens: 300 }, 1, {
      quant: bundle.quantization['bf16']!, maxModelLenMarginTokens: 256,
    });
    expect(serveLine(cmd)).toContain('--max-model-len 16384');
    expect(cmd).toContain('+ 餘裕 84 token（伺服器會重新斷詞 vllm bench 的 prompt，長度可能略有出入），以模型最大上下文 16384 為上限');
    // Without a margin the context is printed as is.
    const plain = verifyCommand(platform, { tp: 1, replicas: 1 }, m, { inputTokens: 1000, outputTokens: 100 }, 1, { quant: bundle.quantization['bf16']! });
    expect(plain).toContain('--max-model-len 1100 = 估算所用的上下文（輸入 1000 + 輸出 100）\n');
  });
});

describe('KV replicated across TP in real scenarios (review C1, C2)', () => {
  const base = { speed: 'smooth', platform: 'nano5-h100' } as const;

  it('mistral-small-4 (MLA) on 4 H100, doc: the latent cache is per rank, so TP 4 serves a few hundred, not ~1200', () => {
    const r = estimateCapacity(bundle, { ...base, model: 'mistral-small-4-119b-2603', quant: 'native', workload: 'doc', gpus: 4 });
    // memUtil 0.92 (vLLM v0.32.0 default; was 0.9): 292 → 300; FLOPs without the input-embedding lookup (review L8): 304
    // (memory-bound). The all-reduce now carries the step's ~8k prefill-chunk tokens too (review L2), so per-user speed
    // binds first: 228. Queueing modelled (Ruling R36): at most 227 decode within max_num_batched_tokens, the step (and
    // 20.16 tok/s) stays at 227 decoding and the rest wait; TTFT 0.072 + W binds: 292 (W ≈ 4.87 s; memory allows 304).
    // R41 calibration (t_fixed 2.9 ms per step): the 20 tok/s target binds before the queue, at 215 (20.03 tok/s).
    expect(r.expected).toEqual({ n: 215, shape: { tp: 4, replicas: 1 } });
  });

  it('gemma-4-26b (full group 2 KV heads) on 8 H100, assist: TP 2 x 4 beats TP 8 once replication is counted', () => {
    const r = estimateCapacity(bundle, { ...base, model: 'gemma-4-26b-a4b-it', quant: 'bf16', workload: 'assist', gpus: 8 });
    // memUtil 0.92 (was 0.9): 244 → 252; sliding layers at window − 1 + 8192 tokens per user (review L9): 252 → 120;
    // corrected to the window per user + one in-flight reserve (2 × 8192 tokens) per replica (vLLM frees out-of-window
    // blocks before each chunk): 120 → 244.
    expect(r.expected).toEqual({ n: 244, shape: { tp: 2, replicas: 4 } });
  });
});

describe('KV allocation granularity (spec §5.1: vLLM blocks, mlx-lm KVCache steps)', () => {
  it('resolvePlatform carries the engine allocation rule of each platform', () => {
    expect(resolvePlatform(bundle, 'nano5-h100', 'fp8').platform.kvAllocation).toEqual({
      engine: 'vllm', blockSize: 16, mlaBlockSize: { fp8Kv: 64, bf16Kv: 16 },
    });
    expect(resolvePlatform(bundle, 'nano4-gb200', 'fp8').platform.kvAllocation).toEqual({
      engine: 'vllm', blockSize: 16,
      // FlashInfer MLA needs qk_nope_head_dim ∈ {64, 128, 192}; otherwise CUTLASS MLA (block 128) (final-review M26).
      mlaBlockSize: { fp8Kv: 32, bf16Kv: 32, qkNopeHeadDims: [64, 128, 192], otherwise: { fp8Kv: 128, bf16Kv: 128 } },
    });
    expect(resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform.kvAllocation).toEqual({ engine: 'mlx', kvCacheStep: 256 });
  });
  it('MLX prompts run in prefill_step_size chunks (Ruling R38); listed only when a prompt takes more than one', () => {
    expect(resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform.prefillStepTokens).toBe(2048);
    expect(resolvePlatform(bundle, 'nano4-h200', 'fp8').platform.prefillStepTokens).toBeUndefined();
    const path = 'calibration.mac-mlx.mlxDefaults.prefillStepSize';
    const mac = (wl: { inputTokens: number; outputTokens: number; cacheHitRate: number }) =>
      predictMeasurement(bundle, { platform: 'mac-studio-m5u-512', model: 'phi-4', quant: 'fp8', workload: wl, concurrency: 1 });
    expect(mac({ inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 }).basis.some((b) => b.path === path)).toBe(false);
    expect(mac({ inputTokens: 8192, outputTokens: 128, cacheHitRate: 0 }).basis.some((b) => b.path === path)).toBe(true);
  });
  it('the basis lists the block size the capacity used (MLA: the backend block for its KV dtype)', () => {
    const base = { workload: 'chat', speed: 'smooth', users: 5 } as const;
    const ms4 = estimateRequirements(bundle, { ...base, model: 'mistral-small-4-119b-2603', quant: 'native' });
    const h100 = ms4.perPlatform.find((x) => x.platform === 'nano5-h100')!;
    expect(h100.basis.some((b) => b.path === 'platforms.nano5-h100.vllmDefaults.mlaKvBlockSize.fp8Kv')).toBe(true);
    expect(h100.basis.some((b) => b.path === 'platforms.nano5-h100.vllmDefaults.kvBlockSize')).toBe(false);
    const phi = estimateRequirements(bundle, { ...base, model: 'phi-4', quant: 'fp8' });
    expect(phi.perPlatform.find((x) => x.platform === 'nano5-h100')!.basis.some((b) => b.path === 'platforms.nano5-h100.vllmDefaults.kvBlockSize')).toBe(true);
    const mac = phi.perPlatform.find((x) => x.platform === 'mac-studio-m5u-512')!;
    expect(mac.basis.some((b) => b.path === 'calibration.mac-mlx.mlxDefaults.kvCacheStep')).toBe(true);
  });
  it('vLLM capacity holds whole blocks: phi-4 chat on one H100 at ceil(1149 / 16) × 16 = 1152 tokens per user', () => {
    const p = predictMeasurement(bundle, { platform: 'nano5-h100', model: 'phi-4', quant: 'fp8', workload: { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 }, concurrency: 1 });
    const m = bundle.models['phi-4']!;
    const rep = resolvePlatform(bundle, 'nano5-h100', 'fp8').platform.replicaFor(p.shape!.tp, 'expected');
    const emb = embeddingParams(m);
    const resident = (m.totalParamsB.value * 1e9 - emb) * 1 + emb * 2;
    // 1149 tokens → 72 blocks of 16 = 1152 (the same as VLLM_BLOCKS).
    const kv = kvBytesPerSequence(m, 1152, 1, p.shape!.tp);
    expect(kv).toBe(kvBytesPerSequence(m, 1149, 1, p.shape!.tp, VLLM_BLOCKS));
    expect(p.maxConcurrent).toBe(Math.floor((rep.memBytes * rep.memUtil - resident) / kv));
  });
});

describe('vLLM sliding-window KV allocation (review L9, corrected)', () => {
  const base = { quant: 'fp8', workload: 'assist', speed: 'smooth' } as const;
  it('vLLM platforms hold max_concurrent_batches × max_num_batched_tokens in flight; MLX none', () => {
    expect(resolvePlatform(bundle, 'nano4-h200', 'fp8').platform.slidingInFlightTokens).toBe(2 * 8192);
    expect(resolvePlatform(bundle, 'nano4-gb200', 'fp8').platform.slidingInFlightTokens).toBe(2 * 16384);
    expect(resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform.slidingInFlightTokens).toBe(0);
  });
  it('capacity: the window per resident sequence, the in-flight overshoot once per replica (not per user)', () => {
    const wl = { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 };
    const p = predictMeasurement(bundle, { platform: 'nano4-h200', model: 'gemma-4-31b-it', quant: 'fp8', workload: wl, concurrency: 1 });
    const m = bundle.models['gemma-4-31b-it']!;
    const tp = p.shape!.tp;
    const rep = resolvePlatform(bundle, 'nano4-h200', 'fp8').platform.replicaFor(tp, 'expected');
    // FP8 linear layers at 1 B, the embedding at 2 B (embeddingBytesPerParam).
    const emb = embeddingParams(m);
    const resident = (m.totalParamsB.value * 1e9 - emb) * 1 + emb * 2;
    const kv = kvBytesPerSequence(m, 126432, 1, tp, VLLM_BLOCKS);
    const reserve = slidingTransientKvBytes(m, 126432, 2 * 8192, 1, tp);
    expect(reserve).toBe(50 * 2 * Math.max(16, tp) * 256 * 16384);
    expect(p.maxConcurrent).toBe(Math.floor((rep.memBytes * rep.memUtil - resident - reserve) / kv));
    // The old per-user upper bound (window − 1 + max_num_batched_tokens) served far fewer.
    const old = kvBytesPerSequence(m, 126432, 1, tp, { slidingExtraTokens: 8191 });
    expect(p.maxConcurrent!).toBeGreaterThan(Math.floor((rep.memBytes * rep.memUtil) / old));
    for (const path of ['maxNumBatchedTokens', 'maxConcurrentBatches']) {
      expect(p.basis.some((b) => b.path === `platforms.nano4-h200.vllmDefaults.${path}`), path).toBe(true);
    }
  });
  it('the verify command explains the sliding-window use of --max-num-batched-tokens only when sliding layers were sized with it', () => {
    const g = estimateRequirements(bundle, { ...base, model: 'gemma-4-31b-it', users: 5 });
    const h = g.perPlatform.find((x) => x.platform === 'nano4-h200')!;
    expect(h.verifyCommand).toContain('--max-num-batched-tokens 8192');
    expect(h.verifyCommand).toContain('穩態');
    // The in-flight reserve assumes async scheduling (max_concurrent_batches 2), so it is pinned too (issue #13).
    expect(h.verifyCommand.split('\n').find((l) => l.startsWith('vllm serve '))).toContain(' --async-scheduling');
    expect(h.verifyCommand).toContain('GitHub issue #13');
    const phi = estimateRequirements(bundle, { ...base, workload: 'chat', model: 'phi-4', users: 5 });
    // Always pinned since final-review M9 (chunking and queueing depend on it), but without the sliding-window note.
    const phiCmd = phi.perPlatform.find((x) => x.platform === 'nano4-h200')!.verifyCommand;
    expect(phiCmd).toContain('--max-num-batched-tokens 8192');
    expect(phiCmd).not.toContain('穩態');
    expect(phiCmd).not.toContain('--async-scheduling');
    // The basis still lists the budget: the queueing model was evaluated against it (Ruling R36), below it here.
    const phiH200 = phi.perPlatform.find((x) => x.platform === 'nano4-h200')!;
    expect(phiH200.queueing).toBeNull();
    expect(phiH200.basis.some((b) => b.path.endsWith('vllmDefaults.maxNumBatchedTokens'))).toBe(true);
  });
});

describe('model context limit in the API (review C3)', () => {
  it('assist (126k) is infeasible for OLMo-2 (4k) and phi-4 (16k) with no runnable verify command', () => {
    for (const model of ['olmo-2-0325-32b', 'phi-4']) {
      const r = estimateRequirements(bundle, { model, quant: 'bf16', workload: 'assist', speed: 'smooth', users: 15 });
      expect(r.best, model).toBeNull();
      for (const p of r.perPlatform) {
        expect(p.expected, `${model} ${p.platform}`).toMatchObject({ ok: false, why: 'context' });
        expect(p.verifyCommand).toBe('');
        expect(p.verifyNote).toContain('超過模型的最大上下文');
      }
    }
  });
  it('verifyCommand called directly never prints --max-model-len above maxContext', () => {
    const platform = resolvePlatform(bundle, 'nano4-h200', 'bf16').platform;
    const m = bundle.models['phi-4']!;
    const q = { quant: bundle.quantization['bf16']! };
    expect(verifyCommand(platform, { tp: 1, replicas: 1 }, m, { inputTokens: 20000, outputTokens: 300 }, 1, q)).toBe('');
    const near = verifyCommand(platform, { tp: 1, replicas: 1 }, m, { inputTokens: 16000, outputTokens: 300 }, 1, {
      ...q,
      maxModelLenMarginTokens: 256,
    });
    expect(near).toContain('--max-model-len 16384');
  });
});

describe('embedding / lm_head stay 16-bit under online quantization (review)', () => {
  it('gemma-4-12b AWQ: the tied 262144 x 3840 embedding is sized at 2 bytes, not 0.53125', () => {
    const m = bundle.models['gemma-4-12b-it']!;
    expect(m.vocabSize).toBe(262144);
    expect(m.tieWordEmbeddings).toBe(true);
    const wl = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
    const p = predictMeasurement(bundle, { platform: 'nano4-h200', model: 'gemma-4-12b-it', quant: 'int4-awq', workload: wl, concurrency: 1 });
    const emb = 262144 * 3840;
    expect(p.basis.find((b) => b.path === 'models.gemma-4-12b-it.embeddingParams')).toMatchObject({ status: 'derived', value: emb });
    expect(p.basis.find((b) => b.path === 'quantization.int4-awq.embeddingBytesPerParam')).toMatchObject({ value: 2 });
    const resident = (m.totalParamsB.value * 1e9 - emb) * 0.53125 + emb * 2;
    const rep = resolvePlatform(bundle, 'nano4-h200', 'bf16').platform.replicaFor(p.shape!.tp, 'expected');
    const ctxTok = wl.inputTokens + wl.outputTokens;
    const kv = kvBytesPerSequence(m, ctxTok, 2, p.shape!.tp, VLLM_BLOCKS);
    const reserve = slidingTransientKvBytes(m, ctxTok, 2 * 8192, 2, p.shape!.tp);
    expect(p.maxConcurrent).toBe(Math.floor((rep.memBytes * rep.memUtil - resident - reserve) / kv));
    // The old all-at-0.53125 sizing under-counted by about a fifth.
    expect(resident / (m.totalParamsB.value * 1e9 * 0.53125)).toBeGreaterThan(1.15);
  });
  it('BF16 is unchanged (embedding already 2 bytes)', () => {
    const p = predictMeasurement(bundle, {
      platform: 'nano4-h200', model: 'phi-4', quant: 'bf16', workload: { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 }, concurrency: 1,
    });
    const m = bundle.models['phi-4']!;
    const rep = resolvePlatform(bundle, 'nano4-h200', 'bf16').platform.replicaFor(1, 'expected');
    expect(p.maxConcurrent).toBe(Math.floor((rep.memBytes * rep.memUtil - m.totalParamsB.value * 2e9) / kvBytesPerSequence(m, 1100, 2, 1, VLLM_BLOCKS)));
  });
});

describe('verifyCommand with several replicas (review: one serve line took all N requests)', () => {
  const m = bundle.models['phi-4']!;
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const fp8 = { quant: bundle.quantization['fp8']! };
  it('benchmarks one replica with its share ceil(G / replicas), GPUs pinned', () => {
    const { platform } = resolvePlatform(bundle, 'nano5-h100', 'fp8');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 3 }, m, w, 100, fp8);
    expect(cmd).toContain('--max-concurrency 34 --dataset-name random');
    expect(cmd).toContain('--num-prompts 340');
    expect(cmd).toContain('共 3 份，每份模型分到 34 個同時生成的請求（100 ÷ 3，無條件進位）');
    expect(cmd).toContain('每個 node 可放 4 份模型');
    expect(cmd.split('\n').filter((l) => l.includes('vllm serve '))).toEqual([
      expect.stringMatching(/^CUDA_VISIBLE_DEVICES=0,1 vllm serve microsoft\/phi-4 --tensor-parallel-size 2 /),
    ]);
  });
  it('several replicas: each gets its own GPUs and port; the measured one is pinned to port 8000 (review L10)', () => {
    const { platform } = resolvePlatform(bundle, 'nano5-h100', 'fp8');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 3 }, m, w, 100, fp8);
    const serve = cmd.split('\n').find((l) => l.includes('vllm serve '))!;
    expect(serve).toMatch(/ --port 8000$/);
    expect(cmd).toContain('vllm bench serve --port 8000 --model microsoft/phi-4 ');
    expect(cmd).toContain('#   第 2 份：CUDA_VISIBLE_DEVICES=2,3、--port 8001');
    expect(cmd).toContain('#   第 3 份：CUDA_VISIBLE_DEVICES=4,5、--port 8002');
    expect(cmd).toContain('--data-parallel-size');
  });
  it('--max-num-seqs is pinned only when a replica runs more requests than the vLLM default (review L10)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const big = verifyCommand(platform, { tp: 8, replicas: 1 }, bundle.models['granite-3.3-8b-instruct']!, w, 3000, fp8);
    expect(big.split('\n').find((l) => l.startsWith('vllm serve '))).toContain('--max-num-seqs 3000');
    expect(big).toContain('# --max-num-seqs 3000：');
    const two = verifyCommand(platform, { tp: 4, replicas: 2 }, bundle.models['granite-3.3-8b-instruct']!, w, 2000, fp8);
    expect(two).not.toContain('--max-num-seqs');
    expect(verifyCommand(platform, { tp: 8, replicas: 1 }, bundle.models['granite-3.3-8b-instruct']!, w, 1024, fp8)).not.toContain('--max-num-seqs');
  });
  it('one replica is unchanged (all G on it, no GPU pinning)', () => {
    const { platform } = resolvePlatform(bundle, 'nano5-h100', 'fp8');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 100, fp8);
    expect(cmd).toContain('--max-concurrency 100 ');
    expect(cmd).not.toContain('CUDA_VISIBLE_DEVICES');
    expect(cmd).not.toContain('份，每份模型分到');
  });
  it('Mac: several machines, each measured with its share', () => {
    const mac = resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform;
    expect(verifyCommand(mac, { tp: 1, replicas: 7 }, m, w, 200, fp8)).toContain('--max-concurrency 29 ');
  });
});

describe('per-platform basis and trust flags (review M-11)', () => {
  it('each platform result lists only what its own calculation used; the aggregate is their union', () => {
    const r = estimateRequirements(bundle, { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 20 });
    const h = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    const mac = r.perPlatform.find((p) => p.platform === 'mac-studio-m5u-512')!;
    expect(h.basis.some((b) => b.path === 'hardware.h200-sxm.memGB')).toBe(true);
    expect(h.basis.some((b) => b.path.startsWith('calibration.mac-mlx'))).toBe(false);
    expect(mac.basis.some((b) => b.path === 'calibration.mac-mlx.etaBw')).toBe(true);
    expect(mac.basis.some((b) => b.path.startsWith('hardware.h200-sxm'))).toBe(false);
    // Shared inputs (model, quantization, workload) are in every platform's basis.
    for (const p of r.perPlatform) expect(p.basis.some((b) => b.path === 'models.phi-4.totalParamsB'), p.platform).toBe(true);
    const union = new Set(r.perPlatform.flatMap((p) => p.basis.map((b) => b.path)));
    expect(new Set(r.basis.map((b) => b.path))).toEqual(union);
    for (const p of r.perPlatform) {
      expect(p.hasEstimate).toBe(p.basis.some((b) => b.status === 'estimate' || b.status === 'unverified'));
      expect(p.hasUser).toBe(false);
    }
  });
});

describe('infeasible scenarios that still print a command say it is expected to fail (review M-8)', () => {
  it('mem / bw / compute / ttft: verifyNote states the expected failure and its reason', () => {
    const r = estimateRequirements(bundle, { model: 'gemma-4-31b-it', quant: 'fp8', workload: 'assist', speed: 'smooth', users: 50 });
    const bad = r.perPlatform.filter((p) => !p.expected.ok && ['mem', 'bw', 'compute', 'ttft'].includes(p.expected.why));
    expect(bad.length).toBeGreaterThan(0);
    for (const p of bad) {
      if (p.expected.ok) throw new Error('unreachable');
      expect(p.verifyCommand.length, p.platform).toBeGreaterThan(0);
      expect(p.verifyNote, p.platform).toContain('預期不可行');
      expect(p.verifyNote, p.platform).toContain(p.expected.detail);
    }
    // Feasible platforms carry no note.
    for (const p of r.perPlatform.filter((x) => x.expected.ok)) expect(p.verifyNote, p.platform).toBeUndefined();
  });
});

describe('requirement and capacity agree on the shape at equal GPU count (review M-7)', () => {
  const cases = [
    ['gemma-4-31b-it', 'fp8', 'assist', 50],
    ['gemma-4-31b-it', 'fp8', 'doc', 40],
    ['gpt-oss-120b', 'native', 'assist', 50],
    ['mistral-small-4-119b-2603', 'native', 'doc', 60],
    ['phi-4', 'fp8', 'chat', 300],
  ] as const;
  it.each(cases)('%s %s %s %d users: ties at the fewest GPUs go to the shape serving the most users', (model, quant, workload, users) => {
    const r = estimateRequirements(bundle, { model, quant, workload, speed: 'smooth', users });
    for (const p of r.perPlatform) {
      if (!p.expected.ok || bundle.platforms[p.platform]!.group !== 'nchc') continue;
      const c = estimateCapacity(bundle, { model, quant, workload, speed: 'smooth', platform: p.platform, gpus: p.expected.gpus });
      // The capacity search over the same GPU count finds the same split, so the two views never contradict.
      expect(c.expected.shape, `${p.platform}`).toEqual(p.expected.shape);
      expect(p.maxConcurrent).toBe(c.expected.n);
    }
  });
});

describe('findFeasibleModels carries provenance (review: trust follows the weakest input)', () => {
  it('each item has its basis and the trust flags estimateRequirements would give', () => {
    const items = findFeasibleModels(bundle, { quant: 'fp8', workload: 'chat', speed: 'smooth', platform: 'nano4-h200', gpus: 8 });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.basis.length, it.model).toBeGreaterThan(0);
      expect(it.basis.some((b) => b.path === `models.${it.model}.totalParamsB`)).toBe(true);
      expect(it.basis.some((b) => b.path.startsWith('platforms.nano4-h200') || b.path.startsWith('hardware.'))).toBe(true);
      const req = estimateRequirements(bundle, { model: it.model, quant: it.quant, workload: 'chat', speed: 'smooth', users: 1 });
      expect(it.hasEstimate, it.model).toBe(req.hasEstimate);
    }
  });
});

describe('queueing model: prefill queues behind vLLM max_num_batched_tokens (Ruling R36)', () => {
  const mnbtPath = (p: string) => `platforms.${p}.vllmDefaults.maxNumBatchedTokens`;
  // The queueing mechanism is checked at t_fixed = 0 and no per-request TTFT overhead (the pre-R41 calibration), so its
  // numbers stay hand-checkable; with the R41 values the 20 tok/s target binds first (215 users on 4 H100).
  const bundle: Bundle = structuredClone(realBundleTop);
  bundle.calibration['nvidia-default']!.tFixedSec.value = 0;
  bundle.calibration['nvidia-default']!.ttftOverheadSec.value = 0;
  // doc 12035 in / 343 out, no cache: decodingMax = floor(8192 × 343 / (343 + 12035)) = floor(227.004) = 227 (H100).
  const ms4 = { model: 'mistral-small-4-119b-2603', quant: 'native', workload: 'doc', speed: 'smooth' } as const;
  const h100At = (users: number) => estimateRequirements(bundle, { ...ms4, users }).perPlatform.find((p) => p.platform === 'nano5-h100')!;

  it('Mistral Small 4 doc on 4 H100: 227 decode at once; the capacity is now TTFT-bound at 292 (was 228)', () => {
    const c = estimateCapacity(bundle, { ...ms4, platform: 'nano5-h100', gpus: 4 });
    expect(c.expected).toEqual({ n: 292, shape: { tp: 4, replicas: 1 } });
    const q = c.queueing!;
    expect([q.budget, q.decodingMax, q.waiting]).toEqual([8192, 227, 65]);
    expect(q.tokensPerStep).toBeCloseTo(292 * (1 + 12035 / 343), 9);
    expect(c.basis.some((b) => b.path === mnbtPath('nano5-h100'))).toBe(true);
    expect(c.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(true);
  });

  it('requirement path: W by Little’s law on the platform result, TTFT includes it, verify note, explain', () => {
    const at227 = h100At(227);
    expect(at227.expected).toMatchObject({ ok: true, gpus: 4, shape: { tp: 4, replicas: 1 } });
    expect(at227.queueing).toBeNull();
    expect(at227.verifyCommand).not.toContain('會排隊');
    if (!at227.expected.ok) throw new Error('unreachable');
    const t227 = at227.expected.check.step.stepSec;
    const prefill = at227.expected.check.prefillTtftSec;
    expect(at227.expected.check.ttftSec).toBe(prefill);

    const h100 = h100At(228);
    expect(h100.expected).toMatchObject({ ok: true, gpus: 4, shape: { tp: 4, replicas: 1 } });
    if (!h100.expected.ok) throw new Error('unreachable');
    const q = h100.queueing!;
    expect(q).toEqual(h100.expected.check.queueing);
    // 1 waiting: W = 1 × 343 × t(227) ÷ 227; the step is the 227-decoding one (same speed as at 227 users).
    expect(q.waiting).toBe(1);
    expect(q.waitSec).toBeCloseTo((343 * t227) / 227, 12);
    expect(h100.expected.check.step.stepSec).toBe(t227);
    expect(h100.expected.check.ttftSec).toBeCloseTo(prefill + q.waitSec, 12);
    expect(h100.basis.some((b) => b.path === mnbtPath('nano5-h100'))).toBe(true);
    expect(h100.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(true);
    expect(h100.verifyCommand).toContain(`# 會排隊：${q.reason}`);
    expect(h100.verifyCommand).toContain('量到的 TTFT 包含排隊時間');
    expect(h100.verifyCommand).toMatch(/vllm serve .* --max-num-batched-tokens 8192/);
    const e = explain(bundle, { ...ms4, users: 228 });
    expect(e.formulas.some((f) => f.includes('max_num_batched_tokens') && f.includes("Little's law"))).toBe(true);
    expect(e.formulas.some((f) => f.includes('nano5-h100') && f.includes(q.reason))).toBe(true);
  });

  it('the solver adds a replica when the wait breaks the 5 s TTFT: 292 users on 4 H100, 293 on 8', () => {
    expect(h100At(292).expected).toMatchObject({ ok: true, gpus: 4, shape: { tp: 4, replicas: 1 } });
    const r = h100At(293);
    expect(r.expected).toMatchObject({ ok: true, gpus: 8, shape: { tp: 4, replicas: 2 } });
    expect(r.queueing).toBeNull();
  });

  it('MLX (Mac) has no per-step budget: null, and its basis has no max_num_batched_tokens or queue rule', () => {
    const r = estimateRequirements(bundle, { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', users: 50 });
    const mac = r.perPlatform.find((p) => p.platform === 'mac-studio-m5u-512')!;
    expect(mac.expected.ok).toBe(true);
    expect(mac.queueing).toBeNull();
    expect(mac.basis.some((b) => b.path.endsWith('maxNumBatchedTokens'))).toBe(false);
    expect(mac.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(false);
    if (!mac.expected.ok) throw new Error('unreachable');
    expect(mac.expected.check.ttftSec).toBe(mac.expected.check.prefillTtftSec);
    // vLLM platforms evaluate the model (no queue here) and list the values used.
    const h200 = r.perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(h200.queueing).toBeNull();
    expect(h200.basis.some((b) => b.path === mnbtPath('nano4-h200'))).toBe(true);
    expect(h200.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(true);
    expect(estimateCapacity(bundle, { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth', platform: 'mac-studio-m5u-512', gpus: 1 }).queueing).toBeNull();
  });

  it('infeasible result: no shape, no queue', () => {
    const r = estimateRequirements(bundle, { ...ms4, users: 1 });
    for (const p of r.perPlatform.filter((x) => !x.expected.ok)) expect(p.queueing, p.platform).toBeNull();
  });

  it('findFeasibleModels items carry the same queue as estimateRequirements', () => {
    const items = findFeasibleModels(bundle, { quant: 'native', workload: 'doc', speed: 'smooth', platform: 'nano5-h100', gpus: 4, users: 228 });
    const it4 = items.find((i) => i.model === 'mistral-small-4-119b-2603')!;
    expect(it4.feasible).toBe(true);
    expect(it4.queueing?.waiting).toBe(1);
    for (const i of items) {
      const p = estimateRequirements(bundle, { model: i.model, quant: i.quant, workload: 'doc', speed: 'smooth', users: 228 })
        .perPlatform.find((x) => x.platform === 'nano5-h100')!;
      expect(i.queueing, i.model).toEqual(p.queueing);
    }
  });
});

describe('verify command is always startable and pins the budget it models (final-review I1, M9)', () => {
  const serve = (cmd: string) => cmd.split('\n').find((l) => /(^| )vllm serve /.test(l) && !l.startsWith('#'))!;
  const flag = (line: string, f: string) => Number(new RegExp(`${f} (\\d+)`).exec(line)?.[1]);
  const m = bundle.models['phi-4']!;
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const fp8 = { quant: bundle.quantization['fp8']! };
  it('always pins --max-num-batched-tokens on vLLM at the value the estimate used (R38 chunks, R36 queue)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const cmd = verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 5, fp8);
    expect(flag(serve(cmd), '--max-num-batched-tokens')).toBe(platform.maxNumBatchedTokens);
    expect(cmd).toContain(`# --max-num-batched-tokens ${platform.maxNumBatchedTokens} = 估算所用的每步 token 上限`);
    const gb = resolvePlatform(bundle, 'nano4-gb200', 'fp8').platform;
    expect(flag(serve(verifyCommand(gb, { tp: 1, replicas: 1 }, m, w, 5, fp8)), '--max-num-batched-tokens')).toBe(16384);
  });
  it('more than max_num_batched_tokens generating per replica: --max-num-seqs is capped at the budget (vLLM requires mnbt ≥ max_num_seqs)', () => {
    const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
    const cmd = verifyCommand(platform, { tp: 8, replicas: 1 }, bundle.models['granite-3.3-8b-instruct']!, w, 10000, fp8);
    const line = serve(cmd);
    expect(flag(line, '--max-num-seqs')).toBe(8192);
    expect(flag(line, '--max-num-batched-tokens')).toBe(8192);
    expect(cmd).toContain('config/scheduler.py');
  });
  it('the repro (gemma-4-31b native chat smooth 10000 users, DGX Spark fallback) is startable', () => {
    const r = estimateRequirements(bundle, { model: 'gemma-4-31b-it', quant: 'native', workload: 'chat', speed: 'smooth', users: 10000 });
    for (const p of r.perPlatform) {
      if (!p.verifyCommand || !p.verifyCommand.includes('vllm serve')) continue;
      const line = serve(p.verifyCommand);
      const mnbt = flag(line, '--max-num-batched-tokens');
      const seqs = flag(line, '--max-num-seqs');
      expect(mnbt, p.platform).toBe(resolvePlatform(bundle, p.platform, 'bf16').platform.maxNumBatchedTokens);
      if (!Number.isNaN(seqs)) expect(seqs, p.platform).toBeLessThanOrEqual(mnbt);
    }
  });
});

describe('multi-replica comments and expected-infeasible queueing (final-review M13, M17)', () => {
  const m = bundle.models['phi-4']!;
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const fp8 = { quant: bundle.quantization['fp8']! };
  it('several replicas: no --max-concurrency <total> comment before the per-replica value', () => {
    const { platform } = resolvePlatform(bundle, 'nano5-h100', 'fp8');
    const cmd = verifyCommand(platform, { tp: 2, replicas: 3 }, m, w, 100, fp8);
    expect(cmd).not.toContain('--max-concurrency 100');
    expect(cmd).toContain('同時在生成 100 人');
    expect(cmd).toContain('--max-concurrency 34 ');
  });
  it('one replica per node: no --data-parallel-size 1 suggestion', () => {
    const { platform } = resolvePlatform(bundle, 'nano5-h100', 'fp8');
    const cmd = verifyCommand(platform, { tp: 8, replicas: 2 }, bundle.models['granite-3.3-8b-instruct']!, w, 100, fp8);
    expect(cmd).not.toContain('--data-parallel-size 1');
    expect(cmd).not.toContain('--data-parallel-size');
    expect(verifyCommand(platform, { tp: 2, replicas: 3 }, m, w, 100, fp8)).toContain('--data-parallel-size 3');
  });
  it('expected-infeasible command on the largest TP, one replica, evaluates and states its queue', () => {
    const r = estimateRequirements(bundle, { model: 'gemma-4-31b-it', quant: 'native', workload: 'chat', speed: 'smooth', users: 10000 });
    const p = r.perPlatform.find((x) => x.platform === 'dgx-spark')!;
    expect(p.expected.ok).toBe(false);
    expect(p.verifyNote).toContain('預期不可行');
    expect(p.verifyNote).toContain('排隊');
    expect(p.verifyCommand).toContain('# 會排隊：');
    expect(p.basis.some((b) => b.path === 'concurrency.queueRule')).toBe(true);
  });
});

describe('Mac (mlx_lm) verify command (final-review M11, M12)', () => {
  const m = bundle.models['phi-4']!;
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const mac = resolvePlatform(bundle, 'mac-studio-m5u-512', 'fp8').platform;
  const q = (id: string) => ({ quant: bundle.quantization[id]!, kvBytesPerElem: 2 });
  const lines = (cmd: string) => cmd.split('\n').filter((l) => !l.startsWith('#'));
  it('names an MLX checkpoint placeholder of the estimated bit width, never the BF16 / ModelOpt repo', () => {
    const cmd = verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 4, q('fp8'));
    expect(lines(cmd)[0]).toBe('mlx_lm.server --model "<MLX 8-bit checkpoint of microsoft/phi-4>" --port 8080 --prefill-step-size 2048');
    expect(lines(cmd)[1]).toContain('--model "<MLX 8-bit checkpoint of microsoft/phi-4>"');
    expect(lines(verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 4, q('bf16')))[0]).toContain('<MLX 16-bit checkpoint of microsoft/phi-4>');
    expect(lines(verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 4, q('int4-awq')))[0]).toContain('<MLX 4-bit checkpoint of microsoft/phi-4>');
    const oss = bundle.models['gpt-oss-120b']!;
    expect(lines(verifyCommand(mac, { tp: 1, replicas: 1 }, oss, w, 1, q('mxfp4')))[0]).toContain('<MLX 4-bit checkpoint of openai/gpt-oss-120b>');
    expect(cmd).toContain('請把 <MLX 8-bit checkpoint of …> 換成');
  });
  it('says mlx_lm.server ignores ignore_eos (outputs may stop at EOS) and gives the logit_bias workaround', () => {
    const cmd = verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 4, q('fp8'));
    expect(cmd).toContain('ignore_eos');
    expect(cmd).toContain('logit_bias');
    expect(cmd).toContain('--extra-body');
  });
  it('pins --decode-concurrency above the server default of 32 (the estimate decodes every generating request)', () => {
    expect(lines(verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 40, q('fp8')))[0]).toContain('--decode-concurrency 40');
    expect(verifyCommand(mac, { tp: 1, replicas: 1 }, m, w, 32, q('fp8'))).not.toContain('--decode-concurrency');
  });
  it('holds every resident session in the prompt cache (default 10 entries)', () => {
    const long = bundle.models['mistral-small-3.1-24b-instruct-2503']!;
    const aw = { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 };
    const cmd = verifyCommand(mac, { tp: 1, replicas: 1 }, long, aw, 100, { ...q('fp8'), kind: 'agent', agentShare: 0.033 });
    expect(lines(cmd)[0]).toContain('--prompt-cache-size 100');
  });
});

describe('verifyCommand validates its own input (final-review M10)', () => {
  const m = bundle.models['phi-4']!;
  const w = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };
  const fp8 = { quant: bundle.quantization['fp8']! };
  const { platform } = resolvePlatform(bundle, 'nano4-h200', 'fp8');
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof CoreInputError ? e.code : 'other';
    }
    return 'none';
  };
  it('rejects a TP the platform or the model does not allow, and non-positive shapes / users / lengths', () => {
    expect(code(() => verifyCommand(platform, { tp: 3, replicas: 1 }, m, w, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 16, replicas: 1 }, m, w, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 1, replicas: 0 }, m, w, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 0, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 1, replicas: 1 }, m, { ...w, outputTokens: 0 }, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 1, replicas: 1 }, m, { ...w, cacheHitRate: 1 }, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 1, replicas: 1 }, m, w, 5, { ...fp8, agentShare: 2 }))).toBe('invalid-input');
    // phi-4 has 40 heads / 10 KV heads: TP 8 does not divide them.
    expect(code(() => verifyCommand(platform, { tp: 8, replicas: 1 }, bundle.models['phi-4']!, w, 5, fp8))).toBe('invalid-input');
    expect(code(() => verifyCommand(platform, { tp: 2, replicas: 1 }, m, w, 5, fp8))).toBe('none');
  });
  it('never prints Infinity or NaN', () => {
    expect(verifyCommand(platform, { tp: 2, replicas: 4 }, m, w, 7, fp8)).not.toMatch(/Infinity|NaN/);
  });
});

describe('estimateCapacity / findFeasibleModels carry the §5.5 / §9 outputs (final-review I3, M15)', () => {
  const cap = (over: Partial<Parameters<typeof estimateCapacity>[1]>) =>
    estimateCapacity(bundle, { model: 'gpt-oss-120b', quant: 'native', workload: 'chat', speed: 'smooth', platform: 'nano5-h200', gpus: 8, ...over } as Parameters<typeof estimateCapacity>[1]);
  it('n > 0: bottleneck, memory-only limit, an 8-point speed curve up to n, and the verify command of the shape', () => {
    const c = cap({});
    expect(c.expected.n).toBeGreaterThan(0);
    expect(c.why).toBeNull();
    expect(['mem', 'bw', 'compute', 'ttft']).toContain(c.bottleneck);
    expect(c.memoryOnlyMax).toBeGreaterThanOrEqual(c.expected.n);
    const pts = c.speedCurve!.points;
    expect(c.speedCurve!.shape).toEqual(c.expected.shape);
    expect(pts.length).toBe(8);
    expect(pts[pts.length - 1]!.users).toBe(c.expected.n);
    expect(pts.every((p) => p.tokPerSecPerUser >= 20 && p.ttftSec <= 5 && p.aggregateTokPerSec > 0)).toBe(true);
    // Per-user speed falls as users grow.
    expect(pts[0]!.tokPerSecPerUser).toBeGreaterThanOrEqual(pts[pts.length - 1]!.tokPerSecPerUser);
    const share = Math.ceil(c.expected.n / c.expected.shape!.replicas);
    expect(c.verifyCommand).toContain(`--max-concurrency ${share} `);
    expect(c.saturated).toBeUndefined();
    expect(nonFinite(c)).toEqual([]);
  });
  it("n = 0: why / detail ('context', 'weights'), no speed curve; no command when nothing can run", () => {
    const ctxOut = cap({ model: 'olmo-2-0325-32b', quant: 'bf16', workload: 'assist' });
    expect(ctxOut.expected.n).toBe(0);
    expect(ctxOut.why).toBe('context');
    expect(ctxOut.detail).toContain('最大上下文');
    expect(ctxOut.bottleneck).toBe('context');
    expect(ctxOut.speedCurve).toBeNull();
    expect(ctxOut.verifyCommand).toBe('');
    expect(ctxOut.verifyNote).toContain('vLLM 不接受這個長度');
    const w = cap({ model: 'mistral-medium-3.5-128b', quant: 'native', platform: 'nano5-h100', gpus: 1 });
    expect(w.why).toBe('weights');
    expect(w.detail).toContain('1 張 GPU');
    expect(w.memoryOnlyMax).toBe(0);
    expect(w.verifyNote).toContain('1 張 GPU');
  });
  it('n = 0 for speed: the expected-to-fail command runs on the largest TP within the GPUs', () => {
    const slow = cap({ model: 'mistral-medium-3.5-128b', quant: 'fp8', speed: { minTokPerSec: 500, maxTtftSec: 5 }, gpus: 4 });
    expect(slow.expected.n).toBe(0);
    expect(['bw', 'compute']).toContain(slow.why);
    expect(slow.memoryOnlyMax).toBeGreaterThan(0);
    expect(slow.verifyNote).toContain('預期不可行');
    expect(slow.verifyCommand).toContain('--tensor-parallel-size 4');
  });
  it('a capacity at the 1e7 search cap is flagged as "at least" (M15)', () => {
    const tiny = { name: 'tiny', totalParamsB: 0.001, layers: 1, heads: 1, kvHeads: 1, headDim: 64, hidden: 64 };
    const c = cap({ model: tiny, quant: 'bf16', gpus: 100000 });
    expect(c.expected.n).toBe(1e7);
    expect(c.saturated).toBe(true);
    expect(c.saturatedNote).toContain('至少');
    expect(c.bottleneck).toBeNull();
  });
  it('findFeasibleModels: each item has why / detail codes, bottleneck, memory-only limit, speed curve and verify command', () => {
    const res = findFeasibleModels(bundle, { workload: 'assist', speed: 'smooth', users: 200, platform: 'nano5-h100', gpus: 8 });
    const ok = res.filter((x) => x.feasible);
    expect(ok.length).toBeGreaterThan(0);
    for (const x of ok) {
      expect(x.why).toBeUndefined();
      expect(x.memoryOnlyMax!).toBeGreaterThanOrEqual(200);
      expect(x.speedCurve!.points.length).toBeGreaterThan(0);
      expect(['mem', 'bw', 'compute', 'ttft', null]).toContain(x.bottleneck);
      expect(x.verifyCommand.length > 0 || x.verifyNote !== undefined).toBe(true);
    }
    const olmo = res.find((x) => x.model === 'olmo-2-0325-32b')!;
    expect(olmo.why).toBe('context');
    expect(olmo.bottleneck).toBe('context');
    expect(olmo.verifyCommand).toBe('');
    const over = findFeasibleModels(bundle, { quant: 'bf16', workload: 'chat', speed: 'smooth', users: 500, platform: 'nano4-h200', gpus: 1 });
    const g = over.find((x) => x.model === 'gemma-4-31b-it')!;
    expect(g.feasible).toBe(false);
    expect(g.detail).toContain('需要');
    expect(['mem', 'bw', 'compute', 'ttft', 'weights']).toContain(g.why);
  });
});

describe('capacity / explain input contract (final-review M16)', () => {
  const base = { model: 'phi-4', quant: 'fp8', workload: 'chat', speed: 'smooth' };
  const err = (f: () => unknown): CoreInputError => {
    try {
      f();
    } catch (e) {
      if (e instanceof CoreInputError) return e;
      throw e;
    }
    throw new Error('no error');
  };
  it('estimateCapacity rejects users (the capacity is the answer, not an input)', () => {
    const e = err(() => estimateCapacity(bundle, { ...base, platform: 'nano4-h200', gpus: 1, users: 5 } as never));
    expect(e.code).toBe('invalid-input');
  });
  it('explain: platform without gpus, or the capacity path with users, gets a clear error', () => {
    const noGpus = err(() => explain(bundle, { ...base, platform: 'nano4-h200', users: 5 } as never));
    expect(noGpus.code).toBe('invalid-input');
    expect(noGpus.message).toContain('gpus');
    const both = err(() => explain(bundle, { ...base, platform: 'nano4-h200', gpus: 1, users: 5 } as never));
    expect(both.code).toBe('invalid-input');
    expect(both.message).toContain('users');
    expect(explain(bundle, { ...base, platform: 'nano4-h200', gpus: 1 }).formulas.length).toBeGreaterThan(0);
    expect(explain(bundle, { ...base, users: 5 }).formulas.length).toBeGreaterThan(0);
  });
});

describe('predictMeasurement beyond the model context (final-review M14)', () => {
  it("returns why 'context' and no numbers when input + output exceeds maxContext", () => {
    const p = predictMeasurement(bundle, {
      platform: 'nano5-h100',
      model: 'olmo-2-0325-32b',
      quant: 'bf16',
      workload: { inputTokens: 4000, outputTokens: 200, cacheHitRate: 0 },
      concurrency: 1,
    });
    expect(p.why).toBe('context');
    expect(p.decodeTokPerSec).toBeNull();
    expect(p.ttftSec).toBeNull();
    expect(p.maxConcurrent).toBeNull();
    expect(p.shape).toBeNull();
    expect(p.step).toBeNull();
  });
});

describe('native weight split sanity (final-review M8)', () => {
  const withCheckpoint = (bytes: number): Bundle => {
    const m = bundle.models['gpt-oss-120b']!;
    const nq = m.nativeQuant!;
    return {
      ...bundle,
      models: { ...bundle.models, 'gpt-oss-120b': { ...m, nativeQuant: { ...nq, checkpointWeightBytes: { ...nq.checkpointWeightBytes, value: bytes } } } },
    };
  };
  const q = { model: 'gpt-oss-120b', quant: 'native', workload: 'chat', speed: 'smooth', users: 1 } as const;
  it('fails clearly when experts + the input embedding do not leave positive non-expert bytes', () => {
    const m = bundle.models['gpt-oss-120b']!;
    const expert = expertParamsTotalB(m) * 1e9 * bundle.quantization['mxfp4']!.bytesPerParam.value;
    // Above the experts alone but not above experts + the untied input embedding (vocab × hidden × 2).
    const emb = m.vocabSize! * m.hidden * 2;
    expect(() => estimateRequirements(withCheckpoint(expert + emb / 2), q)).toThrow(/專家權重.*輸入 embedding/);
    expect(() => estimateRequirements(withCheckpoint(expert + emb * 2), q)).not.toThrow();
  });
});

describe('explain texts follow the current formulas (final-review M1, M2, M3, M7)', () => {
  const { formulas, basis } = explain(bundle, { model: 'gpt-oss-120b', quant: 'native', workload: 'chat', speed: 'smooth', users: 50 });
  it('TTFT: per-chunk roofline sum + t_fixed per chunk + one t_request (R38, R41), with the load floor (M6)', () => {
    const t = formulas.find((f) => f.startsWith('TTFT'))!;
    expect(t).toContain('Σ_段 [max(');
    expect(t).toContain('+ 段 TP 通訊 + t_fixed]');
    expect(t).toContain('+ t_request');
    expect(t).toContain('t_step(D)');
  });
  it('capacity: KV in whole blocks (R37): vLLM roundUp(ctx, bs), sliding min(roundUp, window + bs − 1), MLX step 256, +1 block upper bound', () => {
    const c = formulas.find((f) => f.startsWith('每份模型可服務人數'))!;
    expect(c).toContain('roundUp(上下文, bs)');
    expect(c).toContain('window + bs − 1');
    expect(c).toContain('256');
    expect(c).toContain('+ 1 個 block');
  });
  it('MoE chunk = min(newTok, max_num_batched_tokens − B) (M3)', () => {
    expect(formulas.find((f) => f.includes('topK/experts'))!).toContain('min(未快取 token, max_num_batched_tokens − B)');
  });
  it('the per-request TTFT overhead cites the R41 calibration, not a lecture formula (M7)', () => {
    const item = basis.find((b) => b.path === 'calibration.nvidia-default.ttftOverheadSec')!;
    expect(item.lecRef).toBeUndefined();
    expect(item.text).toContain('R41');
  });
  it('the verify comment of a sliding-window model states the block rounding (M2)', () => {
    const g = estimateRequirements(bundle, { model: 'gemma-4-31b-it', quant: 'native', workload: 'chat', speed: 'smooth', users: 5 });
    const cmd = g.perPlatform.find((p) => p.platform === 'nano4-h200')!.verifyCommand;
    expect(cmd).toContain('window + bs − 1');
    expect(cmd).not.toContain('每人穩態保留 window 個 token');
  });
});

describe('user-supplied hfRepo must be owner/name (an input-validity check, final-review I4); the catalog org check fails closed', () => {
  const o: ModelOverride = { totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 };
  const q = (hfRepo: string) => ({ model: { ...o, hfRepo }, quant: 'bf16', workload: 'chat', speed: 'smooth', users: 1 });
  it('URL form and bare owner are rejected, not silently unchecked', () => {
    for (const bad of ['https://huggingface.co/Qwen/example-model', 'deepseek-ai', 'Qwen/']) {
      let code: string | undefined;
      try {
        estimateRequirements(bundle, q(bad));
      } catch (e) {
        code = e instanceof CoreInputError ? e.code : 'not CoreInputError';
      }
      expect(code, bad).toBe('invalid-input');
    }
    expect(() => estimateRequirements(bundle, q('example/model'))).not.toThrow();
  });
  it('excludedOrgOf (the catalog validator check) throws on a value that is not owner/name', () => {
    expect(() => excludedOrgOf(bundle.policy, 'deepseek-ai')).toThrow(/owner\/name/);
    expect(() => excludedOrgOf(bundle.policy, 'https://huggingface.co/Qwen/example-model')).toThrow(/owner\/name/);
    expect(excludedOrgOf(bundle.policy, 'qwen/x')?.org).toBe('Qwen');
    expect(excludedOrgOf(bundle.policy, undefined)).toBeUndefined();
  });
});

describe('GB200 MLA block size depends on the model (final-review M26)', () => {
  const mla = (qkNopeHeadDim: number): ModelOverride => ({
    name: 'MLA test', hfRepo: 'example/mla', totalParamsB: 20, layers: 32, heads: 32, kvHeads: 32, headDim: 128, hidden: 4096,
    attention: 'mla', mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim, vHeadDim: 128 },
  });
  const gb = (m: ModelOverride | string) =>
    estimateRequirements(bundle, { model: m, quant: 'bf16', workload: 'chat', speed: 'smooth', users: 5 }).perPlatform.find((p) => p.platform === 'nano4-gb200')!;
  it('qk_nope_head_dim in {64, 128, 192}: FlashInfer MLA, 32-token blocks', () => {
    const p = gb(mla(128));
    expect(p.basis.some((b) => b.path === 'platforms.nano4-gb200.vllmDefaults.mlaKvBlockSize.bf16Kv')).toBe(true);
    expect(p.basis.some((b) => b.path.includes('mlaKvBlockSize.otherwise'))).toBe(false);
  });
  it('another qk_nope_head_dim: FlashInfer MLA refuses it, vLLM falls back to CUTLASS MLA (128-token blocks)', () => {
    const p = gb(mla(96));
    expect(p.basis.some((b) => b.path === 'platforms.nano4-gb200.vllmDefaults.mlaKvBlockSize.otherwise.bf16Kv')).toBe(true);
    // The larger block rounds each sequence's KV up further: 1100 tokens hold 1152 (128-blocks), not 1120 (32-blocks).
    const memOnly = (m: ModelOverride) =>
      estimateCapacity(bundle, {
        model: m, quant: 'bf16', workload: { base: 'chat', inputTokens: 1000, outputTokens: 100 }, speed: 'smooth', platform: 'nano4-gb200', gpus: 1,
      }).memoryOnlyMax;
    expect(memOnly(mla(96))).toBeLessThan(memOnly(mla(128)));
  });
});

describe('usage (spec §8.3.3 細節面板)', () => {
  const b = realBundle();
  const q = { model: 'llama-3.3-70b-instruct-fp8', quant: 'fp8', workload: 'assist', speed: 'smooth', users: 15 } as const;
  it('feasible platform: usage matches its expected shape and stays within the limits', () => {
    const r = estimateRequirements(b, q).perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(r.expected.ok).toBe(true);
    const u = r.usage!;
    expect(u.shape).toEqual(r.expected.ok && r.expected.shape);
    // Task 1 deferred minor: the capacity usage is that of the capacity's expected shape too.
    const { users: _n, ...cq } = q;
    const c = estimateCapacity(b, { ...cq, platform: 'nano4-h200', gpus: 8 });
    expect(c.usage!.shape).toEqual(c.expected.shape);
    expect(u.tokPerSecPerUser).toBeCloseTo(r.expected.ok ? r.expected.check.tokPerSecPerUser : NaN, 9);
    expect(u.ttftSec).toBeCloseTo(r.expected.ok ? r.expected.check.ttftSec : NaN, 9);
    expect(u.memory.weightsBytes + u.memory.reserveBytes + u.memory.kvBytes).toBeLessThanOrEqual(u.memory.usableBytes);
    for (const s of Object.values(u.share)) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); }
  });
  it('infeasible platform: usage is null', () => {
    const r = estimateRequirements(b, { ...q, model: 'mistral-medium-3.5-128b', quant: 'bf16' })
      .perPlatform.find((p) => p.platform === 'mac-mini-m6-32')!;
    expect(r.expected.ok).toBe(false);
    expect(r.usage).toBeNull();
  });
  it('capacity: usage at expected.n, null when nobody fits', () => {
    const { users: _u, ...cq } = q;
    const c = estimateCapacity(b, { ...cq, platform: 'nano4-h200', gpus: 8 });
    expect(c.usage!.memory.residentPerReplica).toBeGreaterThan(0);
    const none = estimateCapacity(b, { ...cq, model: 'mistral-medium-3.5-128b', quant: 'bf16', platform: 'mac-mini-m6-32', gpus: 1 });
    expect(none.expected.n).toBe(0);
    expect(none.usage).toBeNull();
  });
});
describe("scale bound (final review I2: 'scale')", () => {
  const b = realBundle();
  // dgx-spark serves one replica per machine, so 200000 chat users on gemma-4-26b-a4b-it bf16 need more machines than
  // the replica bound (1e5); that one platform used to throw CoreInputError for the whole request.
  const q = { model: 'gemma-4-26b-a4b-it', quant: 'bf16', workload: 'chat', speed: 'smooth', users: 200000 } as const;
  it('estimateRequirements: the platform beyond the bound is infeasible with why scale; NCHC platforms still ok', () => {
    const r = estimateRequirements(b, q);
    const spark = r.perPlatform.find((p) => p.platform === 'dgx-spark')!;
    expect(spark.expected.ok).toBe(false);
    expect(!spark.expected.ok && spark.expected.why).toBe('scale');
    expect(!spark.expected.ok && spark.expected.detail).toContain('100000');
    expect(spark.conservative.ok).toBe(false);
    expect(spark.usage).toBeNull();
    expect(spark.verifyCommand).toBe('');
    expect(spark.verifyNote).toContain('100000');
    for (const p of r.perPlatform.filter((x) => b.platforms[x.platform]!.group === 'nchc')) expect(p.expected.ok).toBe(true);
    expect(r.best).not.toBeNull();
  });
  it('findFeasibleModels: the same scenario is not feasible on dgx-spark, why scale, without throwing', () => {
    const items = findFeasibleModels(b, { workload: 'chat', speed: 'smooth', platform: 'dgx-spark', gpus: 8, users: 200000, quant: 'bf16' });
    const g = items.find((x) => x.model === 'gemma-4-26b-a4b-it')!;
    expect(g.feasible).toBe(false);
    expect(g.why).toBe('scale');
  });
});

describe('quantOptions', () => {
  const b = realBundle();
  it('matches the quantizations findFeasibleModels evaluates, per model', () => {
    const items = findFeasibleModels(b, { workload: 'chat', speed: 'ok', platform: 'nano4-h200', gpus: 8 });
    for (const id of Object.keys(b.models)) {
      expect(quantOptions(b, id)).toEqual(items.filter((x) => x.model === id).map((x) => x.quant));
    }
  });
  it('unknown model → CoreInputError unknown-id', () => {
    expect(() => quantOptions(b, 'no-such')).toThrow(CoreInputError);
  });
});
