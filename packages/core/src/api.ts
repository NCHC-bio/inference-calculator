/**
 * Public API of @nchc/core: the only entry points the website and the MCP server call
 * (spec §9). Every function validates its input with zod, resolves config ids against the bundle, and
 * returns results with a provenance basis (spec §2.1).
 * Error contract: every problem with the caller's input throws `CoreInputError` (./errors): code
 * 'invalid-input' (schema; `issues` lists them, the ZodError is `cause`) or 'unknown-id'. A plain Error means a
 * config / bundle problem or a core bug. User-entered models are not origin-checked (spec §2.2); every result that uses
 * one carries the non-blocking CUSTOM_MODEL_WARNING in `warnings`.
 * Pure: no Node or DOM APIs; the bundle is passed in.
 */
import { z } from 'zod';
import {
  HfRepoSchema, LayerGroupSchema, ModelSchema, SourceSchema, type Bundle, type CalibrationProfile, type Hardware, type Model, type Platform, type Quantization,
} from '@nchc/schema';
import { BasisCollector, fromSourced, fromUser, trustFlags, type BasisItem } from './basis';
import {
  capacityWhy,
  checkShape,
  legalTpOptions,
  MAX_GPUS,
  MAX_N,
  mlaBackendBlocks,
  shapeProfile,
  shapeUsage,
  type ShapeUsage,
  type SpeedPoint,
  maxConcurrent,
  maxConcurrentForGpus,
  exceedsMaxContext,
  solveMinGpus,
  type Ctx,
  type EtaMode,
  type Queueing,
  type ResolvedPlatform,
  type Shape,
  type Why,
} from './solve';
import { concurrencyFor } from './concurrency';
import { CoreInputError, parseInput } from './errors';
import { embeddingParams, expertParamsTotalB, hasSlidingLayers, inputEmbeddingBytes, layerShapeIssues, mlaLayoutIssues, moeParamsIssue } from './model-math';
import type { Replica, WorkloadIn } from './timing';

export type { BasisItem } from './basis';
export type { Queueing, ShapeUsage, SpeedPoint } from './solve';
export { CoreInputError, type CoreInputErrorCode } from './errors';

// ---------------------------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------------------------

const MAX_USERS = 1e7;
const MAX_TOKENS = 1e7;

/** Bounded positive integer: bounds keep every product in the formulas finite. */
const int = (max: number) => z.number().int().positive().max(max);

const OriginInSchema = z.strictObject({
  developer: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2 uppercase'),
});

/** Architecture fields of a model the user types in (plain numbers, no provenance). */
export const ModelOverrideSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    /**
     * HF repo `owner/name`: an input-validity check (it is interpolated into the verify command; final-review I4).
     * Not origin-checked; results carry CUSTOM_MODEL_WARNING (spec §2.2).
     */
    hfRepo: HfRepoSchema.optional(),
    /** Base model repo of a derived model: recorded lineage, not checked. */
    baseModel: z.string().min(1).optional(),
    /** Optional publisher origin: recorded, not checked (spec §2.2). */
    origin: OriginInSchema.optional(),
    /** Base model origin: recorded lineage, not checked. */
    baseOrigin: OriginInSchema.optional(),
    totalParamsB: z.number().positive().max(1e5),
    layers: int(1e4),
    heads: int(1e4),
    kvHeads: int(1e4),
    headDim: int(1e5),
    hidden: int(1e6),
    attention: z.enum(['gqa', 'mla']).default('gqa'),
    mla: z.strictObject({ kvLoraRank: int(1e6), qkRopeHeadDim: int(1e5), qkNopeHeadDim: int(1e5), vHeadDim: int(1e5) }).optional(),
    layerGroups: z.array(LayerGroupSchema).min(1).max(1e4).optional(),
    moe: z.strictObject({ experts: int(1e5), topK: int(1e5), expertFfnDim: int(1e6) }).optional(),
    slidingWindow: int(1e8).nullable().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.attention === 'mla' && !m.mla) {
      ctx.addIssue({ code: 'custom', path: ['mla'], message: "attention 'mla' requires mla" });
    }
    // MLA + layerGroups / slidingWindow: not modelled yet, reject instead of ignoring (Ruling R22).
    for (const i of mlaLayoutIssues(m)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
    if (m.moe) {
      if (m.moe.topK > m.moe.experts) {
        ctx.addIssue({ code: 'custom', path: ['moe', 'topK'], message: 'topK must not exceed experts' });
      }
      const issue = moeParamsIssue({ ...m, totalParamsB: { value: m.totalParamsB } });
      if (issue) ctx.addIssue({ code: 'custom', path: ['moe'], message: issue });
    }
    // Layer-group sum and GQA head grouping: core's check, shared with config validation.
    for (const i of layerShapeIssues(m)) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
    m.layerGroups?.forEach((g, i) => {
      const nums = [g.count, g.kvHeads, g.headDim, g.window, g.ssm?.heads, g.ssm?.headDim, g.ssm?.stateSize, g.ssm?.stateBytesPerElem];
      if (nums.some((v) => v !== undefined && v > 1e8)) {
        ctx.addIssue({ code: 'custom', path: ['layerGroups', i], message: 'layer group values must be ≤ 1e8' });
      }
    });
  });
export type ModelOverride = z.input<typeof ModelOverrideSchema>;

/** Internal: used by funnel.ts; not re-exported from index.ts. */
export const WorkloadInputSchema = z.union([
  z.string().min(1),
  z
    .strictObject({
      base: z.string().min(1),
      inputTokens: z.number().int().min(0).max(MAX_TOKENS).optional(),
      outputTokens: z.number().int().min(1).max(MAX_TOKENS).optional(),
      cacheHitRate: z.number().min(0).lt(1).optional(),
    })
    .strict(),
]);

/** Internal: used by funnel.ts; not re-exported from index.ts. */
export const SpeedInputSchema = z.union([
  z.string().min(1),
  z.strictObject({ minTokPerSec: z.number().positive().max(1e6), maxTtftSec: z.number().positive().max(1e6) }).strict(),
]);

/** A model imported from Hugging Face (`data:import` output) with the source its fields cite; not in the catalog. */
const ImportedModelSchema = z.strictObject({ imported: z.strictObject({ model: ModelSchema, source: SourceSchema }) });
export type ImportedModelInput = { imported: { model: z.input<typeof ModelSchema>; source: z.input<typeof SourceSchema> } };

const ModelInputSchema = z.union([z.string().min(1), ModelOverrideSchema, ImportedModelSchema]);
const usersSchema = z.number().int().positive().max(MAX_USERS);

/** Query shared by every entry point. */
export const QueryInputSchema = z.strictObject({
  model: ModelInputSchema,
  quant: z.string().min(1),
  workload: WorkloadInputSchema,
  speed: SpeedInputSchema,
  users: usersSchema.optional(),
  /** Include tensor-parallel all-reduce time (default true). */
  includeComm: z.boolean().optional(),
});
export type QueryInput = z.input<typeof QueryInputSchema>;

/**
 * A user-entered GPU or machine (spec 2026-10-21-direct-manipulation-design §5.3). `tflops` is the dense peak per GPU,
 * used for any compute dtype; a machine is one per node.
 */
export const CustomPlatformInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    unit: z.enum(['gpu', 'machine']),
    gpusPerNode: z.number().int().min(1).max(8),
    memGB: z.number().positive().max(1e5),
    memBwTBs: z.number().positive().max(1e3),
    tflops: z.number().positive().max(1e6),
    tdpW: z.number().positive().max(1e5).optional(),
    nvlinkBidirGBs: z.number().positive().max(1e5).optional(),
    engine: z.enum(['vllm', 'mlx']),
  })
  .refine((c) => c.unit === 'gpu' || c.gpusPerNode === 1, {
    path: ['gpusPerNode'],
    message: 'unit machine is one per node: gpusPerNode must be 1',
  });
export type CustomPlatformInput = z.input<typeof CustomPlatformInputSchema>;

/** A QueryInput whose `users` is required (the base of estimateRequirements' and estimatePerformance's inputs). */
export const UsersQueryInputSchema = QueryInputSchema.extend({ users: usersSchema });
export const RequirementInputSchema = UsersQueryInputSchema.extend({
  /** User-entered platforms, evaluated after the catalog as `custom:<i>` (spec 2026-10-21 §5.3). */
  customPlatforms: z.array(CustomPlatformInputSchema).max(8).optional(),
});
/** estimateRequirements input: a QueryInput whose `users` is required, plus optional custom platforms. */
export type RequirementInput = z.input<typeof RequirementInputSchema>;
/** Capacity input: no `users` (the capacity is the answer; final-review M16 — it used to be accepted and ignored). */
const CapacityInputSchema = QueryInputSchema.omit({ users: true }).extend({
  platform: z.string().min(1),
  gpus: z.number().int().positive().max(MAX_GPUS),
});
export type CapacityInput = z.input<typeof CapacityInputSchema>;

/** Catalog search over every catalog model (no `model` field); `quant` omitted → every quantization. */
const FeasibleInputSchema = QueryInputSchema.omit({ model: true, quant: true }).extend({
  quant: z.string().min(1).optional(),
  platform: z.string().min(1),
  gpus: z.number().int().positive().max(MAX_GPUS),
});
export type FeasibleInput = z.input<typeof FeasibleInputSchema>;

/** explain: the capacity path (platform + gpus) or the requirement path (users), as the two entry points take them. */
const ExplainInputSchema = z.union([CapacityInputSchema, RequirementInputSchema]);
export type ExplainInput = z.input<typeof ExplainInputSchema>;

// ---------------------------------------------------------------------------------------------
// Resolution (config ids → numbers + basis)
// ---------------------------------------------------------------------------------------------

/** The basis items of a platform's KV allocation granularity (resolvePlatform; the one used is picked per model). */
type KvBlockBasis =
  | { engine: 'vllm'; standard: BasisItem; mlaFp8Kv: BasisItem; mlaBf16Kv: BasisItem; mlaOtherwise?: { fp8Kv: BasisItem; bf16Kv: BasisItem } }
  | { engine: 'mlx'; step: BasisItem };

/** A resolved platform plus the inference engine its verify command targets (spec §10.1). */
export type ApiPlatform = ResolvedPlatform & {
  engine: 'vllm' | 'mlx';
  /** vLLM API-server defaults of this platform (platforms.yaml `vllmDefaults`); absent on MLX. */
  vllmDefaults?: { maxNumSeqs: number; maxNumBatchedTokens: number; maxConcurrentBatches: number };
  /** Engine-fixed KV bytes per element from the calibration profile (Ruling R32); undefined → the quantization's. */
  kvBytesPerElemOverride?: number;
};

function lookup<T>(rec: Record<string, T>, id: string, what: string): T {
  const v = Object.hasOwn(rec, id) ? rec[id] : undefined;
  if (v === undefined) throw new CoreInputError('unknown-id', `未知的${what} id：${id}`);
  return v;
}

/**
 * Resolve a platform to per-replica totals for a compute dtype. `replicaFor(tp, eta)`:
 * per-GPU memory / bandwidth / FLOPS × tp; eta 'expected' → etaBw, 'conservative' → etaBwLow;
 * allreduce latency = platform override ?? calibration profile (Ruling R3);
 * link bandwidth per direction = nvlinkBidirGBs × 1e9 / 2, or 0 when absent.
 * Peak FLOPS: the dense value for `computeDtype` [R-LEC C1, C2], else `effective` (Mac).
 * Engine: the calibration profile's `engine` (review M-6).
 */
export function resolvePlatform(bundle: Bundle, id: string, computeDtype: Quantization['computeDtype']): ResolvedApiPlatform {
  const p = lookup(bundle.platforms, id, '平台');
  const hw: Hardware = lookup(bundle.hardware, p.hardware, '硬體');
  const cal = lookup(bundle.calibration, p.calibration, '校正設定');
  const prefix = { platform: `platforms.${p.id}`, hardware: `hardware.${hw.id}`, calibration: `calibration.${cal.id}` };
  return resolveFrom(p, hw, cal, computeDtype, {
    item: (kind, field, label, s, lecRef) => fromSourced(`${prefix[kind]}.${field}`, label, s, lecRef),
  });
}

/** Where a platform value comes from: the platform entry, its hardware or its calibration profile. */
type ValueKind = 'platform' | 'hardware' | 'calibration';

/** How resolveFrom turns each value it uses into a basis item (catalog: fromSourced; custom: user / borrowed). */
type ResolveOpts = {
  /** `field` is the value's dotted path inside its section (`memGB`, `tflops.fp8`, `vllmDefaults.maxNumSeqs`). */
  item(kind: ValueKind, field: string, label: string, s: Parameters<typeof fromSourced>[2], lecRef?: string): BasisItem;
};

/** A platform resolved for one compute dtype (resolvePlatform / resolveCustomPlatform). */
export type ResolvedApiPlatform = {
  platform: ApiPlatform;
  /** Values every calculation on this platform uses. */
  basis: BasisItem[];
  /** Engine KV override (Ruling R32); added by ctxForPlatform only when it applies. */
  kvOverrideBasis?: BasisItem;
  /** TDP: add only when power is computed (requirement path). */
  tdpBasis: BasisItem;
  /** NVLink bandwidth + all-reduce latency: add only when a chosen shape has tp > 1 and comm is on. */
  commBasis: BasisItem[];
  /** t_fixed of the calibration profile; added by ctxForPlatform only when it is non-zero (review L4). */
  tFixedBasis: BasisItem;
  /** Per-request TTFT overhead of the calibration profile; added by ctxForPlatform only when non-zero (Ruling R41). */
  ttftOverheadBasis: BasisItem;
  /** vLLM defaults (vLLM platforms only); each added by the code that uses it. */
  vllmDefaultsBasis?: { maxNumSeqs: BasisItem; maxNumBatchedTokens: BasisItem; maxConcurrentBatches: BasisItem };
  /** KV allocation granularity (spec §5.1): added by ctxForPlatform for the one the model's KV uses. */
  kvBlockBasis?: KvBlockBasis;
  /** mlx-lm prefill_step_size (MLX only): added by ctxForPlatform when a prompt takes more than one chunk (Ruling R38). */
  prefillStepBasis?: BasisItem;
};

/**
 * The one resolution of a platform entry, its hardware and its calibration profile (resolvePlatform for the catalog,
 * resolveCustomPlatform for a user-entered one); `opts.item` builds every basis item.
 */
