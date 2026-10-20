import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Explain } from '../src/components/Explain';

// antd popups render first at opacity 0 while they align, so visibility is awaited rather than read on first match.
const shown = (text: string) => waitFor(() => expect(screen.getByText(text)).toBeVisible());

describe('Explain', () => {
  it.each(['hover', 'click', 'focus'] as const)('opens on %s', async (how) => {
    render(<Explain content="說明"><button>x</button></Explain>); const u = userEvent.setup(); const el = screen.getByText('x');
    if (how === 'hover') await u.hover(el); else if (how === 'click') await u.click(el); else act(() => el.focus());
    await shown('說明');
  });
});
