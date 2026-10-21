import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/en';
import zhTW from '../src/i18n/zh-TW';
import { t } from '../src/i18n';
import { EASE, TRANSITION_MS, transitionMs } from '../src/motion';
import { useTween } from '../src/motion/useTween';
import { setMedia } from './setup';

describe('motion', () => {
  it('reduced motion → 0 ms, otherwise 400', () => {
    setMedia({ reducedMotion: true });
    expect(transitionMs()).toBe(0);
    setMedia({ reducedMotion: false });
    expect(transitionMs()).toBe(400);
    expect(TRANSITION_MS).toBe(400);
    expect(EASE).toBe('cubic-bezier(0.215, 0.61, 0.355, 1)');
  });
});

describe('useTween', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('reduced motion: equals the target at once', () => {
    setMedia({ reducedMotion: true });
    const { result, rerender } = renderHook(({ v }) => useTween(v), { initialProps: { v: 0 } });
    rerender({ v: 100 });
    expect(result.current).toBe(100);
  });
  it('animates from the value on screen to the target over TRANSITION_MS', () => {
    const { result, rerender } = renderHook(({ v }) => useTween(v), { initialProps: { v: 0 } });
    expect(result.current).toBe(0);
    rerender({ v: 100 });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current).not.toBe(100);
    expect(result.current).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(TRANSITION_MS);
    });
    expect(result.current).toBe(100);
  });
  it('a new target mid-way starts from the value on screen', () => {
    const { result, rerender } = renderHook(({ v }) => useTween(v), { initialProps: { v: 0 } });
    rerender({ v: 100 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const mid = result.current;
    rerender({ v: 0 });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toBeLessThan(mid);
    expect(result.current).toBeGreaterThan(0);
  });
  it('non-finite targets jump', () => {
    const { result, rerender } = renderHook(({ v }) => useTween(v), { initialProps: { v: 0 } });
    rerender({ v: Number.POSITIVE_INFINITY });
    expect(result.current).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('i18n', () => {
  it('every zh-TW key exists in en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
  });
  it('interpolates {name} vars', () => {
    expect(t('zh-TW', 'footer.dataVersion', { version: 'x1' })).toBe('資料版本 x1');
  });
});
