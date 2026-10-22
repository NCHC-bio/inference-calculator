import { ModelSchema, type LayerGroup, type Model, type Origin } from '@nchc/schema';

/** Values the importer cannot read from config.json; supplied by the maintainer via CLI flags. */
export interface ParseOptions {
  /** Developer + ISO2 country (spec §2.2). Never inferred. */
  origin?: Origin;
  /**
   * Recorded lineage (the card's base_model or --base) and, when the maintainer gave it, the base origin.
   */
  base?: { repo: string; origin?: Origin };
  /** License string from the model card metadata. */
  license?: string;
  /** ISO date the config was read; defaults to today. */
  verified?: string;
  /**
   * Exact bytes of the checkpoint's weight files (checkpointWeightBytes()). Required when config.json declares a
   * `quantization_config`: the weight memory of a natively quantized checkpoint is its own size.
   */
  checkpointWeightBytes?: number | null;
  /**
   * Contents of the repo's `hf_quant_config.json` at the same commit, when it has one (ModelOpt <= 0.29 writes its
   * quantization config there instead of config.json; vLLM reads it when config.json has no quantization_config).
   */
  hfQuantConfig?: unknown;
  /**
   * Tensor names of the checkpoint (`model.safetensors.index.json` weight_map keys) at the same commit, when the
   * importer read them: they decide tie_word_embeddings when config.json omits it (final-review M21).
   */
  weightNames?: string[];
  /**
   * The model card's base model and its safetensors parameter count, when the importer read it: a packed quantized
   * checkpoint (4-bit values stored two per byte) reports its element count, not its parameter count.
   */
  baseParams?: { repo: string; total: number };
  /** Estimates the caller already made (a GGUF repo read through its base model), added to Model.estimates. */
  estimates?: Array<{ feature: EstimatedFeature; detail: string }>;
}

/**
 * tie_word_embeddings defaults of text-config classes, read from the transformers source (final-review M21), used when
 * config.json omits the key and no checkpoint index says. transformers v5.20.2 (tag commit 4a982f3):
 * - `mistral`: MistralConfig `tie_word_embeddings: bool = False`
 *   (src/transformers/models/mistral/configuration_mistral.py L78).
 * Anything else falls back to untied (an extra 16-bit lm_head table: the larger, conservative footprint), noted.
 */
export const TIE_DEFAULTS: Readonly<Record<string, { tied: boolean; ref: string }>> = {
  mistral: { tied: false, ref: 'transformers v5.20.2 models/mistral/configuration_mistral.py L78 (MistralConfig default False)' },
};

/** A separate lm_head tensor in the checkpoint (`lm_head.weight`, possibly prefixed, e.g. `language_model.lm_head.weight`). */
const hasLmHead = (names: string[]): boolean => names.some((n) => /(^|\.)lm_head\.weight$/.test(n));

/**
 * Structures a model may have that the calculator has not modelled precisely yet: each is estimated conservatively
 * from the standard config fields and listed in Model.estimates (CLAUDE.md "Goal for imported models"); the website
 * names them in the user's language and offers a request to model them precisely.
 */
export const ESTIMATED_FEATURES = [
  'linear-attention', 'short-conv', 'moe-layout', 'heterogeneous-blocks', 'compressed-attention', 'cross-layer-kv',
  'sparse-indexer', 'lookup-tables', 'memory-layers', 'recurrent-depth', 'native-quant', 'unknown-layer-type',
  'sliding-window', 'gguf',
] as const;
export type EstimatedFeature = (typeof ESTIMATED_FEATURES)[number];

