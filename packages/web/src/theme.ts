import { theme, type ThemeConfig } from 'antd';
import { useMediaQuery } from './media';

/** Follows the system color scheme, including live changes. */
export const useDarkMode = (): boolean => useMediaQuery('(prefers-color-scheme: dark)');

export function antdTheme(dark: boolean): ThemeConfig {
  return { algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm };
}
