import { describe, expect, it } from 'vitest';
import type { Model } from '@nchc/schema';
import {
  activeParamsB,
  expertParamsTotalB,
  expertsTouchedExpected,
  expertsTouchedFraction,
  kvBytesPerSequence,
  kvBytesPerToken,
  moeParamsIssue,
  slidingTransientKvBytes,
  weightBytes,
  weightsReadBytes,
  weightsReadBytesSplit,
} from '../src/model-math';

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
const gptoss120: Model = {
  ...llama70b,
  id: 'gpt-oss-120b',
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
const gemma4_31b: Model = {
  ...llama70b,
  id: 'gemma-4-31b',
  origin: { developer: 'Google', country: 'US' },
  layers: 60,
  layerGroups: [
    { kind: 'sliding', count: 50, kvHeads: 16, headDim: 256, window: 1024 },
    { kind: 'full', count: 10, kvHeads: 4, headDim: 512, kEqualsV: true },
  ],
};

describe('MoE experts touched with chunked prefill: mixture expectation (review L6 correction)', () => {
  // f(T) = 1 − (1 − k/E)^T is concave, so E[f(B + prefill tokens)] < f(B + average prefill tokens) (Jensen).
  it('hand-computed small case: E = 8, k = 2, B = 4, P̄ = 2 tokens per step, chunk 8 → p = 1/4', () => {
    // 0.25 × (1 − 0.75^12) + 0.75 × (1 − 0.75^4) = 0.25 × 0.968323647976 + 0.75 × 0.68359375
    expect(expertsTouchedExpected(8, 2, 4, 2, 8)).toBeCloseTo(0.754776224494, 12);
    expect(expertsTouchedExpected(8, 2, 4, 2, 8)).toBeLessThan(expertsTouchedFraction(8, 2, 6));
  });
  it('limits: no prefill or B = 1 (P̄ = 0) → f(B); P̄ ≥ chunk → every step carries P̄ tokens', () => {
    expect(expertsTouchedExpected(128, 4, 1, 0, 1020)).toBe(expertsTouchedFraction(128, 4, 1));
    expect(expertsTouchedExpected(128, 4, 7, 0, 8192)).toBe(expertsTouchedFraction(128, 4, 7));
    expect(expertsTouchedExpected(128, 4, 7, 50, 0)).toBe(expertsTouchedFraction(128, 4, 7));
    expect(expertsTouchedExpected(8, 2, 4, 10, 8)).toBe(expertsTouchedFraction(8, 2, 14));
  });
});

describe('model math', () => {
  it('brief examples', () => {
    expect(kvBytesPerToken(llama70b)).toBe(163840);
    expect(expertParamsTotalB(gptoss120)).toBeCloseTo(114.6617856, 6);
    expect(activeParamsB(gptoss120)).toBeCloseTo(5.7506, 3);
    expect(kvBytesPerSequence(gptoss120, 10000)).toBe(1024 * (18 * 10000 + 18 * 128));
    expect(kvBytesPerSequence(gemma4_31b, 100000)).toBe(
      50 * 2 * 16 * 256 * 1024 + 10 * 1 * 4 * 512 * 100000,
    );
    expect(expertsTouchedFraction(128, 4, 1)).toBeCloseTo(0.03125, 6);
    expect(expertsTouchedFraction(128, 4, 32)).toBeCloseTo(1 - Math.pow(124 / 128, 32), 9);
    expect(weightBytes(llama70b, 1)).toBe(70.55e9);
    expect(weightsReadBytes(llama70b, 1, 64)).toBe(70.55e9);
    expect(kvBytesPerSequence({ ...llama70b, slidingWindow: 4096 }, 126432)).toBe(4096 * 163840);
  });

  it('dense model has zero expert params and full active params', () => {
    expect(expertParamsTotalB(llama70b)).toBe(0);
    expect(activeParamsB(llama70b)).toBe(70.55);
  });

  it('moeParamsIssue: null when consistent, a reason when experts exceed the total (Ruling R31)', () => {
    expect(moeParamsIssue(llama70b)).toBeNull();
    expect(moeParamsIssue(gptoss120)).toBeNull();
    const bad = { ...gptoss120, totalParamsB: { ...gptoss120.totalParamsB, value: 100 } };
    expect(moeParamsIssue(bad)).toMatch(/expert parameters 114.7B .* exceed totalParamsB 100B/);
  });

  it('MoE weightsReadBytes grows with batch toward full weights', () => {
    const b1 = weightsReadBytes(gptoss120, 1, 1);
    const b64 = weightsReadBytes(gptoss120, 1, 64);
    expect(b1).toBeLessThan(b64);
    expect(b64).toBeLessThanOrEqual(weightBytes(gptoss120, 1));
  });

  it('no groups, no window: per-token x ctx; kvBytesPerElem scales', () => {
    expect(kvBytesPerSequence(llama70b, 1000)).toBe(163840 * 1000);
    expect(kvBytesPerSequence(llama70b, 1000, 2)).toBe(163840 * 2 * 1000);
  });

  it('sliding window longer than ctx does not inflate', () => {
    expect(kvBytesPerSequence({ ...llama70b, slidingWindow: 4096 }, 1000)).toBe(1000 * 163840);
  });

  it('MLA uses latent + rope dims', () => {
    const mla: Model = { ...llama70b, attention: 'mla', mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim: 128, vHeadDim: 128 } };
    expect(kvBytesPerToken(mla)).toBe(80 * 576);
    expect(kvBytesPerSequence(mla, 1000)).toBe(80 * 576 * 1000);
  });

  it('groups without kvHeads/headDim fall back to model-level values', () => {
    const m: Model = { ...llama70b, layerGroups: [{ kind: 'full', count: 80 }] };
    expect(kvBytesPerSequence(m, 1000)).toBe(163840 * 1000);
  });

  it('kEqualsV applies to sliding groups too', () => {
    const m: Model = {
      ...llama70b,
      layerGroups: [{ kind: 'sliding', count: 2, kvHeads: 4, headDim: 8, window: 10, kEqualsV: true }],
    };
    expect(kvBytesPerSequence(m, 100)).toBe(2 * 1 * 4 * 8 * 10);
  });

  it('mamba group state is independent of context and kvBytesPerElem (R20)', () => {
    const m: Model = {
      ...llama70b,
      layerGroups: [
        { kind: 'mamba', count: 40, ssm: { heads: 128, headDim: 64, stateSize: 128, stateBytesPerElem: 4 } },
        { kind: 'full', count: 10 },
      ],
    };
    const state = 40 * 128 * 64 * 128 * 4;
    const kv = (ctx: number, e: number) => 10 * 2 * 8 * 128 * e * ctx;
    expect(kvBytesPerSequence(m, 1000)).toBe(state + kv(1000, 1));
    expect(kvBytesPerSequence(m, 100000, 2)).toBe(state + kv(100000, 2));
    const onlyMamba: Model = {
      ...m,
      layerGroups: [{ kind: 'mamba', count: 40, ssm: { heads: 128, headDim: 64, stateSize: 128, stateBytesPerElem: 4 } }],
    };
    expect(kvBytesPerSequence(onlyMamba, 1000)).toBe(state);
    expect(kvBytesPerSequence(onlyMamba, 100000)).toBe(state);
    const defaultBytes: Model = {
      ...m,
      layerGroups: [{ kind: 'mamba', count: 3, ssm: { heads: 2, headDim: 4, stateSize: 8 } }],
    };
    expect(kvBytesPerSequence(defaultBytes, 5)).toBe(3 * 2 * 4 * 8 * 2);
  });
});

