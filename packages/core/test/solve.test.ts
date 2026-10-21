import { describe, expect, it } from 'vitest';
import type { Model } from '@nchc/schema';
import { concurrencyFor } from '../src/concurrency';
import {
  checkShape,
  kvSizing,
  legalTpOptions,
  MAX_GPUS,
  maxConcurrent,
  maxConcurrentForGpus,
  shapeUsage,
  solveMinGpus,
  type Ctx,
  type ResolvedPlatform,
} from '../src/solve';
import { decodeStep, prefillChunkBudget, ttftSec, type Replica } from '../src/timing';

// ---- Test models (fixtures; origins all US) ----
const llama70b: Model = {
  id: 'l70',
  name: 'Llama 3.3 70B',
  hfRepo: 'example/test-model',
  origin: { developer: 'Meta', country: 'US' },
  totalParamsB: { value: 70.55, status: 'official', source: 'x', verified: '2026-10-19' },
  layers: 80,
  heads: 64,
  kvHeads: 8,
  headDim: 128,
  hidden: 8192,
  attention: 'gqa',
  source: 'x',
  verified: '2026-10-19',
};
// Llama 3.1 405B config.json: hidden 16384, layers 126, heads 128, kv 8, intermediate 53248,
// vocab 128256, untied embeddings. Not in docs/research; total derived from the config:
// 2*128256*16384 + 126*(2*16384^2 + 2*16384*1024 + 3*16384*53248 + 2*16384) + 16384 ≈ 405.85e9.
const llama405: Model = {
  ...llama70b,
  id: 'l405',
  name: 'Llama 3.1 405B',
  totalParamsB: { ...llama70b.totalParamsB, value: 405.85 },
  layers: 126,
  heads: 128,
  kvHeads: 8,
  headDim: 128,
  hidden: 16384,
};
// microsoft/phi-4 (config/models/phi-4.yaml).
const phi4: Model = {
  ...llama70b,
  id: 'phi-4',
  origin: { developer: 'Microsoft', country: 'US' },
  totalParamsB: { ...llama70b.totalParamsB, value: 14.6595072 },
  layers: 40,
  heads: 40,
  kvHeads: 10,
  headDim: 128,
  hidden: 5120,
};
const gptoss120: Model = {
  ...llama70b,
  id: 'gpt-oss-120b',
  origin: { developer: 'OpenAI', country: 'US' },
  totalParamsB: { ...llama70b.totalParamsB, value: 116.829156672 },
  layers: 36,
  heads: 64,
  kvHeads: 8,
  headDim: 64,
  hidden: 2880,
  moe: { experts: 128, topK: 4, expertFfnDim: 2880 },
  layerGroups: [
    { kind: 'sliding', count: 18, kvHeads: 8, headDim: 64, window: 128 },
    { kind: 'full', count: 18, kvHeads: 8, headDim: 64 },
  ],
};

// ---- Stub platforms (values from config/hardware.yaml, platforms.yaml, calibration.yaml) ----
type Eta = { etaBw: number; etaBwLow: number; etaCompute: number; memUtil: number; allreduceUs: number };
const nvidiaDefault: Eta = { etaBw: 0.7, etaBwLow: 0.55, etaCompute: 0.5, memUtil: 0.9, allreduceUs: 11 };
const macMlx: Eta = { etaBw: 0.86, etaBwLow: 0.81, etaCompute: 1.0, memUtil: 0.75, allreduceUs: 0 };

function stub(
  id: string,
  hw: { memGB: number; memBwTBs: number; tflops: number; nvlinkBidirGBs: number },
  gpusPerNode: number,
  tpOptions: number[],
  eta: Eta,
  unit: 'gpu' | 'machine' = 'gpu',
): ResolvedPlatform {
  return {
    id,
    name: id,
    sub: '',
    group: unit === 'gpu' ? 'nchc' : 'self',
    unit,
    gpusPerNode,
    tpOptions,
    tdpW: null,
    replicaFor(tp, e): Replica {
      return {
        tp,
        memBytes: hw.memGB * 1e9 * tp,
        memBwBytesPerSec: hw.memBwTBs * 1e12 * tp,
        flopsPerSec: hw.tflops * 1e12 * tp,
        etaBw: e === 'conservative' ? eta.etaBwLow : eta.etaBw,
        etaCompute: eta.etaCompute,
        memUtil: eta.memUtil,
        allreduceLatencySec: eta.allreduceUs * 1e-6,
        linkBwBytesPerSecPerDir: (hw.nvlinkBidirGBs * 1e9) / 2,
      };
    },
  };
}
const h200 = stub('h200', { memGB: 141, memBwTBs: 4.8, tflops: 1979, nvlinkBidirGBs: 900 }, 8, [1, 2, 4, 8], nvidiaDefault);
const h100 = stub('h100', { memGB: 80, memBwTBs: 3.35, tflops: 1979, nvlinkBidirGBs: 900 }, 8, [1, 2, 4, 8], nvidiaDefault);
const gb200 = stub('gb200', { memGB: 186, memBwTBs: 8, tflops: 5000, nvlinkBidirGBs: 1800 }, 4, [1, 2, 4], nvidiaDefault);
const mac = stub('mac', { memGB: 512, memBwTBs: 1.2, tflops: 66.6, nvlinkBidirGBs: 0 }, 1, [1], macMlx, 'machine');

