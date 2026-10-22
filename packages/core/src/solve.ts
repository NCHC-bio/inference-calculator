/** "TP t，共 t 張卡" (Macs: machines): the memory figures beside it are per replica, not per card or per node. */
function perReplica(platform: ResolvedPlatform, t: number): string {
  return `TP ${t}，共 ${t} ${platform.unit === 'machine' ? '台' : '張卡'}`;
}

/**
 * Deployment solver: legal tensor-parallel sizes, shape feasibility, minimum-GPU solve and
 * capacity search. Allocation unit is the GPU (spec §10.2): a replica uses t GPUs inside one
 * node (t <= gpusPerNode), any number of replicas; Mac is counted per machine with t = 1.
 * Cross-node splitting is out of scope and reported as infeasible.
 */
import type { Model, Platform } from '@nchc/schema';
import { concurrencyFor } from './concurrency';
import { kvBytesPerSequence, slidingTransientKvBytes, weightBytes, type KvSeqOpts, type WeightBytes } from './model-math';
import { decodeStep, prefillChunkBudget, ttftSec, type Replica, type WorkloadIn } from './timing';

export type EtaMode = 'expected' | 'conservative';

/** A platform with config resolved to numbers (produced by Task 9 `resolvePlatform`). */
export type ResolvedPlatform = {
  id: string;
  name: string;
  sub: string;
  group: Platform['group'];
  unit: Platform['unit'];
  gpusPerNode: number;
  tpOptions: number[];
  tdpW: number | null;
  /**
   * vLLM max_in_flight_tokens = max_concurrent_batches × max_num_batched_tokens: the chunked-prefill tokens a replica's
   * sliding-window layers may hold beyond their windows (kvSizing); 0 for MLX; absent → 0. Capacity only: a decode
   * step still reads just the window.
   */
  slidingInFlightTokens?: number;
  /**
   * vLLM max_num_batched_tokens: caps one request's prefill chunk in the MoE experts-touched mixture (decodeStep) and
   * is the per-step token budget of the queueing model (decodingMaxFor / queueingFor, Ruling R36);
   * absent (MLX) → the whole uncached prompt is one chunk.
   */
  maxNumBatchedTokens?: number;
  /**
   * mlx-lm prefill_step_size: an MLX prompt runs in chunks of it whatever the decode load (TTFT, Ruling R38); absent with
   * maxNumBatchedTokens (vLLM: the chunk is what the decode tokens leave of the budget) or without either (one pass).
   */
  prefillStepTokens?: number;
  /**
   * How the engine allocates KV (spec §5.1): vLLM in blocks of `blockSize` tokens (MLA: the block size of the backend
   * vLLM picks for the KV dtype), mlx-lm in `KVCache` steps of `kvCacheStep` tokens; absent → exact tokens.
   */
  kvAllocation?: KvAllocation;
  /** Totals for one replica of `tp` GPUs; 'conservative' uses etaBwLow instead of etaBw. */
  replicaFor(tp: number, eta: EtaMode): Replica;
};

export type Ctx = {
  model: Model;
  /** Bytes per parameter of the quantization (used when `weights` is absent). */
  bytesPerParam: number;
  /**
   * Exact resident weight bytes and their routed-expert share (api weightSizing: native checkpoint size, or
   * 16-bit embedding / lm_head beside quantized layers); absent → totalParams × bytesPerParam throughout.
   */
  weights?: WeightBytes;
  /** KV-cache bytes per element (1 = FP8 KV cache, 2 = BF16); Ruling R8. */
  kvBytesPerElem: number;
  workload: WorkloadIn;
  kind: 'chat' | 'agent';
  speed: { minTokPerSec: number; maxTtftSec: number };
  agentShare: number;
  /** Include tensor-parallel all-reduce time in the decode step (default true). */
  includeComm?: boolean;
};

export type Shape = { tp: number; replicas: number };

/** Engine KV allocation granularity of a platform (ResolvedPlatform.kvAllocation; spec §5.1). */
export type KvAllocation =
  | {
      engine: 'vllm';
      blockSize: number;
      /** qkNopeHeadDims / otherwise: the MLA backend's qk_nope_head_dim condition and the fallback backend's blocks (M26). */
      mlaBlockSize: { fp8Kv: number; bf16Kv: number; qkNopeHeadDims?: number[]; otherwise?: { fp8Kv: number; bf16Kv: number } };
    }
  | { engine: 'mlx'; kvCacheStep: number };

/**
 * Allocation granularity (tokens) of a model's KV on a platform: vLLM block_size (MLA: `mlaBlockSize` for 1-byte FP8
 * KV, else the 16-bit one), mlx-lm `KVCache.step`; 1 without a rule. Basis: spec §5.1.
 */
export function kvBlockTokens(alloc: KvAllocation | undefined, m: Pick<Model, 'attention' | 'mla'>, kvBytesPerElem: number): number {
  if (!alloc) return 1;
  if (alloc.engine === 'mlx') return alloc.kvCacheStep;
  if (m.attention === 'mla') {
    const b = mlaBackendBlocks(alloc.mlaBlockSize, m);
    return kvBytesPerElem === 1 ? b.fp8Kv : b.bf16Kv;
  }
  return alloc.blockSize;
}

