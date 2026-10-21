import { CUSTOM_MODEL_WARNING, peakConcurrentFromTotal, quantOptions } from '@nchc/core';
import type { Model, Source } from '@nchc/schema';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchHfModel } from '@nchc/data/hf';
import { App } from '../src/App';
import { getAccuracy } from '../src/accuracy';
import { getBundle } from '../src/bundle';
import { fmt } from '../src/components/answerText';
import { AnswerLine } from '../src/components/AnswerLine';
import { PlatformList } from '../src/components/PlatformList';
import { CiteModal } from '../src/components/CiteModal';
import { Sentence } from '../src/components/Sentence';
import { AccuracyDrawer } from '../src/components/drawers/AccuracyDrawer';
import { formatCommand, splitVerify } from '../src/components/drawers/CodeBlock';
import { FunnelDrawer } from '../src/components/drawers/FunnelDrawer';
import { HardwareDrawer } from '../src/components/drawers/HardwareDrawer';
import { HfImportDrawer, HfRefetch } from '../src/components/drawers/HfImportDrawer';
import { keptLabel, ManualModelDrawer } from '../src/components/drawers/ManualModelDrawer';
import { t as tAny, tZh as tZhFn } from '../src/i18n/t';
const tEn = (k: Parameters<typeof tZhFn>[0], v?: Record<string, string | number>) => tAny('en', k, v);
import { SpeedDrawer } from '../src/components/drawers/SpeedDrawer';
import { VerifyDrawer } from '../src/components/drawers/VerifyDrawer';
import { WorkloadDrawer } from '../src/components/drawers/WorkloadDrawer';
import { computeMain } from '../src/compute/compute';
import { defaultState, type Action, type CalcState } from '../src/state/state';
import { StoreProvider, useCalc } from '../src/state/store';
import { encodeUrl } from '../src/state/url';
import { reportModelUrl, REPORT_REASON_MAX } from '../src/reportModel';

vi.mock('@nchc/data/hf', () => ({ fetchHfModel: vi.fn() }));
const fetchMock = vi.mocked(fetchHfModel);

let send: (a: Action) => void = () => {};
let latest: CalcState | null = null;
function Probe() {
  const [s, dispatch] = useCalc();
  send = dispatch;
  latest = s;
  return null;
}
const state = () => latest!;

/** Renders under the store and antd App (message), with dispatch exposed; `search` seeds the URL. */
function renderWith(ui: ReactElement, search = '') {
  history.replaceState(null, '', '/' + search);
  return render(
    <StoreProvider>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          {ui}
          <Probe />
        </AntApp>
      </ConfigProvider>
    </StoreProvider>,
  );
}
const openDialog = (a: Action) => act(() => send(a));
const drawer = () =>
  waitFor(() => {
    const d = document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-section') ?? document.querySelector<HTMLElement>('.ant-drawer-open');
    expect(d).not.toBeNull();
    return d!;
  });
const b = getBundle();
const zh = (n: number, d = 0) => fmt('zh-TW', n, d);

/** An imported HF model fixture: a catalog model re-cited to an `hf:` source (core checks they match). */
function importedFixture(): { model: Model; source: Source } {
  const catalog = b.models['gpt-oss-20b']!;
  const source: Source = { ...b.sources[catalog.source]!, id: 'hf:test-org/test-model@abc1234', title: 'test-org/test-model config.json', url: 'https://huggingface.co/test-org/test-model' };
  const model = JSON.parse(JSON.stringify({ ...catalog, id: 'test-model', name: 'Test Model', hfRepo: 'test-org/test-model' }), (_k, v) =>
    v === catalog.source ? source.id : v,
  ) as Model;
  return { model, source };
}

beforeEach(() => {
  fetchMock.mockReset();
  latest = null;
});

describe('formatCommand', () => {
  it('breaks before every ` --` with a trailing ` \\`', () => {
    expect(formatCommand('vllm serve m --a 1 --b 2')).toBe('vllm serve m \\\n  --a 1 \\\n  --b 2');
  });
  it('keeps # comment lines as they are', () => {
    expect(formatCommand('# note --x 1\nvllm serve m --a 1')).toBe('# note --x 1\nvllm serve m \\\n  --a 1');
  });
});

const unformat = (code: string) => code.replaceAll(' \\\n  ', ' ');

