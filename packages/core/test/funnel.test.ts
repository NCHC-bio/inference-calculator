import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { CoreInputError } from '../src/api';
import { peakConcurrentFromTotal } from '../src/funnel';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
const bundle = realBundle();

describe('peakConcurrentFromTotal (spec 2026-10-21 §5.5)', () => {
  it('chat: arrival × service time', () => {
    const f = bundle.funnel;
    const wl = bundle.workloads['chat']!;
    const sp = bundle.speedPresets['smooth']!;
    const total = 20000;
    const arrival = (total * f.dailyActiveShare.value * f.requestsPerActivePerDay.value * f.peakHourShare.value) / 3600;
    const service = sp.maxTtftSec.value + wl.outputTokens.value / sp.minTokensPerSec.value;
    const r = peakConcurrentFromTotal(bundle, { total, workload: 'chat', speed: 'smooth' });
    expect(r.arrivalPerSec).toBeCloseTo(arrival, 10);
    expect(r.serviceSec).toBeCloseTo(service, 10);
    expect(r.users).toBe(Math.max(1, Math.ceil(arrival * service)));
    expect(r.hasUser).toBe(false);
    expect(r.hasEstimate).toBe(true);
    const paths = r.basis.map((b) => b.path);
    expect(paths).toEqual(expect.arrayContaining([
      'funnel.dailyActiveShare', 'funnel.requestsPerActivePerDay', 'funnel.peakHourShare',
    ]));
    expect(r.basis.find((b) => b.path === 'funnel.serviceSec')?.text).toContain('maxTtftSec');
  });

  it('overrides are user values', () => {
    const r = peakConcurrentFromTotal(bundle, { total: 20000, dailyActiveShare: 0.1, workload: 'chat', speed: 'smooth' });
    const item = r.basis.find((b) => b.path === 'funnel.dailyActiveShare')!;
    expect(item.status).toBe('user');
    expect(item.value).toBe(0.1);
    expect(r.hasUser).toBe(true);
    const base = peakConcurrentFromTotal(bundle, { total: 20000, workload: 'chat', speed: 'smooth' });
    expect(r.arrivalPerSec).toBeGreaterThan(base.arrivalPerSec);
  });

  it('custom speed and workload overrides feed the service time', () => {
    const r = peakConcurrentFromTotal(bundle, {
      total: 1000, workload: { base: 'chat', outputTokens: 200 }, speed: { minTokPerSec: 10, maxTtftSec: 2 },
    });
    expect(r.serviceSec).toBeCloseTo(2 + 200 / 10, 10);
    expect(r.hasUser).toBe(true);
  });

  it('users is at least 1', () => {
    expect(peakConcurrentFromTotal(bundle, { total: 1, workload: 'chat', speed: 'smooth' }).users).toBe(1);
  });

  it('total must be an integer', () => {
    expect(() => peakConcurrentFromTotal(bundle, { total: 1.5, workload: 'chat', speed: 'smooth' })).toThrow(CoreInputError);
  });

  it('an exactly-integer product is not rounded up by float error', () => {
    // 4500 × 0.07 × 50 × 0.8 ÷ 3600 × (1 + 129 ÷ 129) = 7 exactly; the float product is 7.000000000000002.
    const r = peakConcurrentFromTotal(bundle, {
      total: 4500, dailyActiveShare: 0.07, requestsPerActivePerDay: 50, peakHourShare: 0.8,
      workload: 'chat', speed: { minTokPerSec: 129, maxTtftSec: 1 },
    });
    expect(r.users).toBe(7);
  });

  it('agent workloads are refused', () => {
    try {
      peakConcurrentFromTotal(bundle, { total: 100, workload: 'assist', speed: 'smooth' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CoreInputError);
      expect((e as CoreInputError).code).toBe('invalid-input');
      expect((e as CoreInputError).message).toContain('直接填尖峰同時在線人數');
    }
  });

  it('bounds', () => {
    const bad = (x: object) => {
      try {
        peakConcurrentFromTotal(bundle, { total: 100, workload: 'chat', speed: 'smooth', ...x } as never);
        return undefined;
      } catch (e) {
        return e;
      }
    };
    for (const x of [{ total: 0 }, { total: 2e9 }, { dailyActiveShare: 1.5 }, { requestsPerActivePerDay: 0 }, { peakHourShare: -0.1 }]) {
      const e = bad(x);
      expect(e, JSON.stringify(x)).toBeInstanceOf(CoreInputError);
      expect((e as CoreInputError).code).toBe('invalid-input');
    }
  });
});
