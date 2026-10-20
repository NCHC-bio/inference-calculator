/**
 * Calibration report (spec §10.1): compare the calculator's predictions with published
 * measurements (`config/calibration.yaml` points) and write
 * `packages/data/dist/accuracy.json`.
 *
 * - Each point is predicted at its own tp and concurrency (closed loop, B = concurrency, with the R36 queueing).
 * - errorPct = (predicted − measured) / measured × 100.
 * - Tolerance: decodeTokPerSec and ttftSec ±25%, maxConcurrent ±10%.
 * - `validate` points outside tolerance print `WARN` (exit code stays 0); `fit` points are
 *   reported only — they were used to set η, so they are not independent checks.
 *
 * CLI: `pnpm calibrate`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predictMeasurement } from '@nchc/core';
import type { Bundle, CalibrationPoint, SkippedCalibrationPoint } from '@nchc/schema';
import { loadConfig } from './load';
import { validateConfig } from './validate';
import { CONFIG_DIR } from './paths';

export const ACCURACY_PATH = fileURLToPath(new URL('../dist/accuracy.json', import.meta.url));

/** Allowed |errorPct| per metric (spec §10.1). */
export const TOLERANCE_PCT: Record<CalibrationPoint['metric'], number> = {
  decodeTokPerSec: 25,
  ttftSec: 25,
  maxConcurrent: 10,
};

export type CalibrationResult = {
  id: string;
  role: CalibrationPoint['role'];
  metric: CalibrationPoint['metric'];
  platform: string;
  model: string;
  quant: string;
  engine: string;
  workload: CalibrationPoint['workload'];
  /** The tp the benchmark ran and the prediction used (Ruling R41). */
  tp: number;
  concurrency: number;
  measured: number;
  source: string | undefined;
  /** NaN when the calculator finds no single-node shape (weights do not fit). */
  predicted: number;
  errorPct: number;
  tolerancePct: number;
  withinTolerance: boolean;
  /** Prediction details: TP used, bandwidth- or compute-bound decode step. */
  shape: { tp: number; replicas: number } | null;
  bound: 'bw' | 'compute' | null;
  /** Solver reason with speed targets off: 'tp' | 'context' | 'weights' | 'mem' | null. A non-null value flags a point the solver would reject. */
  why: string | null;
  /** The prediction used an estimate / user value (spec §2.1). */
  hasEstimate: boolean;
  hasUser: boolean;
  /** Decode-step breakdown (seconds) at batch = concurrency, computeSec includes the other
   *  concurrency − 1 users' prefill interference (Ruling R29; none at concurrency 1). */
  step: { bwSec: number; computeSec: number; commSec: number; stepSec: number } | null;
};

/** Predict every calibration point with the calculator (expected η) and compare. */
export function runCalibration(bundle: Bundle): CalibrationResult[] {
  return Object.values(bundle.calibrationPoints).map((pt) => {
    const p = predictMeasurement(bundle, {
      platform: pt.platform,
      model: pt.model,
      quant: pt.quant,
      workload: pt.workload,
      tp: pt.tp,
      concurrency: pt.concurrency,
    });
    const predicted = p[pt.metric] ?? Number.NaN;
    const measured = pt.measured.value;
    const errorPct = ((predicted - measured) / measured) * 100;
    const tolerancePct = TOLERANCE_PCT[pt.metric];
    return {
      id: pt.id,
      role: pt.role,
      metric: pt.metric,
      platform: pt.platform,
      model: pt.model,
      quant: pt.quant,
      engine: pt.engine,
      workload: pt.workload,
      tp: pt.tp,
      concurrency: pt.concurrency,
      measured,
      source: pt.measured.source,
      predicted,
      errorPct,
      tolerancePct,
      withinTolerance: Number.isFinite(errorPct) && Math.abs(errorPct) <= tolerancePct,
      shape: p.shape,
      bound: p.bound,
      why: p.why,
      hasEstimate: p.hasEstimate,
      hasUser: p.hasUser,
      step: p.step,
    };
  });
}

