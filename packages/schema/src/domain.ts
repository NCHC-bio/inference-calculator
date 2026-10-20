import { z } from 'zod';
import { sourced } from './provenance';

const id = z.string().min(1);
const posNum = sourced(z.number().positive());
const posInt = z.number().int().positive();
const unitFrac = sourced(z.number().min(0).max(1));
/** Efficiency / utilisation fraction: strictly positive, at most 1. */
const posFrac = sourced(z.number().gt(0).max(1));

export const HardwareSchema = z.strictObject({
  id,
  name: z.string().min(1),
  memGB: posNum,
  memBwTBs: posNum,
  /** Always dense values; Mac fills only `effective`. */
  tflops: z.strictObject({
    fp8: posNum.optional(),
    bf16: posNum.optional(),
    effective: posNum.optional(),
  }),
  tdpW: sourced(z.number().positive().nullable()),
  nvlinkBidirGBs: posNum.optional(),
});
export type Hardware = z.infer<typeof HardwareSchema>;

export const TpOptionSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]);

export const PlatformSchema = z.strictObject({
  id,
  name: z.string().min(1),
  sub: z.string(),
  group: z.enum(['nchc', 'self']),
  unit: z.enum(['gpu', 'machine']),
  hardware: id,
  /** Positive integer; every tpOptions value must be ≤ it (validator; multi-node TP is out of scope). */
  gpusPerNode: sourced(posInt),
  nodes: posNum.optional(),
  tpOptions: z.array(TpOptionSchema).min(1),
  calibration: id,
  scheduling: z.string().optional(),
  /** Overrides the calibration profile's allreduce latency for this platform. */
  allreduceLatencyUs: posNum.optional(),
  /**
   * vLLM's API-server defaults on this GPU (they depend on its memory; vLLM v0.32.0 engine/arg_utils.py). Required
   * when the platform's calibration profile has engine vllm, refused for mlx (validator). maxConcurrentBatches ×
   * maxNumBatchedTokens = max_in_flight_tokens, the chunked-prefill tokens sliding-window layers hold beyond the window
   * (spec §5.1; vllm/config/vllm.py); maxNumSeqs caps the running batch, so the verify command pins it when exceeded.
   * kvBlockSize: the KV block_size (tokens) vLLM resolves for standard attention on this GPU (v0.32.0
   * `CacheConfig.DEFAULT_BLOCK_SIZE` 16, kept when the default backend accepts it); mlaKvBlockSize: the block size of
   * the MLA backend vLLM picks on this GPU for an FP8 (1-byte) or a 16-bit KV cache (spec §5.1 KV allocation).
   */
  vllmDefaults: z
    .strictObject({
      maxNumSeqs: sourced(posInt),
      maxNumBatchedTokens: sourced(posInt),
      maxConcurrentBatches: sourced(posInt),
      kvBlockSize: sourced(posInt),
      /**
       * qkNopeHeadDims / otherwise (final-review M26): the first MLA backend in vLLM's priority accepts only these
       * qk_nope_head_dim values (FlashInfer MLA on SM100: {64, 128, 192}); a model outside them gets the next backend
       * that accepts it, whose block sizes are `otherwise`. Both or neither.
       */
      mlaKvBlockSize: z
        .strictObject({
          fp8Kv: sourced(posInt),
          bf16Kv: sourced(posInt),
          qkNopeHeadDims: z.array(posInt).min(1).optional(),
          otherwise: z.strictObject({ fp8Kv: sourced(posInt), bf16Kv: sourced(posInt) }).optional(),
        })
        .superRefine((b, ctx) => {
          if ((b.qkNopeHeadDims === undefined) !== (b.otherwise === undefined)) {
            ctx.addIssue({ code: 'custom', path: ['otherwise'], message: 'qkNopeHeadDims and otherwise go together' });
          }
        }),
    })
    .optional(),
});
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * How the verify command starts vLLM for a quantization (spec §3: the command must reproduce the
 * computed scenario). Flags and notes are data, not core constants; every factual claim printed with the
 * command is a sourced string (review 7b).
 */
