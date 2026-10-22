import type { Bundle } from '@nchc/schema';
import {
  CoreInputError,
  activeParamsB,
  estimatePerformance,
  estimatePerformanceSweep,
  quantOptions,
  resolveModel,
  type PerformanceInput,
  type PerformanceResult,
  type ResultWarning,
} from '@nchc/core';
import { READ_LENGTHS, quantChoices, quantFor, workloadId, type CalcState, type CompareLine, type CompareSpec, type RowKey } from '../state/state';
import type { MainView } from './compute';
import { performanceQueryOf, queryOf } from './query';
import { rowInfo, type RowInfo } from './rowInfo';

export type LineStatus = 'ok' | 'fail' | 'nofit';

/** One comparison line resolved against the sentence and the rows (design v9 §3.3), with core's numbers. */
export type LineView = {
  line: CompareLine;
  info: RowInfo;
  /** GPUs (machines) used: the line's own, else the row's current count; an infeasible row → one node / one machine. */
  count: number;
  modelName: string;
  quant: string;
  quantName: string;
  workloadName: string;
  inputTokens: number;
  /** Fields this line overrides (shown in bold). */
  changed: { model: boolean; quant: boolean; workload: boolean; inputTokens: boolean; gpus: boolean };
  /** Total parameters; activeB only for MoE models. */
  params: { totalB: number; activeB: number | null };
  /** Null when core rejected the query (CoreInputError, see `error`). */
  perf: PerformanceResult | null;
  error: string | null;
  status: LineStatus;
  /** Core's speed curve at the shared users, up to the first point where memory runs out; [] when nothing fits. */
  users: { x: number; tps: number; ttft: number }[];
  /** GPU lines only: speed at the current users for 1 … cardsMax GPUs, counts that serve them; null otherwise. */
  sweep: { x: number; tps: number }[] | null;
};

export type CompareView = {
  lines: LineView[];
  /** End of the shared users axis. */
  usersMax: number;
  /** Users every line is sampled at (log-spaced, increasing, includes 1, the current users and usersMax). */
  curveUsers: number[];
  /** End of the GPU-count axis. */
  cardsMax: number;
  /** The GPU chart shows when GPU lines that fit use at least two different (row, count) setups. */
  showCards: boolean;
  /** Lines missing the target on per-user speed (bw / compute) and on time to first token. */
  hot: { tps: number; ttft: number };
  warnings: ResultWarning[];
};

const USERS_AXIS_MAX = 1e6;
const CURVE_POINTS = 40;
const SWEEP_MAX = 64;
/** Points past these do not hold the users' context: the line ends there. */
const MEMORY_WHYS = new Set(['mem', 'context', 'weights']);

type Resolved = { input: Omit<PerformanceInput, 'curveUsers'>; v: Omit<LineView, 'perf' | 'error' | 'status' | 'users' | 'sweep'> };

/** The row's current count; for an infeasible row one node (GPU) or one machine, so the comparison can show why. */
function rowCount(main: Extract<MainView, { kind: 'main' }>, info: RowInfo, row: RowKey): number {
  const r = main.rows.find((x) => x.row === row);
  if (r?.kind === 'ok') return r.count;
  return info.unit === 'machine' ? 1 : info.gpusPerNode;
}

/** The quantizations the line's model offers (catalog model, or the sentence's model with its custom one). */
function quantsOf(b: Bundle, s: CalcState, line: CompareSpec): string[] {
  return line.model !== undefined ? quantOptions(b, line.model) : quantChoices(b, s.model, s.customModel);
}

function resolveLine(b: Bundle, s: CalcState, main: Extract<MainView, { kind: 'main' }>, line: CompareLine): Resolved {
  const info = rowInfo(b, s, line.row);
  const count = line.gpus ?? rowCount(main, info, line.row);
  const offered = quantsOf(b, s, line);
  const quant =
    line.quant !== undefined && offered.includes(line.quant) ? line.quant : line.model !== undefined ? quantFor(b, line.model, s.quant) : s.quant;
  const sel = line.workload ?? s.workload;
  const preset = b.workloads[workloadId(sel)]!;
  const baseTokens = typeof sel === 'string' ? preset.inputTokens.value : sel.inputTokens;
  const workload = line.inputTokens === undefined ? sel : { ...(typeof sel === 'string' ? { base: sel } : sel), inputTokens: line.inputTokens };
  const q = performanceQueryOf(b, s, line.row, count);
  const model = line.model ?? queryOf(b, s).model;
  const resolved = resolveModel(b, model).model;
  return {
    input: { ...q, model, quant, workload },
    v: {
      line,
      info,
      count,
      modelName: resolved.name,
      quant,
      quantName: b.quantization[quant]?.name ?? quant,
      workloadName: preset.name,
      inputTokens: line.inputTokens ?? baseTokens,
      changed: {
        model: line.model !== undefined,
        quant: line.quant !== undefined,
        workload: line.workload !== undefined,
        inputTokens: line.inputTokens !== undefined,
        gpus: line.gpus !== undefined,
      },
      params: { totalB: resolved.totalParamsB.value, activeB: resolved.moe ? activeParamsB(resolved) : null },
    },
  };
}

