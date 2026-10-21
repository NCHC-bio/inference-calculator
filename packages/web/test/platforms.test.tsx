import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { theme } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { PlatformList } from '../src/components/PlatformList';
import { computeMain, type MainView, type OkRow } from '../src/compute/compute';
import { defaultState, type CalcState } from '../src/state/state';
import { useCalc } from '../src/state/store';
import { decodeUrl, encodeUrl } from '../src/state/url';
import { renderStore } from './helpers';
import { setMedia } from './setup';

// mistral-medium only offers fp8, so `q=bf16` falls back to it; its weights still do not fit the 32 GB Mac mini.
const INFEASIBLE_MAC = '?m=mistral-medium-3.5-128b&q=bf16';

const items = () => Array.from(document.querySelectorAll<HTMLElement>('.rows > .ant-collapse-item'));
const rows = () => screen.getAllByTestId('platform-row');
const rowOf = (key: string) => rows().find((x) => x.dataset.row === key)!;
const toggleOf = (row: HTMLElement) => row.querySelector<HTMLElement>(':scope > .ant-collapse-header .ant-collapse-title')!;
const main = (s: CalcState) => computeMain(getBundle(), s) as MainView & { kind: 'main' };
const okRow = (s: CalcState, key: string) => main(s).rows.find((r) => r.row === key) as OkRow;
const fmt0 = (n: number) => new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(n);
const visit = (s: CalcState) => history.replaceState(null, '', '/?' + encodeUrl(s));

/** Mirrors the store so tests can read dispatched state. */
let latest: CalcState | null = null;
function Probe() {
  latest = useCalc()[0];
  return null;
}
const renderList = () => renderStore(<><PlatformList /><Probe /></>);

const CUSTOM = { name: 'Lab GPU', unit: 'gpu' as const, gpusPerNode: 8, memGB: 80, memBwTBs: 3, tflops: 900, engine: 'vllm' as const };

