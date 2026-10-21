import type { ShapeUsage } from '@nchc/core';
import { scaleLog } from 'd3-scale';
import { select } from 'd3-selection';
import { theme, Typography } from 'antd';
import { useEffect, useRef, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useWidth } from '../media';
import { transitionMs } from '../motion';
import { drawAxes, keyed, layer, moving, type Frame, type Sel, type Tick } from './chart-draw';
import { powerTicks } from './ticks';

/** Layout (demo v8 `Roofline`): 210 tall, plot inset L 56 / R 28 (so the last x tick is not clipped) / T 12 / B 42. */
const H = 210;
const M = { L: 56, R: 28, T: 12, B: 42 };
const FALLBACK_WIDTH = 320;
const MIN_WIDTH = 220;

type RooflineData = ShapeUsage['roofline'];
type Label = { key: string; x: number; y: number; text: string; anchor: 'start' | 'end' };

/**
 * Pure layout. Every number is core's (`perf.usage.roofline`): the slope is memBwTBsPerGpu (TFLOPS = FLOP/byte × TB/s),
 * the flat line peakTflopsPerGpu, the dot (intensityFlopPerByte, achievedTflopsPerGpu). Both axes are log, ticks at
 * powers of ten spanning the roof's ridge × 8 and the dot.
 */
function layout(r: RooflineData, width: number, fmt: (n: number, d?: number) => string, tr: ReturnType<typeof useT>) {
  const w = Math.max(MIN_WIDTH, width);
  const roof = (a: number) => Math.min(r.peakTflopsPerGpu, a * r.memBwTBsPerGpu);
  const ridge = r.peakTflopsPerGpu / r.memBwTBsPerGpu;
  const xTickVals = powerTicks(Math.min(1, r.intensityFlopPerByte), Math.max(ridge * 8, r.intensityFlopPerByte * 2));
  const x0 = xTickVals[0]!;
  const x1 = xTickVals[xTickVals.length - 1]!;
  const yTickVals = powerTicks(Math.min(roof(x0), r.achievedTflopsPerGpu) * 0.8, r.peakTflopsPerGpu * 1.2);
  const x = scaleLog().domain([x0, x1]).range([M.L, w - M.R]);
  const y = scaleLog()
    .domain([yTickVals[0]!, yTickVals[yTickVals.length - 1]!])
    .range([H - M.B, M.T]);
  const corners = [x0, ...(ridge > x0 && ridge < x1 ? [ridge] : []), x1];
  const path = corners.map((a, i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)},${y(roof(a)).toFixed(1)}`).join('');
  // The bandwidth label ends 65% of the way (in log) up the slope, above it: the slope falls to the left, so the
  // right-anchored text never crosses it and stays clear of the dot (which lies under the roof).
  const slopeAt = Math.min(x1, Math.max(x0, x0 * (ridge / x0) ** 0.65));
  const dot = { cx: x(r.intensityFlopPerByte), cy: y(Math.max(yTickVals[0]!, r.achievedTflopsPerGpu)) };
  const labels: Label[] = [
    { key: 'peak', x: w - M.R - 4, y: y(r.peakTflopsPerGpu) - 6, text: tr('roofline.peak', { v: fmt(r.peakTflopsPerGpu) }), anchor: 'end' },
    { key: 'bw', x: x(slopeAt) - 4, y: y(roof(slopeAt)) - 8, text: tr('roofline.bw', { v: fmt(r.memBwTBsPerGpu, 2) }), anchor: 'end' },
    { key: 'now', x: dot.cx + 8, y: dot.cy + 4, text: tr('roofline.now'), anchor: 'start' },
  ];
  const tick = (v: number, at: number): Tick => ({ v, at, label: fmt(v) });
  return {
    w,
    path,
    dot,
    labels,
    xTicks: xTickVals.map((v) => tick(v, x(v))),
    yTicks: yTickVals.map((v) => tick(v, y(v))),
  };
}
type Layout = ReturnType<typeof layout>;
type Colors = { grid: string; axis: string; tick: string; title: string; roof: string; dot: string };

function draw(el: SVGSVGElement, lay: Layout, titles: { x: string; y: string }, c: Colors, ms: number): void {
  const svg = select(el);
  svg.selectAll('*').interrupt();
  svg.selectAll('.exit').remove();
  svg.attr('width', lay.w).attr('height', H);
  const f: Frame = { w: lay.w, h: H, ...M };
  drawAxes(svg, f, lay.xTicks, lay.yTicks, titles, c, ms);

  const plot = layer(svg, 'plot');
  let roof: Sel = plot.select('path.roof');
  if (roof.empty()) roof = plot.append('path').attr('class', 'roof').attr('fill', 'none').attr('stroke-width', 2).attr('d', lay.path);
  roof.attr('stroke', c.roof);
  moving(roof, ms).attr('d', lay.path);

  let dot: Sel = plot.select('circle.now');
  if (dot.empty()) dot = plot.append('circle').attr('class', 'now').attr('r', 5).attr('cx', lay.dot.cx).attr('cy', lay.dot.cy);
  dot.attr('fill', c.dot);
  moving(dot, ms).attr('cx', lay.dot.cx).attr('cy', lay.dot.cy);

  const lb = keyed(plot, 'text', 'label', lay.labels, (d) => d.key, ms, (e) => e.attr('x', (d: Label) => d.x).attr('y', (d: Label) => d.y).attr('font-size', 11));
  lb.all
    .attr('fill', (d: Label) => (d.key === 'now' ? c.title : c.tick))
    .attr('text-anchor', (d: Label) => d.anchor)
    .text((d: Label) => d.text);
  lb.t.attr('x', (d: Label) => d.x).attr('y', (d: Label) => d.y);
}

/**
 * 專家用 Roofline（design §4 item 5「更多圖表」，demo v8 `Roofline`）：對數雙軸含單位與 10 的次方刻度；斜線為每張卡頻寬、
 * 水平線為每張卡峰值算力、點為目前一個 decode step 的（算術強度, 可達算力）。值全部來自 core `perf.usage.roofline`。
 */
export function Roofline({ roofline, unit = 'gpu', width }: { roofline: RooflineData; unit?: 'gpu' | 'machine'; width?: number }): JSX.Element {
  const { token } = theme.useToken();
  const tr = useT();
  const lang = useLang();
  const [wrap, measured] = useWidth<HTMLDivElement>();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<{ key: string; w: number } | null>(null);
  const fmt = (n: number, d = 0) => new Intl.NumberFormat(lang, { maximumFractionDigits: d }).format(n);
  const lay = layout(roofline, width ?? (measured || FALLBACK_WIDTH), fmt, tr);
  const titles = { x: tr('roofline.x'), y: tr(unit === 'machine' ? 'roofline.y.machine' : 'roofline.y.gpu') };
  const colors: Colors = {
    grid: token.colorBorderSecondary,
    axis: token.colorBorder,
    tick: token.colorTextTertiary,
    title: token.colorTextSecondary,
    roof: token.colorTextSecondary,
    dot: token.colorPrimary,
  };

  const key = JSON.stringify([lay, titles, colors]);
  useEffect(() => {
    const animate = prev.current !== null && prev.current.key !== key && prev.current.w === lay.w;
    prev.current = { key, w: lay.w };
    draw(ref.current!, lay, titles, colors, animate ? transitionMs() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  return (
    <div ref={wrap} style={{ width: '100%', minWidth: 0 }}>
      <svg ref={ref} className="chart" role="img" aria-label={`${titles.x} / ${titles.y}`} style={{ display: 'block' }} />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {tr('roofline.hint')}
      </Typography.Text>
    </div>
  );
}
