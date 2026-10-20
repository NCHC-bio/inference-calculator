import { theme, type ThemeConfig } from 'antd';
import { useEffect, useState } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Follows the system color scheme, including live changes. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    setDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function antdTheme(dark: boolean): ThemeConfig {
  return { algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm };
}
