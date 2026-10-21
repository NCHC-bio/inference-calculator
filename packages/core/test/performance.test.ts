import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { CoreInputError, estimateRequirements, quantOptions, resolvePlatform, resolveModel, type RequirementInput } from '../src/api';
import { estimatePerformance, estimatePerformanceSweep, PERFORMANCE_CURVE_POINTS } from '../src/performance';
import { resolveCustomPlatform, verifyCommand } from '../src/api';
import { legalTpOptions } from '../src/solve';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
const bundle = realBundle();

const defaultModel = 'llama-3.3-70b-instruct-fp8';
const nativeQuant = (model: string) => quantOptions(bundle, model)[0]!;
const defaults: RequirementInput = {
  model: defaultModel,
  quant: nativeQuant(defaultModel),
  workload: 'assist',
  speed: 'smooth',
  users: 15,
};
const queries: RequirementInput[] = [
  defaults,
  { ...defaults, workload: 'chat', users: 200 },
  { ...defaults, model: 'gpt-oss-20b', quant: nativeQuant('gpt-oss-20b'), speed: 'ok', users: 50 },
];

function legalFor(platformId: string, q: RequirementInput): number[] {
  const quant = bundle.quantization[q.quant]!;
  const { platform } = resolvePlatform(bundle, platformId, quant.computeDtype);
  const { model } = resolveModel(bundle, q.model);
  return legalTpOptions(platform.tpOptions, platform.gpusPerNode, model);
}

