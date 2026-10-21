import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(within(row).queryByTestId('capacity')).toBeNull();
    expect(tag).toHaveTextContent('✗ 模型放不下');
    const detail = mac.expected.ok ? '' : mac.expected.detail;
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(detail));
    expect(within(row).queryByTestId('row-toggle')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
  });
  it('feasible row toggles open by click and Enter', async () => {
    render(<App />); const btn = within(bestRow()).getByTestId('row-toggle');
    expect(btn.tagName).toBe('BUTTON');
    await userEvent.click(btn); expect(btn).toHaveAttribute('aria-expanded', 'true');
    btn.focus(); await userEvent.keyboard('{Enter}'); expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
  it('the expand control is a real button; the row itself is not interactive (no nested interactive content)', () => {
    render(<App />); const row = bestRow(); const btn = within(row).getByTestId('row-toggle');
    expect(row).not.toHaveAttribute('role'); expect(row).not.toHaveAttribute('tabindex'); expect(row).not.toHaveAttribute('aria-expanded');
    expect(btn).toHaveAttribute('aria-controls');
    expect(within(btn).queryByTestId('capacity')).toBeNull();
  });
  it('a mouse click elsewhere on the row toggles it once', async () => {
    render(<App />); const row = bestRow(); const btn = within(row).getByTestId('row-toggle');
    await userEvent.click(within(row).getByTestId('count')); expect(btn).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(row).getByTestId('count')); expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
  it('touch: tapping the capacity bar opens its explanation without toggling the row (Review Focus 5)', async () => {
    setMedia({ hoverNone: true });
    render(<App />); const row = bestRow();
    await userEvent.click(within(row).getByTestId('capacity'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent('目前人數 / 這些機器在你要求的速度下最多能同時服務的人數');
    expect(within(row).getByTestId('row-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
  it('machine icons explain themselves on tap and on focus, without toggling the row (spec §8.3.3; final review I5)', async () => {
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
    const p = r.perPlatform.find((x) => x.platform === r.best)!;
    const plat = b.platforms[r.best!]!;
    const per = plat.gpusPerNode.value;
    if (!p.expected.ok) throw new Error('best is feasible');
    const cons = p.conservative.ok ? Math.max(0, Math.ceil(p.conservative.gpus / per) - Math.ceil(p.expected.gpus / per)) : 0;
    const label = `每個圖示是 1 個 node（${per} 張 GPU）：實心 ${Math.ceil(p.expected.gpus / per)} 個為預期，虛線 ${cons} 個為保守估計多出的`;
    setMedia({ hoverNone: true });
    render(<App />); const row = bestRow();
    // Hidden from the role query in jsdom: antd's xs={0} column rule applies without media-query evaluation.
    const icons = within(row).getByRole('img', { name: label, hidden: true });
    expect(icons).toHaveAttribute('tabindex', '0');
    await userEvent.click(icons);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent(label);
    expect(within(row).getByTestId('row-toggle')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    // jsdom will not focus inside a display:none column, so the focus event is dispatched directly.
    fireEvent.focusIn(icons);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
  });
  it("a platform beyond the size bound shows ✗ 規模超出上限 with core's detail (final review I2)", async () => {
    const url = '?m=gemma-4-26b-a4b-it&q=bf16&w=chat&n=200000';
    const b = getBundle(); const r = (computeView(b, decodeUrl(b, url)) as NeedView).result;
    const spark = r.perPlatform.find((x) => x.platform === 'dgx-spark')!;
    expect(!spark.expected.ok && spark.expected.why).toBe('scale');
    history.replaceState(null, '', '/' + url);
    render(<App />);
    const row = rows().find((x) => x.dataset.platform === 'dgx-spark')!;
    const tag = within(row).getByText(/^✗ /);
    expect(tag).toHaveTextContent('✗ 規模超出上限');
    await userEvent.click(tag);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(spark.expected.ok ? '' : spark.expected.detail));
  });
});
