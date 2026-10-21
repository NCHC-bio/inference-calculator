import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Model, Source } from '@nchc/schema';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { BasisModal } from '../src/components/BasisModal';
import { computeMain, type MainView } from '../src/compute/compute';
import { t, tZh } from '../src/i18n';
import { topEstimates, uniqueByPath } from '../src/components/weak';
import { CUSTOM_MODEL_WARNING, type BasisItem } from '@nchc/core';
import { citeText } from '../src/components/citeText';
import { defaultState, workloadId, type Action } from '../src/state/state';
import { StoreProvider, useCalc } from '../src/state/store';

const modal = () =>
  waitFor(() => {
    const m = document.querySelector<HTMLElement>('.ant-modal');
    expect(m).not.toBeNull();
    expect(m).toBeVisible();
    return m!;
  });

let send: (a: Action) => void = () => {};
function Driver() {
  send = useCalc()[1];
  return null;
}

describe('BasisModal', () => {
  it('basis button opens the modal on all', async () => {
    const b = getBundle(); const r = (computeMain(b, defaultState(b)) as MainView & { kind: 'main' }).result;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const m = await modal();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(within(m).getByText(`全部（${r.basis.length}）`).closest('.ant-segmented-item')).toHaveClass('ant-segmented-item-selected');
    const items = within(m).getAllByTestId('basis-item');
    expect(items).toHaveLength(r.basis.length);
    expect(items[0]).toHaveTextContent(r.basis[0]!.text);
    // The filter switches in place.
    const weak = r.basis.filter((x) => x.status === 'estimate' || x.status === 'unverified').length;
    await userEvent.click(within(m).getByText(`推估與未查證（${weak}）`));
    await waitFor(() => expect(within(m).getAllByTestId('basis-item')).toHaveLength(weak));
    // 2.3 s alone; renders the whole App and every basis item, so a loaded full `pnpm test` run can pass 5 s.
  }, 20_000);

  it('the content scrolls inside 70vh', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const m = await modal();
    const body = m.querySelector<HTMLElement>('.ant-modal-body')!;
    expect(body.style.maxHeight).toBe('70vh');
    expect(body.style.overflowY).toBe('auto');
  });

  it('shows the concurrency reading of the workload kind (spec §8.3.3)', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const b = getBundle(); const kind = b.workloads[workloadId(defaultState(b).workload)]!.kind;
    const rule = kind === 'chat' ? b.concurrency.chatRule : b.concurrency.agentRule;
    expect(await screen.findByTestId('concurrency-reading')).toHaveTextContent(rule.value);
  });

  it('imported model sources resolve', async () => {
    const b = getBundle();
    const catalog = b.models['gpt-oss-20b']!;
    const source: Source = { ...b.sources[catalog.source]!, id: 'hf:test-org/test-model@abc123', title: 'test-org/test-model config.json', url: 'https://huggingface.co/test-org/test-model' };
    // Every citation of the catalog source becomes the imported one (core checks they match).
    const model = JSON.parse(JSON.stringify({ ...catalog, id: 'test-model', name: 'Test Model' }), (_k, v) => (v === catalog.source ? source.id : v)) as Model;
    expect(Object.hasOwn(b.sources, source.id)).toBe(false);
    render(
      <StoreProvider>
        <BasisModal />
        <Driver />
      </StoreProvider>,
    );
    act(() => send({ type: 'customModel', value: { kind: 'hf', repo: 'test-org/test-model', sha: 'abc123', imported: { model, source } } }));
    act(() => send({ type: 'dialog', id: 'basis', basisFilter: 'all' }));
    const m = await modal();
    const item = within(m).getAllByTestId('basis-item').find((x) => x.textContent!.includes('Test Model 總參數量'))!;
    expect(item).toBeDefined();
    const link = within(item).getByRole('link', { name: source.title });
    expect(link).toHaveAttribute('href', source.url);
  });
});

