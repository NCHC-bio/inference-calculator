import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
// Relative import (not the @nchc/data package): see api.test.ts for why.
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { estimateRequirements } from '../src/api';
import { activeParamsB } from '../src/model-math';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
const bundle = realBundle();

/** Paths of every number that is not finite or is negative. */
function badNumbers(x: unknown, path = '$'): string[] {
  if (typeof x === 'number') return Number.isFinite(x) && x >= 0 ? [] : [`${path}=${x}`];
  if (x && typeof x === 'object') {
    return Object.entries(x).flatMap(([k, v]) => (typeof v === 'function' ? [] : badNumbers(v, `${path}.${k}`)));
  }
  return [];
}

/**
 * Catalog-wide sweep (Ruling R31e): every catalog model × quantization × workload × speed preset at
 * 1, 50 and 5000 users through estimateRequirements (which covers every platform). Every numeric
 * output must be finite and ≥ 0, and every model must have 0 < active ≤ total parameters.
 */
describe('catalog sweep (Ruling R31e)', () => {
  const models = Object.values(bundle.models);

  it('every catalog model has 0 < active ≤ total parameters', () => {
    for (const m of models) {
      const a = activeParamsB(m);
      expect(a, m.id).toBeGreaterThan(0);
      expect(a, m.id).toBeLessThanOrEqual(m.totalParamsB.value);
    }
  });

  for (const m of models) {
    it(`${m.id}: every quant × workload × speed × users gives finite, non-negative numbers`, () => {
      const bad: string[] = [];
      let runs = 0;
      for (const quant of Object.keys(bundle.quantization)) {
        for (const workload of Object.keys(bundle.workloads)) {
          for (const speed of Object.keys(bundle.speedPresets)) {
            for (const users of [1, 50, 5000]) {
              const r = estimateRequirements(bundle, { model: m.id, quant, workload, speed, users });
              expect(r.perPlatform).toHaveLength(Object.keys(bundle.platforms).length);
              bad.push(...badNumbers(r).map((p) => `${quant}/${workload}/${speed}/${users}: ${p}`));
              runs++;
            }
          }
        }
      }
      expect(runs).toBe(
        Object.keys(bundle.quantization).length * Object.keys(bundle.workloads).length *
          Object.keys(bundle.speedPresets).length * 3,
      );
      expect(bad).toEqual([]);
    });
  }
});