describe('VerifyDrawer', () => {
  it('verify drawer shows code blocks of the core command', async () => {
    renderWith(<VerifyDrawer />, '?w=chat');
    const s0 = state();
    const main = computeMain(b, s0);
    if (main.kind !== 'main') throw new Error('main');
    const row = main.result.best!;
    const perf = main.rows.find((r) => r.row === row && r.kind === 'ok')!;
    if (perf.kind !== 'ok') throw new Error('ok');
    const cmd = perf.perf.verifyCommand;
    expect(cmd).not.toBe('');
    openDialog({ type: 'openRow', row });
    openDialog({ type: 'dialog', id: 'verify' });
    const d = await drawer();
    expect(within(d).getByText('1. 啟動服務')).toBeInTheDocument();
    expect(within(d).getByText('2. 壓測')).toBeInTheDocument();
    const codes = [...d.querySelectorAll('pre > code')].map((c) => c.textContent!);
    expect(codes).toHaveLength(2);
    const parts = splitVerify(cmd);
    expect(codes.map(unformat)).toEqual(parts);
    expect(parts.join('\n')).toBe(cmd);
    expect(codes[1]).toMatch(/^vllm bench serve/);
    expect(codes[0]).toContain(' \\\n  --tensor-parallel-size');
    // One copy button per block.
    expect(d.querySelectorAll('.ant-typography-copy')).toHaveLength(2);
    expect(within(d).getByText(/Mean TPOT/)).toBeInTheDocument();
  });

  it('shows verifyNote when core gives one', async () => {
    const s: CalcState = { ...defaultState(b), workload: 'chat', overrides: { 'nano5-h100': { gpus: 1 } } };
    renderWith(<VerifyDrawer />, '?' + encodeUrl(s));
    const main = computeMain(b, state());
    if (main.kind !== 'main') throw new Error('main');
    const r = main.rows.find((x) => x.row === 'nano5-h100')!;
    if (r.kind !== 'ok') throw new Error('ok');
    expect(r.perf.verifyNote).toBeTruthy();
    openDialog({ type: 'openRow', row: 'nano5-h100' });
    openDialog({ type: 'dialog', id: 'verify' });
    const d = await drawer();
    expect(within(d).getByText(r.perf.verifyNote!)).toBeInTheDocument();
    expect(d.querySelectorAll('pre > code')).toHaveLength(2);
  });
});

describe('FunnelDrawer', () => {
  it('funnel applies users', async () => {
    renderWith(<FunnelDrawer />, '?w=chat');
    openDialog({ type: 'dialog', id: 'funnel' });
    const d = await drawer();
    const f = b.funnel;
    const daily = within(d).getByLabelText(/每日活躍比例/);
    expect(daily).toHaveValue(String(f.dailyActiveShare.value * 100));
    expect(within(d).getByLabelText(/每位活躍者每日請求數/)).toHaveValue(String(f.requestsPerActivePerDay.value));
    expect(within(d).getByLabelText(/尖峰一小時/)).toHaveValue(String(f.peakHourShare.value * 100));
    // Each default carries its status tag.
    const tagOf = (re: RegExp) => within(d).getByText(re).closest('label')!.querySelector('.ant-tag')!.textContent;
    const label = { measured: '實測', estimate: '推估', derived: '推算', official: '官方', unverified: '未查證' } as const;
    expect(tagOf(/每日活躍比例/)).toBe(label[f.dailyActiveShare.status]);
    expect(tagOf(/尖峰一小時/)).toBe(label[f.peakHourShare.status]);
    expect(within(d).queryByRole('button', { name: '套用到句子' })).toBeNull();

    await userEvent.type(within(d).getByLabelText(/總人數/), '20000');
    const n = peakConcurrentFromTotal(b, { total: 20000, workload: 'chat', speed: state().speed }).users;
    await waitFor(() => expect(within(d).getByTestId('funnel-result')).toHaveTextContent(`約同時 ${zh(n)} 人`));
    await userEvent.click(within(d).getByRole('button', { name: '套用到句子' }));
    expect(state().users).toBe(n);
    expect(state().dialog).toBeNull();
  });

  it('a changed share is passed to core as the user value', async () => {
    renderWith(<FunnelDrawer />, '?w=chat');
    openDialog({ type: 'dialog', id: 'funnel' });
    const d = await drawer();
    await userEvent.type(within(d).getByLabelText(/總人數/), '20000');
    const peak = within(d).getByLabelText(/尖峰一小時/);
    await userEvent.clear(peak);
    await userEvent.type(peak, '50');
    const n = peakConcurrentFromTotal(b, { total: 20000, peakHourShare: 0.5, workload: 'chat', speed: state().speed }).users;
    await waitFor(() => expect(within(d).getByTestId('funnel-result')).toHaveTextContent(`約同時 ${zh(n)} 人`));
  });

  it('assist workload shows only the core message', async () => {
    renderWith(<FunnelDrawer />, '?w=assist');
    openDialog({ type: 'dialog', id: 'funnel' });
    const d = await drawer();
    expect(within(d).getByText(/直接填尖峰同時在線人數/)).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: '套用到句子' })).toBeNull();
    expect(within(d).queryByLabelText(/總人數/)).toBeNull();
  });
});