/**
 * The MLA block sizes that apply to `m` (final-review M26): the first backend's, unless it accepts only some
 * qk_nope_head_dim values and the model's is not one of them — then the fallback backend's (`otherwise`). vLLM v0.32.0 on
 * SM100: FLASHINFER_MLA needs qk_nope_head_dim ∈ {64, 128, 192} (vllm/v1/attention/backends/mla/flashinfer_mla.py
 * L228-L250); next in vllm/platforms/cuda.py L120-L131 is TOKENSPEED_MLA (DeepSeek R1 dims 128/64/128 only, so never
 * for a qk_nope outside the set; tokenspeed_mla.py L133-L171), then CUTLASS_MLA (SM100, fp8 and 16-bit KV, block 128;
 * cutlass_mla.py L38-L66). Basis: spec §5.1 (KV allocation).
 */
export function mlaBackendBlocks(
  b: { fp8Kv: number; bf16Kv: number; qkNopeHeadDims?: number[]; otherwise?: { fp8Kv: number; bf16Kv: number } },
  m: Pick<Model, 'mla'>,
): { fp8Kv: number; bf16Kv: number; fallback: boolean } {
  const nope = m.mla?.qkNopeHeadDim;
  if (b.qkNopeHeadDims && b.otherwise && nope !== undefined && !b.qkNopeHeadDims.includes(nope)) {
    return { ...b.otherwise, fallback: true };
  }
  return { fp8Kv: b.fp8Kv, bf16Kv: b.bf16Kv, fallback: false };
}

/**
 * KV sizing of one replica at context in + out (spec §5.1, review L9 fix, block allocation 2026-10-20):
 * - perSeq: steady-state bytes per resident sequence. vLLM: full / MLA layers ceil(ctx / bs) × bs tokens, sliding layers
 *   min(ceil(ctx / bs) × bs, window + bs − 1) — out-of-window whole blocks are freed before each chunk
 *   (`remove_skipped_blocks`), and the blocks a sequence keeps average window + bs − 1 tokens (KvSeqOpts). MLX: full
 *   layers in `KVCache` steps (ceil(ctx / 256) × 256), sliding layers exactly the window (`RotatingKVCache`).
 * - reserve: the in-flight chunks' overshoot of the window, once per replica (slidingTransientKvBytes; 0 on MLX);
 * - upperBound: one request at vLLM's per-request upper bound, full layers cdiv(ctx, bs) blocks, sliding layers
 *   bs × (cdiv(min(window − 1 + in-flight, ctx), bs) + 1) (`SlidingWindowSpec.max_admission_blocks_per_request`); if it
 *   does not fit beside the weights vLLM refuses to start (v0.32.0 `check_enough_kv_cache_memory`,
 *   vllm/v1/core/kv_cache_utils.py L1104-1136). Equals perSeq on MLX.
 * Granularity: kvBlockTokens (platform kvAllocation; exact without one).
 */
export function kvSizing(
  ctx: Pick<Ctx, 'model' | 'workload' | 'kvBytesPerElem'>,
  platform: Pick<ResolvedPlatform, 'slidingInFlightTokens' | 'kvAllocation'>,
  tp: number,
): { perSeq: number; reserve: number; upperBound: number } {
  const tokens = ctx.workload.inputTokens + ctx.workload.outputTokens;
  const inFlight = platform.slidingInFlightTokens ?? 0;
  const bt = kvBlockTokens(platform.kvAllocation, ctx.model, ctx.kvBytesPerElem);
  const steady: KvSeqOpts = {
    blockTokens: bt,
    // vLLM keeps whole blocks: window + bs − 1 on average; MLX's RotatingKVCache keeps exactly the window.
    slidingExtraTokens: platform.kvAllocation?.engine === 'vllm' ? bt - 1 : 0,
  };
  const perSeq = kvBytesPerSequence(ctx.model, tokens, ctx.kvBytesPerElem, tp, steady);
  if (!(inFlight > 0)) return { perSeq, reserve: 0, upperBound: perSeq };
  return {
    perSeq,
    reserve: slidingTransientKvBytes(ctx.model, tokens, inFlight, ctx.kvBytesPerElem, tp),
    upperBound: kvBytesPerSequence(ctx.model, tokens, ctx.kvBytesPerElem, tp, {
      blockTokens: bt,
      slidingUpperBoundInFlight: inFlight,
    }),
  };
}
/**
 * Why a shape / scenario is infeasible. 'tp': no tensor-parallel size vLLM accepts fits the platform (head
 * divisibility, t ≤ gpusPerNode); 'context': input + output beyond the model's maxContext; 'weights': the weights
 * fit on no single-node shape; 'mem': the KV cache does not fit beside them; 'bw' / 'compute': per-user speed
 * below target, by the decode bottleneck; 'ttft': first-token time above target; 'scale': a deployment exists but its
 * GPU (machine) count exceeds MAX_GPUS, the bound every public entry point accepts for a GPU or replica count (final
 * review I2: that one platform is reported infeasible instead of the request throwing).
 */
export type Why = 'tp' | 'context' | 'weights' | 'mem' | 'bw' | 'compute' | 'ttft' | 'scale';