// ---- Workloads ----
const smooth = { minTokPerSec: 20, maxTtftSec: 5 };
const chatCtx: Ctx = {
  model: llama70b,
  bytesPerParam: 1,
  kvBytesPerElem: 1,
  workload: { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 },
  kind: 'chat',
  speed: smooth,
  agentShare: 0.033,
  includeComm: false,
};
const assistCtx: Ctx = {
  ...chatCtx,
  workload: { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 },
  kind: 'agent',
};

// Ruling R29 (spec §5.3 2026-10-19 校正更正): prefill interference counts only the OTHER B − 1 users, so
// demo v7 goldens moved: 311→312 (H200, H100 tp8), 393→394 (GB200 tp4), H200 chat 500 users 14→13 GPUs, 622→624.
describe('golden values (demo v7, includeComm false, kv 1 B, expected eta, llama70b FP8, smooth)', () => {
  it('maxConcurrent per shape', () => {
    expect(maxConcurrent(chatCtx, h200, { tp: 8, replicas: 1 }, 'expected')).toBe(312);
    expect(maxConcurrent(chatCtx, h100, { tp: 8, replicas: 1 }, 'expected')).toBe(312);
    expect(maxConcurrent(chatCtx, gb200, { tp: 4, replicas: 1 }, 'expected')).toBe(394);
  });
  it('solveMinGpus', () => {
    // Ruling R34 (review M-7): 2 × 2 and 4 × 1 both use 4 GPUs; 4 × 1 serves more users, so it wins the tie (was 2 × 2).
    expect(solveMinGpus(assistCtx, h200, 15, 'expected')).toMatchObject({ ok: true, gpus: 4, shape: { tp: 4, replicas: 1 } });
    expect(maxConcurrent(assistCtx, h200, { tp: 4, replicas: 1 }, 'expected')).toBeGreaterThan(
      maxConcurrent(assistCtx, h200, { tp: 2, replicas: 2 }, 'expected'),
    );
    expect(solveMinGpus(assistCtx, h100, 15, 'expected')).toMatchObject({ ok: true, gpus: 8 });
    expect(solveMinGpus(assistCtx, gb200, 15, 'expected')).toMatchObject({ ok: true, gpus: 4 });
    expect(solveMinGpus(chatCtx, gb200, 500, 'expected')).toMatchObject({ ok: true, gpus: 6 });
    expect(solveMinGpus(chatCtx, h200, 500, 'expected')).toMatchObject({ ok: true, gpus: 13 });
  });
  it('maxConcurrentForGpus', () => {
    expect(maxConcurrentForGpus(chatCtx, h200, 16, 'expected').n).toBe(624);
  });
  it('Mac infeasible even for a single user', () => {
    expect(solveMinGpus(assistCtx, mac, 15, 'expected')).toMatchObject({ ok: false, why: 'ttft' });
    const macChat = solveMinGpus(chatCtx, mac, 1, 'expected');
    expect(macChat).toMatchObject({ ok: false, why: 'bw' });
  });
});

describe('review focus', () => {
  it('405B BF16 on H100 does not fit at max TP: weights, cross-node note, no NaN', () => {
    const r = solveMinGpus({ ...chatCtx, bytesPerParam: 2, model: llama405 }, h100, 1, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'weights' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).toContain('跨 node 切分尚未支援');
    expect(r.detail).not.toMatch(/NaN/);
  });
  it('legal TP follows vLLM head divisibility', () => {
    expect(legalTpOptions([1, 2, 4, 8], 8, phi4)).toEqual([1, 2]);
    expect(legalTpOptions([1, 2, 4, 8], 8, gptoss120)).toEqual([1, 2, 4, 8]);
    // kvHeads < tp: KV heads are replicated (tp % kvHeads === 0).
    expect(legalTpOptions([1, 2, 4, 8], 8, { ...llama70b, kvHeads: 4 })).toEqual([1, 2, 4, 8]);
    // t must not exceed gpusPerNode.
    expect(legalTpOptions([1, 2, 4, 8], 4, llama70b)).toEqual([1, 2, 4]);
  });
  it("no legal TP is reported as why 'tp', not 'weights' (review M-10)", () => {
    const only24 = stub('only24', { memGB: 141, memBwTBs: 4.8, tflops: 1979, nvlinkBidirGBs: 900 }, 8, [2, 4], nvidiaDefault);
    const r = solveMinGpus({ ...chatCtx, model: { ...llama70b, heads: 3, kvHeads: 3 } }, only24, 1, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'tp' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).toContain('沒有合法的 TP 切法');
  });
  it('legal TP checks every layer group KV heads, as vLLM does per layer (review M-4)', () => {
    const base = { ...llama70b, heads: 48, kvHeads: 16 };
    expect(legalTpOptions([1, 2, 4, 8], 8, base)).toEqual([1, 2, 4, 8]);
    const groups = [
      { kind: 'sliding' as const, count: 40, kvHeads: 16, window: 1024 },
      { kind: 'full' as const, count: 40, kvHeads: 6 },
    ];
    // kvHeads 6: t = 4 and 8 neither divide 6 nor are divided by it.
    expect(legalTpOptions([1, 2, 4, 8], 8, { ...base, layerGroups: groups })).toEqual([1, 2]);
    // A group without kvHeads falls back to the model's; mamba groups have no attention heads.
    const withMamba = [
      { kind: 'mamba' as const, count: 70, ssm: { heads: 64, headDim: 64, stateSize: 128 } },
      { kind: 'full' as const, count: 10 },
    ];
    expect(legalTpOptions([1, 2, 4, 8], 8, { ...base, layerGroups: withMamba })).toEqual([1, 2, 4, 8]);
  });
  it('concurrency interpretation (spec §8.3.3)', () => {
    expect(concurrencyFor(15, 'agent', 0.033)).toEqual({ generating: 1, resident: 15 });
    expect(concurrencyFor(500, 'chat', 0.033)).toEqual({ generating: 500, resident: 500 });
    expect(concurrencyFor(1000, 'agent', 0.033)).toEqual({ generating: 33, resident: 1000 });
  });
});

