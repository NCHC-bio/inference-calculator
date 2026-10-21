import { describe, expect, it } from 'vitest';
import type { Model } from '@nchc/schema';
import { allReduceSec, attentionFlop, decodeStep, prefillChunkBudget, ttftSec, type Replica } from '../src/timing';
import { expertsTouchedExpected, kvBytesPerSequence, lmHeadParams, weightsReadBytes } from '../src/model-math';

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

const h200x8: Replica = {
  tp: 8,
  memBytes: 8 * 141e9,
  memBwBytesPerSec: 8 * 4.8e12,
  flopsPerSec: 8 * 1979e12,
  etaBw: 0.7,
  etaCompute: 0.5,
  memUtil: 0.9,
  allreduceLatencySec: 11e-6,
  linkBwBytesPerSecPerDir: 450e9,
};
const chat = { inputTokens: 1020, outputTokens: 129, cacheHitRate: 0 };

describe('allReduceSec', () => {
  it('matches alpha-beta formula', () => {
    expect(allReduceSec(8, 131072, 11e-6, 450e9)).toBeCloseTo(11e-6 + (1.75 * 131072) / 450e9, 12);
  });
  it('is 0 for p == 1', () => {
    expect(allReduceSec(1, 131072, 11e-6, 450e9)).toBe(0);
  });
  it('throws when p>1 and link bandwidth is 0', () => {
    expect(() => allReduceSec(2, 1000, 1e-6, 0)).toThrow(/link/i);
  });
});

describe('decodeStep', () => {
  const off = decodeStep(h200x8, llama70b, 1, chat, 1, { includeComm: false });
  it('bandwidth term', () => {
    const expected = (70.55e9 + 1084.5 * 163840) / (38.4e12 * 0.7);
    expect(off.bwSec).toBeCloseTo(expected, 12);
  });
  it('compute term and step', () => {
    expect(off.computeSec).toBeGreaterThan(0);
    expect(off.commSec).toBe(0);
    expect(off.stepSec).toBe(Math.max(off.bwSec, off.computeSec));
    expect(off.tokensPerSecPerUser).toBeCloseTo(1 / off.stepSec, 12);
  });
  it('comm adds 2*layers*allReduce', () => {
    const on = decodeStep(h200x8, llama70b, 1, chat, 1);
    const ar = allReduceSec(8, 1 * 8192 * 2, 11e-6, 450e9);
    expect(on.stepSec - off.stepSec).toBeCloseTo(2 * 80 * ar, 12);
  });
  it('prefill interference counts only the other B − 1 users (Ruling R29)', () => {
    const peak = 8 * 1979e12 * 0.5;
    const attn = (ctx: number) => 4 * 80 * 64 * 128 * ctx;
    const decodePerUser = 2 * 70.55e9 + attn(1020 + 129 / 2);
    const prefillShare = (1020 / 129) * (2 * 70.55e9 + attn(1020 - 1020 / 2));
    // B = 1: no prefill term at all (own prefill is TTFT).
    expect(off.computeSec).toBeCloseTo(decodePerUser / peak, 15);
    // B = 2: exactly one user's prefill share.
    const two = decodeStep(h200x8, llama70b, 1, chat, 2, { includeComm: false });
    expect(two.computeSec).toBeCloseTo((2 * decodePerUser + prefillShare) / peak, 15);
    const ten = decodeStep(h200x8, llama70b, 1, chat, 10, { includeComm: false });
    expect(ten.computeSec).toBeCloseTo((10 * decodePerUser + 9 * prefillShare) / peak, 14);
  });
  it('kvBytesPerElem option scales KV bytes', () => {
    const b2 = decodeStep(h200x8, llama70b, 1, chat, 1, { includeComm: false, kvBytesPerElem: 2 });
    const expected = (70.55e9 + 1084.5 * 163840 * 2) / (38.4e12 * 0.7);
    expect(b2.bwSec).toBeCloseTo(expected, 12);
  });
});

