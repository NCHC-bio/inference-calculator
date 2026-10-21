import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import {
  CUSTOM_MODEL_WARNING, CoreInputError, estimateRequirements, quantOptions, quantOptionsFor, type RequirementInput,
} from '../src/api';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
const bundle = realBundle();

const catalog = bundle.models['gpt-oss-20b']!;
const source = () => structuredClone(bundle.sources[catalog.source]!);
const imported = (mut?: (m: Record<string, unknown>) => void, src = source()) => {
  const model = structuredClone(catalog) as unknown as Record<string, unknown>;
  mut?.(model);
  return { imported: { model: model as never, source: src } };
};
const query = (model: RequirementInput['model']): RequirementInput => ({
  model, quant: quantOptions(bundle, 'gpt-oss-20b')[0]!, workload: 'assist', speed: 'smooth', users: 15,
});
function expectInvalid(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CoreInputError);
    expect((e as CoreInputError).code).toBe('invalid-input');
    return;
  }
  throw new Error('expected CoreInputError');
}

describe('imported model', () => {
  it('a catalog model passed as imported gives the same numbers', () => {
    const a = estimateRequirements(bundle, query('gpt-oss-20b'));
    const b = estimateRequirements(bundle, query(imported()));
    expect(b.perPlatform.map((p) => p.expected)).toEqual(a.perPlatform.map((p) => p.expected));
    expect(b.warnings).toContainEqual(CUSTOM_MODEL_WARNING);
    expect(a.warnings).toEqual([]);
  });

  it('source id must match the fields', () => {
    expectInvalid(() => estimateRequirements(bundle, query(imported(undefined, { ...source(), id: 'hf:other/x@abc' }))));
  });

  it('a derived input outside the source and the bundle is rejected', () => {
    expectInvalid(() => estimateRequirements(bundle, query(imported((m) => {
      m.totalParamsB = { value: 20, status: 'derived', formula: 'x', inputs: ['nope'], verified: '2026-10-20' };
    }))));
  });

  it('model checks run', () => {
    expectInvalid(() => estimateRequirements(bundle, query(imported((m) => { m.layers = 25; }))));
  });

  it('quantOptionsFor equals quantOptions for catalog models', () => {
    for (const m of Object.values(bundle.models)) expect(quantOptionsFor(bundle, m)).toEqual(quantOptions(bundle, m.id));
  });
});
