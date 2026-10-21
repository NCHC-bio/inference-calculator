import { theme, type ThemeConfig } from 'antd';
import { useMediaQuery } from './media';
import { EASE } from './motion';

/** Follows the system color scheme, including live changes. */
export const useDarkMode = (): boolean => useMediaQuery('(prefers-color-scheme: dark)');
export const useReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)');

/**
 * antd theme with the shared motion token (design §3.6): 400 ms, ease-out cubic. Reduced motion turns antd motion off and
 * sets every duration to 0: `motion: false` alone leaves CSS transitions that read the duration tokens (the Collapse arrow,
 * Progress bars) running at 400 ms.
 */
export function antdTheme(dark: boolean, reducedMotion = false): ThemeConfig {
  const d = (s: string) => (reducedMotion ? '0s' : s);
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      motion: !reducedMotion,
      motionDurationFast: d('0.2s'),
      motionDurationMid: d('0.4s'),
      motionDurationSlow: d('0.4s'),
      motionEaseOut: EASE,
      motionEaseInOut: EASE,
    },
  };
}
