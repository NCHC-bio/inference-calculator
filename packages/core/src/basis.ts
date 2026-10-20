/**
 * Provenance basis: the list of every config value (and user override) a calculation
 * actually used, with status, sources and lecture references (spec §2.1).
 * Pure; no Node or DOM APIs.
 */
import type { CoreStatus } from '@nchc/schema';

export type BasisItem = {
  /** Dotted path into the bundle (`hardware.h200-sxm.memGB`), or `model.<field>` for overrides. */
  path: string;
  status: CoreStatus;
  value: unknown;
  /** Source ids: `source`, else `evidence`, else derived `inputs`; empty for user values. */
  sourceIds: string[];
  /** Human-readable label plus the estimate basis / derivation formula. */
  text: string;
  /** Lecture reference, e.g. 'B1' (docs/research/lecture-formulas.md). */
  lecRef?: string;
};

/** Structural view of a `Sourced<T>` value (schema `sourced()`). */
type SourcedLike = {
  value: unknown;
  unit?: string;
  status: CoreStatus;
  source?: string;
  evidence?: string[];
  basis?: string;
  formula?: string;
  inputs?: string[];
  /** unverified only: the conflicting source ids (≥ 2). */
  sources?: string[];
  /** unverified only: the contradiction, or why no source could verify the value. */
  conflict?: string;
};

/**
 * BasisItem for a config value with provenance. An `unverified` value shows why (its `conflict`) and, when sources
 * contradict each other, every one of them (`sources`, also the item's sourceIds) (spec §2.1).
 */
export function fromSourced(path: string, label: string, s: SourcedLike, lecRef?: string): BasisItem {
  const sourceIds =
    s.status === 'unverified' && s.sources?.length
      ? [...s.sources]
      : s.source ? [s.source] : s.evidence?.length ? [...s.evidence] : [...(s.inputs ?? [])];
  let text = s.unit ? `${label}（${s.unit}）` : label;
  if (s.status === 'estimate' && s.basis) text += `；推估依據：${s.basis}`;
  if (s.status === 'derived' && s.formula) text += `；推導：${s.formula}`;
  if (s.status === 'unverified') {
    text += '；未查證';
    if (s.conflict) text += `：${s.conflict}`;
    if (s.sources?.length) text += `（互相矛盾的來源：${s.sources.join('、')}）`;
  }
  const item: BasisItem = { path, status: s.status, value: s.value, sourceIds, text };
  if (lecRef) item.lecRef = lecRef;
  return item;
}

/** BasisItem for a value the user typed in (status 'user', no sources). */
export function fromUser(path: string, label: string, value: unknown, lecRef?: string): BasisItem {
  const item: BasisItem = { path, status: 'user', value, sourceIds: [], text: `${label}；使用者自訂` };
  if (lecRef) item.lecRef = lecRef;
  return item;
}

/** Ordered, de-duplicated (by path, first wins) collection of basis items. */
export class BasisCollector {
  private readonly items = new Map<string, BasisItem>();
  add(...items: BasisItem[]): this {
    for (const i of items) if (!this.items.has(i.path)) this.items.set(i.path, i);
    return this;
  }
  list(): BasisItem[] {
    return [...this.items.values()];
  }
}

/** Trust flags: the result is only as trustworthy as its weakest input (spec §2.1). */
export function trustFlags(basis: BasisItem[]): { hasEstimate: boolean; hasUser: boolean } {
  return {
    hasEstimate: basis.some((b) => b.status === 'estimate' || b.status === 'unverified'),
    hasUser: basis.some((b) => b.status === 'user'),
  };
}
