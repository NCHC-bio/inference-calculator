import type { RequirementResult } from '@nchc/core';
import type { Bundle } from '@nchc/schema';
import type { Lang, TFn } from '../i18n/t';

// React-free so the Playwright (Node) side can compute the expected answer with the same rules.

export const fmt = (lang: Lang, n: number, digits = 0) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

export type NeedParts = { feasible: boolean; head: string; tail: string; sub: string };

/** The need-mode answer split into its primary head and secondary tail (platform sub + node count). */
export function needAnswerParts(r: RequirementResult, bundle: Bundle, t: TFn, lang: Lang): NeedParts {
  const row = r.best === null ? undefined : r.perPlatform.find((p) => p.platform === r.best);
  if (!row || !row.expected.ok) {
    return { feasible: false, head: t('answer.need.none'), tail: '', sub: t('answer.need.noneHint') };
  }
  const plat = bundle.platforms[row.platform]!;
  const unit = t(plat.unit === 'machine' ? 'unit.machine' : 'unit.gpu');
  const gpus = row.expected.gpus;
  const perNode = plat.gpusPerNode.value;
  // spec §10.2: from one node up, the node count with one decimal, none when it divides evenly.
  const nodes = gpus >= perNode ? t('answer.need.nodes', { nodes: fmt(lang, gpus / perNode, gpus % perNode ? 1 : 0) }) : '';
  return {
    feasible: true,
    head: t('answer.need.main', { name: plat.name, gpus: fmt(lang, gpus), unit }),
    tail: `${plat.sub}${nodes}`,
    sub: row.conservative.ok ? t('answer.need.sub', { gpus: fmt(lang, row.conservative.gpus), unit }) : t('answer.need.subNone'),
  };
}

/** 主答案的文字，供 AnswerLine 與 e2e 使用。 */
export function needAnswerText(r: RequirementResult, bundle: Bundle, t: TFn, lang: Lang = 'zh-TW'): { main: string; sub: string } {
  const p = needAnswerParts(r, bundle, t, lang);
  return { main: p.tail ? `${p.head} ${p.tail}` : p.head, sub: p.sub };
}