describe('PlatformList', () => {
  beforeEach(() => {
    latest = null;
  });
  it('one row per platform in bundle order', () => {
    render(<App />);
    expect(rows().map((r) => r.dataset.row)).toEqual(Object.keys(getBundle().platforms));
  });

  it('rows are an antd Collapse with header-only toggles', async () => {
    const b = getBundle(); const best = main(defaultState(b)).result.best!;
    render(<App />);
    expect(document.querySelector('.ant-collapse.rows')).not.toBeNull();
    const row = rowOf(best); const toggle = toggleOf(row);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(row).getByRole('img', { name: /^每個方塊/ }));
    await userEvent.click(within(row).getByRole('spinbutton'));
    await userEvent.click(within(row).getByTestId('capacity'));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(row).getByText(b.platforms[best]!.name));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(within(row).getByTestId('workbench')).toBeInTheDocument());
  });

  it('infeasible rows cannot expand and show the reason', async () => {
    const b = getBundle();
    const mac = main(decodeUrl(b, INFEASIBLE_MAC)).rows.find((r) => r.row === 'mac-mini-m6-32')!;
    if (mac.kind !== 'infeasible') throw new Error('mac mini should be infeasible');
    history.replaceState(null, '', '/' + INFEASIBLE_MAC);
    render(<App />);
    const row = rowOf('mac-mini-m6-32');
    expect(row).toHaveClass('ant-collapse-item-disabled');
    expect(row.querySelector('.ant-collapse-expand-icon')).toBeNull();
    const tag = within(row).getByTestId('why-tag');
    expect(tag).toHaveClass('ant-tag-error');
    expect(tag).toHaveTextContent(/^模型放不下$/);
    expect(within(row).queryByTestId('capacity')).toBeNull();
    await userEvent.hover(tag);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(mac.detail));
    expect(row.querySelector(':scope > .ant-collapse-header')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(row).getByText(b.platforms['mac-mini-m6-32']!.name));
    expect(row).not.toHaveClass('ant-collapse-item-active');
    expect(row.querySelector('.ant-collapse-panel, .ant-collapse-content')).toBeNull();
  });

  it("a platform beyond the size bound shows 規模超出上限 with core's detail", async () => {
    const url = '?m=gemma-4-26b-a4b-it&q=bf16&w=chat&n=200000';
    const spark = main(decodeUrl(getBundle(), url)).rows.find((r) => r.row === 'dgx-spark')!;
    expect(spark.kind === 'infeasible' && spark.why).toBe('scale');
    history.replaceState(null, '', '/' + url);
    render(<App />);
    const tag = within(rowOf('dgx-spark')).getByTestId('why-tag');
    expect(tag).toHaveTextContent('規模超出上限');
    await userEvent.click(tag);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(spark.kind === 'infeasible' ? spark.detail : ''));
  });

  it('suggest button and count input', async () => {
    const s = defaultState(getBundle()); const best = main(s).result.best!;
    const r = okRow(s, best);
    render(<App />);
    const row = rowOf(best);
    const suggest = within(row).getByRole('button', { name: '建議' });
    expect(suggest).toHaveClass('ant-btn-primary');
    expect(suggest).toHaveAttribute('aria-pressed', 'true');
    const input = within(row).getByRole('spinbutton');
    expect(input).toHaveValue(String(r.suggested));
    expect(within(row).queryByTestId('speed-line')).toBeNull();
    await userEvent.clear(input); await userEvent.type(input, '2{Enter}');
    await waitFor(() => expect(suggest).toHaveAttribute('aria-pressed', 'false'));
    expect(suggest).not.toHaveClass('ant-btn-primary');
    const line = await within(row).findByTestId('speed-line');
    expect(line.querySelector('.anticon-check-circle, .anticon-close-circle')).not.toBeNull();
    expect(line).toHaveTextContent(`建議 ${fmt0(r.suggested)} 張：${fmt0(r.suggestedPerf.usage!.tokPerSecPerUser)} 字/秒`);
    await userEvent.click(suggest);
    await waitFor(() => expect(within(row).queryByTestId('speed-line')).toBeNull());
    expect(suggest).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(input).toHaveValue(String(r.suggested)));
  });

  it('「建議」 rolls the count from the override back to the suggestion', async () => {
    const s = defaultState(getBundle()); const best = main(s).result.best!;
    const r = okRow(s, best);
    expect(r.suggested).toBeGreaterThan(2);
    visit({ ...s, overrides: { [best]: { gpus: 1 } } });
    // Manual clock and animation frames: the tween advances only when a frame is flushed.
    let now = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.set(++id, cb), id));
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((h) => void frames.delete(h));
    const flush = () => act(() => { const cbs = [...frames.values()]; frames.clear(); for (const cb of cbs) cb(now); });
    try {
      renderList();
      const input = within(rowOf(best)).getByRole('spinbutton');
      expect(input).toHaveValue('1');
      // Rendered without App's ConfigProvider, so antd spaces the two-character label (建 議).
      fireEvent.click(within(rowOf(best)).getByRole('button', { name: /^建\s?議$/ }));
      await waitFor(() => expect(latest!.overrides).toEqual({}));
      await waitFor(() => expect(within(rowOf(best)).getByRole('button', { name: /^建\s?議$/ })).toHaveAttribute('aria-pressed', 'true'));
      now = 100; flush();
      const mid = Number((input as HTMLInputElement).value);
      expect(mid).toBeGreaterThan(1);
      expect(mid).toBeLessThan(r.suggested);
      now = 400; flush();
      expect(input).toHaveValue(String(r.suggested));
    } finally {
      nowSpy.mockRestore(); rafSpy.mockRestore(); cafSpy.mockRestore();
    }
  });

  describe('count input commits on Enter, blur and step only (Ruling W6)', () => {
    const setup = () => {
      const s = defaultState(getBundle()); const best = main(s).result.best!;
      const r = okRow(s, best);
      renderList();
      const row = rowOf(best);
      return { best, r, row, input: within(row).getByRole('spinbutton') };
    };
    it('typing 100001 then Enter leaves state unchanged and shows the hint', async () => {
      const { row, input } = setup();
      await userEvent.clear(input); await userEvent.type(input, '100001{Enter}');
      expect(latest!.overrides).toEqual({});
      expect(within(row).getByText('請輸入 1–100,000 的整數')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
    it('typing 2.5 then blur leaves state unchanged and shows the last count', async () => {
      const { r, row, input } = setup();
      await userEvent.clear(input); await userEvent.type(input, '2.5');
      expect(within(row).getByText('請輸入 1–100,000 的整數')).toBeInTheDocument();
      await userEvent.tab();
      expect(latest!.overrides).toEqual({});
      expect(input).toHaveValue(String(r.suggested));
      expect(within(row).queryByText('請輸入 1–100,000 的整數')).toBeNull();
    });
    it('typing does not dispatch until Enter', async () => {
      const { best, r, input } = setup();
      expect(r.suggested).not.toBe(8);
      await userEvent.clear(input); await userEvent.type(input, '8');
      expect(latest!.overrides).toEqual({});
      await userEvent.keyboard('{Enter}');
      expect(latest!.overrides).toEqual({ [best]: { gpus: 8 } });
    });
    it('the + step button commits count + 1 at once', async () => {
      const { best, r, row } = setup();
      await userEvent.click(within(row).getByRole('button', { name: 'Increase Value' }));
      expect(latest!.overrides).toEqual({ [best]: { gpus: r.suggested + 1 } });
    });
    it('focus and blur without typing commits nothing', async () => {
      const { input } = setup();
      await userEvent.click(input); await userEvent.tab();
      expect(latest!.overrides).toEqual({});
    });
  });

  it('capacity bar shows users over max and turns red when exceeded', async () => {
    const b = getBundle(); const s = defaultState(b); const best = main(s).result.best!;
    const r = okRow(s, best);
    const { colorError, colorPrimary } = theme.getDesignToken();
    visit(s);
    const { unmount } = render(<App />);
    const cap = within(rowOf(best)).getByTestId('capacity');
    expect(cap).toHaveTextContent(`同時 ${s.users} / ${r.perf.maxConcurrent} 人`);
    expect(cap.querySelector('.ant-progress-track')).not.toHaveStyle({ background: colorError });
    unmount();
    // The fewest cards that cannot serve everyone at the requested speed.
    let low: OkRow | null = null;
    for (let n = r.suggested - 1; n >= 1 && !low; n--) {
      const x = okRow({ ...s, overrides: { [best]: { gpus: n } } }, best);
      if (x.perf.maxConcurrent < s.users) low = x;
    }
    expect(low).not.toBeNull();
    visit({ ...s, overrides: { [best]: { gpus: low!.count } } });
    render(<App />);
    const cap2 = within(rowOf(best)).getByTestId('capacity');
    await waitFor(() => expect(cap2).toHaveTextContent(`同時 ${s.users} / ${low!.perf.maxConcurrent} 人`));
    expect(cap2.querySelector('.ant-progress-track')).toHaveStyle({ background: colorError });
    expect(colorError).not.toBe(colorPrimary);
  });

  it('self-hosted divider and add-hardware button', async () => {
    const b = getBundle();
    const firstSelf = Object.keys(b.platforms).find((id) => b.platforms[id]!.group === 'self')!;
    renderList();
    const all = items();
    const div = all.findIndex((x) => x.textContent === '自建');
    expect(div).toBeGreaterThanOrEqual(0);
    expect(all[div + 1]!.dataset.row).toBe(firstSelf);
    const add = screen.getByRole('button', { name: /找不到你的硬體？新增硬體/ });
    const list = screen.getByTestId('platform-list');
    expect(list.lastElementChild).toBe(add);
    await userEvent.click(add);
    expect(latest!.dialog).toBe('hardware');
    expect(latest!.editingPlatform).toBeNull();
  });

  it('custom rows have a tag, edit and delete', async () => {
    const s: CalcState = { ...defaultState(getBundle()), customPlatforms: [CUSTOM] };
    visit(s);
    renderList();
    expect(rows().at(-1)!.dataset.row).toBe('custom:0');
    const row = rowOf('custom:0');
    expect(within(row).getByText('Lab GPU')).toBeInTheDocument();
    expect(within(row).getByText('自訂')).toHaveClass('ant-tag');
    await userEvent.click(within(row).getByRole('button', { name: '編輯' }));
    expect(latest!.dialog).toBe('hardware');
    expect(latest!.editingPlatform).toBe(0);
    expect(row).not.toHaveClass('ant-collapse-item-active');
    await userEvent.click(within(row).getByRole('button', { name: '刪除' }));
    expect(latest!.customPlatforms).toEqual([]);
    await waitFor(() => expect(rows().some((x) => x.dataset.row === 'custom:0')).toBe(false));
  });

  it('best marker sits on the best row', () => {
    const best = main(defaultState(getBundle())).result.best!;
    render(<App />);
    expect(screen.getByTestId('best-marker')).toHaveAttribute('data-row', best);
    expect(screen.getByTestId('best-marker')).toHaveStyle({ opacity: '1' });
    expect(rowOf(best)).toHaveAttribute('data-best', 'true');
  });

  it('touch: tapping the capacity bar opens its explanation without toggling the row', async () => {
    setMedia({ hoverNone: true });
    const best = main(defaultState(getBundle())).result.best!;
    render(<App />); const row = rowOf(best);
    await userEvent.click(within(row).getByTestId('capacity'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent('目前人數 / 這些機器在你要求的速度下最多能同時服務的人數');
    expect(toggleOf(row)).toHaveAttribute('aria-expanded', 'false');
  });

  it('machine icons are shown on phones and explain themselves on tap and focus without toggling', async () => {
    const b = getBundle(); const best = main(defaultState(b)).result.best!;
    const per = b.platforms[best]!.gpusPerNode.value;
    const label = `每個方塊 = 1 個 node（${per} 張 GPU）；未滿一個 node 時只填滿用到的比例；實心為預期，虛線為保守估計多出的部分`;
    setMedia({ hoverNone: true });
    render(<App />); const row = rowOf(best);
    const icons = within(row).getByRole('img', { name: label });
    await userEvent.click(icons);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent(label);
    expect(toggleOf(row)).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    icons.blur(); icons.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
  });
});
