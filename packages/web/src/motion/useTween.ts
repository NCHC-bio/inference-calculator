import { useEffect, useRef, useState } from 'react';
import { transitionMs } from '../motion';

/** Ease-out cubic (d3's easeCubicOut), k in [0, 1]. */
const easeCubicOut = (k: number): number => 1 - (1 - k) ** 3;

/**
 * A number that tweens to `target`: from the value on screen (mid-tween included) over transitionMs(), ease-out
 * cubic. Reduced motion, or a non-finite start or target, jumps. A change of `key` (what the number is about, e.g. the
 * best platform) jumps too, in the same render: a count never rolls from one platform's number to another's.
 */
export function useTween(target: number, key?: unknown): number {
  const [value, setValue] = useState(target);
  const [shownKey, setShownKey] = useState(key);
  const shown = useRef(target);
  const instant = !Number.isFinite(target) || transitionMs() === 0;
  const rekeyed = !Object.is(shownKey, key);
  if (rekeyed) {
    // Adjusting state while rendering (React's documented pattern): the next render already shows `target`.
    setShownKey(key);
    setValue(target);
  }

  // A new key starts from `target`: declared first, so the tween below starts there and has nothing to roll.
  useEffect(() => {
    shown.current = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const from = shown.current;
    const dur = transitionMs();
    if (instant || !Number.isFinite(from) || from === target || dur === 0) {
      shown.current = target;
      setValue(target);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const v = k >= 1 ? target : from + (target - from) * easeCubicOut(k);
      shown.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, instant]);

  return instant || rekeyed ? target : value;
}
