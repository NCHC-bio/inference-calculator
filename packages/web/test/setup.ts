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

// jsdom has no ResizeObserver; antd popups (rc-trigger, virtual list) observe their size.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;


// jsdom never runs CSS animations, so animationend/transitionend never fire and rc-motion would leave popups at
// opacity 0 mid-"appear". rc-motion feature-detects support from the event constructors and the (vendor-prefixed)
// animation/transition style properties; removing them makes it skip motion. Runs before any test imports antd.
delete (window as { AnimationEvent?: unknown }).AnimationEvent;
delete (window as { TransitionEvent?: unknown }).TransitionEvent;
for (const prefix of ['Webkit', 'Moz', 'ms', 'O']) {
  for (const prop of ['Animation', 'Transition']) {
    for (let o: object | null = document.createElement('div').style; o; o = Object.getPrototypeOf(o)) delete (o as Record<string, unknown>)[prefix + prop];
  }
}

// jsdom does not implement getComputedStyle(el, pseudoElt) and logs "Not implemented" on every call; antd's Drawer
// (scroll locker measuring the scrollbar) passes '::-webkit-scrollbar'. Drop the pseudo-element argument.
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((el: Element) => computedStyle(el)) as typeof window.getComputedStyle;