export interface ParseResult {
  model?: Model;
  /** Human-readable names of every field that could not be read, each listed once. Empty when `model` is set. */
  missing: string[];
  /**
   * Implicit defaults the parser applied (a convention, not a value read from config.json), e.g. kvHeads =
   * heads when num_key_value_heads is absent. The importer prints them and writes them into the YAML header
   * (review M5): nothing is assumed silently.
   */
  notes: string[];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
/** A JSON number; `null` (Gemma 4 writes `num_experts: null`) counts as absent. */
const num = (o: Obj, key: string): number | undefined => (typeof o[key] === 'number' ? (o[key] as number) : undefined);
const firstNum = (o: Obj, keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = num(o, k);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * HF `quantization_config.quant_method` → quantization id (config/quantization.yaml). Only methods whose
 * served format the calculator models are listed; anything else is reported as missing (fail closed).
 * - `mxfp4`: gpt-oss (OCP MX FP4 experts, BF16 attention).
 * - `fp8`: Mistral Medium 3.5 / Small 4 (FP8 E4M3 weights, BF16 vision tower and lm_head).
 */
export const NATIVE_QUANT_IDS: Readonly<Record<string, string>> = { mxfp4: 'mxfp4', fp8: 'fp8' };

/**
 * The checkpoint's `quantization_config` (top level, or inside `text_config` / `llm_config` for multimodal
 * configs), or undefined for an unquantized checkpoint. `compression_config` (compressed-tensors, which vLLM also
 * reads as a native quantization) is returned too, so it fails closed instead of being sized as BF16.
 * Without either, a separate `hf_quant_config.json` (ModelOpt <= 0.29) is the quantization config, as in vLLM v0.32.0
 * `get_config` (vllm/transformers_utils/config.py L888-899): key 'hf_quant_config.json'.
 */
export function quantizationConfig(config: unknown, hfQuantConfig?: unknown): { key: string; value: unknown } | undefined {
  if (!isObj(config)) return undefined;
  for (const o of [config, config.text_config, config.llm_config]) {
    if (!isObj(o)) continue;
    for (const key of ['quantization_config', 'compression_config']) {
      if (o[key] !== undefined && o[key] !== null) return { key, value: o[key] };
    }
  }
  if (hfQuantConfig !== undefined && hfQuantConfig !== null) return { key: 'hf_quant_config.json', value: hfQuantConfig };
  return undefined;
}

/**
 * ModelOpt `hf_quant_config.json` → native quantization, failing closed on anything the calculator does not model.
 * vLLM v0.32.0 sets quant_method 'modelopt' for producer `modelopt` with quant_algo FP8
 * (vllm/transformers_utils/model_arch_config_convertor.py L270-286) and serves it with ModelOptFp8Config
 * (vllm/model_executor/layers/quantization/modelopt.py L449-455). Precision of embedding / lm_head, from the exclude
 * list (modelopt.py `get_quant_method` L224-260): an excluded LinearBase / ParallelLMHead gets UnquantizedLinearMethod,
 * a non-excluded ParallelLMHead is quantized, and the input VocabParallelEmbedding is never quantized. The calculator
 * sizes embedding and lm_head 16-bit (quantization embeddingBytesPerParam), so `lm_head` must be in exclude_modules.
 * Only quant_algo FP8 is accepted (per-tensor FP8 weights and activations, the calculator's fp8 quantization).
 */
export function modeloptNativeQuant(hq: unknown): { method: string; quant: string } | { missing: string } {
  const producer = isObj(hq) && isObj(hq.producer) ? hq.producer.name : undefined;
  if (producer !== 'modelopt') return { missing: `hf_quant_config.json producer ${JSON.stringify(producer)} (native quantization not supported)` };
  const q = isObj(hq) && isObj(hq.quantization) ? hq.quantization : undefined;
  const algo = q?.quant_algo;
  if (typeof algo !== 'string' || algo.toUpperCase() !== 'FP8') {
    return { missing: `hf_quant_config.json quant_algo ${JSON.stringify(algo)} (native quantization not supported)` };
  }
  const exclude = Array.isArray(q?.exclude_modules) ? q.exclude_modules : [];
  if (!exclude.includes('lm_head')) {
    return { missing: 'hf_quant_config.json exclude_modules without lm_head (an FP8 lm_head is not modelled: embedding / lm_head are sized 16-bit)' };
  }
  return { method: 'modelopt', quant: 'fp8' };
}

/**
 * Exact byte size of the weight files that make up the served checkpoint: the sum of the file sizes (HF
 * `/api/models/<repo>/revision/<sha>?blobs=true` siblings, `lfs.size` else `size`) of every distinct file in
 * `model.safetensors.index.json` `weight_map`. Files not in the index (e.g. gpt-oss `original/`, Mistral
 * `consolidated-*`) are other copies of the weights and are not counted. Without an index, a single
 * `model.safetensors` is the checkpoint. File sizes include each file's small safetensors header.
 */
export function checkpointWeightBytes(index: unknown, siblings: unknown): { bytes?: number; missing: string[] } {
  const sizes = new Map<string, number>();
  if (Array.isArray(siblings)) {
    for (const s of siblings) {
      if (!isObj(s) || typeof s.rfilename !== 'string') continue;
      const lfs = isObj(s.lfs) && typeof s.lfs.size === 'number' ? s.lfs.size : undefined;
      const size = lfs ?? (typeof s.size === 'number' ? s.size : undefined);
      if (size !== undefined) sizes.set(s.rfilename, size);
    }
  }
  let files: string[];
  if (index === null || index === undefined) files = ['model.safetensors'];
  else if (isObj(index) && isObj(index.weight_map)) {
    files = [...new Set(Object.values(index.weight_map).filter((f): f is string => typeof f === 'string'))];
    if (files.length === 0) return { missing: ['model.safetensors.index.json: empty weight_map'] };
  } else return { missing: ['model.safetensors.index.json: no weight_map'] };
  const missing = files.filter((f) => !sizes.has(f)).map((f) => `checkpoint file size: ${f}`);
  if (missing.length > 0) return { missing };
  return { bytes: files.reduce((sum, f) => sum + sizes.get(f)!, 0), missing: [] };
}

/** Model id: lowercase repo name after the owner, e.g. `google/gemma-4-31B-it` → `gemma-4-31b-it`. */
export const modelSlug = (repo: string): string => (repo.split('/').pop() ?? repo).toLowerCase();
/** Source id for a pinned HF commit, e.g. `hf:openai/gpt-oss-120b@b5c939d`. */
export const hfSourceId = (repo: string, sha: string): string => `hf:${repo}@${sha.slice(0, 7)}`;

/** Per-layer cache kind; `none` = no per-sequence cache (MLP / MoE blocks); `linear` / `conv` = a fixed state. */
type LayerKind = 'full' | 'sliding' | 'mamba' | 'linear' | 'conv' | 'none';

/**
 * Per-layer type names, from the real configs in test/fixtures/hf:
 * - `layer_types` (gpt-oss, Gemma 4, Qwen3.5 / 3.8, LFM2, DeepSeek V4 style): `full_attention` → full,
 *   `sliding_attention` → sliding; `linear_attention` → linear (Gated DeltaNet / KDA), `conv` → conv (LFM2 short
 *   convolution), the compressed / sparse attention types → full (estimated), `mlp` → none (a layer without attention).
 * - `layers_block_type` (Nemotron 3 / 3.5, NemotronH): `attention` → full, `mamba` → mamba, `moe` / `mlp` → none.
 * - `hybrid_override_pattern` (older NemotronH string form): `*` → full, `M` → mamba, `-` / `E` → none.
 * - `local_layer_ids` (Inkling): listed indices → sliding, every other layer index → full.
 * Any other type is sized as full attention and recorded as an estimate (the conservative choice).
 */
const LAYER_TYPES: Record<string, LayerKind> = {
  full_attention: 'full', sliding_attention: 'sliding', linear_attention: 'linear', conv: 'conv', mlp: 'none',
  compressed_sparse_attention: 'full', heavily_compressed_attention: 'full', deepseek_sparse_attention: 'full',
};
/** Layer types sized as full attention although they keep less (compressed / sparse): an estimate. */
const FULL_ESTIMATE_TYPES: Record<string, EstimatedFeature> = {
  compressed_sparse_attention: 'compressed-attention',
  heavily_compressed_attention: 'compressed-attention',
  deepseek_sparse_attention: 'sparse-indexer',
};
const BLOCK_TYPES: Record<string, LayerKind> = { attention: 'full', mamba: 'mamba', moe: 'none', mlp: 'none' };
const PATTERN_CHARS: Record<string, LayerKind> = { '*': 'full', M: 'mamba', '-': 'none', E: 'none' };
/** HF state dtype names → bytes per element (NemotronH `mamba_ssm_cache_dtype`, Qwen3.5 `mamba_ssm_dtype`). */
const SSM_DTYPE_BYTES: Record<string, number> = { float32: 4, bfloat16: 2, float16: 2 };

/**
 * Expert-MLP activations known to be gated (gate / up / down = 3 matrices, core's default): SwiGLU (`silu`, `swish`)
 * and GeGLU (`gelu*`, Gemma). Any other activation is estimated with 2 matrices: fewer expert parameters leave more
 * parameters active per token (the conservative side for speed).
 */
const GATED_ACTS = new Set(['silu', 'swish', 'gelu', 'gelu_pytorch_tanh', 'gelu_new']);

type Estimate = (feature: EstimatedFeature, detail: string) => void;

/** Returns per-layer kinds, or undefined when the config has no per-layer type field. */
function layerKinds(t: Obj, layers: number | undefined, missing: string[], estimate: Estimate): LayerKind[] | undefined {
  const mapList = (field: string, list: unknown[], table: Record<string, LayerKind>): LayerKind[] => {
    const unknown = new Map<string, number>();
    const kinds = list.map((x): LayerKind => {
      const k = typeof x === 'string' && Object.hasOwn(table, x) ? table[x]! : undefined;
      if (k === undefined) unknown.set(String(x), (unknown.get(String(x)) ?? 0) + 1);
      return k ?? 'full';
    });
    for (const [x, n] of unknown) {
      estimate('unknown-layer-type', `${field} "${x}" on ${n} of ${list.length} layers: sized as full attention`);
    }
    if (field === 'layer_types') {
      for (const [type, feature] of Object.entries(FULL_ESTIMATE_TYPES)) {
        const n = list.filter((y) => y === type).length;
        if (n > 0) estimate(feature, `layer_types "${type}" on ${n} of ${list.length} layers: sized as full attention`);
      }
    }
    return kinds;
  };
  if (Array.isArray(t.layer_types)) return mapList('layer_types', t.layer_types, LAYER_TYPES);
  if (Array.isArray(t.layers_block_type)) return mapList('layers_block_type', t.layers_block_type, BLOCK_TYPES);
  if (typeof t.hybrid_override_pattern === 'string') {
    return mapList('hybrid_override_pattern', [...t.hybrid_override_pattern], PATTERN_CHARS);
  }
  if (Array.isArray(t.local_layer_ids)) {
    if (layers === undefined) return undefined;
    const local = new Set(t.local_layer_ids);
    for (const i of local) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= layers) {
        missing.push(`local_layer_ids: invalid layer index ${JSON.stringify(i)}`);
      }
    }
    return Array.from({ length: layers }, (_, i): LayerKind => (local.has(i) ? 'sliding' : 'full'));
  }
  return undefined;
}

