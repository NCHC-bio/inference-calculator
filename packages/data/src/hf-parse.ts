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

export interface ParseResult {
  model?: Model;
  /** Human-readable names of every field that could not be read. Empty when `model` is set. */
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

/** Per-layer cache kind; `none` = layer keeps no per-sequence cache (MLP / MoE blocks). */
type LayerKind = 'full' | 'sliding' | 'mamba' | 'none';

/**
 * Field-name mapping for per-layer types, taken from the real configs in test/fixtures/hf:
 * - `layer_types` (gpt-oss, Gemma 4, Muse Glimmer): `full_attention` → full, `sliding_attention` → sliding.
 * - `layers_block_type` (Nemotron 3 / 3.5, NemotronH): `attention` → full, `mamba` → mamba, `moe` / `mlp` → none.
 * - `hybrid_override_pattern` (older NemotronH string form): `*` → full, `M` → mamba, `-` / `E` → none.
 * - `local_layer_ids` (Inkling): listed indices → sliding, every other layer index → full.
 * Anything else is reported as missing; it is never mapped by guess.
 */
const LAYER_TYPES: Record<string, LayerKind> = { full_attention: 'full', sliding_attention: 'sliding' };
const BLOCK_TYPES: Record<string, LayerKind> = { attention: 'full', mamba: 'mamba', moe: 'none', mlp: 'none' };
const PATTERN_CHARS: Record<string, LayerKind> = { '*': 'full', M: 'mamba', '-': 'none', E: 'none' };
/** `mamba_ssm_cache_dtype` (NemotronH) → bytes per SSM-state element. */
const SSM_DTYPE_BYTES: Record<string, number> = { float32: 4, bfloat16: 2, float16: 2 };

/** Returns per-layer kinds, or undefined when the config has no per-layer type field. */
function layerKinds(t: Obj, layers: number | undefined, missing: string[]): LayerKind[] | undefined {
  const mapList = (field: string, list: unknown[], table: Record<string, LayerKind>): LayerKind[] =>
    list.map((x) => {
      const k = typeof x === 'string' ? table[x] : undefined;
      if (k === undefined) missing.push(`${field}: unknown type ${JSON.stringify(x)}`);
      return k ?? 'none';
    });
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
 * Expert-MLP activations known to be gated (gate / up / down = 3 matrices, as core's expert
 * formula assumes): SwiGLU (`silu`, `swish`) and GeGLU (`gelu*`, Gemma).
 */
const GATED_ACTS = new Set(['silu', 'swish', 'gelu', 'gelu_pytorch_tanh', 'gelu_new']);

/**
 * Fail closed on MoE layouts core's expert formula does not model (Ruling R31a). Core counts routed
 * experts as experts × 3 × hidden × expertFfnDim × layers (spec §5.1), so it is only right when every
 * layer carries the same gated routed-expert MLP of width hidden → expertFfnDim → hidden. Reported as
 * missing (no model) instead:
 * - `moe_latent_size`: experts work in a smaller latent dimension, not `hidden` (Nemotron 3 / 3.5).
 * - a non-gated or unknown expert activation (`mlp_hidden_act` / `hidden_act` / `hidden_activation`,
 *   e.g. `relu2` = 2 matrices, Nemotron).
 * - dense MLP layers mixed with MoE layers: `dense_mlp_idx` (Inkling), `first_k_dense_replace` > 0,
 *   `moe_layer_freq` ≠ 1, non-empty `mlp_only_layers`, `decoder_sparse_step` > 1.
 * - `shared_expert_sink` (Inkling; semantics not documented in the config).
 * - MoE blocks on only a subset of the per-layer block list (`layers_block_type` / `hybrid_override_pattern`):
 *   the list length is then a block count, not the number of MoE layers.
 * Shared experts alone (`n_shared_experts`, e.g. Mistral Small 4 with `first_k_dense_replace: 0`) are
 * accepted: they are always active, so they belong to the non-routed remainder (total − routed experts)
 * that core already treats as always read and always computed.
 */
function unsupportedMoe(t: Obj, kinds: LayerKind[] | undefined, layers: number | undefined, missing: string[]): void {
  const latent = num(t, 'moe_latent_size');
  if (latent !== undefined) missing.push(`moe_latent_size ${latent} (latent MoE projection not supported)`);

  const actKey = ['mlp_hidden_act', 'hidden_act', 'hidden_activation'].find((k) => t[k] !== undefined && t[k] !== null);
  if (actKey !== undefined) {
    const act = t[actKey];
    if (typeof act !== 'string' || !GATED_ACTS.has(act)) {
      missing.push(`${actKey} ${JSON.stringify(act)} (non-gated or unknown expert activation not supported)`);
    }
  }

  if (t.dense_mlp_idx !== undefined && t.dense_mlp_idx !== null) {
    missing.push(`dense_mlp_idx ${JSON.stringify(t.dense_mlp_idx)} (dense MLP layers mixed with MoE not supported)`);
  }
  const firstDense = num(t, 'first_k_dense_replace');
  if (firstDense !== undefined && firstDense > 0) {
    missing.push(`first_k_dense_replace ${firstDense} (dense MLP layers mixed with MoE not supported)`);
  }
  const freq = num(t, 'moe_layer_freq');
  if (freq !== undefined && freq !== 1) missing.push(`moe_layer_freq ${freq} (MoE on a subset of layers not supported)`);
  if (Array.isArray(t.mlp_only_layers) && t.mlp_only_layers.length > 0) {
    missing.push('mlp_only_layers (dense MLP layers mixed with MoE not supported)');
  }
  const sparseStep = num(t, 'decoder_sparse_step');
  if (sparseStep !== undefined && sparseStep > 1) {
    missing.push(`decoder_sparse_step ${sparseStep} (MoE on a subset of layers not supported)`);
  }
  if (t.shared_expert_sink !== undefined && t.shared_expert_sink !== null && t.shared_expert_sink !== false) {
    missing.push('shared_expert_sink (not supported)');
  }

  const blocks: unknown[] | undefined = Array.isArray(t.layers_block_type)
    ? t.layers_block_type
    : typeof t.hybrid_override_pattern === 'string' ? [...t.hybrid_override_pattern] : undefined;
  if (blocks && kinds && layers !== undefined) {
    const moeBlocks = blocks.filter((b) => b === 'moe' || b === 'E').length;
    if (moeBlocks !== layers) {
      missing.push(`MoE on ${moeBlocks} of ${layers} per-layer blocks (MoE on a subset of blocks not supported)`);
    }
  }
}

/**
 * Parse a Hugging Face `config.json` into a Model (spec §5; plan Task 5 rules).
 * Multimodal configs are read from `text_config` (Gemma 4, Mistral 3.x, Muse Glimmer, Inkling)
 * or `llm_config` (Nemotron 3.5 VL). Any field that cannot be read is listed in `missing`
 * and no model is returned; nothing is guessed.
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
  const t: Obj = isObj(config.text_config) ? config.text_config : isObj(config.llm_config) ? config.llm_config : config;

  const hidden = num(t, 'hidden_size');
  if (hidden === undefined) missing.push('hidden_size');
  const heads = num(t, 'num_attention_heads');
  if (heads === undefined) missing.push('num_attention_heads');
  // HF convention: no num_key_value_heads means multi-head attention (kv = heads). Kept, but reported.
  const kvHeads = num(t, 'num_key_value_heads') ?? heads;
  if (num(t, 'num_key_value_heads') === undefined && heads !== undefined) {
    notes.push(`num_key_value_heads absent: kvHeads = num_attention_heads (${heads}), the Hugging Face convention for multi-head attention`);
  }

  let headDim = num(t, 'head_dim');
  if (headDim === undefined && hidden !== undefined && heads !== undefined) {
    if (Number.isInteger(hidden / heads)) {
      headDim = hidden / heads;
      notes.push(`head_dim absent: headDim = hidden_size ÷ num_attention_heads = ${hidden} ÷ ${heads} = ${headDim}`);
    } else missing.push('head_dim');
  }

  // NemotronH configs omit num_hidden_layers; the per-layer block list is the layer count.
  const declaredLayers = num(t, 'num_hidden_layers');
  const kinds = layerKinds(t, declaredLayers, missing);
  const layers = declaredLayers ?? kinds?.length;
  if (layers === undefined) missing.push('num_hidden_layers');
  else if (kinds && kinds.length !== layers) {
    missing.push(`per-layer types list ${kinds.length} layers but num_hidden_layers is ${layers}`);
  }

  // Gemma 4 small models can share KV across layers; KV accounting for that is not modelled.
  const shared = num(t, 'num_kv_shared_layers');
  if (shared !== undefined && shared > 0) missing.push('num_kv_shared_layers > 0 (KV sharing not supported)');

  // MLA (latent KV): kv_lora_rank + qk_rope_head_dim; the prefill (MHA) path also needs qk_nope_head_dim and
  // v_head_dim (Ruling R40). DeepSeek-style keys; Mistral's params.json uses the same names.
  const kvLoraRank = num(t, 'kv_lora_rank');
  let mla: Model['mla'];
  if (kvLoraRank !== undefined) {
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

  // MoE. Expert count: num_experts (Gemma 4) / num_local_experts (gpt-oss) / n_routed_experts (Nemotron, Mistral 4,
  // Inkling). Top-k: num_experts_per_tok / top_k_experts (Gemma 4). Expert FFN: moe_intermediate_size, else
  // intermediate_size (gpt-oss and Inkling keep the expert width there).
  const experts = firstNum(t, ['num_experts', 'num_local_experts', 'n_routed_experts']);
  let moe: Model['moe'];
  if (experts !== undefined) {
    const topK = firstNum(t, ['num_experts_per_tok', 'top_k_experts']);
    const expertFfnDim = firstNum(t, ['moe_intermediate_size', 'intermediate_size']);
    if (topK === undefined) missing.push('num_experts_per_tok');
    if (expertFfnDim === undefined) missing.push('moe_intermediate_size');
    if (topK !== undefined && expertFfnDim !== undefined) moe = { experts, topK, expertFfnDim };
    unsupportedMoe(t, kinds, layers, missing);
  }

  // Embedding size (spec §5.1: embedding / lm_head stay 16-bit under vLLM FP8 / AWQ). vocab_size is required;
  // tie_word_embeddings is optional (Mistral 3 text configs omit it) and absent means untied (conservative).
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
  // config's sliding_window (vllm/config/model.py L1612-L1614). With per-layer sliding types it is ambiguous: fail closed.
  if (t.use_sliding_window === false && window !== undefined) {
    if (kinds?.includes('sliding')) {
      missing.push('use_sliding_window false with sliding_attention layer types (ambiguous: not supported)');
    } else {
      notes.push(`use_sliding_window false: sliding_window ${window} ignored (every layer full attention)`);
      window = undefined;
    }
  }

  let layerGroups: LayerGroup[] | undefined;
  if (!kinds && window !== undefined && layers !== undefined) {
    // A window with no per-layer type field means every layer uses sliding-window attention.
    layerGroups = [{ kind: 'sliding', count: layers, kvHeads, headDim, window }];
  }
  if (kinds) {
    const counts = new Map<LayerKind, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    layerGroups = [];
    for (const [kind, count] of counts) {
      if (kind === 'none') continue;
      if (kind === 'full') {
        // Gemma 4 global layers: num_global_key_value_heads / global_head_dim; attention_k_eq_v (K and V share
        // one projection, see docs/research/open-models.md) applies to these global layers.
        const g: LayerGroup = {
          kind, count,
          kvHeads: num(t, 'num_global_key_value_heads') ?? kvHeads,
          headDim: num(t, 'global_head_dim') ?? headDim,
        };
        // A sliding / full hybrid may give its full layers their own dims (Gemma 4); without them the model's are used.
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
          if (stateBytesPerElem === undefined) missing.push(`mamba_ssm_cache_dtype: unknown dtype ${JSON.stringify(dtype)}`);
        }
        if (ssmHeads !== undefined && ssmHeadDim !== undefined && stateSize !== undefined && stateBytesPerElem !== undefined) {
          layerGroups.push({ kind, count, ssm: { heads: ssmHeads, headDim: ssmHeadDim, stateSize, stateBytesPerElem } });
        }
      }
    }
  }

  // Native quantization (config.json quantization_config, else ModelOpt's hf_quant_config.json): map the method, never
  // guess (fail closed).
  let nativeQuant: Model['nativeQuant'];
  const qc = quantizationConfig(config, opts.hfQuantConfig);
  if (qc) {
    let method: string | undefined;
    let quant: string | undefined;
    if (qc.key === 'hf_quant_config.json') {
      const mo = modeloptNativeQuant(qc.value);
      if ('missing' in mo) missing.push(mo.missing);
      else ({ method, quant } = mo);
    } else {
      method = isObj(qc.value) && typeof qc.value.quant_method === 'string' ? qc.value.quant_method : undefined;
      quant = method !== undefined && Object.hasOwn(NATIVE_QUANT_IDS, method) ? NATIVE_QUANT_IDS[method] : undefined;
      if (qc.key !== 'quantization_config') missing.push(`${qc.key} (native quantization not supported)`);
      else if (method === undefined) missing.push('quantization_config.quant_method');
      else if (quant === undefined) missing.push(`quantization_config.quant_method ${JSON.stringify(method)} (native quantization not supported)`);
    }
    const bytes = opts.checkpointWeightBytes;
    if (bytes === undefined || bytes === null) missing.push('checkpoint weight bytes (model.safetensors.index.json file sizes)');
    if (method !== undefined && quant !== undefined && typeof bytes === 'number') {
      nativeQuant = {
        method,
        quant,
        checkpointWeightBytes: {
          value: bytes, unit: 'B', status: 'official', source: hfSourceId(repo, sha),
          verified: opts.verified ?? new Date().toISOString().slice(0, 10),
        },
      };
    }
  }

  if (safetensorsTotal === null) missing.push('safetensors.total');
  if (!opts.origin) missing.push('origin (developer, country)');

  if (missing.length > 0) return { missing, notes };

  const source = hfSourceId(repo, sha);
  const verified = opts.verified ?? new Date().toISOString().slice(0, 10);
  const maxContext = firstNum(t, ['max_position_embeddings', 'model_max_length']);
  const candidate = {
    id: modelSlug(repo),
    name: repo.split('/').pop() ?? repo,
    hfRepo: repo,
    origin: opts.origin,
    ...(opts.base ? { baseModel: opts.base.repo } : {}),
    ...(opts.base?.origin ? { baseOrigin: opts.base.origin } : {}),
    totalParamsB: { value: (safetensorsTotal as number) / 1e9, unit: 'B', status: 'official', source, verified },
    layers, heads, kvHeads, headDim, hidden,
    attention: mla ? 'mla' : 'gqa',
    ...(mla ? { mla } : {}),
    ...(layerGroups && layerGroups.length > 0 ? { layerGroups } : {}),
    ...(moe ? { moe } : {}),
    slidingWindow: window ?? null,
    ...(nativeQuant ? { nativeQuant } : {}),
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
