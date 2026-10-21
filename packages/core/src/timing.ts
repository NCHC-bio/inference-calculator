/**
 * Timing model: roofline decode step with prefill interference, TTFT, all-reduce.
 * Pure functions, SI units (seconds, bytes, FLOP/s) as named.
 */
import type { Model } from '@nchc/schema';
import {
  attentionLayers,
  kvBytesPerSequence,
  linearActiveParams,
  lmHeadParams,
  routedTokensMixture,
  weightsReadBytes,
  weightsReadBytesSplit,
  type WeightBytes,
} from './model-math';

/** Hardware totals for one replica (per-GPU values already multiplied by `tp`). */
export type Replica = {
  tp: number;
  memBytes: number;
  memBwBytesPerSec: number;
  flopsPerSec: number;
  etaBw: number;
  etaCompute: number;
  memUtil: number;
  allreduceLatencySec: number;
  /** nvlinkBidirGBs x 1e9 / 2; 0 for Mac. */
  linkBwBytesPerSecPerDir: number;
  /** Per-step fixed overhead t_fixed (spec §5.2, calibration profile `tFixedSec`); absent → 0. */
  tFixedSec?: number;
  /** Per-request TTFT overhead, once per request (calibration profile `ttftOverheadSec`, Ruling R41); absent → 0. */
  ttftOverheadSec?: number;
};

export type WorkloadIn = { inputTokens: number; outputTokens: number; cacheHitRate: number };

/**
 * Ring all-reduce time: latency + 2(p-1)/p x bytes / bwPerDir; 0 when p == 1.
 * Not in the lecture; basis: spec §5.4 α-β model.
 * Throws if p > 1 and bwPerDir is 0 (a multi-GPU replica without link bandwidth is a config bug).
 */
export function allReduceSec(p: number, bytes: number, latencySec: number, bwPerDir: number): number {
  if (p === 1) return 0;
  if (!(bwPerDir > 0)) {
    throw new Error(`allReduceSec: tp=${p} requires a positive link bandwidth (got ${bwPerDir})`);
  }
  return latencySec + (2 * (p - 1)) / p * (bytes / bwPerDir);
}

/**
 * Attention FLOPs for one token attending `ctx` earlier tokens: 4 × heads × headDim × attended
 * tokens, summed over attention layers (QKᵀ and AV, 2 FLOPs per multiply-add each). It is the
 * attention term of the per-token FLOPs [R-LEC A5]; the term itself is not covered by the lecture
 * (docs/research/lecture-formulas.md, "講義未涵蓋"; spec §5.2).
 * Layer accounting follows kvBytesPerSequence (Ruling R33, spec §5.2 2026-10-19 note):
 * - MLA: attentionLayers(model) × ctx (every layer, or the non-fixed-state layer groups). `phase` picks vLLM's MLA path (review L7; vLLM v0.32.0
 *   vllm/model_executor/layers/attention/mla_attention.py L12-16, L65-117, after the DeepSeek-V2 paper,
 *   arXiv 2405.04434): 'prefill' (and chunked prefill, L120-123) runs the compute-friendly MHA path (`forward_mha`),
 *   QK head dim qkNopeHeadDim + qkRopeHeadDim and V head dim vHeadDim (L65-91; `qk_head_dim` L485, `v_head_dim` L473),
 *   so 2 × heads × (qkNopeHeadDim + qkRopeHeadDim) + 2 × heads × vHeadDim per attended token (Ruling R40; the
 *   up-projection of the cached latent context to K / V, `_compute_prefill_context`, is not counted); 'decode' runs
 *   the absorbed MQA path, QK head dim kvLoraRank + qkRopeHeadDim and V head dim kvLoraRank per query head, so
 *   2 × heads × (2 × kvLoraRank + qkRopeHeadDim) per attended token. GQA / MHA layers cost the same in both phases.
 * - layerGroups: full groups attend ctx, sliding groups min(ctx, window), mamba and state groups have no
 *   attention. Query heads are model-wide (`model.heads`; groups only give KV heads), head dim is
 *   the group's `headDim` when set, else the model's.
 * - slidingWindow without groups: every layer attends min(ctx, window).
 * - otherwise model.layers × ctx.
 * Callers pass an average context (decode: in + out / 2; prefill: the average position of the
 * uncached tokens), so a sliding group is bounded by min(average, window), an approximation.
 */
