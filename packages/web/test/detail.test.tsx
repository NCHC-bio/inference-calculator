import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ShapeUsage } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { computeView, type NeedView } from '../src/compute/compute';
import { MemoryBar } from '../src/components/MemoryBar';
import { rowDetailId } from '../src/components/PlatformRow';
import { RowDetail } from '../src/components/RowDetail';
import { UsageBars } from '../src/components/UsageBars';
import { defaultState } from '../src/state/state';
import { StoreProvider } from '../src/state/store';
import { renderStore, shown } from './helpers';
import { setMedia } from './setup';

// Test fixture values (not hardware data): 10 GB usable, 4 GB weights, 1 GB reserve, 0.5 GB per user.
const mem = (resident: number): ShapeUsage['memory'] => ({
  usableBytes: 10e9,
  weightsBytes: 4e9,
  kvBytes: resident * 0.5e9,
  reserveBytes: 1e9,
  perUserKvBytes: 0.5e9,
  residentPerReplica: resident,
});
const usage = (over: Partial<ShapeUsage> = {}): ShapeUsage => ({
  shape: { tp: 4, replicas: 3 },
  memory: mem(6),
  share: { mem: 0.3, bw: 0.8, compute: 0.1, ttft: 0.5 },
  tokPerSecPerUser: 20,
  ttftSec: 1.2,
  roofline: { peakTflopsPerGpu: 100, memBwTBsPerGpu: 1, intensityFlopPerByte: 10, achievedTflopsPerGpu: 5 },
  ...over,
});
const kvCells = (c: HTMLElement) => c.querySelectorAll('[data-seg="kv"]').length;

// rerender replaces the whole tree, so the provider is part of what is rerendered (same element type: no remount).
const inStore = (memory: ShapeUsage['memory']) => (
  <StoreProvider>
    <MemoryBar memory={memory} />
  </StoreProvider>
);

describe('UsageBars', () => {
  it('largest share is the red bar', () => {
    renderStore(<UsageBars share={{ mem: 0.3, bw: 0.8, compute: 0.1, ttft: 0.5 }} />);
    expect(screen.getByText('頻寬')).toHaveAttribute('data-bottleneck', 'true');
    expect(screen.getByText('記憶體')).not.toHaveAttribute('data-bottleneck');
  });
  it('bars never auto-turn green at 100%', () => {
    const { container } = renderStore(<UsageBars share={{ mem: 1, bw: 1, compute: 1, ttft: 1 }} />);
    expect(container.querySelector('.ant-progress-status-success')).toBeNull();
  });
  it('four bars in order; percent = min(100, round(share × 100))', () => {
    renderStore(<UsageBars share={{ mem: 0.304, bw: 1.7, compute: 0.1, ttft: 0.555 }} />);
    expect(screen.getAllByTestId('usage-bar').map((b) => b.dataset.bar)).toEqual(['mem', 'bw', 'compute', 'ttft']);
    expect(screen.getAllByTestId('usage-bar').map((b) => b.dataset.percent)).toEqual(['30', '100', '10', '56']);
  });
  it('each bar explains itself', async () => {
    renderStore(<UsageBars share={{ mem: 0.3, bw: 0.8, compute: 0.1, ttft: 0.5 }} />);
    await userEvent.click(screen.getByText('首字'));
    await shown('首字等待時間佔你要求上限的比例');
  });
});

describe('MemoryBar', () => {
  it('weights, one KV cell per resident user, reserve, free space', () => {
    const { container } = renderStore(<MemoryBar memory={mem(6)} />);
    const segs = [...container.querySelectorAll('[data-seg]')].map((n) => n.getAttribute('data-seg'));
    expect(segs).toEqual(['weights', 'kv', 'kv', 'kv', 'kv', 'kv', 'kv', 'reserve', 'free']);
  });
  it('more than 60 users: KV becomes one continuous segment', () => {
    const { container } = renderStore(<MemoryBar memory={{ ...mem(61), usableBytes: 100e9 }} />);
    expect(kvCells(container)).toBe(1);
  });
  it('adding users grows KV cells, removing shrinks them (final state)', async () => {
    const { container, rerender } = render(inStore(mem(2)));
    expect(kvCells(container)).toBe(2);
    rerender(inStore(mem(5)));
    expect(kvCells(container)).toBe(5);
    rerender(inStore(mem(3)));
    expect(kvCells(container)).toBe(3);
    // Shrinking cells leave the DOM when their transition ends.
    await waitFor(() => expect(container.querySelectorAll('rect')).toHaveLength(1 + 3 + 2));
  });
  it('reduced motion: removed cells are gone at once', () => {
    setMedia({ reducedMotion: true });
    const { container, rerender } = render(inStore(mem(5)));
    rerender(inStore(mem(1)));
    expect(container.querySelectorAll('rect')).toHaveLength(4);
  });
  it('explains in GB with one decimal', async () => {
    renderStore(<MemoryBar memory={mem(6)} />);
    await userEvent.click(screen.getByTestId('memory-bar'));
    await shown('模型 4.0 GB；每人上下文 0.5 GB；保留 1.0 GB');
  });
});

