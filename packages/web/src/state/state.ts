import { OriginSchema, type Bundle, type Model, type Origin, type Source } from '@nchc/schema';
import {
  CustomPlatformInputSchema,
  ModelOverrideSchema,
  QueryInputSchema,
  quantOptions,
  quantOptionsFor,
  resolveModel,
  type CustomPlatformInput,
  type ModelOverride,
} from '@nchc/core';
import type { Lang } from '../i18n/t';

/** A bundle platform id or `custom:${i}` (index into customPlatforms). */
export type RowKey = string;
/** The card count (and optionally TP) the user set on a row, replacing the suggested amount. */
export type Override = { gpus: number; tp?: number };
export type WorkloadSel = string | { base: string; inputTokens: number; outputTokens: number; cacheHitRate: number };
export type SpeedSel = string | { minTokPerSec: number; maxTtftSec: number };
export type CustomModel =
  | null
  | { kind: 'manual'; value: ModelOverride }
  /**
   * `origin`: the publisher the user confirmed on import (spec §8.3.2), kept so a URL reload can refetch (Ruling W1).
   * `imported` is absent after a URL reload until the refetch answers.
   */
  | { kind: 'hf'; repo: string; sha: string; origin?: Origin; imported?: { model: Model; source: Source } };
export type Pin = {
  id: number;
  platform: string;
  count: string;
  model: string;
  users: number;
  tps: number | null;
  ttft: number | null;
  max: number;
  kw: number | null;
};
export type DialogId = 'basis' | 'cite' | 'verify' | 'accuracy' | 'funnel' | 'workload' | 'speed' | 'hf' | 'manualModel' | 'hardware';
export type BasisFilter = 'est' | 'all';
export type CalcState = {
  lang: Lang;
  /** Peak concurrent users, integer 1..1e7. */
  users: number;
  workload: WorkloadSel;
  /** Catalog model id, or `'custom'` while customModel is set. */
  model: string;
  quant: string;
  speed: SpeedSel;
  customModel: CustomModel;
  customPlatforms: CustomPlatformInput[];
  overrides: Record<RowKey, Override>;
  /** Row key of the expanded row. */
  openRow: RowKey | null;
  pins: Pin[];
  dialog: DialogId | null;
  basisFilter: BasisFilter;
  /** customPlatforms index the hardware dialog edits (null: adding a new one). */
  editingPlatform: number | null;
  /**
   * Repo the HF import dialog starts with: the model search text when it looks like `owner/name` (the not-found
   * 「匯入 owner/name」 button), else ''. Set by `dialog` with `hfQuery`; reset to '' when another dialog opens.
   */
  hfQuery: string;
};
export type Action =
  | { type: 'lang'; lang: Lang }
  | { type: 'users'; value: number | null }
  | { type: 'workload'; id: string }
  | { type: 'workloadCustom'; value: Exclude<WorkloadSel, string> }
  | { type: 'model'; id: string }
  | { type: 'customModel'; value: CustomModel }
  | { type: 'quant'; id: string }
  | { type: 'speed'; id: string }
  | { type: 'speedCustom'; value: Exclude<SpeedSel, string> }
  | { type: 'override'; row: RowKey; value: Override | null }
  | { type: 'addPlatform'; value: CustomPlatformInput }
  | { type: 'editPlatform'; index: number; value: CustomPlatformInput }
  | { type: 'removePlatform'; index: number }
  | { type: 'openRow'; row: RowKey | null }
  | { type: 'pin'; pin: Omit<Pin, 'id'> }
  | { type: 'unpin'; id: number }
  | { type: 'clearPins' }
  | { type: 'dialog'; id: DialogId | null; basisFilter?: BasisFilter; editingPlatform?: number | null; hfQuery?: string };

export const USERS_MAX = 1e7;
/** Upper bound of a row's card / machine count. */
export const COUNT_MAX = 1e5;
export const PINS_MAX = 3;
export const CUSTOM_PLATFORMS_MAX = 8;
export const CUSTOM_MODEL_ID = 'custom';
/** Tensor-parallel sizes a replica may use within one node (spec: TP ∈ {1,2,4,8}). */
const TP_SIZES = [1, 2, 4, 8];
const DIALOGS: readonly DialogId[] = ['basis', 'cite', 'verify', 'accuracy', 'funnel', 'workload', 'speed', 'hf', 'manualModel', 'hardware'];
const HF_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const HF_REVISION = /^[\w.-]{1,100}$/;

/** UI default selections (ids, not figures). Each falls back to the first bundle id when absent. */
export const DEFAULTS = {
  lang: 'zh-TW' as Lang,
  users: 15,
  workload: 'assist',
  model: 'llama-3.3-70b-instruct-fp8',
  speed: 'smooth',
};

