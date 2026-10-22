import { scaleLinear, scaleLog } from 'd3-scale';
import { select } from 'd3-selection';
import { theme } from 'antd';
import { useEffect, useRef, type JSX, type MouseEvent } from 'react';
import { useLang } from '../i18n';
import { useWidth } from '../media';
import { transitionMs } from '../motion';
import { useDarkMode } from '../theme';
import { drawAxes, keyed, layer, moving, translate, type Frame, type Sel, type Tick } from './chart-draw';
import { niceTicks } from './ticks';

/**
 * Categorical colours of the comparison lines by slot (design v9 §4.3): the first five slots of the data-viz palette,
 * validated for colour-vision deficiency on adjacent pairs, one set per colour scheme. Letters label the lines too, so
 * colour is never the only cue.
 */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'],
} as const;
export const LETTERS = 'ABCDE';

export type CompareSeries = {
  key: string;
  slot: number;
  /** Uses estimated inputs: drawn dashed. */
  dashed: boolean;
  points: { x: number; y: number }[];
  /** The value at the current users / count. */
  dot?: { x: number; y: number };
  /** Where the line reaches its capacity ("最多 N"). */
  cap?: { x: number; y: number; label: string };
};

export type CompareChartProps = {
  series: CompareSeries[];
  x: { min: number; max: number; log: boolean };
  xTitle: string;
  yTitle: string;
  /** Target region (success background) and its dashed edge: above `y` for speed, below for waiting time. */
  band: { y: number; dir: 'above' | 'below' };
  /** 「你的 N 人」 vertical line. */
  refLine?: { x: number; label: string };
  /** Shared crosshair (controlled, so two charts can show the same x). */
  hover: number | null;
  onHover: (x: number | null) => void;
  tip: { x: (v: number) => string; y: (v: number) => string };
  /** Screen-reader summary (role="img"). */
  label: string;
  /** Fixed width (tests; jsdom has no layout); otherwise the container's. */
  width?: number;
};

const H = 210;
const M = { L: 46, R: 24, T: 16, B: 40 };
const FALLBACK_WIDTH = 320;
const MIN_WIDTH = 220;
const NARROW = 380;
const CAP_GAP = 64;
const LETTER_GAP = 12;
const TIP_WIDTH = 170;

type Scale = ((v: number) => number) & { invert: (px: number) => number };