export function attentionFlop(m: Model, ctx: number, phase: 'decode' | 'prefill' = 'prefill'): number {
  const perLayer = (headDim: number, tokens: number) => 4 * m.heads * headDim * tokens;
  if (m.attention === 'mla' && m.mla) {
    const n = attentionLayers(m);
    if (phase === 'decode') return n * 2 * m.heads * (2 * m.mla.kvLoraRank + m.mla.qkRopeHeadDim) * ctx;
    return n * 2 * m.heads * (m.mla.qkNopeHeadDim + m.mla.qkRopeHeadDim + m.mla.vHeadDim) * ctx;
  }
  if (m.layerGroups) {
    let total = 0;
    for (const g of m.layerGroups) {
      if (g.kind !== 'full' && g.kind !== 'sliding') continue;
      const tokens = g.kind === 'sliding' && g.window !== undefined ? Math.min(ctx, g.window) : ctx;
      total += g.count * perLayer(g.headDim ?? m.headDim, tokens);
    }
    return total;
  }
  if (m.slidingWindow != null) return m.layers * perLayer(m.headDim, Math.min(ctx, m.slidingWindow));
  return m.layers * perLayer(m.headDim, ctx);
}

/**
 * One decode step at generation batch `genBatch` (time = max of the two roofline branches [R-LEC B1]), including steady-state prefill
 * interference from the OTHER concurrent users: max(0, B − 1) × (newTok / out) prefill tokens
 * per step (Ruling R29, spec §5.3 2026-10-19 correction). A user's own prefill happens before
 * their decode and is counted in TTFT, not in their per-token speed, so B = 1 has no prefill term.
 * `weights`: bytes per parameter (every parameter at one width), or the exact resident / expert split
 * (weightsReadBytesSplit) when the API knows it.
 * FLOPs per token: 2 × linear params (+ lm_head for sampled tokens) + attention (review L8).
 * MoE weight reads: the experts touched are the mixture expectation over steps with and without a whole prefill
 * chunk (routedTokensMixture, expertsTouchedExpected; review L6 correction): chunk = min(newTok,
 * prefillChunkBudget(opts.maxNumBatchedTokens, B)) — what the B decode tokens leave of the budget (Ruling R38) — or
 * newTok when the engine has no budget. FLOPs, all-reduce bytes and KV reads are linear in the
 * step's tokens and use the average B + P̄.
 * step = max(bw, compute) + comm + t_fixed (r.tFixedSec, spec §5.2; [R-LEC G2] qualitative, review L4).
 * Also returns the step's average tokens (stepTokens = B + P̄, prefillTokens = P̄). `genBatch` is the requests that
 * decode: above vLLM's per-step budget the solver passes decodingMax and models the rest as waiting (Ruling R36).
 * Basis: [R-LEC B1, B3, A4, C1, B8]; prefill interference spec §5.3; comm [R-LEC F3] (message size) and spec §5.4
 * α-β model, added outside the max() (no overlap: a conservative bound, [R-LEC G1]).
 */
