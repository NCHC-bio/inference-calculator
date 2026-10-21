import * as core from '@nchc/core';
import { estimatePerformance, estimateRequirements, quantOptions, type CustomPlatformInput } from '@nchc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBundle } from '../src/bundle';
import { computeMain, modelOptionNotes, sweepCounts, type RowView } from '../src/compute/compute';
import { platformOf, queryOf } from '../src/compute/query';
import { defaultState, type CalcState } from '../src/state/state';

// The module namespace is made spy-able (plain object); every call still goes to core unchanged.
vi.mock('@nchc/core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@nchc/core')>()) }));

const b = getBundle();
const s0 = defaultState(b);
const MY_GPU: CustomPlatformInput = {
  name: 'My GPU', unit: 'gpu', gpusPerNode: 8, memGB: 141, memBwTBs: 4.8, tflops: 900, tdpW: 700, nvlinkBidirGBs: 900, engine: 'vllm',
};

const main = (s: CalcState) => {
  const v = computeMain(b, s);
  if (v.kind !== 'main') throw new Error(`expected a main view, got ${v.kind}`);
  return v;
};
const ok = (rows: RowView[]) => rows.filter((r): r is RowView & { kind: 'ok' } => r.kind === 'ok');

afterEach(() => vi.restoreAllMocks());

describe('computeMain', () => {
  it('unadjusted rows use the suggested count', () => {
    const v = main(s0);
    expect(v.users).toBe(s0.users);
    expect(v.result).toEqual(estimateRequirements(b, queryOf(b, s0)));
    expect(v.rows.map((r) => r.row)).toEqual(v.result.perPlatform.map((p) => p.platform));
    expect(ok(v.rows).length).toBeGreaterThan(0);
    v.rows.forEach((r, i) => {
      if (r.kind !== 'ok') return;
      const p = v.result.perPlatform[i]!;
      expect(p.expected.ok).toBe(true);
      expect(r.count).toBe(r.suggested);
      expect(r.suggested).toBe(p.expected.ok ? p.expected.gpus : NaN);
      expect(r.conservative).toBe(p.conservative.ok ? p.conservative.gpus : null);
      expect(r.adjusted).toBe(false);
      expect(r.perf.usage).toEqual(p.usage);
      expect(r.perf.maxConcurrent).toBe(p.maxConcurrent);
      expect(r.suggestedPerf).toEqual(r.perf);
    });
  });

  it('an override changes only its row', () => {
    const before = main(s0);
    const v = main({ ...s0, overrides: { 'nano4-h200': { gpus: 1 } } });
    const row = v.rows.find((r) => r.row === 'nano4-h200')!;
    expect(row.kind).toBe('ok');
    if (row.kind !== 'ok') return;
    expect(row.count).toBe(1);
    expect(row.adjusted).toBe(true);
    expect(row.perf).toEqual(estimatePerformance(b, { ...queryOf(b, s0), platform: 'nano4-h200', gpus: 1 }));
    const prev = before.rows.find((r) => r.row === 'nano4-h200') as RowView & { kind: 'ok' };
    expect(row.suggested).toBe(prev.suggested);
    expect(row.suggestedPerf).toEqual(prev.perf);
    for (const r of v.rows) if (r.row !== 'nano4-h200') expect(r).toEqual(before.rows.find((x) => x.row === r.row));
  });

  it('an override tp is used, and an illegal one falls back to the best split', () => {
    const v = main({ ...s0, overrides: { 'nano4-h200': { gpus: 8, tp: 8 } } });
    const row = v.rows.find((r) => r.row === 'nano4-h200') as RowView & { kind: 'ok' };
    expect(row.perf.shape?.tp).toBe(8);
    const bad = main({ ...s0, overrides: { 'nano4-h200': { gpus: 2, tp: 8 } } });
    const r2 = bad.rows.find((r) => r.row === 'nano4-h200') as RowView & { kind: 'ok' };
    expect(r2.perf).toEqual(estimatePerformance(b, { ...queryOf(b, s0), platform: 'nano4-h200', gpus: 2 }));
  });

  it('infeasible rows carry the solver reason', () => {
    const v = main(s0);
    const bad = v.result.perPlatform.filter((p) => !p.expected.ok);
    expect(bad.length).toBeGreaterThan(0);
    for (const p of bad) {
      const r = v.rows.find((x) => x.row === p.platform)!;
      expect(r.kind).toBe('infeasible');
      if (r.kind !== 'infeasible' || p.expected.ok) continue;
      expect(r.why).toBe(p.expected.why);
      expect(r.detail).toBe(p.expected.detail);
    }
  });

  it('custom platforms become rows after the catalog', () => {
    const s = { ...s0, customPlatforms: [MY_GPU, { ...MY_GPU, name: 'Second' }] };
    const v = main(s);
    const keys = v.rows.map((r) => r.row);
    expect(keys).toEqual([...Object.keys(b.platforms), 'custom:0', 'custom:1']);
    expect(platformOf(b, s, 'custom:1')).toEqual({ ...MY_GPU, name: 'Second' });
    expect(platformOf(b, s, 'nano4-h200')).toBe('nano4-h200');
    const custom = v.rows.find((r) => r.row === 'custom:0')!;
    if (custom.kind === 'ok') {
      expect(custom.perf.usage).toEqual(v.result.perPlatform[keys.indexOf('custom:0')]!.usage);
    }
  });

  it('CoreInputError becomes an error view, other errors rethrow', () => {
    const spy = vi.spyOn(core, 'estimateRequirements');
    spy.mockImplementationOnce(() => {
      throw new core.CoreInputError('invalid-input', 'bad input');
    });
    expect(computeMain(b, s0)).toEqual({ kind: 'error', message: 'bad input' });
    spy.mockImplementationOnce(() => {
      throw new Error('bundle bug');
    });
    expect(() => computeMain(b, s0)).toThrow('bundle bug');
  });

  it('an HF model not imported yet is a loading view (Ruling W1)', () => {
    const s: CalcState = { ...s0, model: 'custom', customModel: { kind: 'hf', repo: 'a/b', sha: 'main' } };
    expect(computeMain(b, s)).toEqual({ kind: 'loading' });
  });
});