/** Log ticks 1-2-5 per decade (powers of ten only below NARROW px), or linear nice integer ticks. */
function xTickValues(min: number, max: number, log: boolean, w: number): number[] {
  if (!log) return niceTicks(min, max, w < NARROW ? 4 : 6).filter((v) => Number.isInteger(v) && v >= min && v <= max);
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(min)); 10 ** k <= max; k++) {
    for (const a of w < NARROW ? [1] : [1, 2, 5]) {
      const v = a * 10 ** k;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

/** Value of a polyline at x (linear between neighbours); null outside its range. */
export function valueAt(points: { x: number; y: number }[], x: number): number | null {
  if (points.length === 0 || x < points[0]!.x || x > points[points.length - 1]!.x) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return points[points.length - 1]!.y;
}

type Lay = {
  w: number;
  x: Scale;
  y: (v: number) => number;
  xTicks: Tick[];
  yTicks: Tick[];
  band: { y0: number; y1: number; edge: number };
  ref: { px: number; label: string; anchor: 'start' | 'end' }[];
  lines: { key: string; slot: number; dashed: boolean; d: string }[];
  letters: { key: string; slot: number; px: number; py: number }[];
  caps: { key: string; slot: number; px: number; py: number; label: string | null }[];
  dots: { key: string; slot: number; px: number; py: number }[];
};

function layout(p: CompareChartProps, width: number, fmt: (n: number) => string): Lay {
  const w = Math.max(MIN_WIDTH, width);
  const lo = Math.max(p.x.log ? 1 : 0, p.x.min);
  const hi = Math.max(lo + 1, p.x.max);
  const x = (p.x.log ? scaleLog().domain([lo, hi]) : scaleLinear().domain([lo, hi])).range([M.L, w - M.R]).clamp(true) as unknown as Scale;
  const ys = [...p.series.flatMap((s) => s.points.map((q) => q.y)), p.band.y * 1.3, 1];
  const yVals = niceTicks(0, Math.max(...ys.filter(Number.isFinite)) * 1.08, 4);
  const top = yVals[yVals.length - 1]!;
  const yScale = scaleLinear().domain([0, top]).range([H - M.B, M.T]).clamp(true);
  const y = (v: number) => yScale(v);
  const edge = y(p.band.y);
  const band = p.band.dir === 'above' ? { y0: y(top), y1: edge, edge } : { y0: edge, y1: y(0), edge };

  const lines = p.series.map((s) => ({
    key: s.key,
    slot: s.slot,
    dashed: s.dashed,
    d: s.points.map((q, i) => `${i ? 'L' : 'M'}${x(q.x).toFixed(1)},${y(q.y).toFixed(1)}`).join(''),
  }));

  let prev = -Infinity;
  const letters = p.series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const last = s.points[s.points.length - 1]!;
      return { key: s.key, slot: s.slot, px: x(last.x) + 5, py: y(last.y) + 4 };
    })
    .sort((a, b) => a.py - b.py)
    .map((l) => {
      const py = Math.max(Math.round(l.py), prev + LETTER_GAP);
      prev = py;
      return { ...l, py };
    });

  let lastCap = -Infinity;
  const caps = p.series
    .filter((s) => s.cap)
    .map((s) => ({ key: s.key, slot: s.slot, px: x(s.cap!.x), py: y(s.cap!.y), text: s.cap!.label }))
    .sort((a, b) => a.px - b.px)
    .map((c) => {
      const show = c.px - lastCap >= CAP_GAP && c.px <= w - M.R - 20;
      if (show) lastCap = c.px;
      return { key: c.key, slot: c.slot, px: c.px, py: c.py, label: show ? c.text : null };
    });

  const dots = p.series.filter((s) => s.dot).map((s) => ({ key: s.key, slot: s.slot, px: x(s.dot!.x), py: y(s.dot!.y) }));
  const ref =
    p.refLine && p.refLine.x >= lo && p.refLine.x <= hi
      ? [{ px: x(p.refLine.x), label: p.refLine.label, anchor: x(p.refLine.x) > w - 90 ? ('end' as const) : ('start' as const) }]
      : [];

  return {
    w,
    x,
    y,
    xTicks: xTickValues(lo, hi, p.x.log, w).map((v) => ({ v, at: x(v), label: fmt(v) })),
    yTicks: yVals.map((v) => ({ v, at: y(v), label: fmt(v) })),
    band,
    ref,
    lines,
    letters,
    caps,
    dots,
  };
}

type Colors = { grid: string; axis: string; tick: string; title: string; text: string; bg: string; success: string; successBg: string; hover: string; series: readonly string[] };

