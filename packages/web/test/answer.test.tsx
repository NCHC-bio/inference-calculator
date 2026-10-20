import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { shown } from './helpers';
import type { RequirementResult } from '@nchc/core';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { needAnswerText } from '../src/components/AnswerLine';
import { computeView, type HaveView, type NeedView } from '../src/compute/compute';
import { tZh } from '../src/i18n';
import { decodeUrl } from '../src/state/url';
import { defaultState } from '../src/state/state';

// Review Focus 1. The brief's `?m=mistral-medium-3.5-128b&q=bf16&w=assist&n=100000` is feasible in the current bundle
// (mistral-medium only offers fp8; nano4-gb200 runs it at every n up to 1e6, and from ~3e6 core rejects the replica
// count). OLMo 2 32B's context window is shorter than the workload's, so every platform is infeasible at any n.
const ALL_INFEASIBLE = '?m=olmo-2-0325-32b&q=bf16&w=assist&n=100000';

describe('AnswerLine', () => {
  it('need answer equals core best', () => {
    const b = getBundle(); const r = computeView(b, defaultState(b)) as NeedView;
    render(<App />);
    expect(screen.getByTestId('answer-main')).toHaveTextContent(needAnswerText(r.result, b, tZh).main);
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(needAnswerText(r.result, b, tZh).sub);
  });
  it('all NCHC platforms infeasible → plain message, rows still render (Review Focus 1)', () => {
    const b = getBundle();
    expect((computeView(b, decodeUrl(b, ALL_INFEASIBLE)) as NeedView).result.best).toBeNull();
    history.replaceState(null, '', '/' + ALL_INFEASIBLE);
    render(<App />);
    expect(screen.getByTestId('answer-main')).toHaveTextContent('國網機台都不可行');
    expect(screen.getByTestId('answer-sub')).toHaveTextContent('可嘗試較小的模型、較低精度或放寬速度');
  });
  it('basis drawer lists every basis item with its status', async () => {
    render(<App />); await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
    const paths = new Set(r.basis.map((x) => x.path));
    expect(screen.getAllByTestId('basis-item')).toHaveLength(paths.size);
    const first = screen.getAllByTestId('basis-item')[0]!;
    expect(first).toHaveTextContent(r.basis[0]!.text);
  });
  it('basis drawer opens with the concurrency reading of the workload kind (spec §8.3.3)', async () => {
    render(<App />); await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const b = getBundle(); const kind = b.workloads[defaultState(b).workload]!.kind;
    const rule = kind === 'chat' ? b.concurrency.chatRule : b.concurrency.agentRule;
    expect(screen.getByTestId('concurrency-reading')).toHaveTextContent(rule.value);
  });
  it('estimate tag popover lists the estimates', async () => {
    render(<App />); await userEvent.click(screen.getByText('推估'));
    await shown('查看全部依據 →');
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
    const est = r.basis.find((x) => x.status === 'estimate')!;
    expect(screen.getAllByText(est.text, { exact: false }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText('查看全部依據 →'));
    await waitFor(() => expect(screen.getAllByTestId('basis-item').length).toBeGreaterThan(0));
  });
  it('estimate tag popover also lists unverified inputs, each with its status tag (spec §2.1 rule 2; final review I4)', async () => {
    const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
    const unv = r.basis.find((x) => x.status === 'unverified')!;
    const est = r.basis.find((x) => x.status === 'estimate')!;
    expect(unv).toBeDefined();
    render(<App />); await userEvent.click(screen.getByText('推估'));
    await shown('查看全部依據 →');
    const pop = screen.getByRole('tooltip');
    const items = within(pop).getAllByTestId('estimate-item');
    const unvItem = items.find((x) => x.textContent!.includes(unv.text))!;
    expect(unvItem).toBeDefined();
    expect(within(unvItem).getByText('未查證')).toBeInTheDocument();
    const estItem = items.find((x) => x.textContent!.includes(est.text))!;
    expect(within(estItem).getByText('推估')).toBeInTheDocument();
  });
  it('cite button is present but disabled', () => {
    render(<App />); expect(screen.getByRole('button', { name: /引用/ })).toBeDisabled();
  });
  it('have mode: 同時最多 N 人 and 保守 N 人 from core', () => {
    history.replaceState(null, '', '/?mode=have');
    const b = getBundle(); const r = (computeView(b, decodeUrl(b, '?mode=have')) as HaveView).result;
    render(<App />);
    expect(r.expected.n).toBeGreaterThan(0);
    expect(screen.getByTestId('answer-main')).toHaveTextContent(`同時最多 ${r.expected.n.toLocaleString('zh-TW')} 人`);
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(`保守 ${r.conservative.n.toLocaleString('zh-TW')} 人`);
  });
  it('have mode with nobody fitting: 不可行 and core detail', () => {
    const url = '?mode=have&m=olmo-2-0325-32b&q=bf16&w=assist';
    const b = getBundle(); const r = (computeView(b, decodeUrl(b, url)) as HaveView).result;
    expect(r.expected.n).toBe(0);
    history.replaceState(null, '', '/' + url);
    render(<App />);
    expect(screen.getByTestId('answer-main')).toHaveTextContent('不可行');
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(r.detail!);
  });
});

describe('needAnswerText', () => {
  const b = getBundle();
  const base = (computeView(b, defaultState(b)) as NeedView).result;
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