export const VllmServeSchema = z
  .strictObject({
    /**
     * Flags appended to `vllm serve <checkpoint>` when the quantization is applied to a checkpoint that is
     * not already in it, e.g. `--quantization fp8`; sourced from the vLLM docs. Exactly one of `args` /
     * `nativeOnly` is set.
     */
    args: sourced(z.string().min(1)).optional(),
    /**
     * vLLM can only load this format from a checkpoint that is already quantized to it (no online
     * conversion), e.g. MXFP4. Any other model needs a re-quantized checkpoint: no runnable command.
     */
    nativeOnly: sourced(z.literal(true)).optional(),
    /**
     * Checkpoint to serve when the catalog's `hfRepo` is not the right one (e.g. an AWQ checkpoint).
     * `{hfRepo}` is replaced by the model's repo. Absent → serve `hfRepo` itself.
     */
    checkpoint: z.string().min(1).optional(),
    /** Comment line printed with `args`. Required with `checkpoint`: a placeholder never appears without it. */
    note: sourced(z.string().min(1)).optional(),
    /**
     * Comment line printed when the model's checkpoint is natively in this format (`Model.nativeQuant`):
     * vLLM detects it from config.json, so no `args` are passed. Required with `nativeOnly`.
     */
    nativeNote: sourced(z.string().min(1)).optional(),
    /** KV-cache flag that reproduces `kvBytesPerElem` on vLLM, e.g. `--kv-cache-dtype fp8` (review 7d). */
    kvCacheArgs: sourced(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.checkpoint !== undefined && v.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'checkpoint requires note (a placeholder path must be explained)' });
    }
    if ((v.args === undefined) === (v.nativeOnly === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['args'], message: 'exactly one of args / nativeOnly is required' });
    }
    if (v.nativeOnly !== undefined && v.nativeNote === undefined) {
      ctx.addIssue({ code: 'custom', path: ['nativeNote'], message: 'nativeOnly requires nativeNote' });
    }
    if (v.nativeOnly !== undefined && v.checkpoint !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['checkpoint'], message: 'nativeOnly has no checkpoint placeholder (it serves the native checkpoint only)' });
    }
  });
export type VllmServe = z.infer<typeof VllmServeSchema>;

export const QuantizationSchema = z.strictObject({
  id,
  name: z.string().min(1),
  bytesPerParam: posNum,
  computeDtype: z.enum(['fp8', 'bf16']),
  description: z.string(),
  /** Bytes per KV-cache element. */
  kvBytesPerElem: posNum,
  /**
   * Bytes per parameter of the embedding / lm_head (vocabSize × hidden): vLLM's FP8, AWQ and MXFP4 methods
   * quantize only Linear / MoE layers, so these stay 16-bit (spec §5.1, review).
   */
  embeddingBytesPerParam: posNum,
  /**
   * The quantization an unquantized checkpoint (config.json without `quantization_config`) is served in;
   * the API's `quant: 'native'` resolves to it for such models. Exactly one quantization sets it (validator).
   */
  nativeForUnquantized: z.literal(true).optional(),
  /** vLLM launch flags for the verify command. */
  vllmServe: VllmServeSchema,
});
export type Quantization = z.infer<typeof QuantizationSchema>;

/** A Hugging Face repo id `owner/name`. HF owner and repo names use letters, digits, '-', '_' and '.'. */
export const HF_REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const HfRepoSchema = z.string().regex(HF_REPO_RE, 'Hugging Face repo id owner/name (no URL, no bare owner)');

export const OriginSchema = z.strictObject({
  developer: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2 uppercase'),
});
export type Origin = z.infer<typeof OriginSchema>;

export const LayerGroupSchema = z.strictObject({
  kind: z.enum(['full', 'sliding', 'mamba']),
  count: posInt,
  kvHeads: posInt.optional(),
  headDim: posInt.optional(),
  window: posInt.optional(),
  kEqualsV: z.boolean().optional(),
  ssm: z.strictObject({
    heads: posInt,
    headDim: posInt,
    stateSize: posInt,
    /** Bytes per SSM-state element (HF `mamba_ssm_cache_dtype`: float32 → 4, bf16/fp16 → 2). */
    stateBytesPerElem: z.number().positive().optional(),
  }).optional(),
}).superRefine((g, ctx) => {
  if (g.kind === 'sliding' && g.window === undefined) {
    ctx.addIssue({ code: 'custom', path: ['window'], message: "kind 'sliding' requires window" });
  }
  if (g.kind === 'mamba' && g.ssm === undefined) {
    ctx.addIssue({ code: 'custom', path: ['ssm'], message: "kind 'mamba' requires ssm" });
  }
});
export type LayerGroup = z.infer<typeof LayerGroupSchema>;