describe('RowDetail', () => {
  it('GB200 null TDP → 功耗未查證 with the note (Review Focus 4)', async () => {
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result.perPlatform.find((p) => p.platform === 'nano4-gb200')!;
    expect(r.expected.ok).toBe(true);
    expect(r.powerKw).toBeNull();
    expect(r.powerNote).toBeTruthy();
    renderStore(<RowDetail usage={r.usage!} unit="gpu" power={{ kw: r.powerKw, note: r.powerNote }} demoText="x" />);
    expect(screen.getByText('功耗未查證')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
    await userEvent.click(screen.getByText('功耗未查證'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent(r.powerNote!);
  });
  it('in the list, the GB200 power popover adds the bundle TDP record’s reason', async () => {
    const b = getBundle();
    const why = b.hardware[b.platforms['nano4-gb200']!.hardware]!.tdpW.conflict!;
    render(<App />);
    const row = screen.getAllByTestId('platform-row').find((x) => x.dataset.platform === 'nano4-gb200')!;
    await userEvent.click(within(row).getByTestId('row-toggle'));
    const detail = document.getElementById(rowDetailId('nano4-gb200'))!;
    await userEvent.click(within(detail).getByText('功耗未查證'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent(`功耗未查證：${why}`);
  });
  it('GPU: shape and peak power with one decimal', () => {
    renderStore(<RowDetail usage={usage()} unit="gpu" power={{ kw: 12.345 }} demoText="x" />);
    expect(screen.getByText('每副本 4 張 GPU × 3 個副本')).toBeInTheDocument();
    expect(screen.getByText('峰值功耗約 12.3 kW')).toBeInTheDocument();
  });
  it('Mac: machine count; no power prop → no power line', () => {
    renderStore(<RowDetail usage={usage({ shape: { tp: 1, replicas: 2 } })} unit="machine" demoText="x" />);
    expect(screen.getByText('2 台')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/功耗/);
  });
  it('queueing: one sentence, reason in the popover', async () => {
    const q = { tokensPerStep: 1, budget: 1, decodingMax: 1, waiting: 1, waitSec: 2.25, reason: '排隊原因' };
    renderStore(<RowDetail usage={usage()} unit="gpu" demoText="x" queueing={q} />);
    const s = screen.getByText('尖峰時部分請求需排隊約 2.3 秒，已計入首字時間');
    await userEvent.click(s);
    await shown('排隊原因');
  });
  it('no queueing → no queue sentence', () => {
    renderStore(<RowDetail usage={usage()} unit="gpu" demoText="x" queueing={null} />);
    expect(document.body.textContent).not.toMatch(/排隊/);
  });
  it('opens under the row with the toggle-controlled id and core data', async () => {
    const b = getBundle(); const s = defaultState(b); const res = (computeView(b, s) as NeedView).result;
    const p = res.perPlatform.find((x) => x.platform === res.best)!;
    render(<App />);
    const row = screen.getAllByTestId('platform-row').find((x) => x.dataset.platform === res.best)!;
    expect(document.getElementById(rowDetailId(res.best!))).toBeNull();
    await userEvent.click(within(row).getByTestId('row-toggle'));
    const detail = document.getElementById(rowDetailId(res.best!))!;
    expect(detail).toBeInTheDocument();
    expect(within(detail).getAllByTestId('usage-bar')).toHaveLength(4);
    expect(within(detail).getAllByTestId('memory-bar')).toHaveLength(1);
    expect(detail.textContent).toContain(`每副本 ${p.usage!.shape.tp} 張 GPU × ${p.usage!.shape.replicas} 個副本`);
    expect(detail.textContent).not.toMatch(/NaN/);
  });
});
