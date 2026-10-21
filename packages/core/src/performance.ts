/**
 * Performance of a chosen deployment (spec 2026-10-21-direct-manipulation-design §5.1): given a platform, a GPU count
 * (machines for Mac) and a user count, what each user gets. The forward answer (estimateRequirements) says how many GPUs
 * serve the users; this one answers "I have / I picked N GPUs: how fast is it, and where does it break". It adds no
 * formula: every number comes from solve.ts (checkShape, shapeUsage, shapeProfile, maxConcurrent), so at the suggested
 * count it equals estimateRequirements' expected result.
 */
import { z } from 'zod';
import type { Bundle } from '@nchc/schema';
import {
  RequirementInputSchema,
  addCommBasis,
  addQueueingBasis,
  ctxForPlatform,
  prepare,
  quantFields,
  resolvePlatform,
  verifyFor,
  withWarnings,
  type QuantFields,
  type ResultWarning,
} from './api';
import { BasisCollector, trustFlags, type BasisItem } from './basis';
import { CoreInputError, parseInput } from './errors';
import {
  MAX_GPUS,
  capacityWhy,
  checkShape,
  legalTpOptions,
  maxConcurrent,
  progress,
  shapeProfile,
  shapeUsage,
  type Shape,
  type ShapeUsage,
  type Queueing,
  type Why,
} from './solve';
import type { SpeedCurve } from './api';

/** Points of the speed curve this view draws (up to the larger of the capacity and the current users). */
export const PERFORMANCE_CURVE_POINTS = 24;

/** Bounded positive integer, as api.ts's `int`. */
const int = (max: number) => z.number().int().positive().max(max);
const TpOptionSchema = int(1e4);

/** Task 3 widens `platform` to also take a custom platform. */
export const PerformanceInputSchema = RequirementInputSchema.extend({
  platform: z.string().min(1),
  gpus: int(MAX_GPUS),
  /** Force this tensor-parallel size (must be legal and fit in `gpus`); omitted → the best split. */
  tp: TpOptionSchema.optional(),
});
export type PerformanceInput = z.input<typeof PerformanceInputSchema>;

/** One legal TP split of the GPUs given, evaluated at the current users. */
export type SplitEval = {
  shape: Shape;
  ok: boolean;
  why: Why | null;
  tokPerSecPerUser: number;
  ttftSec: number;
  maxConcurrent: number;
};

export type PerformanceResult = QuantFields & {
  dataVersion: string;
  platform: string;
  gpus: number;
  users: number;
  ok: boolean;
  /** Why the chosen split misses the target ('tp' | 'context' | 'weights' | 'mem' | 'bw' | 'compute' | 'ttft'); null when ok. */
  why: Why | null;
  detail?: string;
  /** The split evaluated (replicas = floor(gpus / tp)); null when no legal TP fits in `gpus`. */
  shape: Shape | null;
  /** The best split without a `tp` override (the one `tp` would replace). */
  recommendedTp: number | null;
  /** Every legal TP that fits in `gpus`, ascending. */
  splits: SplitEval[];
  /** One replica of `shape` at `users` (shapeUsage); null when the weights or the context do not fit or one user does not. */
  usage: ShapeUsage | null;
  /** Most users `shape` serves (expected eta); 0 when not even one. */
  maxConcurrent: number;
  /** Speed against users up to max(maxConcurrent, users); null when `usage` is. */
  speedCurve: SpeedCurve | null;
  queueing: Queueing | null;
  powerKw: number | null;
  powerNote?: string;
  verifyCommand: string;
  verifyNote?: string;
  basis: BasisItem[];
  hasEstimate: boolean;
  hasUser: boolean;
  warnings: ResultWarning[];
};

