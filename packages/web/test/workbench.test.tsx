import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { PlatformList } from '../src/components/PlatformList';
import { splitText } from '../src/components/SplitSelect';
import { QueueLine } from '../src/components/Workbench';
import { computeBench, computeMain, type MainView, type OkRow } from '../src/compute/compute';
import { t, type MsgKey } from '../src/i18n';
import { decodeUrl } from '../src/state/url';
import { useCalc } from '../src/state/store';
import type { CalcState } from '../src/state/state';
import { renderStore, shown } from './helpers';

const zh = (k: MsgKey, v?: Record<string, string | number>) => t('zh-TW', k, v);
const fmt = (n: number, d = 0) => new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const H200 = 'nano4-h200';
const GB200 = 'nano4-gb200';

let latest: CalcState | null = null;
function Probe() {
  latest = useCalc()[0];
  return null;
}
const rowOf = (key: string) => screen.getAllByTestId('platform-row').find((x) => x.dataset.row === key)!;
const main = (search: string) => computeMain(getBundle(), decodeUrl(getBundle(), search)) as MainView & { kind: 'main' };
const okRow = (search: string, key: string) => main(search).rows.find((r) => r.row === key) as OkRow;

/** Render the list at `search`, open row `key`, return its workbench. */
async function openBench(search: string, key = H200): Promise<HTMLElement> {
  history.replaceState(null, '', '/' + search);
  renderStore(
    <>
      <PlatformList />
      <Probe />
    </>,
  );
  const row = rowOf(key);
  await userEvent.click(within(row).getByTestId('row-name'));
  return within(row).findByTestId('workbench');
}

beforeEach(() => {
  latest = null;
  history.replaceState(null, '', '/');
});

describe('splitText', () => {
  it('split text is plain language', () => {
    expect(splitText(2, 2, 'gpu', zh)).toBe('每 2 張卡合跑一份模型，共 2 份');
    expect(splitText(1, 8, 'gpu', zh)).toBe('每張卡各跑一份模型，共 8 份');
    expect(splitText(1, 3, 'machine', zh)).toBe('每台各跑一份模型，共 3 份');
  });
});