/**
 * MoE layers among `layers` (spec §5.1 counts experts per MoE layer), read from the config's own layout keys (exact):
 * `mlp_layer_types` (routed-expert entries), `layers_block_type` / `hybrid_override_pattern` MoE blocks,
 * `first_k_dense_replace` / `num_dense_layers` (the first k layers dense; DeepSeek, GLM, LFM2) with `moe_layer_freq`
 * (every freq-th layer after them), `mlp_only_layers` (listed layers dense), `decoder_sparse_step` (Qwen2-MoE: layer i
 * sparse when (i + 1) % step == 0), `dense_mlp_idx` (listed dense layers). Undefined = every layer.
 */
function moeLayerCount(t: Obj, layers: number): number | undefined {
  if (Array.isArray(t.mlp_layer_types)) {
    return t.mlp_layer_types.filter((x) => x === 'sparse' || x === 'moe' || x === 'hash_moe').length;
  }
  const blocks: unknown[] | undefined = Array.isArray(t.layers_block_type)
    ? t.layers_block_type
    : typeof t.hybrid_override_pattern === 'string' ? [...t.hybrid_override_pattern] : undefined;
  if (blocks) return blocks.filter((b) => b === 'moe' || b === 'E').length;
  const firstDense = num(t, 'first_k_dense_replace') ?? num(t, 'num_dense_layers') ?? 0;
  const freq = num(t, 'moe_layer_freq') ?? 1;
  const step = num(t, 'decoder_sparse_step') ?? 1;
  const only = new Set(Array.isArray(t.mlp_only_layers) ? t.mlp_only_layers : []);
  const denseIdx = new Set(Array.isArray(t.dense_mlp_idx) ? t.dense_mlp_idx : typeof t.dense_mlp_idx === 'number' ? [t.dense_mlp_idx] : []);
  let n = 0;
  for (let i = 0; i < layers; i++) {
    if (i < firstDense || only.has(i) || denseIdx.has(i)) continue;
    if ((i - firstDense) % freq !== 0) continue;
    if ((i + 1) % step !== 0) continue;
    n++;
  }
  return n === layers ? undefined : n;
}

const present = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== false && v !== 0 && !(Array.isArray(v) && v.length === 0);

/** The text-model config: `text_config` / `llm_config` (multimodal) or a nested `backbone_configs` (MemT). */
function textConfig(config: Obj): Obj {
  if (isObj(config.text_config)) return config.text_config;
  if (isObj(config.llm_config)) return config.llm_config;
  if (isObj(config.backbone_configs)) {
    const b = config.backbone_configs;
    return isObj(b.text_config) ? { ...b.text_config, ...(config.memt !== undefined ? { memt: config.memt } : {}) } : b;
  }
  return config;
}

/**
 * Parse a Hugging Face `config.json` into a Model (spec §5; CLAUDE.md "Goal for imported models").
 * Standard fields are read exactly. A structure the calculator has not modelled precisely is estimated from the
 * standard fields on the conservative side (more memory, slower) and listed in `model.estimates`; the model is never
 * refused for it. Only fields no estimate can do without (hidden size, heads, layers, vocabulary, the parameter count,
 * the publisher origin) are reported as `missing`, and a missing one is an importer bug.
 */
