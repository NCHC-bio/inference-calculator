import { select, type Selection } from 'd3-selection';
import 'd3-transition';
import { theme } from 'antd';
import { useEffect, useRef, type JSX } from 'react';
import { useT } from '../i18n';
import { tZh, type TFn } from '../i18n/t';
import { useWidth } from '../media';
import { easeCubicOut, transitionMs } from '../motion';
import { Explain } from './Explain';

/** Layout only (no hardware values). Spec §3.5: GPU node 12 × 22, Mac 20 × 13, radius 2, gap 4, ellipsis 22 wide. */
const SHAPE = {
  gpu: { w: 12, h: 22 },
  machine: { w: 20, h: 13 },
} as const;
const GAP = 4;
const RX = 2;
const ELLIPSIS_W = 22;
const ICON_H = 24; // height of the icon row; shapes sit on its baseline
const BRACE_H = 34; // brace + label below the icons
const FALLBACK_WIDTH = 300; // before the first measurement (and in jsdom, which has no layout)

type Unit = 'gpu' | 'machine';
export type IsotypeCounts = { expected: number; conservative: number | null; unit: Unit; gpusPerNode: number };
export type Slot = { index: number; x: number; fill: number; dashed: boolean };
export type IsotypeLayout = { slots: Slot[]; fits: boolean; total: number; label: string; ellipsisX: number; width: number };

const num = (n: number) => n.toLocaleString('en');

/** Which blocks to draw for the available width: all of them, or k at each end with an ellipsis between. `expected` and
 *  `conservative` are GPUs for GPU platforms (blocks are nodes) and machines for Macs. Pure: no DOM. */
export function isotypeLayout(n: IsotypeCounts, width: number, tr: TFn = tZh): IsotypeLayout {
  const mac = n.unit === 'machine';
  const per = SHAPE[n.unit].w + GAP;
  const cons = n.conservative ?? 0;
  const total = mac ? Math.max(n.expected, cons) : Math.ceil(Math.max(n.expected, cons) / n.gpusPerNode);
  const blocksExpected = mac ? n.expected : n.expected / n.gpusPerNode;
  const avail = Math.max(per * 3, width);
  const fits = total * per <= avail;
  const make = (index: number, x: number): Slot => {
    const fill = Math.max(0, Math.min(1, blocksExpected - index));
    return { index, x, fill, dashed: fill <= 0 };
  };

  let slots: Slot[];
  let ellipsisX = 0;
  if (fits) {
    slots = Array.from({ length: total }, (_, i) => make(i, i * per));
  } else {
    const k = Math.max(1, Math.floor((avail - ELLIPSIS_W) / per / 2));
    ellipsisX = k * per;
    slots = [
      ...Array.from({ length: k }, (_, i) => make(i, i * per)),
      ...Array.from({ length: k }, (_, j) => make(total - k + j, k * per + ELLIPSIS_W + j * per)),
    ];
  }
  const last = slots[slots.length - 1];
  const w = last ? last.x + per - GAP : 0;

  const extra = n.conservative !== null && n.conservative > n.expected ? tr('isotype.label.conservative', { n: num(n.conservative) }) : '';
  const label =
    (mac
      ? tr('isotype.label.machine', { n: num(n.expected) })
      : tr('isotype.label.gpu', { nodes: num(Math.ceil(n.expected / n.gpusPerNode)), gpus: num(n.expected) })) + extra;
  return { slots, fits, total, label, ellipsisX, width: w };
}

type Colors = { solid: string; dashed: string; brace: string; text: string };

/** Run `sel` at once (ms = 0) or as a d3 transition with the shared motion token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moving = (sel: Selection<any, any, any, any>, ms: number): any => (ms > 0 ? sel.transition().duration(ms).ease(easeCubicOut) : sel);

/** D3 owns the SVG's children; React renders only the element. The first paint (and reduced motion) apply at once; later
 *  changes tween together with `transitionMs()`: blocks slide, grow from height 0, the brace stretches. */
