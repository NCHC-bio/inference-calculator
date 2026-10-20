export const TRANSITION_MS = 400;

/** Transition duration; 0 when the user prefers reduced motion. */
export function transitionMs(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : TRANSITION_MS;
}