describe('FLOPs: no input-embedding lookup; lm_head only for sampled tokens (review L8)', () => {
  // Llama 3.3 70B with its vocabulary: 128256 × 8192, untied (input table + lm_head both in totalParamsB).
  const VH = 128256 * 8192;
  const untied: Model = { ...llama70b, vocabSize: 128256, tieWordEmbeddings: false };
  const tied: Model = { ...untied, tieWordEmbeddings: true };
  const peak = 8 * 1979e12 * 0.5;
  const attn = (ctx: number) => 4 * 80 * 64 * 128 * ctx;
  const lin = (m: Model) => 70.55e9 - VH * (m.tieWordEmbeddings ? 1 : 2);
  it('decode: every generated token runs the linear layers and lm_head; the lookup costs nothing', () => {
    const s = decodeStep(h200x8, untied, 1, chat, 1, { includeComm: false });
    expect(s.computeSec).toBeCloseTo((2 * (lin(untied) + VH) + attn(1020 + 129 / 2)) / peak, 15);
    // Tied: the one matrix is the lm_head, so decode FLOPs equal the old 2 × active.
    const t = decodeStep(h200x8, tied, 1, chat, 1, { includeComm: false });
    expect(t.computeSec).toBeCloseTo((2 * 70.55e9 + attn(1020 + 129 / 2)) / peak, 15);
  });
  it('prefill (TTFT and interference): linear layers per token, lm_head once per sequence (vLLM logits_indices)', () => {
    const newTok = 1020;
    const tt = ttftSec(h200x8, untied, chat, { includeComm: false });
    const comp = (newTok * (2 * lin(untied) + attn(1020 - newTok / 2)) + 2 * VH) / peak;
    expect(tt).toBeGreaterThanOrEqual(comp - 1e-15);
    const two = decodeStep(h200x8, untied, 1, chat, 2, { includeComm: false });
    const decodeTok = 2 * (lin(untied) + VH) + attn(1020 + 129 / 2);
    const prefill = (newTok / 129) * (2 * lin(untied) + attn(1020 - newTok / 2)) + (1 / 129) * 2 * VH;
    expect(two.computeSec).toBeCloseTo((2 * decodeTok + prefill) / peak, 15);
  });
  it('without vocabSize (user override) nothing changes: 2 × active', () => {
    const s = decodeStep(h200x8, llama70b, 1, chat, 1, { includeComm: false });
    expect(s.computeSec).toBeCloseTo((2 * 70.55e9 + attn(1020 + 129 / 2)) / peak, 15);
  });
});

describe('tokens in one step = B decode + the other users\' prefill tokens (review L6, L2)', () => {
  const moe: Model = { ...llama70b, totalParamsB: { ...llama70b.totalParamsB, value: 116.83 }, layers: 36, hidden: 2880,
    moe: { experts: 128, topK: 4, expertFfnDim: 2880 } };
  it('MoE: experts touched follow the mixture of steps with and without a whole prefill chunk (review L6 correction)', () => {
    const B = 2;
    // Average prefill tokens per step P̄ = (B − 1) × 1020 / 129 ≈ 7.9; they arrive as one request's whole chunk of
    // 1020 uncached tokens in a fraction p = P̄ / 1020 of the steps (no max_num_batched_tokens given: chunk = newTok).
    const pBar = (B - 1) * (1020 / 129);
    const p = pBar / 1020;
    const s = decodeStep(h200x8, moe, 1, chat, B, { includeComm: false });
    const kv = B * kvBytesPerSequence(moe, 1020 + 129 / 2, 1, 8);
    const read = p * weightsReadBytes(moe, 1, B + 1020) + (1 - p) * weightsReadBytes(moe, 1, B);
    expect(s.bwSec).toBeCloseTo((read + kv) / (38.4e12 * 0.7), 15);
    // Jensen: the average-token figure (172f74d) over-counted the experts read.
    expect(read).toBeLessThan(weightsReadBytes(moe, 1, B + pBar));
    // max_num_batched_tokens caps the chunk at what the B decode tokens leave of it (prefillChunkBudget, Ruling R38):
    // 512 − 2 = 510 → p = P̄ / 510, steps carry B + 510 tokens.
    const capped = decodeStep(h200x8, moe, 1, chat, B, { includeComm: false, maxNumBatchedTokens: 512 });
    const p2 = pBar / 510;
    const read2 = p2 * weightsReadBytes(moe, 1, B + 510) + (1 - p2) * weightsReadBytes(moe, 1, B);
    expect(capped.bwSec).toBeCloseTo((read2 + kv) / (38.4e12 * 0.7), 15);
    // B = 1 has no prefill tokens: unchanged.
    const one = decodeStep(h200x8, moe, 1, chat, 1, { includeComm: false });
    expect(one.bwSec).toBeCloseTo((weightsReadBytes(moe, 1, 1) + kvBytesPerSequence(moe, 1020 + 129 / 2, 1, 8)) / (38.4e12 * 0.7), 15);
  });
  it('all-reduce message = tokens in the step × hidden × 2 bytes, prefill chunk included [R-LEC F3]', () => {
    const B = 3;
    const tokens = B + (B - 1) * (1020 / 129);
    const s = decodeStep(h200x8, llama70b, 1, chat, B);
    expect(s.commSec).toBeCloseTo(2 * 80 * allReduceSec(8, tokens * 8192 * 2, 11e-6, 450e9), 15);
    expect(decodeStep(h200x8, llama70b, 1, chat, 1).commSec).toBeCloseTo(2 * 80 * allReduceSec(8, 8192 * 2, 11e-6, 450e9), 15);
  });
});

