import { fireEvent, screen, waitFor } from '@testing-library/react';
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { Isotype, isotypeLayout } from '../src/components/Isotype';
import { renderStore } from './helpers';
import { setMedia } from './setup';
import { StoreProvider } from '../src/state/store';

type N = Parameters<typeof isotypeLayout>[0];
const gpu = (expected: number, conservative: number | null = null): N => ({ expected, conservative, unit: 'gpu', gpusPerNode: 8 });
const mac = (expected: number, conservative: number | null = null): N => ({ expected, conservative, unit: 'machine', gpusPerNode: 1 });

describe('isotypeLayout', () => {
  it('fits small counts without a brace', () => {
    const a = isotypeLayout(gpu(16), 300);
    expect(a.fits).toBe(true);
    expect(a.slots).toHaveLength(2);
    expect(a.slots[1]!.fill).toBe(1);
    expect(isotypeLayout(gpu(12), 300).slots[1]!.fill).toBe(0.5);
  });
  it('marks conservative-only slots dashed', () => {
    const a = isotypeLayout(gpu(12, 24), 300);
    expect(a.slots.map((s) => s.dashed)).toEqual([false, false, true]);
  });
  it('elides with a brace', () => {
    const a = isotypeLayout(gpu(480), 200);
    expect(a.fits).toBe(false);
    expect(a.total).toBe(60);
    const k = a.slots.length / 2;
    expect(k).toBeGreaterThanOrEqual(1);
    expect(a.slots.slice(0, k).map((s) => s.index)).toEqual(Array.from({ length: k }, (_, i) => i));
    expect(a.slots[a.slots.length - 1]!.index).toBe(59);
    expect(a.label).toBe('× 60 node・480 張');
    const b = isotypeLayout(gpu(480, 576), 200);
    expect(b.label).toBe('× 60 node・480 張（保守 576）');
    expect(b.slots[b.slots.length - 1]!.dashed).toBe(true);
  });
  it('labels Macs in machines', () => {
    expect(isotypeLayout(mac(20), 100).label).toBe('× 20 台');
  });
});

describe('Isotype', () => {
  it('machines are grey wide blocks, GPUs are blue tall ones', () => {
    const token = theme.getDesignToken();
    const m = renderStore(<Isotype expected={3} conservative={null} unit="machine" gpusPerNode={1} />);
    const out = m.container.querySelector('g.icon .outline')!;
    expect(out.getAttribute('width')).toBe('20');
    expect(out.getAttribute('height')).toBe('13');
    expect(m.container.querySelector('g.icon .fill')!.getAttribute('fill')).toBe(token.colorTextTertiary);
    m.unmount();
    const g = renderStore(<Isotype expected={8} conservative={null} unit="gpu" gpusPerNode={8} />);
    expect(g.container.querySelector('g.icon .outline')!.getAttribute('width')).toBe('12');
    expect(g.container.querySelector('g.icon .outline')!.getAttribute('height')).toBe('22');
    expect(g.container.querySelector('g.icon .fill')!.getAttribute('fill')).toBe(token.colorPrimary);
  });
  it('a partial node fills only its share of the height', () => {
    const { container } = renderStore(<Isotype expected={4} conservative={null} unit="gpu" gpusPerNode={8} />);
    expect(Number(container.querySelector('g.icon .fill')!.getAttribute('height'))).toBeCloseTo(11);
  });
  it('draws a brace and the label when the icons do not fit', () => {
    const { container } = renderStore(<Isotype expected={4000} conservative={null} unit="gpu" gpusPerNode={8} />);
    expect(container.querySelector('path.brace')).not.toBeNull();
    expect(container.textContent).toContain('× 500 node・4,000 張');
  });
  it('reduced motion: final state applied at once', () => {
    setMedia({ reducedMotion: true });
    const { container, rerender } = renderStore(<Isotype expected={8} conservative={8} unit="gpu" gpusPerNode={8} />);
    rerender(<StoreProvider><Isotype expected={24} conservative={24} unit="gpu" gpusPerNode={8} /></StoreProvider>);
    expect(container.querySelectorAll('g.icon')).toHaveLength(3);
  });
  it('the hover legend explains the icon', async () => {
    const g = renderStore(<Isotype expected={8} conservative={null} unit="gpu" gpusPerNode={8} />);
    fireEvent.focusIn(g.getByRole('img', { hidden: true }));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('每個方塊 = 1 個 node（8 張 GPU）；未滿一個 node 時只填滿用到的比例；實心為預期，虛線為保守估計多出的部分'));
    g.unmount();
    const m = renderStore(<Isotype expected={3} conservative={null} unit="machine" gpusPerNode={1} />);
    fireEvent.focusIn(m.getByRole('img', { hidden: true }));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('每個方塊 = 1 台；實心為預期需要，虛線為保守估計多出的台數'));
  });
});
