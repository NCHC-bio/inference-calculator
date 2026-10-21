/**
 * Model math: parameters, MoE experts, weight bytes, KV / recurrent-state bytes.
 * Pure functions. Units are in the name: `...B` = billions of parameters, `...Bytes` = bytes.
 */
import type { Model } from '@nchc/schema';

/** The fields the MoE parameter math reads (a catalog Model or a user override both fit). */
export type MoeParamsIn = {
  moe?: Model['moe'] | undefined;
  hidden: number;
  layers: number;
  totalParamsB: { value: number };
};

/**
 * Total parameters held in MoE experts, in billions. Dense models return 0.
 * experts x matrices x width x expertFfnDim x moeLayers / 1e9, with matrices = moe.matrices ?? 3 (gate/up/down),
 * width = moe.width ?? hidden (a latent MoE works in a smaller dimension) and moeLayers = moe.layers ?? layers (dense
 * MLP layers are not experts).
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function expertParamsTotalB(m: Omit<MoeParamsIn, 'totalParamsB'>): number {
  if (!m.moe) return 0;
  const { experts, expertFfnDim, matrices = 3, width = m.hidden, layers = m.layers } = m.moe;
  return (experts * matrices * width * expertFfnDim * layers) / 1e9;
}

/**
 * Parameters active per token, in billions: total - expert x (1 - topK/experts).
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function activeParamsB(m: MoeParamsIn): number {
  if (!m.moe) return m.totalParamsB.value;
  return m.totalParamsB.value - expertParamsTotalB(m) * (1 - m.moe.topK / m.moe.experts);
}

/**
 * Why the MoE parameter split of a model is impossible, or null when it is consistent:
 * expert parameters (expertParamsTotalB) must not exceed totalParamsB, and active parameters
 * (activeParamsB) must be > 0. A model failing this would give negative read bytes / FLOPs
 * (Ruling R31: config validation, override validation and the API all call this one check).
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function moeParamsIssue(m: MoeParamsIn): string | null {
  const total = m.totalParamsB.value;
  const expertB = expertParamsTotalB(m);
  if (expertB > total) {
    return `expert parameters ${expertB.toFixed(1)}B (experts × matrices × width × expertFfnDim × MoE layers) exceed totalParamsB ${total}B`;
  }
  const active = activeParamsB(m);
  if (!(active > 0)) return `active parameters ${active.toFixed(2)}B are not positive`;
  return null;
}

/** The fields the MLA support check reads (a catalog Model or a user override both fit). */
export type MlaLayoutIn = {
  attention: Model['attention'];
  layerGroups?: unknown[] | undefined;
  slidingWindow?: number | null | undefined;
};

/**
 * Architecture combinations with MLA that the KV math does not support yet (Ruling R22):
 * kvBytesPerSequence gives MLA precedence over layerGroups and slidingWindow, so an MLA model with
 * either would be sized as if every layer kept a full-context latent cache, silently. Config
 * validation and override validation both reject these (one check, like moeParamsIssue).
 * Returns one issue per offending field; empty when supported.
 * Basis: spec §5.1 (KV precedence; not covered by the lecture).
 */
export function mlaLayoutIssues(m: MlaLayoutIn): Array<{ field: 'layerGroups' | 'slidingWindow'; message: string }> {
  if (m.attention !== 'mla') return [];
  const out: Array<{ field: 'layerGroups' | 'slidingWindow'; message: string }> = [];
  const msg = (what: string) =>
    `architecture combination not supported yet: attention 'mla' with ${what} (the MLA KV formula ignores it; Ruling R22)`;
  if (m.layerGroups !== undefined) out.push({ field: 'layerGroups', message: msg('layerGroups') });
  if (m.slidingWindow != null) out.push({ field: 'slidingWindow', message: msg('a non-null slidingWindow') });
  return out;
}

/** The fields the layer-shape check reads (a catalog Model or a user override both fit). */
export type LayerShapeIn = {
  attention: Model['attention'];
  layers: number;
  heads: number;
  kvHeads: number;
  layerGroups?: Array<{ kind: string; count: number; kvHeads?: number | undefined }> | undefined;
};

