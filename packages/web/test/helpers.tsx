import { App as AntApp } from 'antd';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect } from 'vitest';
import { StoreProvider } from '../src/state/store';

/**
 * antd popups render first at opacity 0 while they align, so visibility is awaited rather than read on first match.
 * 5 s, not waitFor's 1 s default: under the full parallel `pnpm test` (CI) an App-level popup can take longer to show.
 */
export const shown = (text: string) => waitFor(() => expect(screen.getByText(text)).toBeVisible(), { timeout: 5_000 });

/** Render under the central store (components using useT / useLang need it). */
export const renderStore = (ui: ReactElement): RenderResult => render(
    <StoreProvider>
      <AntApp>{ui}</AntApp>
    </StoreProvider>,
  );
