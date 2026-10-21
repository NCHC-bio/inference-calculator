import type { BasisItem, RequirementResult } from '@nchc/core';
import type { Bundle, Source } from '@nchc/schema';
import type { TFn } from '../i18n/t';
import type { CalcState, CustomModel } from '../state/state';
import { fmt } from './answerText';
import { topEstimates, uniqueByPath } from './weak';

// React-free: the citation text and the source lookup are plain functions of bundle, state and result.

/** Source lookup for basis items: the bundle's sources plus the imported HF model's own source (when there is one). */
export function sourcesOf(b: Bundle, custom: CustomModel): Record<string, Source> {
  if (custom?.kind === 'hf' && custom.imported) {
    const src = custom.imported.source;
    return { ...b.sources, [src.id]: src };
  }
  return b.sources;
}

/** Titles of the known sources an item cites, joined; empty when none resolves. */
export function sourceTitles(item: BasisItem, sources: Record<string, Source>): string {
  return item.sourceIds
    .filter((id) => Object.hasOwn(sources, id))
    .map((id) => sources[id]!.title)
    .join('、');
}

/** How many basis items the citation lists (demo v8). */
export const CITE_ITEMS = 6;

function modelName(b: Bundle, s: CalcState, tr: TFn): string {
  const c = s.customModel;
  if (c?.kind === 'manual') return c.value.name ?? tr('cite.customModel');
  if (c?.kind === 'hf') return c.imported?.model.name ?? c.repo;
  return b.models[s.model]?.name ?? s.model;
}

function speedOf(b: Bundle, s: CalcState): { tps: number; ttft: number } {
  if (typeof s.speed !== 'string') return { tps: s.speed.minTokPerSec, ttft: s.speed.maxTtftSec };
  const p = b.speedPresets[s.speed]!;
  return { tps: p.minTokensPerSec.value, ttft: p.maxTtftSec.value };
}

/** Text to paste into a proposal or report: the inputs, the best NCHC platform and the first basis items with sources. */
export function citeText(b: Bundle, s: CalcState, result: RequirementResult, tr: TFn): string {
  const n = (x: number) => fmt(s.lang, x);
  const dec = (x: number) => new Intl.NumberFormat(s.lang, { maximumFractionDigits: 2 }).format(x);
  const vars = {
    model: modelName(b, s, tr),
    quant: b.quantization[s.quant]?.name ?? s.quant,
    workload: typeof s.workload === 'string' ? (b.workloads[s.workload]?.name ?? s.workload) : tr('cite.customWorkload'),
    users: n(s.users),
  };
  const row = result.best === null ? undefined : result.perPlatform.find((p) => p.platform === result.best);
  let head: string;
  if (!row || !row.expected.ok) {
    head = tr('cite.none', vars);
  } else {
    const plat = b.platforms[row.platform]!;
    const unit = tr(plat.unit === 'machine' ? 'unit.machine' : 'unit.gpu');
    const { tps, ttft } = speedOf(b, s);
    head = tr('cite.body', {
      ...vars,
      tps: dec(tps),
      ttft: dec(ttft),
      name: plat.name,
      sub: plat.sub,
      gpus: n(row.expected.gpus),
      unit,
      cons: row.conservative.ok ? tr('cite.cons', { gpus: n(row.conservative.gpus), unit }) : tr('cite.consNone'),
    });
  }
  // A custom workload or speed target is part of what was computed: its numbers travel with the text, marked 自訂
  // (v8 minor 8).
  const custom: string[] = [];
  if (typeof s.workload !== 'string') {
    const w = s.workload;
    custom.push(tr('cite.customWorkloadLine', { input: n(w.inputTokens), output: n(w.outputTokens), hit: dec(w.cacheHitRate * 100) }));
  }
  if (typeof s.speed !== 'string') {
    custom.push(tr('cite.customSpeedLine', { tps: dec(s.speed.minTokPerSec), ttft: dec(s.speed.maxTtftSec) }));
  }
  const sources = sourcesOf(b, s.customModel);
  // Spec §2.1: a citation says when it rests on estimates. The weak items lead, in the 推估 popover's order (best
  // platform's first); the count is the popover's 查看全部 N.
  const weak = topEstimates(result.basis, Infinity, row?.basis);
  const listed = uniqueByPath([...weak, ...result.basis]).slice(0, CITE_ITEMS);
  const items = listed.map((x, i) =>
    tr('cite.item', { i: i + 1, text: x.text, status: tr(`status.${x.status}`), source: sourceTitles(x, sources) || tr('cite.noSource') }),
  );
  const trust = result.hasEstimate && weak.length > 0 ? [tr('cite.estimates', { n: n(weak.length) })] : [];
  // The custom-model warning (spec §2.2) travels with the text.
  const warnings = result.warnings.map((w) => w.text);
  return [head, ...custom, ...trust, ...warnings, '', tr('cite.assumptions'), ...items].join('\n');
}
