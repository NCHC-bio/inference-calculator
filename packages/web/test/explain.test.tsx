import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { shown } from './helpers';
import { Explain } from '../src/components/Explain';
import { setMedia } from './setup';

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

  it('mouse: a click while hover-opened keeps it open (click is open-only for a mouse; final review)', async () => {
    render(<Explain content="說明"><button>x</button></Explain>); const u = userEvent.setup(); const el = screen.getByText('x');
    await u.hover(el);
    await shown('說明');
    fireEvent.pointerDown(el, { pointerType: 'mouse' });
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 300));
    await shown('說明');
    // A second mouse click does not toggle it closed either.
    fireEvent.pointerDown(el, { pointerType: 'mouse' });
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 300));
    await shown('說明');
  });
  it('mouse: a click on a closed trigger opens it', async () => {
    render(<Explain content="說明"><button>x</button></Explain>); const el = screen.getByText('x');
    fireEvent.pointerDown(el, { pointerType: 'mouse' });
    fireEvent.click(el);
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
