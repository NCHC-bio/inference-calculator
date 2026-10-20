import { useDeferredValue, useMemo } from 'react';
import { getBundle } from '../bundle';
import { useCalc } from '../state/store';
import { computeView, modelFeasibility, type View } from './compute';

type Feasibility = Record<string, { ok: number; total: number }>;

export function useView(): View {
  const [s] = useCalc();
  const { mode, users, haveCount, havePlatform, workload, model, quant, speed } = s;
  const key = { mode, users, haveCount, havePlatform, workload, model, quant, speed };
  const deferred = useDeferredValue(key);
  return useMemo(
    () => computeView(getBundle(), { ...s, ...deferred }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferred.mode, deferred.users, deferred.haveCount, deferred.havePlatform, deferred.workload, deferred.model, deferred.quant, deferred.speed],
  );
}

/** Computed only while the model dropdown is open. */
export function useModelFeasibility(enabled: boolean): Feasibility | null {
  const [s] = useCalc();
  const { users, workload, quant, speed } = s;
  const d = useDeferredValue({ users, workload, quant, speed });
  return useMemo(
    () => (enabled ? modelFeasibility(getBundle(), { ...s, ...d }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, d.users, d.workload, d.quant, d.speed],
  );
}