/**
 * Prefill queueing behind vLLM max_num_batched_tokens (Ruling R36, spec §5.2, §5.3), per replica / DP rank.
 * Closed loop: each generating request, after `out` decode tokens, is followed by the next request's newTok uncached
 * prefill tokens (newTok = input × (1 − cacheHitRate)). D decoding requests complete D / out requests per step, so the
 * step must carry D decode + D × newTok / out prefill tokens (flow balance; the budget counts every token, the own
 * next prefill included). vLLM schedules at most `budget` tokens per step (docs/research/vllm-tp-kv-precision.md §7.1;
 * requests that do not fit stay in the waiting queue, §7.2, §7.4), so at most
 * decodingMax = max(1, floor(budget × out ÷ (out + newTok))) decode at once; the other B − decodingMax wait.
 * Little's law (J. D. C. Little, Operations Research 9(3), 1961) on the waiting room: λ = decodingMax ÷ (out × t_step),
 * W = (B − decodingMax) ÷ λ. Deterministic fluid approximation without burstiness: W is a lower bound of real waits.
 */
export type Queueing = {
  /** Tokens per step B decoding users would need: B × (1 + newTok / out). */
  tokensPerStep: number;
  /** vLLM max_num_batched_tokens of the platform. */
  budget: number;
  /** Most requests that decode at once within the budget (B_max). */
  decodingMax: number;
  /** Generating requests left waiting for prefill: B − decodingMax. */
  waiting: number;
  /** Little's-law wait W (seconds), added to the TTFT. */
  waitSec: number;
  reason: string;
};

/**
 * Most requests per replica that decode at once within `budget` (Ruling R36): max(1, floor(budget × out ÷ (out +
 * newTok))); one request always runs (its prompt is chunked over several steps). Undefined without a budget (MLX).
 */
export function decodingMaxFor(w: WorkloadIn, budget: number | undefined): number | undefined {
  if (budget === undefined) return undefined;
  const newTok = w.inputTokens * (1 - w.cacheHitRate);
  // + 1e-9: keep an exact integer quotient from rounding below itself.
  return Math.max(1, Math.floor((budget * w.outputTokens) / (w.outputTokens + newTok) + 1e-9));
}

/**
 * The queue of `genBatch` generating requests per replica (Ruling R36), given the step time at decodingMax decoding.
 * Null when they all decode (B ≤ decodingMax) or there is no budget.
 */
export function queueingFor(
  w: WorkloadIn,
  genBatch: number,
  budget: number | undefined,
  stepSecAtMax: number,
): Queueing | null {
  const dMax = decodingMaxFor(w, budget);
  if (budget === undefined || dMax === undefined || !(genBatch > dMax)) return null;
  const r = (w.inputTokens * (1 - w.cacheHitRate)) / w.outputTokens;
  const waiting = genBatch - dMax;
  // λ = dMax ÷ (out × t_step) completions per second; W = waiting ÷ λ (Little 1961).
  const waitSec = (waiting * w.outputTokens * stepSecAtMax) / dMax;
  const tokensPerStep = genBatch * (1 + r);
  const wait = waitSec >= 10 ? waitSec.toFixed(0) : waitSec >= 1 ? waitSec.toFixed(1) : waitSec.toFixed(2);
  return {
    tokensPerStep,
    budget,
    decodingMax: dMax,
    waiting,
    waitSec,
    reason:
      `每步需處理約 ${Math.round(tokensPerStep)} token（解碼 ${genBatch} + 預填 ${Math.round(genBatch * r)}），` +
      `超過 vLLM max_num_batched_tokens ${budget}：每份模型最多 ${dMax} 人同時解碼，其餘 ${waiting} 人在伺服器排隊等預填，` +
      `平均多等約 ${wait} 秒（Little's law），已計入首字時間`,
  };
}

/**
 * Resident weight bytes of a ctx: the exact split when known, else totalParams × bytesPerParam (weightBytes).
 * Basis: spec §5.1 (weight footprint).
 */
export function ctxWeightBytes(ctx: Pick<Ctx, 'model' | 'bytesPerParam' | 'weights'>): number {
  return ctx.weights?.resident ?? weightBytes(ctx.model, ctx.bytesPerParam);
}
export const MAX_N = 1e7;
/** Largest GPU (machine) count, and so replica count, a result may use: the public API's input bound (api.ts schemas). */
export const MAX_GPUS = 1e5;

/**
 * KV-head counts the TP divisibility rule applies to: every attention layer group's kvHeads (falling back to the
 * model's), or the model's kvHeads without groups. vLLM checks each layer (docs/research/vllm-tp-kv-precision.md
 * §3.6: Gemma 4 takes per-layer KV heads and applies the §1.3 asserts). Mamba groups have no attention heads.
 */
function kvHeadCounts(m: Pick<Model, 'kvHeads' | 'layerGroups'>): number[] {
  if (!m.layerGroups) return [m.kvHeads];
  const out = m.layerGroups.filter((g) => g.kind !== 'mamba').map((g) => g.kvHeads ?? m.kvHeads);
  return out.length > 0 ? out : [m.kvHeads];
}

/**
 * Tensor-parallel sizes vLLM accepts for this model on this platform. Keeps t when
 * t <= gpusPerNode, heads % t === 0, and, for every KV-head count K of the model (kvHeadCounts: each layer
 * group's), K % t === 0 || t % K === 0.
 *
 * vLLM source (v0.32.0, docs/research/vllm-tp-kv-precision.md §1.2–1.4, §3.6):
 * - vllm/config/model.py L1544-1551: `total_num_attention_heads % tensor_parallel_size != 0` → ValueError;
 * - vllm/model_executor/layers/linear.py `QKVParallelLinear` L1053-1058: KV heads replicated with
 *   `divide(tp_size, total_num_kv_heads)` when `tp_size >= total_num_kv_heads`, else `divide(total_num_kv_heads,
 *   tp_size)`; `divide` asserts exact divisibility (vllm/distributed/utils.py L58-62);
 * - model files (llama.py L145-156, gemma4.py L386-393 per layer) assert the same.
 * Basis: spec §10.2 (allocation); not covered by the lecture.
 */