describe('t_fixed: per-step fixed overhead from the calibration profile (review L4, spec §5.2, [R-LEC G2])', () => {
  const fixed = { ...h200x8, tFixedSec: 0.002 };
  it('adds once per decode step and once to TTFT; absent means 0', () => {
    const a = decodeStep(h200x8, llama70b, 1, chat, 4);
    const b = decodeStep(fixed, llama70b, 1, chat, 4);
    expect(b.stepSec - a.stepSec).toBeCloseTo(0.002, 15);
    expect(b.fixedSec).toBe(0.002);
    expect(a.fixedSec).toBe(0);
    expect(ttftSec(fixed, llama70b, chat) - ttftSec(h200x8, llama70b, chat)).toBeCloseTo(0.002, 15);
  });
});

describe('ttftSec', () => {
  it('Mac replica, assist workload is 37-39 s', () => {
    const mac: Replica = {
      tp: 1,
      memBytes: 512e9,
      memBwBytesPerSec: 1.2e12,
      flopsPerSec: 66.6e12,
      etaBw: 0.86,
      etaCompute: 1,
      memUtil: 0.75,
      allreduceLatencySec: 0,
      linkBwBytesPerSecPerDir: 0,
    };
    const t = ttftSec(mac, llama70b, { inputTokens: 126180, outputTokens: 252, cacheHitRate: 0.957 });
    expect(t).toBeGreaterThan(37);
    expect(t).toBeLessThan(39);
  });
});

describe('TTFT has a bandwidth term (review L1, [R-LEC B1, B7, B9])', () => {
  const hit = { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0.99 };
  it('few uncached tokens: prefill reads the weights once and the prefix KV, so it is bandwidth-bound', () => {
    const t = ttftSec(h200x8, llama70b, hit, { weights: 1, kvBytesPerElem: 1, includeComm: false });
    const bw = (70.55e9 + kvBytesPerSequence(llama70b, 1000, 1, 8)) / (38.4e12 * 0.7);
    expect(t).toBeCloseTo(bw, 15);
    const compute = (10 * (2 * 70.55e9 + 4 * 80 * 64 * 128 * (1000 - 5))) / (8 * 1979e12 * 0.5);
    expect(t).toBeGreaterThan(compute);
  });
  it('MoE: weights read follow the experts the uncached tokens touch; KV bytes follow kvBytesPerElem', () => {
    const moe: Model = { ...llama70b, totalParamsB: { ...llama70b.totalParamsB, value: 116.83 }, layers: 36, hidden: 2880,
      moe: { experts: 128, topK: 4, expertFfnDim: 2880 } };
    const t = ttftSec(h200x8, moe, hit, { weights: 1, kvBytesPerElem: 2, includeComm: false });
    const bw = (weightsReadBytes(moe, 1, 10) + kvBytesPerSequence(moe, 1000, 2, 8)) / (38.4e12 * 0.7);
    expect(t).toBeGreaterThanOrEqual(bw - 1e-15);
  });
  it('TP > 1: 2 all-reduces per layer of the uncached tokens × hidden × 2 bytes, after the roofline (review L3, [R-LEC F2, F3])', () => {
    const doc = { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 };
    const off = ttftSec(h200x8, llama70b, doc, { weights: 1 , includeComm: false });
    const on = ttftSec(h200x8, llama70b, doc, { weights: 1 });
    expect(on - off).toBeCloseTo(2 * 80 * allReduceSec(8, 12035 * 8192 * 2, 11e-6, 450e9), 12);
    // tp 1: nothing to reduce.
    const one = { ...h200x8, tp: 1 };
    expect(ttftSec(one, llama70b, doc, { weights: 1 })).toBe(ttftSec(one, llama70b, doc, { weights: 1, includeComm: false }));
  });
  it('many uncached tokens stay compute-bound (unchanged)', () => {
    const doc = { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 };
    const compute = (12035 * (2 * 70.55e9 + 4 * 80 * 64 * 128 * (12035 / 2))) / (8 * 1979e12 * 0.5);
    expect(ttftSec(h200x8, llama70b, doc, { weights: 1, includeComm: false })).toBeCloseTo(compute, 12);
  });
});

