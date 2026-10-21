/**
 * Performance of a chosen deployment (spec 2026-10-21-direct-manipulation-design §5.1): given a platform, a GPU count
 * (machines for Mac) and a user count, what each user gets. The forward answer (estimateRequirements) says how many GPUs
 * serve the users; this one answers "I have / I picked N GPUs: how fast is it, and where does it break". It adds no
 * formula: every number comes from solve.ts (checkShape, shapeUsage, shapeProfile, maxConcurrent), so at the suggested
 * count it equals estimateRequirements' expected result.
 */
import { z } from 'zod';
import type { Bundle, Quantization } from '@nchc/schema';
import {
  CustomPlatformInputSchema,
  UsersQueryInputSchema,
  addCommBasis,
  addQueueingBasis,
  ctxForPlatform,
  powerFor,
  prepare,
  quantFields,
  resolveCustomPlatform,
  resolvePlatform,
  verifyFor,
  type ResolvedApiPlatform,
  withWarnings,
  type QuantFields,
  type ResultWarning,
} from './api';
import { BasisCollector, trustFlags, type BasisItem } from './basis';
import { CoreInputError, parseInput } from './errors';
import {
  MAX_GPUS,
  capacityWhy,
  contextDetail,
  singleUserWhy,
  checkShape,
  legalTpOptions,
  maxConcurrent,
  progress,
  shapeProfile,
  shapeUsage,
  type Ctx,
  type ResolvedPlatform,
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

/** A catalog platform id or a user-entered platform (spec 2026-10-21 §5.3). */
const PlatformInSchema = z.union([z.string().min(1), CustomPlatformInputSchema]);

/** The one platform resolution of estimatePerformance and the sweep: catalog id or custom platform. */
function resolveIn(bundle: Bundle, platform: z.infer<typeof PlatformInSchema>, computeDtype: Quantization['computeDtype']): ResolvedApiPlatform {
  return typeof platform === 'string'
    ? resolvePlatform(bundle, platform, computeDtype)
    : resolveCustomPlatform(bundle, platform, computeDtype);
}

export const PerformanceInputSchema = UsersQueryInputSchema.extend({
  platform: PlatformInSchema,
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

/** A SplitEval plus how far one user gets (solve.ts `progress`), the tie-break when no split serves anyone. */
type EvaluatedSplit = SplitEval & { reach: number };

/** Evaluate each legal TP (already filtered to t <= gpus) at `users`: floor(gpus / t) replicas. */
function evaluateSplits(ctx: Ctx, platform: ResolvedPlatform, tps: number[], gpus: number, users: number): EvaluatedSplit[] {
  return tps.map((t) => {
    const shape: Shape = { tp: t, replicas: Math.floor(gpus / t) };
    const c = checkShape(ctx, platform, shape, users, 'expected');
    const one = checkShape(ctx, platform, { tp: t, replicas: 1 }, 1, 'expected');
    return {
      shape,
      ok: c.ok,
      why: c.why,
      tokPerSecPerUser: c.tokPerSecPerUser,
      ttftSec: c.ttftSec,
      maxConcurrent: maxConcurrent(ctx, platform, shape, 'expected'),
      reach: progress(one, ctx.speed.maxTtftSec, ctx.speed.minTokPerSec),
    };
  });
}

/**
 * Best split: most users served, then the smaller t; when nobody is served, the one that gets furthest for one user
 * (singleUserWhy's order), then the faster, then the smaller t. Null for an empty list.
 */
function pickSplit<T extends EvaluatedSplit>(splits: T[]): T | null {
  const anyServed = splits.some((e) => e.maxConcurrent > 0);
  const ranked = [...splits].sort((a, b) =>
    anyServed
      ? b.maxConcurrent - a.maxConcurrent || a.shape.tp - b.shape.tp
      : b.reach - a.reach || b.tokPerSecPerUser - a.tokPerSecPerUser || a.shape.tp - b.shape.tp,
  );
  return ranked[0] ?? null;
}

/** Verdict for a chosen shape (null: no legal TP fits): why it misses the target, and one replica's usage when meaningful. */
function judgeShape(ctx: Ctx, platform: ResolvedPlatform, shape: Shape | null, gpus: number, users: number, unit: string) {
  const check = shape ? checkShape(ctx, platform, shape, users, 'expected') : null;
  let why: { why: Why; detail: string } | null = null;
  if (!shape || !check) {
    why = capacityWhy(ctx, platform, gpus, 'expected') ?? { why: 'mem', detail: `${gpus} ${unit}放不下 1 人` };
  } else if (check.why !== null) {
    why =
      check.why === 'context' || check.why === 'weights'
        ? chosenWhy(ctx, platform, shape, check.why, gpus, unit)
        : { why: check.why, detail: failDetail(check, ctx.speed, users, shape) };
  }
  const oneUserFits = shape ? checkShape(ctx, platform, shape, 1, 'expected').capacityPerReplica >= 1 : false;
  const hasUsage = shape !== null && check !== null && check.why !== 'context' && check.why !== 'weights' && oneUserFits;
  const usage = hasUsage && shape ? shapeUsage(ctx, platform, shape, users, 'expected') : null;
  return { check, why, usage, hasUsage };
}

export type PerformanceResult = QuantFields & {
  dataVersion: string;
  /** The catalog platform id, or 'custom' for a user-entered platform. */
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
  const resolved = resolveIn(bundle, input.platform, quant.computeDtype);
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
      `輸入不合法：TP ${input.tp} 不能用在 ${gpus} ${unit}（這個模型在 ${platform.name} ${platform.sub} 的合法 TP：${legal.join('、')}；且不能超過 GPU 數）`,
    );
  }

  const evals = evaluateSplits(ctx, platform, fitting, gpus, users);
  const recommendedTp = pickSplit(evals)?.shape.tp ?? null;
  const chosenTp = input.tp ?? recommendedTp;
  const chosen = evals.find((e) => e.shape.tp === chosenTp) ?? null;
  const shape = chosen?.shape ?? null;

  const { check, why, usage, hasUsage } = judgeShape(ctx, platform, shape, gpus, users, unit);
  const mc = chosen?.maxConcurrent ?? 0;
  const speedCurve = hasUsage && shape
    ? shapeProfile(ctx, platform, shape, Math.max(mc, users), 'expected', PERFORMANCE_CURVE_POINTS).speedCurve
    : null;
  const queueing = check?.queueing ?? null;

  addQueueingBasis(basis, bundle, resolved, shape !== null);
  addCommBasis(basis, ctx, resolved.commBasis, [shape]);

  // Ruling R7: power counts the GPUs the chosen shape uses; the rest of `gpus` idle and are not counted.
  const used = shape ? shape.tp * shape.replicas : gpus;
  const powered = powerFor(basis, resolved, why === null, used);
  const { powerKw } = powered;
  const idle = gpus - used;
  const powerNote = why === null && idle > 0
    ? `${powered.powerNote ? `${powered.powerNote}；` : ''}功耗只計算使用中的 ${used} ${unit}，閒置的 ${idle} ${unit}不計入`
    : powered.powerNote;

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
      { maxTp: gpus, where: `${gpus} ${unit}`, ...(shape ? { shape } : {}) },
    ),
    warnings,
  );

  const list = basis.list();
  return {
    ...quantFields(ctx.model, qres),
    dataVersion: bundle.meta.dataVersion,
    platform: typeof input.platform === 'string' ? input.platform : 'custom',
    gpus,
    users,
    ok: why === null,
    why: why?.why ?? null,
    ...(why ? { detail: why.detail } : {}),
    shape,
    recommendedTp,
    splits: evals.map(({ reach: _reach, ...split }) => split),
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

/** Reason for the chosen t only (a forced t can fail on weights while a larger legal t fits): context, or its own weights. */
function chosenWhy(ctx: Ctx, platform: ResolvedPlatform, shape: Shape, why: Why, gpus: number, unit: string): { why: Why; detail: string } {
  if (why === 'context') return { why, detail: contextDetail(ctx) };
  return singleUserWhy(ctx, platform, [shape.tp], 'expected', `${gpus} ${unit}`) ?? { why, detail: `TP ${shape.tp} 放不下模型權重` };
}

const SweepInputSchema = UsersQueryInputSchema.extend({
  platform: PlatformInSchema,
  gpusList: z
    .array(int(MAX_GPUS))
    .min(1)
    .max(64)
    .refine((l) => l.every((g, i) => i === 0 || g > l[i - 1]!), { message: 'gpusList must be strictly increasing' }),
});
export type SweepInput = Omit<PerformanceInput, 'gpus' | 'tp'> & { gpusList: number[] };

/** One GPU count of a sweep: the best split's outcome at the current users. */
export type SweepPoint = {
  gpus: number;
  ok: boolean;
  why: Why | null;
  shape: Shape | null;
  tokPerSecPerUser: number | null;
  ttftSec: number | null;
  maxConcurrent: number;
  /**
   * Ruling W9: of this count's splits that serve the users on target (ok), the one with the highest per-user speed
   * (ties: smaller tp); null when none is ok. The default split (`shape`) is unchanged.
   */
  fastest: { shape: Shape; tokPerSecPerUser: number; ttftSec: number; maxConcurrent: number } | null;
};

/** estimatePerformance's headline numbers at several GPU counts (the best split each), sharing one preparation. */
export function estimatePerformanceSweep(
  bundle: Bundle,
  raw: SweepInput,
): { points: SweepPoint[]; basis: BasisItem[]; hasEstimate: boolean; hasUser: boolean; warnings: ResultWarning[]; dataVersion: string } {
  const input = parseInput(SweepInputSchema, raw);
  const { ctx: baseCtx, quant, basis, warnings } = prepare(bundle, input);
  const resolved = resolveIn(bundle, input.platform, quant.computeDtype);
  const { platform } = resolved;
  basis.add(...resolved.basis);
  const ctx = ctxForPlatform(baseCtx, quant, resolved, basis);
  const legal = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model);
  const unit = platform.unit === 'machine' ? '台' : '張 GPU';

  const shapes: (Shape | null)[] = [];
  const points = input.gpusList.map((gpus): SweepPoint => {
    const splits = evaluateSplits(ctx, platform, legal.filter((t) => t <= gpus), gpus, input.users);
    const best = pickSplit(splits);
    const top = splits.filter((e) => e.ok).sort((a, b) => b.tokPerSecPerUser - a.tokPerSecPerUser || a.shape.tp - b.shape.tp)[0];
    const shape = best?.shape ?? null;
    shapes.push(shape);
    const { why, usage } = judgeShape(ctx, platform, shape, gpus, input.users, unit);
    return {
      gpus,
      ok: why === null,
      why: why?.why ?? null,
      shape,
      tokPerSecPerUser: usage?.tokPerSecPerUser ?? null,
      ttftSec: usage?.ttftSec ?? null,
      maxConcurrent: best?.maxConcurrent ?? 0,
      fastest: top ? { shape: top.shape, tokPerSecPerUser: top.tokPerSecPerUser, ttftSec: top.ttftSec, maxConcurrent: top.maxConcurrent } : null,
    };
  });

  addQueueingBasis(basis, bundle, resolved, shapes.some((s) => s !== null));
  addCommBasis(basis, ctx, resolved.commBasis, shapes.filter((s): s is Shape => s !== null));
  const list = basis.list();
  return { points, basis: list, ...trustFlags(list), warnings, dataVersion: bundle.meta.dataVersion };
}
