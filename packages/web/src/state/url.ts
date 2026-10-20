import type { Bundle } from '@nchc/schema';
import { quantOptions } from '@nchc/core';
import { HAVE_MAX, USERS_MAX, defaultState, reduce, type CalcState } from './state';

export function encodeUrl(s: CalcState): string {
  const p = new URLSearchParams({
    mode: s.mode,
    lang: s.lang,
    n: String(s.users),
    have: String(s.haveCount),
    hp: s.havePlatform,
    w: s.workload,
    m: s.model,
    q: s.quant,
    s: s.speed,
  });
  return p.toString();
}

const parseInt10 = (raw: string | null): number | null =>
  raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;

/** Starts from defaults and applies each valid field; invalid ones keep their default. Never throws. */
export function decodeUrl(b: Bundle, search: string): CalcState {
  let s = defaultState(b);
  const p = new URLSearchParams(search);
  const mode = p.get('mode');
  if (mode === 'need' || mode === 'have') s = reduce(b, s, { type: 'mode', mode });
  const lang = p.get('lang');
  if (lang === 'en' || lang === 'zh-TW') s = reduce(b, s, { type: 'lang', lang });
  const n = parseInt10(p.get('n'));
  if (n !== null && n <= USERS_MAX) s = reduce(b, s, { type: 'users', value: n });
  const have = parseInt10(p.get('have'));
  if (have !== null && have <= HAVE_MAX) s = reduce(b, s, { type: 'haveCount', value: have });
  const ids: [string, 'havePlatform' | 'workload' | 'model' | 'speed'][] = [
    ['hp', 'havePlatform'],
    ['w', 'workload'],
    ['m', 'model'],
    ['s', 'speed'],
  ];
  for (const [key, type] of ids) {
    const v = p.get(key);
    if (v !== null) s = reduce(b, s, { type, id: v });
  }
  // m is applied above, so q is checked against the final model's options.
  const q = p.get('q');
  if (q !== null && quantOptions(b, s.model).includes(q)) s = reduce(b, s, { type: 'quant', id: q });
  return s;
}
