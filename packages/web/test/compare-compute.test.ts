import { estimatePerformance, quantOptions } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { cardCounts, computeCompare, variantGroups } from '../src/compute/compare';
import { computeMain } from '../src/compute/compute';
import { performanceQueryOf, rowPerf } from '../src/compute/query';
import { defaultState, reduce, type CalcState, type CompareSpec } from '../src/state/state';

const b = getBundle();
const H200 = 'nano4-h200';
const H100 = 'nano5-h100';
const MAC = 'mac-studio-m5u-512';
const base: CalcState = { ...reduce(b, defaultState(b), { type: 'workload', id: 'chat' }), users: 60 };
const withLines = (s: CalcState, lines: CompareSpec[]): CalcState => reduce(b, s, { type: 'compareAdd', lines });
const view = (s: CalcState) => computeCompare(b, s, computeMain(b, s))!;
const okRow = (s: CalcState, row: string) => {
  const m = computeMain(b, s);
  if (m.kind !== 'main') throw new Error('no main');
  const r = m.rows.find((x) => x.row === row);
  if (r?.kind !== 'ok') throw new Error(`${row} not ok`);
  return r;
};

describe('computeCompare', () => {
  it('is null without lines', () => {
    expect(computeCompare(b, base, computeMain(b, base))).toBeNull();
  });

  it("a plain line equals the row's estimatePerformance", () => {
    const s = withLines(base, [{ row: H200 }]);
    const v = view(s).lines[0]!;
    const r = okRow(s, H200);
    const direct = rowPerf(b, s, H200, { gpus: r.count });
    expect(v.count).toBe(r.count);
    expect(v.status).toBe('ok');
    expect(v.perf!.usage!.tokPerSecPerUser).toBe(direct.usage!.tokPerSecPerUser);
    expect(v.perf!.usage!.ttftSec).toBe(direct.usage!.ttftSec);
    expect(v.perf!.maxConcurrent).toBe(direct.maxConcurrent);
    expect(v.perf!.powerKw).toBe(direct.powerKw);
    expect(v.changed).toEqual({ model: false, quant: false, workload: false, inputTokens: false, gpus: false });
  });

  it("a model variant keeps the source count and uses the model's own quant when the current one is not offered", () => {
    const s = withLines(base, [{ row: H200, model: 'gpt-oss-20b', gpus: 2 }]);
    const v = view(s).lines[0]!;
    expect(v.count).toBe(2);
    expect(v.quant).toBe(quantOptions(b, 'gpt-oss-20b')[0]);
    expect(v.modelName).toBe(b.models['gpt-oss-20b']!.name);
    expect(v.changed.model).toBe(true);
    expect(v.params.activeB).not.toBeNull();
    expect(v.params.totalB).toBe(b.models['gpt-oss-20b']!.totalParamsB.value);
  });

  it("quant falls back when the line's model does not offer it", () => {
    const s = withLines(base, [{ row: H200, quant: 'int4-awq' }]);
    expect(quantOptions(b, s.model)).not.toContain('int4-awq');
    expect(view(s).lines[0]!.quant).toBe(s.quant);
  });

  it("inputTokens builds a custom workload on the line's base", () => {
    const s = withLines(base, [{ row: H200, inputTokens: 32000, gpus: 4 }]);
    const v = view(s).lines[0]!;
    const direct = estimatePerformance(b, { ...performanceQueryOf(b, s, H200, 4), workload: { base: 'chat', inputTokens: 32000 } });
    expect(v.inputTokens).toBe(32000);
    expect(v.perf!.usage!.ttftSec).toBe(direct.usage!.ttftSec);
    expect(v.perf!.maxConcurrent).toBe(direct.maxConcurrent);
  });

  it('users points stop before memory runs out', () => {
    const s = withLines(base, [{ row: H200, gpus: 1 }]);
    const cv = view(s);
    const v = cv.lines[0]!;
    expect(v.users.length).toBeGreaterThan(3);
    for (const p of v.users) expect(cv.curveUsers).toContain(p.x);
    const curve = v.perf!.speedCurve!.points;
    const firstMem = curve.find((p) => p.why === 'mem' || p.why === 'context');
    if (firstMem) expect(Math.max(...v.users.map((p) => p.x))).toBeLessThan(firstMem.users);
    expect(cv.curveUsers[0]).toBe(1);
    expect(cv.curveUsers[cv.curveUsers.length - 1]).toBe(cv.usersMax);
    expect(cv.curveUsers).toContain(s.users);
    expect(cv.curveUsers.length).toBeLessThanOrEqual(64);
  });

  it('a read length over the model context is 放不下 with core detail', () => {
    const s = withLines(base, [{ row: H200, model: 'phi-4', inputTokens: 32000, gpus: 8 }, { row: H200 }]);
    const [bad, good] = view(s).lines;
    expect(bad!.status).toBe('nofit');
    expect(bad!.users).toEqual([]);
    expect(bad!.perf?.detail ?? bad!.error).toBeTruthy();
    expect(good!.status).toBe('ok');
  });

  it('an infeasible row compares at one node (GPU) or one machine (Mac)', () => {
    const s0 = { ...base, users: 5000, workload: 'assist' };
    const s = withLines(s0, [{ row: MAC }, { row: H100 }]);
    const m = computeMain(b, s);
    if (m.kind !== 'main') throw new Error('no main');
    const lines = view(s).lines;
    if (m.rows.find((r) => r.row === MAC)!.kind === 'infeasible') expect(lines[0]!.count).toBe(1);
    if (m.rows.find((r) => r.row === H100)!.kind === 'infeasible') expect(lines[1]!.count).toBe(b.platforms[H100]!.gpusPerNode.value);
    expect(m.rows.some((r) => (r.row === MAC || r.row === H100) && r.kind === 'infeasible')).toBe(true);
  });

  it('showCards only with two GPU setups', () => {
    expect(view(withLines(base, [{ row: H200 }, { row: MAC }])).showCards).toBe(false);
    expect(view(withLines(base, [{ row: H200 }, { row: H200, model: 'gpt-oss-20b' }])).showCards).toBe(false);
    const two = view(withLines(base, [{ row: H200 }, { row: H100 }]));
    expect(two.showCards).toBe(true);
    expect(two.lines[0]!.sweep!.length).toBeGreaterThan(0);
    expect(two.cardsMax).toBeGreaterThanOrEqual(8);
    expect(view(withLines(base, [{ row: MAC }])).lines[0]!.sweep).toBeNull();
  });

  it('hot counts ttft vs bw/compute', () => {
    const s = withLines({ ...base, users: 100000 }, [{ row: H200, gpus: 1 }, { row: H100, gpus: 1 }]);
    const cv = view(s);
    const whys = cv.lines.map((l) => l.perf?.why);
    expect(cv.hot.ttft).toBe(whys.filter((w) => w === 'ttft').length);
    expect(cv.hot.tps).toBe(whys.filter((w) => w === 'bw' || w === 'compute').length);
  });
});