/**
 * Layer layouts the KV and attention math would silently miscount, or empty when consistent:
 * - layer group counts (mamba included) must sum to `layers`;
 * - GQA groups query heads evenly over KV heads, per layer (vLLM llama.py / gemma4.py asserts,
 *   docs/research/vllm-tp-kv-precision.md §1.3, §3.6): kvHeads ≤ heads and heads % kvHeads === 0. MLA ignores
 *   num_key_value_heads (§2.1), so MLA models are not checked.
 * Config validation and override validation both call this one check, like moeParamsIssue.
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function layerShapeIssues(m: LayerShapeIn): Array<{ path: (string | number)[]; message: string }> {
  const out: Array<{ path: (string | number)[]; message: string }> = [];
  if (m.layerGroups) {
    const sum = m.layerGroups.reduce((s, g) => s + g.count, 0);
    if (sum !== m.layers) {
      out.push({ path: ['layerGroups'], message: `layer group counts (mamba included) sum to ${sum}, but layers is ${m.layers}` });
    }
  }
  if (m.attention !== 'mla') {
    const gqa = (kv: number, path: (string | number)[]) => {
      if (kv > m.heads || m.heads % kv !== 0) {
        out.push({ path, message: `heads ${m.heads} is not a multiple of kvHeads ${kv} (GQA needs kvHeads ≤ heads and heads % kvHeads === 0)` });
      }
    };
    gqa(m.kvHeads, ['kvHeads']);
    m.layerGroups?.forEach((g, i) => {
      if (g.kind !== 'mamba' && g.kind !== 'state' && g.kvHeads !== undefined) gqa(g.kvHeads, ['layerGroups', i, 'kvHeads']);
    });
  }
  return out;
}

/**
 * Expected fraction of experts touched in a step that routes `batch` tokens (decode tokens plus any prefill tokens
 * in the same step; not necessarily an integer), assuming independent uniform routing: 1 - (1 - topK/experts)^batch.
 * Basis: spec §5.2 (not covered by the lecture; refines [R-LEC B3] weight reuse for MoE).
 */
export function expertsTouchedFraction(experts: number, topK: number, batch: number): number {
  return 1 - Math.pow(1 - topK / experts, batch);
}

/**
 * Token counts a decode step routes, as a mixture {prob, tokens}, when chunked prefill shares the step.
 * `decodeTokens` B; `prefillPerStep` P̄ = average prefill tokens per step (prefill-interference model, spec §5.3);
 * `chunkTokens` = tokens of one prefill chunk (one request's uncached tokens, capped at max_num_batched_tokens where
 * the engine has it). Prefill arrives as whole chunks in a fraction p = min(1, P̄ / chunk) of the steps, so
 * {p: B + chunk, 1 − p: B}, which keeps the mean at B + P̄; when P̄ ≥ chunk every step carries P̄: {1: B + P̄}.
 * No prefill (P̄ = 0, e.g. B = 1) or chunk = 0 → {1: B}. Basis: spec §5.2, §5.3.
 */
export function routedTokensMixture(
  decodeTokens: number,
  prefillPerStep: number,
  chunkTokens: number,
): Array<{ prob: number; tokens: number }> {
  if (!(prefillPerStep > 0) || !(chunkTokens > 0)) return [{ prob: 1, tokens: decodeTokens }];
  if (prefillPerStep >= chunkTokens) return [{ prob: 1, tokens: decodeTokens + prefillPerStep }];
  const p = prefillPerStep / chunkTokens;
  return [
    { prob: p, tokens: decodeTokens + chunkTokens },
    { prob: 1 - p, tokens: decodeTokens },
  ];
}

/**
 * Expected fraction of experts touched in a decode step with chunked-prefill interference (review L6 correction):
 * E[f(T)] over routedTokensMixture, f(T) = expertsTouchedFraction = 1 − (1 − k/E)^T, i.e.
 * p × f(B + chunk) + (1 − p) × f(B), p = min(1, P̄ / chunk) (f(B + P̄) when P̄ ≥ chunk).
 * Derivation: f is concave in T, so feeding it the average token count B + P̄ over-counts the experts read
 * (Jensen: f(E[T]) ≥ E[f(T)]); the step's routed token count is B in most steps and B + chunk in the steps that
 * carry a prefill chunk. Weight reads are linear in this fraction, so the expected bytes follow it exactly; FLOPs,
 * all-reduce bytes and KV reads are linear in the token count and stay on the average.
 * Basis: spec §5.2 (MoE weight reads; refines the weight reuse of [R-LEC B3, B9]; routing itself is not covered by
 * the lecture).
 */