function resolveFrom(
  p: Platform,
  hw: Hardware,
  cal: CalibrationProfile,
  computeDtype: Quantization['computeDtype'],
  opts: ResolveOpts,
): ResolvedApiPlatform {
  const b = new BasisCollector();
  const { item } = opts;

  const peakKey = hw.tflops[computeDtype] ? computeDtype : hw.tflops.effective ? 'effective' : null;
  if (peakKey === null) {
    throw new Error(`硬體 ${hw.id} 沒有 ${computeDtype} 或 effective 的 TFLOPS，無法計算算力`);
  }
  const peak = hw.tflops[peakKey]!;

  b.add(
    item('platform', 'gpusPerNode', `${p.name} ${p.sub} 每 node 卡數`, p.gpusPerNode),
    item('hardware', 'memGB', `${hw.name} 記憶體容量`, hw.memGB),
    item('hardware', 'memBwTBs', `${hw.name} 記憶體頻寬`, hw.memBwTBs, 'B1'),
    item('hardware', `tflops.${peakKey}`, `${hw.name} ${peakKey} 峰值算力（dense）`, peak, 'A4, C1, C2'),
    // η_bw has no lecture counterpart (lecture-formulas.md A4, B1): the calculator adds it by analogy with A4's
    // utilisation; its value is the calibration profile's, so no lecRef (review L5).
    item('calibration', 'etaBw', '頻寬效率 η_bw（預期；講義無對應項，計算機比照 A4 的利用率補充，值取自校正設定）', cal.etaBw),
    item('calibration', 'etaBwLow', '頻寬效率 η_bw（保守；講義無對應項，計算機比照 A4 的利用率補充，值取自校正設定）', cal.etaBwLow),
    item('calibration', 'etaCompute', '算力效率 η_compute', cal.etaCompute, 'A4'),
    item('calibration', 'memUtil', '記憶體可用比例', cal.memUtil),
  );
  const latency = p.allreduceLatencyUs ?? cal.allreduceLatencyUs;
  const commBasis: BasisItem[] = [];
  if (hw.nvlinkBidirGBs) commBasis.push(item('hardware', 'nvlinkBidirGBs', `${hw.name} NVLink 雙向頻寬`, hw.nvlinkBidirGBs));
  commBasis.push(
    item(p.allreduceLatencyUs ? 'platform' : 'calibration', 'allreduceLatencyUs', 'all-reduce 延遲', latency),
  );
  const tdpBasis = item('hardware', 'tdpW', `${hw.name} TDP`, hw.tdpW, 'D1');

  const memBytes = hw.memGB.value * 1e9;
  const bw = hw.memBwTBs.value * 1e12;
  const flops = peak.value * 1e12;
  const link = hw.nvlinkBidirGBs ? (hw.nvlinkBidirGBs.value * 1e9) / 2 : 0;
  const platform: ApiPlatform = {
    id: p.id,
    name: p.name,
    sub: p.sub,
    group: p.group,
    unit: p.unit,
    gpusPerNode: p.gpusPerNode.value,
    tpOptions: [...p.tpOptions],
    tdpW: hw.tdpW.value,
    engine: cal.engine,
    ...(p.vllmDefaults
      ? {
          vllmDefaults: {
            maxNumSeqs: p.vllmDefaults.maxNumSeqs.value,
            maxNumBatchedTokens: p.vllmDefaults.maxNumBatchedTokens.value,
            maxConcurrentBatches: p.vllmDefaults.maxConcurrentBatches.value,
          },
        }
      : {}),
    // vLLM max_in_flight_tokens: the chunks sliding-window layers hold beyond the window, reserved once per replica,
    // and the per-request upper bound of the startup check (spec §5.1, kvSizing); MLX keeps the window.
    slidingInFlightTokens:
      cal.engine === 'vllm' && p.vllmDefaults
        ? p.vllmDefaults.maxConcurrentBatches.value * p.vllmDefaults.maxNumBatchedTokens.value
        : 0,
    // vLLM chunks a prompt at max_num_batched_tokens: the MoE experts-touched mixture uses it (spec §5.2, review L6).
    ...(cal.engine === 'vllm' && p.vllmDefaults ? { maxNumBatchedTokens: p.vllmDefaults.maxNumBatchedTokens.value } : {}),
    ...(cal.kvBytesPerElemOverride ? { kvBytesPerElemOverride: cal.kvBytesPerElemOverride.value } : {}),
    // KV allocation granularity (spec §5.1): vLLM blocks (MLA: the backend's block for the KV dtype), mlx-lm KVCache steps.
    ...(cal.engine === 'vllm' && p.vllmDefaults
      ? {
          kvAllocation: {
            engine: 'vllm' as const,
            blockSize: p.vllmDefaults.kvBlockSize.value,
            mlaBlockSize: {
              fp8Kv: p.vllmDefaults.mlaKvBlockSize.fp8Kv.value,
              bf16Kv: p.vllmDefaults.mlaKvBlockSize.bf16Kv.value,
              ...(p.vllmDefaults.mlaKvBlockSize.qkNopeHeadDims && p.vllmDefaults.mlaKvBlockSize.otherwise
                ? {
                    qkNopeHeadDims: [...p.vllmDefaults.mlaKvBlockSize.qkNopeHeadDims],
                    otherwise: {
                      fp8Kv: p.vllmDefaults.mlaKvBlockSize.otherwise.fp8Kv.value,
                      bf16Kv: p.vllmDefaults.mlaKvBlockSize.otherwise.bf16Kv.value,
                    },
                  }
                : {}),
            },
          },
        }
      : cal.engine === 'mlx' && cal.mlxDefaults
        ? { kvAllocation: { engine: 'mlx' as const, kvCacheStep: cal.mlxDefaults.kvCacheStep.value } }
        : {}),
    // MLX prompts run in prefill_step_size chunks (TTFT, Ruling R38); vLLM chunks at what decode leaves of the budget.
    ...(cal.engine === 'mlx' && cal.mlxDefaults ? { prefillStepTokens: cal.mlxDefaults.prefillStepSize.value } : {}),
    replicaFor(tp: number, eta: EtaMode): Replica {
      return {
        tp,
        memBytes: memBytes * tp,
        memBwBytesPerSec: bw * tp,
        flopsPerSec: flops * tp,
        etaBw: eta === 'conservative' ? cal.etaBwLow.value : cal.etaBw.value,
        etaCompute: cal.etaCompute.value,
        memUtil: cal.memUtil.value,
        allreduceLatencySec: latency.value * 1e-6,
        linkBwBytesPerSecPerDir: link,
        tFixedSec: cal.tFixedSec.value,
        ttftOverheadSec: cal.ttftOverheadSec.value,
      };
    },
  };
  const kvOverrideBasis = cal.kvBytesPerElemOverride
    ? item('calibration', 'kvBytesPerElemOverride', 'KV cache 每元素位元組（推論引擎固定，取代量化格式的值）', cal.kvBytesPerElemOverride, 'B3, C1')
    : undefined;
  const vd = p.vllmDefaults;
  const vllmDefaultsBasis = vd
    ? {
        maxNumSeqs: item('platform', 'vllmDefaults.maxNumSeqs', `${p.name} ${p.sub} vLLM 預設 max_num_seqs`, vd.maxNumSeqs),
        maxNumBatchedTokens: item(
          'platform', 'vllmDefaults.maxNumBatchedTokens',
          `${p.name} ${p.sub} vLLM 預設 max_num_batched_tokens（每步 chunked prefill 的 token 上限；sliding window 層在 window 之外暫存進行中的 chunk）`,
          vd.maxNumBatchedTokens,
        ),
        maxConcurrentBatches: item(
          'platform', 'vllmDefaults.maxConcurrentBatches',
          `${p.name} ${p.sub} vLLM 同時進行的批次數 max_concurrent_batches（async scheduling 預設開啟、PP = 1：2）；× max_num_batched_tokens = 進行中 token 上限`,
          vd.maxConcurrentBatches,
        ),
      }
    : undefined;
  const kvBlockBasis: KvBlockBasis | undefined =
    cal.engine === 'vllm' && vd
      ? {
          engine: 'vllm',
          standard: item('platform', 'vllmDefaults.kvBlockSize', `${p.name} ${p.sub} vLLM KV block 大小（token；KV 以整個 block 配置）`, vd.kvBlockSize),
          mlaFp8Kv: item('platform', 'vllmDefaults.mlaKvBlockSize.fp8Kv', `${p.name} ${p.sub} vLLM MLA backend 的 KV block 大小（FP8 KV，token）`, vd.mlaKvBlockSize.fp8Kv),
          mlaBf16Kv: item('platform', 'vllmDefaults.mlaKvBlockSize.bf16Kv', `${p.name} ${p.sub} vLLM MLA backend 的 KV block 大小（16-bit KV，token）`, vd.mlaKvBlockSize.bf16Kv),
          ...(vd.mlaKvBlockSize.otherwise
            ? {
                mlaOtherwise: {
                  fp8Kv: item(
                    'platform', 'vllmDefaults.mlaKvBlockSize.otherwise.fp8Kv',
                    `${p.name} ${p.sub} vLLM MLA 備用 backend 的 KV block 大小（qk_nope_head_dim 不在 ${vd.mlaKvBlockSize.qkNopeHeadDims?.join('／')} 時；FP8 KV，token）`,
                    vd.mlaKvBlockSize.otherwise.fp8Kv,
                  ),
                  bf16Kv: item(
                    'platform', 'vllmDefaults.mlaKvBlockSize.otherwise.bf16Kv',
                    `${p.name} ${p.sub} vLLM MLA 備用 backend 的 KV block 大小（qk_nope_head_dim 不在 ${vd.mlaKvBlockSize.qkNopeHeadDims?.join('／')} 時；16-bit KV，token）`,
                    vd.mlaKvBlockSize.otherwise.bf16Kv,
                  ),
                },
              }
            : {}),
        }
      : cal.engine === 'mlx' && cal.mlxDefaults
        ? { engine: 'mlx', step: item('calibration', 'mlxDefaults.kvCacheStep', 'mlx-lm KVCache 每次擴充的 token 數（KV 以此為單位配置）', cal.mlxDefaults.kvCacheStep) }
        : undefined;
  return {
    platform, basis: b.list(), ...(kvOverrideBasis ? { kvOverrideBasis } : {}), tdpBasis, commBasis,
    tFixedBasis: item('calibration', 'tFixedSec', '每步固定開銷 t_fixed（秒；decode 每步、prefill 每段各一次）', cal.tFixedSec, 'G2'),
    // No lecture formula: the value and its form come from the R41 calibration only (final-review M7).
    ttftOverheadBasis: item('calibration', 'ttftOverheadSec', '每個請求的首字固定開銷（秒；每個請求一次，加在 TTFT；形式與數值都來自 Ruling R41 的校正擬合）', cal.ttftOverheadSec),
    ...(vllmDefaultsBasis ? { vllmDefaultsBasis } : {}),
    ...(kvBlockBasis ? { kvBlockBasis } : {}),
    ...(cal.engine === 'mlx' && cal.mlxDefaults
      ? {
          prefillStepBasis: item(
            'calibration', 'mlxDefaults.prefillStepSize',
            'mlx-lm prefill_step_size（prompt 每段的 token 數；每段重讀一次權重）',
            cal.mlxDefaults.prefillStepSize,
          ),
        }
      : {}),
  };
}

/**
 * Placeholder provenance for a user value inside the synthetic Hardware / Platform; never shown, because
 * resolveCustomPlatform's `item` turns every user value into a fromUser item.
 */
const userValue = <T>(value: T) => ({ value, status: 'unverified' as const, verified: '' });

/**
 * Resolve a custom platform (spec 2026-10-21 §5.3) through the same resolveFrom as the catalog: the user's numbers are
 * `user` in the basis; the efficiency factors, all-reduce latency, t_fixed, TTFT overhead, vLLM defaults and KV block
 * size come from `bundle.customHardware.templates[engine].platform` and are `estimate` ("borrowed"), citing the template
 * value's sources plus the template's evidence. tpOptions: {1, 2, 4, 8} ≤ gpusPerNode when an interconnect bandwidth is
 * given and the borrowed all-reduce latency is > 0 (Ruling R14), else [1]. Basis paths are `<pathPrefix>.<field>`.
 */
export function resolveCustomPlatform(
  bundle: Bundle,
  raw: CustomPlatformInput,
  computeDtype: Quantization['computeDtype'],
  /** Basis path prefix: 'custom' for a single platform, `custom:<i>` for row i of estimateRequirements (Ruling R4). */
  pathPrefix = 'custom',
): ResolvedApiPlatform {
  const input = parseInput(CustomPlatformInputSchema, raw);
  const tpl = bundle.customHardware.templates[input.engine];
  const tplPlat = lookup(bundle.platforms, tpl.platform, '平台');
  const cal = lookup(bundle.calibration, tplPlat.calibration, '校正設定');
  if (cal.engine !== input.engine) throw new Error(`自訂硬體範本 ${tpl.platform} 的引擎是 ${cal.engine}，不是 ${input.engine}`);
  const latency = tplPlat.allreduceLatencyUs ?? cal.allreduceLatencyUs;
  const canSplit = input.nvlinkBidirGBs !== undefined && latency.value > 0;
  const hw: Hardware = {
    id: 'custom',
    name: input.name,
    memGB: userValue(input.memGB),
    memBwTBs: userValue(input.memBwTBs),
    tflops: { [computeDtype]: userValue(input.tflops) },
    tdpW: userValue(input.tdpW ?? null),
    ...(input.nvlinkBidirGBs !== undefined ? { nvlinkBidirGBs: userValue(input.nvlinkBidirGBs) } : {}),
  };
  const p: Platform = {
    id: 'custom',
    name: input.name,
    sub: '自訂',
    group: 'self',
    unit: input.unit,
    hardware: hw.id,
    gpusPerNode: userValue(input.gpusPerNode),
    tpOptions: canSplit ? ([1, 2, 4, 8] as const).filter((t) => t <= input.gpusPerNode) : [1],
    calibration: cal.id,
    ...(tplPlat.allreduceLatencyUs ? { allreduceLatencyUs: tplPlat.allreduceLatencyUs } : {}),
    ...(tplPlat.vllmDefaults ? { vllmDefaults: tplPlat.vllmDefaults } : {}),
  };
  const borrowed = `這台硬體沒有實測，借用 ${tpl.platform} 的校正值（${tpl.rationale}）`;
  return resolveFrom(p, hw, cal, computeDtype, {
    item: (kind, field, label, s, lecRef) => {
      const path = `${pathPrefix}.${field}`;
      if (kind === 'hardware' || field === 'gpusPerNode') {
        const u = fromUser(path, label, s.value, lecRef);
        return s.value === null ? { ...u, text: `${label}；使用者未填` } : u;
      }
      const from = fromSourced(path, label, s, lecRef);
      return { ...from, status: 'estimate', sourceIds: [...new Set([...from.sourceIds, ...tpl.evidence])], text: `${from.text}；${borrowed}` };
    },
  });
}