export function parseHfConfig(
  repo: string,
  sha: string,
  config: unknown,
  safetensorsTotal: number | null,
  opts: ParseOptions = {},
): ParseResult {
  const missing: string[] = [];
  if (!isObj(config)) return { missing: ['config.json is not a JSON object'], notes: [] };
  const notes: string[] = [];
  const estimates: Array<{ feature: EstimatedFeature; detail: string }> = [];
  const estimate: Estimate = (feature, detail) => {
    if (!estimates.some((e) => e.feature === feature && e.detail === detail)) estimates.push({ feature, detail });
  };
  const t = textConfig(config);

  const hidden = num(t, 'hidden_size');
  if (hidden === undefined) missing.push('hidden_size');
  const heads = num(t, 'num_attention_heads');
  if (heads === undefined) missing.push('num_attention_heads');
  // HF convention: no num_key_value_heads means multi-head attention (kv = heads). Kept, but reported.
  const kvHeads = num(t, 'num_key_value_heads') ?? heads;
  if (num(t, 'num_key_value_heads') === undefined && heads !== undefined) {
    notes.push(`num_key_value_heads absent: kvHeads = num_attention_heads (${heads}), the Hugging Face convention for multi-head attention`);
  }

  // head_dim 0 (a config that leaves it unset) counts as absent.
  let headDim = num(t, 'head_dim') || undefined;
  if (headDim === undefined && hidden !== undefined && heads !== undefined) {
    if (Number.isInteger(hidden / heads)) {
      headDim = hidden / heads;
      notes.push(`head_dim absent: headDim = hidden_size ÷ num_attention_heads = ${hidden} ÷ ${heads} = ${headDim}`);
    } else missing.push('head_dim');
  }

  // NemotronH configs omit num_hidden_layers; the per-layer block list is the layer count.
  const declaredLayers = num(t, 'num_hidden_layers');
  let kinds = layerKinds(t, declaredLayers, missing, estimate);
  const layers = declaredLayers ?? kinds?.length;
  if (layers === undefined) missing.push('num_hidden_layers');
  else if (kinds && kinds.length !== layers) {
    missing.push(`per-layer types list ${kinds.length} layers but num_hidden_layers is ${layers}`);
  }

  // MLA (latent KV): kv_lora_rank + qk_rope_head_dim (0 allowed: no rope part); the prefill (MHA) path also needs
  // qk_nope_head_dim and v_head_dim (Ruling R40). DeepSeek-style keys; Mistral's params.json uses the same names.
  const kvLoraRank = num(t, 'kv_lora_rank');
  let mla: Model['mla'];
  if (kvLoraRank !== undefined && kvLoraRank > 0) {
    const qkRopeHeadDim = num(t, 'qk_rope_head_dim');
    const qkNopeHeadDim = num(t, 'qk_nope_head_dim');
    const vHeadDim = num(t, 'v_head_dim');
    if (qkRopeHeadDim === undefined) missing.push('qk_rope_head_dim');
    if (qkNopeHeadDim === undefined) missing.push('qk_nope_head_dim');
    if (vHeadDim === undefined) missing.push('v_head_dim');
    if (qkRopeHeadDim !== undefined && qkNopeHeadDim !== undefined && vHeadDim !== undefined) {
      mla = { kvLoraRank, qkRopeHeadDim, qkNopeHeadDim, vHeadDim };
    }
  }

  // MoE. Expert count: n_routed_experts / num_experts / num_local_experts. Top-k: num_experts_per_tok / top_k_experts.
  // Expert FFN: moe_intermediate_size, else intermediate_size (gpt-oss and Inkling keep the expert width there).
  let moe: Model['moe'];
  const blockConfigs = Array.isArray(t.block_configs) ? t.block_configs.filter(isObj) : undefined;
  const moeBlocks = blockConfigs?.filter((b) => b.block_type === 'moe');
  const experts = firstNum(t, ['n_routed_experts', 'num_experts', 'num_local_experts']);
  if (moeBlocks && moeBlocks.length > 0) {
    moe = heterogeneousMoe(moeBlocks, missing, estimate);
  } else if (experts !== undefined) {
    const topK = firstNum(t, ['num_experts_per_tok', 'top_k_experts', 'moe_topk']);
    let expertFfnDim = firstNum(t, ['moe_intermediate_size', 'intermediate_size']);
    if (topK === undefined) missing.push('num_experts_per_tok');
    if (expertFfnDim === undefined) missing.push('moe_intermediate_size');
    // Two expert widths (Hunyuan hy_v3: expert_hidden_dim and moe_intermediate_size): the smaller one, so fewer
    // expert parameters leave more active per token.
    const expertHidden = num(t, 'expert_hidden_dim');
    if (expertHidden !== undefined && expertFfnDim !== undefined && expertHidden !== expertFfnDim) {
      const smaller = Math.min(expertHidden, expertFfnDim);
      estimate('moe-layout', `two expert widths (expert_hidden_dim ${expertHidden}, moe_intermediate_size ${expertFfnDim}): the smaller, ${smaller}, is used`);
      expertFfnDim = smaller;
    }
    if (topK !== undefined && expertFfnDim !== undefined) moe = { experts, topK, expertFfnDim };
  }
  if (moe && layers !== undefined) {
    const moeLayers = moe.layers ?? moeLayerCount(t, layers);
    if (moeLayers !== undefined && moeLayers < layers) moe = { ...moe, layers: moeLayers };
    const latent = num(t, 'moe_latent_size');
    if (latent !== undefined) {
      estimate('moe-layout', `latent MoE: experts work in moe_latent_size ${latent}, not hidden_size`);
      moe = { ...moe, width: latent };
    }
    // Inkling's shared_expert_sink: its semantics are not documented in the config, so it is named, not modelled.
    if (present(t.shared_expert_sink)) estimate('moe-layout', 'shared_expert_sink: not modelled (its weights are in the parameter count)');
    const actKey = ['mlp_hidden_act', 'hidden_act', 'hidden_activation'].find((k) => t[k] !== undefined && t[k] !== null);
    const act = actKey !== undefined ? t[actKey] : undefined;
    if (act !== undefined && (typeof act !== 'string' || !GATED_ACTS.has(act))) {
      estimate('moe-layout', `expert activation ${JSON.stringify(act)}: sized as 2 matrices (non-gated)`);
      moe = { ...moe, matrices: 2 };
    }
  }

  // Embedding size (spec §5.1: embedding / lm_head stay 16-bit under vLLM FP8 / AWQ). vocab_size is required;
  // tie_word_embeddings is optional and absent means untied (conservative).
  const vocabSize = num(t, 'vocab_size') ?? num(config, 'vocab_size');
  if (vocabSize === undefined) missing.push('vocab_size');
  const tieRaw = typeof t.tie_word_embeddings === 'boolean' ? t.tie_word_embeddings : config.tie_word_embeddings;
  let tieWordEmbeddings = typeof tieRaw === 'boolean' ? tieRaw : undefined;
  // Absent (final-review M21): transformers' PretrainedConfig default is tied, but text-config classes override it, so
  // the checkpoint's own tensors decide when known; else a verified class default; else untied (conservative).
  if (tieWordEmbeddings === undefined && vocabSize !== undefined) {
    const textType = typeof t.model_type === 'string' ? t.model_type : undefined;
    if (opts.weightNames && opts.weightNames.length > 0) {
      tieWordEmbeddings = !hasLmHead(opts.weightNames);
      notes.push(
        `tie_word_embeddings absent: the checkpoint index ${tieWordEmbeddings ? 'has no' : 'has a separate'} lm_head.weight tensor, so the embeddings are ${tieWordEmbeddings ? 'tied' : 'untied'}`,
      );
    } else if (textType !== undefined && Object.hasOwn(TIE_DEFAULTS, textType)) {
      const d = TIE_DEFAULTS[textType]!;
      tieWordEmbeddings = d.tied;
      notes.push(`tie_word_embeddings absent: ${textType} class default ${d.tied ? 'tied' : 'untied'} (${d.ref})`);
    } else {
      tieWordEmbeddings = false;
      notes.push(
        'tie_word_embeddings absent and no checkpoint index or verified class default: assumed untied, the conservative ' +
          'choice (a separate 16-bit lm_head; the transformers PretrainedConfig default would be tied)',
      );
    }
  }

  // Sliding window: sliding_window (most), sliding_window_size (Inkling).
  let window = firstNum(t, ['sliding_window', 'sliding_window_size']);
  // 0 means disabled: vLLM v0.32.0 turns it into None (vllm/config/model.py L802-L808).
  if (window === 0) {
    window = undefined;
    notes.push('sliding_window 0: no sliding window (vLLM treats 0 as disabled)');
  }
  // use_sliding_window false (final-review M22): transformers drops the window (e.g. v5.20.2
  // models/qwen2/configuration_qwen2.py L84 `sliding_window if use_sliding_window else None`), and vLLM reads the
  // config's sliding_window (vllm/config/model.py L1612-L1614). Beside layers typed sliding_attention it is ambiguous
  // whether they slide: they are sized as full attention (the conservative side).
  if (t.use_sliding_window === false && window !== undefined) {
    if (kinds?.includes('sliding')) {
      estimate('sliding-window', `use_sliding_window false beside sliding_attention layer types: those layers sized as full attention`);
      kinds = kinds.map((k) => (k === 'sliding' ? 'full' : k));
    } else notes.push(`use_sliding_window false: sliding_window ${window} ignored (every layer full attention)`);
    window = undefined;
  }
  // A window with no per-layer types beside compressed KV, MLA or a DeepSeek-style MoE layout (e.g. an OCR model): not
  // every layer is known to slide, so every layer is sized as full attention.
  const compressed = ['compress_ratios', 'compress_rates'].filter((k) => present(t[k]));
  if (!kinds && window !== undefined && (compressed.length > 0 || t.first_k_dense_replace !== undefined || mla)) {
    estimate(compressed.length > 0 ? 'compressed-attention' : 'sliding-window',
      `sliding_window ${window} beside ${compressed.length > 0 ? compressed.join(', ') : 'a DeepSeek-style layout'}: every layer sized as full attention`);
    window = undefined;
  }
  if (compressed.length > 0 && kinds) estimate('compressed-attention', `${compressed.join(', ')}: compressed layers sized as full attention`);
  if (present(t.kv_source_layer_ids) || (num(t, 'num_kv_shared_layers') ?? 0) > 0) {
    estimate('cross-layer-kv', 'KV shared across layers: every layer counted with its own KV');
  }

  // Fixed-state layers (linear attention, short convolution): their per-sequence state from the config's own sizes.
  const kdaKeys = ['linear_attn_config', 'kda_lower_bound', 'use_kda_lora', 'num_kv_heads_for_linear_attn'].filter((k) => t[k] !== undefined);
  const linState = kinds?.includes('linear') || (!kinds && kdaKeys.length > 0) ? linearStateBytes(t, heads, headDim, estimate) : undefined;
  const convState = convStateBytes(t, hidden, estimate);

  let layerGroups: LayerGroup[] | undefined;
  if (!kinds && window !== undefined && layers !== undefined && !mla) {
    // A window with no per-layer type field means every layer uses sliding-window attention.
    layerGroups = [{ kind: 'sliding', count: layers, kvHeads, headDim, window }];
  }
  if (kinds) {
    const counts = new Map<LayerKind, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    layerGroups = [];
    for (const [kind, count] of counts) {
      if (kind === 'none') {
        layerGroups.push({ kind: 'none', count });
        continue;
      }
      if (kind === 'full') {
        // Gemma 4 global layers: num_global_key_value_heads / global_head_dim; attention_k_eq_v (K and V share
        // one projection, see docs/research/open-models.md) applies to these global layers.
        const g: LayerGroup = {
          kind, count,
          kvHeads: num(t, 'num_global_key_value_heads') ?? kvHeads,
          headDim: num(t, 'global_head_dim') ?? headDim,
        };
        const absent = ['num_global_key_value_heads', 'global_head_dim'].filter((k) => num(t, k) === undefined);
        if (kinds.includes('sliding') && absent.length > 0) {
          notes.push(
            `full-attention layers: ${absent.join(' / ')} absent, so the model num_key_value_heads (${kvHeads}) and head_dim (${headDim}) are used`,
          );
        }
        if (t.attention_k_eq_v === true) g.kEqualsV = true;
        layerGroups.push(g);
      } else if (kind === 'sliding') {
        // Inkling sliding layers: swa_num_key_value_heads / swa_head_dim.
        if (window === undefined) missing.push('sliding_window');
        layerGroups.push({
          kind, count,
          kvHeads: num(t, 'swa_num_key_value_heads') ?? kvHeads,
          headDim: num(t, 'swa_head_dim') ?? headDim,
          ...(window !== undefined ? { window } : {}),
        });
      } else if (kind === 'linear' || kind === 'conv') {
        const bytes = kind === 'linear' ? linState : convState;
        // No sizes in the config: sized as full attention (the conservative fallback).
        if (bytes === undefined) layerGroups.push({ kind: 'full', count, kvHeads, headDim });
        else layerGroups.push({ kind: 'state', count, stateBytes: bytes });
      } else {
        // Mamba2 state per layer: mamba_num_heads × mamba_head_dim × ssm_state_size elements of
        // mamba_ssm_cache_dtype (absent → 2 bytes, the model dtype default; see config/models/README.md).
        const ssmHeads = num(t, 'mamba_num_heads');
        const ssmHeadDim = num(t, 'mamba_head_dim');
        const stateSize = num(t, 'ssm_state_size');
        if (ssmHeads === undefined) missing.push('mamba_num_heads');
        if (ssmHeadDim === undefined) missing.push('mamba_head_dim');
        if (stateSize === undefined) missing.push('ssm_state_size');
        const dtype = t.mamba_ssm_cache_dtype;
        let stateBytesPerElem: number | undefined = 2;
        if (dtype === undefined || dtype === null) {
          notes.push('mamba_ssm_cache_dtype absent: SSM state assumed 2 bytes per element (16-bit model dtype default)');
        } else {
          stateBytesPerElem = typeof dtype === 'string' ? SSM_DTYPE_BYTES[dtype] : undefined;
          if (stateBytesPerElem === undefined) {
            stateBytesPerElem = 4;
            estimate('unknown-layer-type', `mamba_ssm_cache_dtype ${JSON.stringify(dtype)}: sized as 4 bytes per element`);
          }
        }
        if (ssmHeads !== undefined && ssmHeadDim !== undefined && stateSize !== undefined) {
          layerGroups.push({ kind, count, ssm: { heads: ssmHeads, headDim: ssmHeadDim, stateSize, stateBytesPerElem } });
        }
      }
    }
    if (layerGroups.every((g) => g.kind === 'none')) layerGroups = undefined;
  }

  // Caches beyond the layers above, each an estimate.
  let extraBytesPerToken = 0;
  let extraStateBytes = 0;
  const attnLayers = layerGroups
    ? layerGroups.filter((g) => g.kind === 'full' || g.kind === 'sliding').reduce((s, g) => s + g.count, 0)
    : layers ?? 0;
  // A sparse-attention indexer keeps its own key per token (DSA style): indexer KV heads × index head dim at 2 bytes on
  // every attention layer (some designs share it between layers; counting each is the upper bound).
  const indexKeys = ['index_n_heads', 'index_topk', 'indexer_n_heads', 'indexer_budget'].filter((k) => present(t[k]));
  if (indexKeys.length > 0) {
    const kvH = num(t, 'indexer_kv_heads') ?? 1;
    const dim = firstNum(t, ['index_head_dim', 'indexer_head_dim']) ?? headDim ?? 0;
    extraBytesPerToken += attnLayers * kvH * dim * 2;
    estimate('sparse-indexer', `${indexKeys.join(', ')}: an indexer key cache of ${kvH} × ${dim} at 2 bytes per token on ${attnLayers} layers; every token counted as read`);
  }
  // KDA layers whose positions the config does not list (Ling bailing_hybrid): every layer keeps its attention cache AND
  // a linear state (an upper bound on whichever it is).
  if (!kinds && kdaKeys.length > 0 && layers !== undefined) {
    const bytes = linState ?? (heads !== undefined && headDim !== undefined ? heads * headDim * headDim * 4 : 0);
    extraStateBytes += layers * bytes;
    estimate('linear-attention', `linear-attention (KDA) layers not listed by position (${kdaKeys.join(', ')}): every layer counted with both its attention cache and a ${bytes}-byte state`);
  }
  // Memory layers (MemT, a delta-rule memory updated per token): per memory layer a recurrent state of memory heads ×
  // head_dim × head_dim at 4 bytes, plus one chunk (chunk_tokens) of the model's own KV held while it is folded in.
  if (isObj(t.memt)) {
    const memLayers = Array.isArray(t.memt.layers) ? t.memt.layers.length : layers ?? 0;
    const memHeads = firstNum(t.memt, ['num_memory_heads', 'num_kv_heads']) ?? heads ?? 1;
    const memDim = num(t.memt, 'head_dim') ?? headDim ?? 0;
    const chunk = num(t.memt, 'chunk_tokens') ?? 0;
    const perLayer = memHeads * memDim * memDim * 4 + chunk * 2 * (kvHeads ?? 1) * (headDim ?? 0) * 2;
    extraStateBytes += memLayers * perLayer;
    estimate('memory-layers', `memt on ${memLayers} layers: a state of ${memHeads} × ${memDim} × ${memDim} at 4 bytes plus one ${chunk}-token chunk of KV (2 bytes) = ${perLayer} bytes per layer`);
  }
  // Layers run more than once (Nemotron Labs Dory): the attention layers of the repeated block keep KV per pass.
  const loops = num(t, 'n_recurrent_loops');
  if (loops !== undefined && loops > 1 && kinds && kvHeads !== undefined && headDim !== undefined) {
    const start = num(t, 'n_input_layers') ?? 0;
    const n = num(t, 'n_recurrent_layers') ?? kinds.length - start;
    const attn = kinds.slice(start, start + n).filter((k) => k === 'full' || k === 'sliding').length;
    extraBytesPerToken += attn * (loops - 1) * 2 * kvHeads * headDim * 2;
    estimate('recurrent-depth', `${n} layers run ${loops} times: ${attn} attention layers keep KV for each extra pass (2 bytes); the repeated passes' compute is not counted`);
  }
  const lookup = ['engram_layer_ids', 'engram_num_embeddings', 'ngram_vocab_size_base', 'ple_layer_ids'].filter((k) => present(t[k]));
  if (lookup.length > 0) {
    estimate('lookup-tables', `${lookup.join(', ')}: lookup tables counted as weights read in full every step`);
  }
  // Hyper-connections widen the residual stream only: their weights are in safetensors.total, and they keep no
  // per-sequence cache, so nothing the calculator sizes changes (stated, not silent).
  const hc = firstNum(t, ['hc_mult', 'hc_count']);
  if (hc !== undefined && hc > 1) notes.push(`hyper-connections (${hc} residual streams): weights counted in the total; no per-sequence cache`);

  const nativeQuant = parseNativeQuant(repo, sha, config, opts, missing, estimate);
  for (const e of opts.estimates ?? []) estimate(e.feature, e.detail);

  if (safetensorsTotal === null) missing.push('safetensors.total');
  if (!opts.origin) missing.push('origin (developer, country)');
  if (missing.length > 0) return { missing: [...new Set(missing)], notes };

  const source = hfSourceId(repo, sha);
  const verified = opts.verified ?? new Date().toISOString().slice(0, 10);
  // A packed checkpoint (native-other) counts stored elements: its base model's count is the parameter count.
  let totalParamsB: Model['totalParamsB'] = { value: (safetensorsTotal as number) / 1e9, unit: 'B', status: 'official', source, verified };
  const base = opts.baseParams;
  if (nativeQuant?.quant === 'native-other' && base && base.total > (safetensorsTotal as number)) {
    totalParamsB = {
      value: base.total / 1e9, unit: 'B', status: 'estimate', verified, evidence: [source],
      basis: `量化 checkpoint 的 safetensors 計數是打包後的元素數（${((safetensorsTotal as number) / 1e9).toFixed(2)}B），改用 model card 的 base model ${base.repo} 的參數量`,
    };
    estimate('native-quant', `packed checkpoint counts ${((safetensorsTotal as number) / 1e9).toFixed(2)}B elements: parameter count ${(base.total / 1e9).toFixed(2)}B taken from its base model ${base.repo}`);
  }
  // The config's expert sizes cannot exceed the parameter count; when they do the MoE layout is not what the formula
  // assumes, so every weight is counted as read every step (dense: the conservative side for speed).
  if (moe && layers !== undefined && hidden !== undefined) {
    const { experts, expertFfnDim, matrices = 3, width = hidden, layers: moeLayers = layers } = moe;
    const expertB = (experts * matrices * width * expertFfnDim * moeLayers) / 1e9;
    if (expertB >= totalParamsB.value) {
      estimate('moe-layout', `expert parameters from the config (${expertB.toFixed(1)}B) exceed the parameter count (${totalParamsB.value.toFixed(1)}B): every weight counted as read every step`);
      moe = undefined;
    }
  }
  const maxContext = firstNum(t, ['max_position_embeddings', 'model_max_length']);
  const candidate = {
    id: modelSlug(repo),
    name: repo.split('/').pop() ?? repo,
    hfRepo: repo,
    origin: opts.origin,
    ...(opts.base ? { baseModel: opts.base.repo } : {}),
    ...(opts.base?.origin ? { baseOrigin: opts.base.origin } : {}),
    totalParamsB,
    layers, heads, kvHeads, headDim, hidden,
    attention: mla ? 'mla' : 'gqa',
    ...(mla ? { mla } : {}),
    ...(layerGroups && layerGroups.length > 0 ? { layerGroups } : {}),
    ...(moe ? { moe } : {}),
    slidingWindow: mla ? null : window ?? null,
    ...(nativeQuant ? { nativeQuant } : {}),
    ...(extraBytesPerToken > 0 || extraStateBytes > 0 ? { extraCache: { bytesPerToken: extraBytesPerToken, stateBytes: extraStateBytes } } : {}),
    ...(estimates.length > 0 ? { estimates } : {}),
    ...(maxContext !== undefined ? { maxContext } : {}),
    vocabSize,
    ...(tieWordEmbeddings !== undefined ? { tieWordEmbeddings } : {}),
    ...(opts.license ? { license: opts.license } : {}),
    source,
    verified,
  };
  const r = ModelSchema.safeParse(candidate);
  if (!r.success) {
    return { missing: r.error.issues.map((i) => `invalid ${i.path.join('.') || 'model'}: ${i.message}`), notes };
  }
  return { model: r.data, missing: [], notes };
}