describe('checkShape and solver details', () => {
  it('bottleneck order: weights before mem', () => {
    const c = checkShape({ ...chatCtx, bytesPerParam: 2, model: llama405 }, h100, { tp: 8, replicas: 1 }, 1, 'expected');
    expect(c.ok).toBe(false);
    expect(c.why).toBe('weights');
    expect(c.capacityPerReplica).toBe(0);
  });
  it('capacity uses floor((mem*util - W) / kv(in+out))', () => {
    const c = checkShape(chatCtx, h200, { tp: 8, replicas: 1 }, 1, 'expected');
    expect(c.capacityPerReplica).toBe(Math.floor((8 * 141e9 * 0.9 - 70.55e9) / (1149 * 163840)));
    expect(c.ok).toBe(true);
    expect(c.why).toBeNull();
    expect(c.residentPerReplica).toBe(1);
  });
  it('mem bottleneck when resident exceeds capacity', () => {
    const c = checkShape(chatCtx, h200, { tp: 8, replicas: 1 }, 20000, 'expected');
    expect(c.why).toBe('mem');
  });
  it('conservative eta never serves more than expected', () => {
    const e = maxConcurrent(chatCtx, h200, { tp: 8, replicas: 1 }, 'expected');
    const c = maxConcurrent(chatCtx, h200, { tp: 8, replicas: 1 }, 'conservative');
    expect(c).toBeLessThanOrEqual(e);
  });
  it('maxConcurrent is 0 when one user is infeasible; ForGpus returns null shape', () => {
    expect(maxConcurrent(chatCtx, mac, { tp: 1, replicas: 1 }, 'expected')).toBe(0);
    expect(maxConcurrentForGpus(chatCtx, mac, 3, 'expected')).toEqual({ n: 0, shape: null });
    expect(maxConcurrentForGpus(chatCtx, h200, 0, 'expected')).toEqual({ n: 0, shape: null });
  });
  it('no replica cap: 1 million users get an answer, consistent with the capacity path (review: old 999 cap)', () => {
    const r = solveMinGpus(chatCtx, h200, 1e6, 'expected');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.shape.replicas).toBeGreaterThan(999);
    expect(r.gpus).toBeLessThanOrEqual(MAX_GPUS);
    // The capacity of exactly that many GPUs covers the users, and one replica fewer does not.
    expect(maxConcurrent(chatCtx, h200, r.shape, 'expected')).toBeGreaterThanOrEqual(1e6);
    expect(maxConcurrent(chatCtx, h200, { ...r.shape, replicas: r.shape.replicas - 1 }, 'expected')).toBeLessThan(1e6);
  });
  it("a fewest-GPU shape above MAX_GPUS is 'scale', naming the bound (final review I2)", () => {
    const r = solveMinGpus(chatCtx, h200, 1e7, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'scale' });
    expect(!r.ok && r.detail).toMatch(/^需要的 GPU 數（\d+）超過計算上限（100000）$/);
  });
  it('includeComm defaults on and only slows things down', () => {
    const on = checkShape({ ...chatCtx, includeComm: undefined }, h200, { tp: 8, replicas: 1 }, 100, 'expected');
    const off = checkShape(chatCtx, h200, { tp: 8, replicas: 1 }, 100, 'expected');
    expect(on.step.commSec).toBeGreaterThan(0);
    expect(on.tokPerSecPerUser).toBeLessThan(off.tokPerSecPerUser);
  });
});

