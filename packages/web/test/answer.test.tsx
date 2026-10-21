import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shown } from './helpers';
import type { RequirementResult } from '@nchc/core';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { AnswerLine, needAnswerText } from '../src/components/AnswerLine';
import { BasisModal } from '../src/components/BasisModal';
import { computeMain, type MainView } from '../src/compute/compute';
import { tZh } from '../src/i18n';
import { TRANSITION_MS } from '../src/motion';
import { decodeUrl } from '../src/state/url';
import { defaultState, type Action, type CalcState } from '../src/state/state';
import { StoreProvider, useCalc } from '../src/state/store';

// Review Focus 1. OLMo 2 32B's context window is shorter than the workload's, so every platform is infeasible at any n.
const ALL_INFEASIBLE = '?m=olmo-2-0325-32b&q=bf16&w=assist&n=100000';
const CUSTOM = { name: 'Lab GPU', unit: 'gpu' as const, gpusPerNode: 8, memGB: 80, memBwTBs: 3, tflops: 900, engine: 'vllm' as const };

const resultOf = (s: CalcState) => (computeMain(getBundle(), s) as MainView & { kind: 'main' }).result;
const weakCount = (r: RequirementResult) => r.basis.filter((x) => x.status === 'estimate' || x.status === 'unverified').length;

let send: (a: Action) => void = () => {};
function Driver() {
  send = useCalc()[1];
  return null;
}
const renderAnswer = () =>
  render(
    <StoreProvider>
      <AntApp>
        <AnswerLine />
        <BasisModal />
        <Driver />
      </AntApp>
    </StoreProvider>,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('AnswerLine', () => {
  it('need answer equals core best', () => {
    const b = getBundle(); const r = resultOf(defaultState(b));
    render(<App />);
    expect(screen.getByTestId('answer-main')).toHaveTextContent(needAnswerText(r, b, tZh).main);
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(needAnswerText(r, b, tZh).sub);
  });

  it('answer stays on the suggestion', () => {
    const b = getBundle(); const r = resultOf(defaultState(b));
    renderAnswer();
    const before = screen.getByTestId('answer-main').textContent;
    act(() => send({ type: 'override', row: r.best!, value: { gpus: 64 } }));
    expect(screen.getByTestId('answer-main').textContent).toBe(before);
    expect(screen.getByTestId('answer-main')).toHaveTextContent(needAnswerText(r, b, tZh).main);
  });

  it('answer numbers tween while the best platform stays', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] });
    const b = getBundle();
    const s0 = defaultState(b);
    const r0 = resultOf(s0);
    // A user count with the same best platform and a different answer.
    const users = [2, 3, 4, 5, 6, 8, 10, 20, 25, 30, 40, 50].find((u) => {
      const r = resultOf({ ...s0, users: u });
      return r.best === r0.best && needAnswerText(r, b, tZh).main !== needAnswerText(r0, b, tZh).main;
    })!;
    expect(users).toBeDefined();
    const final = needAnswerText(resultOf({ ...s0, users }), b, tZh);
    renderAnswer();
    act(() => send({ type: 'users', value: users }));
    expect(screen.getByTestId('answer-main').textContent).not.toBe(final.main);
    act(() => void vi.advanceTimersByTime(TRANSITION_MS + 50));
    expect(screen.getByTestId('answer-main')).toHaveTextContent(final.main);
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(final.sub);
  });

  it('a new best platform shows its own count at once (never another platform’s number)', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] });
    const b = getBundle();
    const s200 = { ...defaultState(b), users: 200 };
    expect(resultOf(s200).best).not.toBe(resultOf(defaultState(b)).best);
    const final = needAnswerText(resultOf(s200), b, tZh);
    renderAnswer();
    act(() => send({ type: 'users', value: 200 }));
    expect(screen.getByTestId('answer-main')).toHaveTextContent(final.main);
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(final.sub);
  });

  it('estimate popover shows three and a see-all link', async () => {
    const b = getBundle(); const r = resultOf(defaultState(b)); const n = weakCount(r);
    expect(n).toBeGreaterThan(3);
    render(<App />);
    await userEvent.hover(screen.getByText('推估', { selector: '.ant-tag' }));
    const link = `查看全部 ${n} 項 →`;
    await shown(link);
    const pop = screen.getByRole('tooltip');
    const items = within(pop).getAllByTestId('estimate-item');
    expect(items).toHaveLength(3);
    for (const it of items) expect(it.querySelector('.ant-tag')).not.toBeNull();
    await userEvent.click(screen.getByText(link));
    await waitFor(() => expect(screen.getByText(link)).not.toBeVisible());
    const modal = await waitFor(() => {
      const m = document.querySelector<HTMLElement>('.ant-modal');
      expect(m).not.toBeNull();
      return m!;
    });
    expect(within(modal).getByText(`推估與未查證（${n}）`).closest('.ant-segmented-item')).toHaveClass('ant-segmented-item-selected');
    expect(within(modal).getAllByTestId('basis-item')).toHaveLength(n);
  });

  it('see-all works when the popover was opened by a click or tap (focus must not close it first)', async () => {
    render(<App />);
    const u = userEvent.setup();
    await u.click(screen.getByText('推估', { selector: '.ant-tag' }));
    const link = await waitFor(() => {
      const a = screen.getByText(/^查看全部 \d+ 項 →$/);
      expect(a).toBeVisible();
      return a;
    });
    await u.click(link);
    await waitFor(() => expect(document.querySelector('.ant-modal')).not.toBeNull());
  });

  it('estimate popover puts the best platform’s estimates first', async () => {
    const { topEstimates } = await import('../src/components/AnswerLine');
    const r = resultOf(defaultState(getBundle()));
    const bestBasis = r.perPlatform.find((p) => p.platform === r.best)!.basis;
    const top = topEstimates(r.basis, 3, bestBasis);
    const bestPaths = new Set(bestBasis.map((x) => x.path));
    const weakInBest = r.basis.filter((x) => (x.status === 'estimate' || x.status === 'unverified') && bestPaths.has(x.path));
    expect(top.map((x) => x.path)).toEqual(weakInBest.slice(0, 3).map((x) => x.path));
    expect(topEstimates(r.basis, 3).map((x) => x.path)).toEqual(
      r.basis.filter((x) => x.status === 'estimate' || x.status === 'unverified').slice(0, 3).map((x) => x.path),
    );
  });

  it('custom tag when hasUser', () => {
    renderAnswer();
    expect(screen.queryByText('自訂', { selector: '.ant-tag' })).toBeNull();
    act(() => send({ type: 'addPlatform', value: CUSTOM }));
    expect(screen.getByText('自訂', { selector: '.ant-tag' })).toBeInTheDocument();
  });

  it('share copies the URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    render(<App />);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: /分享/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(location.href));
    await shown('已複製分享連結');
  });

  it('no NCHC platform feasible', () => {
    const b = getBundle();
    expect(resultOf(decodeUrl(b, ALL_INFEASIBLE)).best).toBeNull();
    history.replaceState(null, '', '/' + ALL_INFEASIBLE);
    render(<App />);
    expect(screen.getByTestId('answer-main')).toHaveTextContent('國網機台都不可行');
    expect(screen.getByTestId('answer-sub')).toHaveTextContent('可嘗試較小的模型、較低精度或放寬速度');
  });
});