describe('estimatePerformance', () => {
  it('matches estimateRequirements at the suggested count', () => {
    for (const q of queries) {
      const req = estimateRequirements(bundle, q);
      let checked = 0;
      for (const r of req.perPlatform) {
        if (!r.expected.ok) continue;
        checked++;
        const p = estimatePerformance(bundle, { ...q, platform: r.platform, gpus: r.expected.gpus });
        expect(p.shape, r.platform).toEqual(r.expected.shape);
        expect(p.usage, r.platform).toEqual(r.usage);
        expect(p.maxConcurrent, r.platform).toBe(r.maxConcurrent);
        expect(p.usage!.tokPerSecPerUser, r.platform).toBe(r.expected.check.tokPerSecPerUser);
        expect(p.usage!.ttftSec, r.platform).toBe(r.expected.check.ttftSec);
        expect(p.ok, r.platform).toBe(true);
        expect(p.powerKw, r.platform).toBe(r.powerKw);
        expect(p.verifyCommand, r.platform).toBe(r.verifyCommand);
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('more replicas never slow a user down', () => {
    const req = estimateRequirements(bundle, defaults);
    const t = req.perPlatform.find((r) => r.platform === 'nano4-h200')!.expected;
    if (!t.ok) throw new Error('expected a feasible nano4-h200 default');
    const tp = t.shape.tp;
    let prev = 0;
    for (let k = 1; k <= 8; k++) {
      const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: tp * k, tp });
      const v = p.usage!.tokPerSecPerUser;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('fewer GPUs than suggested report the failure with numbers', () => {
    let tested = 0;
    for (const q of queries) {
      for (const r of estimateRequirements(bundle, q).perPlatform) {
        if (!r.expected.ok) continue;
        const t = r.expected.shape.tp;
        const gpus = r.expected.gpus - t;
        if (gpus < t) continue;
        tested++;
        const p = estimatePerformance(bundle, { ...q, platform: r.platform, gpus });
        expect(p.ok, r.platform).toBe(false);
        expect(['mem', 'bw', 'compute', 'ttft']).toContain(p.why);
        if (p.why !== 'mem') expect(p.usage, r.platform).not.toBeNull();
        expect(p.detail).toBeTruthy();
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('splits list every legal TP that fits', () => {
    const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 8 });
    const legal = legalFor('nano4-h200', defaults).filter((t) => t <= 8);
    expect(p.splits.map((s) => s.shape.tp)).toEqual(legal);
    for (const s of p.splits) expect(s.shape.replicas).toBe(8 / s.shape.tp);
    const best = [...p.splits].sort((a, b) => b.maxConcurrent - a.maxConcurrent || a.shape.tp - b.shape.tp)[0]!;
    expect(p.recommendedTp).toBe(best.shape.tp);
    expect(p.shape!.tp).toBe(best.shape.tp);
  });

  it('tp override keeps recommendedTp', () => {
    const base = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 8 });
    const other = base.splits.find((s) => s.shape.tp !== base.recommendedTp)!;
    const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 8, tp: other.shape.tp });
    expect(p.shape!.tp).toBe(other.shape.tp);
    expect(p.recommendedTp).toBe(base.recommendedTp);
  });

  it('illegal tp is an input error', () => {
    try {
      estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 4, tp: 8 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CoreInputError);
      expect((e as CoreInputError).code).toBe('invalid-input');
    }
  });

  it('no split fits in the GPUs given', () => {
    // One GPU: either no legal TP fits (smallest legal TP is 2), or the weights do not fit one card.
    let found: { platform: string; q: RequirementInput } | null = null;
    for (const m of Object.values(bundle.models)) {
      const q = { ...defaults, model: m.id, quant: nativeQuant(m.id) };
      for (const id of Object.keys(bundle.platforms)) {
        if (found) break;
        const p = estimatePerformance(bundle, { ...q, platform: id, gpus: 1 });
        if (!p.ok && p.usage === null) found = { platform: id, q };
      }
      if (found) break;
    }
    if (!found) throw new Error('no model x platform fails on one GPU without usage');
    const p = estimatePerformance(bundle, { ...found.q, platform: found.platform, gpus: 1 });
    expect(p.ok).toBe(false);
    expect(p.usage).toBeNull();
    expect(p.speedCurve).toBeNull();
    expect(['tp', 'weights', 'context', 'mem']).toContain(p.why);
    if (p.shape === null) expect(p.splits).toEqual([]);
  });

  it('a tp override that fails on weights explains itself', () => {
    let hit: ReturnType<typeof estimatePerformance> | null = null;
    for (const m of Object.values(bundle.models)) {
      const q = { ...defaults, model: m.id, quant: nativeQuant(m.id) };
      const base = estimatePerformance(bundle, { ...q, platform: 'nano4-h200', gpus: 8 });
      if (base.splits.length < 2 || base.splits[0]!.why !== 'weights' || base.splits.every((s) => s.why === 'weights')) continue;
      hit = estimatePerformance(bundle, { ...q, platform: 'nano4-h200', gpus: 8, tp: base.splits[0]!.shape.tp });
      break;
    }
    if (!hit) throw new Error('no model whose smallest TP fails on weights while a larger one fits');
    expect(hit.ok).toBe(false);
    expect(hit.why).toBe('weights');
    expect(hit.detail).toBeTruthy();
    expect(hit.verifyNote ?? '').not.toContain('：。');
  });

  it('machines count per machine', () => {
    const p = estimatePerformance(bundle, {
      ...defaults,
      model: 'gpt-oss-20b',
      quant: nativeQuant('gpt-oss-20b'),
      platform: 'mac-studio-m5u-512',
      gpus: 3,
    });
    expect(p.shape).toEqual({ tp: 1, replicas: 3 });
  });

  it('a failing Mac split speaks per machine, not per card', () => {
    const p = estimatePerformance(bundle, {
      ...defaults,
      model: 'gpt-oss-20b',
      quant: nativeQuant('gpt-oss-20b'),
      platform: 'mac-studio-m5u-512',
      gpus: 3,
      users: 100000,
    });
    expect(p.ok).toBe(false);
    expect(p.detail).toContain('每台各跑一份模型，共 3 份');
    expect(p.detail).not.toContain('每張卡');
    expect(p.verifyNote).toContain('每台各跑一份模型');
    expect(p.verifyNote).not.toContain('每張卡');
  });

  it('the schema bound on gpus holds and the largest scale does not throw', () => {
    try {
      estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 100001 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CoreInputError);
      expect((e as CoreInputError).code).toBe('invalid-input');
    }
    const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 1e5, users: 1e7 });
    expect(p.ok || ['mem', 'bw', 'compute', 'ttft'].includes(p.why as string)).toBe(true);
  });

  it('speed curve spans to the current users', () => {
    const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 2, users: 400 });
    expect(p.maxConcurrent).toBeGreaterThan(0);
    expect(400).toBeGreaterThan(p.maxConcurrent);
    const pts = p.speedCurve!.points;
    expect(pts.at(-1)!.users).toBe(400);
    expect(pts.length).toBeLessThanOrEqual(PERFORMANCE_CURVE_POINTS);
    for (const pt of pts) if (pt.users > p.maxConcurrent) expect(pt.why).not.toBeNull();
  });
});

