import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ShapeUsage } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { MemoryBar } from '../src/components/MemoryBar';
import { UsageBars } from '../src/components/UsageBars';
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
  it('caption names each colour with its size and the user count', () => {
    renderStore(<MemoryBar memory={mem(6)} />);
    expect(screen.getByTestId('memory-caption')).toHaveTextContent('紫：模型 4.0 GB；藍：每人上下文 0.5 GB × 6 人；黃：保留 1.0 GB；灰：剩餘');
  });
  it('caption leaves out an empty reserve', () => {
    renderStore(<MemoryBar memory={{ ...mem(2), reserveBytes: 0 }} />);
    expect(screen.getByTestId('memory-caption')).toHaveTextContent(/^紫：模型 4\.0 GB；藍：每人上下文 0\.5 GB × 2 人；灰：剩餘$/);
  });
});
