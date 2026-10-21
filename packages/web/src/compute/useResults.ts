import { useDeferredValue } from 'react';
import { getBundle } from '../bundle';
import type { CalcState, RowKey } from '../state/state';
import { useCalc } from '../state/store';
import { computeBench, computeMain, modelOptionNotes, type BenchView, type MainView, type ModelNote } from './compute';

/**
 * Remembers the last result per function, keyed on the identity of the inputs it reads. The reducer keeps unchanged
 * fields by reference, so every component asking for the same deferred state shares one computation.
 */
function lastBy<A extends unknown[], R>(f: (...a: A) => R): (key: unknown[], ...a: A) => R {
  let last: { key: unknown[]; value: R } | null = null;
  return (key, ...a) => {
    if (last && last.key.length === key.length && last.key.every((k, i) => Object.is(k, key[i]))) return last.value;
    const value = f(...a);
    last = { key, value };
    return value;
  };
}

/** The state fields computeMain reads. */
const mainKey = (s: CalcState): unknown[] => [s.users, s.workload, s.model, s.quant, s.speed, s.customModel, s.customPlatforms, s.overrides];

const mainOf = lastBy((s: CalcState) => computeMain(getBundle(), s));
const benchOf = lastBy((s: CalcState, main: MainView, row: RowKey): BenchView | null => {
  const r = main.kind === 'main' ? main.rows.find((x) => x.row === row) : undefined;
  return r?.kind === 'ok' ? computeBench(getBundle(), s, r) : null;
});
const notesOf = lastBy((s: CalcState, main: MainView): Record<string, ModelNote> | null =>
  main.kind === 'main' ? modelOptionNotes(getBundle(), s, main.rows) : null,
);

/** Input changes are deferred, so typing stays responsive while core recomputes. */
function useDeferredState(): CalcState {
  const [s] = useCalc();
  return useDeferredValue(s);
}

/** The answer and the platform rows for the (deferred) inputs. */
export function useMain(): MainView {
  const s = useDeferredState();
  return mainOf(mainKey(s), s);
}

/** Workbench data for the open row only; null when it is not a feasible row. */
export function useBench(row: RowKey | null): BenchView | null {
  const s = useDeferredState();
  const main = mainOf(mainKey(s), s);
  if (row === null) return null;
  return benchOf([main, row], s, main, row);
}

/** Model option notes, computed only while the model menu is open (`enabled`). */
export function useModelNotes(enabled: boolean): ReturnType<typeof modelOptionNotes> | null {
  const s = useDeferredState();
  const main = mainOf(mainKey(s), s);
  if (!enabled) return null;
  // The note row is the open adjusted one when there is one (modelOptionNotes).
  return notesOf([main, s.openRow], s, main);
}
