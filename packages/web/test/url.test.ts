import { quantOptions, type CustomPlatformInput } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { defaultState, type CalcState } from '../src/state/state';
import { decodeUrl, encodeUrl } from '../src/state/url';

const b = getBundle();
const s0 = defaultState(b);

// Test fixtures (not catalog values).
const gpu: CustomPlatformInput = { name: '自訂 GPU', unit: 'gpu', gpusPerNode: 8, memGB: 80, memBwTBs: 3, tflops: 900, engine: 'vllm', tdpW: 700 };
const mac: CustomPlatformInput = { name: 'Mac', unit: 'machine', gpusPerNode: 1, memGB: 512, memBwTBs: 0.8, tflops: 30, engine: 'mlx' };
const manual = { name: 'My 8B', totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 };
const SHA = '0123456789abcdef0123456789abcdef01234567';
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('url', () => {
  it('round-trips the catalog fields', () => {
    const s: CalcState = { ...s0, lang: 'en', users: 321, workload: 'chat', speed: 'ok' };
    expect(decodeUrl(b, encodeUrl(s))).toEqual(s);
    expect(decodeUrl(b, '?' + encodeUrl(s))).toEqual(s);
  });
  it('round-trips every field', () => {
    const s: CalcState = {
      ...s0,
      lang: 'en',
      users: 321,
      workload: { base: 'chat', inputTokens: 1500, outputTokens: 300, cacheHitRate: 0.25 },
      speed: { minTokPerSec: 12, maxTtftSec: 2.5 },
      model: 'custom',
      customModel: { kind: 'manual', value: manual },
      customPlatforms: [gpu, mac],
      overrides: { 'nano4-h200': { gpus: 8, tp: 2 }, 'custom:0': { gpus: 4 }, 'custom:1': { gpus: 3 } },
      openRow: 'custom:0',
      compare: [],
      dialog: 'hardware',
      editingPlatform: 1,
    };
    const { openRow: _o, dialog: _d, editingPlatform: _e, ...kept } = s;
    expect(decodeUrl(b, encodeUrl(s))).toEqual({ ...s0, ...kept });
  });
  it('hf model encodes as repo@sha', () => {
    const s: CalcState = { ...s0, model: 'custom', customModel: { kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA } };
    const q = encodeUrl(s);
    expect(q).toContain(`hf=openai%2Fgpt-oss-20b%40${SHA}`);
    const d = decodeUrl(b, q);
    expect(d.customModel?.kind).toBe('hf');
    expect(d.customModel).toEqual({ kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA });
    expect(d.customModel?.kind === 'hf' && d.customModel.imported).toBeUndefined();
    expect(d.model).toBe('custom');
  });
  it('hf origin round-trips through x.hfo; an invalid one is dropped (Ruling W1)', () => {
    const origin = { developer: 'OpenAI', country: 'US' };
    const s: CalcState = { ...s0, model: 'custom', customModel: { kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA, origin } };
    expect(decodeUrl(b, encodeUrl(s)).customModel).toEqual({ kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA, origin });
    const bad: CalcState = { ...s0, model: 'custom', customModel: { kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA, origin: { developer: 'OpenAI', country: 'usa' } } };
    expect(decodeUrl(b, encodeUrl(bad)).customModel).toEqual({ kind: 'hf', repo: 'openai/gpt-oss-20b', sha: SHA });
  });
  it('does not write openRow, pins or dialogs', () => {
    const q = encodeUrl({ ...s0, openRow: 'nano4-h200', dialog: 'basis' });
    expect(q).not.toMatch(/open|basis|pin|dialog/i);
    expect(decodeUrl(b, q).openRow).toBeNull();
  });
  it('decodeUrl drops bad overrides and custom entries', () => {
    const cases = [
      'o=nope:4,custom:5:2,nano4-h200:8:3,nano4-h200:abc',
      'x=@@@',
      'x=' + b64({ hw: [{ name: '' }] }),
      'x=' + b64({ hw: 'nope', wl: { base: 'no-such' }, sp: { minTokPerSec: -1 }, mm: { layers: 0 } }),
      'hf=not-a-repo',
      // Inherited prototype keys are not bundle ids; custom keys must be canonical.
      'o=constructor:4,toString:2,__proto__:8,custom:01:4',
      'x=' + b64({ wl: { base: 'constructor', inputTokens: 1, outputTokens: 1, cacheHitRate: 0 } }),
      'x=' + b64({ wl: { base: '__proto__', inputTokens: 1, outputTokens: 1, cacheHitRate: 0 } }),
    ];
    for (const c of cases) {
      let d: CalcState | undefined;
      expect(() => (d = decodeUrl(b, `?${c}&n=42&s=ok`)), c).not.toThrow();
      expect(d, c).toEqual({ ...s0, users: 42, speed: 'ok' });
    }
  });
  it.each(['n=0', 'n=1e9', 'n=abc', 'n=2.5', 'm=no-such-model', 'lang=fr', 'w=nope'])(
    'bad %s → default for that field, no throw',
    (q) => {
      expect(decodeUrl(b, '?' + q + '&s=ok')).toEqual({ ...s0, speed: 'ok' });
    },
  );
  it("q the model does not offer → the model's first option", () => {
    const s = decodeUrl(b, '?m=gpt-oss-120b&q=bf16');
    expect(quantOptions(b, 'gpt-oss-120b')).toContain(s.quant);
  });
  it('garbage search strings fall back to defaults', () => {
    expect(decodeUrl(b, '%%%&&==')).toEqual(s0);
  });
});