describe('chunked prefill: TTFT is the roofline of each chunk step (Ruling R38)', () => {
  const peak = 8 * 1979e12 * 0.5;
  const bw = 38.4e12 * 0.7;
  // One chunk step of `tok` uncached tokens starting after `start` tokens: its FLOPs and bytes (weights read again,
  // the KV up to its end read / written), lm_head on the last chunk only.
  const chunkSec = (m: Model, start: number, tok: number, last: boolean) =>
    Math.max(
      (tok * (2 * 70.55e9 + attentionFlop(m, start + tok / 2)) + (last ? 2 * lmHeadParams(m) : 0)) / peak,
      (weightsReadBytes(m, 1, tok) + kvBytesPerSequence(m, start + tok, 1, 8)) / bw,
    );

  it('prefillChunkBudget: max_num_batched_tokens minus the decode tokens sharing the step, at least 1', () => {
    expect(prefillChunkBudget(8192, 918)).toBe(7274);
    expect(prefillChunkBudget(8192, 0)).toBe(8192);
    expect(prefillChunkBudget(8192, 9000)).toBe(1);
  });

  it('no chunk size (single pass) is the old one-roofline TTFT', () => {
    const doc = { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 };
    const one = ttftSec(h200x8, llama70b, doc, { weights: 1, kvBytesPerElem: 1, includeComm: false });
    expect(ttftSec(h200x8, llama70b, doc, { weights: 1, kvBytesPerElem: 1, includeComm: false, chunkTokens: 1e9 })).toBe(one);
    expect(one).toBeCloseTo(chunkSec(llama70b, 0, 12035, true), 15);
  });

  it('small chunks re-read the weights every step: 1000 uncached tokens in 10 chunks of 100', () => {
    const w = { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 };
    const t = ttftSec(h200x8, llama70b, w, { weights: 1, kvBytesPerElem: 1, includeComm: false, chunkTokens: 100 });
    let want = 0;
    for (let i = 0; i < 10; i++) want += chunkSec(llama70b, 100 * i, 100, i === 9);
    expect(t).toBeCloseTo(want, 15);
    // Each 100-token step is bandwidth-bound (≈ 2.6 ms of weights), ten of them exceed one compute-bound 1000-token pass (≈ 17.8 ms) by about half.
    expect(t).toBeGreaterThan((10 * 70.55e9) / bw);
    expect(t).toBeGreaterThan(1.4 * ttftSec(h200x8, llama70b, w, { weights: 1, kvBytesPerElem: 1, includeComm: false }));
  });

  it('a cached prefix: chunks start after it; the last chunk is the remainder', () => {
    const w = { inputTokens: 10000, outputTokens: 100, cacheHitRate: 0.75 }; // 2500 uncached after 7500 cached
    const t = ttftSec(h200x8, llama70b, w, { weights: 1, kvBytesPerElem: 1, includeComm: false, chunkTokens: 1000 });
    const want = chunkSec(llama70b, 7500, 1000, false) + chunkSec(llama70b, 8500, 1000, false) + chunkSec(llama70b, 9500, 500, true);
    expect(t).toBeCloseTo(want, 15);
  });

  it('all-reduces and t_fixed are paid per chunk step', () => {
    const w = { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 };
    const o = { weights: 1, kvBytesPerElem: 1, chunkTokens: 400 } as const;
    const on = ttftSec(h200x8, llama70b, w, o);
    const off = ttftSec(h200x8, llama70b, w, { ...o, includeComm: false });
    const ar = (tok: number) => 2 * 80 * allReduceSec(8, tok * 8192 * 2, 11e-6, 450e9);
    expect(on - off).toBeCloseTo(ar(400) + ar(400) + ar(200), 12);
    const fixed = { ...h200x8, tFixedSec: 0.001 };
    expect(ttftSec(fixed, llama70b, w, o) - on).toBeCloseTo(3 * 0.001, 12);
  });

  it('the per-request TTFT overhead is paid once, whatever the number of chunks (Ruling R41)', () => {
    const w = { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 };
    const o = { weights: 1, kvBytesPerElem: 1, chunkTokens: 400 } as const;
    const base = ttftSec(h200x8, llama70b, w, o);
    const withOvh = { ...h200x8, ttftOverheadSec: 0.07 };
    expect(ttftSec(withOvh, llama70b, w, o) - base).toBeCloseTo(0.07, 12);
    expect(ttftSec(withOvh, llama70b, w, { ...o, chunkTokens: undefined }) - ttftSec(h200x8, llama70b, w, { ...o, chunkTokens: undefined }))
      .toBeCloseTo(0.07, 12);
    // It is not a per-step cost: the decode step does not change.
    expect(decodeStep(withOvh, llama70b, 1, w, 4).stepSec).toBe(decodeStep(h200x8, llama70b, 1, w, 4).stepSec);
  });

  it('MoE: each chunk reads the experts its own tokens touch', () => {
    const moe: Model = { ...llama70b, totalParamsB: { ...llama70b.totalParamsB, value: 116.83 }, layers: 36, hidden: 2880,
      moe: { experts: 128, topK: 4, expertFfnDim: 2880 } };
    const w = { inputTokens: 64, outputTokens: 10, cacheHitRate: 0 };
    const t = ttftSec(h200x8, moe, w, { weights: 1, kvBytesPerElem: 1, includeComm: false, chunkTokens: 16 });
    let want = 0;
    // Bandwidth-bound at 16 tokens: Σ (experts touched by 16 tokens + KV up to the chunk end).
    for (let i = 0; i < 4; i++) want += (weightsReadBytes(moe, 1, 16) + kvBytesPerSequence(moe, 16 * (i + 1), 1, 8)) / bw;
    expect(t).toBeCloseTo(want, 12);
  });
});

