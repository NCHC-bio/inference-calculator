import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Model, Source } from '@nchc/schema';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { BasisModal } from '../src/components/BasisModal';
import { computeMain, type MainView } from '../src/compute/compute';
import { tZh } from '../src/i18n';
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
  });

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
    r.basis.slice(0, 6).forEach((x, i) => {
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
