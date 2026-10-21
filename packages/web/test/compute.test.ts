import { estimateRequirements } from '@nchc/core';
import { describe, expect, it, vi } from 'vitest';
import { getBundle } from '../src/bundle';
import { computeView, modelFeasibility } from '../src/compute/compute';
import { defaultState } from '../src/state/state';

// estimateRequirements throws CoreInputError for the model named here (final review C1: one model's rejection must not
// take the whole menu down); every other call goes to core unchanged.
const throwFor = vi.hoisted(() => ({ model: null as string | null }));
vi.mock('@nchc/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@nchc/core')>();
  return {
    ...core,
    estimateRequirements: (...args: Parameters<typeof core.estimateRequirements>) => {
      const input = args[1] as { model?: unknown };
      if (throwFor.model !== null && input.model === throwFor.model) throw new core.CoreInputError('invalid-input', 'shape.replicas: Too big');
      return core.estimateRequirements(...args);
    },
  };
});

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
  it('CoreInputError -> error view, not a throw', () => {
    expect(computeView(b, { ...s0, users: 0 }).kind).toBe('error');
  });
  it('modelFeasibility covers every catalog model and counts every platform', () => {
    const f = modelFeasibility(b, s0);
    expect(Object.keys(f).sort()).toEqual(Object.keys(b.models).sort());
    for (const x of Object.values(f)) expect(x.total).toBe(Object.keys(b.platforms).length);
  });
  it('modelFeasibility: a model core rejects counts as runnable nowhere, the others still count (final review C1)', () => {
    const id = Object.keys(b.models)[0]!;
    throwFor.model = id;
    try {
      const f = modelFeasibility(b, s0);
      expect(f[id]).toEqual({ ok: 0, total: Object.keys(b.platforms).length });
      expect(Object.keys(f).sort()).toEqual(Object.keys(b.models).sort());
    } finally {
      throwFor.model = null;
    }
  });
  it('modelFeasibility at 1000000 chat users does not throw (final review C1)', () => {
    expect(() => modelFeasibility(b, { ...s0, workload: 'chat', users: 1000000 })).not.toThrow();
  });
  it('modelFeasibility over the whole catalog runs under 1.5 s', () => {
    const t = performance.now();
    modelFeasibility(b, s0);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(1500);
  });
});
