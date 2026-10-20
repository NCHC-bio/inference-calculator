import type { ShapeUsage } from '@nchc/core';
import { scaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import 'd3-transition';
import { theme } from 'antd';
import { useEffect, useRef, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { transitionMs } from '../motion';
import { Explain } from './Explain';

/** Layout only (no hardware values): a viewBox stretched to the container's width. */
const W = 300;
const H = 12;
/** Above this many resident users the KV cells merge into one continuous segment. */
const MAX_CELLS = 60;

type Kind = 'weights' | 'kv' | 'reserve' | 'free';
type Seg = { key: string; kind: Kind; x: number; w: number };
type Colors = { weights: string; kv: string; reserve: string; free: string; gap: string };
type Memory = ShapeUsage['memory'];

/** Weights, one KV cell per resident user (or one segment above MAX_CELLS), reserve, then the free space. */
function segments(m: Memory): { segs: Seg[]; full: boolean } {
  const used = m.weightsBytes + m.kvBytes + m.reserveBytes;
  const x = scaleLinear().domain([0, Math.max(m.usableBytes, used, 1)]).range([0, W]);
  const segs: Seg[] = [];
  let at = 0;
  const push = (key: string, kind: Kind, bytes: number) => {
    segs.push({ key, kind, x: x(at), w: x(at + bytes) - x(at) });
    at += bytes;
  };
  push('weights', 'weights', m.weightsBytes);
  const n = m.residentPerReplica;
  if (n > MAX_CELLS) push('kv-all', 'kv', m.kvBytes);
  else for (let i = 0; i < n; i++) push(`kv-${i}`, 'kv', m.kvBytes / n);
  push('reserve', 'reserve', m.reserveBytes);
  push('free', 'free', Math.max(0, m.usableBytes - used));
  return { segs, full: used >= m.usableBytes };
}

function draw(svgEl: SVGSVGElement, segs: Seg[], c: Colors, ms: number): void {
  const svg = select(svgEl);
  // A new state supersedes any running transition: stop it and drop cells still shrinking away.
  svg.selectAll('*').interrupt();
  svg.selectAll('rect.exit').remove();
  const colorOf = (d: Seg) => c[d.kind];

  const joined = svg.selectAll<SVGRectElement, Seg>('rect.seg:not(.exit)').data(segs, (d) => d.key);
  // New KV cells grow from their own left edge; everything else moves together (no stagger).
  const enter = joined
    .enter()
    .append('rect')
    .attr('class', 'seg')
    .attr('y', 0)
    .attr('height', H)
    .attr('x', (d) => d.x)
    .attr('width', 0)
    .attr('vector-effect', 'non-scaling-stroke');
  const all = enter
    .merge(joined)
    .attr('data-seg', (d) => d.kind)
    .attr('fill', colorOf)
    .attr('stroke', (d) => (d.kind === 'kv' ? c.gap : 'none'))
    .attr('stroke-width', 1)
    .order();
  const exit = joined.exit<Seg>().classed('exit', true).attr('data-seg', null);
  if (ms === 0) {
    exit.remove();
    all.attr('x', (d) => d.x).attr('width', (d) => d.w);
  } else {
    all
      .transition()
      .duration(ms)
      .attr('x', (d) => d.x)
      .attr('width', (d) => d.w);
    exit.transition().duration(ms).attr('width', 0).remove();
  }
}

const gb = (lang: string, bytes: number) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1e9);

/** 一根橫條：權重、每位常駐使用者一格 KV（超過 60 格改為連續一段）、保留區、剩餘空間；記憶體用滿時 KV 變紅。
 *  人數改變時，KV 格以 transitionMs() 長出或縮回（spec §8.3「加人時區塊一格格長出來」）。
 *  D3 owns the SVG's children; React renders only the element. */
export function MemoryBar({ memory }: { memory: Memory }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const ref = useRef<SVGSVGElement>(null);
  const prev = useRef<string | null>(null);
  const { segs, full } = segments(memory);
  const colors: Colors = {
    weights: token.purple,
    kv: full ? token.colorError : token.colorPrimary,
    reserve: token.colorWarningBorder,
    free: token.colorFillSecondary,
    gap: token.colorBgContainer,
  };
  const key = segs.map((s) => `${s.key}:${s.x}:${s.w}`).join('|');

  useEffect(() => {
    // Animate only when the composition changes (spec §8.3.1-4): first paint and theme changes apply at once.
    const changed = prev.current !== null && prev.current !== key;
    prev.current = key;
    draw(ref.current!, segs, colors, changed ? transitionMs() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, full, colors.weights, colors.kv, colors.reserve, colors.free, colors.gap]);

  useEffect(() => {
    const el = ref.current!;
    return () => {
      select(el).selectAll('*').interrupt();
    };
  }, []);

  const tip = tr('memory.tip', {
    weights: gb(lang, memory.weightsBytes),
    perUserKv: gb(lang, memory.perUserKvBytes),
    reserve: gb(lang, memory.reserveBytes),
  });
  return (
    <Explain content={<div style={{ maxWidth: 300 }}>{tip}</div>}>
      <div data-testid="memory-bar" tabIndex={0} role="img" aria-label={tr('memory.label')} style={{ cursor: 'help', margin: '8px 0 4px' }}>
        <svg
          ref={ref}
          aria-hidden="true"
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ display: 'block', borderRadius: token.borderRadiusXS, overflow: 'hidden' }}
        />
      </div>
    </Explain>
  );
}
