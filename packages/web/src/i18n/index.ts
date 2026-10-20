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

export function langFromUrl(): Lang {
  return new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh-TW';
}

/** Task 3 will read the language from the central store instead of the URL. */
export function useT(): TFn {
  const lang = langFromUrl();
  return (key, vars) => t(lang, key, vars);
}
