import { quantOptions } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { defaultState } from '../src/state/state';
import { decodeUrl, encodeUrl } from '../src/state/url';

const b = getBundle();
const s0 = defaultState(b);

describe('url', () => {
  it('round-trips every field', () => {
    const s = { ...s0, mode: 'have' as const, lang: 'en' as const, users: 321, haveCount: 4, havePlatform: 'nano5-h100', workload: 'chat', speed: 'ok' };
    expect(decodeUrl(b, encodeUrl(s))).toEqual(s);
    expect(decodeUrl(b, '?' + encodeUrl(s))).toEqual(s);
  });
  it('does not write openRow or basisOpen', () => {
    const q = encodeUrl({ ...s0, openRow: 'nano4-h200', basisOpen: true });
    expect(q).not.toMatch(/open|basis/i);
    expect(decodeUrl(b, q).openRow).toBeNull();
  });
  it.each(['n=0', 'n=1e9', 'n=abc', 'n=2.5', 'm=no-such-model', 'mode=x', 'lang=fr', 'hp=nope', 'have=-1'])(
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
