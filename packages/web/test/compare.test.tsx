import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t, type MsgKey } from '../src/i18n';
import { getBundle } from '../src/bundle';
import { withQuant } from '../src/components/Workbench';
import { shown } from './helpers';

const zh = (k: MsgKey, v?: Record<string, string | number>) => t('zh-TW', k, v);
const H200 = 'nano4-h200';

beforeEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

const rowOf = (key: string) => screen.getAllByTestId('platform-row').find((x) => x.dataset.row === key)!;

/** Open the H200 row's workbench and press 加入比較. */
async function pin(): Promise<void> {
  if (!screen.queryByTestId('workbench')) await userEvent.click(within(rowOf(H200)).getByTestId('row-name'));
  const wb = await within(rowOf(H200)).findByTestId('workbench');
  await userEvent.click(within(wb).getByRole('button', { name: /加入比較/ }));
}
const dataRows = () => document.querySelectorAll('.compare-card tbody tr.ant-table-row');

describe('comparison table', { timeout: 20000 }, () => {
  it('appears after the first pin, with the eight columns', async () => {
    render(<App />);
    expect(screen.getByTestId('compare').closest('.reveal')).not.toHaveClass('on');
    await pin();
    const card = await screen.findByTestId('compare');
    expect(card.closest('.reveal')).toHaveClass('on');
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    for (const k of ['compare.platform', 'compare.count', 'compare.model', 'compare.users', 'compare.tps', 'compare.ttft', 'compare.max', 'compare.kw'] as const) {
      expect(within(card).getAllByText(zh(k)).length).toBeGreaterThan(0);
    }
    const p = getBundle().platforms[H200]!;
    expect(dataRows()[0]!.textContent).toContain(`${p.name} ${p.sub}`);
    expect(dataRows()[0]!.textContent).not.toMatch(/FP8（FP8）/);
    await shown(zh('pin.added'));
  });

  it('the 4th pin is rejected with a message', async () => {
    render(<App />);
    await pin();
    await pin();
    await pin();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    await pin();
    await shown(zh('pin.max', { n: 3 }));
    expect(dataRows()).toHaveLength(3);
  });

  it('delete removes one row; clear removes all and hides the card', async () => {
    render(<App />);
    await pin();
    await pin();
    await waitFor(() => expect(dataRows()).toHaveLength(2));
    await userEvent.click(within(dataRows()[0] as HTMLElement).getByRole('button', { name: zh('compare.delete') }));
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    await userEvent.click(screen.getByText(zh('compare.clear')));
    await waitFor(() => expect(screen.getByTestId('compare').closest('.reveal')).not.toHaveClass('on'));
  });

  it('pins are snapshots: changing users later leaves the row unchanged', async () => {
    render(<App />);
    await pin();
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    const before = dataRows()[0]!.textContent;
    const input = screen.getByRole('spinbutton', { name: zh('aria.users') });
    await userEvent.clear(input);
    await userEvent.type(input, '40{Enter}');
    await waitFor(() => expect(new URLSearchParams(location.search).get('n')).toBe('40'));
    expect(dataRows()[0]!.textContent).toBe(before);
  });
});

describe('footer honesty', () => {
  it('shows data version, accuracy link and the two not-included notes with hover explanations', async () => {
    render(<App />);
    const footer = document.querySelector('footer')!;
    expect(footer.textContent).toContain(getBundle().meta.dataVersion);
    expect(within(footer).getByText(zh('footer.cost'))).toBeInTheDocument();
    expect(within(footer).getByText(zh('footer.p95'))).toBeInTheDocument();
    await userEvent.hover(within(footer).getByText(zh('footer.cost')));
    await shown(zh('footer.cost.tip'));
    await userEvent.hover(within(footer).getByText(zh('footer.p95')));
    await shown(zh('footer.p95.tip'));
  });

  it('準確度 opens the accuracy dialog', async () => {
    render(<App />);
    await userEvent.click(within(document.querySelector('footer')!).getByText(zh('footer.accuracy')));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('model label', () => {
  it('skips the quant suffix when the name already contains it as a token', () => {
    expect(withQuant('Llama-3.3-70B-Instruct-FP8', 'FP8')).toBe('Llama-3.3-70B-Instruct-FP8');
    expect(withQuant('Llama-3.3-70B-Instruct-fp8', 'FP8')).toBe('Llama-3.3-70B-Instruct-fp8');
    expect(withQuant('gpt-oss-20b', 'MXFP4')).toBe('gpt-oss-20b（MXFP4）');
    expect(withQuant('Model-FP8', 'FP')).toBe('Model-FP8（FP）');
  });
});

describe('closed comparison', () => {
  it('the container is inert while there are no pins and not after one pin', { timeout: 20000 }, async () => {
    render(<App />);
    const reveal = screen.getByTestId('compare').closest('.reveal')!;
    const clear = () => screen.getByText(zh('compare.clear')).closest('button')!;
    expect(clear().closest('[inert]')).toBe(reveal);
    await pin();
    await waitFor(() => expect(clear().closest('[inert]')).toBeNull());
  });
});
