import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBundle } from '../src/bundle';
import { PlatformList } from '../src/components/PlatformList';
import { Roofline } from '../src/components/Roofline';
import { SpeedChart, speedZones } from '../src/components/SpeedChart';
import { niceTicks, powerTicks } from '../src/components/ticks';
import { computeBench, computeMain, type MainView, type OkRow } from '../src/compute/compute';
import { t, type MsgKey } from '../src/i18n';
import { decodeUrl } from '../src/state/url';
import { StoreProvider, useCalc } from '../src/state/store';
import type { CalcState } from '../src/state/state';
import { renderStore } from './helpers';

const zh = (k: MsgKey, v?: Record<string, string | number>) => t('zh-TW', k, v);
const fmt = (n: number) => new Intl.NumberFormat('zh-TW').format(n);
const H200 = 'nano4-h200';
const MAC = 'mac-mini-m6-32';
const W = 400;

const rowOf = (key: string) => screen.getAllByTestId('platform-row').find((x) => x.dataset.row === key)!;
const main = (search: string) => computeMain(getBundle(), decodeUrl(getBundle(), search)) as MainView & { kind: 'main' };
const okRow = (search: string, key: string) => main(search).rows.find((r) => r.row === key) as OkRow;

let latest: CalcState | null = null;
function Probe() {
  latest = useCalc()[0];
  return null;
}

async function openBench(search: string, key = H200): Promise<HTMLElement> {
  history.replaceState(null, '', '/' + search);
  renderStore(
    <>
      <PlatformList />
      <Probe />
    </>,
  );
  await userEvent.click(within(rowOf(key)).getByTestId('row-name'));
  return within(rowOf(key)).findByTestId('workbench');
}