function draw(svgEl: SVGSVGElement, lay: IsotypeLayout, unit: Unit, c: Colors, ms: number): void {
  const { w, h } = SHAPE[unit];
  const svg = select(svgEl);

  // A new state supersedes any running transition: stop it and drop blocks still shrinking away.
  svg.selectAll('*').interrupt();
  svg.selectAll('g.exit').remove();
  svg.attr('aria-hidden', 'true').style('display', 'block').style('overflow', 'visible');
  moving(svg, ms)
    .attr('width', Math.max(lay.width, 1))
    .attr('height', lay.fits ? ICON_H + 2 : ICON_H + BRACE_H);

  let root = svg.select<SVGGElement>('g.icons');
  if (root.empty()) root = svg.append('g').attr('class', 'icons');
  const joined = root.selectAll<SVGGElement, Slot>('g.icon:not(.exit)').data(lay.slots, (d) => d.index);

  const enter = joined.enter().append('g').attr('class', 'icon').attr('transform', (d) => `translate(${d.x},0)`);
  // New blocks grow up from the baseline (height 0), unless motion is off.
  enter.append('rect').attr('class', 'outline').attr('rx', RX).attr('width', w).attr('y', ICON_H).attr('height', 0);
  enter.append('rect').attr('class', 'fill').attr('rx', RX).attr('width', w).attr('y', ICON_H).attr('height', 0).attr('stroke', 'none');
  const all = enter.merge(joined);

  moving(all, ms).attr('transform', (d: Slot) => `translate(${d.x},0)`);
  all.attr('data-icon', (d) => (d.dashed ? 'dashed' : 'solid'));
  all
    .select('.outline')
    .attr('fill', 'none')
    .attr('stroke-width', 1)
    .attr('stroke', (d) => (d.dashed ? c.dashed : c.solid))
    .attr('stroke-dasharray', (d) => (d.dashed ? '3 2' : null));
  all.select('.fill').attr('fill', c.solid);
  moving(all.select('.outline'), ms)
    .attr('y', ICON_H - h)
    .attr('height', h);
  moving(all.select('.fill'), ms)
    .attr('y', (d: Slot) => ICON_H - h * d.fill)
    .attr('height', (d: Slot) => h * d.fill);

  const exit = joined.exit<Slot>().classed('exit', true).attr('data-icon', null);
  if (ms === 0) exit.remove();
  else {
    exit.selectAll('rect').transition().duration(ms).ease(easeCubicOut).attr('y', ICON_H).attr('height', 0);
    exit.transition().duration(ms).remove();
  }

  // Ellipsis, brace and label exist only while the blocks do not fit; they fade in and out.
  const x1 = Math.max(8, lay.width);
  const y0 = ICON_H + 4;
  const brace = `M0,${y0} q0,6 6,6 L${x1 / 2 - 6},${y0 + 6} q6,0 6,6 q0,-6 6,-6 L${x1 - 6},${y0 + 6} q6,0 6,-6`;
  const fade = (tag: 'text' | 'path', cls: string, show: boolean) => {
    const sel = svg.selectAll<SVGElement, number>(`${tag}.${cls}`).data(show ? [1] : []);
    const fresh = sel.enter().append(tag).attr('class', cls).attr('opacity', ms > 0 ? 0 : 1);
    const merged = fresh.merge(sel as never) as unknown as Selection<SVGElement, number, SVGSVGElement, unknown>;
    moving(merged, ms).attr('opacity', 1);
    const gone = sel.exit();
    if (ms === 0) gone.remove();
    else gone.transition().duration(ms).ease(easeCubicOut).attr('opacity', 0).remove();
    return merged;
  };
  fade('text', 'ellipsis', !lay.fits)
    .attr('x', lay.ellipsisX + 2)
    .attr('y', ICON_H - 6)
    .attr('font-size', 14)
    .attr('fill', c.text)
    .text('…');
  const bracePath = fade('path', 'brace', !lay.fits).attr('fill', 'none').attr('stroke', c.brace);
  moving(bracePath, ms).attr('d', brace);
  fade('text', 'brace-label', !lay.fits)
    .attr('x', x1 / 2)
    .attr('y', y0 + 26)
    .attr('text-anchor', 'middle')
    .attr('font-size', 12)
    .attr('fill', c.text)
    .text(lay.label);
}

/** 每個 node（GPU）或每台（Mac／Spark）一個方塊；實心為預期，虛線為保守多出的。放不下時前 k 個、省略號、後 k 個，
 *  下方一道大括號寫總數。`expected`／`conservative` 的單位：GPU 平台為張數，Mac 為台數。 */
export function Isotype(props: IsotypeCounts): JSX.Element {
  const { expected, conservative, unit, gpusPerNode } = props;
  const { token } = theme.useToken();
  const tr = useT();
  const [wrap, measured] = useWidth<HTMLDivElement>();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<{ key: string; measured: boolean } | null>(null);
  const lay = isotypeLayout({ expected, conservative, unit, gpusPerNode }, measured || FALLBACK_WIDTH, tr);
  const colour = unit === 'machine' ? token.colorTextTertiary : token.colorPrimary;
  const colors: Colors = { solid: colour, dashed: colour, brace: token.colorTextTertiary, text: token.colorTextSecondary };
  const legend = tr(unit === 'machine' ? 'isotype.legend.machine' : 'isotype.legend.gpu', { perNode: gpusPerNode });

  const layKey = JSON.stringify([lay.slots.map((s) => [s.index, s.fill, s.dashed]), lay.fits, lay.label, lay.width]);
  useEffect(() => {
    // Animate only when the layout changes after a measured draw: the first paint, the first real measurement (the
    // fallback-width layout is never shown as a starting point) and theme changes apply at once.
    const changed = prev.current !== null && prev.current.measured && prev.current.key !== layKey;
    prev.current = { key: layKey, measured: measured > 0 };
    draw(ref.current!, lay, unit, colors, changed ? transitionMs() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layKey, measured > 0, unit, colors.solid, colors.dashed, colors.brace, colors.text]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  return (
    <div ref={wrap} style={{ width: '100%', minWidth: 0 }}>
      <Explain content={<div style={{ maxWidth: 320 }}>{legend}</div>}>
        <span role="img" aria-label={legend} tabIndex={0} onClick={(e) => e.stopPropagation()} style={{ display: 'inline-block', cursor: 'help', maxWidth: '100%' }}>
          <svg ref={ref} data-testid="isotype" />
        </span>
      </Explain>
    </div>
  );
}