describe('input-embedding reads: only the looked-up rows; lm_head in full (Ruling R39)', () => {
  // Llama 3.1 8B-like: vocab 128256 × hidden 4096, untied (2 matrices).
  const l8: Model = { ...llama70b, totalParamsB: { ...llama70b.totalParamsB, value: 8.03 }, hidden: 4096, vocabSize: 128256, tieWordEmbeddings: false };
  const table = 128256 * 4096;
  it('untied: a step of T tokens reads T rows of the input embedding (min(T, vocab)), every other weight in full', () => {
    expect(weightsReadBytes(l8, 1, 4)).toBeCloseTo(8.03e9 - table + 4 * 4096, 0);
    expect(weightsReadBytes(l8, 2, 1000)).toBeCloseTo(2 * (8.03e9 - table + 1000 * 4096), 0);
    expect(weightsReadBytes(l8, 1, 1e6)).toBeCloseTo(8.03e9, 0); // more tokens than rows: the whole table
  });
  it('tied: the shared matrix is lm_head too, read in full every step; without vocabSize nothing changes', () => {
    expect(weightsReadBytes({ ...l8, tieWordEmbeddings: true }, 1, 4)).toBeCloseTo(8.03e9, 0);
    const { vocabSize: _vocab, ...noVocab } = l8;
    expect(weightsReadBytes(noVocab, 1, 4)).toBeCloseTo(8.03e9, 0);
  });
  it('exact split: resident − input embedding + its rows; experts as before', () => {
    const w = { resident: 10e9, expert: 0, inputEmbedding: 2 * table };
    expect(weightsReadBytesSplit(l8, w, 8)).toBe(10e9 - 2 * table + 8 * 4096 * 2);
    expect(weightsReadBytesSplit(l8, { resident: 10e9, expert: 0 }, 8)).toBe(10e9);
    const moe = { ...gptoss120, vocabSize: 201088, tieWordEmbeddings: false };
    const wm = { resident: 65e9, expert: 60e9, inputEmbedding: 201088 * 2880 * 2 };
    expect(weightsReadBytesSplit(moe, wm, 3)).toBeCloseTo(
      65e9 - 60e9 + 60e9 * expertsTouchedFraction(128, 4, 3) - wm.inputEmbedding + 3 * 2880 * 2, 0,
    );
  });
});