describe('attentionFlop (Ruling R33: layer groups like kvBytesPerSequence)', () => {
  // gpt-oss-120b-style: 18 sliding (window 128) + 18 full layers, 64 q heads, head dim 64.
  const gptoss: Model = {
    ...llama70b,
    layers: 36,
    heads: 64,
    kvHeads: 8,
    headDim: 64,
    layerGroups: [
      { kind: 'sliding', count: 18, kvHeads: 8, headDim: 64, window: 128 },
      { kind: 'full', count: 18, kvHeads: 8, headDim: 64 },
    ],
  };

  it('no groups (Llama literals): 4 × layers × heads × headDim × ctx, unchanged', () => {
    expect(attentionFlop(llama70b, 1084.5)).toBe(4 * 80 * 64 * 128 * 1084.5);
  });

  it('sliding layers attend min(ctx, window), full layers attend ctx', () => {
    expect(attentionFlop(gptoss, 10000)).toBe(4 * 64 * 64 * (18 * 128 + 18 * 10000));
    // ctx below the window: every layer attends ctx.
    expect(attentionFlop(gptoss, 100)).toBe(4 * 64 * 64 * 36 * 100);
  });

  it('q heads are model-wide; head dim comes from the group; mamba layers have no attention', () => {
    const hybrid: Model = {
      ...llama70b,
      layers: 10,
      heads: 32,
      headDim: 128,
      layerGroups: [
        { kind: 'mamba', count: 8, ssm: { heads: 64, headDim: 64, stateSize: 128 } },
        { kind: 'full', count: 2, kvHeads: 2, headDim: 256 },
      ],
    };
    expect(attentionFlop(hybrid, 5000)).toBe(4 * 32 * 256 * 2 * 5000);
  });

  it('MLA prefill (compute-friendly MHA path): 2 × heads × (qkNope + qkRope) for QK + 2 × heads × vHeadDim for AV (Ruling R40)', () => {
    // vLLM v0.32.0 mla_attention.py L65-91: forward_mha is MHA with QK head dim P + R and V head dim V.
    // DeepSeek-V3-like dims: P 128, R 64, V 128 → 2 × 64 × 192 + 2 × 64 × 128 = 640 × 64 per layer per position,
    // 1.25× the old 4 × heads × headDim (headDim 128).
    const mla: Model = { ...llama70b, attention: 'mla', mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim: 128, vHeadDim: 128 } };
    expect(attentionFlop(mla, 2000)).toBe(80 * (2 * 64 * 192 + 2 * 64 * 128) * 2000);
    expect(attentionFlop(mla, 2000, 'prefill')).toBe(80 * (2 * 64 * 192 + 2 * 64 * 128) * 2000);
    // Mistral Small 4 (P 64, R 64, V 128, headDim 128): equal to the old approximation.
    const ms4: Model = { ...mla, layers: 36, heads: 32, mla: { kvLoraRank: 256, qkRopeHeadDim: 64, qkNopeHeadDim: 64, vHeadDim: 128 } };
    expect(attentionFlop(ms4, 1000)).toBe(4 * 36 * 32 * 128 * 1000);
  });
  it('MLA decode (absorbed MQA path): 2 × heads × (2 × kvLoraRank + qkRopeHeadDim) per layer per position (review L7)', () => {
    // vLLM v0.32.0 mla_attention.py L93-117: QK head dim Lkv + R, V head dim Lkv, per query head.
    const mla: Model = { ...llama70b, attention: 'mla', mla: { kvLoraRank: 512, qkRopeHeadDim: 64, qkNopeHeadDim: 128, vHeadDim: 128 } };
    expect(attentionFlop(mla, 2000, 'decode')).toBe(80 * 2 * 64 * (2 * 512 + 64) * 2000);
    // GQA is the same in both phases.
    expect(attentionFlop(llama70b, 2000, 'decode')).toBe(attentionFlop(llama70b, 2000, 'prefill'));
    // decodeStep uses the decode form for its own tokens.
    const doc = { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 };
    const s = decodeStep(h200x8, mla, 1, doc, 1, { includeComm: false });
    expect(s.computeSec).toBeCloseTo((2 * 70.55e9 + attentionFlop(mla, 12035 + 343 / 2, 'decode')) / (8 * 1979e12 * 0.5), 15);
  });

  it('slidingWindow without groups bounds every layer by the window', () => {
    expect(attentionFlop({ ...llama70b, slidingWindow: 4096 }, 10000)).toBe(4 * 80 * 64 * 128 * 4096);
  });

  it('decode compute and TTFT use it (sliding model costs less than its all-full twin)', () => {
    const allFull: Model = { ...gptoss, layerGroups: [{ kind: 'full', count: 36, kvHeads: 8, headDim: 64 }] };
    const doc = { inputTokens: 12035, outputTokens: 343, cacheHitRate: 0 };
    const peak = 8 * 1979e12 * 0.5;
    const s = decodeStep(h200x8, gptoss, 1, doc, 1, { includeComm: false });
    expect(s.computeSec).toBeCloseTo((2 * 70.55e9 + attentionFlop(gptoss, 12035 + 343 / 2)) / peak, 15);
    expect(s.computeSec).toBeLessThan(decodeStep(h200x8, allFull, 1, doc, 1, { includeComm: false }).computeSec);
    expect(ttftSec(h200x8, gptoss, doc)).toBeLessThan(ttftSec(h200x8, allFull, doc));
  });
});