describe('estimatePerformanceSweep', () => {
  const base = { ...defaults, platform: 'nano4-h200' };
  const gpusList = [1, 2, 3, 4, 6, 8, 12, 16];

  it('each point equals estimatePerformance at that count', () => {
    const sweep = estimatePerformanceSweep(bundle, { ...base, gpusList });
    expect(sweep.points.map((p) => p.gpus)).toEqual(gpusList);
    for (const pt of sweep.points) {
      const one = estimatePerformance(bundle, { ...base, gpus: pt.gpus });
      expect(pt.shape).toEqual(one.shape);
      expect(pt.ok).toBe(one.ok);
      expect(pt.why).toBe(one.why);
      expect(pt.maxConcurrent).toBe(one.maxConcurrent);
      expect(pt.tokPerSecPerUser).toBe(one.usage?.tokPerSecPerUser ?? null);
      expect(pt.ttftSec).toBe(one.usage?.ttftSec ?? null);
    }
    expect(sweep.dataVersion).toBe(bundle.meta.dataVersion);
    expect(sweep.basis.length).toBeGreaterThan(0);
  });

  describe('fastest (Ruling W9)', () => {
    const counts = Array.from({ length: 16 }, (_, i) => i + 1);
    const sweep = estimatePerformanceSweep(bundle, { ...base, gpusList: counts });

    it('is at least as fast as the default split when that one is ok', () => {
      for (const pt of sweep.points) {
        if (pt.ok) expect(pt.fastest!.tokPerSecPerUser).toBeGreaterThanOrEqual(pt.tokPerSecPerUser!);
      }
    });

    it('never drops as cards are added (default nano4-h200 sweep)', () => {
      const ys = sweep.points.flatMap((p) => (p.fastest ? [p.fastest.tokPerSecPerUser] : []));
      expect(ys.length).toBeGreaterThan(8);
      for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
    });

    it('is the fastest ok split, null when no split is ok', () => {
      for (const pt of sweep.points) {
        const one = estimatePerformance(bundle, { ...base, gpus: pt.gpus });
        const ok = one.splits.filter((e) => e.ok);
        if (ok.length === 0) {
          expect(pt.fastest).toBeNull();
          continue;
        }
        const top = Math.max(...ok.map((e) => e.tokPerSecPerUser));
        const best = ok.filter((e) => e.tokPerSecPerUser === top).sort((x, y) => x.shape.tp - y.shape.tp)[0]!;
        expect(pt.fastest).toEqual({ shape: best.shape, tokPerSecPerUser: best.tokPerSecPerUser, ttftSec: best.ttftSec, maxConcurrent: best.maxConcurrent });
      }
    });
  });

  it('rejects unsorted or duplicate counts', () => {
    for (const list of [[4, 2], [2, 2]]) {
      try {
        estimatePerformanceSweep(bundle, { ...base, gpusList: list });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CoreInputError);
        expect((e as CoreInputError).code).toBe('invalid-input');
      }
    }
  });

  it('bounds the list to 1..64 counts', () => {
    for (const list of [[], Array.from({ length: 65 }, (_, i) => i + 1)]) {
      try {
        estimatePerformanceSweep(bundle, { ...base, gpusList: list });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CoreInputError);
        expect((e as CoreInputError).code).toBe('invalid-input');
      }
    }
  });
});

describe('final-review fixes', () => {
  it('a failing chosen split: the verify command reproduces that split, not the largest TP', () => {
    const q: RequirementInput = { ...defaults, workload: 'chat', users: 2000 };
    const p = estimatePerformance(bundle, { ...q, platform: 'nano4-h200', gpus: 8, tp: 2 });
    expect(p.ok).toBe(false);
    expect(p.shape).toEqual({ tp: 2, replicas: 4 });
    expect(['mem', 'bw', 'compute', 'ttft']).toContain(p.why);
    expect(p.verifyCommand).toContain('--tensor-parallel-size 2 ');
    expect(p.verifyCommand).not.toContain('--tensor-parallel-size 8');
    expect(p.verifyNote).toContain('TP 2');
    expect(p.verifyNote).not.toContain('最大 TP');
  });

  it('a failing split of a capacity-style recommendation keeps its shape too', () => {
    const q: RequirementInput = { ...defaults, workload: 'chat', users: 2000 };
    const p = estimatePerformance(bundle, { ...q, platform: 'nano4-h200', gpus: 8 });
    if (!p.ok && p.shape && ['mem', 'bw', 'compute', 'ttft'].includes(p.why!)) {
      expect(p.verifyCommand).toContain(`--tensor-parallel-size ${p.shape.tp} `);
    }
  });

  it('power counts the GPUs the chosen shape uses, and says idle ones are not counted', () => {
    const tdp = bundle.hardware[bundle.platforms['nano4-h200']!.hardware]!.tdpW.value!;
    const p = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 7, tp: 2 });
    expect(p.ok).toBe(true);
    expect(p.shape).toEqual({ tp: 2, replicas: 3 });
    expect(p.powerKw).toBeCloseTo((6 * tdp) / 1000, 10);
    expect(p.powerNote).toContain('閒置');
    const full = estimatePerformance(bundle, { ...defaults, platform: 'nano4-h200', gpus: 8, tp: 2 });
    expect(full.powerKw).toBeCloseTo((8 * tdp) / 1000, 10);
    expect(full.powerNote).toBeUndefined();
  });

  it('a custom platform is named by its display name in a TP error, not the id "custom"', () => {
    const quant = bundle.quantization[defaults.quant]!;
    const { platform } = resolveCustomPlatform(bundle, {
      name: 'My H200', unit: 'gpu', gpusPerNode: 8, memGB: 141, memBwTBs: 4.8, tflops: 900, tdpW: 700, nvlinkBidirGBs: 900, engine: 'vllm',
    }, quant.computeDtype);
    const { model } = resolveModel(bundle, defaults.model);
    try {
      verifyCommand(platform, { tp: 3, replicas: 1 }, model, { inputTokens: 1000, outputTokens: 100 } as never, 1, {
        quant, kvBytesPerElem: quant.kvBytesPerElem.value, kind: 'chat', agentShare: 0.1, maxModelLenMarginTokens: 1,
      } as never);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CoreInputError);
      expect((e as CoreInputError).message).toContain('My H200');
      expect((e as CoreInputError).message).not.toContain('custom');
    }
  });
});
