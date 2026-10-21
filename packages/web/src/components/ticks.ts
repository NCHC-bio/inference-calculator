import { scaleLinear } from 'd3-scale';

/** Linear axis ticks: d3's `linear().domain([min, max]).nice(count).ticks(count)`, so the ends are tick values. */
export function niceTicks(min: number, max: number, count: number): number[] {
  return scaleLinear().domain([min, max]).nice(count).ticks(count);
}

/** Log axis ticks: the powers of ten from the one at or below `min` to the one at or above `max`. */
export function powerTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
  return Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i));
}