describe('variantGroups', () => {
  const groupsFor = (s: CalcState, i = 0) => {
    const main = computeMain(b, s);
    return variantGroups(b, s, main, computeCompare(b, s, main)!.lines[i]!);
  };
  const group = (gs: ReturnType<typeof groupsFor>, key: string) => gs.find((g) => g.key === key)!;

  it('gpus items: half, plus one node, double — deduped', () => {
    const gs = groupsFor(withLines(base, [{ row: H200, gpus: 8 }]));
    const g = group(gs, 'gpus');
    expect(g.items.map((i) => i.specs[0]!.gpus)).toEqual([4, 16]);
    expect(g.items[0]!.label).toEqual({ kind: 'gpus', n: 4, half: true });
  });

  it('model / quant / workload / read variants keep the source count', () => {
    const gs = groupsFor(withLines(base, [{ row: H200 }]));
    const count = view(withLines(base, [{ row: H200 }])).lines[0]!.count;
    for (const k of ['model', 'workload', 'read']) {
      for (const it of group(gs, k).items) expect(it.specs[0]!.gpus).toBe(count);
    }
    expect(group(gs, 'model').items.some((i) => i.specs[0]!.model === base.model)).toBe(false);
    expect(group(gs, 'read').items.map((i) => i.specs[0]!.inputTokens)).toEqual([8000, 32000, 128000]);
    expect(group(gs, 'workload').items.map((i) => i.specs[0]!.workload)).toEqual(['doc', 'assist']);
  });

  it('the quant all item has one spec per other quant', () => {
    const gs = groupsFor(withLines(base, [{ row: H200, model: 'gemma-4-31b-it' }]));
    const g = group(gs, 'quant');
    const singles = g.items.filter((i) => !(i.label.kind === 'quant' && i.label.all));
    const all = g.items.find((i) => i.label.kind === 'quant' && i.label.all)!;
    expect(singles.length).toBeGreaterThanOrEqual(2);
    expect(all.specs.map((x) => x.quant)).toEqual(singles.map((i) => i.specs[0]!.quant));
  });

  it('platform items exclude the source row and follow their own count', () => {
    const gs = groupsFor(withLines(base, [{ row: H200, model: 'gpt-oss-20b' }]));
    const g = group(gs, 'platform');
    expect(g.items.some((i) => i.specs[0]!.row === H200)).toBe(false);
    for (const it of g.items) {
      expect(it.specs[0]!.gpus).toBeUndefined();
      expect(it.specs[0]!.model).toBe('gpt-oss-20b');
    }
  });
});

