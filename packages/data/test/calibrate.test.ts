import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Bundle } from '@nchc/schema';
import { loadConfig, type RawConfig } from '../src/load';
import { validateConfig } from '../src/validate';
import { CONFIG_DIR } from '../src/paths';
import { buildAccuracyReport, formatReport, runCalibration, TOLERANCE_PCT } from '../src/calibrate';

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * Fixture bundle: `good` plus a second point. Fixture numbers (fx-gpu, fx-model, fx-fp8, fx-cal):
 * - fx-point (decodeTokPerSec, measured 50): tp 1, 4 TB/s × etaBw 0.7 = 2.8e12 B/s; bandwidth-bound,
 *   bytes = 8e9 weights + KV(1000 + 100/2 = 1050 tokens) = 2·32·8·128·1·1050 = 68 812 800
 *   → predicted 2.8e12 / 8 068 812 800 ≈ 347.0 tok/s → far outside ±25%.
 * - fx-ttft (ttftSec, measured 0.02): 1000 × (2·8e9 + 4·32·32·128·500) / (2000e12 × etaCompute 0.5)
 *   = 0.016262144 s → errorPct −18.69% → inside ±25%.
 */
/** The good fixture's fx-point, as written in calibration.yaml. */
function b0Point(): Record<string, unknown> {
  const cal = loadConfig(fx('good')).docs.calibration!;
  return (cal.data as { points: Array<Record<string, unknown>> }).points[0]!;
}

function fixtureBundle(extraPoints: Array<Record<string, unknown>> = []): Bundle {
  const raw: RawConfig = loadConfig(fx('good'));
  const cal = raw.docs.calibration!;
  const data = structuredClone(cal.data) as { points: Array<Record<string, unknown>> };
  data.points.push(
    {
      ...data.points[0]!,
      id: 'fx-ttft',
      metric: 'ttftSec',
      measured: { value: 0.02, status: 'measured', source: 'fx-src', verified: '2026-10-19' },
    },
    ...extraPoints,
  );
  const r = validateConfig({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } });
  if (!r.bundle) throw new Error(JSON.stringify(r.issues));
  return r.bundle;
}

describe('runCalibration', () => {
  const results = runCalibration(fixtureBundle());
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  it('point outside tolerance: errorPct = (predicted − measured)/measured × 100', () => {
    const p = byId['fx-point']!;
    const predicted = 2.8e12 / (8e9 + 2 * 32 * 8 * 128 * 1050);
    expect(p.role).toBe('validate');
    expect(p.metric).toBe('decodeTokPerSec');
    expect(p.measured).toBe(50);
    expect(p.predicted).toBeCloseTo(predicted, 6);
    expect(p.errorPct).toBeCloseTo(((predicted - 50) / 50) * 100, 6);
    expect(p.errorPct).toBeGreaterThan(590);
    expect(p.withinTolerance).toBe(false);
  });

  it('point inside tolerance', () => {
    const p = byId['fx-ttft']!;
    expect(p.metric).toBe('ttftSec');
    expect(p.predicted).toBeCloseTo(0.016262144, 9);
    expect(p.errorPct).toBeCloseTo(-18.68928, 4);
    expect(p.withinTolerance).toBe(true);
  });

  it('carries the solver reason and trust flags (why null when the shape serves the point)', () => {
    expect(byId['fx-point']).toMatchObject({ why: null, hasEstimate: true, hasUser: false, shape: { tp: 1, replicas: 1 } });
  });

  it('flags a point the solver would reject (KV for the concurrency does not fit → why mem)', () => {
    const b = fixtureBundle([
      {
        id: 'fx-mem', role: 'validate', platform: 'fx-node', model: 'fx-model', quant: 'fx-fp8',
        workload: { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 }, tp: 1, concurrency: 5000,
        metric: 'decodeTokPerSec', engine: 'fixture',
        measured: { value: 1, status: 'measured', source: 'fx-src', verified: '2026-10-19' },
      },
    ]);
    const res = runCalibration(b);
    expect(res.find((x) => x.id === 'fx-mem')!.why).toBe('mem');
    expect(formatReport(buildAccuracyReport(b, res))).toMatch(/fx-mem .*solver rejects: mem/);
  });

  it("a point is predicted at its own tp (Ruling R41): fx-model's 8 GB fits on one GPU, the point ran tp 2", () => {
    const b = fixtureBundle([{ ...structuredClone(b0Point()), id: 'fx-tp2', tp: 2 }]);
    const res = runCalibration(b);
    const two = res.find((x) => x.id === 'fx-tp2')!;
    expect(two.tp).toBe(2);
    expect(two.shape).toEqual({ tp: 2, replicas: 1 });
    expect(two.step!.commSec).toBeGreaterThan(0);
    expect(two.predicted).not.toBeCloseTo(res.find((x) => x.id === 'fx-point')!.predicted, 3);
  });

  it('tolerances follow spec §10.1', () => {
    expect(TOLERANCE_PCT).toEqual({ decodeTokPerSec: 25, ttftSec: 25, maxConcurrent: 10 });
  });

  it('maxConcurrent is the memory-limited count of one replica, with ±10% tolerance', () => {
    const r = runCalibration(
      fixtureBundle([
        {
          id: 'fx-cap', role: 'validate', platform: 'fx-node', model: 'fx-model', quant: 'fx-fp8',
          workload: { inputTokens: 1000, outputTokens: 100, cacheHitRate: 0 }, tp: 1, concurrency: 1,
          metric: 'maxConcurrent', engine: 'fixture',
          measured: { value: 1200, status: 'measured', source: 'fx-src', verified: '2026-10-19' },
        },
      ]),
    ).find((x) => x.id === 'fx-cap')!;
    // vLLM KV blocks of 16 tokens (fixture kvBlockSize): 1100 tokens → 69 blocks = 1104 (spec §5.1).
    // floor((100e9 × 0.9 − 8e9) / (2·32·8·128·1·1104)) = floor(82e9 / 72 351 744) = 1133
    expect(r.predicted).toBe(1133);
    expect(r.errorPct).toBeCloseTo(((1133 - 1200) / 1200) * 100, 6);
    expect(r.withinTolerance).toBe(true);
  });
});

