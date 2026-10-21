import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { suggestActions } from '../src/compute/actions';
import { computeMain, type RowView } from '../src/compute/compute';
import { defaultState, reduce, type CalcState } from '../src/state/state';

const b = getBundle();
const s0 = defaultState(b);
const ROW = 'nano4-h200';

function rowOf(s: CalcState, row = ROW): RowView & { kind: 'ok' } {
  const v = computeMain(b, s);
  if (v.kind !== 'main') throw new Error(`expected a main view, got ${v.kind}`);
  const r = v.rows.find((x) => x.row === row);
  if (r?.kind !== 'ok') throw new Error(`row ${row} is not feasible`);
  return r;
}
const withCount = (gpus: number, base = s0): CalcState => ({ ...base, overrides: { [ROW]: { gpus } } });
const applied = (s: CalcState, apply: Parameters<typeof reduce>[2][]) => apply.reduce((x, a) => reduce(b, x, a), s);
const paramsOf = (id: string) => b.models[id]!.totalParamsB.value;

describe('suggestActions', () => {
  // Default state (fails on memory: users, model, reset) and a BF16 chat case (fails on compute: every kind).
  const chatBf16 = [
    { type: 'workload', id: 'chat' },
    { type: 'users', value: 200 },
    { type: 'model', id: 'mistral-small-3.1-24b-instruct-2503' },
    { type: 'quant', id: 'bf16' },
  ] as const;
  it.each([
    ['the default state', s0, ['users', 'model', 'reset']],
    ['BF16 chat at 200 users', applied(s0, [...chatBf16]), ['quant', 'speed', 'users', 'model', 'reset']],
  ])('below target offers relaxations that actually pass: %s', (_name, base, want) => {
    const suggested = rowOf(base).suggested;
    const s = withCount(Math.max(1, Math.floor(suggested / 2)), base);
    const row = rowOf(s);
    expect(row.perf.ok).toBe(false);
    const actions = suggestActions(b, s, row);
    const keys = actions.map((a) => a.key);
    expect(keys).toEqual(want);
    expect(keys.filter((k) => k === 'moreUsers' || k === 'biggerModel')).toEqual([]);
    for (const a of actions) {
      if (a.key === 'quant' || a.key === 'speed' || a.key === 'model') {
        const next = applied(s, a.apply);
        const r = rowOf(next);
        expect(r.perf.ok, a.key).toBe(true);
        expect(r.count).toBe(row.count);
      }
      if (a.key === 'model') {
        const next = applied(s, a.apply);
        expect(paramsOf(next.model)).toBeLessThan(paramsOf(s.model));
        expect(a.vars.name).toBe(b.models[next.model]!.name);
      }
      if (a.key === 'quant') {
        const next = applied(s, a.apply);
        expect(b.quantization[next.quant]!.bytesPerParam.value).toBeLessThan(b.quantization[s.quant]!.bytesPerParam.value);
        expect(a.vars.tps).toBe(rowOf(next).perf.usage!.tokPerSecPerUser);
      }
      if (a.key === 'users') {
        expect(a.vars.n).toBe(row.perf.maxConcurrent);
        const next = applied(s, a.apply);
        expect(next.users).toBe(row.perf.maxConcurrent);
        expect(rowOf(next).perf.ok).toBe(true);
      }
      if (a.key === 'reset') {
        expect(a.apply).toEqual([{ type: 'override', row: ROW, value: null }]);
        expect(a.vars.n).toBe(row.suggested);
      }
    }
    if (row.perf.maxConcurrent > 0) expect(keys).toContain('users');
  });

  it('above target offers more users and a bigger model', () => {
    const suggested = rowOf(s0).suggested;
    const s = withCount(suggested * 4);
    const row = rowOf(s);
    expect(row.perf.ok).toBe(true);
    const actions = suggestActions(b, s, row);
    const keys = actions.map((a) => a.key);
    expect(keys.filter((k) => k !== 'moreUsers' && k !== 'biggerModel')).toEqual([]);
    const more = actions.find((a) => a.key === 'moreUsers');
    expect(row.perf.maxConcurrent).toBeGreaterThan(s.users);
    expect(more?.vars.n).toBe(row.perf.maxConcurrent - s.users);
    expect(rowOf(applied(s, more!.apply)).perf.ok).toBe(true);
    const bigger = actions.find((a) => a.key === 'biggerModel');
    if (bigger) {
      const next = applied(s, bigger.apply);
      expect(paramsOf(next.model)).toBeGreaterThan(paramsOf(s.model));
      expect(rowOf(next).perf.ok).toBe(true);
      expect(rowOf(next).count).toBe(row.count);
      // The largest one that runs: no bigger catalog model passes on this row.
      for (const id of Object.keys(b.models).filter((m) => paramsOf(m) > paramsOf(next.model))) {
        const t = applied(s, [{ type: 'model', id }, { type: 'override', row: ROW, value: { gpus: row.count } }]);
        const v = computeMain(b, t);
        const r = v.kind === 'main' ? v.rows.find((x) => x.row === ROW) : undefined;
        expect(r?.kind === 'ok' && r.perf.ok, id).toBeFalsy();
      }
    }
  });

  it('at the suggested count no actions', () => {
    expect(suggestActions(b, s0, rowOf(s0))).toEqual([]);
  });
});