export function expertsTouchedExpected(
  experts: number,
  topK: number,
  decodeTokens: number,
  prefillPerStep: number,
  chunkTokens: number,
): number {
  return routedTokensMixture(decodeTokens, prefillPerStep, chunkTokens).reduce(
    (sum, c) => sum + c.prob * expertsTouchedFraction(experts, topK, c.tokens),
    0,
  );
}

/**
 * Total weight bytes resident in memory: totalParamsB x 1e9 x bytesPerParam.
 * Basis: spec §5.1 (weight footprint; not covered by the lecture).
 */
export function weightBytes(m: Model, bytesPerParam: number): number {
  return m.totalParamsB.value * 1e9 * bytesPerParam;
}

/**
 * Bytes of the separate input-embedding table (Ruling R39): vocabSize × hidden × bytesPerParam when the input
 * embedding and lm_head are separate matrices; 0 when tied (the one matrix is lm_head too, read in full every step) or
 * without vocabSize. Basis: spec §5.2 (embedding reads).
 */
export function inputEmbeddingBytes(m: Pick<Model, 'vocabSize' | 'tieWordEmbeddings' | 'hidden'>, bytesPerParam: number): number {
  if (m.vocabSize === undefined || m.tieWordEmbeddings === true) return 0;
  return m.vocabSize * m.hidden * bytesPerParam;
}

/**
 * Bytes of the input-embedding rows a step reads for `tokens` tokens (Ruling R39): the lookup fetches one row per token,
 * at most every row, so min(tokens, vocab) ÷ vocab of the table (`tableBytes`, inputEmbeddingBytes). Basis: spec §5.2.
 */
export function inputEmbeddingRowsBytes(m: Pick<Model, 'vocabSize'>, tableBytes: number, tokens: number): number {
  if (!(tableBytes > 0) || m.vocabSize === undefined) return 0;
  return (tableBytes * Math.min(Math.max(0, tokens), m.vocabSize)) / m.vocabSize;
}

/**
 * Weight bytes read from HBM in one step that processes `batch` tokens (decode tokens plus any prefill tokens):
 * ((total - expert) + expert x touched) x 1e9 x bytesPerParam, with the separate input-embedding table replaced by the
 * rows the step looks up (Ruling R39: min(batch, vocab) rows; lm_head and a tied matrix are read in full).
 * Weights are read once per step and shared by the whole batch [R-LEC B3, B9]; nothing stays on chip between steps
 * (the reuse distance is the whole model, [R-LEC B6]). (B5's DRAM-only case is the zero-reuse contrast, not cited.)
 */
export function weightsReadBytes(m: Model, bytesPerParam: number, batch: number): number {
  const total = m.totalParamsB.value;
  const table = inputEmbeddingBytes(m, bytesPerParam);
  const embedding = inputEmbeddingRowsBytes(m, table, batch) - table;
  if (!m.moe) return total * 1e9 * bytesPerParam + embedding;
  const expertB = expertParamsTotalB(m);
  const touched = expertsTouchedFraction(m.moe.experts, m.moe.topK, batch);
  return (total - expertB + expertB * touched) * 1e9 * bytesPerParam + embedding;
}

/** The model has sliding-window attention layers (whose in-flight chunks vLLM holds beyond the window; slidingTransientKvBytes). MLA has none. */
export function hasSlidingLayers(m: Pick<Model, 'attention' | 'layerGroups' | 'slidingWindow'>): boolean {
  if (m.attention === 'mla') return false;
  if (m.layerGroups) return m.layerGroups.some((g) => g.kind === 'sliding');
  return m.slidingWindow != null;
}

/**
 * Embedding / lm_head parameter count (exact): vocabSize × hidden, × 2 when the input embedding and lm_head are
 * separate (tieWordEmbeddings false or absent — absent is the larger, conservative reading). 0 without vocabSize
 * (e.g. a user override), which falls back to sizing every parameter at the quantization's width.
 * Basis: spec §5.1 (embedding / lm_head stay 16-bit under vLLM FP8 / AWQ / MXFP4).
 */