function draw(el: SVGSVGElement, lay: Lay, p: CompareChartProps, c: Colors, ms: number): void {
  const svg = select(el);
  svg.selectAll('*').interrupt();
  svg.selectAll('.exit').remove();
  svg.attr('width', lay.w).attr('height', H);
  const f: Frame = { w: lay.w, h: H, ...M };
  const col = (slot: number) => c.series[slot] ?? c.text;

  const band = layer(svg, 'band');
  let rect: Sel = band.select('rect');
  if (rect.empty()) rect = band.append('rect').attr('x', M.L).attr('y', lay.band.y0).attr('height', Math.max(0, lay.band.y1 - lay.band.y0));
  rect.attr('fill', c.successBg).attr('fill-opacity', 0.7).attr('width', lay.w - M.L - M.R);
  moving(rect, ms).attr('y', lay.band.y0).attr('height', Math.max(0, lay.band.y1 - lay.band.y0));

  drawAxes(svg, f, lay.xTicks, lay.yTicks, { x: p.xTitle, y: p.yTitle }, c, ms);

  const edge = layer(svg, 'edge');
  let el2: Sel = edge.select('line');
  if (el2.empty()) el2 = edge.append('line').attr('y1', lay.band.edge).attr('y2', lay.band.edge);
  el2.attr('x1', M.L).attr('x2', lay.w - M.R).attr('stroke', c.success).attr('stroke-dasharray', '4 3');
  moving(el2, ms).attr('y1', lay.band.edge).attr('y2', lay.band.edge);

  type R = Lay['ref'][number];
  const ref = keyed(layer(svg, 'refs'), 'g', 'ref', lay.ref, () => 'ref', ms, (e) => {
    e.attr('transform', (d: R) => `translate(${d.px},0)`);
    e.append('line').attr('y1', M.T).attr('y2', H - M.B).attr('stroke-dasharray', '2 3');
    e.append('text').attr('font-size', 11).attr('font-weight', 700).attr('y', M.T - 4);
  });
  translate(ref.t, (d: R) => [d.px, 0]);
  ref.all.select('line').attr('stroke', c.text);
  ref.all
    .select('text')
    .attr('fill', c.text)
    .attr('text-anchor', (d: R) => d.anchor)
    .attr('x', (d: R) => (d.anchor === 'end' ? -4 : 4))
    .text((d: R) => d.label);

  type L = Lay['lines'][number];
  const lines = keyed(layer(svg, 'lines'), 'path', 'series', lay.lines, (d) => d.key, ms, (e) =>
    e.attr('fill', 'none').attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('d', (d: L) => d.d),
  );
  lines.all.attr('stroke', (d: L) => col(d.slot)).attr('stroke-dasharray', (d: L) => (d.dashed ? '6 4' : null));
  lines.t.attr('d', (d: L) => d.d);

  type C = Lay['caps'][number];
  const caps = keyed(layer(svg, 'caps'), 'circle', 'cap', lay.caps, (d) => d.key, ms, (e) =>
    e.attr('r', 4).attr('stroke-width', 2).attr('cx', (d: C) => d.px).attr('cy', (d: C) => d.py),
  );
  caps.all.attr('fill', c.bg).attr('stroke', (d: C) => col(d.slot));
  caps.t.attr('cx', (d: C) => d.px).attr('cy', (d: C) => d.py);
  const capText = lay.caps.filter((d) => d.label !== null);
  const ct = keyed(layer(svg, 'cap-labels'), 'text', 'cap-label', capText, (d) => d.key, ms, (e) =>
    e.attr('text-anchor', 'middle').attr('font-size', 10.5).attr('x', (d: C) => d.px).attr('y', (d: C) => d.py + 16),
  );
  ct.all.attr('fill', c.title).text((d: C) => d.label);
  ct.t.attr('x', (d: C) => d.px).attr('y', (d: C) => d.py + 16);

  type D = Lay['dots'][number];
  const dots = keyed(layer(svg, 'dots'), 'circle', 'dot', lay.dots, (d) => d.key, ms, (e) =>
    e.attr('r', 5).attr('stroke-width', 2).attr('cx', (d: D) => d.px).attr('cy', (d: D) => d.py),
  );
  dots.all.attr('fill', (d: D) => col(d.slot)).attr('stroke', c.bg);
  dots.t.attr('cx', (d: D) => d.px).attr('cy', (d: D) => d.py);

  type T = Lay['letters'][number];
  const letters = keyed(layer(svg, 'letters'), 'text', 'end-letter', lay.letters, (d) => d.key, ms, (e) =>
    e.attr('font-size', 11).attr('font-weight', 700).attr('x', (d: T) => d.px).attr('y', (d: T) => d.py),
  );
  letters.all.attr('fill', c.text).text((d: T) => LETTERS[d.slot] ?? '');
  letters.t.attr('x', (d: T) => d.px).attr('y', (d: T) => d.py);

  const hover = layer(svg, 'hover');
  if (hover.select('line').empty()) hover.append('line').attr('y1', M.T).attr('y2', H - M.B).attr('opacity', 0);
  hover.select('line').attr('stroke', c.hover);
}