/**
 * The Ctx for one platform: KV bytes per element = the platform's engine override when its
 * calibration profile has one (Ruling R32, e.g. MLX fp16 KV), else the quantization's. Adds the
 * value actually used to the basis, so the basis shows which one applied.
 *
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function ctxForPlatform(
  ctx: Ctx,
  quant: Quantization,
  resolved: {
    platform: ApiPlatform;
    kvOverrideBasis?: BasisItem;
    vllmDefaultsBasis?: { maxNumBatchedTokens: BasisItem; maxConcurrentBatches: BasisItem };
    tFixedBasis?: BasisItem;
    ttftOverheadBasis?: BasisItem;
    kvBlockBasis?: KvBlockBasis;
    prefillStepBasis?: BasisItem;
  },
  basis: BasisCollector,
): Ctx {
  // t_fixed enters every step; it is listed (and counts for trust) only when it changes a result (review L4).
  if (resolved.tFixedBasis && (resolved.platform.replicaFor(1, 'expected').tFixedSec ?? 0) > 0) basis.add(resolved.tFixedBasis);
  // Every result checks a TTFT, so the per-request overhead is listed whenever it is non-zero (Ruling R41).
  if (resolved.ttftOverheadBasis && (resolved.platform.replicaFor(1, 'expected').ttftOverheadSec ?? 0) > 0) {
    basis.add(resolved.ttftOverheadBasis);
  }
  // Sliding-window KV on vLLM reserves the in-flight tokens (spec §5.1, kvSizing): list them only when they are used.
  if ((resolved.platform.slidingInFlightTokens ?? 0) > 0 && hasSlidingLayers(ctx.model) && resolved.vllmDefaultsBasis) {
    basis.add(resolved.vllmDefaultsBasis.maxNumBatchedTokens, resolved.vllmDefaultsBasis.maxConcurrentBatches);
  }
  // MoE: a prompt longer than max_num_batched_tokens is routed in chunks of it (decodeStep, review L6 correction).
  const mnbt = resolved.platform.maxNumBatchedTokens;
  const newTok = ctx.workload.inputTokens * (1 - ctx.workload.cacheHitRate);
  if (ctx.model.moe && mnbt !== undefined && newTok > mnbt && resolved.vllmDefaultsBasis) {
    basis.add(resolved.vllmDefaultsBasis.maxNumBatchedTokens);
  }
  // MLX: a prompt longer than prefill_step_size runs in several chunks, each re-reading the weights (Ruling R38). On vLLM
  // the budget the chunks come from is listed with the queueing model (addQueueingBasis).
  const step = resolved.platform.prefillStepTokens;
  if (step !== undefined && newTok > step && resolved.prefillStepBasis) basis.add(resolved.prefillStepBasis);
  const override = resolved.platform.kvBytesPerElemOverride;
  const kvElem = override !== undefined && resolved.kvOverrideBasis ? override : quant.kvBytesPerElem.value;
  // The KV allocation granularity the capacity uses (kvSizing / kvBlockTokens, spec §5.1).
  const kb = resolved.kvBlockBasis;
  if (kb) {
    // MLA: the backend's block, or the fallback backend's when the model's qk_nope_head_dim is refused (final-review M26).
    const alloc = resolved.platform.kvAllocation;
    const fallback = kb.engine === 'vllm' && alloc?.engine === 'vllm' && ctx.model.attention === 'mla' && mlaBackendBlocks(alloc.mlaBlockSize, ctx.model).fallback;
    basis.add(
      kb.engine === 'mlx'
        ? kb.step
        : ctx.model.attention !== 'mla'
          ? kb.standard
          : fallback && kb.mlaOtherwise
            ? kvElem === 1 ? kb.mlaOtherwise.fp8Kv : kb.mlaOtherwise.bf16Kv
            : kvElem === 1 ? kb.mlaFp8Kv : kb.mlaBf16Kv,
    );
  }
  if (override !== undefined && resolved.kvOverrideBasis) {
    basis.add(resolved.kvOverrideBasis);
    return { ...ctx, kvBytesPerElem: override };
  }
  basis.add(kvElemBasis(quant));
  return { ...ctx, kvBytesPerElem: quant.kvBytesPerElem.value };
}

/**
 * Add vLLM max_num_batched_tokens and the queueing rule (Little's law, Ruling R36) when the queueing model was evaluated
 * on a chosen shape: a null queue ("all decode within the budget") depends on them as much as a wait does, and the
 * wait enters the TTFT, the feasibility and the GPU count. MLX has no budget and adds nothing.
 *
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function addQueueingBasis(
  basis: BasisCollector,
  bundle: Bundle,
  resolved: { platform: ApiPlatform; vllmDefaultsBasis?: { maxNumBatchedTokens: BasisItem } },
  evaluated: boolean,
): void {
  if (evaluated && resolved.platform.maxNumBatchedTokens !== undefined && resolved.vllmDefaultsBasis) {
    basis.add(
      resolved.vllmDefaultsBasis.maxNumBatchedTokens,
      fromSourced('concurrency.queueRule', "預填排隊模型（每步 token 上限 + Little's law）", bundle.concurrency.queueRule),
    );
  }
}

/**
 * Peak power gpus × TDP [R-LEC D1] for a feasible result (adds the TDP to `basis`); a note instead when infeasible or
 * the TDP is unverified.
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function powerFor(
  basis: BasisCollector,
  resolved: { platform: ApiPlatform; tdpBasis: BasisItem },
  ok: boolean,
  gpus: number,
): { powerKw: number | null; powerNote?: string } {
  if (!ok) return { powerKw: null, powerNote: '沒有可行配置，未計算功耗' };
  basis.add(resolved.tdpBasis);
  if (resolved.platform.tdpW === null) {
    return { powerKw: null, powerNote: resolved.tdpBasis.status === 'user' ? '未填 TDP，未計算功耗' : '功耗未查證' };
  }
  return { powerKw: (gpus * resolved.platform.tdpW) / 1000 };
}

/**
 * Add the link bandwidth / all-reduce latency only when a chosen shape actually communicates (finding 7).
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function addCommBasis(basis: BasisCollector, ctx: Ctx, commBasis: BasisItem[], shapes: Array<Shape | null | undefined>): void {
  if ((ctx.includeComm ?? true) && shapes.some((s) => s && s.tp > 1)) basis.add(...commBasis);
}

const kvElemBasis = (q: Quantization): BasisItem =>
  fromSourced(`quantization.${q.id}.kvBytesPerElem`, `${q.name} KV cache 每元素位元組`, q.kvBytesPerElem, 'B3, C1');

const OVERRIDE_LABELS: Record<string, string> = {
  totalParamsB: '總參數量（B）',
  layers: '層數',
  heads: '注意力頭數',
  kvHeads: 'KV 頭數',
  headDim: '每頭維度',
  hidden: '隱藏層維度',
  attention: '注意力類型',
  mla: 'MLA 參數',
  layerGroups: '分層注意力設定',
  moe: 'MoE 設定',
  slidingWindow: '滑動視窗',
};
const OVERRIDE_LEC: Record<string, string> = { totalParamsB: 'B3, B8', moe: 'B3' };

/** A non-blocking warning on a result (it never stops the computation). */
export type ResultWarning = { code: 'custom-model-supply-chain'; text: string };

/**
 * Attached to every result that uses a user-entered (custom) model, whatever its origin or hfRepo (spec §2.2).
 * Catalog models never get it.
 */
export const CUSTOM_MODEL_WARNING: ResultWarning = Object.freeze({
  code: 'custom-model-supply-chain',
  text: '國網中心規定禁止使用紅色供應鏈模型（發表者為中國、香港或澳門組織）。使用後果請用戶自行承擔。',
});

/**
 * Resolve a catalog model id, or turn a user override into a Model. Override values are
 * all status 'user'. An override is not origin-checked (spec §2.2); it always yields
 * CUSTOM_MODEL_WARNING, a catalog model none.
 */
export function resolveModel(
  bundle: Bundle,
  idOrOverride: string | ModelOverride | ImportedModelInput,
): { model: Model; basis: BasisItem[]; warnings: ResultWarning[] } {
  if (typeof idOrOverride === 'string') {
    const m = lookup(bundle.models, idOrOverride, '模型');
    const arch = {
      layers: m.layers,
      heads: m.heads,
      kvHeads: m.kvHeads,
      headDim: m.headDim,
      hidden: m.hidden,
      attention: m.attention,
      ...(m.mla ? { mla: m.mla } : {}),
      ...(m.moe ? { moe: m.moe } : {}),
      ...(m.layerGroups ? { layerGroups: m.layerGroups } : {}),
      ...(m.slidingWindow != null ? { slidingWindow: m.slidingWindow } : {}),
    };
    const basis: BasisItem[] = [
      fromSourced(`models.${m.id}.totalParamsB`, `${m.name} 總參數量`, m.totalParamsB, 'B3, B8'),
      {
        path: `models.${m.id}.architecture`,
        status: 'official',
        value: arch,
        sourceIds: [m.source],
        text: `${m.name} 架構（層數、注意力頭、MoE 等，取自模型 config.json）`,
      },
    ];
    return { model: m, basis, warnings: [] };
  }

  if ('imported' in idOrOverride) return resolveImported(bundle, idOrOverride);

  const o = parseInput(ModelOverrideSchema, idOrOverride);
  const basis = Object.entries(o)
    .filter(([k, v]) => k in OVERRIDE_LABELS && v !== undefined)
    .map(([k, v]) => fromUser(`model.${k}`, OVERRIDE_LABELS[k]!, v, OVERRIDE_LEC[k]));
  const model = {
    id: 'user-override',
    name: o.name ?? '自訂模型',
    ...(o.hfRepo ? { hfRepo: o.hfRepo } : {}),
    ...(o.baseModel ? { baseModel: o.baseModel } : {}),
    // 'ZZ' = ISO user-assigned code: origin not given by the user.
    origin: o.origin ?? { developer: '使用者自訂', country: 'ZZ' },
    ...(o.baseOrigin ? { baseOrigin: o.baseOrigin } : {}),
    // Core math reads only `.value`; provenance for overrides lives in the basis ('user').
    totalParamsB: { value: o.totalParamsB, status: 'user', verified: bundle.meta.dataVersion },
    layers: o.layers,
    heads: o.heads,
    kvHeads: o.kvHeads,
    headDim: o.headDim,
    hidden: o.hidden,
    attention: o.attention,
    ...(o.mla ? { mla: o.mla } : {}),
    ...(o.layerGroups ? { layerGroups: o.layerGroups } : {}),
    ...(o.moe ? { moe: o.moe } : {}),
    ...(o.slidingWindow != null ? { slidingWindow: o.slidingWindow } : {}),
    source: 'user',
    verified: bundle.meta.dataVersion,
  } as unknown as Model;
  return { model, basis, warnings: [CUSTOM_MODEL_WARNING] };
}

/**
 * An imported model: validated like a catalog model (schema, layer shape, MoE split, MLA layout; core's own checks,
 * the same ones config validation runs) and every id its sourced fields cite must be the supplied source (a derived
 * field's inputs may also be a bundle source). Not origin-checked; always carries CUSTOM_MODEL_WARNING (spec §2.2).
 */
function resolveImported(
  bundle: Bundle,
  input: ImportedModelInput,
): { model: Model; basis: BasisItem[]; warnings: ResultWarning[] } {
  const { model: m, source } = parseInput(ImportedModelSchema, input).imported;
  const issues: string[] = [];
  for (const i of layerShapeIssues(m)) issues.push(`${i.path.join('.')}: ${i.message}`);
  const moe = moeParamsIssue(m);
  if (moe) issues.push(`moe: ${moe}`);
  for (const i of mlaLayoutIssues(m)) issues.push(`${i.field}: ${i.message}`);
  if (m.attention === 'mla' && !m.mla) issues.push("mla: attention 'mla' requires mla");
  if (m.moe && m.moe.topK > m.moe.experts) issues.push('moe.topK: topK must not exceed experts');

  const fields: [string, Model['totalParamsB']][] = [['totalParamsB', m.totalParamsB]];
  if (m.nativeQuant) fields.push(['nativeQuant.checkpointWeightBytes', m.nativeQuant.checkpointWeightBytes]);
  const mustBe = (where: string, id: string, allowBundle = false) => {
    if (id !== source.id && !(allowBundle && id in bundle.sources)) issues.push(`${where}: cites '${id}', not the supplied source '${source.id}'`);
  };
  mustBe('source', m.source);
  for (const [path, f] of fields) {
    if (f.source !== undefined) mustBe(`${path}.source`, f.source);
    for (const id of f.evidence ?? []) mustBe(`${path}.evidence`, id);
    for (const id of f.sources ?? []) mustBe(`${path}.sources`, id);
    for (const id of f.inputs ?? []) mustBe(`${path}.inputs`, id, true);
  }
  // Mirrors packages/data/src/validate.ts (secondary-source rule, spec §2.1): data depends on core, so core cannot import it.
  for (const [path, f] of fields) {
    if ((f.status === 'official' || f.status === 'measured') && f.source !== undefined && source.kind === 'secondary') {
      issues.push(`${path}: ${f.status} value cites source '${source.id}' of kind secondary (official / measured need a primary source; use unverified)`);
    }
  }
  // Mirrors validate.ts (nativeQuant): the quantization must exist and carry the native-checkpoint note for the verify command.
  if (m.nativeQuant) {
    const q = bundle.quantization[m.nativeQuant.quant];
    if (!q) issues.push(`nativeQuant.quant: unknown quantization id '${m.nativeQuant.quant}'`);
    else if (!q.vllmServe.nativeNote) issues.push(`nativeQuant.quant: quantization '${q.id}' has no vllmServe.nativeNote`);
  }
  if (issues.length > 0) throw new CoreInputError('invalid-input', `匯入的模型不合法：${issues.join('；')}`);

  const arch = {
    layers: m.layers, heads: m.heads, kvHeads: m.kvHeads, headDim: m.headDim, hidden: m.hidden, attention: m.attention,
    ...(m.mla ? { mla: m.mla } : {}),
    ...(m.moe ? { moe: m.moe } : {}),
    ...(m.layerGroups ? { layerGroups: m.layerGroups } : {}),
    ...(m.slidingWindow != null ? { slidingWindow: m.slidingWindow } : {}),
  };
  const basis: BasisItem[] = [
    fromSourced(`models.${m.id}.totalParamsB`, `${m.name} 總參數量`, m.totalParamsB, 'B3, B8'),
    {
      path: `models.${m.id}.architecture`,
      status: 'official',
      value: arch,
      sourceIds: [m.source],
      text: `${m.name} 架構（層數、注意力頭、MoE 等，取自匯入的 config.json；${source.title}）`,
    },
  ];
  return { model: m as Model, basis, warnings: [CUSTOM_MODEL_WARNING] };
}

/**
 * Refuse a model whose MoE split is impossible (expert parameters > total, or active parameters ≤ 0):
 * every timing formula would turn negative (Ruling R31d). Catalog models are checked at config build
 * and overrides by ModelOverrideSchema; this guards hand-built bundles.
 * Likewise refuse MLA combined with layerGroups / slidingWindow, which the KV math would ignore (Ruling R22).
 */
function assertModelMath(m: Model): void {
  const issue = moeParamsIssue(m);
  if (issue) throw new Error(`模型 ${m.id} 的 MoE 參數不合理，啟用參數無法為正（${issue}），無法計算`);
  const mla = mlaLayoutIssues(m);
  if (mla.length > 0) throw new Error(`模型 ${m.id} 的架構組合尚未支援（${mla.map((i) => i.message).join('；')}），無法計算`);
}

/** A model's native quantization as results report it (the UI defaults its quantization picker to `quant`). */
export type NativeQuantOut = { method: string; quant: string; checkpointWeightBytes: number };

const nativeQuantOut = (m: Model): NativeQuantOut | undefined =>
  m.nativeQuant
    ? { method: m.nativeQuant.method, quant: m.nativeQuant.quant, checkpointWeightBytes: m.nativeQuant.checkpointWeightBytes.value }
    : undefined;

/** How a requested quantization applies to one model. */
export type QuantResolution = {
  quant: Quantization;
  /** The model's checkpoint is natively in this format (`Model.nativeQuant.quant === quant.id`). */
  native: boolean;
  /**
   * The computed scenario needs a checkpoint that is not the catalog's: the model is natively quantized to
   * another format, or the format is `nativeOnly` (vLLM cannot convert to it) and the model is not in it.
   * Such results are still sized, but carry no verify command.
   */
  requiresRequantizedCheckpoint: boolean;
  /** Why a re-quantized checkpoint is needed (only with requiresRequantizedCheckpoint). */
  quantNote?: string;
};

/**
 * Resolve the quantization input for one model.
 * - `'native'` → the model's `nativeQuant.quant` when its checkpoint is natively quantized, else the quantization
 *   marked `nativeForUnquantized` in quantization.yaml (BF16: unquantized checkpoints are BF16).
 * - any other string is a quantization id.
 * A format other than the model's native one, or a `nativeOnly` format on a model not in it, sets
 * requiresRequantizedCheckpoint with a note (no runnable verify command).
 */
export function resolveQuant(bundle: Bundle, model: Model, requested: string): QuantResolution {
  let id = requested;
  if (requested === 'native') {
    const unq = Object.values(bundle.quantization).find((q) => q.nativeForUnquantized === true);
    if (!model.nativeQuant && !unq) throw new Error('設定缺少 nativeForUnquantized 的量化格式，無法解析 native');
    id = model.nativeQuant?.quant ?? unq!.id;
  }
  const quant = lookup(bundle.quantization, id, '量化');
  const nq = model.nativeQuant;
  const native = nq?.quant === quant.id;
  const repo = model.hfRepo ?? model.name;
  if (nq && !native) {
    const nativeName = bundle.quantization[nq.quant]?.name ?? nq.quant;
    return {
      quant, native, requiresRequantizedCheckpoint: true,
      quantNote: `此模型在目錄中的 checkpoint（${repo}）是原生 ${nativeName}；${quant.name} 需自行取得對應的 checkpoint，因此沒有可執行的驗證指令`,
    };
  }
  if (!nq && quant.vllmServe.nativeOnly) {
    return {
      quant, native, requiresRequantizedCheckpoint: true,
      quantNote: `計算機只估算原生的 ${quant.name} checkpoint（線上轉成 ${quant.name} 的路徑未建模，見 quantization.yaml 的 nativeOnly）；此模型的 checkpoint（${repo}）不是 ${quant.name}，需自行取得對應的 checkpoint，因此沒有可執行的驗證指令`,
    };
  }
  return { quant, native, requiresRequantizedCheckpoint: false };
}

