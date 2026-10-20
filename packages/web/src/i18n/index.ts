import { useMemo } from 'react';
import { useCalc } from '../state/store';
import en from './en';
import zhTW from './zh-TW';

export type Lang = 'zh-TW' | 'en';
export type MsgKey = keyof typeof zhTW;
export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;

const messages: Record<Lang, Record<MsgKey, string>> = { 'zh-TW': zhTW, en };

/** Looks up a message and interpolates `{name}` placeholders. */
export function t(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  const msg = messages[lang][key];
  if (!vars) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export const tZh: TFn = (key, vars) => t('zh-TW', key, vars);

/** Single source of the active language: the central store (seeded from the `lang` URL param). */
export function useLang(): Lang {
  return useCalc()[0].lang;
}

export function useT(): TFn {
  const lang = useLang();
  return useMemo<TFn>(() => (key, vars) => t(lang, key, vars), [lang]);
}
