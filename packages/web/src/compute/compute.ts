import type { Bundle } from '@nchc/schema';
import {
  CoreInputError,
  estimateRequirements,
  quantOptions,
  type QueryInput,
  type RequirementResult,
} from '@nchc/core';
import type { CalcState } from '../state/state';

/** `users` is the (deferred) user count the result was computed for. */
export type NeedView = { kind: 'need'; result: RequirementResult; users: number };
export type ErrorView = { kind: 'error'; message: string };
export type View = NeedView | ErrorView;

/**
 * The model as core takes it: catalog id, manual architecture, or an imported HF model. An HF model not re-imported
 * yet (URL reload) has no model object; its id `custom` is unknown to core (Task 2 turns this into a loading view).
 */
export function modelInput(s: Pick<CalcState, 'model' | 'customModel'>): QueryInput['model'] {
  const c = s.customModel;
  if (c?.kind === 'manual') return c.value;
  if (c?.kind === 'hf' && c.imported) return { imported: c.imported };
  return s.model;
}

/**
 * State goes to core unchanged; only CoreInputError becomes an error view, anything else is rethrown. Custom platforms
 * are not passed yet: the rows that render `custom:<i>` arrive with the v8 platform list (later task).
 */
export function computeView(bundle: Bundle, s: CalcState): View {
  try {
    return {
      kind: 'need',
      users: s.users,
      result: estimateRequirements(bundle, {
        model: modelInput(s),
        quant: s.quant,
        workload: s.workload,
        speed: s.speed,
        users: s.users,
      }),
    };
  } catch (e) {
    if (e instanceof CoreInputError) return { kind: 'error', message: e.message };
    throw e;
  }
}

/**
 * Per model: how many platforms run it (expected.ok) at the current users / workload / speed. A model core rejects
 * with CoreInputError for these inputs counts as runnable on none (final review C1: one model's rejection used to
 * throw out of the menu render and blank the page); anything else is rethrown.
 */
export function modelFeasibility(bundle: Bundle, s: CalcState): Record<string, { ok: number; total: number }> {
  const out: Record<string, { ok: number; total: number }> = {};
  const total = Object.keys(bundle.platforms).length;
  for (const id of Object.keys(bundle.models)) {
    const opts = quantOptions(bundle, id);
    const quant = opts.includes(s.quant) ? s.quant : opts[0]!;
    try {
      const r = estimateRequirements(bundle, {
        model: id,
        quant,
        workload: s.workload,
        speed: s.speed,
        users: s.users,
      });
      out[id] = { ok: r.perPlatform.filter((p) => p.expected.ok).length, total: r.perPlatform.length };
    } catch (e) {
      if (!(e instanceof CoreInputError)) throw e;
      out[id] = { ok: 0, total };
    }
  }
  return out;
}