describe('Workbench', () => {
  it('one view, no tabs', async () => {
    const wb = await openBench('');
    expect(document.querySelector('.ant-tabs')).toBeNull();
    const titles = [...wb.querySelectorAll('.wb-h')].map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(['體驗', '原因']);
    expect(within(wb).getByTestId('chart-cards')).toBeInTheDocument();
    expect(within(wb).getByTestId('chart-users')).toBeInTheDocument();
    const foot = wb.querySelector<HTMLElement>('.wb-foot')!;
    expect(within(foot).getByText('更多圖表（Roofline，專家用）')).toBeInTheDocument();
    expect(within(foot).getByRole('button', { name: /驗證指令/ })).toBeInTheDocument();
    const top = wb.querySelector<HTMLElement>('.wb-top')!;
    expect(within(top).getByRole('button', { name: /加入比較/ })).toBeInTheDocument();
    expect(wb.textContent).not.toMatch(/副本/);
    expect(wb.textContent).not.toMatch(/NaN/);
  });

  it('layout rows', async () => {
    const wb = await openBench('');
    const area = (a: string) => wb.querySelector<HTMLElement>(`[data-area="${a}"]`)!;
    expect(area('exp').closest('.wb-row-1')).not.toBeNull();
    expect(area('why').closest('.wb-row-1')).not.toBeNull();
    expect(area('cards').closest('.wb-row-2')).not.toBeNull();
    expect(area('users').closest('.wb-row-2')).not.toBeNull();
    expect(within(area('cards')).getByTestId('chart-cards')).toBeInTheDocument();
    expect(within(area('users')).getByTestId('chart-users')).toBeInTheDocument();
  });

  it('top line: count, users and the split in plain words', async () => {
    const r = okRow('', H200);
    const wb = await openBench('');
    const top = wb.querySelector<HTMLElement>('.wb-top')!;
    const { tp, replicas } = r.perf.shape!;
    expect(top.textContent).toContain(`${fmt(r.count)} 張 ${getBundle().platforms[H200]!.name}`);
    expect(top.textContent).toContain(`${fmt(15)} 人同時使用`);
    expect(top.textContent).toContain(splitText(tp, replicas, 'gpu', zh));
  });

  it('metrics come from the shown count', async () => {
    const search = '?n=200&o=nano4-h200:16';
    const r = okRow(search, H200);
    expect(r.count).toBe(16);
    const wb = await openBench(search);
    const u = r.perf.usage!;
    expect(within(wb).getByTestId('metric-tps')).toHaveTextContent(fmt(u.tokPerSecPerUser));
    expect(within(wb).getByTestId('metric-ttft')).toHaveTextContent(fmt(u.ttftSec, 1));
    expect(within(wb).getByTestId('metric-max')).toHaveTextContent(fmt(r.perf.maxConcurrent));
  });

  it('split select lists every split and marks the recommended one', async () => {
    const r = okRow('', H200);
    expect(r.perf.splits.length).toBeGreaterThan(1);
    const wb = await openBench('');
    const sel = within(wb).getByTestId('split-select');
    await userEvent.click(within(sel).getByRole('combobox'));
    const opts = await waitFor(() => {
      const o = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(o).toHaveLength(r.perf.splits.length);
      return o;
    });
    const recIdx = r.perf.splits.findIndex((x) => x.shape.tp === r.perf.recommendedTp);
    opts.forEach((o, i) => {
      if (i === recIdx) expect(o.textContent).toContain('（建議）');
      else expect(o.textContent).not.toContain('（建議）');
    });
    const other = r.perf.splits.find((x) => x.shape.tp !== r.perf.recommendedTp && x.ok)!;
    await userEvent.click(opts[r.perf.splits.indexOf(other)]!);
    expect(latest!.overrides[H200]).toEqual({ gpus: r.count, tp: other.shape.tp });
  });

  it('split select disables a split that cannot hold the model (Ruling W8)', async () => {
    const search = '?m=mistral-medium-3.5-128b';
    const r = okRow(search, H200);
    const bad = r.perf.splits.find((x) => x.why === 'weights')!;
    expect(bad).toBeDefined();
    expect(bad.why).toBe('weights');
    const wb = await openBench(search);
    await userEvent.click(within(within(wb).getByTestId('split-select')).getByRole('combobox'));
    const opts = await waitFor(() => {
      const o = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(o).toHaveLength(r.perf.splits.length);
      return o;
    });
    const o = opts[r.perf.splits.indexOf(bad)]!;
    expect(o).toHaveClass('ant-select-item-option-disabled');
    expect(o.textContent).toBe(`${splitText(bad.shape.tp, bad.shape.replicas, 'gpu', zh)}：放不下`);
    expect(o.textContent).not.toMatch(/字\/秒/);
    await userEvent.click(o);
    expect(latest!.overrides[H200]).toBeUndefined();
  });

  it('a split that is only too slow stays selectable with its numbers (Ruling W8)', async () => {
    // Custom speed 60 字/秒, 1 user: TP 1 and 2 fit in memory but miss the speed (why 'bw', maxConcurrent 0).
    const search = '?n=1&m=llama-3.3-70b-instruct-fp8&q=fp8&x=eyJzcCI6eyJtaW5Ub2tQZXJTZWMiOjYwLCJtYXhUdGZ0U2VjIjo1fX0';
    const r = okRow(search, H200);
    const slow = r.perf.splits.find((x) => !x.ok && x.maxConcurrent === 0 && x.why !== 'weights' && x.why !== 'context' && x.why !== 'mem')!;
    expect(slow).toBeDefined();
    const wb = await openBench(search);
    await userEvent.click(within(within(wb).getByTestId('split-select')).getByRole('combobox'));
    const opts = await waitFor(() => {
      const o = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(o).toHaveLength(r.perf.splits.length);
      return o;
    });
    const o = opts[r.perf.splits.indexOf(slow)]!;
    expect(o).not.toHaveClass('ant-select-item-option-disabled');
    expect(o.textContent).not.toContain('放不下');
    expect(o.textContent).toContain(`${fmt(slow.tokPerSecPerUser)} 字/秒`);
    await userEvent.click(o);
    expect(latest!.overrides[H200]).toEqual({ gpus: r.count, tp: slow.shape.tp });
  });

  it('the selected split is never a disabled option', async () => {
    for (const search of ['', '?m=mistral-medium-3.5-128b', '?n=200&o=nano4-h200:16', '?m=mistral-medium-3.5-128b&o=nano4-h200:8:2']) {
      const wb = await openBench(search);
      await userEvent.click(within(within(wb).getByTestId('split-select')).getByRole('combobox'));
      const sel = await waitFor(() => {
        const x = document.querySelector<HTMLElement>('.ant-select-item-option-selected');
        expect(x).not.toBeNull();
        return x!;
      });
      expect(sel).not.toHaveClass('ant-select-item-option-disabled');
      expect(sel.textContent).not.toContain('放不下');
      cleanup();
    }
  });

  it('Mac row: 台 in the summary and the split', async () => {
    const search = '?m=gpt-oss-20b&s=ok&n=15';
    const key = 'mac-mini-m6-32';
    const r = okRow(search, key);
    expect(r.kind).toBe('ok');
    const { tp, replicas } = r.perf.shape!;
    const wb = await openBench(search, key);
    const top = wb.querySelector<HTMLElement>('.wb-top')!;
    expect(top.textContent).toContain(`${fmt(r.count)} 台 ${getBundle().platforms[key]!.name}`);
    expect(top.textContent).toContain(`每台各跑一份模型，共 ${fmt(replicas)} 份`);
    expect(splitText(tp, replicas, 'machine', zh)).toBe(`每台各跑一份模型，共 ${fmt(replicas)} 份`);
    expect(wb.textContent).toContain('台數 → 每人速度');
    expect(wb.textContent).not.toMatch(/張/);
  });

  it('actions apply: back to the suggested count', async () => {
    const search = '?n=200&o=nano4-h200:2';
    const r = okRow(search, H200);
    expect(r.perf.ok).toBe(false);
    const wb = await openBench(search);
    expect(wb.textContent).toContain('想用這些卡達標，可以：');
    await userEvent.click(within(wb).getByRole('button', { name: `改回建議的 ${fmt(r.suggested)} 張` }));
    expect(latest!.overrides[H200]).toBeUndefined();
  });

  it('actions apply: lower the users', async () => {
    const search = '?n=200&o=nano4-h200:2';
    const r = okRow(search, H200);
    const wb = await openBench(search);
    await userEvent.click(within(wb).getByRole('button', { name: `人數降到 ${fmt(r.perf.maxConcurrent)}` }));
    expect(latest!.users).toBe(r.perf.maxConcurrent);
  });

  it('action labels format their numbers', async () => {
    const search = '?n=200&o=nano4-h200:2';
    const b = getBundle();
    const s = decodeUrl(b, search);
    const bench = computeBench(b, s, okRow(search, H200));
    const wb = await openBench(search);
    const chips = within(wb).getAllByTestId('action-chip');
    expect(chips).toHaveLength(bench.actions.length);
    expect(wb.textContent).not.toMatch(/\{\w+\}/);
  });

  it('power: unverified TDP shows 功耗未查證 with the reason on hover', async () => {
    const b = getBundle();
    const r = okRow('', GB200);
    expect(r.perf.powerKw).toBeNull();
    const why = b.hardware[b.platforms[GB200]!.hardware]!.tdpW.conflict!;
    const wb = await openBench('', GB200);
    const p = within(wb).getByText('功耗未查證');
    await userEvent.hover(p);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${r.perf.powerNote}：${why}`);
  });

  it('power: verified TDP shows peak power with one decimal', async () => {
    const r = okRow('', H200);
    expect(r.perf.powerKw).not.toBeNull();
    const wb = await openBench('');
    expect(wb.textContent).toContain(`峰值功耗約 ${fmt(r.perf.powerKw!, 1)} kW`);
  });

  it('pin snapshots the shown numbers', async () => {
    const r = okRow('', H200);
    const wb = await openBench('');
    await userEvent.click(within(wb).getByRole('button', { name: /加入比較/ }));
    expect(latest!.pins).toHaveLength(1);
    expect(latest!.pins[0]).toMatchObject({
      platform: `${getBundle().platforms[H200]!.name} ${getBundle().platforms[H200]!.sub}`,
      users: 15,
      tps: r.perf.usage!.tokPerSecPerUser,
      ttft: r.perf.usage!.ttftSec,
      max: r.perf.maxConcurrent,
      kw: r.perf.powerKw,
      ok: r.perf.ok,
      hasEstimate: r.perf.hasEstimate,
      hasUser: r.perf.hasUser,
      warnings: r.perf.warnings,
    });
  });

  it('verify button opens the verify dialog without toggling the chart Collapse', async () => {
    const wb = await openBench('');
    const foot = wb.querySelector<HTMLElement>('.wb-foot')!;
    await userEvent.click(within(foot).getByRole('button', { name: /驗證指令/ }));
    expect(latest!.dialog).toBe('verify');
    expect(foot.querySelector('.ant-collapse-item-active')).toBeNull();
  });

  it('workbench without usage shows only the reason', async () => {
    const search = '?m=mistral-medium-3.5-128b&o=nano4-h200:1';
    const r = okRow(search, H200);
    expect(r.perf.usage).toBeNull();
    const wb = await openBench(search);
    expect(within(wb).queryByTestId('chart-cards')).toBeNull();
    expect(within(wb).queryByTestId('chart-users')).toBeNull();
    expect(within(wb).queryByTestId('usage-bar')).toBeNull();
    expect(wb.textContent).toContain('模型放不下');
    expect(within(wb).getByRole('button', { name: `改回建議的 ${fmt(r.suggested)} 張` })).toBeInTheDocument();
  });

  it('opens inside the row of the full app with core data', async () => {
    render(<App />);
    const r = okRow('', H200);
    const row = rowOf(H200);
    expect(within(row).queryByTestId('workbench')).toBeNull();
    await userEvent.click(within(row).getByTestId('row-name'));
    const wb = await within(row).findByTestId('workbench');
    expect(within(wb).getAllByTestId('usage-bar')).toHaveLength(4);
    expect(within(wb).getAllByTestId('memory-bar')).toHaveLength(1);
    expect(wb.textContent).toContain(splitText(r.perf.shape!.tp, r.perf.shape!.replicas, 'gpu', zh));
  });
});

// Test fixture (not model data): one queueing result.
const QUEUE = { tokensPerStep: 1, budget: 1, decodingMax: 1, waiting: 1, waitSec: 2.25, reason: '排隊原因' };

describe('QueueLine', () => {
  it('queueing: one sentence, reason in the popover', async () => {
    renderStore(<QueueLine queueing={QUEUE} />);
    const s = screen.getByText('尖峰時部分請求需排隊約 2.3 秒，已計入首字時間');
    await userEvent.hover(s);
    await shown('排隊原因');
  });
  it('no queueing → no queue sentence', () => {
    const { container } = renderStore(<QueueLine queueing={null} />);
    expect(container.textContent).not.toMatch(/排隊/);
    expect(screen.queryByTestId('queue-line')).toBeNull();
  });
});

describe('closed rows stop their clocks (v8 minor 1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('after the close animation no interval or frame from the row is left running', async () => {
    const live = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      live.add(id);
      return id;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id?: ReturnType<typeof setInterval>) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearInterval);
    const wb = await openBench('');
    expect(within(wb).getByTestId('typed')).toBeInTheDocument();
    await waitFor(() => expect(live.size).toBeGreaterThan(0));
    await userEvent.click(within(rowOf(H200)).getByTestId('row-name'));
    // Past the 400 ms close animation.
    await new Promise((r) => setTimeout(r, 700));
    expect(live.size).toBe(0);
    expect(within(rowOf(H200)).queryByTestId('workbench')).toBeNull();
  });
});
