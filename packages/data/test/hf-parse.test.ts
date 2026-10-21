import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkpointWeightBytes, parseHfConfig, quantizationConfig, type ParseOptions } from '../src/hf-parse';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/hf/${name}.json`, import.meta.url)), 'utf8'));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const opts = (developer: string, country: string, extra: Partial<ParseOptions> = {}): ParseOptions => ({
  origin: { developer, country },
  verified: '2026-10-19',
  ...extra,
});

describe('parseHfConfig', () => {
  it('phi-4: dense GQA, no moe, no layer groups', () => {
    const { model, missing } = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 14659507200, opts('Microsoft', 'US'));
    expect(missing).toEqual([]);
    expect(model).toMatchObject({ layers: 40, heads: 40, kvHeads: 10, headDim: 128, hidden: 5120, attention: 'gqa' });
    expect(model?.moe).toBeUndefined();
    expect(model?.layerGroups).toBeUndefined();
    expect(model?.slidingWindow).toBeNull();
    expect(model?.maxContext).toBe(16384);
  });

  it('phi-4: id, name, source and provenance', () => {
    const { model } = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 14659507200, opts('Microsoft', 'US'));
    expect(model?.id).toBe('phi-4');
    expect(model?.name).toBe('phi-4');
    expect(model?.hfRepo).toBe('microsoft/phi-4');
    expect(model?.source).toBe('hf:microsoft/phi-4@0123456');
    expect(model?.verified).toBe('2026-10-19');
    expect(model?.origin).toEqual({ developer: 'Microsoft', country: 'US' });
    expect(model?.totalParamsB).toMatchObject({ status: 'official', source: 'hf:microsoft/phi-4@0123456' });
    expect(model?.totalParamsB.value).toBeCloseTo(14.66, 2);
  });

  it('gpt-oss-120b: MoE in intermediate_size, sliding/full groups, native-quant param total', () => {
    const { model, missing } = parseHfConfig('openai/gpt-oss-120b', SHA, fixture('gpt-oss-120b'), 116829156672,
      opts('OpenAI', 'US', { checkpointWeightBytes: 65248893184 }));
    expect(missing).toEqual([]);
    expect(model).toMatchObject({ layers: 36, heads: 64, kvHeads: 8, headDim: 64, hidden: 2880 });
    expect(model?.moe).toEqual({ experts: 128, topK: 4, expertFfnDim: 2880 });
    expect(model?.layerGroups).toEqual([
      { kind: 'sliding', count: 18, kvHeads: 8, headDim: 64, window: 128 },
      { kind: 'full', count: 18, kvHeads: 8, headDim: 64 },
    ]);
    expect(model?.slidingWindow).toBe(128);
    expect(model?.totalParamsB.value).toBeCloseTo(116.83, 2);
  });

  it('gemma-4-31b-it: per-type kv heads / head dim from text_config, k=v on global layers', () => {
    const { model, missing } = parseHfConfig('google/gemma-4-31B-it', SHA, fixture('gemma-4-31b-it'), 31273088876, opts('Google', 'US'));
    expect(missing).toEqual([]);
    expect(model?.id).toBe('gemma-4-31b-it');
    expect(model?.layers).toBe(60);
    expect(model?.layerGroups).toContainEqual({ kind: 'sliding', count: 50, kvHeads: 16, headDim: 256, window: 1024 });
    expect(model?.layerGroups).toContainEqual({ kind: 'full', count: 10, kvHeads: 4, headDim: 512, kEqualsV: true });
    expect(model?.moe).toBeUndefined();
  });

  it('nemotron-3.5-super: fails closed on latent MoE, relu2 experts and MoE on a subset of blocks (Ruling R31)', () => {
    const r = parseHfConfig(
      'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16', SHA, fixture('nemotron-3.5-super'), 124453395976,
      opts('NVIDIA', 'US'),
    );
    expect(r.model).toBeUndefined();
    expect(r.missing).toEqual([
      'moe_latent_size 1024 (latent MoE projection not supported)',
      'mlp_hidden_act "relu2" (non-gated or unknown expert activation not supported)',
      'MoE on 40 of 88 per-layer blocks (MoE on a subset of blocks not supported)',
    ]);
  });

  it('nemotron-3.5-super block list without MoE keys: 8 attention layers, mamba group, MoE / MLP blocks carry no cache', () => {
    const cfg = structuredClone(fixture('nemotron-3.5-super')) as { llm_config: Record<string, unknown> };
    for (const k of ['n_routed_experts', 'num_experts_per_tok', 'moe_intermediate_size', 'moe_latent_size']) delete cfg.llm_config[k];
    const { model, missing } = parseHfConfig(
      'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16', SHA, cfg, 124453395976, opts('NVIDIA', 'US'),
    );
    expect(missing).toEqual([]);
    expect(model?.layers).toBe(88);
    expect(model?.layerGroups).toContainEqual({ kind: 'full', count: 8, kvHeads: 2, headDim: 128 });
    expect(model?.layerGroups).toContainEqual({ kind: 'mamba', count: 40, ssm: { heads: 128, headDim: 64, stateSize: 128, stateBytesPerElem: 4 } });
    expect(model?.layerGroups).toHaveLength(2);
    expect(model?.moe).toBeUndefined();
  });

  it('inkling-small: fails closed on dense_mlp_idx and shared_expert_sink (Ruling R31)', () => {
    const r = parseHfConfig('thinkingmachines/Inkling-Small', SHA, fixture('inkling-small'), 265956439090, opts('Thinking Machines', 'US'));
    expect(r.model).toBeUndefined();
    expect(r.missing).toEqual([
      'dense_mlp_idx 2 (dense MLP layers mixed with MoE not supported)',
      'shared_expert_sink (not supported)',
    ]);
  });

  it('inkling-small without MoE keys: local_layer_ids select sliding layers with swa_* dims', () => {
    const cfg = structuredClone(fixture('inkling-small')) as Record<string, unknown>;
    const t = (cfg.text_config ?? cfg) as Record<string, unknown>;
    for (const k of ['n_routed_experts', 'num_experts_per_tok']) delete t[k];
    const { model, missing } = parseHfConfig('thinkingmachines/Inkling-Small', SHA, cfg, 265956439090, opts('Thinking Machines', 'US'));
    expect(missing).toEqual([]);
    expect(model?.layers).toBe(42);
    expect(model?.layerGroups).toEqual([
      { kind: 'sliding', count: 35, kvHeads: 8, headDim: 128, window: 512 },
      { kind: 'full', count: 7, kvHeads: 8, headDim: 128 },
    ]);
    expect(model?.moe).toBeUndefined();
    expect(model?.maxContext).toBe(1048576);
    expect(model?.slidingWindow).toBe(512);
  });

  it('MoE fail-closed keys are each reported; shared experts with all-MoE layers are accepted', () => {
    const base = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 128,
      n_routed_experts: 16, num_experts_per_tok: 2, moe_intermediate_size: 256, hidden_act: 'silu',
    };
    const miss = (extra: Record<string, unknown>) => parseHfConfig('example/moe', SHA, { ...base, ...extra }, 1e9, opts('Example Lab', 'US')).missing;
    expect(miss({})).toEqual([]);
    expect(miss({ n_shared_experts: 1, first_k_dense_replace: 0 })).toEqual([]);
    expect(miss({ first_k_dense_replace: 1 })).toEqual(['first_k_dense_replace 1 (dense MLP layers mixed with MoE not supported)']);
    expect(miss({ moe_layer_freq: 2 })).toEqual(['moe_layer_freq 2 (MoE on a subset of layers not supported)']);
    expect(miss({ mlp_only_layers: [0] })).toEqual(['mlp_only_layers (dense MLP layers mixed with MoE not supported)']);
    expect(miss({ decoder_sparse_step: 2 })).toEqual(['decoder_sparse_step 2 (MoE on a subset of layers not supported)']);
    expect(miss({ hidden_act: 'relu2' })).toEqual(['hidden_act "relu2" (non-gated or unknown expert activation not supported)']);
    expect(miss({ moe_latent_size: 128 })).toEqual(['moe_latent_size 128 (latent MoE projection not supported)']);
    expect(miss({ moe_latent_size: null })).toEqual([]);
    // Every block MoE (pattern 'EEEE'): the block count is the MoE layer count, accepted.
    expect(miss({ hybrid_override_pattern: 'EEEE' })).toEqual([]);
    expect(miss({ hybrid_override_pattern: 'E*EE' })).toEqual(['MoE on 3 of 4 per-layer blocks (MoE on a subset of blocks not supported)']);
  });

  it('mla-synthetic: attention mla with kv_lora_rank and rope dim', () => {
    const { model, missing } = parseHfConfig('example/mla-synthetic', SHA, fixture('mla-synthetic'), 1e9, opts('Example Lab', 'US'));
    expect(missing).toEqual([]);
    expect(model?.attention).toBe('mla');
    expect(model?.mla).toEqual({ kvLoraRank: 256, qkRopeHeadDim: 32, qkNopeHeadDim: 96, vHeadDim: 112 });
  });

  it('MLA without qk_nope_head_dim / v_head_dim is missing them (the prefill FLOPs need both; Ruling R40)', () => {
    const cfg = { ...(fixture('mla-synthetic') as Record<string, unknown>) };
    delete cfg.qk_nope_head_dim;
    delete cfg.v_head_dim;
    const { model, missing } = parseHfConfig('example/mla-synthetic', SHA, cfg, 1e9, opts('Example Lab', 'US'));
    expect(model).toBeUndefined();
    expect(missing).toEqual(['qk_nope_head_dim', 'v_head_dim']);
  });

  it('multimodal-text-config: layers read from text_config', () => {
    const { model, missing } = parseHfConfig(
      'mistralai/Mistral-Small-3.1-24B-Instruct-2503', SHA, fixture('multimodal-text-config'), 24011361280,
      opts('Mistral AI', 'FR', { base: { repo: 'mistralai/Mistral-Small-3.1-24B-Base-2503', origin: { developer: 'Mistral AI', country: 'FR' } } }),
    );
    expect(missing).toEqual([]);
    expect(model).toMatchObject({ layers: 40, heads: 32, kvHeads: 8, headDim: 128, hidden: 5120 });
    expect(model?.baseModel).toBe('mistralai/Mistral-Small-3.1-24B-Base-2503');
    expect(model?.baseOrigin).toEqual({ developer: 'Mistral AI', country: 'FR' });
  });

  it('a base without origin is recorded as lineage only (the card base_model)', () => {
    const { model, missing } = parseHfConfig(
      'mistralai/Mistral-Small-3.1-24B-Instruct-2503', SHA, fixture('multimodal-text-config'), 24011361280,
      opts('Mistral AI', 'FR', { base: { repo: 'mistralai/Mistral-Small-3.1-24B-Base-2503' } }),
    );
    expect(missing).toEqual([]);
    expect(model?.baseModel).toBe('mistralai/Mistral-Small-3.1-24B-Base-2503');
    expect(model?.baseOrigin).toBeUndefined();
  });

  it('missing-fields: lists num_hidden_layers and returns no model', () => {
    const r = parseHfConfig('example/missing-fields', SHA, fixture('missing-fields'), 1e9, opts('Example Lab', 'US'));
    expect(r.missing).toContain('num_hidden_layers');
    expect(r.model).toBeUndefined();
  });

  it('missing safetensors total and origin are reported, never guessed', () => {
    const r = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), null);
    expect(r.missing).toContain('safetensors.total');
    expect(r.missing).toContain('origin (developer, country)');
    expect(r.model).toBeUndefined();
  });

  it('experts without top-k is missing', () => {
    const cfg = { hidden_size: 1024, num_hidden_layers: 2, num_attention_heads: 8, num_local_experts: 8, intermediate_size: 512 };
    const r = parseHfConfig('example/moe-no-topk', SHA, cfg, 1e9, opts('Example Lab', 'US'));
    expect(r.missing).toContain('num_experts_per_tok');
    expect(r.model).toBeUndefined();
  });

  it('unknown layer type is missing, not guessed', () => {
    const cfg = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 2, num_attention_heads: 8,
      layer_types: ['full_attention', 'chunked_attention'],
    };
    const r = parseHfConfig('example/unknown-layer', SHA, cfg, 1e9, opts('Example Lab', 'US'));
    expect(r.missing).toContain('layer_types: unknown type "chunked_attention"');
    expect(r.model).toBeUndefined();
  });

  it('implicit defaults are reported as notes, never silent (review M5)', () => {
    // phi-4 omits head_dim: hidden ÷ heads is an implicit default too, so it is noted (final-review M21).
    expect(parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 14659507200, opts('Microsoft', 'US')).notes).toEqual([
      'head_dim absent: headDim = hidden_size ÷ num_attention_heads = 5120 ÷ 40 = 128',
    ]);
    // Every field explicit: no notes.
    const explicit = { ...(fixture('phi-4') as Record<string, unknown>), head_dim: 128 };
    expect(parseHfConfig('microsoft/phi-4', SHA, explicit, 14659507200, opts('Microsoft', 'US')).notes).toEqual([]);
    // No num_key_value_heads: the HF convention (multi-head attention, kv = heads) is kept, but reported.
    const mha = { hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 4, num_attention_heads: 8, head_dim: 128, tie_word_embeddings: false };
    const r = parseHfConfig('example/mha', SHA, mha, 1e9, opts('Example Lab', 'US'));
    expect(r.model?.kvHeads).toBe(8);
    expect(r.notes).toEqual(['num_key_value_heads absent: kvHeads = num_attention_heads (8), the Hugging Face convention for multi-head attention']);
    // Mamba layers without mamba_ssm_cache_dtype: 2 bytes per state element, reported.
    const hybrid = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 2, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 128,
      hybrid_override_pattern: 'M*', mamba_num_heads: 16, mamba_head_dim: 64, ssm_state_size: 128, tie_word_embeddings: false,
    };
    expect(parseHfConfig('example/hybrid', SHA, hybrid, 1e9, opts('Example Lab', 'US')).notes).toEqual([
      'mamba_ssm_cache_dtype absent: SSM state assumed 2 bytes per element (16-bit model dtype default)',
    ]);
    expect(parseHfConfig('example/hybrid', SHA, { ...hybrid, mamba_ssm_cache_dtype: 'float32' }, 1e9, opts('Example Lab', 'US')).notes)
      .toEqual([]);
  });

  it('hybrid_override_pattern: M = mamba, * = attention, - / E carry no cache', () => {
    const cfg = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 6, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 128,
      hybrid_override_pattern: 'M-M*EM', mamba_num_heads: 16, mamba_head_dim: 64, ssm_state_size: 128,
    };
    const { model, missing } = parseHfConfig('example/hybrid', SHA, cfg, 1e9, opts('Example Lab', 'US'));
    expect(missing).toEqual([]);
    expect(model?.layerGroups).toEqual([
      { kind: 'mamba', count: 3, ssm: { heads: 16, headDim: 64, stateSize: 128, stateBytesPerElem: 2 } },
      { kind: 'full', count: 1, kvHeads: 2, headDim: 128 },
    ]);
  });

  it('mamba_ssm_cache_dtype: bfloat16/float16 → 2, unknown dtype is missing', () => {
    const base = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 2, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 128,
      hybrid_override_pattern: 'M*', mamba_num_heads: 16, mamba_head_dim: 64, ssm_state_size: 128,
    };
    const bytes = (dtype: string) =>
      parseHfConfig('example/hybrid', SHA, { ...base, mamba_ssm_cache_dtype: dtype }, 1e9, opts('Example Lab', 'US'))
        .model?.layerGroups?.[0]?.ssm?.stateBytesPerElem;
    expect(bytes('float32')).toBe(4);
    expect(bytes('bfloat16')).toBe(2);
    expect(bytes('float16')).toBe(2);
    const r = parseHfConfig('example/hybrid', SHA, { ...base, mamba_ssm_cache_dtype: 'int3' }, 1e9, opts('Example Lab', 'US'));
    expect(r.missing).toContain('mamba_ssm_cache_dtype: unknown dtype "int3"');
    expect(r.model).toBeUndefined();
  });

  it('sliding_window without a per-layer type field: one sliding group over all layers', () => {
    const cfg = {
      hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 12, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 128,
      sliding_window: 4096,
    };
    const { model, missing } = parseHfConfig('example/all-sliding', SHA, cfg, 1e9, opts('Example Lab', 'US'));
    expect(missing).toEqual([]);
    expect(model?.layerGroups).toEqual([{ kind: 'sliding', count: 12, kvHeads: 2, headDim: 128, window: 4096 }]);
    expect(model?.slidingWindow).toBe(4096);
  });

  it('base model without base origin is not missing', () => {
    const r = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 1e9, opts('Microsoft', 'US', { base: { repo: 'x/y' } }));
    expect(r.missing).toEqual([]);
    expect(r.model?.baseModel).toBe('x/y');
  });
});

describe('native quantization (quantization_config) and checkpoint bytes', () => {
  // HF revision API (blobs=true) + model.safetensors.index.json at the pinned commits (fixtures/hf/README.md).
  const GPT_OSS_BYTES = 65248893184;
  const MS4_BYTES = 120922973936;
  const siblings = (name: string) => (fixture(`${name}.revision`) as { siblings: unknown }).siblings;

  it('checkpointWeightBytes sums the files in the index; original/ and consolidated-* copies are excluded', () => {
    const g = checkpointWeightBytes(fixture('gpt-oss-120b.index'), siblings('gpt-oss-120b'));
    expect(g).toEqual({ bytes: GPT_OSS_BYTES, missing: [] });
    const m = checkpointWeightBytes(fixture('mistral-small-4-119b-2603.index'), siblings('mistral-small-4-119b-2603'));
    expect(m).toEqual({ bytes: MS4_BYTES, missing: [] });
    // Whole files (safetensors headers included): slightly above the index's tensor total_size.
    const meta = (fixture('gpt-oss-120b.index') as { metadata: { total_size: number } }).metadata;
    expect(g.bytes! - meta.total_size).toBeGreaterThan(0);
    expect(g.bytes! - meta.total_size).toBeLessThan(1e6);
  });

  it('checkpointWeightBytes: no index → model.safetensors; an unsized file is missing', () => {
    expect(checkpointWeightBytes(null, [{ rfilename: 'model.safetensors', size: 10, lfs: { size: 1234 } }])).toEqual({ bytes: 1234, missing: [] });
    expect(checkpointWeightBytes(null, [{ rfilename: 'other.bin', size: 5 }]).missing).toEqual(['checkpoint file size: model.safetensors']);
    const idx = { weight_map: { a: 'x-1.safetensors', b: 'x-2.safetensors', c: 'x-1.safetensors' } };
    expect(checkpointWeightBytes(idx, [{ rfilename: 'x-1.safetensors', size: 3 }, { rfilename: 'x-2.safetensors', size: 4 }]).bytes).toBe(7);
    expect(checkpointWeightBytes(idx, [{ rfilename: 'x-1.safetensors', size: 3 }]).missing).toEqual(['checkpoint file size: x-2.safetensors']);
    expect(checkpointWeightBytes({}, []).missing).toEqual(['model.safetensors.index.json: no weight_map']);
  });

  it('quantizationConfig: top level, text_config / llm_config, compression_config; absent for BF16 checkpoints', () => {
    expect(quantizationConfig(fixture('gpt-oss-120b'))?.key).toBe('quantization_config');
    expect(quantizationConfig(fixture('phi-4'))).toBeUndefined();
    expect(quantizationConfig({ text_config: { quantization_config: { quant_method: 'fp8' } } })?.value).toEqual({ quant_method: 'fp8' });
    expect(quantizationConfig({ llm_config: { quantization_config: { quant_method: 'fp8' } } })).toBeDefined();
    expect(quantizationConfig({ compression_config: { format: 'x' } })?.key).toBe('compression_config');
  });

  it('gpt-oss-120b: nativeQuant mxfp4 with the exact checkpoint bytes, sourced to the pinned commit', () => {
    const { model, missing } = parseHfConfig('openai/gpt-oss-120b', SHA, fixture('gpt-oss-120b'), 116829156672,
      opts('OpenAI', 'US', { checkpointWeightBytes: GPT_OSS_BYTES }));
    expect(missing).toEqual([]);
    expect(model?.nativeQuant).toEqual({
      method: 'mxfp4', quant: 'mxfp4',
      checkpointWeightBytes: { value: GPT_OSS_BYTES, unit: 'B', status: 'official', source: 'hf:openai/gpt-oss-120b@0123456', verified: '2026-10-19' },
    });
  });

  it('mistral-small-4: top-level quantization_config fp8 → nativeQuant fp8', () => {
    const { model, missing } = parseHfConfig('mistralai/Mistral-Small-4-119B-2603', SHA, fixture('mistral-small-4-119b-2603'), 119401317952,
      opts('Mistral AI', 'FR', { checkpointWeightBytes: MS4_BYTES }));
    expect(missing).toEqual([]);
    expect(model?.attention).toBe('mla');
    // DeepSeek-style keys in text_config (the Mistral-format params.json uses the same names).
    expect(model?.mla).toEqual({ kvLoraRank: 256, qkRopeHeadDim: 64, qkNopeHeadDim: 64, vHeadDim: 128 });
    expect(model?.nativeQuant).toMatchObject({ method: 'fp8', quant: 'fp8', checkpointWeightBytes: { value: MS4_BYTES, status: 'official' } });
  });

  it('a quantized checkpoint without its byte size is missing (never sized as totalParams × bytes/param)', () => {
    const r = parseHfConfig('openai/gpt-oss-120b', SHA, fixture('gpt-oss-120b'), 116829156672, opts('OpenAI', 'US'));
    expect(r.model).toBeUndefined();
    expect(r.missing).toEqual(['checkpoint weight bytes (model.safetensors.index.json file sizes)']);
  });

  it('an unknown quant_method, a missing quant_method or compression_config fails closed', () => {
    const cfg = (qc: Record<string, unknown>) => ({ ...(fixture('phi-4') as Record<string, unknown>), ...qc });
    const miss = (qc: Record<string, unknown>) =>
      parseHfConfig('microsoft/phi-4', SHA, cfg(qc), 14659507200, opts('Microsoft', 'US', { checkpointWeightBytes: 1e9 })).missing;
    expect(miss({ quantization_config: { quant_method: 'gptq', bits: 4 } })).toEqual(['quantization_config.quant_method "gptq" (native quantization not supported)']);
    expect(miss({ quantization_config: { bits: 4 } })).toEqual(['quantization_config.quant_method']);
    expect(miss({ compression_config: { format: 'pack-quantized' } })).toEqual(['compression_config (native quantization not supported)']);
    // Inherited object keys are not methods.
    expect(miss({ quantization_config: { quant_method: 'toString' } })).toEqual(['quantization_config.quant_method "toString" (native quantization not supported)']);
  });

  describe('ModelOpt hf_quant_config.json (no quantization_config in config.json)', () => {
    // nvidia/Llama-3.3-70B-Instruct-FP8 @ fde04ee: ModelOpt 0.27.1, quant_algo FP8, exclude_modules [lm_head].
    const LLAMA_BYTES = 72656585760;
    const hq = () => structuredClone(fixture('llama-3.3-70b-instruct-fp8.hf_quant_config')) as Record<string, any>;
    const parse = (hfQuantConfig: unknown, extra: Partial<ParseOptions> = {}) =>
      parseHfConfig('nvidia/Llama-3.3-70B-Instruct-FP8', SHA, fixture('llama-3.3-70b-instruct-fp8'), 70553706496,
        opts('NVIDIA', 'US', { checkpointWeightBytes: LLAMA_BYTES, hfQuantConfig, ...extra }));

    it('checkpointWeightBytes sums the 15 safetensors files of the index', () => {
      expect(checkpointWeightBytes(fixture('llama-3.3-70b-instruct-fp8.index'), siblings('llama-3.3-70b-instruct-fp8')))
        .toEqual({ bytes: LLAMA_BYTES, missing: [] });
    });

    it('quantizationConfig falls back to hf_quant_config.json the way vLLM does (config.json first)', () => {
      expect(quantizationConfig(fixture('llama-3.3-70b-instruct-fp8'))).toBeUndefined();
      expect(quantizationConfig(fixture('llama-3.3-70b-instruct-fp8'), hq())?.key).toBe('hf_quant_config.json');
      expect(quantizationConfig(fixture('gpt-oss-120b'), hq())?.key).toBe('quantization_config');
    });

    it('producer modelopt, quant_algo FP8, lm_head excluded → nativeQuant modelopt / fp8 with the exact bytes', () => {
      const { model, missing } = parse(hq());
      expect(missing).toEqual([]);
      expect(model?.nativeQuant).toEqual({
        method: 'modelopt', quant: 'fp8',
        checkpointWeightBytes: { value: LLAMA_BYTES, unit: 'B', status: 'official', source: 'hf:nvidia/Llama-3.3-70B-Instruct-FP8@0123456', verified: '2026-10-19' },
      });
      expect(model).toMatchObject({ layers: 80, heads: 64, kvHeads: 8, headDim: 128, hidden: 8192, vocabSize: 128256, tieWordEmbeddings: false });
    });

    it('without hf_quant_config.json the importer would size it as BF16; with a quantized lm_head or another algo it fails closed', () => {
      const lmHeadQuantized = hq();
      lmHeadQuantized.quantization.exclude_modules = [];
      expect(parse(lmHeadQuantized).missing).toEqual([
        'hf_quant_config.json exclude_modules without lm_head (an FP8 lm_head is not modelled: embedding / lm_head are sized 16-bit)',
      ]);
      const nvfp4 = hq();
      nvfp4.quantization.quant_algo = 'NVFP4';
      expect(parse(nvfp4).missing).toEqual(['hf_quant_config.json quant_algo "NVFP4" (native quantization not supported)']);
      const other = hq();
      other.producer.name = 'someone-else';
      expect(parse(other).missing).toEqual(['hf_quant_config.json producer "someone-else" (native quantization not supported)']);
      expect(parse(hq(), { checkpointWeightBytes: null }).missing).toEqual(['checkpoint weight bytes (model.safetensors.index.json file sizes)']);
    });
  });

  it('a BF16 checkpoint has no nativeQuant and needs no checkpoint bytes', () => {
    const { model, missing } = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 14659507200, opts('Microsoft', 'US'));
    expect(missing).toEqual([]);
    expect(model?.nativeQuant).toBeUndefined();
  });

  it('vocab_size and tie_word_embeddings (embedding width, review): text_config first, absent tie stays unset', () => {
    const phi = parseHfConfig('microsoft/phi-4', SHA, fixture('phi-4'), 14659507200, opts('Microsoft', 'US')).model!;
    expect(phi.vocabSize).toBe(100352);
    expect(phi.tieWordEmbeddings).toBe(false);
    const gemma = parseHfConfig('google/gemma-4-31B-it', SHA, fixture('gemma-4-31b-it'), 31273088876, opts('Google', 'US')).model!;
    expect(gemma.vocabSize).toBe(262144);
    expect(gemma.tieWordEmbeddings).toBe(true);
    const ms31 = parseHfConfig(
      'mistralai/Mistral-Small-3.1-24B-Instruct-2503', SHA, fixture('multimodal-text-config'), 24011361280,
      opts('Mistral AI', 'FR', { base: { repo: 'mistralai/Mistral-Small-3.1-24B-Base-2503', origin: { developer: 'Mistral AI', country: 'FR' } } }),
    ).model!;
    expect(ms31.vocabSize).toBe(131072);
    // Absent in the config: the text config class default (MistralConfig: untied) applies, and is noted (final-review M21).
    expect(ms31.tieWordEmbeddings).toBe(false);
    const noVocab = { hidden_size: 1024, num_hidden_layers: 2, num_attention_heads: 8 };
    expect(parseHfConfig('example/no-vocab', SHA, noVocab, 1e9, opts('Example Lab', 'US')).missing).toContain('vocab_size');
  });
});

describe('importer notes every implicit default and honours use_sliding_window (final-review M21, M22)', () => {
  const base = { hidden_size: 1024, vocab_size: 32000, num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, tie_word_embeddings: false };
  const run = (cfg: Record<string, unknown>, extra: Partial<ParseOptions> = {}) => parseHfConfig('example/m', SHA, cfg, 1e9, opts('Example Lab', 'US', extra));
  it('head_dim absent: hidden ÷ heads, noted', () => {
    const r = run(base);
    expect(r.model?.headDim).toBe(128);
    expect(r.notes).toEqual(['head_dim absent: headDim = hidden_size ÷ num_attention_heads = 1024 ÷ 8 = 128']);
  });
  it('full layers of a sliding / full hybrid without num_global_key_value_heads / global_head_dim use the model values, noted', () => {
    const cfg = { ...base, head_dim: 128, sliding_window: 512, layer_types: ['sliding_attention', 'full_attention', 'sliding_attention', 'full_attention'] };
    const r = run(cfg);
    expect(r.model?.layerGroups?.find((g) => g.kind === 'full')).toMatchObject({ kvHeads: 2, headDim: 128 });
    expect(r.notes).toEqual([
      'full-attention layers: num_global_key_value_heads / global_head_dim absent, so the model num_key_value_heads (2) and head_dim (128) are used',
    ]);
    expect(run({ ...cfg, num_global_key_value_heads: 1, global_head_dim: 256 }).notes).toEqual([]);
  });
  it('tie_word_embeddings absent: the checkpoint index decides, else a verified class default, else untied (conservative)', () => {
    const { tie_word_embeddings: _t, ...noTie } = { ...base, head_dim: 128 };
    const withHead = run(noTie, { weightNames: ['model.embed_tokens.weight', 'lm_head.weight'] });
    expect(withHead.model?.tieWordEmbeddings).toBe(false);
    expect(withHead.notes.join('\n')).toContain('lm_head.weight');
    const noHead = run(noTie, { weightNames: ['model.embed_tokens.weight', 'model.layers.0.mlp.up_proj.weight'] });
    expect(noHead.model?.tieWordEmbeddings).toBe(true);
    const mistral = run({ ...noTie, model_type: 'mistral' });
    expect(mistral.model?.tieWordEmbeddings).toBe(false);
    expect(mistral.notes.join('\n')).toContain('configuration_mistral.py');
    const unknown = run({ ...noTie, model_type: 'somethingnew' });
    expect(unknown.model?.tieWordEmbeddings).toBe(false);
    expect(unknown.notes.join('\n')).toContain('conservative');
  });
  it('use_sliding_window false: the window is ignored (transformers sets it to None); with sliding layer types it fails closed', () => {
    const cfg = { ...base, head_dim: 128, sliding_window: 4096, use_sliding_window: false };
    const r = run(cfg);
    expect(r.missing).toEqual([]);
    expect(r.model?.layerGroups).toBeUndefined();
    expect(r.model?.slidingWindow).toBeNull();
    expect(r.notes.join('\n')).toContain('use_sliding_window false');
    const amb = run({ ...cfg, layer_types: ['sliding_attention', 'full_attention', 'sliding_attention', 'full_attention'] });
    expect(amb.model).toBeUndefined();
    expect(amb.missing.join('\n')).toContain('use_sliding_window false');
    // sliding_window 0 means disabled (vLLM converts 0 to None).
    const zero = run({ ...base, head_dim: 128, sliding_window: 0 });
    expect(zero.model?.slidingWindow).toBeNull();
    expect(zero.model?.layerGroups).toBeUndefined();
  });
});