describe('MLX: the prompt chunk is a separate forward after the decode forward (final-review M5)', () => {
  // mlx-lm v0.32.2 BatchGenerator._next: generation batch .next() first, then the prompt batch .prompt() on its own.
  const mac: Replica = {
    tp: 1, memBytes: 512e9, memBwBytesPerSec: 1.2e12, flopsPerSec: 100e12, etaBw: 0.86, etaCompute: 0.5, memUtil: 0.75,
    allreduceLatencySec: 0, linkBwBytesPerSecPerDir: 0,
  };
  it('step = decode forward(B) + p × prefill forward(chunk ≤ prefill_step_size), each its own roofline', () => {
    const B = 8;
    const sep = decodeStep(mac, llama70b, 1, chat, B, { prefillStepTokens: 2048 });
    const dec = decodeStep(mac, llama70b, 1, chat, 1, {});
    // Decode forward reads the weights for B tokens plus B sequences' KV; FLOPs of B decode tokens only.
    const bwDec = (70.55e9 + B * kvBytesPerSequence(llama70b, 1020 + 129 / 2, 1, 1)) / (1.2e12 * 0.86);
    expect(sep.decodeFwdSec).toBeCloseTo(Math.max(bwDec, (B * dec.computeSec) / 1), 9);
    // P̄ = 7 × 1020 / 129 = 55.3 tokens per step; chunk = min(1020, 2048) = 1020 → p = P̄ / 1020.
    const pbar = (7 * 1020) / 129;
    const p = pbar / 1020;
    expect(sep.prefillTokens).toBeCloseTo(pbar, 9);
    expect(sep.prefillPassProb).toBeCloseTo(p, 12);
    // The pass re-reads the weights: the step is longer than the fused (one-read) model.
    const fused = decodeStep(mac, llama70b, 1, chat, B, {});
    expect(sep.stepSec).toBeGreaterThan(fused.stepSec);
    expect(sep.stepSec).toBeCloseTo(sep.decodeFwdSec + p * sep.prefillPassSec, 12);
  });
  it('B = 1: no other prompts, so the step is the decode forward alone', () => {
    const one = decodeStep(mac, llama70b, 1, chat, 1, { prefillStepTokens: 2048 });
    expect(one.stepSec).toBe(one.decodeFwdSec);
    expect(one.prefillPassProb).toBe(0);
  });
});