const ticks = (root: Element, axis: 'x' | 'y') => [...root.querySelectorAll(`g.${axis}-axis g.tick text`)].map((e) => e.textContent ?? '');
const title = (root: Element, axis: 'x' | 'y') => root.querySelector(`text.${axis}-title`)?.textContent;
/** The x pixel of an x tick (its group is translated there). */
const tickX = (root: Element, label: string) => {
  const g = [...root.querySelectorAll('g.x-axis g.tick')].find((e) => e.querySelector('text')?.textContent === label)!;
  return Number(/translate\(([-\d.]+)/.exec(g.getAttribute('transform')!)![1]);
};

const zones = speedZones(getBundle(), zh);
const pts = (ys: (number | null)[]) => ys.map((y, i) => ({ x: i + 1, y }));
const chart = (props: Partial<Parameters<typeof SpeedChart>[0]> = {}) => (
  <StoreProvider>
    <SpeedChart width={W} points={pts([5, 9, 14, 18, 22, 25, 27, 28, 29, 30])} xTitle="x" yTitle="y" marks={[]} zones={zones} {...props} />
  </StoreProvider>
);

beforeEach(() => history.replaceState(null, '', '/'));

describe('ticks', () => {
  it('niceTicks is linear().nice().ticks', () => {
    expect(niceTicks(0, 33, 4)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(1, 8, 6)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('powerTicks are the powers of ten spanning the range', () => {
    expect(powerTicks(3, 1500)).toEqual([1, 10, 100, 1000, 10000]);
  });
});

describe('SpeedChart', () => {
  it('axes have tick values and unit titles', async () => {
    const r = okRow('', H200);
    const wb = await openBench('');
    const cards = within(wb).getByTestId('chart-cards');
    const users = within(wb).getByTestId('chart-users');
    for (const c of [cards, users]) {
      expect(ticks(c, 'y').length).toBeGreaterThanOrEqual(3);
      expect(ticks(c, 'x').length).toBeGreaterThanOrEqual(3);
      expect(title(c, 'y')).toBe('每人速度（字/秒）');
      expect(c.querySelectorAll('line.grid').length).toBeGreaterThanOrEqual(3);
    }
    expect(title(cards, 'x')).toBe('GPU 張數（張）・15 人同時使用');
    expect(title(users, 'x')).toBe(`同時使用人數（人）・${fmt(r.count)} 張`);
    expect(r.count).toBe(4);
  });

  it('Mac x title counts machines', async () => {
    const search = '?m=gpt-oss-20b&s=ok&n=15';
    const r = okRow(search, MAC);
    const wb = await openBench(search, MAC);
    expect(title(within(wb).getByTestId('chart-cards'), 'x')).toBe('機器台數（台）・15 人同時使用');
    expect(title(within(wb).getByTestId('chart-users'), 'x')).toBe(`同時使用人數（人）・${fmt(r.count)} 台`);
  });

  it('zones come from speed presets', () => {
    const mins = Object.values(getBundle().speedPresets)
      .map((p) => p.minTokensPerSec.value)
      .sort((a, b) => b - a);
    expect(zones.map((z) => z.lo)).toEqual([...mins, 0]);
    expect(zones.map((z) => z.hi)).toEqual([Infinity, ...mins]);
    expect(zones.map((z) => z.tone)).toEqual(['success', 'warning', 'error']);
    expect(zones[2]!.name).toBe('卡頓');

    const { container } = render(chart());
    expect(container.querySelectorAll('rect.zone')).toHaveLength(3);
    // y up to ~1000: the 8–20 zone is under 14 px tall and drops its name; the top zone keeps it.
    const tall = render(chart({ points: pts([10, 500, 1000]) }));
    const names = [...tall.container.querySelectorAll('text.zone-name')].map((e) => e.textContent);
    expect(names).toContain(zones[0]!.name);
    expect(names).not.toContain(zones[1]!.name);
  });

  it('click sets the count', () => {
    const onPick = vi.fn();
    const { container } = render(chart({ onPick }));
    const svg = container.querySelector('svg')!;
    fireEvent.click(svg, { clientX: tickX(container, '6') + 3 });
    expect(onPick).toHaveBeenLastCalledWith(6);
    fireEvent.click(svg, { clientX: 2 });
    expect(onPick).toHaveBeenLastCalledWith(1);
  });

  it('null points break the line', () => {
    const { container } = render(chart({ points: pts([10, 12, null, 15, 16]) }));
    const d = container.querySelector('path.line')!.getAttribute('d')!;
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('points that miss the target are drawn dashed', () => {
    const points = [...pts([30, 25, 20]), { x: 4, y: 15, miss: true }, { x: 5, y: 10, miss: true }];
    const { container } = render(chart({ points }));
    const over = container.querySelector('path.line-miss')!;
    expect(over.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(over.getAttribute('d')!.match(/M/g)).toHaveLength(1);
  });

  it('marks are drawn with labels', () => {
    const marks = [
      { key: 's', x: 4, label: '建議', tone: 'muted' as const, dashed: true },
      { key: 'c', x: 6, y: 25, label: '目前', tone: 'primary' as const },
    ];
    const { container } = render(chart({ marks }));
    expect([...container.querySelectorAll('g.mark text')].map((e) => e.textContent)).toEqual(['建議', '目前']);
    expect(container.querySelectorAll('g.mark circle')).toHaveLength(1);
  });

  it('hover shows the point note', async () => {
    const { container } = render(chart({ pointNote: (x) => `note ${x}` }));
    fireEvent.mouseMove(container.querySelector('svg')!, { clientX: tickX(container, '6') });
    await waitFor(() => expect(screen.getByTestId('chart-note').textContent).toBe('note 6'));
  });
});

describe('cards chart: fastest split (Ruling W9)', () => {
  const r = okRow('', H200);
  const bench = computeBench(getBundle(), decodeUrl(getBundle(), ''), r);
  /** Click the cards chart at count `n` (pixel from the linear map through the first two x ticks). */
  const clickCount = (wb: HTMLElement, n: number) => {
    const c = within(wb).getByTestId('chart-cards');
    const [u, v] = ticks(c, 'x');
    const [a, b] = [tickX(c, u!), tickX(c, v!)];
    const [x0, x1] = [Number(u), Number(v)];
    fireEvent.click(c.querySelector('svg')!, { clientX: a + ((n - x0) * (b - a)) / (x1 - x0) });
  };

  it('plots the fastest ok split: the default curve never drops as cards are added', async () => {
    const wb = await openBench('');
    const d = within(wb).getByTestId('chart-cards').querySelector('path.line')!.getAttribute('d')!;
    const ys = [...d.matchAll(/[ML][-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(8);
    // SVG y grows downward: a speed that never drops is a y that never grows.
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
  });

  it('clicking a count whose fastest split differs sets that split', async () => {
    const pt = bench.sweep.find((p) => p.gpus !== r.suggested && p.fastest && p.shape && p.fastest.shape.tp !== p.shape.tp)!;
    expect(pt).toBeDefined();
    const wb = await openBench('');
    clickCount(wb, pt.gpus);
    await waitFor(() => expect(latest!.overrides[H200]).toEqual({ gpus: pt.gpus, tp: pt.fastest!.shape.tp }));
  });

  it('clicking a count whose fastest split is the default sets only the count', async () => {
    const pt = bench.sweep.find((p) => p.gpus !== r.suggested && p.fastest && p.shape && p.fastest.shape.tp === p.shape.tp)!;
    expect(pt).toBeDefined();
    const wb = await openBench('');
    clickCount(wb, pt.gpus);
    await waitFor(() => expect(latest!.overrides[H200]).toEqual({ gpus: pt.gpus }));
  });

  it('clicking the suggested count with the recommended split clears the override', async () => {
    const sug = bench.sweep.find((p) => p.gpus === r.suggested)!;
    expect(sug.fastest!.shape.tp).toBe(sug.shape!.tp);
    const other = bench.sweep.find((p) => p.gpus > r.suggested + 1 && p.fastest)!;
    const wb = await openBench(`?o=${H200}:${other.gpus}`);
    expect(latest!.overrides[H200]).toBeDefined();
    clickCount(wb, r.suggested);
    await waitFor(() => expect(latest!.overrides[H200]).toBeUndefined());
  });
});

describe('Roofline', () => {
  const roofline = { peakTflopsPerGpu: 989, memBwTBsPerGpu: 4.8, intensityFlopPerByte: 40, achievedTflopsPerGpu: 120 };

  it('Roofline axes are log with units', () => {
    const { container } = render(
      <StoreProvider>
        <Roofline roofline={roofline} width={W} />
      </StoreProvider>,
    );
    expect(title(container, 'x')).toBe('算術強度（FLOP/byte，對數）');
    expect(title(container, 'y')).toBe('每張卡可達算力（TFLOPS，對數）');
    for (const axis of ['x', 'y'] as const) {
      const vs = [...container.querySelectorAll(`g.${axis}-axis g.tick`)].map((g) => Number(g.getAttribute('data-v')));
      expect(vs.length).toBeGreaterThanOrEqual(2);
      for (const v of vs) expect(Math.log10(v) % 1).toBe(0);
    }
    const xs = [...container.querySelectorAll('g.x-axis g.tick')].map((g) => Number(/translate\(([-\d.]+)/.exec(g.getAttribute('transform')!)![1]));
    expect(W - Math.max(...xs)).toBeGreaterThanOrEqual(28);
    expect(container.querySelector('circle.now')).not.toBeNull();
  });

  it('opens from the workbench footer', async () => {
    const wb = await openBench('');
    await userEvent.click(within(wb).getByText('更多圖表（Roofline，專家用）'));
    const rf = await within(wb).findByTestId('chart-roofline');
    await waitFor(() => expect(rf.querySelector('text.x-title')?.textContent).toBe('算術強度（FLOP/byte，對數）'));
  });
});

describe('chart screen-reader labels (v8 minor 9)', () => {
  const nf = (n: number, d = 0) => new Intl.NumberFormat('zh-TW', { maximumFractionDigits: d }).format(n);

  it('the cards and users charts are role=img with a summary of what they draw', async () => {
    const r = okRow('', H200);
    const bench = computeBench(getBundle(), decodeUrl(getBundle(), ''), r);
    const wb = await openBench('');
    const xs = bench.sweep.map((p) => p.gpus);
    const u = r.perf.usage!;
    const cards = within(within(wb).getByTestId('chart-cards')).getByRole('img');
    expect(cards.tagName.toLowerCase()).toBe('svg');
    expect(cards).toHaveAttribute(
      'aria-label',
      `張數 → 每人速度：${nf(Math.min(...xs))} 到 ${nf(Math.max(...xs))} 張，目前 ${nf(r.count)} 張每人 ${nf(u.tokPerSecPerUser)} 字/秒，建議 ${nf(r.suggested)} 張`,
    );
    const pts = bench.userCurve!.points.map((p) => p.users);
    const users = within(within(wb).getByTestId('chart-users')).getByRole('img');
    expect(users).toHaveAttribute(
      'aria-label',
      `人數 → 每人速度：${nf(Math.min(...pts))} 到 ${nf(Math.max(...pts))} 人，目前 15 人每人 ${nf(u.tokPerSecPerUser)} 字/秒，上限 ${nf(r.perf.maxConcurrent)} 人`,
    );
  });

  it('the Roofline label states its roof and the current point', () => {
    const roofline = { peakTflopsPerGpu: 989, memBwTBsPerGpu: 4.8, intensityFlopPerByte: 40.25, achievedTflopsPerGpu: 120.5 };
    render(
      <StoreProvider>
        <Roofline roofline={roofline} width={W} />
      </StoreProvider>,
    );
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Roofline：每張卡峰值算力 989 TFLOPS、頻寬 4.8 TB/s，目前算術強度 40.3 FLOP/byte、可達 120.5 TFLOPS');
  });
});
