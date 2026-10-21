import raw from '../../data/dist/accuracy.json';

/** The part of `pnpm calibrate`'s report the site shows (packages/data/src/calibrate.ts `AccuracyReport`). */
export type PlatformAccuracy = {
  platform: string;
  metric: 'decodeTokPerSec' | 'ttftSec' | 'maxConcurrent';
  role: 'fit' | 'validate';
  n: number;
  meanAbsErrorPct: number;
  maxAbsErrorPct: number;
};
export type AccuracyReport = {
  dataVersion: string;
  tolerancePct: Record<PlatformAccuracy['metric'], number>;
  byPlatform: PlatformAccuracy[];
};

let cached: AccuracyReport | undefined;

/**
 * The only place accuracy.json is imported (design §6.4). Written by `pnpm calibrate`, which the typecheck, test and
 * web dev / build scripts run first.
 */
export function getAccuracy(): AccuracyReport {
  if (!cached) {
    const r = raw as unknown as AccuracyReport;
    cached = { dataVersion: r.dataVersion, tolerancePct: r.tolerancePct, byPlatform: r.byPlatform };
  }
  return cached;
}