/**
 * Overlaid comparison lines (design v9 §4.3, demo v9 `MultiChart`): target region and edge, 「你的 N 人」 line, one path
 * per line in its slot colour (dashed when it uses estimates), a dot at the current value, a hollow circle and 「最多 N」
 * at the capacity (labels thinned so they never collide) and the line's letter at its end. A crosshair follows the
 * pointer (or a tap); the tooltip lists every line's value there. Data changes move every mark together with the motion
 * token; the first paint and width changes apply at once.
 */
export function CompareChart(p: CompareChartProps): JSX.Element {
  const { token } = theme.useToken();
  const dark = useDarkMode();
  const lang = useLang();
  const [wrap, measured] = useWidth<HTMLDivElement>();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<{ key: string; w: number } | null>(null);
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
  const lay = layout(p, p.width ?? (measured || FALLBACK_WIDTH), (n) => nf.format(n));
  const colors: Colors = {
    grid: token.colorBorderSecondary,
    axis: token.colorBorder,
    tick: token.colorTextTertiary,
    title: token.colorTextSecondary,
    text: token.colorText,
    bg: token.colorBgContainer,
    success: token.colorSuccess,
    successBg: token.colorSuccessBg,
    hover: token.colorTextTertiary,
    series: SERIES[dark ? 'dark' : 'light'],
  };

  const key = JSON.stringify([lay.w, lay.lines, lay.xTicks, lay.yTicks, lay.band, lay.ref, lay.caps, lay.dots, lay.letters, p.xTitle, p.yTitle, colors]);
  useEffect(() => {
    const animate = prev.current !== null && prev.current.key !== key && prev.current.w === lay.w;
    prev.current = { key, w: lay.w };
    draw(ref.current!, lay, p, colors, animate ? transitionMs() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  const [lo, hi] = [Math.max(p.x.log ? 1 : 0, p.x.min), Math.max(Math.max(p.x.log ? 1 : 0, p.x.min) + 1, p.x.max)];
  const hv = p.hover !== null && p.hover >= lo && p.hover <= hi ? p.hover : null;
  useEffect(() => {
    const line = select(ref.current!).select('g.hover line');
    if (hv === null) line.attr('opacity', 0);
    else line.attr('x1', lay.x(hv)).attr('x2', lay.x(hv)).attr('opacity', 1);
  }, [hv, lay]);

  const at = (e: MouseEvent<SVGSVGElement>) => lay.x.invert(e.clientX - e.currentTarget.getBoundingClientRect().left);
  const rows = hv === null ? [] : p.series.map((s) => ({ s, v: valueAt(s.points, hv) }));
  const left = hv === null ? 0 : Math.min(Math.max(0, lay.x(hv) + 10), Math.max(0, lay.w - TIP_WIDTH));
  const palette = SERIES[dark ? 'dark' : 'light'];

  return (
    <div ref={wrap} style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <svg
        ref={ref}
        className="chart"
        role="img"
        aria-label={p.label}
        style={{ display: 'block', touchAction: 'pan-y' }}
        onMouseMove={(e) => p.onHover(at(e))}
        onClick={(e) => p.onHover(at(e))}
        onMouseLeave={() => p.onHover(null)}
      />
      <div
        className="cmp-tip"
        aria-hidden={hv === null}
        style={{
          left,
          maxWidth: TIP_WIDTH,
          opacity: hv === null ? 0 : 1,
          background: token.colorBgElevated,
          boxShadow: token.boxShadowSecondary,
          color: token.colorText,
          borderRadius: token.borderRadiusSM,
        }}
      >
        {hv !== null && (
          <>
            <div style={{ color: token.colorTextSecondary }}>{p.tip.x(hv)}</div>
            {rows.map(({ s, v }) => (
              <div key={s.key}>
                <span className="cmp-swatch" style={{ background: palette[s.slot] }} />
                <b>{LETTERS[s.slot]}</b> {v === null ? <span style={{ color: token.colorTextTertiary }}>—</span> : p.tip.y(v)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