export function estimatePerformance(bundle: Bundle, raw: PerformanceInput): PerformanceResult {
  const input = parseInput(PerformanceInputSchema, raw);
  const { ctx: baseCtx, quant, res: qres, basis, warnings } = prepare(bundle, input);
  // Platform resolution is this one step (a custom platform replaces it later).
  const resolved = resolvePlatform(bundle, input.platform, quant.computeDtype);
  const { platform } = resolved;
  basis.add(...resolved.basis);
  const ctx = ctxForPlatform(baseCtx, quant, resolved, basis);
  const { gpus, users } = input;
  const unit = platform.unit === 'machine' ? '台' : '張 GPU';

  const legal = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model);
  const fitting = legal.filter((t) => t <= gpus);
  if (input.tp !== undefined && !fitting.includes(input.tp)) {
    throw new CoreInputError(
      'invalid-input',
      `輸入不合法：TP ${input.tp} 不能用在 ${gpus} ${unit}（這個模型在 ${input.platform} 的合法 TP：${legal.join('、')}；且不能超過 GPU 數）`,
    );
  }

  const evals = fitting.map((t) => {
    const shape: Shape = { tp: t, replicas: Math.floor(gpus / t) };
    const c = checkShape(ctx, platform, shape, users, 'expected');
    const mc = maxConcurrent(ctx, platform, shape, 'expected');
    const one = checkShape(ctx, platform, { tp: t, replicas: 1 }, 1, 'expected');
    const split: SplitEval = { shape, ok: c.ok, why: c.why, tokPerSecPerUser: c.tokPerSecPerUser, ttftSec: c.ttftSec, maxConcurrent: mc };
    return { split, reach: progress(one, ctx.speed.maxTtftSec, ctx.speed.minTokPerSec) };
  });
  // Best split: most users served, then the smaller t; when nobody is served, the one that gets furthest for one user
  // (singleUserWhy's order), then the faster, then the smaller t.
  const anyServed = evals.some((e) => e.split.maxConcurrent > 0);
  const ranked = [...evals].sort((a, b) =>
    anyServed
      ? b.split.maxConcurrent - a.split.maxConcurrent || a.split.shape.tp - b.split.shape.tp
      : b.reach - a.reach || b.split.tokPerSecPerUser - a.split.tokPerSecPerUser || a.split.shape.tp - b.split.shape.tp,
  );
  const recommendedTp = ranked[0]?.split.shape.tp ?? null;
  const chosenTp = input.tp ?? recommendedTp;
  const chosen = evals.find((e) => e.split.shape.tp === chosenTp)?.split ?? null;
  const shape = chosen?.shape ?? null;

  const check = shape ? checkShape(ctx, platform, shape, users, 'expected') : null;
  let why: { why: Why; detail: string } | null = null;
  if (!shape || !check) {
    why = capacityWhy(ctx, platform, gpus, 'expected') ?? { why: 'mem', detail: `${gpus} ${unit}放不下 1 人` };
  } else if (check.why !== null) {
    why =
      check.why === 'context' || check.why === 'weights'
        ? (capacityWhy(ctx, platform, gpus, 'expected') ?? { why: check.why, detail: '' })
        : { why: check.why, detail: failDetail(check, ctx.speed, users, shape) };
  }

  const oneUserFits = shape ? checkShape(ctx, platform, shape, 1, 'expected').capacityPerReplica >= 1 : false;
  const hasUsage = shape !== null && check !== null && check.why !== 'context' && check.why !== 'weights' && oneUserFits;
  const usage = hasUsage ? shapeUsage(ctx, platform, shape, users, 'expected') : null;
  const mc = chosen?.maxConcurrent ?? 0;
  const speedCurve = hasUsage
    ? shapeProfile(ctx, platform, shape, Math.max(mc, users), 'expected', PERFORMANCE_CURVE_POINTS).speedCurve
    : null;
  const queueing = check?.queueing ?? null;

  addQueueingBasis(basis, bundle, resolved, shape !== null);
  addCommBasis(basis, ctx, resolved.commBasis, [shape]);

  let powerKw: number | null = null;
  let powerNote: string | undefined;
  if (why) powerNote = '沒有可行配置，未計算功耗';
  else {
    basis.add(resolved.tdpBasis);
    if (platform.tdpW === null) powerNote = '功耗未查證';
    else powerKw = (gpus * platform.tdpW) / 1000;
  }

  const v = withWarnings(
    verifyFor(
      bundle,
      ctx,
      quant,
      qres,
      resolved,
      basis,
      why ? { ok: false, ...why } : { ok: true, shape: shape!, queueing },
      users,
      { maxTp: gpus, where: `${gpus} ${unit}` },
    ),
    warnings,
  );

  const list = basis.list();
  return {
    ...quantFields(ctx.model, qres),
    dataVersion: bundle.meta.dataVersion,
    platform: input.platform,
    gpus,
    users,
    ok: why === null,
    why: why?.why ?? null,
    ...(why ? { detail: why.detail } : {}),
    shape,
    recommendedTp,
    splits: evals.map((e) => e.split),
    usage,
    maxConcurrent: mc,
    speedCurve,
    queueing,
    powerKw,
    ...(powerNote !== undefined ? { powerNote } : {}),
    verifyCommand: v.verifyCommand,
    ...(v.verifyNote !== undefined ? { verifyNote: v.verifyNote } : {}),
    basis: list,
    ...trustFlags(list),
    warnings,
  };
}

/** One-line reason with the numbers for a split that misses the target at `users` (mem | bw | compute | ttft). */
function failDetail(
  c: ReturnType<typeof checkShape>,
  speed: { minTokPerSec: number; maxTtftSec: number },
  users: number,
  shape: Shape,
): string {
  const where = `TP ${shape.tp} × ${shape.replicas} 個副本`;
  if (c.why === 'mem') return `${where}記憶體最多放得下 ${c.capacityPerReplica * shape.replicas} 人的上下文，${users} 人超過了`;
  if (c.why === 'ttft') return `${where}在 ${users} 人時首字約 ${c.ttftSec.toFixed(1)} 秒，超過要求的 ${speed.maxTtftSec} 秒`;
  return `${where}在 ${users} 人時每人每秒約 ${c.tokPerSecPerUser.toFixed(1)} token，低於要求的 ${speed.minTokPerSec}`;
}
