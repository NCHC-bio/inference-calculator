import en from './en';
import zhTW from './zh-TW';

// React-free half of i18n, so Node-side code (e2e expectations) can use it without the store.
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