export function legalTpOptions(platformTp: number[], gpusPerNode: number, m: Model): number[] {
  return [...platformTp]
    .filter(
      (t) =>
        Number.isInteger(t) &&
        t >= 1 &&
        t <= gpusPerNode &&
        m.heads % t === 0 &&
        kvHeadCounts(m).every((k) => k % t === 0 || t % k === 0),
    )
    .sort((a, b) => a - b);
}

/**
 * Feasibility of `shape` serving `n` concurrent users (spec §8.3.3 interpretation).
 * Per-replica batches: generating = ceil(gen / replicas), resident = ceil(resident / replicas).
 * capacityPerReplica = floor((memBytes x memUtil - weightBytes - kvSizing.reserve) / kvSizing.perSeq), 0 when one
 * request at vLLM's upper bound (kvSizing.upperBound) does not fit beside the weights; the KV is the total over the
 * replica (KV heads replicated when tp > kvHeads, MLA latent copied on every rank; spec §5.1),
 * clamped at 0. Bottleneck order: context > weights > mem > speed (bw if bwSec >= computeSec, else
 * compute) > ttft. 'context': input + output exceeds the model's maxContext (review C3), so vLLM
 * would refuse the request whatever the hardware.
 * Queueing (Ruling R36, queueingFor): with a per-step budget (vLLM max_num_batched_tokens) at most decodingMax of the
 * B generating requests per replica decode; the step (and the per-user speed of those decoding) is computed at
 * min(B, decodingMax), and `ttftSec` = prefill TTFT (`prefillTtftSec`) + the Little's-law wait W. The prefill runs in
 * chunks (Ruling R38): vLLM prefillChunkBudget(max_num_batched_tokens, decoding − 1), MLX prefill_step_size. Every user still
 * counts as resident: a waiting request's earlier turns stay in the prefix cache, which the cache hit rate assumes.
 * Basis: spec §5.1 (memory), §5.3 (decode/TTFT via decodeStep [R-LEC B1, B3, A4, C1, B8] and
 * ttftSec [R-LEC A2, A5, B1, B7, B9]), §8.3.3 (concurrency), §10.2 (allocation).
 */
export function checkShape(
  ctx: Ctx,
  platform: ResolvedPlatform,
  shape: Shape,
  n: number,
  eta: EtaMode,
): {
  ok: boolean;
  why: Why | null;
  tokPerSecPerUser: number;
  /** TTFT the target is checked against: prefillTtftSec + queueing wait (0 without a queue). */
  ttftSec: number;
  /** Prefill time alone (ttftSec of timing: roofline + all-reduce + t_fixed), no queueing. */
  prefillTtftSec: number;
  residentPerReplica: number;
  capacityPerReplica: number;
  step: ReturnType<typeof decodeStep>;
  queueing: Queueing | null;
} {
  const { model: m, workload: w } = ctx;
  const r = platform.replicaFor(shape.tp, eta);
  const conc = concurrencyFor(n, ctx.kind, ctx.agentShare);
  const genPerReplica = Math.ceil(conc.generating / shape.replicas);
  const residentPerReplica = Math.ceil(conc.resident / shape.replicas);

  const usable = r.memBytes * r.memUtil;
  const weights = ctxWeightBytes(ctx);
  const fits = weights <= usable;
  const kv = kvSizing(ctx, platform, shape.tp);
  const free = usable - weights;
  // vLLM refuses to start when one request at its upper bound does not fit (kvSizing); otherwise the in-flight
  // reserve comes off once and each resident sequence takes its steady-state KV.
  const capacityPerReplica = !fits || kv.upperBound > free
    ? 0
    : kv.perSeq > 0
      ? Math.max(0, Math.floor((free - kv.reserve) / kv.perSeq))
      : Number.MAX_SAFE_INTEGER;

  // Within the budget all B decode; above it only decodingMax do, the rest wait (Ruling R36).
  const dMax = decodingMaxFor(w, platform.maxNumBatchedTokens);
  const decoding = dMax !== undefined ? Math.min(genPerReplica, dMax) : genPerReplica;
  const step = decodeStep(r, m, ctx.weights ?? ctx.bytesPerParam, w, decoding, {
    includeComm: ctx.includeComm ?? true,
    kvBytesPerElem: ctx.kvBytesPerElem,
    ...(platform.maxNumBatchedTokens !== undefined ? { maxNumBatchedTokens: platform.maxNumBatchedTokens } : {}),
    // MLX runs the prompt chunks as separate forwards after the decode forward (final-review M5).
    ...(platform.maxNumBatchedTokens === undefined && platform.prefillStepTokens !== undefined
      ? { prefillStepTokens: platform.prefillStepTokens }
      : {}),
  });
  const tokPerSecPerUser = step.tokensPerSecPerUser;
  // Chunked prefill (Ruling R38): on vLLM the other `decoding − 1` requests decode in the steps of this prompt and are
  // scheduled first, so a chunk is what they leave of max_num_batched_tokens; MLX chunks at prefill_step_size.
  const chunkTokens =
    platform.maxNumBatchedTokens !== undefined
      ? prefillChunkBudget(platform.maxNumBatchedTokens, decoding - 1)
      : platform.prefillStepTokens;
  const prefillTtft = ttftSec(r, m, w, {
    weights: ctx.weights ?? ctx.bytesPerParam,
    kvBytesPerElem: ctx.kvBytesPerElem,
    includeComm: ctx.includeComm ?? true,
    ...(chunkTokens !== undefined ? { chunkTokens } : {}),
    // Under load (others decode while this prompt prefills; final-review M6): vLLM's fused chunk step lasts at least
    // the decode step it shares; MLX's iteration runs the decode forward before each chunk.
    ...(decoding > 1
      ? platform.maxNumBatchedTokens !== undefined
        ? { stepFloorSec: step.stepSec }
        : platform.prefillStepTokens !== undefined
          ? { perChunkExtraSec: step.decodeFwdSec }
          : {}
      : {}),
  });
  const queueing = queueingFor(w, genPerReplica, platform.maxNumBatchedTokens, step.stepSec);
  const ttft = prefillTtft + (queueing?.waitSec ?? 0);

  let why: Why | null = null;
  if (exceedsMaxContext(m, w)) why = 'context';
  else if (!fits) why = 'weights';
  else if (residentPerReplica > capacityPerReplica) why = 'mem';
  else if (tokPerSecPerUser < ctx.speed.minTokPerSec) why = step.bwSec >= step.computeSec ? 'bw' : 'compute';
  else if (ttft > ctx.speed.maxTtftSec) why = 'ttft';

  return {
    ok: why === null,
    why,
    tokPerSecPerUser,
    ttftSec: ttft,
    prefillTtftSec: prefillTtft,
    residentPerReplica,
    capacityPerReplica,
    step,
    queueing,
  };
}