export function embeddingParams(m: Pick<Model, 'vocabSize' | 'tieWordEmbeddings' | 'hidden'>): number {
  if (m.vocabSize === undefined) return 0;
  return m.vocabSize * m.hidden * (m.tieWordEmbeddings === true ? 1 : 2);
}

/** lm_head parameters: vocabSize × hidden (tied or not, the output projection runs); 0 without vocabSize. */
export function lmHeadParams(m: Pick<Model, 'vocabSize' | 'hidden'>): number {
  return m.vocabSize === undefined ? 0 : m.vocabSize * m.hidden;
}

/**
 * Active parameters of the linear layers (absolute count): active − the embedding / lm_head matrices
 * (embeddingParams). Every token multiplies them once [R-LEC B8]. The input embedding is a row lookup (no FLOPs) and
 * the lm_head runs only for tokens whose logits are sampled (lmHeadParams; review L8). Without vocabSize (user
 * override) embeddingParams is 0, so this is all active parameters, as before.
 * Basis: [R-LEC B8]; spec §5.2.
 */
export function linearActiveParams(m: Model): number {
  return activeParamsB(m) * 1e9 - embeddingParams(m);
}

/**
 * Resident weight bytes, the routed-expert share of them (0 for a dense model) and the separate input-embedding table
 * (inputEmbeddingBytes at the embedding's bytes per parameter; 0 or absent when tied or unknown).
 */
export type WeightBytes = { resident: number; expert: number; inputEmbedding?: number };

/**
 * Weight bytes read from HBM in one step of `batch` tokens from an exact split: non-expert bytes are read every step,
 * routed-expert bytes in proportion to the experts the batch touches [R-LEC B3], and the input-embedding table only by
 * the rows the step looks up (Ruling R39):
 * (resident − expert − inputEmbedding) + expert × expertsTouchedFraction(batch) + inputEmbeddingRowsBytes(batch).
 * Basis: spec §5.2.
 */
export function weightsReadBytesSplit(m: Model, w: WeightBytes, batch: number): number {
  const table = w.inputEmbedding ?? 0;
  const embedding = inputEmbeddingRowsBytes(m, table, batch) - table;
  if (!m.moe || w.expert === 0) return w.resident + embedding;
  return w.resident - w.expert + w.expert * expertsTouchedFraction(m.moe.experts, m.moe.topK, batch) + embedding;
}

/**
 * KV heads stored across a replica of `tp` GPUs. vLLM shards KV heads when kvHeads % tp === 0
 * (kvHeads in total) and replicates them when tp % kvHeads === 0 (one head per GPU, tp in total),
 * so the replica stores max(kvHeads, tp). vLLM v0.32.0 (docs/research/vllm-tp-kv-precision.md §1.1–1.2):
 * `ModelConfig.get_num_kv_heads` returns `max(1, total_num_kv_heads // tensor_parallel_size)` per GPU
 * (vllm/config/model.py L1650-1670), and `QKVParallelLinear` replicates with `divide(tp_size, total_num_kv_heads)`
 * when `tp_size >= total_num_kv_heads` (vllm/model_executor/layers/linear.py L1053-1058). Same rule since V0 (§1.7).
 * Basis: spec §5.1 (not covered by the lecture; [R-LEC F4] is only an analogy).
 */
export function kvHeadsStored(kvHeads: number, tp = 1): number {
  return Math.max(kvHeads, tp);
}