describe('FunnelDrawer cap (v8 minor 10)', () => {
  it('a result over the users limit shows the capNote from core, and 套用到句子 applies the capped value', async () => {
    renderWith(<FunnelDrawer />, '?w=chat');
    openDialog({ type: 'dialog', id: 'funnel' });
    const d = await drawer();
    await fill(d, /總人數/, '1000000000');
    await fill(d, /每位活躍者每日請求數/, '1000');
    const r = peakConcurrentFromTotal(b, {
      total: 1e9,
      requestsPerActivePerDay: 1000,
      workload: 'chat',
      speed: state().speed,
    });
    expect(r.capped).toBe(true);
    const alert = await within(d).findByTestId('funnel-capped');
    expect(alert).toHaveClass('ant-alert-warning');
    expect(alert).toHaveTextContent(r.capNote!);
    await userEvent.click(within(d).getByRole('button', { name: '套用到句子' }));
    expect(state().users).toBe(r.users);
    expect(state().dialog).toBeNull();
  });

  it('an uncapped result shows no cap warning', async () => {
    renderWith(<FunnelDrawer />, '?w=chat');
    openDialog({ type: 'dialog', id: 'funnel' });
    const d = await drawer();
    await fill(d, /總人數/, '20000');
    await within(d).findByTestId('funnel-result');
    expect(within(d).queryByTestId('funnel-capped')).toBeNull();
  });
});

describe('WorkloadDrawer', () => {
  it('workload drawer', async () => {
    renderWith(<WorkloadDrawer />, '?w=assist');
    openDialog({ type: 'dialog', id: 'workload' });
    const d = await drawer();
    const w = b.workloads.assist!;
    const input = within(d).getByLabelText(/每次讀入/);
    const output = within(d).getByLabelText(/每次回覆/);
    const hit = within(d).getByLabelText(/快取命中/);
    expect(input).toHaveValue(String(w.inputTokens.value));
    expect(output).toHaveValue(String(w.outputTokens.value));
    expect(Number(hit.getAttribute('value'))).toBeCloseTo(w.cacheHitRate.value * 100, 5);
    await userEvent.clear(output);
    await userEvent.type(output, '300');
    await waitFor(() =>
      expect(state().workload).toEqual({ base: 'assist', inputTokens: w.inputTokens.value, outputTokens: 300, cacheHitRate: w.cacheHitRate.value }),
    );
    await userEvent.click(within(d).getByText('還原為「研究助理」的預設值'));
    expect(state().workload).toBe('assist');
  });
});

describe('SpeedDrawer', () => {
  it('speed drawer', async () => {
    renderWith(<SpeedDrawer />);
    openDialog({ type: 'dialog', id: 'speed' });
    const d = await drawer();
    const p = b.speedPresets[state().speed as string]!;
    const tps = within(d).getByLabelText(/每人每秒至少/);
    const ttft = within(d).getByLabelText(/最多等幾秒/);
    expect(tps).toHaveValue(String(p.minTokensPerSec.value));
    expect(ttft).toHaveValue(String(p.maxTtftSec.value));
    await userEvent.clear(tps);
    await userEvent.type(tps, '42');
    await waitFor(() => expect(state().speed).toEqual({ minTokPerSec: 42, maxTtftSec: p.maxTtftSec.value }));
    await userEvent.clear(ttft);
    await userEvent.type(ttft, '3');
    await waitFor(() => expect(state().speed).toEqual({ minTokPerSec: 42, maxTtftSec: 3 }));
  });
});

const fill = async (scope: HTMLElement, label: RegExp, value: string) => {
  const el = within(scope).getByLabelText(label);
  await userEvent.clear(el);
  await userEvent.type(el, value);
};

