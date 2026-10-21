import type { Bundle } from '@nchc/schema';
import { CoreInputError, resolveModel, type PerformanceResult } from '@nchc/core';
import type { MsgKey } from '../i18n';
import { quantChoices, reduce, type Action, type CalcState, type Override } from '../state/state';
import type { OkRow } from './compute';
import { platformOf, queryOf, rowPerf } from './query';

/**
 * A one-click change offered in the workbench. `vars` carry raw numbers (tok/s, users, B params): the component formats
 * them before interpolating `label`. `apply` is dispatched in order.
 */
export type SuggestedAction = {
  key: 'quant' | 'speed' | 'users' | 'model' | 'reset' | 'moreUsers' | 'biggerModel';
  label: MsgKey;
  vars: Record<string, string | number>;
  apply: Action[];
};

/** Total parameters of the current model (bundle / user-entered config value, used only for ordering). */
function currentParamsB(b: Bundle, s: CalcState): number {
  if (s.customModel === null) return b.models[s.model]!.totalParamsB.value;
  return resolveModel(b, queryOf(b, s).model).model.totalParamsB.value;
}

/** The current speed target's figures (preset or custom). */
function speedTarget(b: Bundle, s: CalcState): { min: number; ttft: number } {
  if (typeof s.speed !== 'string') return { min: s.speed.minTokPerSec, ttft: s.speed.maxTtftSec };
  const p = b.speedPresets[s.speed]!;
  return { min: p.minTokensPerSec.value, ttft: p.maxTtftSec.value };
}

/**
 * Suggested changes for an adjusted row, each checked with core: applying `apply` to the state makes the row pass at the
 * same count. Below the target: a lower-bit quant, a looser speed preset, fewer users, a smaller catalog model, back to
 * the suggested count. Above the suggested count and on target: more users, the largest catalog model that still runs.
 * At the suggested count (not adjusted): none.
 */
export function suggestActions(b: Bundle, s: CalcState, row: OkRow): SuggestedAction[] {
  if (!row.adjusted) return [];
  const { perf } = row;
  const o: Override | undefined = s.overrides[row.row];
  const keepCount: Action = { type: 'override', row: row.row, value: { gpus: row.count } };
  const keepShape: Action = { type: 'override', row: row.row, value: o ?? { gpus: row.count } };
  const passes = (apply: Action[]): PerformanceResult | null => {
    const next = apply.reduce((x, a) => reduce(b, x, a), s);
    const set = next.overrides[row.row];
    if (!set) return null;
    try {
      const p = rowPerf(b, next, row.row, set);
      return p.ok ? p : null;
    } catch (e) {
      if (e instanceof CoreInputError) return null;
      throw e;
    }
  };
  const cur = currentParamsB(b, s);
  const byParams = (pred: (p: number) => boolean) =>
    Object.keys(b.models)
      .filter((id) => pred(b.models[id]!.totalParamsB.value))
      .sort((x, y) => b.models[y]!.totalParamsB.value - b.models[x]!.totalParamsB.value);
  const out: SuggestedAction[] = [];

  if (!perf.ok) {
    const bytes = b.quantization[s.quant]!.bytesPerParam.value;
    const offered = new Set(quantChoices(b, s.model, s.customModel));
    for (const id of Object.keys(b.quantization)) {
      if (!offered.has(id) || b.quantization[id]!.bytesPerParam.value >= bytes) continue;
      const apply: Action[] = [{ type: 'quant', id }, keepCount];
      const p = passes(apply);
      if (p?.usage) {
        out.push({ key: 'quant', label: 'action.quant', vars: { name: b.quantization[id]!.name, tps: p.usage.tokPerSecPerUser }, apply });
        break;
      }
    }

    const t = speedTarget(b, s);
    for (const [id, p] of Object.entries(b.speedPresets)) {
      const min = p.minTokensPerSec.value;
      const ttft = p.maxTtftSec.value;
      if (id === s.speed || min > t.min || ttft < t.ttft || (min === t.min && ttft === t.ttft)) continue;
      const apply: Action[] = [{ type: 'speed', id }, keepCount];
      if (passes(apply)) {
        out.push({ key: 'speed', label: 'action.speed', vars: { name: p.name }, apply });
        break;
      }
    }

    if (perf.maxConcurrent > 0) {
      const apply: Action[] = [{ type: 'users', value: perf.maxConcurrent }, keepShape];
      if (passes(apply)) out.push({ key: 'users', label: 'action.users', vars: { n: perf.maxConcurrent }, apply });
    }

    for (const id of byParams((p) => p < cur)) {
      const apply: Action[] = [{ type: 'model', id }, keepCount];
      if (passes(apply)) {
        out.push({ key: 'model', label: 'action.model', vars: { name: b.models[id]!.name }, apply });
        break;
      }
    }

    const p = platformOf(b, s, row.row);
    const unit = typeof p === 'string' ? b.platforms[p]!.unit : p.unit;
    out.push({
      key: 'reset',
      label: unit === 'machine' ? 'action.reset.machine' : 'action.reset.gpu',
      vars: { n: row.suggested },
      apply: [{ type: 'override', row: row.row, value: null }],
    });
  } else if (row.count > row.suggested) {
    if (perf.maxConcurrent > s.users) {
      const apply: Action[] = [{ type: 'users', value: perf.maxConcurrent }, keepShape];
      if (passes(apply)) out.push({ key: 'moreUsers', label: 'action.moreUsers', vars: { n: perf.maxConcurrent - s.users }, apply });
    }
    for (const id of byParams((p) => p > cur)) {
      const apply: Action[] = [{ type: 'model', id }, keepCount];
      if (passes(apply)) {
        const m = b.models[id]!;
        out.push({ key: 'biggerModel', label: 'action.biggerModel', vars: { name: m.name, params: m.totalParamsB.value }, apply });
        break;
      }
    }
  }
  return out;
}
