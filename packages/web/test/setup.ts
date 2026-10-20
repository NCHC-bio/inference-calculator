import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

export interface MediaState {
  dark?: boolean;
  reducedMotion?: boolean;
  hoverNone?: boolean;
}

type Listener = (e: MediaQueryListEvent) => void;

let state: Required<MediaState> = { dark: false, reducedMotion: false, hoverNone: false };
const queries = new Set<{ query: string; listeners: Set<Listener> }>();

function matches(query: string): boolean {
  if (query.includes('prefers-color-scheme: dark')) return state.dark;
  if (query.includes('prefers-reduced-motion: reduce')) return state.reducedMotion;
  if (query.includes('hover: none')) return state.hoverNone;
  return false;
}

/** Switch the mocked media features; live MediaQueryLists notify their listeners. */
export function setMedia(next: MediaState): void {
  state = { ...state, ...next };
  for (const q of queries) {
    const ev = { matches: matches(q.query), media: q.query } as MediaQueryListEvent;
    for (const l of q.listeners) l(ev);
  }
}

window.matchMedia = ((query: string): MediaQueryList => {
  const entry = { query, listeners: new Set<Listener>() };
  queries.add(entry);
  return {
    get matches() {
      return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
    removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
    addListener: (l: Listener) => entry.listeners.add(l),
    removeListener: (l: Listener) => entry.listeners.delete(l),
    dispatchEvent: () => false,
  } as MediaQueryList;
}) as typeof window.matchMedia;

beforeEach(() => {
  state = { dark: false, reducedMotion: false, hoverNone: false };
  history.replaceState(null, '', '/');
});
afterEach(cleanup);
