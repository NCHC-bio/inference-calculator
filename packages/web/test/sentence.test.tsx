import { quantOptions } from '@nchc/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderStore, shown } from './helpers';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { computeMain, modelOptionNotes } from '../src/compute/compute';
import { Sentence } from '../src/components/Sentence';
import { decodeUrl } from '../src/state/url';
import { USERS_MAX, type Action } from '../src/state/state';
import { useCalc } from '../src/state/store';
import { setMedia } from './setup';

// antd 6 puts aria-label on the combobox <input>; the displayed selection is the surrounding .ant-select-content.
const selection = (label: string) => screen.getByLabelText(label).closest('.ant-select-content');
const menu = () => document.querySelector<HTMLElement>('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
/** The <div class="opt-desc"> under the option whose label is `label` (inside the open menu). */
const descOf = (label: string) => within(menu()).getByTitle(label).querySelector('.opt-desc');

/** Shows the dialog-related state and keeps dispatch reachable for the test. */
let send: (a: Action) => void = () => {};
function Probe() {
  const [s, dispatch] = useCalc();
  send = dispatch;
  return <output data-testid="probe">{JSON.stringify({ dialog: s.dialog, hfQuery: s.hfQuery, workload: s.workload, speed: s.speed, customModel: s.customModel })}</output>;
}
const probe = () => JSON.parse(screen.getByTestId('probe').textContent!) as { dialog: string | null; hfQuery: string };
const renderSentence = () => renderStore(<><Sentence /><Probe /></>);

const NOTE_RE = /^可在 \d+ \/ \d+ 種機台執行$|^目前設定下所有機台都跑不動$/;

describe('Sentence', () => {
  it('keeps the full sentence (spec §8.3.3: no "·" fields), one nowrap clause per field', () => {
    render(<App />);
    const s = screen.getByTestId('sentence');
    for (const part of ['同時最多有', '人會使用，', '做', '任務，', '模型用', '模型精度用', '希望回應速度']) expect(s.textContent).toContain(part);
    expect(s.textContent).not.toContain('·');
    expect(s.querySelectorAll(':scope > .clause')).toHaveLength(5);
  });

  it('operating each select in turn leaves the others unchanged (spec §8.3.3 demo 缺陷)', async () => {
    render(<App />);
    const u = userEvent.setup();
    const pick = async (label: string, option: string) => {
      await u.click(screen.getByLabelText(label));
      await u.click(await within(menu()).findByTitle(option));
      await waitFor(() => expect(selection(label)).toHaveTextContent(option));
    };
    await pick('工作', '一般對話問答');
    await pick('速度', '可接受');
    await pick('模型', getBundle().models['gpt-oss-120b']!.name);
    expect(selection('工作')).toHaveTextContent('一般對話問答');
    expect(selection('速度')).toHaveTextContent('可接受');
  }, 20_000);

  it('typing an invalid user count keeps the last valid value', async () => {
    render(<App />);
    const u = userEvent.setup();
    const n = screen.getByLabelText('同時人數');
    // Replace the whole text in one step (no clear-then-type race with the re-rendered value).
    await u.type(n, '0', { initialSelectionStart: 0, initialSelectionEnd: (n as HTMLInputElement).value.length });
    await waitFor(() => expect(n).toHaveValue('0'));
    await u.tab();
    await waitFor(() => expect(n).toHaveValue('15'));
    expect(new URLSearchParams(location.search).get('n')).toBe('15');
  });

  it('an out-of-range count is marked invalid with its range while typed; the URL keeps the last valid (final review I3)', async () => {
    render(<App />);
    const u = userEvent.setup();
    const n = screen.getByLabelText('同時人數');
    expect(n).not.toHaveAttribute('aria-invalid', 'true');
    await u.type(n, '30000000', { initialSelectionStart: 0, initialSelectionEnd: (n as HTMLInputElement).value.length });
    await waitFor(() => expect(n).toHaveAttribute('aria-invalid', 'true'));
    expect(n.closest('.ant-input-number')).toHaveClass('ant-input-number-status-error');
    const hint = screen.getByText('請輸入 1–10,000,000 的整數');
    expect(hint).toBeVisible();
    expect(n.getAttribute('aria-describedby')!.split(' ')).toContain(hint.id);
    await waitFor(() => expect(new URLSearchParams(location.search).get('n')).toBe('3000000'));
    await u.tab();
    await waitFor(() => expect(n).not.toHaveAttribute('aria-invalid', 'true'));
    expect(screen.queryByText('請輸入 1–10,000,000 的整數')).toBeNull();
  });

  it('option descriptions only for the active option on hover devices', async () => {
    render(<App />);
    const u = userEvent.setup();
    const wl = getBundle().workloads;
    await u.click(screen.getByLabelText('工作'));
    await waitFor(() => expect(descOf(wl.assist!.name)).toHaveClass('on'));
    // Selected (assist) shows; the others stay collapsed.
    expect(descOf(wl.chat!.name)).not.toHaveClass('on');
    expect(descOf(wl.chat!.name)).toHaveAttribute('aria-hidden', 'true');
    // rc-select reads KeyboardEvent.which, which user-event leaves 0 in jsdom.
    const prev = Object.values(wl)[Object.keys(wl).indexOf('assist') - 1]!;
    fireEvent.keyDown(screen.getByLabelText('工作'), { key: 'ArrowUp', keyCode: 38, which: 38 });
    await waitFor(() => expect(descOf(prev.name)).toHaveClass('on'));
    expect(descOf(prev.name)).toHaveTextContent(prev.description);
  });

  it('touch devices show every option description', async () => {
    setMedia({ hoverNone: true });
    render(<App />);
    await userEvent.click(screen.getByLabelText('工作'));
    await shown(getBundle().workloads.chat!.description);
    for (const w of Object.values(getBundle().workloads)) expect(descOf(w.name)).toHaveClass('on');
    expect(descOf('自訂…')).toHaveClass('on');
  });

  it('workload and speed end with 自訂…, which opens its dialog', async () => {
    renderSentence();
    const u = userEvent.setup();
    for (const [label, dialog, desc] of [
      ['工作', 'workload', '以上都不符合？自己設定讀入與回覆長度'],
      ['速度', 'speed', '以上都不符合？自己設定速度與等待時間'],
    ] as const) {
      await u.click(screen.getByLabelText(label));
      await waitFor(() => expect(menu()).toBeTruthy());
      const titles = [...menu().querySelectorAll('.ant-select-item-option')].map((o) => o.getAttribute('title'));
      expect(titles.at(-1)).toBe('自訂…');
      expect(descOf('自訂…')).toHaveTextContent(desc);
      await u.click(within(menu()).getByTitle('自訂…'));
      await waitFor(() => expect(probe().dialog).toBe(dialog));
      act(() => send({ type: 'dialog', id: null }));
    }
    // Picking 自訂… opens the dialog only; the preset stays selected until the dialog applies a custom value.
    expect(selection('工作')).toHaveTextContent(getBundle().workloads.assist!.name);
  }, 15_000);

  it('custom selections read 自訂…', async () => {
    renderSentence();
    act(() => send({ type: 'workloadCustom', value: { base: 'chat', inputTokens: 500, outputTokens: 100, cacheHitRate: 0 } }));
    act(() => send({ type: 'speedCustom', value: { minTokPerSec: 30, maxTtftSec: 2 } }));
    await waitFor(() => expect(selection('工作')).toHaveTextContent('自訂…'));
    expect(selection('速度')).toHaveTextContent('自訂…');
    // 自訂… again (already selected) still reopens the dialog.
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('工作'));
    await u.click(await within(menu()).findByTitle('自訂…'));
    await waitFor(() => expect(probe().dialog).toBe('workload'));
  });

  it('model menu header shows the tier note with 推估（參考用）', async () => {
    setMedia({ hoverNone: true });
    render(<App />);
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('模型'));
    const tier = getBundle().workloads.assist!.tierNote.value;
    await waitFor(() => expect(menu()).toBeTruthy());
    const header = menu().querySelector('[data-testid="tier-note"]')!;
    expect(header).toHaveTextContent('推估（參考用）');
    expect(header).toHaveTextContent(tier);
  });

  it('model notes: platform counts without an adjusted row', async () => {
    setMedia({ hoverNone: true });
    render(<App />);
    expect(screen.queryByText(NOTE_RE)).toBeNull();
    await userEvent.click(screen.getByLabelText('模型'));
    await waitFor(() => expect(screen.getAllByText(NOTE_RE)).toHaveLength(Object.keys(getBundle().models).length), { timeout: 10_000 });
  }, 15_000);

  it.each([8, 1])('model notes on an adjusted row: speed or 放不下 on your %i H200', async (gpus) => {
    const b = getBundle();
    history.replaceState(null, '', `/?o=nano4-h200:${gpus}`);
    const s = decodeUrl(b, location.search);
    const main = computeMain(b, s);
    if (main.kind !== 'main') throw new Error('main view expected');
    const expected = modelOptionNotes(b, s, main.rows);
    setMedia({ hoverNone: true });
    render(<App />);
    await userEvent.click(screen.getByLabelText('模型'));
    await waitFor(() => expect(within(menu()).getAllByText(/^在你的 |^你的 /)).toHaveLength(Object.keys(b.models).length), { timeout: 10_000 });
    for (const [id, note] of Object.entries(expected)) {
      const text =
        note.kind === 'onRow'
          ? `在你的 ${gpus} 張 H200 上：每人 ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(note.tps)} 字/秒${note.ok ? '' : '（未達標）'}`
          : `你的 ${gpus} 張 H200 放不下`;
      expect(descOf(b.models[id]!.name)).toHaveTextContent(text);
    }
    if (gpus === 1) expect(Object.values(expected).some((n) => n.kind === 'noFit')).toBe(true);
    else expect(Object.values(expected).some((n) => n.kind === 'onRow')).toBe(true);
  }, 15_000);

  it('opening the model menu at 1000000 chat users keeps the page (final review C1)', async () => {
    history.replaceState(null, '', '/?w=chat&n=1000000');
    setMedia({ hoverNone: true });
    render(<App />);
    await userEvent.click(screen.getByLabelText('模型'));
    await waitFor(() => expect(screen.getAllByText(NOTE_RE)).toHaveLength(Object.keys(getBundle().models).length), { timeout: 10_000 });
    expect(screen.getByTestId('sentence')).toBeInTheDocument();
  }, 15_000);

  it('model not found offers import and manual entry; a typed owner/name imports at once, no dialog to confirm it', async () => {
    renderSentence();
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('模型'));
    await u.type(screen.getByLabelText('模型'), 'meta-llama/foo');
    await waitFor(() => expect(screen.getByText('找不到這個模型？')).toBeVisible(), { timeout: 10_000 });
    expect(within(menu()).getByRole('button', { name: /手動輸入架構/ })).toBeInTheDocument();
    // The hint under the list says the search also takes a Hugging Face owner/name (nobody could guess it).
    expect(within(menu()).getByTestId('model-hint')).toHaveTextContent('輸入 Hugging Face 的 owner/name');
    await u.click(within(menu()).getByRole('button', { name: /匯入 meta-llama\/foo/ }));
    await waitFor(() => expect(probe()).toMatchObject({ dialog: null, customModel: { kind: 'hf', repo: 'meta-llama/foo', sha: 'main' } }));
  }, 15_000);

  it('a not-found search that is not owner/name imports without a pre-fill; manual entry opens its dialog', async () => {
    renderSentence();
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('模型'));
    await u.type(screen.getByLabelText('模型'), 'zzz nothing');
    await waitFor(() => expect(screen.getByText('找不到這個模型？')).toBeVisible(), { timeout: 10_000 });
    await u.click(within(menu()).getByRole('button', { name: /從 Hugging Face 匯入/ }));
    await waitFor(() => expect(probe()).toMatchObject({ dialog: 'hf', hfQuery: '' }));
    act(() => send({ type: 'dialog', id: null }));
    await u.click(screen.getByLabelText('模型'));
    await u.type(screen.getByLabelText('模型'), 'zzz');
    await u.click(await within(menu()).findByRole('button', { name: /手動輸入架構/ }, { timeout: 10_000 }));
    await waitFor(() => expect(probe().dialog).toBe('manualModel'));
  }, 15_000);

  it('users focus shows the funnel hint; blur hides it; clicking it opens the funnel', async () => {
    renderSentence();
    const u = userEvent.setup();
    const hint = '只知道總人數？換算同時人數';
    expect(screen.queryByText(hint)).toBeNull();
    await u.click(screen.getByLabelText('同時人數'));
    await shown(hint);
    await u.click(document.body);
    await waitFor(() => expect(screen.getByText(hint)).not.toBeVisible());
    await u.click(screen.getByLabelText('同時人數'));
    await shown(hint);
    await u.click(screen.getByRole('button', { name: hint }));
    await waitFor(() => expect(probe().dialog).toBe('funnel'));
  });

  it('quant options describe the quantization (its description, not its name again)', async () => {
    setMedia({ hoverNone: true });
    render(<App />);
    await userEvent.click(screen.getByLabelText('模型精度'));
    const q = getBundle().quantization[quantOptions(getBundle(), getBundle().models['llama-3.3-70b-instruct-fp8']!.id)[0]!]!;
    await shown(q.description);
  });

  it('count inputs announce their range', () => {
    render(<App />);
    expect(screen.getByLabelText('同時人數')).toHaveAttribute('aria-valuemin', '1');
    expect(screen.getByLabelText('同時人數')).toHaveAttribute('aria-valuemax', String(USERS_MAX));
  });
});
