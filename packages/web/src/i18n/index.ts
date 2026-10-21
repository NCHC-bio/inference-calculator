import { useMemo } from 'react';
import { useCalc } from '../state/store';
import { t, type Lang, type TFn } from './t';

export { t, tZh, unitWord, type Lang, type MsgKey, type TFn } from './t';

/** Single source of the active language: the central store (seeded from the `lang` URL param). */
export function useLang(): Lang {
  return useCalc()[0].lang;
}

export function useT(): TFn {
  const lang = useLang();
  return useMemo<TFn>(() => (key, vars) => t(lang, key, vars), [lang]);
}