export type AccuracyReport = {
  dataVersion: string;
  tolerancePct: typeof TOLERANCE_PCT;
  points: CalibrationResult[];
  /** Ids of `validate` points outside tolerance (CI warnings, not failures). */
  warnings: string[];
  skipped: SkippedCalibrationPoint[];
  /** Platform families with no usable public measurement yet. */
  gaps: string[];
  gapNote: string;
  gapDetails: Array<{ id: string; platforms: string[]; note: string }>;
};

export function buildAccuracyReport(bundle: Bundle, points: CalibrationResult[]): AccuracyReport {
  const gapDetails = Object.values(bundle.calibrationGaps).map((g) => ({ ...g, platforms: [...g.platforms] }));
  return {
    dataVersion: bundle.meta.dataVersion,
    tolerancePct: TOLERANCE_PCT,
    points,
    warnings: points.filter((p) => p.role === 'validate' && !p.withinTolerance).map((p) => p.id),
    skipped: Object.values(bundle.skippedCalibrationPoints),
    gaps: gapDetails.map((g) => g.id),
    gapNote: gapDetails.map((g) => `${g.id}: ${g.note}`).join(' '),
    gapDetails,
  };
}

const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(1) : x.toPrecision(4)) : 'n/a');
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}%` : 'n/a');

/** Human-readable report (one line per point, then WARN / skipped / gaps). */
export function formatReport(r: AccuracyReport): string {
  const lines = [`calibration report (dataVersion ${r.dataVersion})`];
  for (const p of r.points) {
    const ok = p.withinTolerance ? 'ok' : 'OUT';
    const rejects = p.why ? `, solver rejects: ${p.why}` : '';
    // The bw/compute tag describes the decode step, so it is shown only for decode points (finding 10).
    const bound = p.metric === 'decodeTokPerSec' ? `, ${p.bound}-bound` : '';
    const how = p.shape ? ` [tp ${p.shape.tp}${bound}${rejects}]` : ` [no shape${rejects}]`;
    lines.push(
      `  ${p.id} (${p.role}, ${p.metric}): measured ${fmt(p.measured)} / predicted ${fmt(p.predicted)} / ` +
        `errorPct ${pct(p.errorPct)} (±${p.tolerancePct}% ${ok})${how}`,
    );
  }
  for (const id of r.warnings) {
    const p = r.points.find((x) => x.id === id)!;
    lines.push(`WARN ${id}: errorPct ${pct(p.errorPct)} outside ±${p.tolerancePct}% (validate point)`);
  }
  if (r.skipped.length > 0) {
    lines.push('skipped:');
    for (const s of r.skipped) {
      lines.push(`  ${s.id} (${s.platform}, ${s.modelRepo ?? `${s.modelName}（${s.modelOrigin?.developer}，${s.modelOrigin?.country}）`} ${s.quant}, ${s.metric} ${s.measured.value}): ${s.reason}`);
    }
  }
  lines.push(`gaps: ${r.gaps.join(', ') || '(none)'}`);
  for (const g of r.gapDetails) lines.push(`  ${g.id} (${g.platforms.join(', ')}): ${g.note}`);
  return lines.join('\n');
}

function main(): void {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) {
    for (const i of issues.filter((x) => x.level === 'error')) console.error(`error: config/${i.file} ${i.path}: ${i.message}`);
    console.error('calibrate: config is invalid (run pnpm data:build for details)');
    process.exit(1);
  }
  const report = buildAccuracyReport(bundle, runCalibration(bundle));
  console.log(formatReport(report));
  mkdirSync(dirname(ACCURACY_PATH), { recursive: true });
  // NaN is not JSON: write null for a missing prediction.
  writeFileSync(
    ACCURACY_PATH,
    `${JSON.stringify(report, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)}\n`,
  );
  console.log('wrote packages/data/dist/accuracy.json');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