/**
 * KV-cache bytes per token for uniform attention (ignores layerGroups / windows), summed over a
 * replica of `tp` GPUs.
 * GQA: 2 x layers x kvHeadsStored(kvHeads, tp) x headDim x elem.
 * MLA: layers x (kvLoraRank + qkRopeHeadDim) x elem x tp — the latent cache has no head axis, so
 * every TP rank keeps a full copy (vLLM v0.32.0 `get_num_kv_heads` returns 1 under MLA, and the MLA KV spec has
 * `max_tp_shards=1`, so the copies = tp; docs/research/vllm-tp-kv-precision.md §2.1, §2.3, §2.5).
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function kvBytesPerToken(m: Model, kvBytesPerElem = 1, tp = 1): number {
  if (m.attention === 'mla' && m.mla) {
    return m.layers * (m.mla.kvLoraRank + m.mla.qkRopeHeadDim) * kvBytesPerElem * tp;
  }
  return 2 * m.layers * kvHeadsStored(m.kvHeads, tp) * m.headDim * kvBytesPerElem;
}

/**
 * Options of kvBytesPerSequence (spec §5.1 KV allocation; all absent = exact tokens, what a decode step READS).
 * - `blockTokens`: allocation granularity. vLLM allocates KV in blocks of block_size tokens (v0.32.0
 *   `CacheConfig.DEFAULT_BLOCK_SIZE` 16, raised per attention backend, e.g. FlashMLA 64; platforms.yaml
 *   `vllmDefaults.kvBlockSize` / `mlaKvBlockSize`), mlx-lm grows `KVCache` in steps of 256 tokens (calibration
 *   `mlxDefaults.kvCacheStep`). Full and MLA layers hold ceil(ctx / block) × block tokens
 *   (vLLM `FullAttentionSpec.max_memory_usage_bytes` = cdiv(max_model_len, block_size) blocks).
 * - `slidingExtraTokens`: steady-state tokens a sliding layer holds beyond its window; sliding layers hold
 *   min(ceil(ctx / block) × block, window + slidingExtraTokens). vLLM: block − 1, the average of the whole blocks
 *   `remove_skipped_blocks` keeps (a sequence at n tokens holds ceil((w + r) / bs) blocks, r = (n − w) mod bs; their
 *   mean over r is exactly w + bs − 1 by Hermite's identity); MLX `RotatingKVCache`: 0 (it keeps exactly the window).
 * - `slidingUpperBoundInFlight`: vLLM's per-request UPPER BOUND instead of the steady state, sliding layers at
 *   block × (ceil(min(window − 1 + inFlight, ctx) / block) + 1) (`SlidingWindowSpec.max_admission_blocks_per_request`,
 *   v0.32.0 vllm/v1/kv_cache_interface.py L859-L882; +1 because the window may start mid-block), used by the startup
 *   check and the admission gate only (docs/research/vllm-tp-kv-precision.md §3.3, impact 4).
 */
export type KvSeqOpts = { blockTokens?: number; slidingExtraTokens?: number; slidingUpperBoundInFlight?: number };

/** ceil(tokens / block) × block; block ≤ 1 (or absent) → tokens unchanged. Basis: spec §5.1 KV allocation. */
export function roundUpToBlock(tokens: number, block = 1): number {
  return block > 1 ? Math.ceil(tokens / block) * block : tokens;
}

/** Tokens one sliding layer of `window` holds at `ctx` under KvSeqOpts (spec §5.1). */
function slidingHeldTokens(ctx: number, window: number, opts?: KvSeqOpts): number {
  const bt = opts?.blockTokens ?? 1;
  const inFlight = opts?.slidingUpperBoundInFlight;
  if (inFlight !== undefined) return Math.max(bt, 1) * (Math.ceil(Math.min(window - 1 + inFlight, ctx) / Math.max(bt, 1)) + 1);
  return Math.min(roundUpToBlock(ctx, bt), window + (opts?.slidingExtraTokens ?? 0));
}

/**
 * Transient sliding-window KV of a vLLM replica: the bytes the chunks in flight hold beyond the window, reserved once
 * per replica (not per user). vLLM v0.32.0 frees a sequence's out-of-window blocks before each chunk is allocated
 * (`KVCacheManager.allocate_slots` → `remove_skipped_blocks`, vllm/v1/core/kv_cache_manager.py L546-559;
 * `SlidingWindowManager.get_num_skipped_tokens` = computed − window + 1, single_type_kv_cache_manager.py L1135-1170),
 * so a resident sequence holds the window, and only tokens scheduled but not yet processed overshoot it — at most
 * `inFlightTokens` = max_concurrent_batches × max_num_batched_tokens per step across all requests
 * (vllm/config/vllm.py L577-598). Per sliding group: count × kv × min(inFlightTokens, ctx), 0 when ctx ≤ window
 * (nothing is ever freed, the steady figure already holds every token). Same TP replication as kvBytesPerSequence;
 * MLA and full / mamba layers have none. Basis: spec §5.1 (not covered by the lecture).
 */
