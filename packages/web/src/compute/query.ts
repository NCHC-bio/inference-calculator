import type { Bundle } from '@nchc/schema';
import {
  CoreInputError,
  estimatePerformance,
  type CustomPlatformInput,
  type PerformanceInput,
  type PerformanceResult,
  type RequirementInput,
} from '@nchc/core';
import type { CalcState, Override, RowKey } from '../state/state';

/**
 * The model as core takes it: catalog id, manual architecture, or an imported HF model. An HF model not re-imported yet
 * (URL reload) has no model object; computeMain shows a loading view for it before asking core (Ruling W1).
 */
function modelOf(s: Pick<CalcState, 'model' | 'customModel'>): RequirementInput['model'] {
  const c = s.customModel;
  if (c?.kind === 'manual') return c.value;
  if (c?.kind === 'hf' && c.imported) return { imported: c.imported };
  return s.model;
}

/** State → core requirement query: the only place selections map to core inputs. */
export function queryOf(_b: Bundle, s: CalcState): RequirementInput {
  return {
    model: modelOf(s),
    quant: s.quant,
    workload: s.workload,
    speed: s.speed,
    users: s.users,
    ...(s.customPlatforms.length > 0 ? { customPlatforms: s.customPlatforms } : {}),
  };
}

/** A row's platform as core takes it: the catalog id, or the user-entered platform behind `custom:<i>`. */
export function platformOf(b: Bundle, s: CalcState, row: RowKey): string | CustomPlatformInput {
  const m = /^custom:(0|[1-9]\d*)$/.exec(row);
  if (m) {
    const p = s.customPlatforms[Number(m[1])];
    if (p) return p;
  } else if (Object.hasOwn(b.platforms, row)) {
    return row;
  }
  throw new Error(`unknown row ${row}`);
}

/** estimatePerformance's input for one row at `gpus` (and `tp`): the requirement query without the platform list. */
export function performanceQueryOf(b: Bundle, s: CalcState, row: RowKey, gpus: number, tp?: number): PerformanceInput {
  const { customPlatforms: _drop, ...q } = queryOf(b, s);
  return { ...q, platform: platformOf(b, s, row), gpus, ...(tp !== undefined ? { tp } : {}) };
}

/**
 * estimatePerformance for one row. An override's tp that is not legal for this count / model (e.g. a stale URL) is
 * dropped: the best split is used instead.
 */
export function rowPerf(b: Bundle, s: CalcState, row: RowKey, o: Override): PerformanceResult {
  if (o.tp !== undefined) {
    try {
      return estimatePerformance(b, performanceQueryOf(b, s, row, o.gpus, o.tp));
    } catch (e) {
      if (!(e instanceof CoreInputError)) throw e;
    }
  }
  return estimatePerformance(b, performanceQueryOf(b, s, row, o.gpus));
}
