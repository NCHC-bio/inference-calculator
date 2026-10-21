import type { BasisItem } from '@nchc/core';

// React-free: shared by the 推估 popover, the basis Modal and the citation text.

/** Estimated or unverified items: the ones a result's trust rests on (spec §2.1, shown as 推估／未查證). */
export const isWeak = (x: BasisItem): boolean => x.status === 'estimate' || x.status === 'unverified';

/** First item per path, in order (the union basis repeats shared inputs). */
export function uniqueByPath(items: BasisItem[]): BasisItem[] {
  const seen = new Set<string>();
  return items.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)));
}

/**
 * The first `n` estimated / unverified items in basis order; items the best platform's result uses (`best`, its own
 * basis) come first, since they shape the answer most (design §3.3).
 */
export function topEstimates(basis: BasisItem[], n: number, best?: BasisItem[]): BasisItem[] {
  const weak = uniqueByPath(basis.filter(isWeak));
  if (!best) return weak.slice(0, n);
  const inBest = new Set(best.map((x) => x.path));
  return [...weak.filter((x) => inBest.has(x.path)), ...weak.filter((x) => !inBest.has(x.path))].slice(0, n);
}
