import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { getBundle } from '../bundle';
import { reduce, type Action, type CalcState } from './state';
import { decodeUrl, encodeUrl } from './url';

const Ctx = createContext<[CalcState, (a: Action) => void] | null>(null);

type Tick = { s: CalcState; n: number };

export function StoreProvider({ children }: { children: ReactNode }) {
  const bundle = getBundle();
  const [tick, send] = useReducer(
    (t: Tick, a: Action): Tick => ({ s: reduce(bundle, t.s, a), n: t.n + 1 }),
    undefined,
    (): Tick => ({ s: decodeUrl(bundle, window.location.search), n: 0 }),
  );
  // tick.n changes on every dispatch (even rejected inputs), so the URL is rewritten each time.
  const last = useRef(tick);
  last.current = tick;
  useEffect(() => {
    history.replaceState(null, '', '?' + encodeUrl(last.current.s));
  }, [tick]);
  const dispatch = useCallback((a: Action) => send(a), []);
  const value = useMemo<[CalcState, (a: Action) => void]>(() => [tick.s, dispatch], [tick.s, dispatch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCalc(): [CalcState, (a: Action) => void] {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCalc must be used inside StoreProvider');
  return v;
}