const isIntIn = (v: number | null | undefined, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

export const platformIds = (b: Bundle): string[] => Object.keys(b.platforms);
export const workloadIds = (b: Bundle): string[] => Object.keys(b.workloads);
export const modelIds = (b: Bundle): string[] => Object.keys(b.models);
export const speedIds = (b: Bundle): string[] => Object.keys(b.speedPresets);

/** Preset id behind a workload selection (the custom workload's base). */
export const workloadId = (w: WorkloadSel): string => (typeof w === 'string' ? w : w.base);

const pick = (ids: string[], want: string): string => (ids.includes(want) ? want : ids[0]!);

export function defaultState(b: Bundle): CalcState {
  const model = pick(modelIds(b), DEFAULTS.model);
  return {
    lang: DEFAULTS.lang,
    users: DEFAULTS.users,
    workload: pick(workloadIds(b), DEFAULTS.workload),
    model,
    quant: quantOptions(b, model)[0]!,
    speed: pick(speedIds(b), DEFAULTS.speed),
    customModel: null,
    customPlatforms: [],
    overrides: {},
    openRow: null,
    pins: [],
    dialog: null,
    basisFilter: 'est',
    editingPlatform: null,
    hfQuery: '',
  };
}

/**
 * Quantizations offered for the current model, by core's rule (quantOptions / quantOptionsFor). An HF model not yet
 * re-imported (URL reload) is unknown: every bundle quantization is accepted until it is fetched.
 */
export function quantChoices(b: Bundle, model: string, custom: CustomModel): string[] {
  if (custom === null) return quantOptions(b, model);
  if (custom.kind === 'manual') return quantOptionsFor(b, resolveModel(b, custom.value).model);
  return custom.imported ? quantOptionsFor(b, custom.imported.model) : Object.keys(b.quantization);
}

const keepQuant = (opts: string[], current: string): string => (opts.includes(current) ? current : opts[0]!);

/** Quant carried to a new catalog model: kept when offered, else the model's first option. */
export function quantFor(b: Bundle, model: string, current: string): string {
  return keepQuant(quantOptions(b, model), current);
}

const WorkloadSchema = QueryInputSchema.shape.workload;
const SpeedSchema = QueryInputSchema.shape.speed;

export function validWorkload(b: Bundle, v: unknown): v is Exclude<WorkloadSel, string> {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Record<string, unknown>;
  const complete = ['inputTokens', 'outputTokens', 'cacheHitRate'].every((k) => typeof w[k] === 'number');
  return complete && WorkloadSchema.safeParse(v).success && typeof w.base === 'string' && Object.hasOwn(b.workloads, w.base);
}

export function validSpeed(v: unknown): v is Exclude<SpeedSel, string> {
  return typeof v === 'object' && v !== null && SpeedSchema.safeParse(v).success;
}

export const validPlatform = (v: unknown): v is CustomPlatformInput => CustomPlatformInputSchema.safeParse(v).success;

export function validCustomModel(v: unknown): v is Exclude<CustomModel, null> {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (c.kind === 'manual') return typeof c.value === 'object' && ModelOverrideSchema.safeParse(c.value).success;
  if (c.kind === 'hf') {
    return (
      typeof c.repo === 'string' &&
      HF_REPO.test(c.repo) &&
      typeof c.sha === 'string' &&
      HF_REVISION.test(c.sha) &&
      (c.origin === undefined || OriginSchema.safeParse(c.origin).success)
    );
  }
  return false;
}

export const customIndex = (row: RowKey): number | null => {
  // Canonical index only (`custom:01` is not a row key).
  const m = /^custom:(0|[1-9]\d*)$/.exec(row);
  return m ? Number(m[1]) : null;
};

export function isRowKey(b: Bundle, s: Pick<CalcState, 'customPlatforms'>, row: RowKey): boolean {
  const i = customIndex(row);
  return i === null ? Object.hasOwn(b.platforms, row) : i < s.customPlatforms.length;
}

export function validOverride(v: unknown): v is Override {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isIntIn(o.gpus as number, COUNT_MAX) && (o.tp === undefined || TP_SIZES.includes(o.tp as number));
}

/** Any input change makes the per-row card counts stale: they are cleared. */
const input = (s: CalcState, patch: Partial<CalcState>): CalcState => ({ ...s, ...patch, overrides: {} });

/** Re-key `custom:i` entries after removing custom platform `removed` (higher indices shift down). */
function shiftCustom<T>(rec: Record<RowKey, T>, removed: number): Record<RowKey, T> {
  const out: Record<RowKey, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const i = customIndex(k);
    if (i === removed) continue;
    out[i !== null && i > removed ? `custom:${i - 1}` : k] = v;
  }
  return out;
}

function shiftRow(row: RowKey | null, removed: number): RowKey | null {
  const i = row === null ? null : customIndex(row);
  if (i === null) return row;
  if (i === removed) return null;
  return i > removed ? `custom:${i - 1}` : row;
}