/**
 * Per-sequence state of one linear-attention layer, from the config's own sizes (an estimate until sourced; CLAUDE.md
 * "Goal for imported models"):
 * - Gated DeltaNet (Qwen3.5 / 3.8 keys): recurrent state linear_num_value_heads × linear_key_head_dim ×
 *   linear_value_head_dim at mamba_ssm_dtype (absent → 4 bytes), plus a conv state of conv_dim × linear_conv_kernel_dim
 *   at 2 bytes, conv_dim = 2 × linear_num_key_heads × linear_key_head_dim + linear_num_value_heads × linear_value_head_dim.
 * - KDA (`linear_attn_config` { num_heads, head_dim }): num_heads × head_dim × head_dim at 4 bytes, plus a conv state
 *   of 3 × num_heads × head_dim × short_conv_kernel_size (absent → 4) at 2 bytes.
 * Undefined when the config gives no sizes (the layers are then sized as full attention).
 */
function linearStateBytes(t: Obj, heads: number | undefined, headDim: number | undefined, estimate: Estimate): number | undefined {
  const nv = num(t, 'linear_num_value_heads');
  const nk = num(t, 'linear_num_key_heads') ?? nv;
  const dk = num(t, 'linear_key_head_dim');
  const dv = num(t, 'linear_value_head_dim') ?? dk;
  const dtype = t.mamba_ssm_dtype ?? t.mamba_ssm_cache_dtype;
  const elem = typeof dtype === 'string' && SSM_DTYPE_BYTES[dtype] !== undefined ? SSM_DTYPE_BYTES[dtype]! : 4;
  if (nv !== undefined && nk !== undefined && dk !== undefined && dv !== undefined) {
    const kernel = num(t, 'linear_conv_kernel_dim') ?? 4;
    const bytes = nv * dk * dv * elem + (2 * nk * dk + nv * dv) * kernel * 2;
    estimate('linear-attention', `Gated DeltaNet layers: state ${nv} × ${dk} × ${dv} at ${elem} bytes + conv state (2 × ${nk} × ${dk} + ${nv} × ${dv}) × ${kernel} at 2 bytes = ${bytes} bytes per layer`);
    return bytes;
  }
  const kda = isObj(t.linear_attn_config) ? t.linear_attn_config : undefined;
  const kh = (kda && num(kda, 'num_heads')) ?? (kda ? heads : undefined);
  const kd = (kda && num(kda, 'head_dim')) ?? (kda ? headDim : undefined);
  if (kh !== undefined && kd !== undefined) {
    const kernel = (kda && firstNum(kda, ['short_conv_kernel_size', 'conv_kernel_size'])) ?? 4;
    const bytes = kh * kd * kd * 4 + 3 * kh * kd * kernel * 2;
    estimate('linear-attention', `KDA layers: state ${kh} × ${kd} × ${kd} at 4 bytes + conv state 3 × ${kh} × ${kd} × ${kernel} at 2 bytes = ${bytes} bytes per layer`);
    return bytes;
  }
  if (Array.isArray(t.layer_types) && t.layer_types.includes('linear_attention')) {
    estimate('linear-attention', 'linear-attention layers without state sizes in the config: sized as full attention');
  }
  return undefined;
}

