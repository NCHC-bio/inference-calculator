import type { Bundle } from '@nchc/schema';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import { theme } from 'antd';
import { useEffect, useRef, useState, type JSX, type MouseEvent } from 'react';
import { useLang } from '../i18n';
import type { TFn } from '../i18n/t';
import { useWidth } from '../media';
import { transitionMs } from '../motion';
import { drawAxes, keyed, layer, moving, translate, type Frame, type Sel, type Tick } from './chart-draw';
import { niceTicks } from './ticks';

export type ChartPoint = { x: number; y: number | null; /** Misses the target here (core `why`): drawn dashed. */ miss?: boolean };
export type ChartMark = { key: string; x: number; y?: number; label: string; tone: 'primary' | 'muted' | 'error'; dashed?: boolean };
export type ChartZone = { name: string; lo: number; hi: number; tone: 'success' | 'warning' | 'error' };

export type SpeedChartProps = {
  points: ChartPoint[];
  xTitle: string;
  yTitle: string;
  marks: ChartMark[];
  zones: ChartZone[];
  /** Click anywhere: the x under the pointer, rounded, at least 1. */
  onPick?: (x: number) => void;
  /** Hover: a short note for the nearest point (design §5.2: which split that point uses). */
  pointNote?: (x: number) => string;
  /** A speed target that is not a zone boundary (custom speed): a dashed horizontal line. */
  target?: { y: number; label: string } | null;
  /** Fixed width (tests; jsdom has no layout); otherwise the container's. */
  width?: number;
};

/** Layout (demo v8 `LineChart`): 190 tall, plot inset L 48 / R 12 / T 12 / B 40. */
const H = 190;
const M = { L: 48, R: 12, T: 12, B: 40 };
const FALLBACK_WIDTH = 320;
const MIN_WIDTH = 200;
const ZONE_LABEL_MIN_PX = 14;

/** 流暢／可接受／卡頓 from the speed presets: each preset's minTokensPerSec is a boundary (fastest zone up to ∞). */
export function speedZones(b: Bundle, tr: TFn): ChartZone[] {
  const presets = Object.values(b.speedPresets).sort((p, q) => q.minTokensPerSec.value - p.minTokensPerSec.value);
  const zones: ChartZone[] = presets.map((p, i) => ({
    name: p.name,
    lo: p.minTokensPerSec.value,
    hi: i === 0 ? Infinity : presets[i - 1]!.minTokensPerSec.value,
    tone: i === 0 ? 'success' : 'warning',
  }));
  const last = presets[presets.length - 1];
  if (last) zones.push({ name: tr('chart.zone.slow'), lo: 0, hi: last.minTokensPerSec.value, tone: 'error' });
  return zones;
}

/** `M…L…` through consecutive points whose later end passes `keep`; a null y always breaks the line. */
function runs(pts: { px: number; py: number | null; miss: boolean }[], keep: (cur: { miss: boolean }) => boolean): string {
  let d = '';
  let end = -1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.py === null || b.py === null || !keep(b)) continue;
    if (end !== i - 1) d += `M${a.px.toFixed(1)},${a.py.toFixed(1)}`;
    d += `L${b.px.toFixed(1)},${b.py.toFixed(1)}`;
    end = i;
  }
  return d;
}

type Layout = {
  w: number;
  x: ScaleLinear<number, number>;
  y: ScaleLinear<number, number>;
  xTicks: Tick[];
  yTicks: Tick[];
  solid: string;
  miss: string;
  zones: (ChartZone & { y0: number; y1: number; label: boolean })[];
  marks: (ChartMark & { px: number; py: number | null; ly: number; anchor: 'start' | 'end' })[];
  target: { py: number; label: string }[];
};

/** Pure layout: scales, ticks, line paths, zone rectangles and mark positions for `width`. */
function layout(p: SpeedChartProps, width: number, fmt: (n: number) => string): Layout {
  const w = Math.max(MIN_WIDTH, width);
  const xs = [...p.points.map((q) => q.x), ...p.marks.map((m) => m.x)];
  const xmin = Math.min(...xs);
  const xmax = Math.max(xmin + 1, ...xs);
  const x = scaleLinear().domain([xmin, xmax]).range([M.L, w - M.R]);
  const ys = [...p.points.map((q) => q.y ?? 0), ...p.marks.map((m) => m.y ?? 0), p.target?.y ?? 0];
  const yTickVals = niceTicks(0, Math.max(30, ...ys) * 1.1, 4);
  const y = scaleLinear()
    .domain([0, yTickVals[yTickVals.length - 1]!])
    .range([H - M.B, M.T])
    .clamp(true);
  const xTickVals = niceTicks(xmin, xmax, w < 320 ? 4 : 6).filter((v) => Number.isInteger(v) && v >= xmin && v <= xmax);

  const pts = p.points.map((q) => ({ px: x(q.x), py: q.y === null ? null : y(q.y), miss: q.miss === true }));
  const placed: number[] = [];
  const marks = p.marks.map((m) => {
    const px = x(m.x);
    // Labels of marks within 36 px of an earlier one stack one line lower.
    const ly = M.T + 10 + 12 * placed.filter((q) => Math.abs(q - px) < 36).length;
    placed.push(px);
    return { ...m, px, py: m.y === undefined ? null : y(m.y), ly, anchor: px > w - M.R - 40 ? ('end' as const) : ('start' as const) };
  });
  return {
    w,
    x,
    y,
    xTicks: xTickVals.map((v) => ({ v, at: x(v), label: fmt(v) })),
    yTicks: yTickVals.map((v) => ({ v, at: y(v), label: fmt(v) })),
    solid: runs(pts, (c) => !c.miss),
    miss: runs(pts, (c) => c.miss),
    zones: p.zones.map((z) => {
      const y0 = y(Math.min(z.hi, y.domain()[1]!));
      const y1 = y(z.lo);
      return { ...z, y0, y1, label: y1 - y0 >= ZONE_LABEL_MIN_PX };
    }),
    marks,
    target: p.target ? [{ py: y(p.target.y), label: p.target.label }] : [],
  };
}