/** One replica of `shape` at n users (spec §8.3.3 細節面板; v7 草稿 DetailT 的四根使用率條). */
export type ShapeUsage = {
  shape: Shape;
  /** Bytes per replica: usable = memBytes × memUtil; kv = residentPerReplica × kvSizing.perSeq. */
  memory: {
    usableBytes: number;
    weightsBytes: number;
    kvBytes: number;
    reserveBytes: number;
    perUserKvBytes: number;
    residentPerReplica: number;
  };
  /** 1 = at the limit. mem = (weights + reserve + kv) / usable; bw = step.bwSec / step.stepSec;
   *  compute = step.computeSec / step.stepSec; ttft = ttftSec / speed.maxTtftSec. */
  share: { mem: number; bw: number; compute: number; ttft: number };
  tokPerSecPerUser: number;
  ttftSec: number;
  /** Roofline coordinates of one decode step per GPU (peak and bandwidth are hardware, not multiplied by η). */
  roofline: { peakTflopsPerGpu: number; memBwTBsPerGpu: number; intensityFlopPerByte: number; achievedTflopsPerGpu: number };
};

/**
 * Usage of one replica of `shape` serving `n` users, for the detail panel's four bars (spec §8.3.3; v7 draft DetailT):
 * memory composition [R-LEC B3] (usable = memBytes × memUtil, weights ctxWeightBytes, the in-flight reserve and the
 * resident sequences' steady-state KV, kvSizing) and the shares of each limit. bw / compute are the shares of the step
 * time (v7 draft); the largest of the four shares is the bottleneck. Step, TTFT and residentPerReplica come from
 * checkShape, so no formula is repeated here. Shares above 1 mean the shape is infeasible on that limit.
 */
export function shapeUsage(ctx: Ctx, platform: ResolvedPlatform, shape: Shape, n: number, eta: EtaMode): ShapeUsage {
  const c = checkShape(ctx, platform, shape, n, eta);
  const r = platform.replicaFor(shape.tp, eta);
  const usableBytes = r.memBytes * r.memUtil;
  const weightsBytes = ctxWeightBytes(ctx);
  const kv = kvSizing(ctx, platform, shape.tp);
  const kvBytes = c.residentPerReplica * kv.perSeq;
  return {
    shape,
    memory: {
      usableBytes,
      weightsBytes,
      kvBytes,
      reserveBytes: kv.reserve,
      perUserKvBytes: kv.perSeq,
      residentPerReplica: c.residentPerReplica,
    },
    share: {
      mem: (weightsBytes + kv.reserve + kvBytes) / usableBytes,
      bw: c.step.bwSec / c.step.stepSec,
      compute: c.step.computeSec / c.step.stepSec,
      ttft: c.ttftSec / ctx.speed.maxTtftSec,
    },
    tokPerSecPerUser: c.tokPerSecPerUser,
    ttftSec: c.ttftSec,
    roofline: {
      peakTflopsPerGpu: r.flopsPerSec / r.tp / 1e12,
      memBwTBsPerGpu: r.memBwBytesPerSec / r.tp / 1e12,
      intensityFlopPerByte: c.step.flop / c.step.bytes,
      achievedTflopsPerGpu: c.step.flop / c.step.stepSec / r.tp / 1e12,
    },
  };
}

const GB = (bytes: number) => (bytes / 1e9).toFixed(0);