/**
 * Weight sizing for a resolved quantization, with its basis: resident bytes and the routed-expert share of them
 * (the decode step reads non-expert bytes every step and expert bytes per expert touched; spec §5.1, §5.2).
 * - Native checkpoint: resident = `nativeQuant.checkpointWeightBytes` (exact, mixed precision included, e.g.
 *   gpt-oss attention stays BF16); expert = expert parameters × the native format's bytesPerParam (MoE experts are
 *   what the format quantizes), so the non-expert bytes are the exact remainder (review: no longer the average).
 * - Otherwise: the embedding / lm_head (vocabSize × hidden, × 2 untied) at `embeddingBytesPerParam` (vLLM keeps
 *   them 16-bit) and every other parameter at `bytesPerParam` [R-LEC B3, C1]; expert = expert parameters ×
 *   bytesPerParam. Without vocabSize (user override) every parameter is at bytesPerParam.
 */
function weightSizing(model: Model, res: QuantResolution, basis: BasisCollector): Pick<Ctx, 'bytesPerParam' | 'weights'> {
  const q = res.quant;
  const nq = model.nativeQuant;
  const bpp = q.bytesPerParam.value;
  const expertParams = model.moe ? expertParamsTotalB(model) * 1e9 : 0;
  basis.add(fromSourced(`quantization.${q.id}.bytesPerParam`, `${q.name} 每參數位元組`, q.bytesPerParam, 'B3, C1'));
  const mp = `models.${model.id}`;
  // The separate input-embedding table is read only by the rows a step looks up (Ruling R39); it stays 16-bit under
  // every format vLLM serves (embeddingBytesPerParam), native checkpoints included. Tied / no vocabSize → 0.
  const embBppItem = fromSourced(`quantization.${q.id}.embeddingBytesPerParam`, `${q.name} embedding／lm_head 每參數位元組`, q.embeddingBytesPerParam, 'B3');
  const inputEmbedding = inputEmbeddingBytes(model, q.embeddingBytesPerParam.value);
  if (inputEmbedding > 0) {
    basis.add(embBppItem, {
      path: `${mp}.inputEmbeddingBytes`,
      status: 'derived',
      value: inputEmbedding,
      sourceIds: [model.source, ...(q.embeddingBytesPerParam.source ? [q.embeddingBytesPerParam.source] : [])],
      text:
        `${model.name} 輸入 embedding 表位元組（不共用；每步只讀查到的列，lm_head 照常全讀）；推導：vocab_size × hidden × ` +
        `${q.embeddingBytesPerParam.value} = ${model.vocabSize} × ${model.hidden} × ${q.embeddingBytesPerParam.value} = ${inputEmbedding}`,
      lecRef: 'B3',
    });
  }
  const emb = inputEmbedding > 0 ? { inputEmbedding } : {};
  if (res.native && nq) {
    const resident = nq.checkpointWeightBytes.value;
    const expert = expertParams * bpp;
    basis.add(
      fromSourced(
        `${mp}.nativeQuant.checkpointWeightBytes`,
        `${model.name} 原生 ${q.name} checkpoint 權重檔大小（權重記憶體直接採用此值，含未量化的層；quant_method ${nq.method}）`,
        nq.checkpointWeightBytes,
        'B3',
      ),
    );
    // The step reads resident − expert − inputEmbedding non-expert bytes in full (weightsReadBytesSplit): they must be
    // positive, else the split (or the checkpoint size) is wrong (final-review M8).
    if (!(expert + inputEmbedding < resident)) {
      throw new Error(
        `模型 ${model.id} 的專家權重（${expert.toFixed(0)} B）加輸入 embedding（${inputEmbedding} B）不小於 checkpoint 大小（${resident} B），` +
          '非專家權重會是 0 或負數，無法拆分（請檢查 checkpointWeightBytes、MoE 設定與 vocabSize）',
      );
    }
    if (expert > 0) {
      basis.add({
        path: `${mp}.nativeQuant.expertBytes`,
        status: 'derived',
        value: expert,
        sourceIds: [nq.checkpointWeightBytes.source ?? model.source, ...(q.bytesPerParam.source ? [q.bytesPerParam.source] : [])],
        text:
          `${model.name} 專家權重位元組（MoE 每步依觸及的專家比例讀取）；推導：專家參數 × ${q.name} 每參數位元組 = ` +
          `${expertParams} × ${bpp} = ${expert.toFixed(0)}；其餘 ${(resident - expert).toFixed(0)} B（非專家層，含 BF16 的 attention 與 embedding）每步全讀`,
        lecRef: 'B3',
      });
    }
    return { bytesPerParam: bpp, weights: { resident, expert, ...emb } };
  }
  const embParams = embeddingParams(model);
  const embBpp = q.embeddingBytesPerParam.value;
  const total = model.totalParamsB.value * 1e9;
  const resident = (total - embParams) * bpp + embParams * embBpp;
  if (embParams > 0) {
    basis.add(
      embBppItem,
      {
        path: `${mp}.embeddingParams`,
        status: 'derived',
        value: embParams,
        sourceIds: [model.source],
        text:
          `${model.name} embedding／lm_head 參數；推導：vocab_size × hidden × ${model.tieWordEmbeddings === true ? '1（共用）' : '2（不共用）'} = ` +
          `${model.vocabSize} × ${model.hidden} × ${model.tieWordEmbeddings === true ? 1 : 2} = ${embParams}`,
      },
    );
  }
  return { bytesPerParam: bpp, weights: { resident, expert: expertParams * bpp, ...emb } };
}

export type Prepared = {
  ctx: Ctx;
  quant: Quantization;
  res: QuantResolution;
  basis: BasisCollector;
  /** The model's result warnings (CUSTOM_MODEL_WARNING for a user-entered model). */
  warnings: ResultWarning[];
};

/**
 * A verify command copied out on its own still carries the result's warnings, as leading comment lines.
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function withWarnings(v: { verifyCommand: string; verifyNote?: string }, warnings: ResultWarning[]): typeof v {
  if (v.verifyCommand === '' || warnings.length === 0) return v;
  return { ...v, verifyCommand: [...warnings.map((w) => `# ${w.text}`), v.verifyCommand].join('\n') };
}

/**
 * Resolve a workload (preset or preset + user overrides) and a speed standard (preset or custom) to numbers, adding
 * each used value to `basis` (user values as fromUser). Internal: shared with funnel.ts; not re-exported from index.ts.
 */
export function resolveWorkloadSpeed(
  bundle: Bundle,
  workloadInput: z.infer<typeof WorkloadInputSchema>,
  speedInput: z.infer<typeof SpeedInputSchema>,
  basis: BasisCollector,
): { kind: Bundle['workloads'][string]['kind']; workload: WorkloadIn; speed: Ctx['speed'] } {
  const wIn = typeof workloadInput === 'string' ? { base: workloadInput } : workloadInput;
  const wl = lookup(bundle.workloads, wIn.base, '負載');
  const wp = `workloads.${wl.id}`;
  const field = (
    k: 'inputTokens' | 'outputTokens' | 'cacheHitRate',
    label: string,
    lecRef?: string,
  ): number => {
    const user = wIn[k as keyof typeof wIn] as number | undefined;
    if (user !== undefined) {
      basis.add(fromUser(`${wp}.${k}`, `${wl.name} ${label}`, user, lecRef));
      return user;
    }
    basis.add(fromSourced(`${wp}.${k}`, `${wl.name} ${label}`, wl[k], lecRef));
    return wl[k].value;
  };
  const workload: WorkloadIn = {
    inputTokens: field('inputTokens', '每次讀入 token', 'A2, A5'),
    outputTokens: field('outputTokens', '每次回覆 token'),
    cacheHitRate: field('cacheHitRate', '前綴快取命中率', 'A2, A5'),
  };

  let speed: Ctx['speed'];
  if (typeof speedInput === 'string') {
    const sp = lookup(bundle.speedPresets, speedInput, '速度標準');
    basis.add(
      fromSourced(`speedPresets.${sp.id}.minTokensPerSec`, `${sp.name}：每人最低 token/s`, sp.minTokensPerSec),
      fromSourced(`speedPresets.${sp.id}.maxTtftSec`, `${sp.name}：首字最長等待`, sp.maxTtftSec, 'A2'),
    );
    speed = { minTokPerSec: sp.minTokensPerSec.value, maxTtftSec: sp.maxTtftSec.value };
  } else {
    basis.add(
      fromUser('speed.minTokPerSec', '每人最低 token/s', speedInput.minTokPerSec),
      fromUser('speed.maxTtftSec', '首字最長等待（秒）', speedInput.maxTtftSec, 'A2'),
    );
    speed = { ...speedInput };
  }
  return { kind: wl.kind, workload, speed };
}

/** Resolve quant, workload, speed and concurrency rule into a solver Ctx (model given). */
function prepareCommon(
  bundle: Bundle,
  model: Model,
  input: {
    quant: string;
    workload: z.infer<typeof WorkloadInputSchema>;
    speed: z.infer<typeof SpeedInputSchema>;
    includeComm?: boolean | undefined;
  },
  basis: BasisCollector,
): { ctx: Ctx; quant: Quantization; res: QuantResolution } {
  assertModelMath(model);
  const res = resolveQuant(bundle, model, input.quant);
  const q = res.quant;
  const sizing = weightSizing(model, res, basis);

  const { kind, workload, speed } = resolveWorkloadSpeed(bundle, input.workload, input.speed, basis);

  const cr = bundle.concurrency;
  if (kind === 'agent') {
    basis.add(
      fromSourced('concurrency.agentRule', '研究助理類人數解讀', cr.agentRule),
      fromSourced('concurrency.agentGeneratingShare', '同時在生成的比例', cr.agentGeneratingShare),
    );
  } else {
    basis.add(fromSourced('concurrency.chatRule', '對話類人數解讀', cr.chatRule));
  }

  const ctx: Ctx = {
    model,
    ...sizing,
    // Default; ctxForPlatform replaces it per platform (Ruling R32).
    kvBytesPerElem: q.kvBytesPerElem.value,
    workload,
    kind,
    speed,
    agentShare: cr.agentGeneratingShare.value,
    includeComm: input.includeComm ?? true,
  };
  return { ctx, quant: q, res };
}

/** Internal: used by performance.ts; not re-exported from index.ts. */
export function prepare(bundle: Bundle, input: z.infer<typeof QueryInputSchema>): Prepared {
  const basis = new BasisCollector();
  const rm = resolveModel(bundle, input.model);
  basis.add(...rm.basis);
  const { ctx, quant, res } = prepareCommon(bundle, rm.model, input, basis);
  return { ctx, quant, res, basis, warnings: rm.warnings };
}

/**
 * Quantization fields every result carries: the resolved id, the model's native format, re-quantization flag.
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export type QuantFields = {
  /** Quantization id actually used ('native' resolved). */
  quant: string;
  /** The model's native quantization (absent for an unquantized checkpoint); the UI defaults to it. */
  nativeQuant?: NativeQuantOut;
  /** The scenario needs a checkpoint the catalog does not list (see QuantResolution). */
  requiresRequantizedCheckpoint?: true;
  quantNote?: string;
};