describe('CiteModal', () => {
  const weakOf = (r: { basis: BasisItem[] }) => uniqueByPath(r.basis.filter((x) => x.status === 'estimate' || x.status === 'unverified'));

  it('says the result rests on estimates, with the 推估 popover count, and lists them first', () => {
    const b = getBundle(); const s = defaultState(b);
    const r = (computeMain(b, s) as MainView & { kind: 'main' }).result;
    expect(r.hasEstimate).toBe(true);
    const n = weakOf(r).length;
    expect(n).toBeGreaterThan(0);
    const text = citeText(b, s, r, tZh);
    expect(text).toContain(`此結果含 ${n} 項推估／未查證的數值，詳見計算依據`);
    const lines = text.split('\n').filter((l) => /^\[\d+\] /.test(l));
    expect(lines).toHaveLength(6);
    const first = lines.slice(0, Math.min(n, 6));
    for (const l of first) expect(l).toMatch(/（(推估|未查證)；/);
    // Deduplicated by path: no line repeats.
    expect(new Set(lines.map((l) => l.replace(/^\[\d+\] /, ''))).size).toBe(lines.length);
    const en = citeText(b, { ...s, lang: 'en' }, r, (k, v) => t('en', k, v));
    expect(en).toContain(`This result uses ${n} estimated or unverified values; see the calculation basis.`);
  });

  it('a manual model carries the custom-model warning', () => {
    const b = getBundle();
    // Test fixture architecture, not a catalog value.
    const manual = { name: 'My 8B', totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 };
    const s = { ...defaultState(b), model: 'custom', customModel: { kind: 'manual' as const, value: manual } };
    const r = (computeMain(b, s) as MainView & { kind: 'main' }).result;
    expect(r.warnings.map((w) => w.text)).toEqual([CUSTOM_MODEL_WARNING.text]);
    expect(citeText(b, s, r, tZh)).toContain(CUSTOM_MODEL_WARNING.text);
  });

  it('a custom workload and speed target state their numbers and that they are 自訂 (v8 minor 8)', () => {
    const b = getBundle();
    // Test fixture values, not catalog values.
    const s = {
      ...defaultState(b),
      workload: { base: 'chat', inputTokens: 3000, outputTokens: 600, cacheHitRate: 0.3 },
      speed: { minTokPerSec: 12, maxTtftSec: 3 },
    };
    const r = (computeMain(b, s) as MainView & { kind: 'main' }).result;
    const zh = citeText(b, s, r, tZh);
    expect(zh).toContain('自訂工作：每次讀入 3,000 token、回覆 600 token、快取命中率 30%（自訂）');
    expect(zh).toContain('自訂速度標準：每人每秒至少 12 字、首字等待不超過 3 秒（自訂）');
    const en = citeText(b, { ...s, lang: 'en' }, r, (k, v) => t('en', k, v));
    expect(en).toContain('Custom workload: 3,000 input tokens and 600 output tokens per request, cache hit rate 30% (custom)');
    expect(en).toContain('Custom speed target: at least 12 tokens per second per user, time to first token at most 3 s (custom)');
    // Presets add no such lines.
    const preset = defaultState(b);
    const pr = (computeMain(b, preset) as MainView & { kind: 'main' }).result;
    expect(citeText(b, preset, pr, tZh)).not.toMatch(/自訂工作：|自訂速度標準：/);
  });

  it('cite modal text', async () => {
    const b = getBundle(); const s = defaultState(b);
    const r = (computeMain(b, s) as MainView & { kind: 'main' }).result;
    const best = r.perPlatform.find((p) => p.platform === r.best)!;
    if (!best.expected.ok || !best.conservative.ok) throw new Error('fixture: default best must be feasible');
    const text = citeText(b, s, r, tZh);
    const speed = b.speedPresets[s.speed as string]!;
    const plat = b.platforms[r.best!]!;
    for (const want of [
      b.models[s.model]!.name,
      b.quantization[s.quant]!.name,
      `${s.users} 名使用者`,
      `每人每秒至少 ${speed.minTokensPerSec.value} 字`,
      `首字等待不超過 ${speed.maxTtftSec.value} 秒`,
      `${plat.name}（${plat.sub}）${best.expected.gpus} 張`,
      `保守估計 ${best.conservative.gpus} 張`,
    ]) expect(text).toContain(want);
    // Weak (推估／未查證) items first in the 推估 popover's order, then the rest; one line per path.
    const bestBasis = r.perPlatform.find((p) => p.platform === r.best)!.basis;
    const listed = uniqueByPath([...topEstimates(r.basis, Infinity, bestBasis), ...r.basis]);
    listed.slice(0, 6).forEach((x, i) => {
      const src = x.sourceIds.filter((id) => Object.hasOwn(b.sources, id)).map((id) => b.sources[id]!.title).join('、') || '—';
      expect(text).toContain(`[${i + 1}] ${x.text}（${tZh(`status.${x.status}`)}；${src}）`);
    });
    expect(text).not.toContain('[7]');

    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /引用/ }));
    const m = await modal();
    expect(within(m).getByText('可貼進申請書／報告的文字')).toBeInTheDocument();
    expect(m.querySelector('[data-testid="cite-text"]')!.textContent).toContain(text.split('\n')[0]!);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(within(m).getByRole('button', { name: /複製/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  });
});