describe('needAnswerText', () => {
  const b = getBundle();
  const base = resultOf(defaultState(b));
  const withGpus = (gpus: number, conservativeOk = true): RequirementResult => ({
    ...base,
    perPlatform: base.perPlatform.map((p) =>
      p.platform !== base.best || !p.expected.ok || !p.conservative.ok
        ? p
        : { ...p, expected: { ...p.expected, gpus }, conservative: conservativeOk ? { ...p.conservative, gpus: gpus * 2 } : { ok: false, why: 'mem', detail: 'x' } as never },
    ),
  });
  const plat = b.platforms[base.best!]!;
  const per = plat.gpusPerNode.value;
  it('below one node: no node count', () => {
    expect(needAnswerText(withGpus(per - 1), b, tZh).main).toBe(`${plat.name} × ${per - 1} 張 ${plat.sub}`);
  });
  it('whole nodes: no decimal; partial: one decimal', () => {
    expect(needAnswerText(withGpus(per * 2), b, tZh).main).toContain(' · 約 2 個 node');
    expect(needAnswerText(withGpus(per * 1.5), b, tZh).main).toContain(' · 約 1.5 個 node');
  });
  it('conservative: × N, or — when infeasible', () => {
    expect(needAnswerText(withGpus(per), b, tZh).sub).toBe(`保守 × ${per * 2} 張`);
    expect(needAnswerText(withGpus(per, false), b, tZh).sub).toBe('保守 —');
  });
});