export const ModelSchema = z
  .strictObject({
    id,
    name: z.string().min(1),
    /** HF repo `owner/name`. */
    hfRepo: HfRepoSchema,
    /** The publisher (developer + country). */
    origin: OriginSchema,
    /** The model card's `base_model` (several repos joined with ', ') or the maintainer's --base. */
    baseModel: z.string().min(1).optional(),
    /** Origin of `baseModel` when the maintainer gave it; never guessed. */
    baseOrigin: OriginSchema.optional(),
    totalParamsB: posNum,
    layers: posInt,
    heads: posInt,
    kvHeads: posInt,
    headDim: posInt,
    hidden: posInt,
    attention: z.enum(['gqa', 'mla']),
    /**
     * MLA dimensions (config.json `kv_lora_rank`, `qk_rope_head_dim`, `qk_nope_head_dim`, `v_head_dim`). The latent KV
     * cache is kvLoraRank + qkRopeHeadDim per token per layer; the prefill (MHA) path attends with QK head dim
     * qkNopeHeadDim + qkRopeHeadDim and V head dim vHeadDim, the decode (absorbed MQA) path with kvLoraRank +
     * qkRopeHeadDim and kvLoraRank (spec §5.2, Ruling R40).
     */
    mla: z.strictObject({ kvLoraRank: posInt, qkRopeHeadDim: posInt, qkNopeHeadDim: posInt, vHeadDim: posInt }).optional(),
    layerGroups: z.array(LayerGroupSchema).min(1).optional(),
    moe: z.strictObject({ experts: posInt, topK: posInt, expertFfnDim: posInt }).optional(),
    slidingWindow: posInt.nullable().optional(),
    /**
     * The checkpoint at `hfRepo` is already quantized (config.json `quantization_config`). Weight memory is
     * then the checkpoint's own size, not totalParams × bytesPerParam (config/models/README.md).
     */
    nativeQuant: z
      .strictObject({
        /** HF `quantization_config.quant_method`, verbatim. */
        method: z.string().min(1),
        /** Quantization id the method maps to (hf-parse.ts table; unknown methods fail closed). */
        quant: id,
        /** Exact bytes of the safetensors files listed in model.safetensors.index.json at the pinned commit. */
        checkpointWeightBytes: sourced(z.number().int().positive()),
      })
      .strict()
      .optional(),
    maxContext: posInt.optional(),
    /**
     * config.json vocab_size and tie_word_embeddings: the embedding / lm_head parameters
     * (vocabSize × hidden, × 2 when untied) stay 16-bit under vLLM FP8 / AWQ (spec §5.1). Absent
     * tieWordEmbeddings is treated as untied (the larger, conservative footprint).
     */
    vocabSize: posInt.optional(),
    tieWordEmbeddings: z.boolean().optional(),
    license: z.string().optional(),
    source: id,
    verified: z.iso.date(),
  })
  .superRefine((m, ctx) => {
    if (m.baseOrigin !== undefined && m.baseModel === undefined) {
      ctx.addIssue({ code: 'custom', path: ['baseOrigin'], message: 'baseOrigin needs the baseModel it describes' });
    }
  });
export type Model = z.infer<typeof ModelSchema>;

export const ExcludedOrgSchema = z.strictObject({
  /** HF owner slug; no '/'. */
  org: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'HF owner slug (the part before /)'),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2 uppercase'),
});
export type ExcludedOrg = z.infer<typeof ExcludedOrgSchema>;