describe('KV across a TP replica (review C1, C2)', () => {
  const mla: Model = {
    ...llama70b,
    id: 'mla',
    layers: 36,
    heads: 32,
    kvHeads: 32,
    attention: 'mla',
    mla: { kvLoraRank: 256, qkRopeHeadDim: 64, qkNopeHeadDim: 64, vHeadDim: 128 },
  };

  it('GQA: KV heads shard while tp <= kvHeads, replicate once tp > kvHeads (max(kvHeads, tp))', () => {
    const one = kvBytesPerSequence(llama70b, 1000, 1, 1);
    expect(kvBytesPerSequence(llama70b, 1000, 1, 8)).toBe(one); // 8 KV heads over 8 GPUs: sharded
    const kv2 = { ...llama70b, kvHeads: 2 };
    // 2 KV heads at TP 8: each GPU keeps one head -> 8 heads stored, 4x the TP-1 total.
    expect(kvBytesPerSequence(kv2, 1000, 1, 8)).toBe(4 * kvBytesPerSequence(kv2, 1000, 1, 1));
    expect(kvBytesPerSequence(kv2, 1000, 1, 8)).toBe(2 * 80 * 8 * 128 * 1000);
  });

  it('layer groups replicate per group: only groups with kvHeads < tp grow', () => {
    // Gemma 4 31B at TP 8: sliding groups (16 KV heads) stay sharded, the full group (4) is replicated to 8.
    expect(kvBytesPerSequence(gemma4_31b, 100000, 1, 8)).toBe(
      50 * 2 * 16 * 256 * 1024 + 10 * 1 * 8 * 512 * 100000,
    );
  });

  it('vLLM sliding-window allocation: min(window − 1 + max_num_batched_tokens, ctx) per sliding layer (review L9)', () => {
    // vLLM v0.32.0 SlidingWindowSpec.max_admission_blocks_per_request (docs/research/vllm-tp-kv-precision.md §3.3).
    const extra = 8192 - 1;
    expect(kvBytesPerSequence(gemma4_31b, 100000, 1, 8, { slidingExtraTokens: extra })).toBe(
      50 * 2 * 16 * 256 * (1024 + extra) + 10 * 1 * 8 * 512 * 100000,
    );
    // Capped at the context, like the window itself.
    expect(kvBytesPerSequence(gemma4_31b, 5000, 1, 1, { slidingExtraTokens: extra })).toBe(
      kvBytesPerSequence(gemma4_31b, 5000, 1, 1, { slidingExtraTokens: 0 }) + 50 * 2 * 16 * 256 * (5000 - 1024),
    );
    // slidingWindow without groups follows the same rule; default (MLX, decode reads) keeps the window.
    expect(kvBytesPerSequence({ ...llama70b, slidingWindow: 4096 }, 126432, 1, 1, { slidingExtraTokens: extra })).toBe(
      (4096 + extra) * 163840,
    );
    expect(kvBytesPerSequence({ ...llama70b, slidingWindow: 4096 }, 126432)).toBe(4096 * 163840);
  });

  it('vLLM sliding-window transient reserve: min(in-flight tokens, ctx) per sliding layer, only beyond the window (review L9 fix)', () => {
    // vLLM v0.32.0 frees out-of-window blocks before each chunk (SlidingWindowManager.get_num_skipped_tokens), so a
    // resident sequence holds the window; only the tokens in flight overshoot it, at most max_in_flight_tokens per step.
    const inFlight = 2 * 8192;
    expect(slidingTransientKvBytes(gemma4_31b, 100000, inFlight, 1, 8)).toBe(50 * 2 * 16 * 256 * inFlight);
    // Capped at the context; nothing is ever freed (so nothing overshoots) when the context is within the window.
    expect(slidingTransientKvBytes(gemma4_31b, 5000, inFlight, 1, 1)).toBe(50 * 2 * 16 * 256 * 5000);
    expect(slidingTransientKvBytes(gemma4_31b, 1024, inFlight, 1, 1)).toBe(0);
    expect(slidingTransientKvBytes(gptoss120, 1405, inFlight, 2, 1)).toBe(18 * 2 * 8 * 64 * 2 * 1405);
    // slidingWindow without groups: every layer; full-attention-only, MLA and MLX (0 in flight) have none.
    expect(slidingTransientKvBytes({ ...llama70b, slidingWindow: 4096 }, 126432, inFlight)).toBe(163840 * inFlight);
    expect(slidingTransientKvBytes(llama70b, 126432, inFlight)).toBe(0);
    expect(slidingTransientKvBytes(gemma4_31b, 100000, 0)).toBe(0);
  });

  it('KV block rounding: full and MLA layers hold whole blocks, ceil(ctx / block) × block tokens', () => {
    // vLLM allocates KV in blocks of block_size tokens (v0.32.0 CacheConfig.DEFAULT_BLOCK_SIZE 16); mlx-lm grows
    // KVCache in steps of 256 tokens. Exact (block 1) is the default and what a decode step reads.
    expect(kvBytesPerSequence(llama70b, 1000, 1, 1, { blockTokens: 16 })).toBe(kvBytesPerToken(llama70b) * 1008);
    expect(kvBytesPerSequence(llama70b, 1008, 1, 1, { blockTokens: 16 })).toBe(kvBytesPerToken(llama70b) * 1008);
    expect(kvBytesPerSequence(llama70b, 1000, 1, 1, { blockTokens: 256 })).toBe(kvBytesPerToken(llama70b) * 1024);
    expect(kvBytesPerSequence(mla, 1000, 1, 2, { blockTokens: 64 })).toBe(2 * 36 * 320 * 1024);
    expect(kvBytesPerSequence(llama70b, 1000)).toBe(kvBytesPerToken(llama70b) * 1000);
  });

  it('vLLM sliding steady state with blocks: min(ceil(ctx/bs)·bs, window + bs − 1) (whole blocks are freed)', () => {
    // remove_skipped_blocks frees floor((c − w + 1) / bs) whole blocks once c tokens are processed and allocates
    // ceil((c + 1) / bs) blocks for the next one, so a sequence at n = c + 1 tokens holds ceil(n/bs) − floor((n − w)/bs)
    // blocks = ceil((w + r) / bs), r = (n − w) mod bs. Over one period of r the held tokens average exactly w + bs − 1
    // (Hermite's identity), for any w; the maximum is bs × ceil((w + bs − 1) / bs).
    for (const [w, bs] of [[128, 16], [1024, 16], [100, 16], [128, 64], [4096, 32]] as const) {
      let sum = 0;
      for (let n = w + 1; n <= w + bs; n++) sum += bs * (Math.ceil(n / bs) - Math.floor((n - w) / bs));
      expect(sum / bs, `w=${w} bs=${bs}`).toBe(w + bs - 1);
    }
    const sliding = 50 * 2 * 16 * 256;
    const full = 10 * 1 * 4 * 512;
    const opts = { blockTokens: 16, slidingExtraTokens: 15 };
    expect(kvBytesPerSequence(gemma4_31b, 100000, 1, 1, opts)).toBe(sliding * (1024 + 15) + full * 100000);
    // Context within the window: nothing is freed, every layer holds whole blocks of the context.
    expect(kvBytesPerSequence(gemma4_31b, 1000, 1, 1, opts)).toBe((sliding + full) * 1008);
    // MLX (RotatingKVCache): grows in steps up to the window and keeps exactly the window.
    const mlx = { blockTokens: 256, slidingExtraTokens: 0 };
    expect(kvBytesPerSequence(gemma4_31b, 100000, 1, 1, mlx)).toBe(sliding * 1024 + full * 100096);
    expect(kvBytesPerSequence(gemma4_31b, 700, 1, 1, mlx)).toBe((sliding + full) * 768);
  });

  it('vLLM startup upper bound with blocks: bs × (ceil(min(w − 1 + in-flight, ctx) / bs) + 1) per sliding layer', () => {
    // SlidingWindowSpec.max_admission_blocks_per_request (+1: the window may start mid-block);
    // FullAttentionSpec.max_memory_usage_bytes = cdiv(max_model_len, bs) blocks.
    const per = 18 * 2 * 8 * 64;
    const ub = { blockTokens: 16, slidingUpperBoundInFlight: 2 * 8192 };
    expect(kvBytesPerSequence(gptoss120, 20000, 1, 1, ub)).toBe(per * 16 * (Math.ceil((127 + 16384) / 16) + 1) + per * 20000);
    // Capped by the context: min(…, ctx) before rounding, then + 1 block.
    expect(kvBytesPerSequence(gptoss120, 5000, 1, 1, ub)).toBe(per * 16 * (Math.ceil(5000 / 16) + 1) + per * 5008);
  });

  it('MLA: every TP rank keeps the whole latent cache (x tp)', () => {
    const one = 36 * (256 + 64) * 1000;
    expect(kvBytesPerSequence(mla, 1000, 1, 1)).toBe(one);
    expect(kvBytesPerSequence(mla, 1000, 1, 4)).toBe(4 * one);
    expect(kvBytesPerToken(mla, 1, 8)).toBe(8 * 36 * 320);
  });

  it('Mamba state is sharded by head, so its total does not change with tp', () => {
    const hybrid: Model = {
      ...llama70b,
      layerGroups: [{ kind: 'mamba', count: 3, ssm: { heads: 8, headDim: 4, stateSize: 8, stateBytesPerElem: 4 } }],
    };
    expect(kvBytesPerSequence(hybrid, 5, 1, 4)).toBe(kvBytesPerSequence(hybrid, 5, 1, 1));
  });
});

