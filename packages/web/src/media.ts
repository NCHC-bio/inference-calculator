import { useEffect, useState } from 'react';

/** Live `matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Touch-first devices: no hover, so descriptions are shown inline instead of on hover. */
export const useHoverNone = (): boolean => useMediaQuery('(hover: none)');
