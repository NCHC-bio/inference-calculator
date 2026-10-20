import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Explain } from '../src/components/Explain';
import { setMedia } from './setup';

// antd popups render first at opacity 0 while they align, so visibility is awaited rather than read on first match.
const shown = (text: string) => waitFor(() => expect(screen.getByText(text)).toBeVisible());
const hidden = (text: string) =>
  waitFor(() => {
    const el = screen.queryByText(text);
    if (el) expect(el).not.toBeVisible();
  });

describe('Explain', () => {
  it.each(['hover', 'click', 'focus'] as const)('opens on %s', async (how) => {
    render(<Explain content="說明"><button>x</button></Explain>); const u = userEvent.setup(); const el = screen.getByText('x');
    if (how === 'hover') await u.hover(el); else if (how === 'click') await u.click(el); else act(() => el.focus());
    await shown('說明');
  });

  // Touch: a tapped button may get no focus and no reliable mouseleave, so the popover needs other ways out.
  const openByTap = async () => {
    setMedia({ hoverNone: true });
    render(<div><Explain content="說明"><button>x</button></Explain><span>elsewhere</span></div>);
    fireEvent.pointerDown(screen.getByText('x'));
    fireEvent.click(screen.getByText('x'));
    await shown('說明');
  };
  it('closes on a pointerdown outside trigger and popup', async () => {
    await openByTap();
    fireEvent.pointerDown(screen.getByText('說明'));
    await shown('說明');
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    await hidden('說明');
  });
  it('closes on Escape', async () => {
    await openByTap();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await hidden('說明');
  });
  it('tapping the trigger again closes it; a focus-then-click press keeps it open', async () => {
    await openByTap();
    fireEvent.pointerDown(screen.getByText('x'));
    fireEvent.click(screen.getByText('x'));
    await hidden('說明');
    // Real taps on browsers that focus buttons: pointerdown → focus (opens) → click, which must not re-close it.
    fireEvent.pointerDown(screen.getByText('x'));
    act(() => screen.getByText('x').focus());
    fireEvent.click(screen.getByText('x'));
    await shown('說明');
  });
});