/** estimatePerformance, with a CoreInputError turned into an error message (anything else is a bug: rethrown). */
function tryPerf(b: Bundle, input: PerformanceInput): { perf: PerformanceResult | null; error: string | null } {
  try {
    return { perf: estimatePerformance(b, input), error: null };
  } catch (e) {
    if (e instanceof CoreInputError) return { perf: null, error: e.message };
    throw e;
  }
}

/** Up to CURVE_POINTS log-spaced integers in [1, max], with `users` added; increasing, deduplicated. */
export function logUsers(max: number, users: number): number[] {
  const set = new Set<number>([1, max]);
  if (users <= max) set.add(users);
  for (let i = 1; i < CURVE_POINTS - 1; i++) set.add(Math.round(Math.pow(max, i / (CURVE_POINTS - 1))));
  return [...set].filter((u) => u >= 1 && u <= max).sort((a, c) => a - c);
}

/**
 * Comparison view (design v9 §4): every line through core at its count, then once more with the shared `curveUsers`
 * (the axis depends on every line's capacity); GPU lines get a sweep for the GPUs → speed chart. Null when the sentence
 * has no result or there are no lines.
 */
export function computeCompare(b: Bundle, s: CalcState, main: MainView): CompareView | null {
  if (main.kind !== 'main' || s.compare.length === 0) return null;
  const resolved = s.compare.map((l) => resolveLine(b, s, main, l));
  const first = resolved.map((r) => tryPerf(b, r.input));
  const caps = first.map((f) => f.perf?.maxConcurrent ?? 0);
  const usersMax = Math.min(USERS_AXIS_MAX, Math.ceil(Math.max(10, s.users * 3, ...caps.map((c) => c * 1.6))));
  const curveUsers = logUsers(usersMax, s.users);

  const gpuCounts = resolved.filter((r) => r.v.info.unit === 'gpu').map((r) => r.v.count);
  const cardsMax = Math.min(SWEEP_MAX, Math.max(8, ...gpuCounts.map((c) => c * 2)));

  const lines = resolved.map((r, i): LineView => {
    const { perf: base, error } = first[i]!;
    const status = !base ? 'nofit' : base.ok ? 'ok' : base.usage ? 'fail' : 'nofit';
    let users: LineView['users'] = [];
    let sweep: LineView['sweep'] = null;
    if (base?.usage) {
      const curve = tryPerf(b, { ...r.input, curveUsers }).perf?.speedCurve?.points ?? [];
      const end = curve.findIndex((p) => p.why !== null && MEMORY_WHYS.has(p.why));
      users = (end < 0 ? curve : curve.slice(0, end)).map((p) => ({ x: p.users, tps: p.tokPerSecPerUser, ttft: p.ttftSec }));
      if (r.v.info.unit === 'gpu') {
        const { gpus: _g, tp: _t, ...q } = r.input;
        const pts = estimatePerformanceSweep(b, { ...q, gpusList: Array.from({ length: cardsMax }, (_, k) => k + 1) }).points;
        sweep = pts.flatMap((p) => {
          if (p.fastest) return [{ x: p.gpus, tps: p.fastest.tokPerSecPerUser }];
          return p.tokPerSecPerUser !== null && p.why !== 'mem' ? [{ x: p.gpus, tps: p.tokPerSecPerUser }] : [];
        });
      }
    }
    return { ...r.v, perf: base, error, status, users, sweep };
  });

  const fitting = lines.filter((l) => l.sweep !== null && l.sweep.length > 0);
  const showCards = new Set(fitting.map((l) => `${l.line.row}:${l.count}`)).size >= 2;
  const whys = lines.map((l) => l.perf?.why ?? null);
  const warnings = [...new Map(lines.flatMap((l) => l.perf?.warnings ?? []).map((w) => [w.code, w])).values()];
  return {
    lines,
    usersMax,
    curveUsers,
    cardsMax,
    showCards,
    hot: { tps: whys.filter((w) => w === 'bw' || w === 'compute').length, ttft: whys.filter((w) => w === 'ttft').length },
    warnings,
  };
}