/** input + output beyond the model's maxContext (review C3); a model without maxContext never exceeds. */
export function exceedsMaxContext(m: Pick<Model, 'maxContext'>, w: Pick<WorkloadIn, 'inputTokens' | 'outputTokens'>): boolean {
  return m.maxContext !== undefined && w.inputTokens + w.outputTokens > m.maxContext;
}

/** Detail text of the 'context' reason (review C3). */
export function contextDetail(ctx: Pick<Ctx, 'model' | 'workload'>): string {
  const w = ctx.workload;
  return `每人上下文 ${w.inputTokens + w.outputTokens} token（輸入 ${w.inputTokens} + 輸出 ${w.outputTokens}）超過模型的最大上下文 ${ctx.model.maxContext} token`;
}

/** How far a single-user check got before failing, in the reporting order of Ruling R24 / R25. */
export const progress = (c: ReturnType<typeof checkShape>, maxTtftSec: number, minTokPerSec: number): number =>
  c.why === 'context' ? -1
    : c.why === 'weights' ? 0
      : c.why === 'mem' ? 1
        : c.ttftSec > maxTtftSec ? 2
          : c.tokPerSecPerUser < minTokPerSec ? 3
            : 4;

/**
 * Why not even one user fits on any of the tensor-parallel sizes `ts` (one replica each), or null when one does.
 * Single-user check at EVERY t: a larger t is not always better (all-reduce slows the step; the MLA latent is copied on
 * each rank). When none works, the reason comes from the t that got furthest: weights, then one sequence's KV beside the
 * weights ('mem', Ruling R25), then TTFT (independent of n and replicas), then per-user speed (Ruling R24); ties keep
 * the larger t. `where` names the GPUs searched in the detail text. Context and TP legality are the caller's checks.
 * Basis: spec §5.5, §10.2.
 */
export function singleUserWhy(
  ctx: Ctx,
  platform: ResolvedPlatform,
  ts: number[],
  eta: EtaMode,
  where: string,
): { why: Why; detail: string } | null {
  const tMax = ts[ts.length - 1]!;
  let one = checkShape(ctx, platform, { tp: tMax, replicas: 1 }, 1, eta);
  let tOne = tMax;
  let furthest = progress(one, ctx.speed.maxTtftSec, ctx.speed.minTokPerSec);
  for (const t of ts) {
    if (furthest === 4) break;
    const c = checkShape(ctx, platform, { tp: t, replicas: 1 }, 1, eta);
    const p = progress(c, ctx.speed.maxTtftSec, ctx.speed.minTokPerSec);
    if (p > furthest) {
      one = c;
      tOne = t;
      furthest = p;
    }
  }
  if (furthest === 0) {
    const r = platform.replicaFor(tMax, eta);
    return {
      why: 'weights',
      detail: `模型權重需要 ${GB(ctxWeightBytes(ctx))} GB，但${where}內最大的一份模型（${perReplica(platform, tMax)}）只有 ${GB(r.memBytes * r.memUtil)} GB 可用（跨 node 切分尚未支援）`,
    };
  }
  if (furthest === 1) {
    const r = platform.replicaFor(tOne, eta);
    const kv = kvSizing(ctx, platform, tOne);
    const free = r.memBytes * r.memUtil - ctxWeightBytes(ctx);
    // Steady state fits but vLLM's startup check (one request at its sliding-window upper bound) does not.
    const startup = kv.upperBound > free && kv.perSeq <= free;
    return {
      why: 'mem',
      detail: startup
        ? `模型權重 ${GB(ctxWeightBytes(ctx))} GB 放進${where}內的一份模型（${perReplica(platform, tOne)}，每份可用 ${GB(r.memBytes * r.memUtil)} GB）後，剩下的記憶體放不下 vLLM 啟動檢查的 1 人上限（約 ${(kv.upperBound / 1e9).toFixed(1)} GB，sliding window 層以 window − 1 + 進行中的 ${platform.slidingInFlightTokens} 個 token 計，取整到 KV block 後再加 1 個 block），vLLM 啟動時會拒絕（跨 node 切分尚未支援）`
        : `模型權重 ${GB(ctxWeightBytes(ctx))} GB 放進${where}內的一份模型（${perReplica(platform, tOne)}，每份可用 ${GB(r.memBytes * r.memUtil)} GB）後，剩下的記憶體放不下 1 人的上下文（約 ${(Math.max(kv.perSeq + kv.reserve, kv.upperBound) / 1e9).toFixed(1)} GB）（跨 node 切分尚未支援）`,
    };
  }
  if (furthest === 2) {
    return { why: 'ttft', detail: `就算只有 1 人，首字也要等約 ${one.ttftSec.toFixed(1)} 秒，超過要求的 ${ctx.speed.maxTtftSec} 秒` };
  }
  if (furthest === 3) {
    return {
      why: one.step.bwSec >= one.step.computeSec ? 'bw' : 'compute',
      detail: `就算只有 1 人，每秒也只有約 ${one.tokPerSecPerUser.toFixed(1)} token，低於要求的 ${ctx.speed.minTokPerSec}`,
    };
  }
  return null;
}

