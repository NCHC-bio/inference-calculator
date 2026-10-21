import en from './en';
import zhTW from './zh-TW';

// React-free half of i18n, so Node-side code (e2e expectations) can use it without the store.
export type Lang = 'zh-TW' | 'en';
export type MsgKey = keyof typeof zhTW;
export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;

const messages: Record<Lang, Record<MsgKey, string>> = { 'zh-TW': zhTW, en };

/** A var's value as a number (formatted numbers such as `1,200` included); NaN when it is not one. */
const asNumber = (v: string | number): number => (typeof v === 'number' ? v : Number(v.replace(/[^\d.-]/g, '') || NaN));

/**
 * Looks up a message and interpolates `{name}` placeholders. `{name:one|other}` picks `one` when that var is 1 and
 * `other` otherwise (English plurals: `{n} {n:GPU|GPUs}`; zh-TW messages have no plural forms).
 */
export function t(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  const msg = messages[lang][key];
  if (!vars) return msg;
  return msg
    .replace(/\{(\w+):([^|{}]*)\|([^{}]*)\}/g, (m, name: string, one: string, other: string) =>
      name in vars ? (asNumber(vars[name]!) === 1 ? one : other) : m,
    )
    .replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** The unit word after a count: `unit.gpu` / `unit.machine` for `n` (English singular for 1). */
export function unitWord(tr: TFn, unit: 'gpu' | 'machine', n: number | string): string {
  return tr(unit === 'machine' ? 'unit.machine' : 'unit.gpu', { n });
}

export const tZh: TFn = (key, vars) => t('zh-TW', key, vars);