export const PolicySchema = z.strictObject({
  excludedCountries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1, 'excludedCountries must not be empty')
    .refine((l) => l.includes('CN'), 'excludedCountries must include CN'),
  excludedOrgs: z.array(ExcludedOrgSchema).min(1, 'excludedOrgs must not be empty'),
  decision: z.strictObject({ value: z.string().min(1), source: id }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const WorkloadSchema = z.strictObject({
  id,
  name: z.string().min(1),
  kind: z.enum(['chat', 'agent']),
  inputTokens: sourced(z.number().int().min(0)),
  outputTokens: sourced(z.number().int().min(1)),
  cacheHitRate: sourced(z.number().min(0).lt(1)),
  description: z.string(),
  /** Human-readable tier note; the models it names are `tierModels`. */
  tierNote: sourced(z.string()),
  /**
   * Tier reference models as catalog ids (review I3): the validator checks they exist, so a model outside the
   * catalog cannot be recommended through free text.
   */
  tierModels: z.array(id).min(1),
  demoText: z.string(),
});
export type Workload = z.infer<typeof WorkloadSchema>;

export const SpeedPresetSchema = z.strictObject({
  id,
  name: z.string().min(1),
  minTokensPerSec: posNum,
  maxTtftSec: posNum,
  description: z.string(),
});
export type SpeedPreset = z.infer<typeof SpeedPresetSchema>;

export const CalibrationProfileSchema = z.strictObject({
  id,
  /**
   * The inference engine these factors were set for (spec §5.2: η is per platform × engine). It decides the
   * verify command (vLLM serve vs mlx_lm.server) and the engine-specific memory rules (review M-6: no longer
   * inferred from which TFLOPS fields the hardware has).
   */
  engine: z.enum(['vllm', 'mlx']),
  etaBw: posFrac,
  etaBwLow: posFrac,
  etaCompute: posFrac,
  memUtil: posFrac,
  /** 0 is allowed for single-machine profiles (tp=1, no all-reduce). */
  allreduceLatencyUs: sourced(z.number().nonnegative()),
  /**
   * t_fixed of spec §5.2: per-step fixed overhead (kernel launches, scheduling, pipeline fill; [R-LEC G2] is only
   * qualitative), seconds, added once per decode step and once to TTFT. 0 until measured (review L4).
   */
  tFixedSec: sourced(z.number().nonnegative()),
  /**
   * Per-request TTFT overhead (seconds) paid once per request, outside the prefill chunks: what a benchmark's TTFT
   * holds beyond the prefill forward passes (request admission, scheduling, first-token output). Ruling R41; 0 until
   * fitted.
   */
  ttftOverheadSec: sourced(z.number().nonnegative()),
  /**
   * KV-cache bytes per element fixed by the inference engine, overriding the quantization's
   * `kvBytesPerElem` (Ruling R32; e.g. MLX keeps KV in the fp16/bf16 activation dtype).
   */
  kvBytesPerElemOverride: sourced(z.number().positive()).optional(),
  /**
   * mlx-lm defaults the memory and timing math read (spec §5.1, §5.3). Required when engine is mlx, refused for vllm
   * (validator). kvCacheStep: `KVCache.step`, the tokens the cache grows by (full / MLA layers hold
   * ceil(ctx / step) × step); prefillStepSize: `mlx_lm.server --prefill-step-size`, the prompt tokens one prefill step
   * processes (TTFT runs in chunks of it, Ruling R38).
   */
  mlxDefaults: z.strictObject({ kvCacheStep: sourced(posInt), prefillStepSize: sourced(posInt) }).optional(),
});
export type CalibrationProfile = z.infer<typeof CalibrationProfileSchema>;

export const ConcurrencyRuleSchema = z.strictObject({
  agentGeneratingShare: unitFrac,
  chatRule: sourced(z.string()),
  agentRule: sourced(z.string()),
  /** Prefill queueing behind the engine's per-step token budget (Ruling R36): the model's rule text and provenance. */
  queueRule: sourced(z.string()),
});
export type ConcurrencyRule = z.infer<typeof ConcurrencyRuleSchema>;

/** A calibration point's value is a published measurement, so its status is `measured` (review M2). */
const measuredValue = sourced(z.number().nonnegative()).refine((v) => v.status === 'measured', {
  path: ['status'],
  message: "a calibration point's measured value must have status measured",
});

/**
 * How a benchmark drew its request lengths. `fixed`: every request has the workload's lengths. `uniform`: each length
 * is an integer drawn uniformly from [floor(rangeRatio × nominal), nominal] (e.g. vLLM / InferenceX `--random-range-ratio`
 * 0.8); the point's workload then holds the mean, (floor(r × L) + L) / 2, within ±0.5 (validator), because the
 * calculator takes one length per workload.
 */
export const PointLengthsSchema = z.discriminatedUnion('sampling', [
  z.strictObject({ sampling: z.literal('fixed') }),
  z.strictObject({
    sampling: z.literal('uniform'),
    rangeRatio: z.number().gt(0).lt(1),
    nominalInputTokens: posInt,
    nominalOutputTokens: posInt,
  }),
]);

/**
 * The conditions a calibration point was measured under (Ruling R41): what the calculator cannot read from the
 * workload / tp / concurrency fields but a reader needs to reproduce or judge the point.
 */
export const PointConditionsSchema = z.strictObject({
  /** Engine version as run, e.g. the vLLM image tag `v0.22.0`. */
  engineVersion: z.string().min(1),
  /** Server launch flags beyond the model and --tensor-parallel-size, as the benchmark script passes them. */
  engineArgs: z.array(z.string().min(1)).optional(),
  /** Environment variables the server ran with, e.g. VLLM_MXFP4_USE_MARLIN=1. */
  engineEnv: z.record(z.string().min(1), z.string()).optional(),
  /** Benchmark client and its arguments. */
  client: z.string().min(1).optional(),
  lengths: PointLengthsSchema.optional(),
  /** The run (e.g. GitHub Actions run attempt) the numbers come from. */
  runUrl: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * Every difference between how the point was run and what the calculator models / its verify command runs (e.g. a
   * non-default MoE kernel forced by an environment variable, an older engine version, an unpinned client).
   */
  deviations: z.array(z.string().min(1)).optional(),
});
export type PointConditions = z.infer<typeof PointConditionsSchema>;

export const CalibrationPointSchema = z.strictObject({
  id,
  role: z.enum(['fit', 'validate']),
  platform: id,
  model: id,
  quant: id,
  workload: z.strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(1),
    cacheHitRate: z.number().min(0).lt(1),
  }),
  /**
   * Tensor-parallel size the benchmark ran (one replica of tp GPUs); the prediction is evaluated at it, not at the
   * calculator's own choice. Must be a TP vLLM accepts for the model on the platform (validator, legalTpOptions).
   */
  tp: posInt,
  /** Concurrent requests (closed loop: the prediction runs B = concurrency, with R36 queueing). */
  concurrency: posInt,
  metric: z.enum(['decodeTokPerSec', 'maxConcurrent', 'ttftSec']),
  measured: measuredValue,
  engine: z.string(),
  conditions: PointConditionsSchema.optional(),
  /** Why the point has its role (a fit point says what it sets), or other context for the reader. */
  note: z.string().min(1).optional(),
});
export type CalibrationPoint = z.infer<typeof CalibrationPointSchema>;

