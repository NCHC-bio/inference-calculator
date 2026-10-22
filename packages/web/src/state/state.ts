import { type Bundle, type Model, type Source } from '@nchc/schema';
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
import type { Lang, MsgKey } from '../i18n/t';

/** A bundle platform id or `custom:${i}` (index into customPlatforms). */
export type RowKey = string;
/** The card count (and optionally TP) the user set on a row, replacing the suggested amount. */
export type Override = { gpus: number; tp?: number };
export type WorkloadSel = string | { base: string; inputTokens: number; outputTokens: number; cacheHitRate: number };
export type SpeedSel = string | { minTokPerSec: number; maxTtftSec: number };
export type CustomModel =
  | null
  | { kind: 'manual'; value: ModelOverride }
  /** `imported` is absent after a URL reload until the refetch answers (Ruling W1). */
  | { kind: 'hf'; repo: string; sha: string; imported?: { model: Model; source: Source } };
/** A platform sub-label as data: catalog text, or a message key with its values (formatted in the current language). */
export type SubLabel = string | { key: MsgKey; vars: Record<string, string | number> };
/**
 * A comparison line (design v9 §3.3): only what it overrides; every field left out follows the sentence, and `gpus`
 * left out follows the row's current count. `id` is stable; `slot` (0–4) picks the line's colour and letter A–E and is
 * kept when other lines are removed.
 */
export type CompareSpec = { row: RowKey; model?: string; quant?: string; workload?: string; inputTokens?: number; gpus?: number };
export type CompareLine = CompareSpec & { id: number; slot: number };
/** Every dialog the store can open; the reducer ignores any other id, so the type is derived from this one list. */
export const DIALOGS = ['basis', 'cite', 'verify', 'accuracy', 'funnel', 'workload', 'speed', 'hf', 'manualModel', 'hardware', 'myModels'] as const;
export type DialogId = (typeof DIALOGS)[number];
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
  compare: CompareLine[];
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
  /** Undo of removePlatform: back at `index` (clamped to the end), with the row's count and open state when it had them (v8 minor 5). */
  | { type: 'restorePlatform'; index: number; value: CustomPlatformInput; override?: Override; wasOpen?: boolean; lines?: CompareLine[] }
  | { type: 'openRow'; row: RowKey | null }
  /** Add or remove the line that only names `row` (the row's 比較 checkbox). */
  | { type: 'compareToggle'; row: RowKey }
  /** Valid specs, in order, up to the free slots. */
  | { type: 'compareAdd'; lines: CompareSpec[] }
  | { type: 'compareRemove'; id: number }
  | { type: 'compareClear' }
  | { type: 'dialog'; id: DialogId | null; basisFilter?: BasisFilter; editingPlatform?: number | null; hfQuery?: string };

export const USERS_MAX = 1e7;
/** Upper bound of a row's card / machine count. */
export const COUNT_MAX = 1e5;
/** Most comparison lines (the validated categorical palette has five colours). */
export const COMPARE_MAX = 5;
/** Read lengths 「換每次讀入長度」 offers (tokens). */
export const READ_LENGTHS = [8000, 32000, 128000] as const;
const INPUT_TOKENS_MAX = 1e6;
export const CUSTOM_PLATFORMS_MAX = 8;
export const CUSTOM_MODEL_ID = 'custom';
/** Tensor-parallel sizes a replica may use within one node (spec: TP ∈ {1,2,4,8}). */
const TP_SIZES = [1, 2, 4, 8];
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
    compare: [],
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
      HF_REVISION.test(c.sha)
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

const SPEC_KEYS = new Set(['row', 'model', 'quant', 'workload', 'inputTokens', 'gpus']);

/** A comparison spec whose row exists and whose overrides are catalog ids / integers in range, with no other keys. */
export function validCompareSpec(b: Bundle, s: Pick<CalcState, 'customPlatforms'>, v: unknown): v is CompareSpec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (!Object.keys(c).every((k) => SPEC_KEYS.has(k))) return false;
  if (typeof c.row !== 'string' || !isRowKey(b, s, c.row)) return false;
  const id = (x: unknown, ids: Record<string, unknown>) => x === undefined || (typeof x === 'string' && Object.hasOwn(ids, x));
  if (!id(c.model, b.models) || !id(c.quant, b.quantization) || !id(c.workload, b.workloads)) return false;
  const int = (x: unknown, max: number) => x === undefined || isIntIn(x as number, max);
  return int(c.inputTokens, INPUT_TOKENS_MAX) && int(c.gpus, COUNT_MAX);
}

/** A line that only names its row (what the row's 比較 checkbox adds). */
export const isPlainLine = (l: CompareSpec): boolean => Object.keys(l).every((k) => k === 'row' || k === 'id' || k === 'slot');

