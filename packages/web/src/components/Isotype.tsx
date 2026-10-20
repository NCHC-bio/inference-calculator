import { select, type Selection } from 'd3-selection';
import 'd3-transition';
import { theme } from 'antd';
import { useEffect, useRef, type JSX } from 'react';
import { transitionMs } from '../motion';

/** Layout only (no hardware values): every icon has the same height, so platforms read on one scale (spec §8.3.1-2). */
const H = 20;
const PAD = 1;
const GAP = 3;
const MAX_ICONS = 16;
const SHAPE = {
  gpu: { w: 12, rx: 2 }, // a node: tall, nearly square corners
  machine: { w: 20, rx: 5 }, // a Mac / Spark: wide box with rounder corners
} as const;

type Icon = { key: string; kind: 'solid' | 'dashed'; fill: number };
type Colors = { solid: string; dashed: string; text: string };

/** Icons for the counts: the first expected nodes solid (the last one filled to its share), the rest up to the conservative count dashed. */
function isotypeIcons(expectedGpus: number, conservativeGpus: number | null, gpusPerNode: number): { icons: Icon[]; total: number } {
  const exp = Math.ceil(expectedGpus / gpusPerNode);
  const total = Math.max(exp, conservativeGpus === null ? 0 : Math.ceil(conservativeGpus / gpusPerNode));
  const icons: Icon[] = [];
  for (let i = 0; i < Math.min(total, MAX_ICONS); i++) {
    const solid = i < exp;
    icons.push({ key: String(i), kind: solid ? 'solid' : 'dashed', fill: solid ? Math.min(1, expectedGpus / gpusPerNode - i) : 0 });
  }
  return { icons, total };
}

function draw(svgEl: SVGSVGElement, icons: Icon[], total: number, unit: 'gpu' | 'machine', c: Colors, ms: number, ghost: boolean): void {
  const { w, rx } = SHAPE[unit];
  const x = (i: number) => PAD + i * (w + GAP);
  const svg = select(svgEl);
  const overflow = total > icons.length;
  svg
    .attr('width', x(icons.length) + (overflow ? 30 : 0))
    .attr('height', H + 2 * PAD)
    .attr('aria-hidden', 'true')
    .style('display', 'block')
    .style('overflow', 'visible');

  // A new state supersedes any running transition: stop it and drop icons still shrinking away.
  svg.selectAll('*').interrupt();
  svg.selectAll('g.exit').remove();

  // Ghost (spec §8.3.1-4): a copy of the previous state that fades out over this one transition.
  svg.selectAll('g.ghost').remove();
  const live = svg.select<SVGGElement>('g.icons');
  if (ghost && ms > 0 && !live.empty()) {
    const copy = live.node()!.cloneNode(true) as SVGGElement;
    copy.setAttribute('class', 'ghost');
    copy.setAttribute('data-ghost', '');
    copy.querySelectorAll('[data-icon]').forEach((n) => n.removeAttribute('data-icon'));
    copy.querySelectorAll('.exit').forEach((n) => n.remove());
    svgEl.insertBefore(copy, svgEl.firstChild);
    select(copy).attr('opacity', 0.3).transition().duration(ms).attr('opacity', 0).remove();
  }

  const root = live.empty() ? svg.append('g').attr('class', 'icons') : live;
  const dashed = (g: Selection<SVGGElement, Icon, SVGGElement, unknown>) =>
    g
      .attr('data-icon', (d) => d.kind)
      .select('.outline')
      .attr('fill', 'none')
      .attr('stroke', (d) => (d.kind === 'solid' ? c.solid : c.dashed))
      .attr('stroke-dasharray', (d) => (d.kind === 'solid' ? null : '3 2'));

  const joined = root.selectAll<SVGGElement, Icon>('g.icon:not(.exit)').data(icons, (d) => d.key);

  const enter = joined.enter().append('g').attr('class', 'icon');
  enter.append('rect').attr('class', 'outline').attr('rx', rx).attr('width', w).attr('stroke-width', 1);
  enter.append('rect').attr('class', 'fill').attr('rx', rx).attr('stroke', 'none');
  const all = enter.merge(joined).attr('transform', (_, i) => `translate(${x(i)},0)`);
  dashed(all);
  all.select('.outline').attr('rx', rx).attr('width', w);
  all.select('.fill').attr('fill', c.solid).attr('rx', rx);

  const exit = joined.exit<Icon>().classed('exit', true).attr('data-icon', null);
  if (ms === 0) {
    exit.remove();
    enter.selectAll('rect').attr('y', PAD).attr('height', H);
    all.select('.outline').attr('y', PAD).attr('height', H);
    all.select<SVGRectElement>('.fill').attr('y', PAD).attr('height', H).attr('width', (d) => w * d.fill);
  } else {
    // New icons grow up from the baseline, removed ones shrink down; everything moves together (no stagger).
    enter.selectAll('rect').attr('y', PAD + H).attr('height', 0);
    enter.select('.fill').attr('width', (d) => w * d.fill);
    all.select('.outline').transition().duration(ms).attr('y', PAD).attr('height', H);
    all
      .select<SVGRectElement>('.fill')
      .transition()
      .duration(ms)
      .attr('y', PAD)
      .attr('height', H)
      .attr('width', (d) => w * d.fill);
    exit.selectAll('rect').transition().duration(ms).attr('y', PAD + H).attr('height', 0);
    exit.transition().duration(ms).remove();
  }

  svg
    .selectAll<SVGTextElement, number>('text.more')
    .data(overflow ? [total - icons.length] : [])
    .join('text')
    .attr('class', 'more')
    .attr('x', x(icons.length) + 2)
    .attr('y', PAD + H - 5)
    .attr('font-size', 11)
    .attr('fill', c.text)
    .text((n) => `+${n}`);
}

/** 每台機器一個圖示：GPU 平台的台數是 ceil(gpus / gpusPerNode) 個 node，Mac／Spark 是台數。
 *  前 `expected` 個實心，到 `conservative` 為止虛線。gpus 不滿一個 node 時，圖示只填滿相應比例。
 *  數量改變時，用 d3-transition（transitionMs()）長出或縮回，前一個狀態以殘影保留一次轉場。
 *  D3 owns the SVG's children; React renders only the element. */
export function Isotype(props: { expectedGpus: number; conservativeGpus: number | null; gpusPerNode: number; unit: 'gpu' | 'machine' }): JSX.Element {
  const { expectedGpus, conservativeGpus, gpusPerNode, unit } = props;
  const { token } = theme.useToken();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<string | null>(null);
  const colors: Colors = { solid: token.colorPrimary, dashed: token.colorBorder, text: token.colorTextSecondary };

  useEffect(() => {
    const el = ref.current!;
    const key = `${expectedGpus}|${conservativeGpus}|${gpusPerNode}|${unit}`;
    // Animate only when the counts change (spec §8.3.1-4): first paint and theme changes apply at once.
    const changed = prev.current !== null && prev.current !== key;
    prev.current = key;
    const { icons, total } = isotypeIcons(expectedGpus, conservativeGpus, gpusPerNode);
    draw(el, icons, total, unit, colors, changed ? transitionMs() : 0, changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedGpus, conservativeGpus, gpusPerNode, unit, colors.solid, colors.dashed, colors.text]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  return <svg ref={ref} data-testid="isotype" />;
}
