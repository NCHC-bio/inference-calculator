import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StoreProvider, useCalc } from '../src/state/store';

let dispatch!: ReturnType<typeof useCalc>[1];
function Probe() {
  dispatch = useCalc()[1];
  return null;
}

describe('store', () => {
  it('writes the URL on mount and after every dispatch, even if rejected', () => {
    render(<StoreProvider><Probe /></StoreProvider>);
    expect(window.location.search).toContain('n=15');
    act(() => dispatch({ type: 'users', value: 200 }));
    expect(window.location.search).toContain('n=200');
    act(() => dispatch({ type: 'users', value: 0 }));
    expect(window.location.search).toContain('n=200');
    history.replaceState(null, '', '/?n=7');
    act(() => dispatch({ type: 'users', value: 0 }));
    expect(window.location.search).toContain('n=200');
  });
});