export function reduce(b: Bundle, s: CalcState, a: Action): CalcState {
  switch (a.type) {
    case 'lang':
      return a.lang === 'en' || a.lang === 'zh-TW' ? { ...s, lang: a.lang } : s;
    case 'users':
      return isIntIn(a.value, USERS_MAX) ? input(s, { users: a.value }) : s;
    case 'workload':
      return workloadIds(b).includes(a.id) ? input(s, { workload: a.id }) : s;
    case 'workloadCustom':
      return validWorkload(b, a.value) ? input(s, { workload: { ...a.value } }) : s;
    case 'speed':
      return speedIds(b).includes(a.id) ? input(s, { speed: a.id }) : s;
    case 'speedCustom':
      return validSpeed(a.value) ? input(s, { speed: { ...a.value } }) : s;
    case 'model':
      return modelIds(b).includes(a.id)
        ? input(s, { model: a.id, customModel: null, quant: quantFor(b, a.id, s.quant) })
        : s;
    case 'customModel': {
      if (a.value === null) {
        if (s.customModel === null) return s;
        const model = pick(modelIds(b), DEFAULTS.model);
        return input(s, { model, customModel: null, quant: quantFor(b, model, s.quant) });
      }
      if (!validCustomModel(a.value)) return s;
      const quant = keepQuant(quantChoices(b, CUSTOM_MODEL_ID, a.value), s.quant);
      // Filling in `imported` for the same pending repo@sha (the URL refetch, Ruling W1) is hydration, not an input
      // change: a shared link keeps its card counts unless the precision had to change.
      const c = s.customModel;
      const hydrate =
        c?.kind === 'hf' && !c.imported && a.value.kind === 'hf' && a.value.imported !== undefined &&
        a.value.repo === c.repo && a.value.sha === c.sha && quant === s.quant;
      if (hydrate) return { ...s, model: CUSTOM_MODEL_ID, customModel: a.value, quant };
      return input(s, { model: CUSTOM_MODEL_ID, customModel: a.value, quant });
    }
    case 'quant':
      return quantChoices(b, s.model, s.customModel).includes(a.id) ? input(s, { quant: a.id }) : s;
    case 'override': {
      if (!isRowKey(b, s, a.row)) return s;
      if (a.value === null) {
        if (!Object.hasOwn(s.overrides, a.row)) return s;
        const { [a.row]: _drop, ...rest } = s.overrides;
        return { ...s, overrides: rest };
      }
      if (!validOverride(a.value)) return s;
      const value: Override = a.value.tp === undefined ? { gpus: a.value.gpus } : { gpus: a.value.gpus, tp: a.value.tp };
      return { ...s, overrides: { ...s.overrides, [a.row]: value } };
    }
    case 'addPlatform':
      return s.customPlatforms.length < CUSTOM_PLATFORMS_MAX && validPlatform(a.value)
        ? { ...s, customPlatforms: [...s.customPlatforms, a.value] }
        : s;
    case 'editPlatform': {
      if (!Number.isInteger(a.index) || a.index < 0 || a.index >= s.customPlatforms.length || !validPlatform(a.value)) return s;
      // The row's set count may not be legal on the edited hardware (node size, TP): it is dropped.
      const { [`custom:${a.index}`]: _drop, ...overrides } = s.overrides;
      return { ...s, customPlatforms: s.customPlatforms.map((p, i) => (i === a.index ? a.value : p)), overrides };
    }
    case 'removePlatform': {
      if (!Number.isInteger(a.index) || a.index < 0 || a.index >= s.customPlatforms.length) return s;
      const ep = s.editingPlatform;
      return {
        ...s,
        customPlatforms: s.customPlatforms.filter((_, i) => i !== a.index),
        overrides: shiftCustom(s.overrides, a.index),
        openRow: shiftRow(s.openRow, a.index),
        editingPlatform: ep === null || ep === a.index ? null : ep > a.index ? ep - 1 : ep,
      };
    }
    case 'openRow':
      return { ...s, openRow: a.row };
    case 'pin': {
      if (s.pins.length >= PINS_MAX) return s;
      const id = s.pins.reduce((m, p) => Math.max(m, p.id), 0) + 1;
      return { ...s, pins: [...s.pins, { ...a.pin, id }] };
    }
    case 'unpin':
      return { ...s, pins: s.pins.filter((p) => p.id !== a.id) };
    case 'clearPins':
      return { ...s, pins: [] };
    case 'dialog': {
      if (a.id !== null && !DIALOGS.includes(a.id)) return s;
      const basisFilter = a.basisFilter === 'est' || a.basisFilter === 'all' ? a.basisFilter : s.basisFilter;
      const editingPlatform = a.editingPlatform !== undefined ? a.editingPlatform : a.id === null ? null : s.editingPlatform;
      const hfQuery = a.id === 'hf' ? (typeof a.hfQuery === 'string' ? a.hfQuery.trim() : s.hfQuery) : '';
      return { ...s, dialog: a.id, basisFilter, editingPlatform, hfQuery };
    }
  }
}