/** LFM2 short convolution: hidden_size × conv_L_cache at 2 bytes per layer (an estimate until sourced). */
function convStateBytes(t: Obj, hidden: number | undefined, estimate: Estimate): number | undefined {
  if (!(Array.isArray(t.layer_types) && t.layer_types.includes('conv'))) return undefined;
  const cache = num(t, 'conv_L_cache');
  if (hidden === undefined || cache === undefined) {
    estimate('short-conv', 'short-convolution layers without conv_L_cache: sized as full attention');
    return undefined;
  }
  const bytes = hidden * cache * 2;
  estimate('short-conv', `short-convolution layers: state hidden_size ${hidden} × conv_L_cache ${cache} at 2 bytes = ${bytes} bytes per layer`);
  return bytes;
}

/**
 * Per-block MoE (Nemotron puzzle `block_configs`): one MoE whose expert parameters equal the blocks' sum, with the
 * experts / top-k of the block that activates the largest share (the most parameters active per token: conservative).
 */
function heterogeneousMoe(blocks: Obj[], missing: string[], estimate: Estimate): Model['moe'] {
  const parsed = blocks.map((b) => ({
    experts: firstNum(b, ['n_routed_experts', 'num_experts']), topK: firstNum(b, ['num_experts_per_tok']), ffn: num(b, 'moe_intermediate_size'),
  }));
  if (parsed.some((p) => p.experts === undefined || p.topK === undefined || p.ffn === undefined)) {
    missing.push('block_configs: a MoE block without n_routed_experts / num_experts_per_tok / moe_intermediate_size');
    return undefined;
  }
  const ok = parsed as Array<{ experts: number; topK: number; ffn: number }>;
  const widest = ok.reduce((a, b) => (b.topK / b.experts > a.topK / a.experts ? b : a));
  const sum = ok.reduce((s, b) => s + b.experts * b.ffn, 0);
  const expertFfnDim = Math.max(1, Math.floor(sum / (widest.experts * ok.length)));
  estimate('heterogeneous-blocks', `${ok.length} MoE blocks with their own expert counts and widths: one MoE of ${widest.experts} experts, top-${widest.topK} (the largest active share), width ${expertFfnDim} (the blocks' total expert size)`);
  return { experts: widest.experts, topK: widest.topK, expertFfnDim, layers: ok.length };
}