/**
 * Smallest total GPU count (replicas x t) that serves `n` users. Ties at that GPU count go to the shape serving the
 * most users (maxConcurrent, expected / conservative as `eta`), then to the smaller t (Ruling R34, spec §5.5), so the
 * requirement and the capacity view (maxConcurrentForGpus) pick the same split of the same GPUs.
 * t is tried in ascending legal order; for each t the fewest replicas is found by binary search over
 * [1, resident users] (feasibility only improves with more replicas, and one user per replica is the limit),
 * so there is no replica cap (review: the old 999 cap disagreed with the capacity path). First the context must fit the
 * model ('context', review C3). Then a single user is checked at every legal t; if none works, the
 * reason comes from the t that got furthest: weights, then one sequence's KV beside the weights
 * ('mem', Ruling R25), then TTFT (independent of n and replicas), then per-user speed (Ruling R24).
 * A fewest-GPU shape above MAX_GPUS GPUs (machines) is reported as 'scale' (final review I2).
 * Basis: spec §10.2 (allocation), §8.3.3 (concurrency).
 */
export function solveMinGpus(
  ctx: Ctx,
  platform: ResolvedPlatform,
  n: number,
  eta: EtaMode,
):
  | { ok: true; shape: Shape; gpus: number; check: ReturnType<typeof checkShape> }
  | { ok: false; why: Why; detail: string } {
  const ts = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model);
  const where = platform.unit === 'machine' ? '單台' : '一個 node';
  if (ts.length === 0) {
    return {
      ok: false,
      why: 'tp',
      detail: `這個模型的注意力頭數（${ctx.model.heads}／KV ${ctx.model.kvHeads}）在${where}內沒有合法的 TP 切法（跨 node 切分尚未支援）`,
    };
  }
  if (exceedsMaxContext(ctx.model, ctx.workload)) return { ok: false, why: 'context', detail: contextDetail(ctx) };
  const pre = singleUserWhy(ctx, platform, ts, eta, where);
  if (pre) return { ok: false, ...pre };

  // One resident user per replica is the most replicas can ever help; feasibility is monotone in replicas.
  const hiReplicas = Math.max(1, concurrencyFor(n, ctx.kind, ctx.agentShare).resident);
  let best: { shape: Shape; gpus: number; check: ReturnType<typeof checkShape>; maxN?: number } | null = null;
  const maxN = (b: NonNullable<typeof best>): number => (b.maxN ??= maxConcurrent(ctx, platform, b.shape, eta));
  for (const t of ts) {
    // A t above the best GPU count cannot tie it (one replica already uses t GPUs).
    if (best && t > best.gpus) break;
    if (!checkShape(ctx, platform, { tp: t, replicas: hiReplicas }, n, eta).ok) continue;
    let lo = 0; // infeasible (no replica)
    let hi = hiReplicas; // feasible
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (checkShape(ctx, platform, { tp: t, replicas: mid }, n, eta).ok) hi = mid;
      else lo = mid;
    }
    const gpus = hi * t;
    const cand = { shape: { tp: t, replicas: hi }, gpus, check: checkShape(ctx, platform, { tp: t, replicas: hi }, n, eta) };
    // Fewer GPUs wins; at equal GPUs the larger maxConcurrent, then the smaller t (tried first) (Ruling R34).
    if (!best || gpus < best.gpus || (gpus === best.gpus && maxN(cand) > maxN(best))) best = cand;
  }
  // The single-user pre-check found a t where one user works, so one user per replica always does.
  if (!best) throw new Error('solveMinGpus: no feasible shape although one user fits (unreachable)');
  if (best.gpus > MAX_GPUS) {
    const what = platform.unit === 'machine' ? '需要的機器數' : '需要的 GPU 數';
    return { ok: false, why: 'scale', detail: `${what}（${best.gpus}）超過計算上限（${MAX_GPUS}）` };
  }
  return { ok: true, shape: best.shape, gpus: best.gpus, check: best.check };
}

/**
 * Largest n in [1, 1e7] that `shape` can serve (binary search). Feasibility is treated as monotone in n: resident and
 * generating per replica grow with n, the step time grows up to decodingMax decoding and then stays, and the queueing
 * wait (Ruling R36) grows with the waiting requests. TTFT + W is not strictly non-decreasing — a larger decode batch
 * leaves a smaller prefill chunk, and the chunk count can step, so the prefill part may fall by microseconds between
 * neighbouring n — but those dips are far below any target's resolution; a scan of every n up to 1200 on the queueing
 * test shape (solve.test.ts, 'capacity: feasibility stays monotone in n') finds no feasible n above an infeasible one
 * (final-review M4: was "TTFT + W never falls").
 * Returns 0 when even n = 1 is infeasible.
 * Basis: spec §8.3.3, §10.2.
 */
