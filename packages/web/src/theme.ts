import { theme, type ThemeConfig } from 'antd';
import { useMediaQuery } from './media';
import { EASE } from './motion';

/** Follows the system color scheme, including live changes. */
export const useDarkMode = (): boolean => useMediaQuery('(prefers-color-scheme: dark)');
export const useReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)');

/** antd theme with the shared motion token (design §3.6): 400 ms, ease-out cubic; reduced motion turns antd motion off. */
export function antdTheme(dark: boolean, reducedMotion = false): ThemeConfig {
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      motion: !reducedMotion,
      motionDurationFast: '0.2s',
      motionDurationMid: '0.4s',
      motionDurationSlow: '0.4s',
      motionEaseOut: EASE,
      motionEaseInOut: EASE,
    },
  };
}