describe('sweepCounts', () => {
  const increasing = (l: number[]) => l.every((g, i) => Number.isInteger(g) && g >= 1 && (i === 0 || g > l[i - 1]!));
  it('small counts: every count up to max(8, suggested × 4, count × 1.5)', () => {
    const l = sweepCounts(4, 4);
    expect(l).toContain(1);
    expect(l).toContain(4);
    expect(l).toContain(16);
    expect(increasing(l)).toBe(true);
    expect(l.length).toBeLessThanOrEqual(64);
  });
  it('large counts stay within 64 points and keep the suggested and current counts', () => {
    const l = sweepCounts(4000, 4000);
    expect(l.length).toBeLessThanOrEqual(64);
    expect(l).toContain(4000);
    expect(l).toContain(1);
    expect(l.at(-1)).toBe(16000);
    expect(increasing(l)).toBe(true);
    const m = sweepCounts(3, 777);
    expect(m).toContain(3);
    expect(m).toContain(777);
    expect(increasing(m)).toBe(true);
    expect(m.length).toBeLessThanOrEqual(64);
  });
  it('the range covers 1.5 × the current count', () => {
    expect(Math.max(...sweepCounts(2, 30))).toBeGreaterThanOrEqual(45);
  });
  it('never exceeds the core GPU limit', () => {
    const l = sweepCounts(100000, 100000);
    expect(l.at(-1)).toBeLessThanOrEqual(100000);
    expect(l).toContain(100000);
    expect(increasing(l)).toBe(true);
  });
});

describe('modelOptionNotes', () => {
  it('without an override: how many platforms run each model', () => {
    const v = main(s0);
    const notes = modelOptionNotes(b, s0, v.rows);
    expect(Object.keys(notes).sort()).toEqual(Object.keys(b.models).sort());
    for (const [id, n] of Object.entries(notes)) {
      const opts = quantOptions(b, id);
      const quant = opts.includes(s0.quant) ? s0.quant : opts[0]!;
      const r = estimateRequirements(b, { ...queryOf(b, s0), model: id, quant });
      expect(n).toEqual({ kind: 'platforms', ok: r.perPlatform.filter((p) => p.expected.ok).length, total: r.perPlatform.length });
    }
  });

  it('with an override: the result on that row', () => {
    const s = { ...s0, overrides: { 'nano4-h200': { gpus: 1 } } };
    const v = main(s);
    const notes = modelOptionNotes(b, s, v.rows);
    const kinds = new Set<string>();
    for (const [id, n] of Object.entries(notes)) {
      const opts = quantOptions(b, id);
      const quant = opts.includes(s.quant) ? s.quant : opts[0]!;
      const p = estimatePerformance(b, { ...queryOf(b, s0), model: id, quant, platform: 'nano4-h200', gpus: 1 });
      expect(n).toEqual(p.usage ? { kind: 'onRow', tps: p.usage.tokPerSecPerUser, ok: p.ok } : { kind: 'noFit' });
      kinds.add(n.kind);
    }
    expect(kinds.has('platforms')).toBe(false);
  });

  it('a model core rejects counts as runnable nowhere (final review C1)', () => {
    const id = Object.keys(b.models)[0]!;
    const real = core.estimateRequirements;
    vi.spyOn(core, 'estimateRequirements').mockImplementation((bb, input) => {
      if (input.model === id) throw new core.CoreInputError('invalid-input', 'too big');
      return real(bb, input);
    });
    const notes = modelOptionNotes(b, s0, main(s0).rows);
    expect(notes[id]).toEqual({ kind: 'platforms', ok: 0, total: Object.keys(b.platforms).length });
  });

  it('at 1000000 chat users does not throw (final review C1)', () => {
    const s = { ...s0, workload: 'chat', users: 1000000 };
    expect(() => modelOptionNotes(b, s, main(s).rows)).not.toThrow();
  });
});