type Colors = Record<'grid' | 'axis' | 'tick' | 'title' | 'line' | 'primary' | 'muted' | 'error' | 'success' | 'warning' | 'zoneError', string>;

function draw(el: SVGSVGElement, lay: Layout, xTitle: string, yTitle: string, c: Colors, ms: number): void {
  const svg = select(el);
  svg.selectAll('*').interrupt();
  svg.selectAll('.exit').remove();
  svg.attr('width', lay.w).attr('height', H);
  const f: Frame = { w: lay.w, h: H, ...M };

  type Z = Layout['zones'][number];
  const zl = layer(svg, 'zones');
  const zoneFill = { success: c.success, warning: c.warning, error: c.zoneError };
  const zr = keyed(zl, 'rect', 'zone', lay.zones, (z) => z.name, ms, (e) => e.attr('y', (z: Z) => z.y0).attr('height', (z: Z) => Math.max(0, z.y1 - z.y0)));
  zr.all
    .attr('data-lo', (z: Z) => z.lo)
    .attr('data-hi', (z: Z) => z.hi)
    .attr('data-tone', (z: Z) => z.tone)
    .attr('fill', (z: Z) => zoneFill[z.tone])
    .attr('fill-opacity', 0.5);
  zr.t
    .attr('x', M.L)
    .attr('width', lay.w - M.L - M.R)
    .attr('y', (z: Z) => z.y0)
    .attr('height', (z: Z) => Math.max(0, z.y1 - z.y0));
  const named = lay.zones.filter((z) => z.label);
  // Names sit at the bottom-right of their zone, clear of the mark labels along the top.
  const zn = keyed(zl, 'text', 'zone-name', named, (z) => z.name, ms, (e) => e.attr('y', (z: Z) => z.y1 - 4).attr('text-anchor', 'end').attr('font-size', 10));
  zn.all.attr('fill', c.tick).text((z: Z) => z.name);
  zn.t.attr('x', lay.w - M.R - 4).attr('y', (z: Z) => z.y1 - 4);

  type G = Layout['target'][number];
  const tg = keyed(layer(svg, 'target'), 'g', 'target', lay.target, () => 't', ms, (e) => {
    e.attr('transform', (d: G) => `translate(0,${d.py})`);
    e.append('line').attr('stroke-dasharray', '6 3');
    e.append('text').attr('font-size', 10).attr('y', -3);
  });
  translate(tg.t, (d: G) => [0, d.py]);
  tg.all.select('line').attr('x1', M.L).attr('x2', lay.w - M.R).attr('stroke', c.title);
  tg.all
    .select('text')
    .attr('x', M.L + 4)
    .attr('fill', c.title)
    .text((d: G) => d.label);

  drawAxes(svg, f, lay.xTicks, lay.yTicks, { x: xTitle, y: yTitle }, c, ms);

  const lines = layer(svg, 'lines');
  const path = (cls: string, d: string, dashed: boolean) => {
    let p: Sel = lines.select(`path.${cls}`);
    if (p.empty()) p = lines.append('path').attr('class', cls).attr('fill', 'none').attr('stroke-width', 2).attr('d', d);
    p.attr('stroke', c.line).attr('stroke-dasharray', dashed ? '5 4' : null);
    moving(p, ms).attr('d', d);
  };
  path('line', lay.solid, false);
  path('line-miss', lay.miss, true);

  type K = Layout['marks'][number];
  const tone = (m: K) => (m.tone === 'primary' ? c.primary : m.tone === 'error' ? c.error : c.muted);
  const mk = keyed(layer(svg, 'marks'), 'g', 'mark', lay.marks, (m) => m.key, ms, (e) => {
    e.attr('transform', (m: K) => `translate(${m.px},0)`);
    e.append('line').attr('y1', M.T).attr('y2', H - M.B);
    e.append('text').attr('font-size', 11);
  });
  translate(mk.t, (m: K) => [m.px, 0]);
  mk.all
    .select('line')
    .attr('stroke', tone)
    .attr('stroke-dasharray', (m: K) => (m.dashed ? '4 3' : null));
  mk.all
    .select('text')
    .attr('fill', tone)
    .attr('text-anchor', (m: K) => m.anchor)
    .text((m: K) => m.label);
  moving(mk.all.select('text'), ms)
    .attr('x', (m: K) => (m.anchor === 'end' ? -4 : 4))
    .attr('y', (m: K) => m.ly);
  mk.all.each(function (this: SVGGElement, m: K) {
    const g = select(this);
    const dot = keyed(g, 'circle', 'dot', m.py === null ? [] : [m], (d) => d.key, ms, (e) => e.attr('cy', (d: K) => d.py).attr('r', 5));
    dot.all.attr('fill', tone(m));
    dot.t.attr('cy', (d: K) => d.py);
  });

  const hover = layer(svg, 'hover');
  if (hover.select('line').empty()) hover.append('line').attr('y1', M.T).attr('y2', H - M.B).attr('opacity', 0);
  hover.select('line').attr('stroke', c.axis).attr('stroke-dasharray', '2 2');
}

