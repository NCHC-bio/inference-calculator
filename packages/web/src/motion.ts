/** The one motion token (design §3.6): antd (ConfigProvider token), D3 (easeCubicOut) and CSS (--motion-*) share it. */
export const TRANSITION_MS = 400;
/** Ease-out cubic as a CSS timing function; the same curve as d3's easeCubicOut. */
export const EASE = 'cubic-bezier(0.215, 0.61, 0.355, 1)';

/** Transition duration; 0 when the user prefers reduced motion. */
export function transitionMs(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : TRANSITION_MS;
}