/**
 * Native quantization (config.json quantization_config, else ModelOpt's hf_quant_config.json). A format the calculator
 * models maps to its quantization id; any other gets the `native-other` stand-in (config/quantization.yaml), an
 * estimate. Either way the weight memory is the checkpoint's own file size.
 */
function parseNativeQuant(
  repo: string, sha: string, config: Obj, opts: ParseOptions, missing: string[], estimate: Estimate,
): Model['nativeQuant'] {
  const qc = quantizationConfig(config, opts.hfQuantConfig);
  if (!qc) return undefined;
  let method: string;
  let quant: string;
  const v = isObj(qc.value) ? qc.value : {};
  if (qc.key === 'hf_quant_config.json') {
    const mo = modeloptNativeQuant(qc.value);
    method = 'modelopt';
    if ('missing' in mo) {
      quant = 'native-other';
      estimate('native-quant', `${mo.missing}: weight memory from the checkpoint files, compute as BF16`);
    } else quant = mo.quant;
  } else {
    method = typeof v.quant_method === 'string' ? v.quant_method : qc.key;
    const algo = typeof v.quant_algo === 'string' ? v.quant_algo.toUpperCase() : undefined;
    const exclude = [...(Array.isArray(v.exclude_modules) ? v.exclude_modules : []), ...(Array.isArray(v.ignore) ? v.ignore : [])];
    const expertDtype = typeof v.expert_dtype === 'string' ? v.expert_dtype : undefined;
    if (qc.key === 'quantization_config' && method === 'modelopt' && algo === 'FP8' && exclude.includes('lm_head')) {
      // ModelOpt FP8 written into config.json: the format modeloptNativeQuant accepts from hf_quant_config.json.
      quant = 'fp8';
    } else if (qc.key === 'quantization_config' && Object.hasOwn(NATIVE_QUANT_IDS, method) && (expertDtype === undefined || expertDtype === method)) {
      quant = NATIVE_QUANT_IDS[method]!;
    } else {
      quant = 'native-other';
      const what = [method, algo, expertDtype && `experts ${expertDtype}`].filter(Boolean).join(' ');
      estimate('native-quant', `quantization ${what}: weight memory from the checkpoint files, compute as BF16`);
    }
  }
  const bytes = opts.checkpointWeightBytes;
  if (bytes === undefined || bytes === null) {
    missing.push('checkpoint weight bytes (model.safetensors.index.json file sizes)');
    return undefined;
  }
  return {
    method, quant,
    checkpointWeightBytes: {
      value: bytes, unit: 'B', status: 'official', source: hfSourceId(repo, sha),
      verified: opts.verified ?? new Date().toISOString().slice(0, 10),
    },
  };
}
