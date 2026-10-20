import { fireEvent, screen } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { getBundle } from '../src/bundle';
import { AnswerLine } from '../src/components/AnswerLine';
import { computeView, type NeedView } from '../src/compute/compute';
import { defaultState } from '../src/state/state';
import { renderStore, shown } from './helpers';
import { setMedia } from './setup';

// No catalog input yields a 'user' value yet, so the view is the default one with hasUser set.
vi.mock('../src/compute/useResults', () => ({
  useView: () => {
    const b = getBundle();
    const v = computeView(b, defaultState(b)) as NeedView;
    return { ...v, result: { ...v.result, hasUser: true } };
  },
}));

describe('自訂 tag', () => {
  it('explains itself on tap, not only on hover (final review)', async () => {
    setMedia({ hoverNone: true });
    renderStore(<AnswerLine />);
    const tag = screen.getByText('自訂');
    fireEvent.pointerDown(tag, { pointerType: 'touch' });
    fireEvent.click(tag);
    await shown('結果用到你自訂的值');
  });
});
