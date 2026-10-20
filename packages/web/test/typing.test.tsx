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
