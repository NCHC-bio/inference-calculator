import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/** antd popups render first at opacity 0 while they align, so visibility is awaited rather than read on first match. */
export const shown = (text: string) => waitFor(() => expect(screen.getByText(text)).toBeVisible());
