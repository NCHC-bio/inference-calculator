import { useEffect, useRef, useState } from 'react';
import { transitionMs } from '../motion';

/** Ease-out cubic (d3's easeCubicOut), k in [0, 1]. */
const easeCubicOut = (k: number): number => 1 - (1 - k) ** 3;

/**
 * A number that tweens to `target`: from the value on screen (mid-tween included) over transitionMs(), ease-out
 * cubic. Reduced motion, or a non-finite start or target, jumps.
 */
export function useTween(target: number): number {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  const instant = !Number.isFinite(target) || transitionMs() === 0;

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

  return instant ? target : value;
}