describe('variantGroups model', () => {
  it("keeps the line's own quant when the new model offers it", () => {
    const s = withLines(base, [{ row: H200, model: 'gemma-4-31b-it', quant: 'int4-awq' }]);
    const main = computeMain(b, s);
    const gs = variantGroups(b, s, main, computeCompare(b, s, main)!.lines[0]!);
    const items = gs.find((g) => g.key === 'model')!.items;
    const gemma12 = items.find((i) => i.specs[0]!.model === 'gemma-4-12b-it')!;
    expect(gemma12.specs[0]!.quant).toBe('int4-awq');
    const llama = items.find((i) => i.specs[0]!.model === 'llama-3.3-70b-instruct-fp8')!;
    expect(llama.specs[0]!.quant).toBeUndefined();
  });
});

describe('final review fixes', () => {
  it('platform variants carry the platform name and sub-label', () => {
    const s = withLines(base, [{ row: H200 }]);
    const main = computeMain(b, s);
    const g = variantGroups(b, s, main, computeCompare(b, s, main)!.lines[0]!).find((x) => x.key === 'platform')!;
    const h100 = g.items.find((i) => i.specs[0]!.row === H100)!;
    expect(h100.label).toMatchObject({ kind: 'platform', name: b.platforms[H100]!.name, sub: b.platforms[H100]!.sub, unit: 'gpu' });
  });

  it("curveUsers holds each line's maxConcurrent, so the cap is a core point", () => {
    const cv = view(withLines(base, [{ row: H200 }, { row: H100 }]));
    for (const l of cv.lines) {
      const mc = l.perf!.maxConcurrent;
      if (mc > 0 && mc <= cv.usersMax) expect(cv.curveUsers).toContain(mc);
    }
    expect(cv.curveUsers.length).toBeLessThanOrEqual(64);
  });

  it('the GPUs sweep reaches large setups and includes every line count', () => {
    const cv = view(withLines({ ...base, users: 5000 }, [{ row: H200, gpus: 128 }, { row: H100, gpus: 8 }]));
    expect(cv.cardsMax).toBe(256);
    const xs = cv.lines[0]!.sweep!.map((p) => p.x);
    expect(xs).toContain(128);
    expect(xs.length).toBeLessThanOrEqual(64);
    const list = cardCounts(256, [128, 8]);
    expect(list).toEqual(expect.arrayContaining([1, 8, 128, 256]));
    expect(list.length).toBe(64);
    expect(list.every((v, i) => i === 0 || v > list[i - 1]!)).toBe(true);
  });

  it('changed.quant compares the resolved quant with the sentence', () => {
    const fallback = view(withLines(base, [{ row: H200, quant: 'int4-awq' }])).lines[0]!;
    expect(fallback.changed.quant).toBe(false);
    const other = view(withLines(base, [{ row: H200, model: 'gpt-oss-20b' }])).lines[0]!;
    expect(other.quant).not.toBe(base.quant);
    expect(other.changed.quant).toBe(true);
  });
});