export function decodeStep(
  r: Replica,
  m: Model,
  weights: number | WeightBytes,
  w: WorkloadIn,
  genBatch: number,
  opts?: { includeComm?: boolean; kvBytesPerElem?: number; maxNumBatchedTokens?: number; prefillStepTokens?: number },
): {
  bwSec: number;
  computeSec: number;
  commSec: number;
  fixedSec: number;
  stepSec: number;
  tokensPerSecPerUser: number;
  prefillTokens: number;
  stepTokens: number;
  /** The decode forward alone (fused: the whole step). */
  decodeFwdSec: number;
  /** MLX: one prompt-chunk forward pass (0 when fused or without prefill). */
  prefillPassSec: number;
  /** MLX: share of steps that run a prompt-chunk pass (0 when fused or without prefill). */
  prefillPassProb: number;
  /** FLOPs of the step (expected value; computeSec = flop / (flopsPerSec × etaCompute)). */
  flop: number;
  /** Bytes read by the step (expected value; bwSec = bytes / (memBwBytesPerSec × etaBw)). */
  bytes: number;
} {
  const includeComm = opts?.includeComm ?? true;
  const kvElem = opts?.kvBytesPerElem ?? 1;
  const B = genBatch;
  const ctxDecode = w.inputTokens + w.outputTokens / 2;
  const newTok = w.inputTokens * (1 - w.cacheHitRate);
  // FLOPs per token (review L8, [R-LEC B8]): linear layers for every token; lm_head only where logits are sampled —
  // every decode token, but one token per prefilled sequence (vLLM v0.32.0 gpu_model_runner.py L4241-4242:
  // compute_logits on hidden_states[logits_indices]); the input-embedding lookup has no FLOPs.
  const lin = linearActiveParams(m);
  const lm = lmHeadParams(m);
  const others = Math.max(0, B - 1);
  // Average tokens the step's forward pass processes: B decode tokens + the other users' prefill (chunked prefill shares
  // the step), P̄ = (B − 1) × newTok / out. Linear terms (FLOPs, all-reduce, KV) use this average (review L2, L6).
  const prefillTokens = others * (newTok / w.outputTokens);
  const stepTokens = B + prefillTokens;
  // MoE routing: prefill arrives as one request's whole chunk (≤ max_num_batched_tokens) in a fraction of the steps;
  // the touched fraction is concave, so take the expectation over that mixture, not f(average) (review L6 correction).
  // Weight bytes are linear in the touched fraction, so the expected bytes are the mixture of the bytes.
  // A chunk is at most what the B decode tokens leave of the step's budget (prefillChunkBudget, Ruling R38).
  const mnbt = opts?.maxNumBatchedTokens;
  const chunk = mnbt !== undefined ? Math.min(newTok, prefillChunkBudget(mnbt, B)) : newTok;
  const readAt = (tokens: number) =>
    typeof weights === 'number' ? weightsReadBytes(m, weights, tokens) : weightsReadBytesSplit(m, weights, tokens);
  const weightRead = routedTokensMixture(B, prefillTokens, chunk).reduce((sum, c) => sum + c.prob * readAt(c.tokens), 0);

  const bytes = weightRead + B * kvBytesPerSequence(m, ctxDecode, kvElem, r.tp);
  const bwSec = bytes / (r.memBwBytesPerSec * r.etaBw);
  const decodeFlop = B * (2 * (lin + lm) + attentionFlop(m, ctxDecode, 'decode'));
  // The other users' prefill: (B − 1) × newTok / out tokens per step, and (B − 1) / out of a prompt finishes per step.
  const prefillFlop =
    prefillTokens * (2 * lin + attentionFlop(m, w.inputTokens - newTok / 2)) +
    (others / w.outputTokens) * 2 * lm;
  const flop = decodeFlop + prefillFlop;
  const computeSec = flop / (r.flopsPerSec * r.etaCompute);
  // Row-parallel partial sums are reduced for every token of the step, prefill chunk included [R-LEC F3]
  // (review L2): 2 all-reduces per layer (Megatron-style TP, spec §5.4), message = step tokens × hidden × 2 bytes.
  const commSec =
    includeComm && r.tp > 1
      ? 2 *
        m.layers *
        allReduceSec(r.tp, stepTokens * m.hidden * 2, r.allreduceLatencySec, r.linkBwBytesPerSecPerDir)
      : 0;
  // t_fixed (spec §5.2): per-step overhead independent of the work, from the calibration profile [R-LEC G2] (review L4).
  const fixedSec = r.tFixedSec ?? 0;
  if (opts?.prefillStepTokens !== undefined) {
    return separatePrefillStep(r, m, readAt, w, B, prefillTokens, decodeFlop, prefillFlop, kvElem, includeComm, opts.prefillStepTokens);
  }
  const stepSec = Math.max(bwSec, computeSec) + commSec + fixedSec;
  return {
    bwSec, computeSec, commSec, fixedSec, stepSec, tokensPerSecPerUser: 1 / stepSec, prefillTokens, stepTokens,
    decodeFwdSec: stepSec, prefillPassSec: 0, prefillPassProb: 0, flop, bytes,
  };
}

