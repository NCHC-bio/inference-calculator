import type { Bundle } from '@nchc/schema';
import { quantOptions } from '@nchc/core';
import type { Lang } from '../i18n';

export type Mode = 'need' | 'have';
export type CalcState = {
  mode: Mode;
  lang: Lang;
  /** Peak concurrent users, integer 1..1e7. */
  users: number;
  /** Cards or machines the user already has, integer 1..1e5. */
  haveCount: number;
  havePlatform: string;
  workload: string;
  model: string;
  quant: string;
  speed: string;
  /** Platform id of the expanded row. */
  openRow: string | null;
  basisOpen: boolean;
};
export type Action =
  | { type: 'mode'; mode: Mode }
  | { type: 'lang'; lang: Lang }
  | { type: 'users'; value: number | null }
  | { type: 'haveCount'; value: number | null }
  | { type: 'havePlatform'; id: string }
  | { type: 'workload'; id: string }
  | { type: 'model'; id: string }
  | { type: 'quant'; id: string }
  | { type: 'speed'; id: string }
  | { type: 'openRow'; id: string | null }
  | { type: 'basis'; open: boolean };

export const USERS_MAX = 1e7;
export const HAVE_MAX = 1e5;

/** UI default selections (ids, not figures). Each falls back to the first bundle id when absent. */
export const DEFAULTS = {
  mode: 'need' as Mode,
  lang: 'zh-TW' as Lang,
  users: 15,
  haveCount: 16,
  havePlatform: 'nano4-h200',
  workload: 'assist',
  model: 'llama-3.3-70b-instruct-fp8',
  speed: 'smooth',
};

const isIntIn = (v: number | null, max: number): v is number =>
  v !== null && Number.isInteger(v) && v >= 1 && v <= max;

export const platformIds = (b: Bundle): string[] => Object.keys(b.platforms);
export const workloadIds = (b: Bundle): string[] => Object.keys(b.workloads);
export const modelIds = (b: Bundle): string[] => Object.keys(b.models);
export const speedIds = (b: Bundle): string[] => Object.keys(b.speedPresets);

const pick = (ids: string[], want: string): string => (ids.includes(want) ? want : ids[0]!);

export function defaultState(b: Bundle): CalcState {
  const model = pick(modelIds(b), DEFAULTS.model);
  return {
    mode: DEFAULTS.mode,
    lang: DEFAULTS.lang,
    users: DEFAULTS.users,
    haveCount: DEFAULTS.haveCount,
    havePlatform: pick(platformIds(b), DEFAULTS.havePlatform),
    workload: pick(workloadIds(b), DEFAULTS.workload),
    model,
    quant: quantOptions(b, model)[0]!,
    speed: pick(speedIds(b), DEFAULTS.speed),
    openRow: null,
    basisOpen: false,
  };
}

/** Quant carried to a new model: kept when offered, else the model's first option. */
export function quantFor(b: Bundle, model: string, current: string): string {
  const opts = quantOptions(b, model);
  return opts.includes(current) ? current : opts[0]!;
}

export function reduce(b: Bundle, s: CalcState, a: Action): CalcState {
  switch (a.type) {
    case 'mode':
      return a.mode === 'need' || a.mode === 'have' ? { ...s, mode: a.mode } : s;
    case 'lang':
      return a.lang === 'en' || a.lang === 'zh-TW' ? { ...s, lang: a.lang } : s;
    case 'users':
      return isIntIn(a.value, USERS_MAX) ? { ...s, users: a.value } : s;
    case 'haveCount':
      return isIntIn(a.value, HAVE_MAX) ? { ...s, haveCount: a.value } : s;
    case 'havePlatform':
      return platformIds(b).includes(a.id) ? { ...s, havePlatform: a.id } : s;
    case 'workload':
      return workloadIds(b).includes(a.id) ? { ...s, workload: a.id } : s;
    case 'speed':
      return speedIds(b).includes(a.id) ? { ...s, speed: a.id } : s;
    case 'model':
      return modelIds(b).includes(a.id) ? { ...s, model: a.id, quant: quantFor(b, a.id, s.quant) } : s;
    case 'quant':
      return quantOptions(b, s.model).includes(a.id) ? { ...s, quant: a.id } : s;
    case 'openRow':
      return { ...s, openRow: a.id };
    case 'basis':
      return { ...s, basisOpen: a.open };
  }
}
