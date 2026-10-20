import { estimateRequirements } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { computeView, modelFeasibility } from '../src/compute/compute';
import { defaultState } from '../src/state/state';

const b = getBundle();
const s0 = defaultState(b);

describe('compute layer', () => {
  it('need mode returns estimateRequirements for the state', () => {
    const v = computeView(b, s0);
    expect(v.kind).toBe('need');
    expect(v.kind === 'need' && v.users).toBe(s0.users);
    expect(v.kind === 'need' && v.result).toEqual(
      estimateRequirements(b, { model: s0.model, quant: s0.quant, workload: s0.workload, speed: s0.speed, users: s0.users }),
    );
  });
  it('have mode returns estimateCapacity for havePlatform x haveCount', () => {
    const v = computeView(b, { ...s0, mode: 'have' });
    expect(v.kind === 'have' && v.result.expected.n).toBeGreaterThan(0);
  });
  it('CoreInputError -> error view, not a throw', () => {
    expect(computeView(b, { ...s0, users: 0 }).kind).toBe('error');
  });
  it('modelFeasibility covers every catalog model and counts every platform', () => {
    const f = modelFeasibility(b, s0);
    expect(Object.keys(f).sort()).toEqual(Object.keys(b.models).sort());
    for (const x of Object.values(f)) expect(x.total).toBe(Object.keys(b.platforms).length);
  });
  it('modelFeasibility over the whole catalog runs under 1.5 s', () => {
    const t = performance.now();
    modelFeasibility(b, s0);
    const ms = performance.now() - t;
    console.log(`modelFeasibility ms=${ms.toFixed(1)}`);
    expect(ms).toBeLessThan(1500);
  });
});