describe('HardwareDrawer', () => {
  it('hardware drawer validates and adds a row', async () => {
    renderWith(
      <>
        <PlatformList />
        <HardwareDrawer />
      </>,
    );
    openDialog({ type: 'dialog', id: 'hardware', editingPlatform: null });
    const d = await drawer();
    expect(within(d).getByText('效率係數沒有實測，借用同引擎的校正值，結果標為推估')).toBeInTheDocument();
    expect(within(d).getByLabelText('每張卡 dense 峰值算力（TFLOPS）')).toBeInTheDocument();
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(d.querySelectorAll('.ant-form-item-explain-error').length).toBeGreaterThan(0));
    expect(state().customPlatforms).toEqual([]);

    await fill(d, /^名稱/, 'My Server');
    await fill(d, /每台幾張卡/, '4');
    await fill(d, /每張卡記憶體（GB）/, '96');
    await fill(d, /記憶體頻寬/, '3');
    await fill(d, /TFLOPS/, '700');
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(state().customPlatforms).toHaveLength(1));
    expect(state().customPlatforms[0]).toEqual({ name: 'My Server', unit: 'gpu', gpusPerNode: 4, memGB: 96, memBwTBs: 3, tflops: 700, engine: 'vllm' });
    expect(state().dialog).toBeNull();
    await waitFor(() => {
      const rows = screen.getAllByTestId('platform-row');
      const last = rows.at(-1)!;
      expect(last.dataset.row).toBe('custom:0');
      expect(within(last).getByText('自訂')).toHaveClass('ant-tag');
      expect(last).toHaveTextContent('My Server');
    });
  }, 20_000);

  it('the TFLOPS label follows the engine', async () => {
    renderWith(<HardwareDrawer />);
    openDialog({ type: 'dialog', id: 'hardware', editingPlatform: null });
    const d = await drawer();
    await userEvent.click(within(d).getByText('MLX'));
    expect(await within(d).findByLabelText('實測可達算力（TFLOPS，effective）')).toBeInTheDocument();
  });

  it('edit mode loads the platform and saves with editPlatform', async () => {
    const hw = { name: 'Box', unit: 'machine' as const, gpusPerNode: 1, memGB: 128, memBwTBs: 0.5, tflops: 30, engine: 'mlx' as const };
    renderWith(<HardwareDrawer />, '?' + encodeUrl({ ...defaultState(b), customPlatforms: [hw] }));
    openDialog({ type: 'dialog', id: 'hardware', editingPlatform: 0 });
    const d = await drawer();
    expect(within(d).getByText('編輯你的硬體')).toBeInTheDocument();
    expect(within(d).getByLabelText(/^名稱/)).toHaveValue('Box');
    expect(within(d).getByLabelText(/每張卡記憶體（GB）|記憶體（GB）/)).toHaveValue('128');
    await fill(d, /^名稱/, 'Box 2');
    await userEvent.click(within(d).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(state().customPlatforms).toEqual([{ ...hw, name: 'Box 2' }]));
  });
});

describe('ManualModelDrawer', () => {
  it('manual model drawer', async () => {
    renderWith(
      <>
        <Sentence />
        <AnswerLine />
        <ManualModelDrawer />
      </>,
      '?w=chat',
    );
    openDialog({ type: 'dialog', id: 'manualModel' });
    const d = await drawer();
    for (const l of [/總參數/, /層數/, /注意力頭數/, /KV 頭數/, /head 維度/, /hidden 維度/]) expect(within(d).getByLabelText(l)).toBeInTheDocument();
    // The NCHC rule is stated before anything is entered (Ruling W12).
    expect(within(d).getByTestId('custom-model-warning')).toHaveTextContent(CUSTOM_MODEL_WARNING.text);
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(d.querySelectorAll('.ant-form-item-explain-error').length).toBeGreaterThan(0));
    expect(state().customModel).toBeNull();

    await fill(d, /^名稱/, 'My Model');
    await fill(d, /總參數/, '8');
    await fill(d, /層數/, '32');
    await fill(d, /注意力頭數/, '32');
    await fill(d, /KV 頭數/, '8');
    await fill(d, /head 維度/, '128');
    await fill(d, /hidden 維度/, '4096');
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(state().customModel?.kind).toBe('manual'));
    expect(state().customModel).toEqual({
      kind: 'manual',
      value: { name: 'My Model', totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 },
    });
    await waitFor(() => expect(screen.getByLabelText('模型').closest('.ant-select-content')).toHaveTextContent('My Model'));
    await waitFor(() => expect(screen.getByText(CUSTOM_MODEL_WARNING.text)).toBeInTheDocument());
    expect(screen.getAllByText('自訂').some((x) => x.classList.contains('ant-tag'))).toBe(true);
  }, 20_000);

  it('a shape core rejects is shown on the form, nothing dispatched', async () => {
    renderWith(<ManualModelDrawer />);
    openDialog({ type: 'dialog', id: 'manualModel' });
    const d = await drawer();
    await fill(d, /總參數/, '8');
    await fill(d, /層數/, '32');
    await fill(d, /注意力頭數/, '32');
    await fill(d, /KV 頭數/, '5');
    await fill(d, /head 維度/, '128');
    await fill(d, /hidden 維度/, '4096');
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(within(d).getByTestId('model-issues')).toBeInTheDocument());
    expect(state().customModel).toBeNull();
  });
});

