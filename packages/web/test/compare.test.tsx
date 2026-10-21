import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t, type MsgKey } from '../src/i18n';
import { getBundle } from '../src/bundle';
import { withQuant } from '../src/components/Workbench';
import { CUSTOM_MODEL_WARNING } from '@nchc/core';
import { useEffect } from 'react';
import { CompareTable } from '../src/components/CompareTable';
import type { Action, Pin } from '../src/state/state';
import { useCalc } from '../src/state/store';
import { renderStore, shown } from './helpers';

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

  it('each pin keeps its trust flags: a miss, 推估, 自訂 and the custom-model warning (review I2)', async () => {
    const base: Omit<Pin, 'id'> = { platform: { row: 'p', name: 'P', sub: '' }, unit: 'gpu', count: 8, model: { name: 'M', quant: null }, users: 15, tps: 30, ttft: 1, max: 40, kw: null, ok: true, hasEstimate: false, hasUser: false, warnings: [] };
    const pins: Omit<Pin, 'id'>[] = [
      { ...base, platform: { row: 'p', name: 'Plain', sub: '' } },
      { ...base, platform: { row: 'p', name: 'Missed', sub: '' }, ok: false, hasEstimate: true, hasUser: true, warnings: [CUSTOM_MODEL_WARNING] },
    ];
    function Seed() {
      const [, dispatch] = useCalc();
      useEffect(() => {
        for (const pin of pins) dispatch({ type: 'pin', pin });
      }, [dispatch]);
      return null;
    }
    await act(async () => {
      renderStore(
        <>
          <CompareTable />
          <Seed />
        </>,
      );
    });
    await waitFor(() => expect(dataRows()).toHaveLength(2));
    const [plain, missed] = [...dataRows()] as HTMLElement[];
    expect(within(plain!).getByLabelText(zh('compare.ok'))).toBeInTheDocument();
    expect(within(plain!).queryByText(zh('tag.estimate'))).toBeNull();
    expect(within(plain!).queryByText(zh('tag.user'))).toBeNull();
    expect(within(missed!).getByLabelText(zh('compare.miss'))).toBeInTheDocument();
    expect(within(missed!).getByText(zh('tag.estimate'))).toBeInTheDocument();
    expect(within(missed!).getByText(zh('tag.user'))).toBeInTheDocument();
    expect(within(screen.getByTestId('compare')).getAllByText(CUSTOM_MODEL_WARNING.text)).toHaveLength(1);
  });
});

describe('pins follow the current language (v8 minor 6)', () => {
  it('a pin made in zh-TW is formatted in en after the switch; its values stay frozen', async () => {
    const pins: Omit<Pin, 'id'>[] = [
      {
        platform: { row: 'custom:0', name: 'Lab GPU', sub: { key: 'platforms.customSub', vars: { mem: 80, gpn: 8, engine: 'vLLM' } } },
        unit: 'gpu',
        count: 1200,
        model: { name: 'gpt-oss-20b', quant: 'MXFP4' },
        users: 1500,
        tps: 31.4,
        ttft: null,
        max: 2400,
        kw: 1.25,
        ok: true,
        hasEstimate: false,
        hasUser: false,
        warnings: [],
      },
    ];
    let send: (a: Action) => void = () => {};
    function Seed() {
      const [, dispatch] = useCalc();
      send = dispatch;
      useEffect(() => {
        for (const pin of pins) dispatch({ type: 'pin', pin });
      }, [dispatch]);
      return null;
    }
    await act(async () => {
      renderStore(
        <>
          <CompareTable />
          <Seed />
        </>,
      );
    });
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    const cells = () => [...(dataRows()[0] as HTMLElement).querySelectorAll('td')].map((td) => td.textContent);
    expect(cells().slice(0, 8)).toEqual([
      'Lab GPU 80 GB × 8／台・vLLM',
      '1,200 張',
      'gpt-oss-20b（MXFP4）',
      '1,500',
      '31',
      zh('status.unverified'),
      '2,400',
      '1.3',
    ]);
    act(() => send({ type: 'lang', lang: 'en' }));
    const en = (k: MsgKey) => t('en', k);
    await waitFor(() => expect(cells()[1]).toBe('1,200 GPUs'));
    expect(cells().slice(0, 8)).toEqual([
      'Lab GPU 80 GB × 8 per machine · vLLM',
      '1,200 GPUs',
      'gpt-oss-20b (MXFP4)',
      '1,500',
      '31',
      en('status.unverified'),
      '2,400',
      '1.3',
    ]);
    expect(screen.getByTestId('compare').querySelector('thead')!.textContent).toContain(en('compare.platform'));
  });

  it('a real pin, then the language switch: the count unit turns English, the numbers stay', async () => {
    render(<App />);
    await pin();
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    const cells = () => [...(dataRows()[0] as HTMLElement).querySelectorAll('td')].map((td) => td.textContent ?? '');
    const before = cells();
    expect(before[1]).toMatch(/ 張$/);
    await userEvent.click(screen.getByText(zh('lang.en')));
    await waitFor(() => expect(cells()[1]).toMatch(/ GPUs$/));
    const after = cells();
    expect(after[1]!.replace(' GPUs', '')).toBe(before[1]!.replace(' 張', ''));
    expect(after.slice(3, 8)).toEqual(before.slice(3, 8));
  });
});
