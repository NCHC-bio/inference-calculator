import { type Bundle } from '@nchc/schema';
import {
  CUSTOM_PLATFORMS_MAX,
  USERS_MAX,
  defaultState,
  isRowKey,
  quantChoices,
  reduce,
  validCustomModel,
  validOverride,
  validPlatform,
  validSpeed,
  validWorkload,
  type CalcState,
  type Override,
} from './state';

/**
 * Query string of the shareable inputs (design §7): `n w m q s lang` as before, `o=rowKey:gpus[:tp],…`,
 * `x=` base64url JSON `{ hw?, wl?, sp?, mm? }` (custom hardware, workload, speed, manual model; an older link's `hfo` is ignored)
 * and `hf=owner/name@sha`.
 * The expanded row, pins and dialogs are one visit's working state and stay out.
 */
export function encodeUrl(s: CalcState): string {
  const p = new URLSearchParams({ lang: s.lang, n: String(s.users) });
  p.set('w', typeof s.workload === 'string' ? s.workload : s.workload.base);
  if (s.customModel === null) p.set('m', s.model);
  else if (s.customModel.kind === 'hf') p.set('hf', `${s.customModel.repo}@${s.customModel.sha}`);
  p.set('q', s.quant);
  if (typeof s.speed === 'string') p.set('s', s.speed);
  const x: { hw?: unknown; wl?: unknown; sp?: unknown; mm?: unknown } = {};
  if (s.customPlatforms.length > 0) x.hw = s.customPlatforms;
  if (typeof s.workload !== 'string') x.wl = s.workload;
  if (typeof s.speed !== 'string') x.sp = s.speed;
  if (s.customModel?.kind === 'manual') x.mm = s.customModel.value;
  if (Object.keys(x).length > 0) p.set('x', toBase64Url(JSON.stringify(x)));
  const o = Object.entries(s.overrides).map(([k, v]) => (v.tp === undefined ? `${k}:${v.gpus}` : `${k}:${v.gpus}:${v.tp}`));
  if (o.length > 0) p.set('o', o.join(','));
  return p.toString();
}

function toBase64Url(text: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Parsed `x=` object, or null when it is not base64url JSON of an object. */
function fromBase64Url(raw: string): Record<string, unknown> | null {
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const parseInt10 = (raw: string | null): number | null =>
  raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;

/** `rowKey:gpus[:tp]`; null when malformed. */
function parseOverride(item: string): [string, Override] | null {
  const m = /^(custom:(?:0|[1-9]\d{0,2})|[^:]+):(\d{1,9})(?::(\d{1,9}))?$/.exec(item);
  if (!m) return null;
  const v: Override = m[3] === undefined ? { gpus: Number(m[2]) } : { gpus: Number(m[2]), tp: Number(m[3]) };
  return validOverride(v) ? [m[1]!, v] : null;
}

/**
 * Starts from defaults and applies each valid field through the reducer; invalid ones keep their default, and each
 * custom entry is checked with core's schema and dropped when it fails. Never throws.
 */
export function decodeUrl(b: Bundle, search: string): CalcState {
  let s = defaultState(b);
  const p = new URLSearchParams(search);
  const rawX = p.get('x');
  const x: Record<string, unknown> = (rawX !== null ? fromBase64Url(rawX) : null) ?? {};

  const lang = p.get('lang');
  if (lang === 'en' || lang === 'zh-TW') s = reduce(b, s, { type: 'lang', lang });
  // Custom platforms first: `o=custom:i:…` is checked against them.
  if (Array.isArray(x.hw)) {
    for (const hw of x.hw.slice(0, CUSTOM_PLATFORMS_MAX)) {
      if (validPlatform(hw)) s = reduce(b, s, { type: 'addPlatform', value: hw });
    }
  }
  const n = parseInt10(p.get('n'));
  if (n !== null && n <= USERS_MAX) s = reduce(b, s, { type: 'users', value: n });

  const w = p.get('w');
  if (validWorkload(b, x.wl)) s = reduce(b, s, { type: 'workloadCustom', value: x.wl });
  else if (w !== null) s = reduce(b, s, { type: 'workload', id: w });

  const m = p.get('m');
  const hf = /^(.+)@([^@]+)$/.exec(p.get('hf') ?? '');
  const hfModel = hf ? { kind: 'hf' as const, repo: hf[1]!, sha: hf[2]! } : null;
  const manual = { kind: 'manual' as const, value: x.mm };
  if (validCustomModel(manual)) s = reduce(b, s, { type: 'customModel', value: manual });
  else if (hfModel && validCustomModel(hfModel)) s = reduce(b, s, { type: 'customModel', value: hfModel });
  else if (m !== null) s = reduce(b, s, { type: 'model', id: m });

  // The model is applied above, so q is checked against the final model's options.
  const q = p.get('q');
  if (q !== null && quantChoices(b, s.model, s.customModel).includes(q)) s = reduce(b, s, { type: 'quant', id: q });

  const sp = p.get('s');
  if (validSpeed(x.sp)) s = reduce(b, s, { type: 'speedCustom', value: x.sp });
  else if (sp !== null) s = reduce(b, s, { type: 'speed', id: sp });

  // Last: every input above clears overrides.
  for (const item of (p.get('o') ?? '').split(',')) {
    const o = parseOverride(item);
    if (o && isRowKey(b, s, o[0])) s = reduce(b, s, { type: 'override', row: o[0], value: o[1] });
  }
  return s;
}