describe('ManualModelDrawer re-save (v8 minor 7)', () => {
  const moeModel = {
    name: 'Sparse',
    totalParamsB: 20,
    layers: 24,
    heads: 64,
    kvHeads: 8,
    headDim: 64,
    hidden: 2880,
    moe: { experts: 32, topK: 4, expertFfnDim: 2880 },
    slidingWindow: 128,
  };

  it('keeps the fields the form does not edit and says which', async () => {
    const seeded: CalcState = { ...defaultState(b), model: 'custom', customModel: { kind: 'manual', value: moeModel } };
    renderWith(<ManualModelDrawer />, '?' + encodeUrl(seeded));
    expect(state().customModel).toEqual({ kind: 'manual', value: moeModel });
    openDialog({ type: 'dialog', id: 'manualModel' });
    const d = await drawer();
    // Translated labels, not schema keys (fix round D).
    expect(within(d).getByTestId('manual-kept')).toHaveTextContent('MoE 專家設定、滑動視窗');
    expect(within(d).getByTestId('manual-kept').textContent).not.toMatch(/moe|slidingWindow/);
    await fill(d, /層數/, '20');
    await userEvent.click(within(d).getByRole('button', { name: '加入' }));
    await waitFor(() => expect(state().customModel).toEqual({ kind: 'manual', value: { ...moeModel, layers: 20 } }));
  });

  it('kept-field labels in en, every schema field translated, unknown keys as they are (fix round D)', async () => {
    const en = (k: Parameters<typeof tEn>[0], v?: Record<string, string | number>) => tEn(k, v);
    expect(keptLabel('moe', en)).toBe('MoE experts');
    expect(keptLabel('slidingWindow', en)).toBe('sliding window');
    for (const k of ['hfRepo', 'baseModel', 'origin', 'baseOrigin', 'attention', 'mla', 'layerGroups', 'moe', 'slidingWindow']) {
      expect(keptLabel(k, en)).not.toBe(k);
      expect(keptLabel(k, tZhFn)).not.toBe(k);
    }
    expect(keptLabel('somethingNew', en)).toBe('somethingNew');
    const seeded: CalcState = { ...defaultState(b), lang: 'en', model: 'custom', customModel: { kind: 'manual', value: moeModel } };
    renderWith(<ManualModelDrawer />, '?' + encodeUrl(seeded));
    openDialog({ type: 'dialog', id: 'manualModel' });
    const d = await drawer();
    expect(within(d).getByTestId('manual-kept')).toHaveTextContent('This form does not edit MoE experts, sliding window');
  });

  it('a plain model shows no kept-fields note', async () => {
    const plain = { name: 'Plain', totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 };
    renderWith(<ManualModelDrawer />, '?' + encodeUrl({ ...defaultState(b), model: 'custom', customModel: { kind: 'manual', value: plain } }));
    openDialog({ type: 'dialog', id: 'manualModel' });
    const d = await drawer();
    expect(within(d).queryByTestId('manual-kept')).toBeNull();
  });
});