/** Append valid specs with fresh ids in the smallest free slots; unchanged when nothing is added. */
function addLines(b: Bundle, s: CalcState, specs: CompareSpec[]): CalcState {
  const used = new Set(s.compare.map((l) => l.slot));
  const free = Array.from({ length: COMPARE_MAX }, (_, i) => i).filter((i) => !used.has(i));
  let id = s.compare.reduce((m, l) => Math.max(m, l.id), 0);
  const added = specs
    .filter((v) => validCompareSpec(b, s, v))
    .slice(0, free.length)
    .map((v, i): CompareLine => ({ ...v, id: ++id, slot: free[i]! }));
  return added.length === 0 ? s : { ...s, compare: [...s.compare, ...added] };
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

/** Re-key `custom:i` entries for a platform inserted at `at` (that index and higher shift up). */
function unshiftCustom<T>(rec: Record<RowKey, T>, at: number): Record<RowKey, T> {
  const out: Record<RowKey, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const i = customIndex(k);
    out[i !== null && i >= at ? `custom:${i + 1}` : k] = v;
  }
  return out;
}

/** Lines on removed custom platform `removed` are dropped; later custom rows shift down. */
function shiftLines(lines: CompareLine[], removed: number): CompareLine[] {
  return lines.filter((l) => customIndex(l.row) !== removed).map((l) => ({ ...l, row: shiftRow(l.row, removed)! }));
}

/**
 * Lines removed with a custom platform come back on its new row key (final review: 復原 brings the comparison back),
 * in their old slot when it is still free, else the smallest free one; fresh ids; at most COMPARE_MAX lines.
 */
function restoreLines(b: Bundle, customPlatforms: CustomPlatformInput[], lines: CompareLine[], back: CompareLine[] | undefined, row: RowKey): CompareLine[] {
  if (!Array.isArray(back)) return lines;
  const out = [...lines];
  let id = out.reduce((m, l) => Math.max(m, l.id), 0);
  for (const l of back) {
    const { id: _i, slot, ...spec } = l;
    const restored: CompareSpec = { ...spec, row };
    if (out.length >= COMPARE_MAX || !validCompareSpec(b, { customPlatforms }, restored)) continue;
    const used = new Set(out.map((x) => x.slot));
    const free = used.has(slot) ? Array.from({ length: COMPARE_MAX }, (_, i) => i).find((i) => !used.has(i))! : slot;
    out.push({ ...restored, id: ++id, slot: free });
  }
  return out;
}

/** Lines on custom rows at or after `at` shift up (a platform inserted at `at`). */
function unshiftLines(lines: CompareLine[], at: number): CompareLine[] {
  return lines.map((l) => {
    const i = customIndex(l.row);
    return i !== null && i >= at ? { ...l, row: `custom:${i + 1}` } : l;
  });
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
        compare: shiftLines(s.compare, a.index),
        editingPlatform: ep === null || ep === a.index ? null : ep > a.index ? ep - 1 : ep,
      };
    }
    case 'restorePlatform': {
      const n = s.customPlatforms.length;
      if (!Number.isInteger(a.index) || a.index < 0 || n >= CUSTOM_PLATFORMS_MAX || !validPlatform(a.value)) return s;
      // The list may have shrunk since the delete: past its end, the platform goes last (fix round C).
      const at = Math.min(a.index, n);
      const key = `custom:${at}`;
      const overrides = unshiftCustom(s.overrides, at);
      if (a.override !== undefined && validOverride(a.override)) overrides[key] = a.override;
      const i = s.openRow === null ? null : customIndex(s.openRow);
      const openRow = a.wasOpen ? key : i !== null && i >= at ? `custom:${i + 1}` : s.openRow;
      const ep = s.editingPlatform;
      const customPlatforms = [...s.customPlatforms.slice(0, at), a.value, ...s.customPlatforms.slice(at)];
      return {
        ...s,
        customPlatforms,
        overrides,
        openRow,
        compare: restoreLines(b, customPlatforms, unshiftLines(s.compare, at), a.lines, key),
        editingPlatform: ep !== null && ep >= at ? ep + 1 : ep,
      };
    }
    case 'openRow':
      return { ...s, openRow: a.row };
    case 'compareToggle': {
      const plain = s.compare.find((l) => l.row === a.row && isPlainLine(l));
      return plain ? { ...s, compare: s.compare.filter((l) => l !== plain) } : addLines(b, s, [{ row: a.row }]);
    }
    case 'compareAdd':
      return Array.isArray(a.lines) ? addLines(b, s, a.lines) : s;
    case 'compareRemove':
      return { ...s, compare: s.compare.filter((l) => l.id !== a.id) };
    case 'compareClear':
      return { ...s, compare: [] };
    case 'dialog': {
      if (a.id !== null && !(DIALOGS as readonly string[]).includes(a.id)) return s;
      const basisFilter = a.basisFilter === 'est' || a.basisFilter === 'all' ? a.basisFilter : s.basisFilter;
      const editingPlatform = a.editingPlatform !== undefined ? a.editingPlatform : a.id === null ? null : s.editingPlatform;
      const hfQuery = a.id === 'hf' ? (typeof a.hfQuery === 'string' ? a.hfQuery.trim() : s.hfQuery) : '';
      return { ...s, dialog: a.id, basisFilter, editingPlatform, hfQuery };
    }
  }
}