/**
 * MLX decode step (final-review M5): mlx-lm v0.32.2 `BatchGenerator._next` runs the generation batch's forward first
 * (`self._generation_batch.next()`) and then, as a forward of its own, the prompt batch's next chunk of at most
 * `prefill_step_size` tokens per prompt (`self._prompt_batch.prompt(prompts)`; mlx_lm/generate.py L1812-L1889, server
 * defaults mlx_lm/server.py L912-L917, L2025-L2040). So prefill does not share the decode step's weight read the way
 * vLLM's fused chunked prefill does: each pass re-reads the weights.
 * Model: decode forward = its own roofline at the B decode tokens (weights read for B tokens, B sequences' KV, decode
 * FLOPs) + comm + t_fixed; the other users' prefill P̄ = (B − 1) × newTok / out tokens per step arrives in passes of
 * chunk = min(newTok, prefill_step_size) tokens, in a share p = min(1, P̄ / chunk) of the steps (P̄ ≥ chunk: every step,
 * P̄ tokens); a pass = its own roofline (weights read for its tokens — MoE: the experts they touch —, the prompts' KV
 * at their average position, prefill FLOPs ÷ p) + comm + t_fixed. step = decode forward + p × pass.
 * bwSec / computeSec are the two branches summed the same way (bottleneck label only).
 * Not modelled: the server's prompt_concurrency (8 prompts per pass) and decode_concurrency (32) caps; the verify
 * command pins the latter when a machine decodes more.
 */
function separatePrefillStep(
  r: Replica,
  m: Model,
  readAt: (tokens: number) => number,
  w: WorkloadIn,
  B: number,
  prefillTokens: number,
  decodeFlop: number,
  prefillFlop: number,
  kvElem: number,
  includeComm: boolean,
  prefillStepTokens: number,
): ReturnType<typeof decodeStep> {
  const bw = r.memBwBytesPerSec * r.etaBw;
  const peak = r.flopsPerSec * r.etaCompute;
  const ctxDecode = w.inputTokens + w.outputTokens / 2;
  const fixed = r.tFixedSec ?? 0;
  const comm = (tokens: number) =>
    includeComm && r.tp > 1 ? 2 * m.layers * allReduceSec(r.tp, tokens * m.hidden * 2, r.allreduceLatencySec, r.linkBwBytesPerSecPerDir) : 0;
  const decBytes = readAt(B) + B * kvBytesPerSequence(m, ctxDecode, kvElem, r.tp);
  const decBw = decBytes / bw;
  const decCompute = decodeFlop / peak;
  const decComm = comm(B);
  const decodeFwdSec = Math.max(decBw, decCompute) + decComm + fixed;
  const newTok = w.inputTokens * (1 - w.cacheHitRate);
  const chunk = Math.min(newTok, prefillStepTokens);
  if (!(prefillTokens > 0) || !(chunk > 0)) {
    return {
      bwSec: decBw, computeSec: decCompute, commSec: decComm, fixedSec: fixed, stepSec: decodeFwdSec,
      tokensPerSecPerUser: 1 / decodeFwdSec, prefillTokens: 0, stepTokens: B,
      decodeFwdSec, prefillPassSec: 0, prefillPassProb: 0, flop: decodeFlop, bytes: decBytes,
    };
  }
  const p = Math.min(1, prefillTokens / chunk);
  const passTokens = prefillTokens / p;
  // The prompts in the pass: passTokens ÷ chunk prompts' KV, each at its average prompt position.
  const passBytes = readAt(passTokens) + (passTokens / chunk) * kvBytesPerSequence(m, w.inputTokens - newTok / 2, kvElem, r.tp);
  const passBw = passBytes / bw;
  const passCompute = prefillFlop / p / peak;
  const passComm = comm(passTokens);
  const prefillPassSec = Math.max(passBw, passCompute) + passComm + fixed;
  const stepSec = decodeFwdSec + p * prefillPassSec;
  return {
    bwSec: decBw + p * passBw,
    computeSec: decCompute + p * passCompute,
    commSec: decComm + p * passComm,
    fixedSec: fixed * (1 + p),
    stepSec,
    tokensPerSecPerUser: 1 / stepSec,
    prefillTokens,
    stepTokens: B + prefillTokens,
    decodeFwdSec,
    prefillPassSec,
    prefillPassProb: p,
    // Expected per step, weighted like bwSec / computeSec: decode forward + p × pass (the pass's FLOPs are prefillFlop / p).
    flop: decodeFlop + prefillFlop,
    bytes: decBytes + p * passBytes,
  };
}

