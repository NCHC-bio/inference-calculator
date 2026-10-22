import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStore as render } from './helpers';
import { CompareChart, LETTERS, SERIES, type CompareChartProps, type CompareSeries } from '../src/components/CompareChart';

const line = (slot: number, ys: [number, number][], extra: Partial<CompareSeries> = {}): CompareSeries => ({
  key: `k${slot}`,
  slot,
  dashed: false,
  points: ys.map(([x, y]) => ({ x, y })),
  ...extra,
});

const props = (over: Partial<CompareChartProps> = {}): CompareChartProps => ({
  series: [],
  x: { min: 1, max: 1000, log: true },
  xTitle: 'X',
  yTitle: 'Y',
  band: { y: 20, dir: 'above' },
  hover: null,
  onHover: () => {},
  tip: { x: (v) => `x${Math.round(v)}`, y: (v) => `${Math.round(v)} t/s` },
  label: 'chart',
  width: 600,
  ...over,
});

const xTicks = (root: Element) => [...root.querySelectorAll('g.x-axis g.tick text')].map((e) => e.textContent);

describe('CompareChart', () => {
  it('draws one path per series in its slot colour; estimate lines are dashed', () => {
    const { container } = render(
      <CompareChart {...props({ series: [line(0, [[1, 50], [100, 30]]), line(2, [[1, 40], [500, 10]], { dashed: true })] })} />,
    );
    const paths = [...container.querySelectorAll('path.series')];
    expect(paths).toHaveLength(2);
    expect(paths[0]!.getAttribute('stroke')).toBe(SERIES.light[0]);
    expect(paths[1]!.getAttribute('stroke')).toBe(SERIES.light[2]);
    expect(paths[0]!.getAttribute('stroke-dasharray')).toBeNull();
    expect(paths[1]!.getAttribute('stroke-dasharray')).toBe('6 4');
  });

  it('labels each line with its letter at the end, at least 12 px apart', () => {
    const { container } = render(<CompareChart {...props({ series: [line(0, [[1, 30], [1000, 30]]), line(2, [[1, 30.2], [1000, 30.2]])] })} />);
    const letters = [...container.querySelectorAll('text.end-letter')];
    expect(letters.map((e) => e.textContent).sort()).toEqual([LETTERS[0], LETTERS[2]]);
    const ys = letters.map((e) => Number(e.getAttribute('y')));
    expect(Math.abs(ys[0]! - ys[1]!)).toBeGreaterThanOrEqual(12);
  });

  it('cap labels closer than 64 px keep only the first', () => {
    const series = [
      line(0, [[1, 50], [100, 20]], { cap: { x: 100, y: 20, label: '最多 100' } }),
      line(1, [[1, 40], [120, 20]], { cap: { x: 120, y: 20, label: '最多 120' } }),
    ];
    const { container } = render(<CompareChart {...props({ series })} />);
    expect(container.querySelectorAll('circle.cap')).toHaveLength(2);
    expect([...container.querySelectorAll('text.cap-label')].map((e) => e.textContent)).toEqual(['最多 100']);
  });

  it('log ticks are 1-2-5 per decade, only powers of ten when narrow', () => {
    const wide = render(<CompareChart {...props()} />);
    expect(xTicks(wide.container)).toEqual(['1', '2', '5', '10', '20', '50', '100', '200', '500', '1,000']);
    wide.unmount();
    const narrow = render(<CompareChart {...props({ width: 360 })} />);
    expect(xTicks(narrow.container)).toEqual(['1', '10', '100', '1,000']);
  });

  it('reports the x under the pointer', () => {
    const onHover = vi.fn();
    const { container } = render(<CompareChart {...props({ onHover, x: { min: 0, max: 100, log: false } })} />);
    const svg = container.querySelector('svg')!;
    fireEvent.mouseMove(svg, { clientX: 46 + (600 - 46 - 24) / 2 });
    expect(onHover).toHaveBeenCalled();
    expect(onHover.mock.calls[0]![0]).toBeCloseTo(50, 0);
    fireEvent.mouseLeave(svg);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('the tooltip lists every line at the hovered x, — outside its range', () => {
    const series = [line(0, [[1, 50], [100, 30]]), line(1, [[1, 40], [5, 35]])];
    const { container } = render(<CompareChart {...props({ series, hover: 10 })} />);
    const tip = container.querySelector('.cmp-tip')!;
    expect(tip.textContent).toContain('x10');
    expect(tip.textContent).toMatch(/A\s*\d+ t\/s/);
    expect(tip.textContent).toMatch(/B\s*—/);
  });

  it('empty series draws axes and no NaN', () => {
    const { container } = render(<CompareChart {...props({ refLine: { x: 60, label: '你的 60 人' } })} />);
    expect(container.querySelector('svg')!.innerHTML).not.toContain('NaN');
    expect(container.querySelectorAll('g.x-axis g.tick').length).toBeGreaterThan(0);
    expect(container.querySelector('g.ref text')!.textContent).toBe('你的 60 人');
  });
});
