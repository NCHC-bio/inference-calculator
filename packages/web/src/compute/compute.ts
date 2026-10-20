import type { Bundle } from '@nchc/schema';
import {
  CoreInputError,
  estimateCapacity,
  estimateRequirements,
  quantOptions,
  type CapacityResult,
  type RequirementResult,
} from '@nchc/core';
import type { CalcState } from '../state/state';

/** `users` is the (deferred) user count the result was computed for. */
export type NeedView = { kind: 'need'; result: RequirementResult; users: number };
export type HaveView = { kind: 'have'; result: CapacityResult };
export type ErrorView = { kind: 'error'; message: string };
export type View = NeedView | HaveView | ErrorView;

/** State goes to core unchanged; only CoreInputError becomes an error view, anything else is rethrown. */
export function computeView(bundle: Bundle, s: CalcState): View {
  try {
    if (s.mode === 'have') {
      return {
        kind: 'have',
        result: estimateCapacity(bundle, {
          model: s.model,
          quant: s.quant,
          workload: s.workload,
          speed: s.speed,
          platform: s.havePlatform,
          gpus: s.haveCount,
        }),
      };
    }
    return {
      kind: 'need',
      users: s.users,
      result: estimateRequirements(bundle, {
        model: s.model,
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