/**
 * 「卡數／人數 → 每人速度」曲線（design §4 item 5, demo v8 `LineChart`）：速度分區背景（`speedPresets`）、格線、兩軸刻度數值
 * 與含單位的標題；y 為 null 的點斷開，未達標的點（`miss`）畫虛線；標記「建議／目前／上限」。點一下設定 x（`onPick`），
 * 滑過時顯示最近一點的說明（`pointNote`）。資料改變時路徑、刻度與標記一起以 motion token 過渡；首次繪製與縮放直接套用。
 */
export function SpeedChart(props: SpeedChartProps): JSX.Element {
  const { points, xTitle, yTitle, onPick, pointNote } = props;
  const { token } = theme.useToken();
  const lang = useLang();
  const [wrap, measured] = useWidth<HTMLDivElement>();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<{ key: string; w: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
  const lay = layout(props, props.width ?? (measured || FALLBACK_WIDTH), (n) => nf.format(n));
  const colors: Colors = {
    grid: token.colorBorderSecondary,
    axis: token.colorBorder,
    tick: token.colorTextTertiary,
    title: token.colorTextSecondary,
    line: token.colorPrimary,
    primary: token.colorPrimary,
    muted: token.colorTextTertiary,
    error: token.colorError,
    success: token.colorSuccessBg,
    warning: token.colorWarningBg,
    zoneError: token.colorErrorBg,
  };

  const key = JSON.stringify([lay.w, lay.solid, lay.miss, lay.xTicks, lay.yTicks, lay.zones, lay.marks, lay.target, xTitle, yTitle, colors]);
  useEffect(() => {
    // Data changes animate; the first paint and width changes (resize, first measurement) apply at once.
    const animate = prev.current !== null && prev.current.key !== key && prev.current.w === lay.w;
    prev.current = { key, w: lay.w };
    draw(ref.current!, lay, xTitle, yTitle, colors, animate ? transitionMs() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  useEffect(() => {
    const line = select(ref.current!).select('g.hover line');
    if (hover === null) line.attr('opacity', 0);
    else line.attr('x1', lay.x(hover)).attr('x2', lay.x(hover)).attr('opacity', 1);
  }, [hover, lay]);

  const xAt = (e: MouseEvent<SVGSVGElement>) => {
    const [lo, hi] = lay.x.domain() as [number, number];
    const v = lay.x.invert(e.clientX - e.currentTarget.getBoundingClientRect().left);
    return Math.min(hi, Math.max(lo, v));
  };
  const nearest = (v: number) =>
    points.reduce((best, q) => (q.y !== null && Math.abs(q.x - v) < Math.abs(best - v) ? q.x : best), points.find((q) => q.y !== null)?.x ?? v);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!pointNote || points.length === 0) return;
    const x = nearest(xAt(e));
    setHover(x);
    setNote(pointNote(x));
  };
  const hx = hover === null ? 0 : lay.x(hover);
  const right = hx > lay.w / 2;

  return (
    <div ref={wrap} style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <svg
        ref={ref}
        className="chart"
        style={{ display: 'block', cursor: onPick ? 'pointer' : 'default' }}
        onClick={onPick ? (e) => onPick(Math.max(1, Math.round(xAt(e)))) : undefined}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      />
      {pointNote && (
        <div
          data-testid="chart-note"
          aria-live="polite"
          className="chart-note"
          style={{
            top: M.T + 30,
            ...(right ? { right: lay.w - hx + 8 } : { left: hx + 8 }),
            maxWidth: Math.min(240, right ? hx - 8 : lay.w - hx - 8),
            opacity: hover === null ? 0 : 1,
            background: token.colorBgElevated,
            color: token.colorText,
            boxShadow: token.boxShadowSecondary,
            borderRadius: token.borderRadiusSM,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
