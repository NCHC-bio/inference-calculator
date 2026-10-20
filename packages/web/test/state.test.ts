import { quantOptions } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { defaultState, reduce } from '../src/state/state';

const b = getBundle();
const s0 = defaultState(b);

describe('reduce', () => {
  it('each select changes only its own field (spec §8.3.3 demo 缺陷)', () => {
    const s1 = reduce(b, s0, { type: 'speed', id: 'ok' });
    expect({ ...s1, speed: s0.speed }).toEqual(s0);
    const s2 = reduce(b, s1, { type: 'workload', id: 'chat' });
    expect(s2.speed).toBe('ok');
    expect(s2.model).toBe(s0.model);
    expect(s2.quant).toBe(s0.quant);
  });
  it('users: rejects null, 0, decimals, > 1e7; keeps the last valid value', () => {
    for (const v of [null, 0, 2.5, -3, 1e7 + 1, Number.NaN]) {
      expect(reduce(b, s0, { type: 'users', value: v }).users).toBe(s0.users);
    }
    expect(reduce(b, s0, { type: 'users', value: 200 }).users).toBe(200);
  });
  it('haveCount: 1..1e5 integers only', () => {
    for (const v of [null, 0, 1.5, 1e5 + 1]) {
      expect(reduce(b, s0, { type: 'haveCount', value: v }).haveCount).toBe(s0.haveCount);
    }
    expect(reduce(b, s0, { type: 'haveCount', value: 4 }).haveCount).toBe(4);
  });
  it('model change keeps quant when the new model offers it, else takes its first option', () => {
    const native = reduce(b, s0, { type: 'model', id: 'gpt-oss-120b' });
    expect(native.quant).toBe(quantOptions(b, 'gpt-oss-120b')[0]);
    const kept = reduce(b, s0, { type: 'model', id: 'llama-3.3-70b-instruct-fp8' });
    expect(kept.quant).toBe(s0.quant);
  });
  it('unknown ids are ignored', () => {
    expect(reduce(b, s0, { type: 'model', id: 'no-such' })).toEqual(s0);
    expect(reduce(b, s0, { type: 'havePlatform', id: 'no-such' })).toEqual(s0);
    expect(reduce(b, s0, { type: 'quant', id: 'no-such' })).toEqual(s0);
  });
  it('mode, lang, openRow and basis set their own field', () => {
    expect(reduce(b, s0, { type: 'mode', mode: 'have' }).mode).toBe('have');
    expect(reduce(b, s0, { type: 'lang', lang: 'en' }).lang).toBe('en');
    expect(reduce(b, s0, { type: 'openRow', id: 'nano4-h200' }).openRow).toBe('nano4-h200');
    expect(reduce(b, s0, { type: 'basis', open: true }).basisOpen).toBe(true);
  });
});