describe('single-user failure reasons (Ruling R25)', () => {
  it("returns 'mem' (not 'too-many') when one sequence's KV cannot fit beside the weights", () => {
    // 8 x 10 GB x 0.9 = 72 GB usable; weights 70.55 GB; one assist sequence needs ~20.7 GB of KV.
    const tight = stub('tight', { memGB: 10, memBwTBs: 4.8, tflops: 1979, nvlinkBidirGBs: 900 }, 8, [1, 2, 4, 8], nvidiaDefault);
    const r = solveMinGpus(assistCtx, tight, 15, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'mem' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).not.toMatch(/NaN|Infinity/);
  });
  it("returns 'compute' when a single user is compute-bound", () => {
    // Huge bandwidth, tiny FLOPS: compute time dominates the decode step.
    const slow = stub('slow', { memGB: 1000, memBwTBs: 1e6, tflops: 0.5, nvlinkBidirGBs: 0 }, 1, [1], macMlx, 'machine');
    const r = solveMinGpus({ ...chatCtx, speed: { minTokPerSec: 20, maxTtftSec: 1e9 } }, slow, 1, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'compute' });
  });
});

describe('model context limit (review C3)', () => {
  const olmo = { ...llama70b, id: 'olmo', maxContext: 4096 };
  it("checkShape and the solver report 'context' when input + output exceeds maxContext", () => {
    const ctx = { ...assistCtx, model: olmo };
    expect(checkShape(ctx, h200, { tp: 1, replicas: 1 }, 1, 'expected').why).toBe('context');
    const r = solveMinGpus(ctx, h200, 15, 'expected');
    expect(r).toMatchObject({ ok: false, why: 'context' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).toContain('超過模型的最大上下文 4096 token');
    expect(maxConcurrent(ctx, h200, { tp: 8, replicas: 1 }, 'expected')).toBe(0);
  });
  it('a context within the limit is unaffected', () => {
    expect(solveMinGpus({ ...chatCtx, model: olmo }, h200, 10, 'expected')).toMatchObject({ ok: true });
  });
});

describe('single-user pre-check covers every legal TP (review: not only the largest)', () => {
  // All-reduce latency so high that TP 8 cannot reach 20 tok/s, while TP 1 is comfortably fast.
  const slowLink = stub('slow-link', { memGB: 141, memBwTBs: 4.8, tflops: 1979, nvlinkBidirGBs: 900 }, 8, [1, 2, 4, 8], {
    ...nvidiaDefault,
    allreduceUs: 10000,
  });
  const ctx: Ctx = { ...chatCtx, includeComm: true };
  it('TP 8 alone is too slow for one user', () => {
    expect(checkShape(ctx, slowLink, { tp: 8, replicas: 1 }, 1, 'expected').ok).toBe(false);
  });
  it('the solver still finds the TP 1 deployment', () => {
    expect(solveMinGpus(ctx, slowLink, 1, 'expected')).toMatchObject({ ok: true, shape: { tp: 1, replicas: 1 } });
  });
});

describe('vLLM sliding-window KV: steady state, transient reserve, startup check (review L9 fix)', () => {
  // gpt-oss-120b fixture at 1 B/param, FP8 KV: 18 sliding (window 128) + 18 full layers, 18 × 2 × 8 × 64 = 18432 B/token each.
  const perLayerGroup = 18 * 2 * 8 * 64;
  const inFlight = 2 * 8192; // max_concurrent_batches (async scheduling) × max_num_batched_tokens
  const vllm = { ...h200, slidingInFlightTokens: inFlight };
  const usable = 141e9 * 0.9;
  const weights = 116.829156672e9;
  const at = (inputTokens: number): Ctx => ({ ...chatCtx, model: gptoss120, workload: { inputTokens, outputTokens: 1, cacheHitRate: 0 } });

  it('capacity = (usable − weights − one in-flight reserve) ÷ steady-state KV (sliding layers hold the window)', () => {
    const ctxTok = 10001;
    const steady = perLayerGroup * (128 + ctxTok);
    const reserve = perLayerGroup * Math.min(inFlight, ctxTok);
    const c = checkShape(at(10000), vllm, { tp: 1, replicas: 1 }, 1, 'expected');
    expect(c.capacityPerReplica).toBe(Math.floor((usable - weights - reserve) / steady));
    // MLX-like (no in-flight tokens): no reserve.
    expect(checkShape(at(10000), h200, { tp: 1, replicas: 1 }, 1, 'expected').capacityPerReplica).toBe(
      Math.floor((usable - weights) / steady),
    );
  });

  it('one request at the upper bound (sliding at min(window − 1 + in-flight, ctx)) must fit, or vLLM refuses to start', () => {
    // Steady state fits one user, the startup upper bound does not.
    const free = usable - weights;
    const ctxTok = Math.floor((free - perLayerGroup * 128) / perLayerGroup) - 100;
    const steady = perLayerGroup * (128 + ctxTok);
    const upper = perLayerGroup * (127 + inFlight + ctxTok);
    expect(steady).toBeLessThan(free);
    expect(upper).toBeGreaterThan(free);
    const ctx = at(ctxTok - 1);
    expect(checkShape(ctx, h200, { tp: 1, replicas: 1 }, 1, 'expected').capacityPerReplica).toBe(1);
    const c = checkShape(ctx, vllm, { tp: 1, replicas: 1 }, 1, 'expected');
    expect(c.capacityPerReplica).toBe(0);
    expect(c.why).toBe('mem');
    const s = solveMinGpus(ctx, { ...vllm, tpOptions: [1] }, 1, 'expected');
    expect(s).toMatchObject({ ok: false, why: 'mem' });
    expect(s.ok ? '' : s.detail).toContain('vLLM 啟動');
  });
});

describe('KV allocation granularity: vLLM blocks, mlx-lm cache steps (spec §5.1)', () => {
  const per = 18 * 2 * 8 * 64; // gpt-oss-120b, one 18-layer group, FP8 KV, B per token
  const at = (inputTokens: number, kv = 1): Pick<Ctx, 'model' | 'workload' | 'kvBytesPerElem'> => ({
    model: gptoss120,
    workload: { inputTokens, outputTokens: 1, cacheHitRate: 0 },
    kvBytesPerElem: kv,
  });
  const vllmAlloc = { engine: 'vllm' as const, blockSize: 16, mlaBlockSize: { fp8Kv: 64, bf16Kv: 16 } };

  it('vLLM: full layers in whole blocks, sliding layers window + block − 1 on average; upper bound + 1 block', () => {
    const k = kvSizing(at(19999), { slidingInFlightTokens: 16384, kvAllocation: vllmAlloc }, 1);
    expect(k.perSeq).toBe(per * (128 + 15) + per * 20000);
    expect(k.upperBound).toBe(per * 16 * (Math.ceil((127 + 16384) / 16) + 1) + per * 20000);
    // Within one block of 20000 tokens the full layers already hold whole blocks; 20001 tokens take another block.
    expect(kvSizing(at(20000), { slidingInFlightTokens: 16384, kvAllocation: vllmAlloc }, 1).perSeq).toBe(
      per * (128 + 15) + per * 20016,
    );
  });

  it('vLLM MLA: the block size of the backend vLLM picks for the KV dtype', () => {
    const mla: Model = { ...llama70b, layers: 36, heads: 32, kvHeads: 32, attention: 'mla', mla: { kvLoraRank: 256, qkRopeHeadDim: 64, qkNopeHeadDim: 64, vHeadDim: 128 } };
    const ctx = (kv: number) => ({ model: mla, workload: { inputTokens: 999, outputTokens: 1, cacheHitRate: 0 }, kvBytesPerElem: kv });
    expect(kvSizing(ctx(1), { kvAllocation: vllmAlloc }, 2).perSeq).toBe(2 * 36 * 320 * 1 * 1024);
    expect(kvSizing(ctx(2), { kvAllocation: vllmAlloc }, 2).perSeq).toBe(2 * 36 * 320 * 2 * 1008);
  });

  it('MLX: KVCache grows in steps of 256 tokens; RotatingKVCache keeps exactly the window', () => {
    const k = kvSizing(at(19999), { kvAllocation: { engine: 'mlx', kvCacheStep: 256 } }, 1);
    expect(k).toEqual({ perSeq: per * 128 + per * 20224, reserve: 0, upperBound: per * 128 + per * 20224 });
  });

  it('no allocation rule (stub platforms): exact tokens, as before', () => {
    expect(kvSizing(at(19999), {}, 1).perSeq).toBe(per * 128 + per * 20000);
  });
});

describe('chunked prefill in TTFT: chunk = budget minus the decode tokens sharing the step (Ruling R38)', () => {
  // Comm on: each chunk step pays its own all-reduce latency, so chunking shows even where every chunk is compute-bound
  // (there the FLOPs of the chunks sum to the single pass's).
  const doc: Ctx = { ...chatCtx, includeComm: true, workload: { inputTokens: 60000, outputTokens: 343, cacheHitRate: 0 } };
  const r8 = h200.replicaFor(8, 'expected');
  const o = { weights: 1, kvBytesPerElem: 1, includeComm: true };
  it('vLLM: the other decoding requests come first, the prompt gets the rest of max_num_batched_tokens', () => {
    const vllm = { ...h200, maxNumBatchedTokens: 8192 };
    const c = checkShape(doc, vllm, { tp: 8, replicas: 1 }, 40, 'expected');
    // Under load each chunk step lasts at least the decode step it shares (final-review M6).
    expect(c.prefillTtftSec).toBe(
      ttftSec(r8, llama70b, doc.workload, { ...o, chunkTokens: prefillChunkBudget(8192, 39), stepFloorSec: c.step.stepSec }),
    );
    expect(c.prefillTtftSec).toBeGreaterThan(ttftSec(r8, llama70b, doc.workload, o));
    // Above decodingMax (queueing) only decodingMax decode, so the chunk is budget − (decodingMax − 1).
    const dMax = Math.floor((8192 * 343) / (343 + 60000));
    const q = checkShape(doc, vllm, { tp: 8, replicas: 1 }, 500, 'expected');
    expect(q.queueing?.decodingMax).toBe(dMax);
    expect(q.prefillTtftSec).toBe(
      ttftSec(r8, llama70b, doc.workload, { ...o, chunkTokens: prefillChunkBudget(8192, dMax - 1), stepFloorSec: q.step.stepSec }),
    );
  });
  it('MLX: prompts run in prefill_step_size chunks whatever the decode load; no step size → one pass', () => {
    const mlx = { ...h200, prefillStepTokens: 2048 };
    const mc = checkShape(doc, mlx, { tp: 8, replicas: 1 }, 40, 'expected');
    const m = mc.prefillTtftSec;
    // MLX runs the others' decode forward before each chunk (final-review M5, M6).
    expect(m).toBe(ttftSec(r8, llama70b, doc.workload, { ...o, chunkTokens: 2048, perChunkExtraSec: mc.step.decodeFwdSec }));
    expect(checkShape(doc, mlx, { tp: 8, replicas: 1 }, 1, 'expected').prefillTtftSec).toBe(
      ttftSec(r8, llama70b, doc.workload, { ...o, chunkTokens: 2048 }),
    );
    expect(m).toBeGreaterThan(ttftSec(r8, llama70b, doc.workload, o));
    expect(checkShape(doc, h200, { tp: 8, replicas: 1 }, 40, 'expected').prefillTtftSec).toBe(ttftSec(r8, llama70b, doc.workload, o));
  });
});

describe('MoE prefill chunk is capped at the platform max_num_batched_tokens (review L6 correction)', () => {
  it('checkShape passes the vLLM max_num_batched_tokens to the decode step; MLX-like platforms use the whole prompt', () => {
    const moeCtx: Ctx = { ...chatCtx, model: gptoss120, workload: { inputTokens: 20000, outputTokens: 200, cacheHitRate: 0 } };
    const r = h200.replicaFor(1, 'expected');
    const capped = checkShape(moeCtx, { ...h200, maxNumBatchedTokens: 8192 }, { tp: 1, replicas: 1 }, 40, 'expected');
    expect(capped.step).toEqual(
      decodeStep(r, gptoss120, 1, moeCtx.workload, 40, { includeComm: false, kvBytesPerElem: 1, maxNumBatchedTokens: 8192 }),
    );
    const whole = checkShape(moeCtx, h200, { tp: 1, replicas: 1 }, 40, 'expected');
    expect(whole.step).toEqual(decodeStep(r, gptoss120, 1, moeCtx.workload, 40, { includeComm: false, kvBytesPerElem: 1 }));
    expect(capped.step.bwSec).not.toBe(whole.step.bwSec);
  });
});

describe('queueing model: prefill queues behind vLLM max_num_batched_tokens, wait by Little\'s law (Ruling R36)', () => {
  // chat 1020 in / 129 out, no cache: r = newTok / out = 1020 / 129. Each decoding user's completions bring r prefill
  // tokens per step, so B decoding users need B × (1 + r) tokens per step; the budget holds
  // decodingMax = floor(8192 / (1 + 1020/129)) = floor(8192 × 129 / 1149) = floor(919.73) = 919.
  // Step at 919 decoding (llama70b, 8 × H200, comm off): compute-bound,
  // (919 × 2 × 70.55e9 + 919 × 80 × 32768 × 1084.5 + 918 × 1020/129 × (2 × 70.55e9 + 80 × 32768 × 510)) ÷ (8 × 1979e12 × 0.5)
  // = 1.16617e15 ÷ 7.916e15 ≈ 0.147319 s. Little's law: λ = 919 ÷ (129 × t), W = waiting ÷ λ = waiting × 129 × t ÷ 919.
  const vllm = { ...h200, maxNumBatchedTokens: 8192 };
  const shape = { tp: 8, replicas: 1 };
  const r8 = h200.replicaFor(8, 'expected');
  const opts = { includeComm: false, kvBytesPerElem: 1, maxNumBatchedTokens: 8192 };
  const t919 = decodeStep(r8, llama70b, 1, chatCtx.workload, 919, opts).stepSec;
  const ttftChat = checkShape(chatCtx, h200, shape, 1, 'expected').ttftSec;

  it('step and TTFT of the hand computation', () => {
    expect(t919).toBeCloseTo(0.147319, 6);
    expect(ttftChat).toBeCloseTo(0.018353, 6);
  });

  it('at or below decodingMax: no queue, and every value equals the no-budget result', () => {
    for (const n of [1, 300, 919]) {
      const a = checkShape(chatCtx, vllm, shape, n, 'expected');
      const b = checkShape(chatCtx, h200, shape, n, 'expected');
      expect(a.queueing, `${n}`).toBeNull();
      expect([a.ok, a.why, a.tokPerSecPerUser, a.step]).toEqual([b.ok, b.why, b.tokPerSecPerUser, b.step]);
      // The one chunk (budget − (n − 1) ≥ 1020 tokens) lasts at least the decode step under load (final-review M6).
      expect(a.ttftSec, `${n}`).toBe(n > 1 ? Math.max(b.ttftSec, a.step.stepSec) : b.ttftSec);
    }
  });

  it('just above (920): 1 waiting, W = 129 × t(919) ÷ 919 ≈ 0.02068 s, added to TTFT; speed is that of 919 decoding', () => {
    const c = checkShape(chatCtx, vllm, shape, 920, 'expected');
    const q = c.queueing!;
    expect(q.tokensPerStep).toBeCloseTo(920 * (1 + 1020 / 129), 9);
    expect(q.budget).toBe(8192);
    expect(q.decodingMax).toBe(919);
    expect(q.waiting).toBe(1);
    expect(q.waitSec).toBeCloseTo((129 * t919) / 919, 12);
    expect(q.waitSec).toBeCloseTo(0.020679, 6);
    // The prompt's one chunk shares a step with 918 decoding requests: it lasts t(919), not the 0.018 s roofline (M6).
    expect(c.ttftSec).toBeCloseTo(t919 + q.waitSec, 12);
    expect(c.prefillTtftSec).toBeCloseTo(t919, 12);
    expect(c.step.stepSec).toBe(t919);
    expect(c.tokPerSecPerUser).toBe(1 / t919);
    expect(q.reason).toBe(
      '每步需處理約 8194 token（解碼 920 + 預填 7274），超過 vLLM max_num_batched_tokens 8192：每份模型最多 919 人同時解碼，' +
        '其餘 1 人在伺服器排隊等預填，平均多等約 0.02 秒（Little\'s law），已計入首字時間',
    );
  });

  it('large overload (2483 users, 2.7 × the budget): 1564 waiting, W = 1564 × 129 × t(919) ÷ 919 ≈ 32.34 s', () => {
    const c = checkShape(chatCtx, vllm, shape, 2483, 'expected');
    const q = c.queueing!;
    expect(q.tokensPerStep / 8192).toBeCloseTo(2.7, 2);
    expect(q.waiting).toBe(1564);
    expect(q.waitSec).toBeCloseTo((1564 * 129 * t919) / 919, 9);
    expect(q.waitSec).toBeCloseTo(32.342, 3);
    expect(c.ttftSec).toBeCloseTo(t919 + 32.342, 3);
    expect(c.tokPerSecPerUser).toBeCloseTo(6.788, 3);
    // Memory still counts every user resident (waiting requests keep their cached prefix; spec §5.2).
    expect(c.residentPerReplica).toBe(2483);
  });

  it('the budget is per replica: 1840 users on 2 replicas is 920 each (queue), 1838 is 919 each (none)', () => {
    expect(checkShape(chatCtx, vllm, { tp: 4, replicas: 2 }, 1840, 'expected').queueing!.waiting).toBe(1);
    expect(checkShape(chatCtx, vllm, { tp: 4, replicas: 2 }, 1838, 'expected').queueing).toBeNull();
  });

  it('agent: B is the generating requests; uncached newTok = 126180 × 0.043 sets r', () => {
    // r = 5425.74 / 252; decodingMax = floor(8192 × 252 / (252 + 5425.74)) = floor(363.59) = 363.
    const t363 = decodeStep(r8, llama70b, 1, assistCtx.workload, 363, opts).stepSec;
    expect(t363).toBeCloseTo(0.479259, 6);
    const all = { ...assistCtx, agentShare: 1 };
    expect(checkShape(all, vllm, shape, 363, 'expected').queueing).toBeNull();
    const q1 = checkShape(all, vllm, shape, 364, 'expected').queueing!;
    expect([q1.decodingMax, q1.waiting]).toEqual([363, 1]);
    expect(q1.waitSec).toBeCloseTo((252 * t363) / 363, 12);
    // Share 0.033: 22000 sessions generate ceil(726) = 726 → 363 decoding, 363 waiting: W = 252 × t(363) ≈ 120.77 s.
    const q2 = checkShape(assistCtx, vllm, shape, 22000, 'expected').queueing!;
    expect([q2.decodingMax, q2.waiting]).toEqual([363, 363]);
    expect(q2.waitSec).toBeCloseTo(252 * t363, 9);
    expect(q2.waitSec).toBeCloseTo(120.773, 3);
    // 11000 sessions generate ceil(363) = 363: no queue.
    expect(checkShape(assistCtx, vllm, shape, 11000, 'expected').queueing).toBeNull();
  });

  it('no budget (MLX-like platform): never queues, results unchanged', () => {
    expect(checkShape(chatCtx, h200, shape, 5000, 'expected').queueing).toBeNull();
    const m = checkShape(chatCtx, mac, { tp: 1, replicas: 1 }, 5000, 'expected');
    expect(m.queueing).toBeNull();
    expect(m.ttftSec).toBe(m.prefillTtftSec);
  });

  it('the solver adds replicas when the wait breaks the TTFT target (2000 users, TP 8 only, 1 tok/s, 2 s)', () => {
    const loose: Ctx = { ...chatCtx, speed: { minTokPerSec: 1, maxTtftSec: 2 } };
    const only8 = { ...h200, tpOptions: [8] };
    // No budget: one replica serves 2000 at ≈ 3.1 tok/s and 0.018 s TTFT → 8 GPUs.
    expect(solveMinGpus(loose, only8, 2000, 'expected')).toMatchObject({ ok: true, gpus: 8, shape: { tp: 8, replicas: 1 } });
    // Budget: 1 replica → 1081 waiting, W ≈ 22.35 s > 2 ('ttft'); 2 replicas → 1000 each, 81 waiting,
    // W = 81 × 129 × t(919) ÷ 919 ≈ 1.675 s, TTFT = t(919) (the chunk's step under load, M6) + W ≈ 1.8223 s ≤ 2 → 16 GPUs.
    const one = checkShape(loose, { ...only8, maxNumBatchedTokens: 8192 }, shape, 2000, 'expected');
    expect(one.why).toBe('ttft');
    expect(one.queueing!.waitSec).toBeCloseTo((1081 * 129 * t919) / 919, 9);
    const s = solveMinGpus(loose, { ...only8, maxNumBatchedTokens: 8192 }, 2000, 'expected');
    expect(s).toMatchObject({ ok: true, gpus: 16, shape: { tp: 8, replicas: 2 } });
    if (!s.ok) throw new Error('unreachable');
    expect(s.check.queueing!.waiting).toBe(81);
    expect(s.check.ttftSec).toBeCloseTo(t919 + (81 * 129 * t919) / 919, 9);
    expect(s.check.ttftSec).toBeCloseTo(1.8223, 4);
  });

  it('capacity: feasibility stays monotone in n; the largest n keeps TTFT + W ≤ 2 s', () => {
    const loose: Ctx = { ...chatCtx, speed: { minTokPerSec: 1, maxTtftSec: 2 } };
    // Under load the chunk lasts t(919) (M6): 0.147319 + (n − 919) × 129 × t(919) ÷ 919 ≤ 2 → n − 919 ≤ 89.59 → n = 1008.
    expect(maxConcurrent(loose, vllm, shape, 'expected')).toBe(1008);
    let last = true;
    for (let n = 1; n <= 1200; n++) {
      const ok = checkShape(loose, vllm, shape, n, 'expected').ok;
      if (!last) expect(ok, `${n}`).toBe(false);
      last = ok;
    }
    // Without the budget the same shape serves far more (memory / speed bound).
    expect(maxConcurrent(loose, h200, shape, 'expected')).toBeGreaterThan(1008);
  });
});

describe('shapeUsage (spec §8.3.3 細節面板)', () => {
  const shape = { tp: 8, replicas: 2 };
  it('memory composition per replica [R-LEC B3]: usable, weights, resident × perSeq KV', () => {
    const u = shapeUsage(chatCtx, h200, shape, 100, 'expected');
    expect(u.shape).toEqual(shape);
    expect(u.memory.usableBytes).toBeCloseTo(8 * 141e9 * 0.9, 0);
    expect(u.memory.weightsBytes).toBeCloseTo(70.55e9, 0);
    expect(u.memory.residentPerReplica).toBe(50);
    expect(u.memory.perUserKvBytes).toBe(1149 * 163840);
    expect(u.memory.kvBytes).toBe(50 * 1149 * 163840);
    expect(u.memory.reserveBytes).toBe(0);
    expect(u.share.mem).toBeCloseTo((70.55e9 + 50 * 1149 * 163840) / (8 * 141e9 * 0.9), 12);
  });
  it('time shares and speed come from checkShape at the same n', () => {
    const c = checkShape(chatCtx, h200, shape, 100, 'expected');
    const u = shapeUsage(chatCtx, h200, shape, 100, 'expected');
    expect(u.share.bw).toBeCloseTo(c.step.bwSec / c.step.stepSec, 12);
    expect(u.share.compute).toBeCloseTo(c.step.computeSec / c.step.stepSec, 12);
    expect(u.share.ttft).toBeCloseTo(c.ttftSec / smooth.maxTtftSec, 12);
    expect(u.tokPerSecPerUser).toBe(c.tokPerSecPerUser);
    expect(u.ttftSec).toBe(c.ttftSec);
  });
});

describe('shapeUsage roofline', () => {
  it('roofline point lies under the roof', () => {
    const shape = { tp: 8, replicas: 2 };
    const u = shapeUsage(chatCtx, h200, shape, 100, 'expected');
    const c = checkShape(chatCtx, h200, shape, 100, 'expected');
    const r = h200.replicaFor(8, 'expected');
    const rf = u.roofline;
    expect(rf.peakTflopsPerGpu).toBeCloseTo(r.flopsPerSec / 8 / 1e12, 12);
    expect(rf.memBwTBsPerGpu).toBeCloseTo(r.memBwBytesPerSec / 8 / 1e12, 12);
    expect(rf.intensityFlopPerByte).toBeCloseTo(c.step.flop / c.step.bytes, 12);
    expect(rf.achievedTflopsPerGpu).toBeGreaterThan(0);
    expect(rf.achievedTflopsPerGpu).toBeLessThanOrEqual(Math.min(rf.peakTflopsPerGpu, rf.intensityFlopPerByte * rf.memBwTBsPerGpu));
  });
});
