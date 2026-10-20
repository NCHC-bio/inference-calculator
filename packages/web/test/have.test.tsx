import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { computeView, type HaveView } from '../src/compute/compute';
import { defaultState, reduce } from '../src/state/state';
import { decodeUrl } from '../src/state/url';

const go = (q: string) => {
  history.replaceState(null, '', '/?mode=have&' + q);
  render(<App />);
};

describe('have mode', () => {
  it('answer equals estimateCapacity expected.n and shows the full-load line with detail', () => {
    const b = getBundle();
    go('hp=nano4-h200&have=16');
    const r = computeView(b, decodeUrl(b, location.search)) as HaveView;
    expect(screen.getByTestId('answer-main')).toHaveTextContent(new Intl.NumberFormat('zh-TW').format(r.result.expected.n));
    expect(screen.getByText(/滿載時/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`同時 ${new Intl.NumberFormat('zh-TW').format(r.result.expected.n)} 人`))).toBeInTheDocument();
    expect(screen.getByTestId('row-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-list')).not.toBeInTheDocument();
  });

  it('shows the next-user bottleneck line when core reports one', () => {
    const b = getBundle();
    go('hp=nano4-h200&have=16');
    const r = computeView(b, decodeUrl(b, location.search)) as HaveView;
    if (r.result.bottleneck !== null) expect(screen.getByText(/再多 1 人會：/)).toBeInTheDocument();
    else expect(screen.queryByText(/再多 1 人會/)).not.toBeInTheDocument();
  });

  it('nobody fits: error alert with core detail', () => {
    const b = getBundle();
    go('hp=mac-mini-m6-32&have=1&m=mistral-medium-3.5-128b&q=bf16');
    const r = computeView(b, decodeUrl(b, location.search)) as HaveView;
    expect(r.result.expected.n).toBe(0);
    const alert = screen.getByTestId('have-error');
    expect(within(alert).getByText(r.result.detail!)).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByTestId('row-detail')).not.toBeInTheDocument();
  });

  it('Mac platform says 台', () => {
    go('hp=mac-studio-m5u-512&have=2');
    expect(screen.getByTestId('sentence')).toHaveTextContent('台');
  });

  it('GPU platform says 張', () => {
    go('hp=nano4-h200&have=16');
    expect(screen.getByTestId('sentence')).toHaveTextContent('張');
  });

  it('haveCount survives a platform change', () => {
    const b = getBundle();
    const s = reduce(b, { ...defaultState(b), haveCount: 7 }, { type: 'havePlatform', id: 'mac-studio-m5u-512' });
    expect(s.haveCount).toBe(7);
  });
});
