import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingDemo } from '../src/components/TypingDemo';
import { StoreProvider } from '../src/state/store';
import { renderStore } from './helpers';
import { setMedia } from './setup';

const typed = () => screen.getByTestId('typed').textContent!;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('TypingDemo', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('waits ttft, then reveals tokPerSec chars per second', () => {
    renderStore(<TypingDemo text="一二三四五六七八九十" tokPerSec={4} ttftSec={2} />);
    advance(1900); expect(screen.getByTestId('typed')).toHaveTextContent(/^$/);
    advance(1100); expect(typed().length).toBe(4);
  });
  it('holds the full text 1.5 s, then replays from the wait', () => {
    renderStore(<TypingDemo text="一二三四" tokPerSec={4} ttftSec={1} />);
    advance(2000); expect(typed()).toBe('一二三四');
    advance(1400); expect(typed()).toBe('一二三四');
    advance(200); expect(typed()).toBe('');
  });
  it('restarts when the props change', () => {
    const el = (text: string) => (
      <StoreProvider>
        <TypingDemo text={text} tokPerSec={4} ttftSec={1} />
      </StoreProvider>
    );
    const { rerender } = render(el('一二三四'));
    advance(1500); expect(typed()).toBe('一二');
    rerender(el('甲乙丙丁'));
    expect(typed()).toBe('');
    advance(1250); expect(typed()).toBe('甲');
  });
  it('continues from current progress when speed changes', () => {
    const text = '一'.repeat(60);
    const el = (tps: number) => (
      <StoreProvider>
        <TypingDemo text={text} tokPerSec={tps} ttftSec={0} />
      </StoreProvider>
    );
    const { rerender } = render(el(10));
    advance(1000); expect(typed().length).toBeGreaterThanOrEqual(9); expect(typed().length).toBeLessThanOrEqual(11);
    rerender(el(40));
    advance(500); expect(typed().length).toBeGreaterThanOrEqual(28); expect(typed().length).toBeLessThanOrEqual(31);
  });
  it('keeps typing when the first-word wait rises mid-text', () => {
    const text = '一'.repeat(60);
    const el = (ttft: number) => (
      <StoreProvider>
        <TypingDemo text={text} tokPerSec={10} ttftSec={ttft} />
      </StoreProvider>
    );
    const { rerender } = render(el(0.5));
    advance(1000); const before = typed().length; expect(before).toBeGreaterThan(0);
    rerender(el(3));
    advance(500); expect(typed().length).toBeGreaterThanOrEqual(before + 4);
    expect(screen.queryByTestId('waiting')).toBeNull();
  });
  it('restarts when the row changes, not when the speed does', () => {
    const el = (reset: string, tps: number) => (
      <StoreProvider>
        <TypingDemo text="一二三四五六七八" tokPerSec={tps} ttftSec={0} reset={reset} />
      </StoreProvider>
    );
    const { rerender } = render(el('a', 4));
    advance(1000); expect(typed()).toBe('一二三四');
    rerender(el('a', 8)); expect(typed()).toBe('一二三四');
    rerender(el('b', 8)); expect(typed()).toBe('');
  });
  it('waiting for the first word shows a spinning hourglass, no emoji', () => {
    renderStore(<TypingDemo text="一二三" tokPerSec={4} ttftSec={2} />);
    advance(100);
    const w = screen.getByTestId('waiting');
    expect(w.querySelector('[aria-label="hourglass"]')).not.toBeNull();
    expect(w.querySelector('.anticon-spin')).not.toBeNull();
    expect(w.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it('clears its timers on unmount', () => {
    const { unmount } = renderStore(<TypingDemo text="一二三" tokPerSec={4} ttftSec={1} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reduced motion shows the whole text at once, with the wait and speed', () => {
    setMedia({ reducedMotion: true });
    renderStore(<TypingDemo text="一二三" tokPerSec={4} ttftSec={2} />);
    expect(screen.getByTestId('typed')).toHaveTextContent('一二三');
    expect(document.body.textContent).toContain('先等 2 秒出現第一個字，之後每秒約 4 字');
    expect(vi.getTimerCount()).toBe(0);
  });
});