describe('HfImportDrawer', () => {
  it('success → customModel hf with imported and sha; no publisher fields, the NCHC rule shown first (Ruling W12)', async () => {
    const { model, source } = importedFixture();
    fetchMock.mockResolvedValue({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] });
    renderWith(<HfImportDrawer />);
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/test-model' });
    const d = await drawer();
    expect(within(d).getByLabelText(/Hugging Face 模型/)).toHaveValue('test-org/test-model');
    const warning = within(d).getByTestId('custom-model-warning');
    expect(warning).toHaveTextContent('國網中心模型使用規定');
    expect(warning).toHaveTextContent(CUSTOM_MODEL_WARNING.text);
    expect(within(d).queryByLabelText(/發表者/)).toBeNull();
    expect(within(d).queryByLabelText(/國家/)).toBeNull();
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    await waitFor(() => expect(state().customModel?.kind).toBe('hf'));
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('origin');
    expect(state().customModel).toEqual({ kind: 'hf', repo: 'test-org/test-model', sha: 'abc1234def', imported: { model, source } });
    expect(state().dialog).toBeNull();
  });

  it('denied → token field; the token never reaches the URL', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 'denied', message: 'gated or private repo: an access token is required (HTTP 401 on config.json)' });
    renderWith(<HfImportDrawer />);
    const before = state().model;
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/gated' });
    const d = await drawer();
    expect(within(d).queryByLabelText(/token/i)).toBeNull();
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    const token = await within(d).findByLabelText(/Hugging Face token/);
    // Its own localized title plus the CLI-neutral detail (no command-line flag reaches the browser).
    const alert = within(d).getByTestId('hf-error');
    expect(alert).toHaveTextContent('這個模型需要授權：請貼上你的 Hugging Face token 再匯入');
    expect(alert).toHaveTextContent('gated or private repo: an access token is required');
    expect(alert).not.toHaveTextContent('--token-env');
    expect(within(d).getByText(/token 只留在瀏覽器記憶體/)).toBeInTheDocument();
    await userEvent.type(token, 'hf_secret123');
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('test-org/gated', expect.objectContaining({ token: 'hf_secret123' })));
    expect(location.href).not.toContain('hf_secret123');
    expect(state().model).toBe(before);
    expect(state().customModel).toBeNull();
  });

  it('the Import button is disabled while an import runs', async () => {
    const { model, source } = importedFixture();
    let resolve: (v: Awaited<ReturnType<typeof fetchHfModel>>) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWith(<HfImportDrawer />);
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/test-model' });
    const d = await drawer();
    const button = within(d.closest('.ant-drawer')!).getByRole('button', { name: '匯入' });
    await userEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    await act(async () => resolve({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] }));
    await waitFor(() => expect(state().customModel?.kind).toBe('hf'));
  });

  it('closing the Drawer while an import runs drops its answer: no dispatch, no toast', async () => {
    const { model, source } = importedFixture();
    let resolve: (v: Awaited<ReturnType<typeof fetchHfModel>>) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWith(<HfImportDrawer />);
    const before = state().model;
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/test-model' });
    const d = await drawer();
    await userEvent.click(within(d.closest('.ant-drawer')!).getByRole('button', { name: '匯入' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(d.closest('.ant-drawer')!.querySelector('.ant-drawer-close')!);
    expect(state().dialog).toBeNull();
    await act(async () => resolve({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(state().customModel).toBeNull();
    expect(state().model).toBe(before);
    expect(state().dialog).toBeNull();
    expect(document.querySelector('.ant-message-success')).toBeNull();
  });

  it.each([
    ['not-found', /找不到這個模型/],
    ['network', /無法連線到 Hugging Face/],
    ['unparsable', /無法解析這個模型的架構/],
    ['invalid', /owner\/name/],
  ] as const)('%s → its own message and the missing list', async (status, re) => {
    fetchMock.mockResolvedValue({ ok: false, status, message: 'detail text', missing: ['num_hidden_layers', 'head_dim'] });
    renderWith(<HfImportDrawer />);
    const before = state().model;
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/x' });
    const d = await drawer();
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    const alert = await within(d).findByTestId('hf-error');
    expect(alert).toHaveTextContent(re);
    expect(alert).toHaveTextContent('num_hidden_layers');
    expect(alert).toHaveTextContent('head_dim');
    expect(state().model).toBe(before);
    expect(state().customModel).toBeNull();
  });

  const submitFailure = async (failure: Awaited<ReturnType<typeof fetchHfModel>>, query = 'test-org/x') => {
    fetchMock.mockResolvedValue(failure);
    renderWith(<HfImportDrawer />);
    openDialog({ type: 'dialog', id: 'hf', hfQuery: query });
    const d = await drawer();
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    return { d, alert: await within(d).findByTestId('hf-error') };
  };

  it('unsupported architecture → localized feature names once, details one step away, a pre-filled report link (issue #17)', async () => {
    const reason = 'unsupported architecture: layer_types "linear_attention" on 48 of 64 layers; first_k_dense_replace 3';
    const { alert } = await submitFailure({
      ok: false, status: 'unparsable', message: reason, repo: 'test-org/x', sha: 'abc1234def',
      missing: ['layer_types: unknown type "linear_attention"', 'first_k_dense_replace 3 (dense MLP layers mixed with MoE not supported)'],
      unsupported: [
        { feature: 'linear-attention', detail: 'layer_types "linear_attention" on 48 of 64 layers', fields: ['layer_types: unknown type "linear_attention"'] },
        { feature: 'dense-and-moe', detail: 'first_k_dense_replace 3', fields: ['first_k_dense_replace 3 (dense MLP layers mixed with MoE not supported)'] },
      ],
    });
    expect(alert).toHaveTextContent('這個模型用到計算機還沒建模的結構：混合線性注意力（Gated DeltaNet、KDA）、Dense 與 MoE 混合的層。');
    // Each problem once: the explained missing lines are not listed again, and the details stay folded.
    expect(alert).not.toHaveTextContent('缺少');
    expect(within(alert).queryByTestId('hf-error-details')).toBeNull();
    await userEvent.click(within(alert).getByText('技術細節'));
    expect(await within(alert).findByTestId('hf-error-details')).toHaveTextContent('layer_types "linear_attention" on 48 of 64 layers');
    const link = within(alert).getByTestId('hf-report');
    const url = new URL(link.getAttribute('href')!);
    expect(url.origin + url.pathname).toBe('https://github.com/NCHC-bio/inference-calculator/issues/new');
    expect(url.searchParams.get('template')).toBe('unsupported-model.yml');
    expect(url.searchParams.get('repo')).toBe('test-org/x');
    expect(url.searchParams.get('sha')).toBe('abc1234def');
    expect(url.searchParams.get('reason')).toBe(reason);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('the report link never carries the token, even after a gated retry (issue #17)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 'denied', message: 'gated or private repo: an access token is required (HTTP 401 on config.json)' });
    renderWith(<HfImportDrawer />);
    openDialog({ type: 'dialog', id: 'hf', hfQuery: 'test-org/gated' });
    const d = await drawer();
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    await userEvent.type(await within(d).findByLabelText(/Hugging Face token/), 'hf_secret123');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 'unparsable', message: 'missing: hidden_size', missing: ['hidden_size'], unsupported: [], repo: 'test-org/gated', sha: 'abc1234def' });
    await userEvent.click(within(d).getByRole('button', { name: '匯入' }));
    const link = await within(d).findByTestId('hf-report');
    expect(link.getAttribute('href')).not.toContain('hf_secret123');
    expect(within(d).getByTestId('hf-error')).toHaveTextContent('缺少：hidden_size');
  });

  it('GGUF → the base model in one click (issue #17)', async () => {
    const { d, alert } = await submitFailure({
      ok: false, status: 'gguf', message: 'GGUF repo without config.json', repo: 'quant-org/m-GGUF', sha: 'abc1234def', baseModels: ['test-org/m'],
    }, 'quant-org/m-GGUF');
    expect(alert).toHaveTextContent('這個 repo 只有 GGUF 檔，沒有 config.json');
    await userEvent.click(within(alert).getByRole('button', { name: '改匯入 test-org/m' }));
    expect(within(d).getByLabelText('Hugging Face 模型（owner/name）')).toHaveValue('test-org/m');
    expect(within(d).queryByTestId('hf-error')).toBeNull();
  });
});

describe('reportModelUrl', () => {
  it('caps the reason so the link stays short; no sha → main', () => {
    const url = new URL(reportModelUrl('a/b', undefined, 'x'.repeat(5000)));
    expect(url.searchParams.get('reason')).toHaveLength(REPORT_REASON_MAX);
    expect(url.searchParams.get('config')).toBe('https://huggingface.co/a/b/blob/main/config.json');
    expect(url.searchParams.has('sha')).toBe(false);
    expect(url.href.length).toBeLessThan(8000);
  });
});

describe('AccuracyDrawer', () => {
  it('accuracy drawer', async () => {
    renderWith(<AccuracyDrawer />);
    openDialog({ type: 'dialog', id: 'accuracy' });
    const d = await drawer();
    const rows = within(d).getAllByTestId('accuracy-row');
    expect(rows).toHaveLength(Object.keys(b.platforms).length);
    const acc = getAccuracy().byPlatform;
    Object.keys(b.platforms).forEach((id, i) => {
      const row = rows[i]!;
      expect(row).toHaveTextContent(b.platforms[id]!.name);
      const has = acc.filter((a) => a.platform === id);
      if (has.length === 0) expect(row).toHaveTextContent('無實測');
      for (const a of has.filter((x) => x.metric === 'decodeTokPerSec' && x.role === 'validate')) {
        expect(row).toHaveTextContent(`平均 ${zh(a.meanAbsErrorPct)}%`);
        expect(row).toHaveTextContent(`最大 ${zh(a.maxAbsErrorPct)}%`);
        expect(row).toHaveTextContent(`${a.n} 點`);
      }
    });
    expect(acc.some((a) => a.platform === 'nano4-gb200')).toBe(false);
  });

  it('the footer link opens it', async () => {
    history.replaceState(null, '', '/');
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '準確度' }));
    const d = await drawer();
    expect(within(d).getAllByTestId('accuracy-row').length).toBeGreaterThan(0);
  });
});