/** Benchmark (verify command) rules shared by every result (workloads.yaml `benchmark`). */
export const BenchmarkRuleSchema = z.strictObject({
  /**
   * Tokens added to `--max-model-len` above input + output, so a benchmark prompt whose length drifts when the
   * server re-tokenizes it is not rejected (docs/research/prior-art-calculators.md §C, added 2026-10-20).
   */
  maxModelLenMarginTokens: sourced(z.number().int().min(0)),
});
export type BenchmarkRule = z.infer<typeof BenchmarkRuleSchema>;

export const MetaSchema = z.strictObject({ dataVersion: z.iso.date() });
export type Meta = z.infer<typeof MetaSchema>;

/**
 * A published measurement that is NOT evaluated (Ruling R28): its model is not in the catalog, or the
 * source does not state the conditions the calculator needs (input/output lengths). Kept, sourced, so
 * the accuracy report can say what was left out and why.
 */
export const SkippedCalibrationPointSchema = z
  .strictObject({
    id,
    role: z.enum(['fit', 'validate']),
    platform: id,
    /** HF repo `owner/name` of the measured model (it may be absent from the catalog). */
    modelRepo: HfRepoSchema.optional(),
    /** The measured model as the source names it, when the source gives no exact repo (needs modelOrigin). */
    modelName: z.string().min(1).optional(),
    /** Publisher of `modelName` (final-review I4). */
    modelOrigin: OriginSchema.optional(),
    quant: id,
    concurrency: posInt,
    metric: z.enum(['decodeTokPerSec', 'maxConcurrent', 'ttftSec']),
    measured: measuredValue,
    reason: z.string().min(1),
  })
  .superRefine((p, ctx) => {
    // Name the repo, or the model and its publisher (final-review I4).
    if (p.modelRepo === undefined && (p.modelName === undefined || p.modelOrigin === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['modelRepo'], message: 'give modelRepo (owner/name), or modelName with modelOrigin { developer, country }' });
    }
  });
export type SkippedCalibrationPoint = z.infer<typeof SkippedCalibrationPointSchema>;

/** Platforms with no usable public measurement yet (spec §10.1). */
export const CalibrationGapSchema = z.strictObject({
  id,
  platforms: z.array(id).min(1),
  note: z.string().min(1),
});
export type CalibrationGap = z.infer<typeof CalibrationGapSchema>;