/** Internal: used by performance.ts; not re-exported from index.ts. */
export function quantFields(model: Model, res: QuantResolution): QuantFields {
  const nq = nativeQuantOut(model);
  return {
    quant: res.quant.id,
    ...(nq ? { nativeQuant: nq } : {}),
    ...(res.requiresRequantizedCheckpoint ? { requiresRequantizedCheckpoint: true as const, quantNote: res.quantNote! } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Verify command
// ---------------------------------------------------------------------------------------------

/**
 * Benchmark instructions for a deployment shape (spec §3: results ship with a verify command that
 * reproduces the computed scenario).
 *
 * Signature: `verifyCommand(platform, shape, model, workload, users, opts) → string`
 * - `platform`: a resolved platform (`resolvePlatform(...).platform`); `engine` 'mlx' → mlx_lm instructions.
 * - `shape`: `{ tp, replicas }`. With several replicas the command starts and benchmarks ONE replica (GPUs pinned with
 *   CUDA_VISIBLE_DEVICES) at its share ceil(G / replicas), which is what checkShape estimated per replica; a comment
 *   says how to deploy all of them.
 * - `model`: `hfRepo` (absent → `<模型路徑>`), `nativeQuant` (natively quantized checkpoint) and `maxContext`
 *   (caps `--max-model-len`).
 * - `workload`: input / output tokens and optional cache hit rate of the benchmark.
 * - `users`: N; `opts.kind` / `opts.agentShare` turn it into generating requests (spec §8.3.3).
 * - `opts.quant`: the quantization (id, name, bytes, KV bytes, vllmServe); `opts.kvBytesPerElem`: the KV bytes
 *   actually used (engine override, Ruling R32); `opts.maxModelLenMarginTokens`: workloads.yaml
 *   `benchmark.maxModelLenMarginTokens` (default 0).
 * - Throws CoreInputError('invalid-input') (final-review M10) for a non-positive shape / users / output length, a cache
 *   hit rate outside [0, 1), and a TP outside the platform's tpOptions or above gpusPerNode, or (when `model` carries
 *   heads / kvHeads) one vLLM would refuse for it (legalTpOptions).
 * - Returns '' when nothing can be run: the model is natively quantized to another format, the format is
 *   `nativeOnly` and the model is not in it (resolveQuant: requiresRequantizedCheckpoint), or input + output
 *   exceeds the model's maxContext (review C3).
 *
 * vLLM server: `vllm serve <checkpoint> --tensor-parallel-size TP` plus
 * - native checkpoint (`model.nativeQuant.quant === quant.id`): no quantization / dtype flag, vLLM detects
 *   `quantization_config` itself (v0.32.0 vllm/config/model.py `_verify_quantization` L1440-L1442);
 *   `vllmServe.nativeNote` says so;
 * - otherwise the quantization's `vllmServe.args` from quantization.yaml (fp8 → `--quantization fp8_per_tensor`, vLLM
 *   v0.32.0 online FP8 of the BF16 checkpoint, with its note; bf16 → `--dtype bfloat16`; int4-awq →
 *   `--quantization awq`, an alias of v0.32.0 `auto_awq`). When the quantization names a `checkpoint` (AWQ: vLLM cannot quantize to
 *   AWQ online), that placeholder replaces hfRepo and its `note` is always printed with it;
 * - `vllmServe.kvCacheArgs` (fp8 → `--kv-cache-dtype fp8`, Ruling R8) when the KV bytes used are the
 *   quantization's own (no engine override);
 * - `--gpu-memory-utilization memUtil`, the calibration profile's value the capacity used (spec §5.1); pinned so
 *   the run does not depend on the version's default (0.92 in v0.32.0, 0.9 in v0.10.0);
 * - `--max-num-batched-tokens` always (the platform's value the estimate used: chunked prefill R38, queueing R36,
 *   sliding-window reserve; final-review M9), with a note when the sliding-window reserve was sized with it (spec §5.1,
 *   review L9) or the scenario queues (`opts.queueing`, Ruling R36: the measured TTFT includes the modelled wait), and
 *   `--max-num-seqs min(G_r, max_num_batched_tokens)` when the replica's share G_r exceeds the platform's vLLM default
 *   `vllmDefaults.maxNumSeqs` (above it vLLM would queue the rest; docs/research/vllm-tp-kv-precision.md §7, review
 *   L10). The cap keeps the server startable (vLLM refuses max_num_seqs > max_num_batched_tokens, v0.32.0
 *   vllm/config/scheduler.py L328-L333; final-review I1) and never binds below the modelled decode batch (R36);
 * - several replicas: the measured one on CUDA_VISIBLE_DEVICES 0..tp−1 with `--port 8000` (bench the same port), and a
 *   comment per other replica of the node (its GPUs and port) or `--data-parallel-size` for one endpoint (§8);
 * - `--max-model-len input + output + margin` (capped at the model's maxContext), the context the capacity was
 *   sized with (spec §5.1) plus the benchmark margin: the server re-tokenizes vllm bench's prompt string and, in
 *   v0.32.0, clamps max_tokens to max_model_len − prompt (vllm/entrypoints/serve/utils/api_utils.py `get_max_tokens`
 *   L169-L205; v0.10.0 rejected the request instead), which would shorten the measured output. Without the flag vLLM
 *   sizes for the model's max context (1M for some models) and may refuse to start.
 *   All four flags exist in vLLM v0.32.0 vllm/engine/arg_utils.py (`--dtype` L952, `--max-model-len` L966,
 *   `--quantization` L967, `--gpu-memory-utilization` L1356-L1361).
 * Then `vllm bench serve` with the workload's random lengths:
 * - `--max-concurrency G`: G = requests generating at once (spec §8.3.3): chat G = N users;
 *   agent G = max(1, ceil(N × agentGeneratingShare)). A comment line says which.
 * - Prefix cache (final-review I2; was one `--random-prefix-len` prefix shared by every request, which never held the
 *   idle resident sessions' KV): P = round(input × cacheHitRate) > 0 → `--dataset-name prefix_repetition` with
 *   `--prefix-repetition-prefix-len P --prefix-repetition-suffix-len (input − P) --prefix-repetition-num-prefixes R_r
 *   --prefix-repetition-output-len out --ignore-eos`, R_r = resident sessions per replica (vLLM v0.32.0
 *   vllm/benchmarks/datasets/datasets.py L1810-L1840, L4181-L4266; ignore_eos is defaulted only for the random datasets,
 *   vllm/benchmarks/serve.py L2133-L2139), so the prefix cache must hold R_r prefixes; `--num-prompts` is a multiple
 *   of R_r (each prefix gets num_prompts // R_r prompts, at least 10). Notes: run twice (the same --seed regenerates the
 *   same prefixes) and compare the second; not reproduced: the outputs of idle sessions (the bench holds P of the
 *   input + output tokens sized), and a memory shortfall shows as prefix evictions, not a refusal.
 *   P = 0: `--dataset-name random` (bench defaults ignore_eos), with a note when idle resident sessions exist.
 * - `--num-prompts max(G × 10, 100)` (random dataset).
 * MLX (Mac): the same benchmark parameters against an `mlx_lm.server` endpoint. mlx_lm.server has no
 * quantization / memory-fraction / context flags, so a note states what the estimate assumed instead.
 */
const VerifyArgsSchema = z.strictObject({
  shape: z.object({ tp: int(1e4), replicas: int(MAX_GPUS) }),
  workload: z.object({
    inputTokens: z.number().int().min(0).max(MAX_TOKENS),
    outputTokens: z.number().int().min(1).max(MAX_TOKENS),
    cacheHitRate: z.number().min(0).lt(1).optional(),
  }),
  users: usersSchema,
  opts: z.strictObject({
    kvBytesPerElem: z.number().positive().max(16).optional(),
    agentShare: z.number().min(0).max(1).optional(),
    maxModelLenMarginTokens: z.number().int().min(0).max(MAX_TOKENS).optional(),
    maxNumBatchedTokens: z.number().int().positive().max(MAX_TOKENS).optional(),
  }),
});

export function verifyCommand(
  platform: ResolvedPlatform & { engine?: 'vllm' | 'mlx'; vllmDefaults?: { maxNumSeqs: number; maxNumBatchedTokens: number; maxConcurrentBatches: number } },
  shape: Shape,
  model: Pick<Model, 'nativeQuant' | 'maxContext'> & { hfRepo?: string },
  workload: Pick<WorkloadIn, 'inputTokens' | 'outputTokens'> & { cacheHitRate?: number },
  users: number,
  opts: {
    quant: Pick<Quantization, 'id' | 'name' | 'bytesPerParam' | 'kvBytesPerElem' | 'vllmServe'>;
    /** KV bytes per element actually used (engine override, Ruling R32); default the quantization's. */
    kvBytesPerElem?: number;
    kind?: 'chat' | 'agent';
    agentShare?: number;
    /** Tokens added to --max-model-len above input + output (workloads.yaml benchmark); default 0. */
    maxModelLenMarginTokens?: number;
    /**
     * vLLM: the max_num_batched_tokens the sliding-window in-flight reserve was sized with (spec §5.1); given → pinned
     * with `--max-num-batched-tokens`, so the run does not depend on the version's default.
     */
    maxNumBatchedTokens?: number;
    /**
     * The scenario's queue (Ruling R36): given → a note that the measured TTFT includes the queueing wait the estimate
     * added, and `--max-num-batched-tokens` pinned at the budget the queue was computed with.
     */
    queueing?: Queueing | null;
  },
): string {
  // Public entry point: validate like the others (final-review M10; tp 3 or replicas 0 used to print Infinity).
  parseInput(VerifyArgsSchema, { shape, workload, users, opts: { kvBytesPerElem: opts.kvBytesPerElem, agentShare: opts.agentShare, maxModelLenMarginTokens: opts.maxModelLenMarginTokens, maxNumBatchedTokens: opts.maxNumBatchedTokens } });
  const archOf = model as Partial<Pick<Model, 'heads' | 'kvHeads' | 'layerGroups'>>;
  const legal =
    typeof archOf.heads === 'number' && typeof archOf.kvHeads === 'number'
      ? legalTpOptions(platform.tpOptions, platform.gpusPerNode, model as Model)
      : platform.tpOptions.filter((t) => t <= platform.gpusPerNode);
  if (!legal.includes(shape.tp)) {
    throw new CoreInputError(
      'invalid-input',
      `tp ${shape.tp} 不是 ${platform.id} 上這個模型的合法 TP（可用：${legal.join('／') || '無'}；需在平台的 tpOptions 內、≤ 每 node 卡數，且注意力頭與 KV 頭可整除）`,
    );
  }
  const { quant } = opts;
  const nq = model.nativeQuant;
  const native = nq?.quant === quant.id;
  // The scenario needs a checkpoint that is not published: nothing to run (resolveQuant).
  if ((nq && !native) || (!nq && quant.vllmServe.nativeOnly)) return '';
  // vLLM rejects --max-model-len above the model's max_position_embeddings: nothing to run (review C3).
  if (exceedsMaxContext(model, workload)) return '';
  const hfRepo = model.hfRepo ?? '<模型路徑>';
  const kind = opts.kind ?? 'chat';
  const share = opts.agentShare ?? 0;
  const kvElem = opts.kvBytesPerElem ?? quant.kvBytesPerElem.value;
  const memUtil = platform.replicaFor(shape.tp, 'expected').memUtil;
  const context = workload.inputTokens + workload.outputTokens;
  const margin = opts.maxModelLenMarginTokens ?? 0;
  const cap = model.maxContext;
  const maxModelLen = cap !== undefined ? Math.min(context + margin, cap) : context + margin;
  const lenNote =
    `--max-model-len ${maxModelLen} = 估算所用的上下文（輸入 ${workload.inputTokens} + 輸出 ${workload.outputTokens}）` +
    (maxModelLen > context
      ? ` + 餘裕 ${maxModelLen - context} token（伺服器會重新斷詞 vllm bench 的 prompt，長度可能略有出入）` +
        (maxModelLen < context + margin ? `，以模型最大上下文 ${cap} 為上限` : '')
      : '');
  const conc = concurrencyFor(users, kind, share);
  const g = conc.generating;
  const hit = workload.cacheHitRate ?? 0;
  const prefix = Math.round(workload.inputTokens * hit);
  // Several replicas: the estimate checks each replica on its own share ceil(G / replicas) (checkShape), so the
  // reproduction is one replica benchmarked with that share (review: one serve line, all N requests on it).
  const R = shape.replicas;
  const gRep = Math.ceil(g / R);
  const residentRep = Math.ceil(conc.resident / R);
  const suffix = workload.inputTokens - prefix;
  const minPrompts = Math.max(gRep * 10, 100);
  // A cached prefix: every resident session keeps its own (final-review I2), so the server's prefix cache must hold
  // residentRep prefixes of `prefix` tokens, the memory the estimate sized. vLLM v0.32.0 prefix_repetition
  // (vllm/benchmarks/datasets/datasets.py L1810-L1840 flags, L4181-L4266 PrefixRepetitionRandomDataset): num_prefixes
  // prefixes, num_prompts // num_prefixes prompts each (so num-prompts is a multiple), prompt = prefix + suffix, shuffled;
  // ignore_eos is defaulted only for the random datasets (vllm/benchmarks/serve.py L2133-L2139), so it is passed.
  const prefixRep = prefix > 0;
  const bench = prefixRep
    ? `--max-concurrency ${gRep} --dataset-name prefix_repetition --prefix-repetition-prefix-len ${prefix}` +
      ` --prefix-repetition-suffix-len ${suffix} --prefix-repetition-num-prefixes ${residentRep}` +
      ` --prefix-repetition-output-len ${workload.outputTokens} --ignore-eos` +
      ` --num-prompts ${residentRep * Math.max(10, Math.ceil(minPrompts / residentRep))}`
    : `--max-concurrency ${gRep} --dataset-name random` +
      ` --random-input-len ${workload.inputTokens} --random-output-len ${workload.outputTokens}` +
      ` --num-prompts ${minPrompts}`;
  const pct = ((100 * prefix) / (workload.inputTokens + workload.outputTokens)).toFixed(0);
  // With several replicas the flag carries the per-replica share, so the total is stated without the flag (final-review M13).
  const gLabel = R > 1 ? `同時在生成 ${g} ${kind === 'agent' ? '個請求' : '人'}` : `--max-concurrency ${g} = 同時在生成的${kind === 'agent' ? '請求數' : '人數'}`;
  const notes = [
    kind === 'agent'
      ? `# ${gLabel}（研究助理類：${users} 個工作階段 × 同時生成比例 ${share}，無條件進位，至少 1）`
      : `# ${gLabel}（對話類：${users} 人都在生成）`,
    ...(R > 1
      ? [
          `# 共 ${R} 個副本，每個副本分到 ${gRep} 個同時生成的請求（${g} ÷ ${R}，無條件進位），所以 --max-concurrency ${gRep}：` +
            `只需啟動並量測其中一個副本，其餘副本相同；總吞吐約為單一副本 × ${R}`,
        ]
      : []),
    ...(prefixRep
      ? [
          `# prefix_repetition：每個副本 ${residentRep} 個常駐${kind === 'agent' ? '工作階段' : '使用者'}各有一段 ${prefix} token 的固定前綴` +
            `（輸入 ${workload.inputTokens} × 快取命中率 ${hit}，四捨五入），每個請求隨機取其中一段，再接 ${suffix} token 的隨機內容；` +
            `--max-concurrency ${gRep} 個同時生成。前綴快取要同時留住 ${residentRep} 段前綴才會命中，所以會用到估算的常駐記憶體`,
          '# 暖機：同一行 bench 指令先執行一次（相同的 --seed 產生相同的前綴），讓前綴進入快取，再執行第二次，以第二次的結果比對；' +
            '第一次每段前綴的第一個請求必定未命中',
          `# 未重現：估算時每個常駐的上下文佔 輸入 + 輸出 = ${workload.inputTokens + workload.outputTokens} token 的 KV，bench 只留住前綴（${pct}%）；` +
            '記憶體不夠時 vLLM 不會拒絕，而是逐出前綴（命中率下降、TTFT 變長、吞吐下降），記憶體上限要從這些現象判斷；' +
            '工作階段是隨機挑選的，不是各自輪流生成',
        ]
      : conc.resident > g
        ? [
            `# 未重現：估算時 ${conc.resident} 個工作階段的上下文都留在記憶體，但快取命中率為 0，bench 沒有可以留住的前綴，` +
              `閒置工作階段佔用的記憶體不會出現在這次量測中（只量到同時生成的 ${gRep} 個）`,
          ]
        : []),
  ];
  if (platform.engine === 'mlx') {
    const weights = native && nq
      ? `權重為 ${quant.name}（以原生 checkpoint 大小 ${(nq.checkpointWeightBytes.value / 1e9).toFixed(1)} GB 估算，請選位元數相同的 MLX 量化版本）`
      : `權重為 ${quant.name}（每參數 ${quant.bytesPerParam.value} bytes，請選位元數相同的 MLX 量化版本）`;
    // mlx_lm.server loads MLX checkpoints only: the catalog repo (BF16, ModelOpt FP8, …) is not one, so name a placeholder
    // of the estimated bit width (final-review M11). Group-quantized formats (AWQ, MXFP4) round to their 4 bits.
    const bits = Math.round(quant.bytesPerParam.value * 8);
    const mlxRepo = `"<MLX ${bits}-bit checkpoint of ${model.hfRepo ?? '模型路徑'}>"`;
    // mlx-lm v0.32.2 server defaults the calculator departs from or depends on (mlx_lm/server.py L2025-L2047):
    // --decode-concurrency 32 caps the decode batch (the estimate decodes every generating request), --prefill-step-size
    // 2048 is the chunk the TTFT uses (pinned like vLLM's budget), --prompt-cache-size 10 entries would evict resident
    // sessions' prefixes (LRUPromptCache, mlx_lm/models/cache.py L1599).
    const decodeConc = gRep > 32 ? ` --decode-concurrency ${gRep}` : '';
    const step = platform.prefillStepTokens !== undefined ? ` --prefill-step-size ${platform.prefillStepTokens}` : '';
    const cacheSize = prefixRep && residentRep > 10 ? ` --prompt-cache-size ${residentRep}` : '';
    return [
      `# ${platform.name} ${platform.sub}：以 mlx_lm 啟動 OpenAI 相容服務（模型需為 MLX 格式），再以相同參數量測`,
      `# 請把 <MLX ${bits}-bit checkpoint of …> 換成位元數相同的 MLX 量化版本（mlx_lm.server 只能載入 MLX 格式；目錄中的 checkpoint 不是）`,
      `# mlx_lm.server 沒有量化、記憶體比例、上下文長度等啟動參數；本估算假設：${weights}、` +
        `KV cache 每元素 ${kvElem} bytes、可用記憶體 = 實體記憶體 × ${memUtil}、每個請求的上下文 ${context} token（輸入 ${workload.inputTokens} + 輸出 ${workload.outputTokens}）`,
      // mlx-lm v0.32.2 reads no ignore_eos from the request (mlx_lm/server.py L1296-L1330), so vllm bench's flag has no
      // effect (final-review M12); logit_bias is additive (mlx_lm/sample_utils.py L111-L116) and --extra-body is merged
      // into the payload (vllm/benchmarks/lib/endpoint_request_func.py L135-L136).
      '# mlx_lm.server（v0.32.2）不讀 ignore_eos：模型遇到 EOS 就會提早停止，輸出可能比指定的短，吞吐與總時間要以實際輸出 token 計；' +
        `要強制跑滿可在 bench 加 --extra-body '{"logit_bias": {"<EOS token id>": -1000}}'（填入模型的 EOS id；logit_bias 是加在 logits 上的偏移）`,
      ...(decodeConc ? [`# --decode-concurrency ${gRep}：mlx_lm.server 預設最多同時解碼 32 個請求，估算是 ${gRep} 個同時解碼`] : []),
      ...(step ? [`# --prefill-step-size ${platform.prefillStepTokens} = 估算首字時間所用的 prompt 分段大小（mlx_lm 預設值，釘住）`] : []),
      ...(cacheSize
        ? [
            `# --prompt-cache-size ${residentRep}：mlx_lm.server 預設只保留 10 份 prompt KV（LRU），每台 ${residentRep} 個常駐工作階段的前綴都要留著；` +
              `bench 隨機挑選前綴，LRU 只保留最近的 ${residentRep} 份，命中率會略低於估算`,
          ]
        : []),
      ...notes,
      `mlx_lm.server --model ${mlxRepo} --port 8080${step}${decodeConc}${cacheSize}`,
      `vllm bench serve --backend openai-chat --base-url http://127.0.0.1:8080 --endpoint /v1/chat/completions --model ${mlxRepo} ${bench}`,
    ].join('\n');
  }
  const serve = quant.vllmServe;
  // Native checkpoint: vLLM detects the format, so no args and no placeholder; else the format's args / checkpoint.
  // Without hfRepo the template is itself a placeholder: fill it with the bare words, not a second `<…>` (review M-9).
  const checkpoint =
    !native && serve.checkpoint ? serve.checkpoint.replaceAll('{hfRepo}', model.hfRepo ?? '模型路徑') : hfRepo;
  const args = native ? '' : serve.args ? ` ${serve.args.value}` : '';
  const note = native ? serve.nativeNote : serve.note;
  const kv = serve.kvCacheArgs && kvElem === quant.kvBytesPerElem.value ? ` ${serve.kvCacheArgs.value}` : '';
  const slidingMnbt = opts.maxNumBatchedTokens;
  const queueing = opts.queueing ?? null;
  // Always pinned (final-review M9): the chunked prefill (Ruling R38), the queue (R36) and the sliding-window reserve are
  // all computed with the platform's max_num_batched_tokens, so the run must not depend on the version's default.
  const mnbt = platform.maxNumBatchedTokens ?? platform.vllmDefaults?.maxNumBatchedTokens ?? slidingMnbt ?? queueing?.budget;
  const perNode = Math.max(1, Math.floor(platform.gpusPerNode / shape.tp));
  const gpus = (k: number) => Array.from({ length: shape.tp }, (_, i) => k * shape.tp + i).join(',');
  // vLLM caps the running batch at max_num_seqs (per replica / DP rank; docs/research/vllm-tp-kv-precision.md §7.1–7.4,
  // §8.1): above the platform's default the extra requests would queue, so the batch the estimate used is pinned.
  // vLLM refuses max_num_seqs > max_num_batched_tokens (v0.32.0 vllm/config/scheduler.py L328-L333), so the pin is capped
  // at the budget (final-review I1). That never binds below what the estimate decodes: more than the budget generating
  // per replica always queues (decodingMax ≤ budget × out ÷ (out + newTok) ≤ budget, Ruling R36), and the rest wait in
  // the server's queue exactly as modelled; the estimate keeps the platform's budget, which the command pins.
  const defSeqs = platform.vllmDefaults?.maxNumSeqs;
  const seqs = defSeqs !== undefined && gRep > defSeqs ? (mnbt !== undefined ? Math.min(gRep, mnbt) : gRep) : undefined;
  // Several replicas: the measured one on GPUs 0..tp-1 and port 8000; the rest of the node get their own GPUs and
  // ports (external load balancing, §8.3), or one endpoint with --data-parallel-size (internal, §8.1).
  const port = R > 1 ? ' --port 8000' : '';
  const onNode = Math.min(perNode, R);
  const replicaLines =
    R > 1
      ? [
          onNode > 1
            ? `# 完整部署（每個 node ${onNode} 個副本）：每個副本各自的 GPU 與 port，前面加負載平衡；` +
              `或改用單一 endpoint：啟動指令加 --data-parallel-size ${onNode}（vLLM 內部負載平衡；同時請求上限以每個副本計）`
            : `# 完整部署：每個 node 只放得下 1 個副本，每個 node 各自以同一行指令啟動，前面加負載平衡`,
          ...Array.from({ length: onNode - 1 }, (_, i) => `#   副本 ${i + 2}：CUDA_VISIBLE_DEVICES=${gpus(i + 1)}、--port ${8001 + i}`),
        ]
      : [];
  const lines = [
    `# ${platform.name} ${platform.sub}：每個副本 ${shape.tp} 張 GPU` +
      (R > 1
        ? `，共 ${R} 個副本。完整部署時每個 node 可放 ${perNode} 個副本，以 CUDA_VISIBLE_DEVICES 分配不同的 GPU、各用不同的 --port，前面加負載平衡`
        : ''),
    ...(note ? [`# ${note.value}`] : []),
    `# --gpu-memory-utilization ${memUtil} = 估算所用的記憶體可用比例（校正設定）；${lenNote}`,
    ...(slidingMnbt !== undefined
      ? [
          `# --max-num-batched-tokens ${slidingMnbt} = 估算 sliding window 層 KV 所用的值：vLLM 每人穩態保留 min(roundUp(上下文, bs), window + bs − 1) 個 token` +
            '（整塊配置，window 外的整塊在每個 chunk 前釋放，Ruling R37）；' +
            `進行中的 chunk（${platform.slidingInFlightTokens ?? slidingMnbt} token）每副本預留一次；啟動檢查以 1 人 cdiv(min(window − 1 + ${platform.slidingInFlightTokens ?? slidingMnbt}, max-model-len), bs) + 1 個 block 計`,
          `# --async-scheduling = 估算所假設的排程方式：進行中的 token 數 = max_concurrent_batches（async scheduling、PP = 1：${platform.vllmDefaults?.maxConcurrentBatches ?? 2}）× max_num_batched_tokens，` +
            '釘住以免結果隨版本預設而變（國網部署是否開啟待確認，GitHub issue #13）',
        ]
      : []),
    ...(queueing
      ? [
          `# 會排隊：${queueing.reason}。--max-num-batched-tokens ${queueing.budget} 為估算所用的每步上限；` +
            '量到的 TTFT 包含排隊時間（估算以封閉迴路的穩態平均計入，沒有突發，是下限；--max-concurrency 的開頭一起送出，前幾個請求會等更久）',
        ]
      : []),
    ...(mnbt !== undefined
      ? [
          `# --max-num-batched-tokens ${mnbt} = 估算所用的每步 token 上限（此平台 vLLM 的預設值；chunked prefill 每段的大小與排隊模型都依它計算，` +
            'Ruling R38、R36），釘住以免結果隨版本預設而變',
        ]
      : []),
    ...(seqs !== undefined
      ? [
          seqs < gRep
            ? `# --max-num-seqs ${seqs}：每個副本同時生成 ${gRep} 個請求，超過此平台 vLLM 的預設 ${defSeqs}；但 vLLM 要求 max_num_batched_tokens ≥ max_num_seqs` +
              `（v0.32.0 vllm/config/scheduler.py L328-L333），所以取上限 ${mnbt}。每步 token 上限本來就讓最多 ${queueing?.decodingMax ?? '不到上限'} 人同時解碼（排隊模型），` +
              '其餘在伺服器排隊，與估算相同'
            : `# --max-num-seqs ${seqs}：每個副本同時生成 ${seqs} 個請求，超過此平台 vLLM 的預設 ${defSeqs}；不加的話多出的請求會排隊，量不到估算的批次`,
        ]
      : []),
    ...notes,
    ...replicaLines,
    (R > 1 ? `CUDA_VISIBLE_DEVICES=${gpus(0)} ` : '') +
      `vllm serve ${checkpoint} --tensor-parallel-size ${shape.tp}${args}${kv}` +
      ` --gpu-memory-utilization ${memUtil} --max-model-len ${maxModelLen}` +
      (mnbt !== undefined ? ` --max-num-batched-tokens ${mnbt}` : '') +
      (slidingMnbt !== undefined ? ' --async-scheduling' : '') +
      (seqs !== undefined ? ` --max-num-seqs ${seqs}` : '') +
      port,
    `vllm bench serve${port} --model ${checkpoint} ${bench}`,
  ];
  return lines.join('\n');
}

/**
 * Verify command + note of one solved scenario (spec §5.6), shared by estimateRequirements, estimateCapacity and
 * findFeasibleModels (final-review I3):
 * - no command, only a note: the scenario needs a checkpoint the catalog lacks (requiresRequantizedCheckpoint), the
 *   context exceeds maxContext, no legal TP, or the weights fit on no shape (`where` names the GPUs searched);
 * - ok: the command for `shape` at `n` users (its queue as given);
 * - otherwise (mem / bw / compute / ttft): the largest legal TP ≤ `maxTp`, one replica, at `n` users, with its own queue
 *   evaluated (final-review M17) and a note that it is expected to fail and why (review M-8).
 * Adds the benchmark margin, the pinned max_num_batched_tokens (final-review M9) and, when pinned, the max_num_seqs
 * default to `basis`.
 *
 * Internal: used by performance.ts; not re-exported from index.ts.
 */
export function verifyFor(
  bundle: Bundle,
  ctx: Ctx,
  quant: Quantization,
  qres: QuantResolution,
  resolved: ResolvedApiPlatform,
  basis: BasisCollector,
  solved: { ok: true; shape: Shape; queueing: Queueing | null } | { ok: false; why: Why; detail: string },
  n: number,
  opts?: { maxTp?: number; where?: string },
): { verifyCommand: string; verifyNote?: string } {
  const { platform } = resolved;
  if (qres.requiresRequantizedCheckpoint) return { verifyCommand: '', verifyNote: qres.quantNote! };
  if (!solved.ok && solved.why === 'context') {
    // vLLM refuses a context beyond max_position_embeddings, so there is nothing to run (review C3).
    return { verifyCommand: '', verifyNote: `${solved.detail}，vLLM 不接受這個長度，沒有可執行的驗證指令` };
  }
  if (!solved.ok && solved.why === 'tp') {
    // vLLM accepts no TP size for this model on this platform, so there is nothing to run (review M-10).
    return { verifyCommand: '', verifyNote: `${solved.detail}，沒有可執行的驗證指令` };
  }
  if (!solved.ok && solved.why === 'scale') {
    // More GPUs (machines) than the bound: no command is generated for a deployment beyond it (final review I2).
    return { verifyCommand: '', verifyNote: `${solved.detail}，沒有產生驗證指令` };
  }
  if (!solved.ok && solved.why === 'weights') {
    // No shape holds the weights, so there is nothing to run (finding 9).
    return { verifyCommand: '', verifyNote: `模型權重放不進${opts?.where ?? '單一 node'}，沒有可執行的驗證指令（跨 node 切分尚未支援）` };
  }
  const legal = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model).filter((t) => t <= (opts?.maxTp ?? Infinity));
  const shape = solved.ok ? solved.shape : legal.length > 0 ? { tp: legal[legal.length - 1]!, replicas: 1 } : null;
  if (!shape) return { verifyCommand: '' };
  let queue = solved.ok ? solved.queueing : null;
  let verifyNote: string | undefined;
  if (!solved.ok) {
    // Weights fit but the target is missed (mem / bw / compute / ttft): the command reproduces the scenario on the
    // largest legal TP, one replica, and is expected to fail; say so and why (review M-8). Its queue at the n users
    // is evaluated too (Ruling R36), so the note and the command say the measured TTFT includes it (final-review M17).
    queue = checkShape(ctx, platform, shape, n, 'expected').queueing;
    addQueueingBasis(basis, bundle, resolved, true);
    verifyNote =
      `預期不可行：${solved.detail}。以下驗證指令在最大 TP（${shape.tp}）、1 個副本上重現此情境，` +
      '預期量測結果達不到目標或啟動失敗，可用來確認這個判斷' +
      (queue ? `；這個形狀在 ${n} 人時也會排隊（${queue.reason}）` : '');
  }
  const cmd = verifyCommand(platform, shape, ctx.model, ctx.workload, n, {
    quant,
    kvBytesPerElem: ctx.kvBytesPerElem,
    kind: ctx.kind,
    agentShare: ctx.agentShare,
    maxModelLenMarginTokens: bundle.benchmark.maxModelLenMarginTokens.value,
    queueing: queue,
    ...((platform.slidingInFlightTokens ?? 0) > 0 && hasSlidingLayers(ctx.model) && platform.vllmDefaults
      ? { maxNumBatchedTokens: platform.vllmDefaults.maxNumBatchedTokens }
      : {}),
  });
  basis.add(fromSourced('benchmark.maxModelLenMarginTokens', '驗證指令 --max-model-len 的餘裕（token）', bundle.benchmark.maxModelLenMarginTokens));
  // vLLM commands always pin max_num_batched_tokens (final-review M9): list the value pinned.
  if (platform.engine === 'vllm' && resolved.vllmDefaultsBasis) basis.add(resolved.vllmDefaultsBasis.maxNumBatchedTokens);
  // --max-num-seqs is pinned when a replica's batch exceeds the vLLM default (verifyCommand): list the default used.
  const gRep = Math.ceil(concurrencyFor(n, ctx.kind, ctx.agentShare).generating / shape.replicas);
  if (platform.vllmDefaults && gRep > platform.vllmDefaults.maxNumSeqs && resolved.vllmDefaultsBasis) {
    basis.add(resolved.vllmDefaultsBasis.maxNumSeqs);
  }
  return { verifyCommand: cmd, ...(verifyNote !== undefined ? { verifyNote } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------------------------

export type SolveOut = ReturnType<typeof solveMinGpus>;

export type PlatformResult = {
  platform: string;
  expected: SolveOut;
  conservative: SolveOut;
  /** Most users the expected shape can serve (expected eta); 0 when infeasible. */
  maxConcurrent: number;
  powerKw: number | null;
  powerNote?: string;
  /**
   * The expected shape's queue (Ruling R36): more generating requests per replica than decode within vLLM
   * max_num_batched_tokens; the rest wait W (Little's law), already in the TTFT. Null when all decode, infeasible, or no
   * budget (MLX).
   */
  queueing: Queueing | null;
  /** Usage of one replica of the expected shape at `users` (shapeUsage; spec §8.3.3 detail panel); null when infeasible. */
  usage: ShapeUsage | null;
  /** Benchmark instructions for the expected shape; '' when there is none to run (see verifyNote). */
  verifyCommand: string;
  /**
   * Why verifyCommand is empty: the scenario needs a checkpoint the catalog does not list
   * (requiresRequantizedCheckpoint), no legal TP, the weights fit on no single-node shape, the context exceeds the
   * model's maxContext, or the deployment needs more GPUs than MAX_GPUS ('scale'). Or, with a command, why it is expected to fail: the scenario is infeasible for memory /
   * speed / TTFT (review M-8).
   */
  verifyNote?: string;
  /** Every value this platform's result used (shared inputs + the platform's own); the aggregate basis is the union (review M-11). */
  basis: BasisItem[];
  /** Trust of this platform's result alone (spec §2.1). */
  hasEstimate: boolean;
  hasUser: boolean;
};

export type RequirementResult = QuantFields & {
  dataVersion: string;
  perPlatform: PlatformResult[];
  best: string | null;
  bestCriterion: 'fewest-gpus';
  /** Union of the platforms' bases (perPlatform[].basis); hasEstimate / hasUser below follow it. */
  basis: BasisItem[];
  hasEstimate: boolean;
  hasUser: boolean;
  /** Non-blocking warnings: CUSTOM_MODEL_WARNING for a user-entered model (spec §2.2); empty for a catalog model. */
  warnings: ResultWarning[];
};

/**
 * Forward estimate: for every platform, the fewest GPUs (expected and conservative eta) that
 * serve `users` at the speed target, with peak power gpus × TDP [R-LEC D1].
 * `best`: NCHC platform with a feasible expected result and the fewest GPUs; ties keep
 * platforms.yaml order.
 */
export function estimateRequirements(bundle: Bundle, raw: RequirementInput): RequirementResult {
  const input = parseInput(RequirementInputSchema, raw);
  const { ctx: baseCtx, quant, res: qres, basis, warnings } = prepare(bundle, input);
  const n = input.users;
  // Inputs every platform shares (model, quantization, workload, speed, concurrency rule).
  const common = basis.list();

  // One platform's result; `basis` here is that platform's own collector (review M-11).
  const build = (id: string, resolved: ResolvedApiPlatform, basis: BasisCollector): Omit<PlatformResult, 'basis' | 'hasEstimate' | 'hasUser'> => {
    const { platform } = resolved;
    basis.add(...resolved.basis);
    const ctx = ctxForPlatform(baseCtx, quant, resolved, basis);
    const expected = solveMinGpus(ctx, platform, n, 'expected');
    const conservative = solveMinGpus(ctx, platform, n, 'conservative');
    const res: Omit<PlatformResult, 'basis' | 'hasEstimate' | 'hasUser'> = {
      platform: id,
      expected,
      conservative,
      maxConcurrent: expected.ok ? maxConcurrent(ctx, platform, expected.shape, 'expected') : 0,
      powerKw: null,
      queueing: expected.ok ? expected.check.queueing : null,
      usage: expected.ok ? shapeUsage(ctx, platform, expected.shape, n, 'expected') : null,
      verifyCommand: '',
    };
    // The queueing model uses max_num_batched_tokens and Little's law on the expected shape (Ruling R36): list them.
    addQueueingBasis(basis, bundle, resolved, expected.ok);
    // Basis lists only values used (finding 7): TDP when power is computed (or reported unverified)
    // for a feasible result; link bandwidth / all-reduce latency when a chosen shape has tp > 1.
    Object.assign(res, powerFor(basis, resolved, expected.ok, expected.ok ? expected.gpus : 0));
    addCommBasis(basis, ctx, resolved.commBasis, [
      expected.ok ? expected.shape : null,
      conservative.ok ? conservative.shape : null,
    ]);

    const v = withWarnings(
      verifyFor(bundle, ctx, quant, qres, resolved, basis, expected.ok ? { ok: true, shape: expected.shape, queueing: res.queueing } : expected, n),
      warnings,
    );
    res.verifyCommand = v.verifyCommand;
    if (v.verifyNote !== undefined) res.verifyNote = v.verifyNote;
    return res;
  };
  const result = (id: string, resolved: ResolvedApiPlatform): PlatformResult => {
    const own = new BasisCollector().add(...common);
    const res = build(id, resolved, own);
    const list = own.list();
    basis.add(...list);
    return { ...res, basis: list, ...trustFlags(list) };
  };
  // Catalog platforms first, then the user's own (spec 2026-10-21 §5.3), through the same build.
  const perPlatform: PlatformResult[] = [
    ...Object.keys(bundle.platforms).map((id) => result(id, resolvePlatform(bundle, id, quant.computeDtype))),
    ...(input.customPlatforms ?? []).map((cp, i) => result(`custom:${i}`, resolveCustomPlatform(bundle, cp, quant.computeDtype, `custom:${i}`))),
  ];

  let best: { id: string; gpus: number } | null = null;
  for (const r of perPlatform) {
    // Only NCHC catalog platforms compete; custom platforms (group self, not in the bundle) never do.
    if (bundle.platforms[r.platform]?.group !== 'nchc' || !r.expected.ok) continue;
    if (!best || r.expected.gpus < best.gpus) best = { id: r.platform, gpus: r.expected.gpus };
  }

  const list = basis.list();
  return {
    ...quantFields(baseCtx.model, qres),
    dataVersion: bundle.meta.dataVersion,
    perPlatform,
    best: best?.id ?? null,
    bestCriterion: 'fewest-gpus',
    basis: list,
    ...trustFlags(list),
    warnings,
  };
}

/** Speed curve of a shape (spec §5.5: per-user speed between 1 and the capacity; final-review I3). */
export type SpeedCurve = { shape: Shape; points: SpeedPoint[] };

/** The capacity outputs spec §5.5 / §9 require, shared by estimateCapacity and findFeasibleModels (final-review I3). */
export type CapacityProfile = {
  /**
   * What one more user would break (checkShape at n + 1: 'mem' | 'bw' | 'compute' | 'ttft'); when nobody fits, the
   * reason (same as `why`); null when the capacity saturates the search (`saturated`).
   */
  bottleneck: Why | null;
  /** Users the KV memory alone allows (speed and TTFT targets off), on the reported shape (see each function). */
  memoryOnlyMax: number;
  /** Per-user / aggregate speed and TTFT at SPEED_CURVE_POINTS users in [1, capacity]; null when nobody fits. */
  speedCurve: SpeedCurve | null;
  /** Benchmark instructions (spec §5.6); '' when none can run (see verifyNote). */
  verifyCommand: string;
  /** Why verifyCommand is empty, or why it is expected to fail (as PlatformResult.verifyNote). */
  verifyNote?: string;
};

export type CapacityResult = QuantFields &
  CapacityProfile & {
    dataVersion: string;
    expected: { n: number; shape: Shape | null };
    conservative: { n: number; shape: Shape | null };
    /** Queue of the expected shape at its n users (Ruling R36); null when all decode, no shape, or MLX. */
    queueing: Queueing | null;
    /** Usage of one replica of the expected shape at expected.n users (shapeUsage; spec §8.3.3); null when n = 0. */
    usage: ShapeUsage | null;
    /** Why the expected capacity is 0 ('context' | 'tp' | 'weights' | 'mem' | 'bw' | 'compute' | 'ttft' | 'scale'); null when n > 0. */
    why: Why | null;
    /** Text of `why`. */
    detail?: string;
    /** The expected capacity reached the search cap (1e7 users): the true capacity is at least that (final-review M15). */
    saturated?: true;
    saturatedNote?: string;
    /** The split of the GPUs `memoryOnlyMax` uses (best split with speed targets off); null when nobody fits. */
    memoryOnlyShape: Shape | null;
    basis: BasisItem[];
    hasEstimate: boolean;
    hasUser: boolean;
    /** As RequirementResult.warnings. */
    warnings: ResultWarning[];
  };

/**
 * Reverse estimate (spec §5.5, §9): the most users `gpus` GPUs (machines for Mac) of `platform` can serve, with the
 * best split into replicas, for expected and conservative eta; plus (final-review I3) why it is 0, the bottleneck at
 * the limit, the memory-only limit (best split of the same GPUs, speed targets off), the speed curve up to the capacity
 * on the expected shape, and its verify command (expected shape at n users; when n = 0 the largest legal TP within the
 * GPUs at 1 user, expected to fail, as estimateRequirements does). A capacity at the 1e7 search cap is flagged
 * `saturated` (at least that many; final-review M15).
 */
export function estimateCapacity(bundle: Bundle, raw: CapacityInput): CapacityResult {
  const input = parseInput(CapacityInputSchema, raw);
  const { ctx: baseCtx, quant, res: qres, basis, warnings } = prepare(bundle, input);
  const resolved = resolvePlatform(bundle, input.platform, quant.computeDtype);
  const { platform } = resolved;
  basis.add(...resolved.basis);
  const ctx = ctxForPlatform(baseCtx, quant, resolved, basis);
  const expected = maxConcurrentForGpus(ctx, platform, input.gpus, 'expected');
  const conservative = maxConcurrentForGpus(ctx, platform, input.gpus, 'conservative');
  addCommBasis(basis, ctx, resolved.commBasis, [expected.shape, conservative.shape]);
  const queueing = expected.shape ? checkShape(ctx, platform, expected.shape, expected.n, 'expected').queueing : null;
  addQueueingBasis(basis, bundle, resolved, expected.shape !== null);

  // Memory-only limit: the best split of the same GPUs with the speed targets off.
  let memoryOnly: { n: number; shape: Shape | null } = { n: 0, shape: null };
  for (const t of legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model)) {
    const replicas = Math.floor(input.gpus / t);
    if (replicas < 1) continue;
    const m = shapeProfile(ctx, platform, { tp: t, replicas }, 0, 'expected').memoryOnlyMax;
    if (m > memoryOnly.n) memoryOnly = { n: m, shape: { tp: t, replicas } };
  }
  const unit = platform.unit === 'machine' ? '台' : '張 GPU';
  let profile: Pick<CapacityProfile, 'bottleneck' | 'speedCurve'>;
  let why: { why: Why; detail: string } | null = null;
  let v: { verifyCommand: string; verifyNote?: string };
  if (expected.shape && expected.n > 0) {
    const p = shapeProfile(ctx, platform, expected.shape, expected.n, 'expected');
    profile = { bottleneck: p.bottleneck, speedCurve: p.speedCurve };
    v = withWarnings(verifyFor(bundle, ctx, quant, qres, resolved, basis, { ok: true, shape: expected.shape, queueing }, expected.n), warnings);
  } else {
    why = capacityWhy(ctx, platform, input.gpus, 'expected') ?? { why: 'mem', detail: `${input.gpus} ${unit}放不下 1 人` };
    profile = { bottleneck: why.why, speedCurve: null };
    v = withWarnings(
      verifyFor(bundle, ctx, quant, qres, resolved, basis, { ok: false, ...why }, 1, {
        maxTp: input.gpus,
        where: `${input.gpus} ${unit}`,
      }),
      warnings,
    );
  }
  const saturated = expected.n >= MAX_N;
  const list = basis.list();
  return {
    ...quantFields(ctx.model, qres),
    dataVersion: bundle.meta.dataVersion,
    expected,
    conservative,
    queueing,
    usage: expected.shape && expected.n > 0 ? shapeUsage(ctx, platform, expected.shape, expected.n, 'expected') : null,
    why: why?.why ?? null,
    ...(why ? { detail: why.detail } : {}),
    ...profile,
    memoryOnlyMax: memoryOnly.n,
    memoryOnlyShape: memoryOnly.shape,
    ...(saturated
      ? {
          saturated: true as const,
          saturatedNote: `可服務人數達到搜尋上限 ${MAX_N.toLocaleString('en-US')} 人，實際至少有這麼多（沒有再往上搜尋）`,
        }
      : {}),
    ...v,
    basis: list,
    ...trustFlags(list),
    warnings,
  };
}

export type FeasibleModel = QuantFields &
  Partial<Pick<CapacityProfile, 'memoryOnlyMax' | 'speedCurve'>> & {
    model: string;
    feasible: boolean;
    /** Fewest GPUs (machines) needed, when a deployment exists at all. */
    gpus?: number;
    /**
     * Why not feasible within the GPUs given (final-review I3; the text moved to `detail`): the solver's reason
     * ('context' | 'tp' | 'weights' | 'mem' | 'bw' | 'compute' | 'ttft' | 'scale') when no deployment exists; when one exists but
     * needs more GPUs, the reason the best split of the GPUs given fails for `users`.
     */
    why?: Why;
    detail?: string;
    /** Most users the fewest-GPU shape serves (expected eta), when one exists. */
    maxConcurrent?: number;
    /** What one more user than maxConcurrent breaks on that shape; when no deployment exists, `why`. */
    bottleneck: Why | null;
    /** Queue of the fewest-GPU shape (Ruling R36), as estimateRequirements reports it; null when none. */
    queueing: Queueing | null;
    /** Verify command of the fewest-GPU shape at `users` (as estimateRequirements), or the expected-to-fail fallback. */
    verifyCommand: string;
    verifyNote?: string;
    /** Every value this model × quantization result used (spec §10.1), as estimateRequirements returns. */
    basis: BasisItem[];
    /** Trust follows the weakest input (spec §2.1): any estimate / user value in the basis. */
    hasEstimate: boolean;
    hasUser: boolean;
  };

/**
 * Quantization ids the UI offers for a catalog model: [nativeQuant.quant] for a natively quantized checkpoint, else
 * every quantization without vllmServe.nativeOnly (bundle order), i.e. the formats vLLM can apply to an unquantized
 * checkpoint. The rule findFeasibleModels evaluates when `quant` is omitted. Unknown model → CoreInputError 'unknown-id'.
 */
export function quantOptions(bundle: Bundle, modelId: string): string[] {
  return quantOptionsFor(bundle, lookup(bundle.models, modelId, '模型'));
}

/** quantOptions for a model object (catalog or imported), by the same rule. */
export function quantOptionsFor(bundle: Bundle, model: Model): string[] {
  if (model.nativeQuant) return [model.nativeQuant.quant];
  return Object.values(bundle.quantization).filter((q) => !q.vllmServe.nativeOnly).map((q) => q.id);
}

/**
 * Catalog search: which model × quantization pairs serve `users` (default 1) at the speed
 * target within `gpus` GPUs of `platform` (expected eta), over every catalog model (the catalog is checked against
 * `policy` at data:build, spec §2.2).
 * Quantizations evaluated per model: `quant` given → that one (`'native'` resolves per model); omitted → the
 * model's native format when its checkpoint is natively quantized, else every format vLLM can apply to an
 * unquantized checkpoint (not `nativeOnly`).
 * Each item (final-review I3): why / detail, bottleneck, and for a deployment that exists its maxConcurrent,
 * memory-only limit and speed curve on the fewest-GPU shape, plus that shape's verify command (estimateRequirements'
 * rules). Computed eagerly: the whole catalog on one platform takes well under a second.
 */
export function findFeasibleModels(bundle: Bundle, raw: FeasibleInput): FeasibleModel[] {
  const input = parseInput(FeasibleInputSchema, raw);
  const n = input.users ?? 1;
  if (input.quant !== undefined && input.quant !== 'native') lookup(bundle.quantization, input.quant, '量化');
  lookup(bundle.platforms, input.platform, '平台');
  const unitWord = bundle.platforms[input.platform]!.unit === 'machine' ? '台' : '張 GPU';

  const out: FeasibleModel[] = [];
  for (const m of Object.values(bundle.models)) {
    const ids = input.quant !== undefined ? [input.quant] : quantOptions(bundle, m.id);
    for (const id of ids) {
      const basis = new BasisCollector();
      basis.add(...resolveModel(bundle, m.id).basis);
      const { ctx: baseCtx, quant: q, res } = prepareCommon(bundle, m, { ...input, quant: id }, basis);
      const resolved = resolvePlatform(bundle, input.platform, q.computeDtype);
      const { platform } = resolved;
      basis.add(...resolved.basis);
      const ctx = ctxForPlatform(baseCtx, q, resolved, basis);
      const s = solveMinGpus(ctx, platform, n, 'expected');
      addCommBasis(basis, ctx, resolved.commBasis, [s.ok ? s.shape : null]);
      addQueueingBasis(basis, bundle, resolved, s.ok);
      const v = verifyFor(bundle, ctx, q, res, resolved, basis, s.ok ? { ok: true, shape: s.shape, queueing: s.check.queueing } : s, n);
      const item: Omit<FeasibleModel, 'basis' | 'hasEstimate' | 'hasUser'> = {
        model: m.id,
        ...quantFields(m, res),
        feasible: false,
        bottleneck: null,
        queueing: s.ok ? s.check.queueing : null,
        ...v,
      };
      if (!s.ok) {
        item.why = s.why;
        item.detail = s.detail;
        item.bottleneck = s.why;
      } else {
        item.gpus = s.gpus;
        const maxN = maxConcurrent(ctx, platform, s.shape, 'expected');
        const p = shapeProfile(ctx, platform, s.shape, maxN, 'expected');
        item.maxConcurrent = maxN;
        item.bottleneck = p.bottleneck;
        item.memoryOnlyMax = p.memoryOnlyMax;
        item.speedCurve = p.speedCurve;
        if (s.gpus <= input.gpus) item.feasible = true;
        else {
          // Why the GPUs given fall short: the best split of them at `users` (or why one user does not fit there).
          const atBudget = maxConcurrentForGpus(ctx, platform, input.gpus, 'expected');
          item.why = atBudget.shape
            ? (checkShape(ctx, platform, atBudget.shape, n, 'expected').why ?? 'mem')
            : (capacityWhy(ctx, platform, input.gpus, 'expected')?.why ?? 'weights');
          item.detail =
            `需要 ${s.gpus} ${unitWord}，超過現有的 ${input.gpus} ${unitWord}` +
            (atBudget.shape ? `（現有的 ${input.gpus} ${unitWord}最多服務 ${atBudget.n} 人）` : '');
        }
      }
      const list = basis.list();
      out.push({ ...item, basis: list, ...trustFlags(list) });
    }
  }
  return out;
}

/**
 * Stateless explanation (spec §10.1): recompute from the same input and return every value
 * used (basis) plus the formulas with their lecture references. With `platform` and `gpus`
 * the capacity path is explained, otherwise the requirement path (needs `users`).
 */
export function explain(bundle: Bundle, raw: ExplainInput): { basis: BasisItem[]; formulas: string[]; warnings: ResultWarning[] } {
  // Which path is meant decides the message (final-review M16): the union's own issues name neither.
  if (raw && typeof raw === 'object') {
    const has = (k: string) => Object.hasOwn(raw, k) && (raw as Record<string, unknown>)[k] !== undefined;
    if (has('platform') && !has('gpus')) {
      throw new CoreInputError('invalid-input', '輸入不合法：explain 的容量路徑需要 platform 與 gpus 一起給；需求路徑請給 users、不要給 platform');
    }
    if (has('platform') && has('users')) {
      throw new CoreInputError('invalid-input', '輸入不合法：explain 的容量路徑（platform + gpus）不接受 users（人數是容量的答案）；需求路徑請只給 users');
    }
  }
  const input = parseInput(ExplainInputSchema, raw);
  const capacity = 'platform' in input;
  let basis: BasisItem[];
  let queued: Array<{ platform: string; q: Queueing }>;
  if (capacity) {
    const c = estimateCapacity(bundle, input);
    basis = c.basis;
    queued = c.queueing ? [{ platform: input.platform, q: c.queueing }] : [];
  } else {
    const r = estimateRequirements(bundle, input);
    basis = r.basis;
    queued = r.perPlatform.flatMap((p) => (p.queueing ? [{ platform: p.platform, q: p.queueing }] : []));
  }
  const { ctx, res, warnings } = prepare(bundle, input);

  const formulas = [
    res.native
      ? '權重記憶體 = 原生量化 checkpoint 的權重檔大小（實際值，含未量化的層）；MoE 每步權重讀取量 = 非專家權重（檔案大小 − 專家參數 × 原生格式每參數位元組）+ 專家權重 × 觸及比例（spec §5.1, §5.2）'
      : '權重記憶體 = （總參數 − embedding／lm_head 參數）× 每參數位元組 + embedding／lm_head 參數 × 16-bit 位元組（spec §5.1；權重容量講義未涵蓋，低精度降低讀取量見 [R-LEC C1]）',
    'decode 單步時間 = max((權重讀取位元組 + B × 每序列 KV 位元組) ÷ (頻寬 × η_bw), (decode + 預填干擾 FLOPs) ÷ (峰值 × η_compute)) [R-LEC B1, B3, A4, C1, B8] + 通訊時間 [R-LEC F3, G1]（spec §5.4）+ t_fixed [R-LEC G2]（spec §5.2）；η_bw 為計算機補充（講義無對應項）',
    '每人速度 = 1 ÷ decode 單步時間，總吞吐 = B ÷ decode 單步時間（穩態連續批次、已知 B）[R-LEC A1, A3]',
    '權重每步只讀一次、由整批共用 [R-LEC B3, B9]，跨步不留在晶片內 [R-LEC B6]；MoE 只讀被選中專家的期望比例 f(T) = 1 − (1 − topK/experts)^T；vLLM 的 prefill 以整個 chunk = min(未快取 token, max_num_batched_tokens − B)（B 個 decode token 先排，Ruling R38）出現在 p = min(1, 平均每步 prefill token ÷ chunk) 的步數，所以取 p × f(B + chunk) + (1 − p) × f(B)（f 是凹函數，不能代平均值）；MLX 的 prefill 是另一次 forward（每段 ≤ prefill_step_size），decode 只觸及 f(B)，prefill pass 另讀它的 token 觸及的專家（最終審查 M5）（spec §5.2、§5.3，講義未涵蓋）',
    'TTFT = 排隊時間 W（vLLM 每步 token 上限，見下；沒有排隊時為 0）+ Σ_段 [max(段 FLOPs ÷ (峰值 × η_compute), 段位元組 ÷ (頻寬 × η_bw)) + 段 TP 通訊 + t_fixed] + t_request（每個請求一次的首字固定開銷 ttftOverheadSec，Ruling R41）。' +
      '未快取 token = 輸入 × (1 − 快取命中率)，分成 ceil(未快取 token ÷ chunk) 段（vLLM：chunk = max_num_batched_tokens − (D − 1)；MLX：prefill_step_size；Ruling R38）；段 FLOPs = 段 token × (2 × 線性層參數 + 段平均位置的注意力 FLOPs)，最後一段另加 2 × lm_head 參數；' +
      '段位元組 = 權重重讀一次（MoE：段 token 觸及的專家）+ 到段結尾的 KV；段 TP 通訊 = 2 × 層數 次 all-reduce，訊息 = 段 token × hidden × 2 bytes。負載下（D ≥ 2）vLLM 每段至少 t_step(D)（與 decode 同一步），MLX 每段另加一次其他人的 decode forward（最終審查 M6）。' +
      '線性層參數 = 啟用參數 − embedding／lm_head [R-LEC A2, A5, B1, B6, B7, B8, B9, F3]（通訊 spec §5.4）',
    '每副本可服務人數 = floor((記憶體 × memUtil − 權重位元組 − 進行中 chunk 的預留) ÷ 每序列 KV 位元組(上下文 = 輸入 + 輸出))。KV 以整塊配置（Ruling R37）：vLLM 的 full／MLA 層每人 roundUp(上下文, bs) 個 token，sliding window 層穩態 min(roundUp(上下文, bs), window + bs − 1)（bs = block_size；MLA 依 backend）；' +
      'MLX 的 KVCache 每次擴充 256 個 token：full 層 roundUp(上下文, 256)，sliding 層 min(roundUp(上下文, 256), window)。vLLM 另在每副本預留一次 min(max_concurrent_batches × max_num_batched_tokens, 上下文) 個 token 的 sliding 層 KV（進行中的 chunk），' +
      '並在 1 人的上限（full 層 cdiv(上下文, bs) 個 block；sliding 層 cdiv(min(window − 1 + 進行中 token, 上下文), bs) + 1 個 block）放不下時拒絕啟動；MLX 沒有預留（spec §5.1）',
    'KV cache 每元素位元組：平台的推論引擎有固定值時用它（MLX = 2，fp16／bf16），否則用量化格式的值（Ruling R32）',
    '峰值算力一律採 dense 值，不用 with sparsity 標示值 [R-LEC C2]',
    ctx.kind === 'agent'
      ? '研究助理類：佔用記憶體的工作階段 = N，同時生成 = max(1, ceil(N × 同時生成比例))（spec §8.3.3）'
      : '對話類：同時生成 = 佔用記憶體 = N（spec §8.3.3）',
    '配置：每副本 t ∈ 合法 TP（t ≤ 每 node 卡數、注意力頭可整除），GPU 總數 = 副本數 × t，取最少者（spec §10.2）',
  ];
  if (ctx.includeComm !== false) {
    formulas.push('通訊時間 = 2 × 層數 × (all-reduce 延遲 + 2(p − 1)/p × 本步 token 數 × hidden × 2 bytes ÷ 單向 NVLink 頻寬)，p = TP；本步 token 數 = B + 預填干擾 token [R-LEC F3]（spec §5.4）');
  }
  formulas.push(
    "排隊（vLLM）：每副本 B 個生成中的請求，D 人同時解碼時每步需要 D × (1 + 未快取 token ÷ 輸出) 個 token，每步上限 max_num_batched_tokens，所以最多 D_max = max(1, floor(上限 × 輸出 ÷ (輸出 + 未快取 token))) 人同時解碼；B > D_max 時其餘 B − D_max 人排隊，Little's law：λ = D_max ÷ (輸出 × t_step(D_max))，W = (B − D_max) ÷ λ；TTFT = 預填時間 + W，每人速度 = 1 ÷ t_step(D_max)。封閉迴路、確定性流體近似，W 是下限；MLX 沒有這個上限（Ruling R36，spec §5.2；Little 1961；docs/research/vllm-tp-kv-precision.md §7.5）",
    ...queued.map(({ platform, q }) => `${platform} 會排隊：${q.reason}`),
  );
  if (!capacity) formulas.push('峰值功耗 = GPU 數 × TDP（上限，不是實際耗電；TDP 未查證時不計算）[R-LEC D1]');
  return { basis, formulas, warnings };
}

// ---------------------------------------------------------------------------------------------
// Measurement prediction (calibration, spec §10.1)
// ---------------------------------------------------------------------------------------------

const PredictInputSchema = z
  .strictObject({
    platform: z.string().min(1),
    model: z.string().min(1),
    quant: z.string().min(1),
    /** The benchmark's own conditions (not a workload preset). */
    workload: z
      .strictObject({
        inputTokens: z.number().int().min(0).max(MAX_TOKENS),
        outputTokens: z.number().int().min(1).max(MAX_TOKENS),
        cacheHitRate: z.number().min(0).lt(1),
      })
      .strict(),
    /** Concurrent requests in the benchmark; all generating and resident (chat rule). */
    concurrency: usersSchema,
    /**
     * The benchmark's tensor-parallel size (one replica of tp GPUs). Absent → the smallest legal TP whose weights fit.
     * Must be a TP vLLM accepts for this model on this platform (legalTpOptions), else CoreInputError.
     */
    tp: z.number().int().positive().optional(),
    eta: z.enum(['expected', 'conservative']).optional(),
  })
  .strict();
export type PredictInput = z.input<typeof PredictInputSchema>;

export type MeasurementPrediction = QuantFields & {
  dataVersion: string;
  /** The benchmark's tp (or, without one, the smallest legal TP whose weights fit), one replica; null when the weights do not fit. */
  shape: Shape | null;
  /** Per-request decode tok/s at batch = concurrency, as the calculator reports it (incl. the other
   *  concurrency − 1 users' prefill interference, Ruling R29; none at concurrency 1). Above vLLM's per-step budget only
   *  decodingMax decode, at that batch's speed (Ruling R36). */
  decodeTokPerSec: number | null;
  /** Prefill TTFT + the queueing wait (Ruling R36; 0 within the budget), as a benchmark's TTFT measures it. */
  ttftSec: number | null;
  /** Memory-only capacity of that one replica (speed targets not applied). */
  maxConcurrent: number | null;
  bound: 'bw' | 'compute' | null;
  /**
   * checkShape reason with speed targets off: 'tp' (no legal TP), 'weights' (no shape fits), 'mem' (KV for
   * `concurrency` does not fit), 'context' (input + output above maxContext: every prediction null, final-review M14),
   * or null.
   */
  why: Why | null;
  step: { bwSec: number; computeSec: number; commSec: number; stepSec: number } | null;
  basis: BasisItem[];
  hasEstimate: boolean;
  hasUser: boolean;
};

/**
 * What the calculator predicts for one published benchmark run (calibration points, spec §10.1):
 * catalog model × quantization on a platform, at the benchmark's own input/output lengths, cache hit
 * rate and concurrency. Uses the same `checkShape` path as the solver (decodeStep [R-LEC B1, B3, A4, C1, B8],
 * ttftSec [R-LEC A2, A5, B1, B7, B9], memory spec §5.1) on one replica of the benchmark's `tp` (or, without one, the
 * smallest legal TP whose weights fit). Closed loop at B = concurrency, so above vLLM's per-step budget only
 * decodingMax decode and the TTFT carries the Little's-law wait (Ruling R36).
 * Speed targets are not applied. Chat interpretation: generating = resident = concurrency (spec §8.3.3).
 */
export function predictMeasurement(bundle: Bundle, raw: PredictInput): MeasurementPrediction {
  const input = parseInput(PredictInputSchema, raw);
  const basis = new BasisCollector();
  const rm = resolveModel(bundle, input.model);
  assertModelMath(rm.model);
  basis.add(...rm.basis);
  const qres = resolveQuant(bundle, rm.model, input.quant);
  const q = qres.quant;
  const sizing = weightSizing(rm.model, qres, basis);
  const resolved = resolvePlatform(bundle, input.platform, q.computeDtype);
  const { platform } = resolved;
  basis.add(...resolved.basis);

  const baseCtx: Ctx = {
    model: rm.model,
    ...sizing,
    kvBytesPerElem: q.kvBytesPerElem.value,
    workload: { ...input.workload },
    kind: 'chat',
    speed: { minTokPerSec: 0, maxTtftSec: Number.POSITIVE_INFINITY },
    agentShare: bundle.concurrency.agentGeneratingShare.value,
    includeComm: true,
  };
  const ctx = ctxForPlatform(baseCtx, q, resolved, basis);
  const eta = input.eta ?? 'expected';
  const legal = legalTpOptions(platform.tpOptions, platform.gpusPerNode, ctx.model);
  if (input.tp !== undefined && !legal.includes(input.tp)) {
    throw new CoreInputError(
      'invalid-input',
      `tp ${input.tp} 不是 ${platform.id} 上 ${rm.model.id} 的合法 TP（可用：${legal.join('／') || '無'}；需在平台的 tpOptions 內、≤ 每 node 卡數，且注意力頭與 KV 頭可整除）`,
    );
  }
  const tps = input.tp !== undefined ? [input.tp] : legal;
  const chosen = tps
    .map((tp) => ({ shape: { tp, replicas: 1 }, c: checkShape(ctx, platform, { tp, replicas: 1 }, input.concurrency, eta) }))
    .find((x) => x.c.why !== 'weights');
  addCommBasis(basis, ctx, resolved.commBasis, [chosen?.shape]);
  // The decode step and TTFT went through the queueing model (Ruling R36) at the benchmark's concurrency.
  addQueueingBasis(basis, bundle, resolved, chosen !== undefined);
  const list = basis.list();
  const out: MeasurementPrediction = {
    ...quantFields(rm.model, qres),
    dataVersion: bundle.meta.dataVersion,
    shape: null,
    decodeTokPerSec: null,
    ttftSec: null,
    maxConcurrent: null,
    bound: null,
    why: tps.length === 0 ? 'tp' : 'weights',
    step: null,
    basis: list,
    ...trustFlags(list),
  };
  // vLLM refuses a context beyond max_position_embeddings: no run, so no numbers (final-review M14).
  if (exceedsMaxContext(rm.model, input.workload)) return { ...out, why: 'context' };
  if (chosen) {
    const { shape, c } = chosen;
    const { bwSec, computeSec, commSec, stepSec } = c.step;
    return {
      ...out,
      shape,
      decodeTokPerSec: c.tokPerSecPerUser,
      ttftSec: c.ttftSec,
      maxConcurrent: c.capacityPerReplica,
      bound: bwSec >= computeSec ? 'bw' : 'compute',
      why: c.why,
      step: { bwSec, computeSec, commSec, stepSec },
    };
  }
  return out;
}
