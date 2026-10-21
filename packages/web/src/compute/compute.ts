import type { Bundle } from '@nchc/schema';
import {
  CoreInputError,
  estimatePerformanceSweep,
  estimateRequirements,
  type PerformanceResult,
  type PlatformResult,
  type RequirementResult,
  type SpeedCurve,
  type SweepPoint,
  type Why,
} from '@nchc/core';
import { COUNT_MAX, reduce, type CalcState, type RowKey } from '../state/state';
import { suggestActions, type SuggestedAction } from './actions';
import { performanceQueryOf, queryOf, rowPerf } from './query';

export type RowView =
  | { kind: 'infeasible'; row: RowKey; why: Why; detail: string }
  | {
      kind: 'ok';
      row: RowKey;
      /** Core's fewest cards (expected eta). */
      suggested: number;
      /** Core's fewest cards at conservative eta; null when that is infeasible. */
      conservative: number | null;
      /** The user set this row's count (or split). */
      adjusted: boolean;
      /** The count shown: the override's, else the suggested one. */
      count: number;
      /** Performance at `count` (and the override's tp). */
      perf: PerformanceResult;
      /** Performance at `suggested` with the best split (equals the requirement row). */
      suggestedPerf: PerformanceResult;
    };
export type OkRow = RowView & { kind: 'ok' };
export type MainView =
  | { kind: 'main'; result: RequirementResult; rows: RowView[]; users: number }
  | { kind: 'error'; message: string }
  /** An HF model in the URL that is not re-imported yet (Ruling W1). */
  | { kind: 'loading' };

function rowView(b: Bundle, s: CalcState, p: PlatformResult): RowView {
  const row = p.platform;
  if (!p.expected.ok) return { kind: 'infeasible', row, why: p.expected.why, detail: p.expected.detail };
  const suggested = p.expected.gpus;
  const suggestedPerf = rowPerf(b, s, row, { gpus: suggested });
  const o = Object.hasOwn(s.overrides, row) ? s.overrides[row] : undefined;
  return {
    kind: 'ok',
    row,
    suggested,
    conservative: p.conservative.ok ? p.conservative.gpus : null,
    adjusted: o !== undefined,
    count: o?.gpus ?? suggested,
    perf: o ? rowPerf(b, s, row, o) : suggestedPerf,
    suggestedPerf,
  };
}

/** The answer and one view per platform row; only CoreInputError becomes an error view, anything else is rethrown. */
export function computeMain(b: Bundle, s: CalcState): MainView {
  if (s.customModel?.kind === 'hf' && !s.customModel.imported) return { kind: 'loading' };
  try {
    const result = estimateRequirements(b, queryOf(b, s));
    return { kind: 'main', result, rows: result.perPlatform.map((p) => rowView(b, s, p)), users: s.users };
  } catch (e) {
    if (e instanceof CoreInputError) return { kind: 'error', message: e.message };
    throw e;
  }
}

/**
 * Card counts of the "cards → speed" curve: 1 to max(8, suggested × 4, ceil(count × 1.5)), at most COUNT_MAX (core's
 * GPU limit). Every count when that is ≤ 64, else 64 evenly spaced ones that always include 1, suggested, count and the
 * end (core's sweep takes at most 64).
 */
export function sweepCounts(suggested: number, count: number): number[] {
  const max = Math.min(COUNT_MAX, Math.max(8, suggested * 4, Math.ceil(count * 1.5)));
  if (max <= 64) return Array.from({ length: max }, (_, i) => i + 1);
  const set = new Set([1, suggested, count, max].filter((g) => g >= 1 && g <= max));
  const free = 64 - set.size;
  for (let i = 1; i <= free; i++) set.add(Math.round(1 + (i * (max - 1)) / (free + 1)));
  return [...set].sort((x, y) => x - y);
}

export type BenchView = {
  row: RowKey;
  perf: PerformanceResult;
  /** The best split at each sweepCounts count, at the current users. */
  sweep: SweepPoint[];
  /** Speed against users at the current count and split (perf.speedCurve). */
  userCurve: SpeedCurve | null;
  actions: SuggestedAction[];
};

/** Workbench data for the expanded row. */
export function computeBench(b: Bundle, s: CalcState, row: OkRow): BenchView {
  const { gpus: _g, tp: _t, ...q } = performanceQueryOf(b, s, row.row, row.count);
  const sweep = estimatePerformanceSweep(b, { ...q, gpusList: sweepCounts(row.suggested, row.count) });
  return { row: row.row, perf: row.perf, sweep: sweep.points, userCurve: row.perf.speedCurve, actions: suggestActions(b, s, row) };
}

export type ModelNote = { kind: 'onRow'; tps: number; ok: boolean } | { kind: 'noFit' } | { kind: 'platforms'; ok: number; total: number };

/**
 * Per catalog model, the note its option shows. With an adjusted row (the open one first, else the first adjusted):
 * that model's speed on the row's cards, or noFit when the weights / one user's context do not fit. Otherwise how many
 * platforms run it (expected.ok). The model keeps the current quant when it offers it, else its first option. A model
 * core rejects with CoreInputError counts as runnable nowhere (final review C1); anything else is rethrown.
 */
export function modelOptionNotes(b: Bundle, s: CalcState, rows: RowView[]): Record<string, ModelNote> {
  const adjusted = rows.filter((r): r is OkRow => r.kind === 'ok' && r.adjusted);
  const target = adjusted.find((r) => r.row === s.openRow) ?? adjusted[0];
  const total = Object.keys(b.platforms).length + s.customPlatforms.length;
  const out: Record<string, ModelNote> = {};
  for (const id of Object.keys(b.models)) {
    const cand = reduce(b, s, { type: 'model', id });
    try {
      if (target) {
        const perf = rowPerf(b, cand, target.row, s.overrides[target.row] ?? { gpus: target.count });
        out[id] = perf.usage ? { kind: 'onRow', tps: perf.usage.tokPerSecPerUser, ok: perf.ok } : { kind: 'noFit' };
      } else {
        const r = estimateRequirements(b, queryOf(b, cand));
        out[id] = { kind: 'platforms', ok: r.perPlatform.filter((p) => p.expected.ok).length, total: r.perPlatform.length };
      }
    } catch (e) {
      if (!(e instanceof CoreInputError)) throw e;
      out[id] = target ? { kind: 'noFit' } : { kind: 'platforms', ok: 0, total };
    }
  }
  return out;
}
