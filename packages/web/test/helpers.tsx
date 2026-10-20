import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect } from 'vitest';
import { StoreProvider } from '../src/state/store';

/** antd popups render first at opacity 0 while they align, so visibility is awaited rather than read on first match. */
export const shown = (text: string) => waitFor(() => expect(screen.getByText(text)).toBeVisible());

/** Render under the central store (components using useT / useLang need it). */
export const renderStore = (ui: ReactElement): RenderResult => render(<StoreProvider>{ui}</StoreProvider>);