describe('HF refetch on load (Ruling W1)', () => {
  const hfUrl = () => {
    const s: CalcState = { ...defaultState(b), model: 'custom', customModel: { kind: 'hf', repo: 'test-org/test-model', sha: 'abc1234def' } };
    return '?' + encodeUrl(s);
  };

  it('refetches at the stored sha', async () => {
    const { model, source } = importedFixture();
    fetchMock.mockResolvedValue({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] });
    history.replaceState(null, '', '/' + hfUrl());
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('test-org/test-model', expect.objectContaining({ revision: 'abc1234def' })));
    await waitFor(() => expect(screen.queryByTestId('answer-loading')).toBeNull());
    expect(screen.getByLabelText('模型').closest('.ant-select-content')).toHaveTextContent('test-org/test-model');
  });

  it('a shared link keeps its card counts through the refetch (hydration, not an input change)', async () => {
    const { model, source } = importedFixture();
    fetchMock.mockResolvedValue({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] });
    // As a sharer's link carries it: the imported model's precision (q=) and a card count (o=).
    const shared: CalcState = {
      ...defaultState(b),
      model: 'custom',
      quant: quantOptions(b, 'gpt-oss-20b')[0]!,
      customModel: { kind: 'hf', repo: 'test-org/test-model', sha: 'abc1234def' },
      overrides: { 'nano4-h200': { gpus: 8 } },
    };
    history.replaceState(null, '', '/?' + encodeUrl(shared));
    render(
      <StoreProvider>
        <AntApp>
          <HfRefetch />
          <Probe />
        </AntApp>
      </StoreProvider>,
    );
    expect(state().overrides).toEqual({ 'nano4-h200': { gpus: 8 } });
    await waitFor(() => expect(state().customModel).toMatchObject({ kind: 'hf', imported: { model, source } }));
    expect(state().overrides).toEqual({ 'nano4-h200': { gpus: 8 } });
    await waitFor(() => expect(location.search).toContain('o=nano4-h200%3A8'));
    // A real input change afterwards still clears them.
    act(() => send({ type: 'users', value: 77 }));
    expect(state().overrides).toEqual({});
  });

  it('a failed refetch shows an error and falls back to the default model', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 'not-found', message: 'model API HTTP 404' });
    history.replaceState(null, '', '/' + hfUrl());
    render(<App />);
    await waitFor(() => expect(document.querySelector('.ant-message-error')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('answer-loading')).toBeNull());
    expect(screen.getByLabelText('模型').closest('.ant-select-content')).toHaveTextContent(b.models[defaultState(b).model]!.name);
  });

  it('a network failure keeps the link and offers Retry or the default model (review I3)', async () => {
    const { model, source } = importedFixture();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 'network', message: 'Failed to fetch' });
    history.replaceState(null, '', '/' + hfUrl());
    render(<App />);
    const retry = await screen.findByRole('button', { name: '重試' });
    expect(screen.getByText('無法連線到 Hugging Face，暫時無法重新匯入 test-org/test-model；連結已保留')).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get('hf')).not.toBeNull();
    expect(screen.getByTestId('answer-loading')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce({ ok: true, repo: 'test-org/test-model', sha: 'abc1234def', model, source, notes: [], cardBases: [] });
    await userEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('answer-loading')).toBeNull());
    expect(screen.getByLabelText('模型').closest('.ant-select-content')).toHaveTextContent('test-org/test-model');
  });

  it('after a network failure, 改用預設模型 falls back', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 'network', message: 'Failed to fetch' });
    history.replaceState(null, '', '/' + hfUrl());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '改用預設模型' }));
    await waitFor(() => expect(screen.queryByTestId('answer-loading')).toBeNull());
    expect(screen.getByLabelText('模型').closest('.ant-select-content')).toHaveTextContent(b.models[defaultState(b).model]!.name);
  });

  it('a gated link opens the HF drawer with the token field (Ruling W12)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 'denied', message: 'gated or private repo: an access token is required (HTTP 401 on config.json)' });
    history.replaceState(null, '', '/' + hfUrl());
    render(<App />);
    const d = await drawer();
    expect(within(d).getByLabelText(/Hugging Face 模型/)).toHaveValue('test-org/test-model');
    expect(within(d).getByText('網址中的模型 test-org/test-model 需要授權才能重新匯入，請貼上你的 Hugging Face token。')).toBeInTheDocument();
    expect(within(d).getByLabelText(/Hugging Face token/)).toBeInTheDocument();
    // Closing without importing drops the model.
    fireEvent.click(d.closest('.ant-drawer')!.querySelector('.ant-drawer-close')!);
    await waitFor(() => expect(screen.queryByTestId('answer-loading')).toBeNull());
  });
});

describe('CiteModal copy (v8 minor 4)', () => {
  const modal = () => waitFor(() => {
    const m = document.querySelector<HTMLElement>('.ant-modal');
    expect(m).not.toBeNull();
    return m!;
  });

  it('with nothing to cite the copy button is disabled', async () => {
    // An HF model not yet refetched: no result, so no citation text.
    renderWith(<CiteModal />, '?hf=test-org/test-model@abc1234');
    openDialog({ type: 'dialog', id: 'cite' });
    const m = await modal();
    expect(within(m).getByTestId('cite-text').textContent).toBe('');
    expect(within(m).getByRole('button', { name: /複製/ })).toBeDisabled();
  });

  it('a failed clipboard write shows an error, never 已複製', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      renderWith(<CiteModal />);
      openDialog({ type: 'dialog', id: 'cite' });
      const m = await modal();
      const copy = within(m).getByRole('button', { name: /複製/ });
      expect(copy).toBeEnabled();
      await userEvent.click(copy);
      expect(writeText).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText('無法複製，請手動選取文字複製')).toBeInTheDocument());
      expect(screen.queryByText('已複製')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
