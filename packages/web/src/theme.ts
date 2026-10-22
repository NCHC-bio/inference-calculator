import { theme, type ThemeConfig } from 'antd';
import { createContext, createElement, useContext, useState, type ReactNode } from 'react';
import { useMediaQuery } from './media';
import { EASE } from './motion';

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const THEME_MODE_KEY = 'theme-mode';

/**
 * The viewer's appearance choice (design v10). Per-viewer convenience: localStorage, never the URL or the store, so a
 * shared link cannot change the recipient's appearance. Every access is guarded; a blocked storage means 'system'.
 */
export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function writeThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') localStorage.removeItem(THEME_MODE_KEY);
    else localStorage.setItem(THEME_MODE_KEY, mode);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

const ThemeModeContext = createContext<{ mode: ThemeMode; setMode: (m: ThemeMode) => void }>({ mode: 'system', setMode: () => {} });

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState(readThemeMode);
  const setMode = (m: ThemeMode) => {
    setModeState(m);
    writeThemeMode(m);
  };
  return createElement(ThemeModeContext.Provider, { value: { mode, setMode } }, children);
}

export const useThemeMode = () => useContext(ThemeModeContext);

/** Dark when the viewer chose dark, or chose 'system' and the system color scheme is dark (live). */
export function useDarkMode(): boolean {
  const system = useMediaQuery('(prefers-color-scheme: dark)');
  const { mode } = useThemeMode();
  return mode === 'system' ? system : mode === 'dark';
}
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