describe('TTFT physical floor under load (final-review M6)', () => {
  it('vLLM: each chunk step lasts at least the decode step of the batch it shares (opts.stepFloorSec)', () => {
    const w = { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0.99 };
    const free = ttftSec(h200x8, llama70b, w, { includeComm: false });
    expect(ttftSec(h200x8, llama70b, w, { includeComm: false, stepFloorSec: free / 2 })).toBe(free);
    expect(ttftSec(h200x8, llama70b, w, { includeComm: false, stepFloorSec: free * 3 })).toBeCloseTo(free * 3, 12);
  });
  it('MLX: each chunk iteration first runs the decode forward of the others (opts.perChunkExtraSec)', () => {
    const w = { inputTokens: 5000, outputTokens: 100, cacheHitRate: 0 };
    const base = ttftSec(h200x8, llama70b, w, { includeComm: false, chunkTokens: 2048 });
    expect(ttftSec(h200x8, llama70b, w, { includeComm: false, chunkTokens: 2048, perChunkExtraSec: 0.01 })).toBeCloseTo(base + 3 * 0.01, 12);
  });
});

describe('decodeStep flop and bytes reproduce its times (roofline data)', () => {
  const mac: Replica = {
    tp: 1, memBytes: 512e9, memBwBytesPerSec: 1.2e12, flopsPerSec: 100e12, etaBw: 0.86, etaCompute: 0.5, memUtil: 0.75,
    allreduceLatencySec: 0, linkBwBytesPerSecPerDir: 0,
  };
  const close = (a: number, b: number) => expect(Math.abs(a - b) / b).toBeLessThan(1e-9);
  it('GPU replica (fused chunked prefill)', () => {
    const s = decodeStep(h200x8, llama70b, 1, chat, 8, { includeComm: false });
    close(s.bytes / (h200x8.memBwBytesPerSec * h200x8.etaBw), s.bwSec);
    close(s.flop / (h200x8.flopsPerSec * h200x8.etaCompute), s.computeSec);
  });
  it('MLX replica (separate prompt pass, expected value)', () => {
    const s = decodeStep(mac, llama70b, 1, chat, 8, { prefillStepTokens: 2048 });
    expect(s.prefillPassProb).toBeGreaterThan(0);
    close(s.bytes / (mac.memBwBytesPerSec * mac.etaBw), s.bwSec);
    close(s.flop / (mac.flopsPerSec * mac.etaCompute), s.computeSec);
  });
});