describe('accuracy report', () => {
  const bundle = fixtureBundle();
  const report = buildAccuracyReport(bundle, runCalibration(bundle));

  it('lists points; only out-of-tolerance validate points are warnings', () => {
    expect(report.points.map((p) => p.id)).toEqual(['fx-point', 'fx-ttft']);
    expect(report.gaps).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.warnings).toEqual(['fx-point']);
  });

  it('formatReport prints measured / predicted / errorPct and a WARN line for out-of-tolerance validate points', () => {
    const text = formatReport(report);
    expect(text).toMatch(/fx-point.*measured 50.*predicted 347\.0.*errorPct \+594\.0%/);
    expect(text).toMatch(/WARN fx-point/);
    expect(text).not.toMatch(/WARN fx-ttft/);
  });

  it('the decode bound tag is shown only for decode points, not TTFT (finding 10)', () => {
    const lines = formatReport(report).split('\n');
    expect(lines.find((l) => l.includes('fx-point ('))).toMatch(/\[tp 1, (bw|compute)-bound\]/);
    const ttft = lines.find((l) => l.includes('fx-ttft ('))!;
    expect(ttft).toMatch(/\[tp 1\]/);
    expect(ttft).not.toMatch(/-bound/);
  });
});

describe('real config', () => {
  const { bundle } = validateConfig(loadConfig(CONFIG_DIR));
  const report = buildAccuracyReport(bundle!, runCalibration(bundle!));

  it('only points with stated conditions are evaluated; the rest are skipped with reasons', () => {
    const ids = report.points.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith('apple-')).sort()).toEqual([
      'apple-m5u-mistral128b-fp8-8k',
      'apple-m5u-mistral128b-fp8-8k-ttft',
    ]);
    // InferenceX H100 / H200 (Ruling R41): 20 runs × decode and TTFT; the fit set is the two H200 TP=1 1k/1k c=4 runs.
    const ix = report.points.filter((p) => p.id.startsWith('ix-'));
    expect(ix).toHaveLength(40);
    expect(ix.filter((p) => p.role === 'fit').map((p) => p.id).sort()).toEqual([
      'ix-h200-gptoss-mxfp4-tp1-1k1k-c4', 'ix-h200-gptoss-mxfp4-tp1-1k1k-c4-ttft',
      'ix-h200-llama70b-fp8-tp1-1k1k-c4', 'ix-h200-llama70b-fp8-tp1-1k1k-c4-ttft',
    ]);
    // Each is predicted at the tp it ran.
    for (const p of ix) expect(p.shape?.tp).toBe(p.tp);
    expect(report.skipped.map((s) => s.id).sort()).toEqual([
      'ix-h200-gptoss-mxfp4-tp1-8k1k-c16-ttft',
      'storagereview-spark-llama8b-bf16-c1',
      'storagereview-spark-llama8b-fp8-c1',
      'storagereview-spark-mistralsmall31-fp8-c1',
    ]);
    for (const s of report.skipped) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.measured.status).toBe('measured');
    }
    for (const p of report.points) expect(Number.isFinite(p.predicted)).toBe(true);
  });

  it('lists the NVIDIA gaps: GB200 only, since InferenceX covers H100 / H200 (Ruling R41)', () => {
    expect(report.gaps).toEqual(['nvidia-gb200']);
    expect(report.gapNote.length).toBeGreaterThan(0);
    expect(report.gapDetails.flatMap((g) => g.platforms).sort()).toEqual(['nano4-gb200']);
    // Both H100 and H200 have evaluated points.
    expect(new Set(report.points.filter((p) => p.id.startsWith('ix-')).map((p) => p.platform))).toEqual(new Set(['nano5-h100', 'nano5-h200']));
  });
});
