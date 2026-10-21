import { quantOptions, type CustomPlatformInput } from '@nchc/core';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { CUSTOM_PLATFORMS_MAX, defaultState, reduce, type Action, type CalcState, type Pin } from '../src/state/state';

const b = getBundle();
const s0 = defaultState(b);

// Test fixtures (not catalog values).
const gpu = (name: string): CustomPlatformInput => ({ name, unit: 'gpu', gpusPerNode: 8, memGB: 80, memBwTBs: 3, tflops: 900, engine: 'vllm' });
const manual = { name: 'My 8B', totalParamsB: 8, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 };
const pin: Omit<Pin, 'id'> = { platform: { row: 'nano4-h200', name: 'H200', sub: 'x' }, unit: 'gpu', count: 8, model: { name: 'M', quant: null }, users: 15, tps: 30, ttft: 1, max: 40, kw: null, ok: true, hasEstimate: false, hasUser: false, warnings: [] };

const run = (s: CalcState, ...as: Action[]) => as.reduce((x, a) => reduce(b, x, a), s);

describe('reduce', () => {
  it('each select changes only its own field (spec §8.3.3 demo 缺陷)', () => {
    const s1 = reduce(b, s0, { type: 'speed', id: 'ok' });
    expect({ ...s1, speed: s0.speed }).toEqual(s0);
    const s2 = reduce(b, s1, { type: 'workload', id: 'chat' });
    expect(s2.speed).toBe('ok');
    expect(s2.model).toBe(s0.model);
    expect(s2.quant).toBe(s0.quant);
  });
  it('users: rejects null, 0, decimals, > 1e7; keeps the last valid value', () => {
    for (const v of [null, 0, 2.5, -3, 1e7 + 1, Number.NaN]) {
      expect(reduce(b, s0, { type: 'users', value: v }).users).toBe(s0.users);
    }
    expect(reduce(b, s0, { type: 'users', value: 200 }).users).toBe(200);
  });
  it('model change keeps quant when the new model offers it, else takes its first option', () => {
    const native = reduce(b, s0, { type: 'model', id: 'gpt-oss-120b' });
    expect(native.quant).toBe(quantOptions(b, 'gpt-oss-120b')[0]);
    const kept = reduce(b, s0, { type: 'model', id: 'llama-3.3-70b-instruct-fp8' });
    expect(kept.quant).toBe(s0.quant);
  });
  it('unknown ids and invalid custom values are ignored', () => {
    expect(reduce(b, s0, { type: 'model', id: 'no-such' })).toEqual(s0);
    expect(reduce(b, s0, { type: 'quant', id: 'no-such' })).toEqual(s0);
    expect(reduce(b, s0, { type: 'workloadCustom', value: { base: 'no-such', inputTokens: 1, outputTokens: 1, cacheHitRate: 0 } })).toEqual(s0);
    expect(reduce(b, s0, { type: 'workloadCustom', value: { base: 'chat', inputTokens: 1, outputTokens: 0, cacheHitRate: 0 } })).toEqual(s0);
    expect(reduce(b, s0, { type: 'speedCustom', value: { minTokPerSec: 0, maxTtftSec: 1 } })).toEqual(s0);
    expect(reduce(b, s0, { type: 'customModel', value: { kind: 'manual', value: { ...manual, layers: 0 } } })).toEqual(s0);
    expect(reduce(b, s0, { type: 'addPlatform', value: { ...gpu('x'), name: '' } })).toEqual(s0);
  });
  it('lang, openRow and dialog set their own field', () => {
    expect(reduce(b, s0, { type: 'lang', lang: 'en' }).lang).toBe('en');
    expect(reduce(b, s0, { type: 'openRow', row: 'nano4-h200' }).openRow).toBe('nano4-h200');
    const d = reduce(b, s0, { type: 'dialog', id: 'basis', basisFilter: 'all' });
    expect([d.dialog, d.basisFilter]).toEqual(['basis', 'all']);
    expect(reduce(b, d, { type: 'dialog', id: null }).dialog).toBeNull();
  });
  it('a custom model sets model to custom; a catalog model clears it', () => {
    const c = reduce(b, s0, { type: 'customModel', value: { kind: 'manual', value: manual } });
    expect(c.model).toBe('custom');
    expect(c.customModel).toEqual({ kind: 'manual', value: manual });
    const back = reduce(b, c, { type: 'model', id: 'gpt-oss-120b' });
    expect([back.model, back.customModel]).toEqual(['gpt-oss-120b', null]);
  });
  it('inputs clear overrides', () => {
    // A model with several quantizations, so a quant change is possible.
    const multi = Object.keys(b.models).find((id) => quantOptions(b, id).length > 1)!;
    const sm = reduce(b, s0, { type: 'model', id: multi });
    const o = reduce(b, sm, { type: 'override', row: 'nano4-h200', value: { gpus: 8 } });
    expect(o.overrides).toEqual({ 'nano4-h200': { gpus: 8 } });
    const inputs: Action[] = [
      { type: 'users', value: 99 },
      { type: 'workload', id: 'chat' },
      { type: 'workloadCustom', value: { base: 'chat', inputTokens: 1000, outputTokens: 200, cacheHitRate: 0.5 } },
      { type: 'model', id: 'gpt-oss-120b' },
      { type: 'customModel', value: { kind: 'manual', value: manual } },
      { type: 'quant', id: quantOptions(b, multi).find((q) => q !== sm.quant)! },
      { type: 'speed', id: 'ok' },
      { type: 'speedCustom', value: { minTokPerSec: 12, maxTtftSec: 3 } },
    ];
    for (const a of inputs) {
      const next = reduce(b, o, a);
      expect(next, a.type).not.toBe(o);
      expect(next.overrides, a.type).toEqual({});
    }
  });
  it('override bounds', () => {
    for (const value of [{ gpus: 0 }, { gpus: 1.5 }, { gpus: 100001 }, { gpus: 8, tp: 3 }]) {
      expect(reduce(b, s0, { type: 'override', row: 'nano4-h200', value })).toEqual(s0);
    }
    expect(reduce(b, s0, { type: 'override', row: 'no-such', value: { gpus: 8 } })).toEqual(s0);
    expect(reduce(b, s0, { type: 'override', row: 'custom:0', value: { gpus: 8 } })).toEqual(s0);
    for (const row of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(reduce(b, s0, { type: 'override', row, value: { gpus: 8 } }), row).toEqual(s0);
    }
    const one = reduce(b, s0, { type: 'addPlatform', value: gpu('A') });
    expect(reduce(b, one, { type: 'override', row: 'custom:00', value: { gpus: 8 } })).toEqual(one);
    expect(reduce(b, s0, { type: 'override', row: 'constructor', value: null })).toEqual(s0);
    for (const base of ['constructor', 'toString', '__proto__']) {
      expect(reduce(b, s0, { type: 'workloadCustom', value: { base, inputTokens: 1, outputTokens: 1, cacheHitRate: 0 } }), base).toEqual(s0);
    }
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(reduce(b, s0, { type: 'workload', id })).toEqual(s0);
      expect(reduce(b, s0, { type: 'speed', id })).toEqual(s0);
      expect(reduce(b, s0, { type: 'model', id })).toEqual(s0);
      expect(reduce(b, s0, { type: 'quant', id })).toEqual(s0);
    }
    const ok = reduce(b, s0, { type: 'override', row: 'nano4-h200', value: { gpus: 8, tp: 2 } });
    expect(ok.overrides).toEqual({ 'nano4-h200': { gpus: 8, tp: 2 } });
    expect(reduce(b, ok, { type: 'override', row: 'nano4-h200', value: null }).overrides).toEqual({});
  });
  it('removing a custom platform reindexes overrides', () => {
    const s = run(
      s0,
      { type: 'addPlatform', value: gpu('A') },
      { type: 'addPlatform', value: gpu('B') },
      { type: 'addPlatform', value: gpu('C') },
      { type: 'override', row: 'custom:0', value: { gpus: 2 } },
      { type: 'override', row: 'custom:2', value: { gpus: 16, tp: 8 } },
      { type: 'openRow', row: 'custom:1' },
    );
    expect(Object.keys(s.overrides).sort()).toEqual(['custom:0', 'custom:2']);
    const r = reduce(b, s, { type: 'removePlatform', index: 1 });
    expect(r.customPlatforms.map((p) => p.name)).toEqual(['A', 'C']);
    expect(r.overrides).toEqual({ 'custom:0': { gpus: 2 }, 'custom:1': { gpus: 16, tp: 8 } });
    expect(r.openRow).toBeNull();
  });
  it('restorePlatform puts a removed platform back at its index with its override and open state (v8 minor 5)', () => {
    const s = run(
      s0,
      { type: 'addPlatform', value: gpu('A') },
      { type: 'addPlatform', value: gpu('B') },
      { type: 'addPlatform', value: gpu('C') },
      { type: 'override', row: 'custom:1', value: { gpus: 4, tp: 2 } },
      { type: 'override', row: 'custom:2', value: { gpus: 16, tp: 8 } },
      { type: 'openRow', row: 'custom:1' },
    );
    const removed = reduce(b, s, { type: 'removePlatform', index: 1 });
    const back = reduce(b, removed, { type: 'restorePlatform', index: 1, value: gpu('B'), override: { gpus: 4, tp: 2 }, wasOpen: true });
    expect(back.customPlatforms.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect(back.overrides).toEqual(s.overrides);
    expect(back.openRow).toBe('custom:1');
    // Without override / open state: only the platform returns; another open row stays open (shifted).
    const opened = reduce(b, removed, { type: 'openRow', row: 'custom:1' });
    const plain = reduce(b, opened, { type: 'restorePlatform', index: 0, value: gpu('Z') });
    expect(plain.customPlatforms.map((p) => p.name)).toEqual(['Z', 'A', 'C']);
    expect(plain.overrides).toEqual({ 'custom:2': { gpus: 16, tp: 8 } });
    expect(plain.openRow).toBe('custom:2');
    // Invalid index, a full list or an invalid platform are ignored.
    expect(reduce(b, removed, { type: 'restorePlatform', index: 5, value: gpu('Q') })).toEqual(removed);
    const full = run(s0, ...Array.from({ length: CUSTOM_PLATFORMS_MAX }, (_, i): Action => ({ type: 'addPlatform', value: gpu(`P${i}`) })));
    expect(reduce(b, full, { type: 'restorePlatform', index: 0, value: gpu('Q') })).toEqual(full);
    expect(reduce(b, removed, { type: 'restorePlatform', index: 0, value: { ...gpu('Q'), memGB: -1 } })).toEqual(removed);
  });
  it('editPlatform replaces the entry', () => {
    const s = run(s0, { type: 'addPlatform', value: gpu('A') }, { type: 'editPlatform', index: 0, value: gpu('Z') });
    expect(s.customPlatforms.map((p) => p.name)).toEqual(['Z']);
    expect(reduce(b, s, { type: 'editPlatform', index: 3, value: gpu('Q') })).toEqual(s);
  });
  it('pins cap at three', () => {
    const s = run(s0, ...Array.from({ length: 4 }, (): Action => ({ type: 'pin', pin })));
    expect(s.pins).toHaveLength(3);
    expect(new Set(s.pins.map((p) => p.id)).size).toBe(3);
    expect(reduce(b, s, { type: 'unpin', id: s.pins[0]!.id }).pins).toHaveLength(2);
    expect(reduce(b, s, { type: 'clearPins' }).pins).toEqual([]);
  });
  it('addPlatform caps at eight', () => {
    const s = run(s0, ...Array.from({ length: 9 }, (_, i): Action => ({ type: 'addPlatform', value: gpu(`P${i}`) })));
    expect(s.customPlatforms).toHaveLength(CUSTOM_PLATFORMS_MAX);
    expect(CUSTOM_PLATFORMS_MAX).toBe(8);
  });
});

