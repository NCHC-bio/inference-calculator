import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { computeView, type NeedView } from '../src/compute/compute';
import { decodeUrl } from '../src/state/url';
import { defaultState } from '../src/state/state';
import { setMedia } from './setup';

// mistral-medium only offers fp8, so `q=bf16` falls back to it; its weights still do not fit the 32 GB Mac mini.
const INFEASIBLE_MAC = '?m=mistral-medium-3.5-128b&q=bf16';

const rows = () => screen.getAllByTestId('platform-row');
const bestRow = () => rows().find((x) => x.dataset.best === 'true')!;

describe('PlatformList', () => {
  it('one row per platform in bundle order, self group after a divider', () => {
    render(<App />);
    expect(rows().map((r) => r.dataset.platform)).toEqual(Object.keys(getBundle().platforms));
    expect(screen.getByText('自建')).toBeInTheDocument();
  });
  it('best row is marked; its big number equals expected.gpus', () => {
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
    render(<App />);
    const best = bestRow();
    expect(best.dataset.platform).toBe(r.best);
    const p = r.perPlatform.find((x) => x.platform === r.best)!;
    expect(within(best).getByTestId('count')).toHaveTextContent(String(p.expected.ok && p.expected.gpus));
  });
  it('capacity bar reads 同時 {users} / {maxConcurrent} 人 from core', () => {
    const b = getBundle(); const s = defaultState(b); const r = (computeView(b, s) as NeedView).result;
    render(<App />);
    const p = r.perPlatform.find((x) => x.platform === r.best)!;
    expect(within(bestRow()).getByTestId('capacity')).toHaveTextContent(`同時 ${s.users} / ${p.maxConcurrent} 人`);
  });
  it('infeasible row shows one short reason, detail in a click popover', async () => {
    const b = getBundle(); const r = (computeView(b, decodeUrl(b, INFEASIBLE_MAC)) as NeedView).result;
    const mac = r.perPlatform.find((x) => x.platform === 'mac-mini-m6-32')!;
    expect(mac.expected.ok).toBe(false);
    history.replaceState(null, '', '/' + INFEASIBLE_MAC);
    render(<App />);
    const row = rows().find((x) => x.dataset.platform === 'mac-mini-m6-32')!;
    const tag = within(row).getByText(/^✗ /); await userEvent.click(tag);
    expect(await screen.findByRole('tooltip')).toBeVisible();
    expect(within(row).queryByTestId('capacity')).toBeNull();
    expect(tag).toHaveTextContent('✗ 模型放不下');
    const detail = mac.expected.ok ? '' : mac.expected.detail;
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(detail));
    expect(row).not.toHaveAttribute('aria-expanded');
  });
  it('feasible row toggles open by click and Enter', async () => {
    render(<App />); const row = bestRow();
    await userEvent.click(row); expect(row).toHaveAttribute('aria-expanded', 'true');
    row.focus(); await userEvent.keyboard('{Enter}'); expect(row).toHaveAttribute('aria-expanded', 'false');
  });
  it('touch: tapping the capacity bar opens its explanation without toggling the row (Review Focus 5)', async () => {
    setMedia({ hoverNone: true });
    render(<App />); const row = bestRow();
    await userEvent.click(within(row).getByTestId('capacity'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent('目前人數 / 這些機器在你要求的速度下最多能同時服務的人數');
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });
  it('have mode shows no platform rows', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('我已有的能撐多少'));
    await waitFor(() => expect(screen.queryAllByTestId('platform-row')).toHaveLength(0));
  });
});