export function slidingTransientKvBytes(
  m: Model,
  contextTokens: number,
  inFlightTokens: number,
  kvBytesPerElem = 1,
  tp = 1,
): number {
  if (!(inFlightTokens > 0) || m.attention === 'mla') return 0;
  const tokens = (window: number) => (contextTokens > window ? Math.min(inFlightTokens, contextTokens) : 0);
  if (m.layerGroups) {
    let total = 0;
    for (const g of m.layerGroups) {
      if (g.kind !== 'sliding' || g.window === undefined) continue;
      const kv =
        (g.kEqualsV ? 1 : 2) * kvHeadsStored(g.kvHeads ?? m.kvHeads, tp) * (g.headDim ?? m.headDim) * kvBytesPerElem;
      total += g.count * kv * tokens(g.window);
    }
    return total;
  }
  if (m.slidingWindow != null) return kvBytesPerToken(m, kvBytesPerElem, tp) * tokens(m.slidingWindow);
  return 0;
}

/**
 * Per-sequence cache bytes at `contextTokens`. All later KV computations must call this
 * rather than multiplying per-token size by context length.
 *
 * Precedence: MLA (latent cache, all layers) > layerGroups > slidingWindow (all layers
 * sliding) > kvBytesPerToken x ctx.
 * - full group: count x kv x ceil(ctx / block) x block; sliding: count x kv x min(ceil(ctx / block) x block,
 *   window + slidingExtraTokens), or vLLM's upper bound (KvSeqOpts; block 1 = exact, the default);
 *   kv = (kEqualsV ? 1 : 2) x kvHeads x headDim x elem (kvHeads/headDim fall back to model-level).
 * - mamba group: count x ssm.heads x ssm.headDim x ssm.stateSize x (stateBytesPerElem ?? 2).
 *   Derived estimate: SSM recurrent state only (conv state not counted); independent of
 *   context length and of kvBytesPerElem.
 * - state group: count x stateBytes (a fixed per-sequence state already summed over the replica).
 * - indexer (sparse-attention key cache): layers x bytesPerToken x ceil(ctx / block) x block x tp, every rank keeping
 *   a copy, added on top of whichever branch above applies.
 * `tp`: the replica's tensor-parallel size; the result is the total over its GPUs, with KV heads
 * replicated when tp > kvHeads and the MLA latent cache copied on every rank (kvBytesPerToken).
 * Mamba state is sharded by head across ranks, so its total does not depend on tp.
 * Basis: spec §5.1 (not covered by the lecture).
 */
export function kvBytesPerSequence(m: Model, contextTokens: number, kvBytesPerElem = 1, tp = 1, opts?: KvSeqOpts): number {
  const fullTokens = roundUpToBlock(contextTokens, opts?.blockTokens);
  const indexer = m.indexer ? m.indexer.layers * m.indexer.bytesPerToken * fullTokens * tp : 0;
  return attentionKvBytesPerSequence(m, contextTokens, fullTokens, kvBytesPerElem, tp, opts) + indexer;
}

function attentionKvBytesPerSequence(
  m: Model, contextTokens: number, fullTokens: number, kvBytesPerElem: number, tp: number, opts?: KvSeqOpts,
): number {
  if (m.attention === 'mla' && m.mla) {
    return kvBytesPerToken(m, kvBytesPerElem, tp) * fullTokens;
  }
  if (m.layerGroups) {
    let total = 0;
    for (const g of m.layerGroups) {
      if (g.kind === 'mamba') {
        const s = g.ssm;
        if (s) total += g.count * s.heads * s.headDim * s.stateSize * (s.stateBytesPerElem ?? 2);
        continue;
      }
      if (g.kind === 'state') {
        total += g.count * (g.stateBytes ?? 0);
        continue;
      }
      const kv =
        (g.kEqualsV ? 1 : 2) * kvHeadsStored(g.kvHeads ?? m.kvHeads, tp) * (g.headDim ?? m.headDim) * kvBytesPerElem;
      const tokens =
        g.kind === 'sliding' && g.window !== undefined ? slidingHeldTokens(contextTokens, g.window, opts) : fullTokens;
      total += g.count * kv * tokens;
    }
    return total;
  }
  if (m.slidingWindow != null) {
    return kvBytesPerToken(m, kvBytesPerElem, tp) * slidingHeldTokens(contextTokens, m.slidingWindow, opts);
  }
  return kvBytesPerToken(m, kvBytesPerElem, tp) * fullTokens;
}