/**
 * Options of ttftSec. `weights`: bytes per parameter or the exact resident / expert split, as decodeStep takes them
 * (default 1 byte per parameter); `kvBytesPerElem` default 1; `includeComm` default true; `chunkTokens`: uncached
 * tokens one prefill step processes (vLLM: prefillChunkBudget; MLX: prefill_step_size); absent → one pass.
 */
export type TtftOpts = {
  includeComm?: boolean;
  kvBytesPerElem?: number;
  weights?: number | WeightBytes;
  chunkTokens?: number;
  /**
   * vLLM under load (final-review M6): each chunk is one engine step that also runs the other requests' decode, so it
   * lasts at least their decode step t_step(D); each chunk's time = max(chunk time, stepFloorSec). Absent → no floor.
   */
  stepFloorSec?: number;
  /**
   * MLX under load (final-review M6, M5): each chunk's iteration first runs the other requests' decode forward, a
   * separate pass, so it adds to every chunk. Absent → 0.
   */
  perChunkExtraSec?: number;
};

/**
 * Prefill tokens one vLLM step can give a request's prompt (Ruling R38): max_num_batched_tokens minus the decode tokens
 * scheduled first in the same step (the scheduler runs RUNNING requests before it fills the rest of the budget;
 * docs/research/vllm-tp-kv-precision.md §7.5), at least 1. With the queueing model's decode count (decodingMax at most,
 * Ruling R36) the remainder is ≥ budget × newTok ÷ (out + newTok), so a prompt takes at most about
 * (out + newTok) ÷ budget + 1 steps; the floor of 1 only guards inputs outside that model.
 * Basis: spec §5.3.
 */
export function prefillChunkBudget(maxNumBatchedTokens: number, decodeTokens: number): number {
  return Math.max(1, maxNumBatchedTokens - Math.max(0, decodeTokens));
}

