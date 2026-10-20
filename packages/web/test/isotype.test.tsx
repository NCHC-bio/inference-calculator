import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Isotype } from '../src/components/Isotype';
import { setMedia } from './setup';

const count = (c: HTMLElement, kind: string) => c.querySelectorAll(`[data-icon="${kind}"]`).length;

describe('Isotype', () => {
  it('icons: ceil(gpus / gpusPerNode) solid, extra conservative ones dashed', () => {
    const { container } = render(<Isotype expectedGpus={12} conservativeGpus={20} gpusPerNode={8} unit="gpu" />);
    expect(container.querySelectorAll('[data-icon="solid"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-icon="dashed"]')).toHaveLength(1);
  });
  it('reduced motion: final state applied with no transition', () => {
    setMedia({ reducedMotion: true });
    const { container, rerender } = render(<Isotype expectedGpus={8} conservativeGpus={8} gpusPerNode={8} unit="gpu" />);
    rerender(<Isotype expectedGpus={24} conservativeGpus={24} gpusPerNode={8} unit="gpu" />);
    expect(container.querySelectorAll('[data-icon="solid"]')).toHaveLength(3);
    expect(container.querySelector('[data-ghost]')).toBeNull();
  });
  it('a partial node fills only its share of the icon', () => {
    const { container } = render(<Isotype expectedGpus={4} conservativeGpus={4} gpusPerNode={8} unit="gpu" />);
    const icon = container.querySelector('[data-icon="solid"]')!;
    const outline = icon.querySelector('.outline')!; const fill = icon.querySelector('.fill')!;
    expect(Number(fill.getAttribute('width'))).toBeCloseTo(Number(outline.getAttribute('width')) / 2);
  });
  it('machines: one icon per machine; null conservative means no dashed icons', () => {
    const { container } = render(<Isotype expectedGpus={3} conservativeGpus={null} gpusPerNode={1} unit="machine" />);
    expect(count(container, 'solid')).toBe(3);
    expect(count(container, 'dashed')).toBe(0);
  });
  it('count change: final icons at once, previous state kept as a ghost for one transition', async () => {
    const { container, rerender } = render(<Isotype expectedGpus={24} conservativeGpus={24} gpusPerNode={8} unit="gpu" />);
    expect(container.querySelector('[data-ghost]')).toBeNull();
    rerender(<Isotype expectedGpus={8} conservativeGpus={16} gpusPerNode={8} unit="gpu" />);
    expect(count(container, 'solid')).toBe(1);
    expect(count(container, 'dashed')).toBe(1);
    expect(container.querySelector('[data-ghost]')).not.toBeNull();
    await waitFor(() => expect(container.querySelector('[data-ghost]')).toBeNull());
    expect(container.querySelectorAll('g.icon')).toHaveLength(2);
  });
  it('rerender with the same counts does not leave a ghost', () => {
    const { container, rerender } = render(<Isotype expectedGpus={8} conservativeGpus={8} gpusPerNode={8} unit="gpu" />);
    rerender(<Isotype expectedGpus={8} conservativeGpus={8} gpusPerNode={8} unit="gpu" />);
    expect(container.querySelector('[data-ghost]')).toBeNull();
  });
});
