import { quantOptions } from '@nchc/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { shown } from './helpers';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { USERS_MAX } from '../src/state/state';
import { setMedia } from './setup';

// antd 6 puts aria-label on the combobox <input>; the displayed selection is the surrounding .ant-select-content.
const selection = (label: string) => screen.getByLabelText(label).closest('.ant-select-content');

describe('Sentence', () => {
  it('keeps the full sentence (spec §8.3.3: no "·" fields)', () => {
    render(<App />);
    const text = screen.getByTestId('sentence').textContent!;
    for (const part of ['同時最多有', '人會使用，', '做', '任務，', '模型用', '模型精度用', '希望回應速度']) expect(text).toContain(part);
  });
  it('operating each select in turn leaves the others unchanged (spec §8.3.3 demo 缺陷)', async () => {
    render(<App />); const u = userEvent.setup();
    const pick = async (label: string, option: string) => { await u.click(screen.getByLabelText(label)); await u.click(await screen.findByTitle(option)); };
    await pick('工作', '一般對話問答'); await pick('速度', '可接受');
    await pick('模型', getBundle().models['gpt-oss-120b']!.name);
    expect(selection('工作')).toHaveTextContent('一般對話問答');   // 斷言目標是 Select 的 selection item
    expect(selection('速度')).toHaveTextContent('可接受');
  });
  it('typing an invalid user count keeps the last valid value', async () => {
    render(<App />); const u = userEvent.setup(); const n = screen.getByLabelText('同時人數');
    await u.clear(n); await u.type(n, '0'); await u.tab();
    expect(new URLSearchParams(location.search).get('n')).toBe('15');
  });
  it('an out-of-range count is marked invalid with its range while typed; the URL keeps the last valid (final review I3)', async () => {
    render(<App />); const u = userEvent.setup(); const n = screen.getByLabelText('同時人數');
    expect(n).not.toHaveAttribute('aria-invalid', 'true');
    await u.clear(n); await u.type(n, '30000000');
    expect(n).toHaveAttribute('aria-invalid', 'true');
    expect(n.closest('.ant-input-number')).toHaveClass('ant-input-number-status-error');
    const hint = screen.getByText('請輸入 1–10,000,000 的整數');
    expect(hint).toBeVisible();
    expect(n.getAttribute('aria-describedby')).toBe(hint.id);
    expect(new URLSearchParams(location.search).get('n')).toBe('3000000');
    await u.tab();
    expect(n).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('請輸入 1–10,000,000 的整數')).toBeNull();
  });
  it('touch devices show option descriptions inline', async () => {
    setMedia({ hoverNone: true }); render(<App />);
    await userEvent.click(screen.getByLabelText('工作'));
    await shown(getBundle().workloads.chat!.description);
  });
  it('desktop: the active option (keyboard) shows its description in a tooltip', async () => {
    render(<App />); const u = userEvent.setup();
    expect(screen.queryByText(getBundle().workloads.assist!.description)).toBeNull();
    await u.click(screen.getByLabelText('工作'));
    await shown(getBundle().workloads.assist!.description);
    // rc-select reads KeyboardEvent.which, which user-event leaves 0 in jsdom.
    fireEvent.keyDown(screen.getByLabelText('工作'), { key: 'ArrowUp', keyCode: 38, which: 38 });
    const prev = Object.keys(getBundle().workloads).indexOf('assist') - 1;
    await shown(Object.values(getBundle().workloads)[prev]!.description);
  });
  it('model menu: tier suggestion with 推估, and per-model platform counts once opened', async () => {
    setMedia({ hoverNone: true }); render(<App />); const u = userEvent.setup();
    expect(screen.queryByText(/種機台上執行|所有機台都跑不動/)).toBeNull();
    await u.click(screen.getByLabelText('模型'));
    const tier = getBundle().workloads.assist!.tierNote.value;
    await shown(`這類任務建議（參考用）：${tier}`);
    // Scoped to the menu: the answer line has its own 推估 tag.
    expect(within(document.querySelector<HTMLElement>('.ant-select-dropdown')!).getByText('推估')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/^可在 \d+ \/ \d+ 種機台上執行$|^目前設定下所有機台都跑不動$/)).toHaveLength(Object.keys(getBundle().models).length));
  });
  it('opening the model menu at 1000000 chat users keeps the page (final review C1)', async () => {
    history.replaceState(null, '', '/?w=chat&n=1000000');
    setMedia({ hoverNone: true }); render(<App />); const u = userEvent.setup();
    await u.click(screen.getByLabelText('模型'));
    await waitFor(() => expect(screen.getAllByText(/^可在 \d+ \/ \d+ 種機台上執行$|^目前設定下所有機台都跑不動$/)).toHaveLength(Object.keys(getBundle().models).length));
    expect(screen.getByTestId('sentence')).toBeInTheDocument();
  });
  it('quant options describe the quantization (its description, not its name again)', async () => {
    setMedia({ hoverNone: true }); render(<App />);
    await userEvent.click(screen.getByLabelText('模型精度'));
    const q = getBundle().quantization[quantOptions(getBundle(), getBundle().models['llama-3.3-70b-instruct-fp8']!.id)[0]!]!;
    await shown(q.description);
  });
  it('count inputs announce their range', async () => {
    render(<App />);
    expect(screen.getByLabelText('同時人數')).toHaveAttribute('aria-valuemin', '1');
    expect(screen.getByLabelText('同時人數')).toHaveAttribute('aria-valuemax', String(USERS_MAX));
  });
});