/**
 * Time to first token (prefill of the uncached tokens, no queueing; the solver adds the queueing wait of Ruling R36),
 * a roofline evaluated per chunk step [R-LEC B1] (Ruling R38): the uncached tokens run in
 * n = ceil(uncached ÷ chunkTokens) steps (one when `chunkTokens` is absent), and
 * TTFT = Σ_chunks [max(compute_i, bytes_i ÷ (BW × η_bw)) + comm_i + t_fixed] + t_request (r.ttftOverheadSec, once per
 * request, Ruling R41).
 * - compute_i = (tok_i × (2 × linear params + attention at the chunk's average position) [+ 2 × lm_head params on the
 *   last chunk, the one sampled token]) ÷ (peak × η_compute) [R-LEC A5, B7, B8] (review L8).
 * - bytes_i = the weights read again by this step — within a step the GEMM's output tile holds every token, so each
 *   weight tile is fetched once [R-LEC B9], but nothing stays on chip between steps [R-LEC B6] (MoE: experts touched by
 *   the chunk's tokens) — plus the sequence's KV up to the chunk's end: the cached prefix and earlier chunks read, its
 *   own tokens written (review L1). Few tokens per step make this term bind.
 * - comm_i: TP > 1: 2 × layers all-reduces of tok_i × hidden × 2 bytes (review L3), outside the max().
 * - t_fixed (r.tFixedSec, review L4) [R-LEC G2] once per step.
 * The steps' decode tokens of other requests are not added: TTFT stays one request's prefill work (Ruling R29).
 * Basis: [R-LEC A2, A5, B1, B6, B7, B8, B9, F2, F3]; spec §5.3, comm spec §5.4.
 */
export function ttftSec(r: Replica, m: Model, w: WorkloadIn, opts?: TtftOpts): number {
  const newTok = w.inputTokens * (1 - w.cacheHitRate);
  const cached = w.inputTokens - newTok;
  const weights = opts?.weights ?? 1;
  const kvElem = opts?.kvBytesPerElem ?? 1;
  const includeComm = (opts?.includeComm ?? true) && r.tp > 1;
  const lin = linearActiveParams(m);
  const lm = lmHeadParams(m);
  const chunk = opts?.chunkTokens !== undefined && opts.chunkTokens > 0 ? opts.chunkTokens : Number.POSITIVE_INFINITY;
  const n = Math.max(1, Math.ceil(newTok / chunk));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const start = cached + (n === 1 ? 0 : i * chunk);
    const tok = n === 1 ? newTok : Math.min(chunk, newTok - i * chunk);
    const last = i === n - 1;
    // FLOPs: linear layers per token, attention at the chunk's average position, lm_head for the one sampled token.
    const flop = tok * (2 * lin + attentionFlop(m, start + tok / 2)) + (last ? 2 * lm : 0);
    const computeSec = flop / (r.flopsPerSec * r.etaCompute);
    // Bytes: the step re-reads the weights (MoE: experts its tokens touch; at least one token routes) and the KV up to
    // the chunk's end (prefix and earlier chunks read, own tokens written).
    const readTokens = Math.max(1, tok);
    const weightBytes =
      typeof weights === 'number' ? weightsReadBytes(m, weights, readTokens) : weightsReadBytesSplit(m, weights, readTokens);
    const bwSec = (weightBytes + kvBytesPerSequence(m, start + tok, kvElem, r.tp)) / (r.memBwBytesPerSec * r.etaBw);
    // TP > 1: the step's row-parallel layers reduce their partial sums too [R-LEC F2, F3] (review L3): 2 all-reduces
    // per layer (spec §5.4), message = the chunk's tokens × hidden × 2 bytes; added after the max() like the decode step.
    const commSec = includeComm
      ? 2 * m.layers * allReduceSec(r.tp, tok * m.hidden * 2, r.allreduceLatencySec, r.linkBwBytesPerSecPerDir)
      : 0;
    // Each chunk is one forward pass: one t_fixed (spec §5.2, review L4). Under load (final-review M6): vLLM's fused step
    // lasts at least the decode step it shares; MLX's iteration also runs the decode forward before the chunk.
    const chunkSec = Math.max(computeSec, bwSec) + commSec + (r.tFixedSec ?? 0);
    total += Math.max(chunkSec, opts?.stepFloorSec ?? 0) + (opts?.perChunkExtraSec ?? 0);
  }
  // Per-request overhead outside the forward passes (Ruling R41): once, not per chunk.
  return total + (r.ttftOverheadSec ?? 0);
}