export function maxConcurrent(ctx: Ctx, platform: ResolvedPlatform, shape: Shape, eta: EtaMode): number {
  if (!(shape.tp >= 1 && shape.replicas >= 1)) return 0;
  if (!checkShape(ctx, platform, shape, 1, eta).ok) return 0;
  if (checkShape(ctx, platform, shape, MAX_N, eta).ok) return MAX_N;
  let lo = 1; // feasible
  let hi = MAX_N; // infeasible
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (checkShape(ctx, platform, shape, mid, eta).ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Best split of `gpus` GPUs (or machines): for each legal t, replicas = floor(gpus / t);
 * keeps the shape serving the most users (first, i.e. smallest t, on ties).
 * Basis: spec §10.2.
 */
export function maxConcurrentForGpus(
  ctx: Ctx,
  platform: ResolvedPlatform,
  gpus: number,
  eta: EtaMode,
): { n: number; shape: Shape | null } {
  let best: { n: number; shape: Shape | null } = { n: 0, shape: null };
  for (const t of legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model)) {
    const replicas = Math.floor(gpus / t);
    if (replicas < 1) continue;
    const n = maxConcurrent(ctx, platform, { tp: t, replicas }, eta);
    if (n > best.n) best = { n, shape: { tp: t, replicas } };
  }
  return best;
}

/**
 * Why `gpus` GPUs (machines) of `platform` serve nobody (estimateCapacity n = 0; final-review I3), in the solver's order:
 * 'context' (input + output above maxContext), 'tp' (no legal TP within the GPUs given), then the single-user reason
 * on the legal TPs that fit in `gpus` (singleUserWhy). Null when one user fits.
 * Basis: spec §5.5 (reverse estimate), §10.2.
 */
export function capacityWhy(ctx: Ctx, platform: ResolvedPlatform, gpus: number, eta: EtaMode): { why: Why; detail: string } | null {
  const unit = platform.unit === 'machine' ? '台' : '張 GPU';
  if (exceedsMaxContext(ctx.model, ctx.workload)) return { why: 'context', detail: contextDetail(ctx) };
  const ts = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model).filter((t) => t <= gpus);
  if (ts.length === 0) {
    return {
      why: 'tp',
      detail: `這個模型的注意力頭數（${ctx.model.heads}／KV ${ctx.model.kvHeads}）在 ${gpus} ${unit}內沒有合法的 TP 切法（跨 node 切分尚未支援）`,
    };
  }
  return singleUserWhy(ctx, platform, ts, eta, `${gpus} ${unit}`);
}

/** One point of a speed-vs-users curve (spec §5.2: per-user speed 1 / t_step and aggregate throughput, against users). */
export type SpeedPoint = {
  users: number;
  /** Per-user decode tok/s of the requests decoding (Ruling R36). */
  tokPerSecPerUser: number;
  /** Requests decoding at once × per-user speed, summed over replicas. */
  aggregateTokPerSec: number;
  /** TTFT incl. the queueing wait. */
  ttftSec: number;
  /** What breaks at this many users (checkShape why); null when the shape serves them. */
  why: Why | null;
};

/** Points of the speed curve (final-review I3): this many n from 1 up to the capacity, evenly spaced. */
export const SPEED_CURVE_POINTS = 8;

/**
 * Capacity profile of one shape (spec §5.5 reverse estimate, §9; final-review I3):
 * - memoryOnlyMax: users the KV memory alone allows (speed targets off) = capacityPerReplica × replicas, capped at
 *   MAX_N; resident users per replica = ceil(n / replicas) for both workload kinds (spec §8.3.3), so this is exact;
 * - bottleneck: what one more user than `n` breaks (checkShape why at n + 1: 'mem' | 'bw' | 'compute' | 'ttft'), or
 *   null when `n` saturates the search (MAX_N);
 * - speedCurve: SPEED_CURVE_POINTS users evenly spaced in [1, n] (deduplicated), with per-user and aggregate tok/s and
 *   TTFT at each; null when n = 0.
 */
export function shapeProfile(
  ctx: Ctx,
  platform: ResolvedPlatform,
  shape: Shape,
  n: number,
  eta: EtaMode,
  pointCount = SPEED_CURVE_POINTS,
  /** Sample exactly these users instead of `pointCount` evenly spaced ones up to `n` (the comparison's shared axis). */
  usersList?: number[],
): { memoryOnlyMax: number; bottleneck: Why | null; speedCurve: { shape: Shape; points: SpeedPoint[] } | null } {
  const one = checkShape(ctx, platform, shape, 1, eta);
  const memoryOnlyMax = one.why === 'context' || one.why === 'weights' ? 0 : Math.min(MAX_N, one.capacityPerReplica * shape.replicas);
  const bottleneck = n >= MAX_N ? null : checkShape(ctx, platform, shape, n + 1, eta).why;
  if (n < 1) return { memoryOnlyMax, bottleneck, speedCurve: null };
  const ns = usersList ?? [...new Set(Array.from({ length: pointCount }, (_, i) => Math.max(1, Math.round(((i + 1) * n) / pointCount))))];
  const points = ns.map((users) => {
    const c = checkShape(ctx, platform, shape, users, eta);
    const gen = concurrencyFor(users, ctx.kind, ctx.agentShare).generating;
    const perReplica = Math.ceil(gen / shape.replicas);
    const decoding = Math.min(gen, shape.replicas * (c.queueing ? c.queueing.decodingMax : perReplica));
    return { users, tokPerSecPerUser: c.tokPerSecPerUser, aggregateTokPerSec: decoding * c.tokPerSecPerUser, ttftSec: c.ttftSec, why: c.why };
  });
  return { memoryOnlyMax, bottleneck, speedCurve: { shape, points } };
}

/** Plain-language split (design §3.7): one model spans `tp` cards, `replicas` copies; machine platforms are counted per machine. */
export function splitPhrase(tp: number, replicas: number, machine: boolean): string {
  if (machine) return `每台各跑一份模型，共 ${replicas} 份`;
  return tp === 1 ? `每張卡各跑一份模型，共 ${replicas} 份` : `每 ${tp} 張卡合跑一份模型，共 ${replicas} 份`;
}