export type VariantLabel =
  | { kind: 'model'; id: string; name: string; totalB: number; activeB: number | null }
  | { kind: 'quant'; id: string; all?: boolean }
  | { kind: 'workload'; id: string }
  | { kind: 'read'; tokens: number }
  | { kind: 'gpus'; n: number; half: boolean }
  | { kind: 'platform'; row: RowKey; count: number };
export type VariantGroup = {
  key: 'model' | 'quant' | 'workload' | 'read' | 'gpus' | 'platform';
  items: { key: string; label: VariantLabel; specs: CompareSpec[] }[];
};

/** The line's spec without id / slot and without unset fields. */
function specOf(l: CompareLine): CompareSpec {
  const { id: _i, slot: _s, ...rest } = l;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as CompareSpec;
}

/**
 * 「換一項比較」 (design v9 §3.2): each item is the specs it adds. Model / quant / workload / read variants copy the line
 * at its current count (same hardware, same cards); count variants change only gpus; platform variants keep the line's
 * model, quant, workload and read length and follow the new row's count. Groups with no item are left out.
 */
export function variantGroups(b: Bundle, s: CalcState, main: MainView, v: LineView): VariantGroup[] {
  if (main.kind !== 'main') return [];
  const src = specOf(v.line);
  const atCount = (patch: Partial<CompareSpec>): CompareSpec => ({ ...src, ...patch, gpus: v.count });
  const currentModel = v.line.model ?? (s.customModel === null ? s.model : null);
  const groups: VariantGroup[] = [];

  groups.push({
    key: 'model',
    items: Object.values(b.models)
      .filter((m) => m.id !== currentModel)
      .map((m) => {
        // The line's own quant is kept when the new model offers it; otherwise the model's default applies.
        const { quant, ...rest } = src;
        const keep = quant !== undefined && quantOptions(b, m.id).includes(quant) ? { quant } : {};
        return {
          key: `model:${m.id}`,
          label: { kind: 'model', id: m.id, name: m.name, totalB: m.totalParamsB.value, activeB: m.moe ? activeParamsB(m) : null },
          specs: [{ ...rest, ...keep, model: m.id, gpus: v.count }],
        };
      }),
  });

  const otherQuants = quantsOf(b, s, v.line).filter((q) => q !== v.quant);
  const quantItems: VariantGroup['items'] = otherQuants.map((q) => ({ key: `quant:${q}`, label: { kind: 'quant', id: q }, specs: [atCount({ quant: q })] }));
  if (otherQuants.length >= 2) {
    quantItems.push({ key: 'quant:*', label: { kind: 'quant', id: '*', all: true }, specs: otherQuants.map((q) => atCount({ quant: q })) });
  }
  groups.push({ key: 'quant', items: quantItems });

  const current = workloadId(v.line.workload ?? s.workload);
  groups.push({
    key: 'workload',
    items: Object.keys(b.workloads)
      .filter((id) => id !== current)
      .map((id) => {
        const { inputTokens: _i, ...rest } = src;
        return { key: `workload:${id}`, label: { kind: 'workload', id }, specs: [{ ...rest, workload: id, gpus: v.count }] };
      }),
  });

  groups.push({
    key: 'read',
    items: READ_LENGTHS.filter((n) => n !== v.inputTokens).map((n) => ({ key: `read:${n}`, label: { kind: 'read', tokens: n }, specs: [atCount({ inputTokens: n })] })),
  });

  const step = v.info.unit === 'gpu' ? v.info.gpusPerNode : 1;
  const half = Math.max(1, Math.floor(v.count / 2));
  const counts = [...new Set([half, v.count + step, v.count * 2])].filter((n) => n !== v.count);
  groups.push({
    key: 'gpus',
    items: counts.map((n) => ({ key: `gpus:${n}`, label: { kind: 'gpus', n, half: n < v.count }, specs: [{ ...src, gpus: n }] })),
  });

  groups.push({
    key: 'platform',
    items: main.rows
      .filter((r) => r.row !== v.line.row)
      .map((r) => {
        const { gpus: _g, ...rest } = src;
        const info = rowInfo(b, s, r.row);
        return { key: `platform:${r.row}`, label: { kind: 'platform', row: r.row, count: rowCount(main, info, r.row) }, specs: [{ ...rest, row: r.row }] };
      }),
  });

  return groups.filter((g) => g.items.length > 0);
}
