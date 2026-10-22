import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { CompareCard } from '../src/components/CompareCard';
import { computeMain } from '../src/compute/compute';
import { rowPerf } from '../src/compute/query';
import { t, type MsgKey } from '../src/i18n';
import { decodeUrl, encodeUrl } from '../src/state/url';
import { defaultState, type CompareSpec } from '../src/state/state';
import { renderStore } from './helpers';

const zh = (k: MsgKey, v?: Record<string, string | number>) => t('zh-TW', k, v);
const b = getBundle();
const H200 = 'nano4-h200';
const H100 = 'nano5-h100';
const MAC = 'mac-studio-m5u-512';
const fmt = (n: number, d = 0) => new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

/** Search string with the given comparison lines (and chat, `users`). */
function search(lines: CompareSpec[], users = 60): string {
  const s0 = defaultState(b);
  const s = { ...decodeUrl(b, `w=chat&n=${users}`), compare: lines.map((l, i) => ({ ...l, id: i + 1, slot: i })) };
  return '?' + encodeUrl({ ...s0, ...s });
}

beforeEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

const rowOf = (key: string) => screen.getAllByTestId('platform-row').find((x) => x.dataset.row === key)!;
const card = () => screen.getByTestId('compare');
const lines = () => within(card()).queryAllByTestId('compare-line');
const isOpen = () => card().closest('.reveal')!.classList.contains('on');

describe('comparison card', { timeout: 30000 }, () => {
  it("is closed until a row's 比較 is checked, then shows one line; unchecking closes it", async () => {
    render(<App />);
    expect(isOpen()).toBe(false);
    await userEvent.click(within(rowOf(H200)).getByRole('checkbox', { name: zh('row.compare') }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(isOpen()).toBe(true);
    expect(screen.queryByTestId('workbench')).toBeNull();
    await userEvent.click(within(rowOf(H200)).getByRole('checkbox', { name: zh('row.compare') }));
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it('换一項比較 → 換模型 adds a line with the model in bold and the source count', async () => {
    history.replaceState(null, '', '/' + search([{ row: H200, gpus: 2 }]));
    render(<App />);
    await waitFor(() => expect(lines()).toHaveLength(1));
    await userEvent.click(within(lines()[0]!).getByRole('button', { name: new RegExp(zh('compare.variant')) }));
    await userEvent.click(await screen.findByText(zh('compare.variant.model')));
    await userEvent.click(await screen.findByText(new RegExp(`^${b.models['gpt-oss-20b']!.name}`)));
    await waitFor(() => expect(lines()).toHaveLength(2));
    const added = lines()[1]!;
    expect(within(added).getByText(b.models['gpt-oss-20b']!.name).tagName).toBe('B');
    expect(added.textContent).toContain('× 2');
  });

  it('其他精度各加一條 at four lines adds one and warns', async () => {
    history.replaceState(null, '', '/' + search([{ row: H200, model: 'gemma-4-31b-it' }, { row: H100 }, { row: MAC }, { row: H200, gpus: 1 }]));
    render(<App />);
    await waitFor(() => expect(lines()).toHaveLength(4));
    await userEvent.click(within(lines()[0]!).getByRole('button', { name: new RegExp(zh('compare.variant')) }));
    await userEvent.click(await screen.findByText(zh('compare.variant.quant')));
    await userEvent.click(await screen.findByText(zh('compare.variant.quantAll')));
    await waitFor(() => expect(lines()).toHaveLength(5));
    expect(await screen.findByText(zh('compare.partial', { n: 5, k: 1 }))).toBeInTheDocument();
    for (const l of lines()) expect(within(l).getByRole('button', { name: new RegExp(zh('compare.variant')) })).toBeDisabled();
  });

  it('a failing line shows 不達標 and 達不到 when it serves nobody', async () => {
    history.replaceState(null, '', '/' + search([{ row: H200, gpus: 1, inputTokens: 128000 }], 5000));
    render(<App />);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const l = lines()[0]!;
    expect(l.textContent).toMatch(new RegExp(`${zh('compare.unreachable')}|${zh('compare.nofit')}`));
  });

  it('an infeasible Mac row can be compared and shows its verdict', async () => {
    history.replaceState(null, '', `/?w=assist&n=5000`);
    render(<App />);
    const m = computeMain(b, decodeUrl(b, 'w=assist&n=5000'));
    expect(m.kind === 'main' && m.rows.find((r) => r.row === MAC)!.kind).toBe('infeasible');
    await userEvent.click(within(rowOf(MAC)).getByRole('checkbox', { name: zh('row.compare') }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]!.textContent).toMatch(new RegExp(`${zh('compare.nofit')}|不達標`));
  });

  it("values equal core: the H200 line's speed is rowPerf's", async () => {
    const q = search([{ row: H200 }]);
    history.replaceState(null, '', '/' + q);
    render(<App />);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const s = decodeUrl(b, q);
    const m = computeMain(b, s);
    const r = m.kind === 'main' ? m.rows.find((x) => x.row === H200) : undefined;
    if (r?.kind !== 'ok') throw new Error('H200 not ok');
    const p = rowPerf(b, s, H200, { gpus: r.count });
    expect(lines()[0]!.textContent).toContain(zh('compare.tps', { v: fmt(p.usage!.tokPerSecPerUser) }));
    expect(lines()[0]!.textContent).toContain(zh('compare.ok'));
  });

  it('a narrow container renders line cards instead of a table', () => {
    history.replaceState(null, '', '/' + search([{ row: H200 }, { row: H100 }]));
    renderStore(<CompareCard width={390} />);
    expect(card().querySelector('table')).toBeNull();
    expect(lines()).toHaveLength(2);
  });

  it('the cards chart shows only with two GPU setups; machines get a note', () => {
    history.replaceState(null, '', '/' + search([{ row: H200 }, { row: H100 }, { row: MAC }]));
    renderStore(<CompareCard width={1000} />);
    expect(screen.getByTestId('compare-cards-chart').closest('.reveal')).toHaveClass('on');
    expect(card().textContent).toContain(zh('compare.machines', { letters: 'C' }));
    cleanup();
    history.replaceState(null, '', '/' + search([{ row: H200 }]));
    renderStore(<CompareCard width={1000} />);
    expect(screen.getByTestId('compare-cards-chart').closest('.reveal')).not.toHaveClass('on');
  });

  it('delete and clear', async () => {
    history.replaceState(null, '', '/' + search([{ row: H200 }, { row: H100 }]));
    renderStore(<CompareCard width={1000} />);
    await userEvent.click(within(lines()[0]!).getByRole('button', { name: zh('compare.delete') }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    await userEvent.click(within(card()).getByRole('button', { name: zh('compare.clear') }));
    await waitFor(() => expect(card().closest('.reveal')).not.toHaveClass('on'));
  });

  it('dashes only distinguish: when every line uses estimates all lines are solid and the note says so', () => {
    history.replaceState(null, '', '/' + search([{ row: H200 }, { row: H100 }]));
    renderStore(<CompareCard width={1000} />);
    const s = decodeUrl(b, location.search);
    const m = computeMain(b, s);
    if (m.kind !== 'main') throw new Error('no main');
    const est = [H200, H100].map((row) => {
      const r = m.rows.find((x) => x.row === row)!;
      return r.kind === 'ok' && r.perf.hasEstimate;
    });
    expect(est.every(Boolean)).toBe(true);
    for (const p of card().querySelectorAll('path.series')) expect(p.getAttribute('stroke-dasharray')).toBeNull();
    expect(card().textContent).toContain(zh('compare.note.allEst'));
  });
});

