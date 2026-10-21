import type { Selection } from 'd3-selection';
import 'd3-transition';
import { easeCubicOut } from '../motion';

/* Shared D3 drawing for the speed charts and the Roofline: layers, keyed joins that fade in / out, and axes with tick
 * values, gridlines and unit titles (design §3.7). D3 owns each chart's SVG children; React renders only the element. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sel = Selection<any, any, any, any>;

/** Run `sel` at once (ms = 0) or as a d3 transition with the shared motion token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const moving = (sel: Sel, ms: number): any => (ms > 0 ? sel.transition().duration(ms).ease(easeCubicOut) : sel);

/** The `<g class={cls}>` child of `svg`, created (appended, so first-draw order is paint order) when missing. */
export function layer(svg: Sel, cls: string): Sel {
  const g = svg.select(`g.${cls}`);
  return g.empty() ? svg.append('g').attr('class', cls) : g;
}

/**
 * Keyed join of `tag.cls` under `parent`. New elements get `init` (their start state) and fade in; leaving ones fade out
 * and are removed; `t` is the running transition (or selection) of every current element, for the caller's attributes
 * (one transition per element, so nothing interrupts the fade).
 */
export function keyed<D>(parent: Sel, tag: string, cls: string, data: D[], key: (d: D) => string, ms: number, init?: (enter: Sel) => void) {
  const sel = parent.selectAll<Element, D>(`${tag}.${cls}:not(.exit)`).data(data, key);
  const enter = sel.enter().append(tag).attr('class', cls).attr('opacity', ms > 0 ? 0 : 1);
  init?.(enter);
  const gone = sel.exit().classed('exit', true);
  if (ms === 0) gone.remove();
  else gone.transition().duration(ms).ease(easeCubicOut).attr('opacity', 0).remove();
  const all: Sel = enter.merge(sel as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = moving(all, ms).attr('opacity', 1);
  return { all, t };
}

const TRANSLATE = /translate\(([-\d.e]+),([-\d.e]+)\)/;

/**
 * Move to `translate(xy(d))`: at once on a selection, or tweened between the two translations on a transition (d3's own
 * transform interpolator needs SVG transform lists, which jsdom lacks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function translate<D>(t: any, xy: (d: D) => [number, number]): void {
  if (typeof t.attrTween !== 'function') {
    t.attr('transform', (d: D) => `translate(${xy(d).join(',')})`);
    return;
  }
  t.attrTween('transform', function (this: Element, d: D) {
    const [x1, y1] = xy(d);
    const m = TRANSLATE.exec(this.getAttribute('transform') ?? '');
    const [x0, y0] = m ? [Number(m[1]), Number(m[2])] : [x1, y1];
    return (k: number) => `translate(${x0 + (x1 - x0) * k},${y0 + (y1 - y0) * k})`;
  });
}

export type Frame = { w: number; h: number; L: number; R: number; T: number; B: number };
export type Tick = { v: number; at: number; label: string };
export type AxisColors = { grid: string; axis: string; tick: string; title: string };

/** Gridlines at the y ticks, both axes with their tick values, the axis lines and the two unit titles. */
export function drawAxes(svg: Sel, f: Frame, xTicks: Tick[], yTicks: Tick[], titles: { x: string; y: string }, c: AxisColors, ms: number): void {
  const { w, h, L, R, T, B } = f;
  const key = (d: Tick) => String(d.v);

  const grid = keyed(layer(svg, 'grid'), 'line', 'grid', yTicks, key, ms, (e) => e.attr('y1', (d: Tick) => d.at).attr('y2', (d: Tick) => d.at));
  grid.all.attr('stroke', c.grid);
  grid.t.attr('x1', L).attr('x2', w - R).attr('y1', (d: Tick) => d.at).attr('y2', (d: Tick) => d.at);

  const y = keyed(layer(svg, 'y-axis'), 'g', 'tick', yTicks, key, ms, (e) => {
    e.attr('transform', (d: Tick) => `translate(0,${d.at})`);
    e.append('text').attr('text-anchor', 'end').attr('font-size', 11).attr('dy', 4);
  });
  y.all.attr('data-v', (d: Tick) => d.v).select('text').attr('x', L - 6).attr('fill', c.tick).text((d: Tick) => d.label);
  translate(y.t, (d: Tick) => [0, d.at]);

  const x = keyed(layer(svg, 'x-axis'), 'g', 'tick', xTicks, key, ms, (e) => {
    e.attr('transform', (d: Tick) => `translate(${d.at},0)`);
    e.append('line');
    e.append('text').attr('text-anchor', 'middle').attr('font-size', 11);
  });
  x.all.attr('data-v', (d: Tick) => d.v);
  x.all.select('line').attr('y1', h - B).attr('y2', h - B + 4).attr('stroke', c.axis);
  x.all.select('text').attr('y', h - B + 16).attr('fill', c.tick).text((d: Tick) => d.label);
  translate(x.t, (d: Tick) => [d.at, 0]);

  const frame = layer(svg, 'frame');
  const lines = [
    { k: 'y', x1: L, y1: T, x2: L, y2: h - B },
    { k: 'x', x1: L, y1: h - B, x2: w - R, y2: h - B },
  ];
  const fl = keyed(frame, 'line', 'axis', lines, (d) => d.k, ms);
  fl.all.attr('stroke', c.axis);
  fl.t
    .attr('x1', (d: (typeof lines)[number]) => d.x1)
    .attr('y1', (d: (typeof lines)[number]) => d.y1)
    .attr('x2', (d: (typeof lines)[number]) => d.x2)
    .attr('y2', (d: (typeof lines)[number]) => d.y2);

  const tl = layer(svg, 'titles');
  const xt = keyed(tl, 'text', 'x-title', [titles.x], () => 'x', ms, (e) => e.attr('text-anchor', 'middle').attr('font-size', 11).attr('x', (w + L) / 2).attr('y', h - 4));
  xt.all.attr('fill', c.title).text(titles.x);
  xt.t.attr('x', (w + L) / 2).attr('y', h - 4);
  const rot = `translate(12,${(T + h - B) / 2}) rotate(-90)`;
  const yt = keyed(tl, 'text', 'y-title', [titles.y], () => 'y', ms, (e) => e.attr('text-anchor', 'middle').attr('font-size', 11).attr('transform', rot));
  yt.all.attr('fill', c.title).attr('transform', rot).text(titles.y);
}