describe('architectures beyond the standard layout (issue #17)', () => {
  it('expert parameters use the MoE layer count, matrices and width when given', () => {
    const base = { hidden: 1000, layers: 10 };
    const moe = { experts: 8, topK: 2, expertFfnDim: 100 };
    expect(expertParamsTotalB({ ...base, moe })).toBeCloseTo((8 * 3 * 1000 * 100 * 10) / 1e9, 12);
    // Dense MLP layers before the MoE layers are not experts.
    expect(expertParamsTotalB({ ...base, moe: { ...moe, layers: 7 } })).toBeCloseTo((8 * 3 * 1000 * 100 * 7) / 1e9, 12);
    // Non-gated (2 matrices) experts in a latent dimension.
    expect(expertParamsTotalB({ ...base, moe: { ...moe, matrices: 2, width: 250 } })).toBeCloseTo((8 * 2 * 250 * 100 * 10) / 1e9, 12);
  });

  it('state groups add a fixed per-sequence state; extraCache adds a per-token cache on every rank and a state', () => {
    const hybrid: Model = {
      ...llama70b,
      layers: 4,
      layerGroups: [
        { kind: 'full', count: 1 },
        { kind: 'state', count: 3, stateBytes: 1_000_000 },
      ],
    };
    const fullPerToken = 2 * 8 * 128 * 2; // kv × kvHeads × headDim × 2 bytes, one layer
    expect(kvBytesPerSequence(hybrid, 1000, 2)).toBe(fullPerToken * 1000 + 3 * 1_000_000);
    // The state does not grow with context.
    expect(kvBytesPerSequence(hybrid, 2000, 2) - kvBytesPerSequence(hybrid, 1000, 2)).toBe(fullPerToken * 1000);
    const withExtra: Model = { ...llama70b, extraCache: { bytesPerToken: 80 * 132, stateBytes: 5000 } };
    expect(kvBytesPerSequence(withExtra, 1000, 2, 2) - kvBytesPerSequence(llama70b, 1000, 2, 2)).toBe(80 * 132 * 1000 * 2 + 5000);
  });
});
