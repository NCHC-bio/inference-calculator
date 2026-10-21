import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeParamsB, expertParamsTotalB } from '@nchc/core';
import { BundleSchema, type Bundle } from '@nchc/schema';
import { loadConfig } from '../src/load';
import { validateConfig } from '../src/validate';

const configDir = fileURLToPath(new URL('../../../config', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const result = validateConfig(loadConfig(configDir));
const b = result.bundle as Bundle;

type SV = {
  value: unknown; status: string; source?: string; evidence?: string[]; inputs?: string[];
  basis?: string; formula?: string; sources?: string[]; conflict?: string;
};
const expectSV = (v: SV | undefined, value: unknown, status: string, ref?: string) => {
  expect(v, `missing value, expected ${String(value)}`).toBeDefined();
  expect(v!.value).toBe(value);
  expect(v!.status).toBe(status);
  if (ref === undefined) return;
  if (status === 'estimate') expect(v!.evidence).toContain(ref);
  else if (status === 'derived') expect(v!.inputs).toContain(ref);
  else expect(v!.source).toBe(ref);
};

/** Collect every sourced value (an object with `status` and `verified`) in the bundle. */
function sourcedValues(node: unknown, path: string, out: Array<{ path: string; v: SV }>) {
  if (Array.isArray(node)) node.forEach((x, i) => sourcedValues(x, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.status === 'string' && typeof o.verified === 'string') out.push({ path, v: o as unknown as SV });
    for (const [k, x] of Object.entries(o)) sourcedValues(x, path ? `${path}.${k}` : k, out);
  }
  return out;
}

describe('config values (Task 3 table)', () => {
  it('validates with no errors', () => {
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(b).toBeDefined();
    expect(b.meta.dataVersion).toBe('2026-10-19');
  });

  it('a catalog model whose publisher country is excluded (CN, HK or MO) fails the build', () => {
    const raw = loadConfig(configDir);
    const m = raw.models[0]!;
    for (const country of ['CN', 'HK', 'MO']) {
      const data = { ...(m.data as Record<string, unknown>), origin: { developer: 'X', country } };
      const e = validateConfig({ ...raw, models: [{ ...m, data }, ...raw.models.slice(1)] }).issues.filter((i) => i.level === 'error');
      expect(e.some((i) => i.message.includes('policy') && i.path.endsWith('origin.country')), country).toBe(true);
    }
    // An excluded HF org as hfRepo owner fails whatever the origin claims.
    const data = { ...(m.data as Record<string, unknown>), hfRepo: 'hkunlp/example-model' };
    const e = validateConfig({ ...raw, models: [{ ...m, data }, ...raw.models.slice(1)] }).issues.filter((i) => i.level === 'error');
    expect(e.some((i) => i.message.includes("org 'hkunlp'"))).toBe(true);
  });

  it('policy', () => {
    expect(b.policy.excludedCountries).toEqual(['CN', 'HK', 'MO']);
    expect(b.policy.excludedOrgs.map((o) => o.org)).toEqual([
      'Qwen', 'deepseek-ai', 'moonshotai', 'THUDM', 'zai-org', 'baichuan-inc', '01-ai', 'internlm', 'MiniMaxAI',
      'tencent', 'baidu', 'ByteDance', 'ByteDance-Seed', 'stepfun-ai',
      'XiaomiMiMo', 'inclusionAI', 'OpenGVLab', 'openbmb', 'BAAI', 'Skywork', 'Kwaipilot', 'Kwai-Kolors', 'PaddlePaddle',
      'Alibaba-NLP', 'meituan-longcat', 'Tencent-Hunyuan', 'xverse', 'zhipuai', 'FreedomIntelligence',
      'hkunlp', 'hkust-nlp', 'HKUSTAudio', 'hkuds', 'PolyU-ChenLab', 'SenseTime', 'sensenova',
    ]);
    const hkOrgs = ['hkunlp', 'hkust-nlp', 'HKUSTAudio', 'hkuds', 'PolyU-ChenLab', 'SenseTime', 'sensenova'];
    for (const o of b.policy.excludedOrgs) {
      expect(o.country, o.org).toBe(hkOrgs.includes(o.org) ? 'HK' : 'CN');
      expect(Object.keys(o).sort()).toEqual(['country', 'org']);
    }
    expect(b.policy.decision).toEqual({ value: '國網中心明確禁止在計算機集群使用紅色供應鏈模型', source: 'nchc-model-policy' });
    expect(b.sources['nchc-model-policy']).toMatchObject({
      title: '國網中心明確禁止在計算機集群使用紅色供應鏈模型',
      url: 'docs/superpowers/specs/2026-10-19-inference-calculator-design.md#22-模型限制',
      kind: 'internal',
    });
  });

  it('hardware ids', () => {
    expect(Object.keys(b.hardware)).toEqual([
      'h100-sxm', 'h200-sxm', 'gb200', 'm5-ultra-512', 'gb10-spark', 'm5-pro-64', 'm6-32',
    ]);
  });

  it('NVIDIA datacenter GPUs', () => {
    const h100 = b.hardware['h100-sxm']!;
    expectSV(h100.memGB, 80, 'official', 'nvidia-h100');
    expectSV(h100.memBwTBs, 3.35, 'official', 'nvidia-h100');
    expectSV(h100.tflops.fp8, 1979, 'official', 'nvidia-h100');
    expectSV(h100.tflops.bf16, 989.5, 'official', 'nvidia-h100');
    expectSV(h100.tdpW, 700, 'official', 'nvidia-h100');
    expectSV(h100.nvlinkBidirGBs, 900, 'official', 'nvidia-hopper-tuning-guide');

    const h200 = b.hardware['h200-sxm']!;
    expectSV(h200.memGB, 141, 'official', 'nvidia-h200');
    expectSV(h200.memBwTBs, 4.8, 'official', 'nvidia-h200');
    expectSV(h200.tflops.fp8, 1979, 'official', 'nvidia-h200');
    expectSV(h200.tflops.bf16, 989.5, 'official', 'nvidia-h200');
    expectSV(h200.tdpW, 700, 'official', 'nvidia-h200');
    expectSV(h200.nvlinkBidirGBs, 900, 'official', 'nvidia-h200');

    const gb = b.hardware['gb200']!;
    expectSV(gb.memGB, 186, 'derived', 'nvidia-gb200-nvl72');
    expectSV(gb.memBwTBs, 8, 'derived', 'nvidia-gb200-nvl72');
    expectSV(gb.tflops.fp8, 5000, 'derived', 'nvidia-gb200-nvl72');
    expectSV(gb.tflops.bf16, 2500, 'derived', 'nvidia-gb200-nvl72');
    expectSV(gb.nvlinkBidirGBs, 1800, 'derived', 'nvidia-gb200-nvl72');
    // Per-GPU values are derived from NVIDIA's per-superchip figures (review): never 'official'.
    for (const v of [gb.memGB, gb.memBwTBs, gb.tflops.fp8, gb.tflops.bf16, gb.nvlinkBidirGBs]) expect(v!.formula).toMatch(/superchip/);
    expectSV(gb.tdpW, null, 'unverified', 'nvidia-gb200-nvl72');
  });

  it('DGX Spark GB10 uses measured MAMF, not sparse FP4', () => {
    const s = b.hardware['gb10-spark']!;
    expectSV(s.memGB, 128, 'official', 'nvidia-dgx-spark');
    expectSV(s.memBwTBs, 0.273, 'official', 'nvidia-dgx-spark');
    expectSV(s.tdpW, 140, 'official', 'nvidia-dgx-spark');
    expectSV(s.tflops.fp8, 207.7, 'measured', 'storagereview-dgx-spark');
    expectSV(s.tflops.bf16, 99.8, 'measured', 'storagereview-dgx-spark');
  });

  it('Apple silicon', () => {
    const u = b.hardware['m5-ultra-512']!;
    expectSV(u.memGB, 512, 'official', 'apple-mac-studio-specs');
    expectSV(u.memBwTBs, 1.2, 'official', 'apple-mac-studio-specs');
    expectSV(u.tflops.effective, 66.6, 'derived', 'llamacpp-4167');
    expect(u.tflops.effective?.formula).toBe('pp512 tok/s × 2 × 6.74e9');
    expect(u.tflops.fp8).toBeUndefined();
    expect(u.tflops.bf16).toBeUndefined();
    expectSV(u.tdpW, 300, 'measured', 'apple-mlx-distributed');

    const p = b.hardware['m5-pro-64']!;
    expectSV(p.memGB, 64, 'official', 'apple-mac-mini-specs');
    expectSV(p.memBwTBs, 0.307, 'estimate', 'apple-mac-mini-specs');
    expect(p.memBwTBs.basis).toContain('15C/16G');
    expectSV(p.tflops.effective, 21.8, 'derived', 'llamacpp-4167');
    expect(p.tflops.effective?.formula).toBe('pp512 tok/s × 2 × 6.74e9');
    expectSV(p.tdpW, null, 'unverified', 'apple-mac-mini-specs');

    const m6 = b.hardware['m6-32']!;
    expectSV(m6.memGB, 32, 'official', 'apple-mac-mini-specs');
    expectSV(m6.memBwTBs, 0.17, 'official', 'apple-mac-mini-specs');
    expectSV(m6.tflops.effective, 13.3, 'estimate', 'llamacpp-4167');
    expect(m6.tflops.effective?.basis).toContain('不一致');
    expectSV(m6.tdpW, null, 'unverified', 'apple-mac-mini-specs');
  });

  it('platform order is preserved (a later tie-break uses file order)', () => {
    expect(Object.keys(b.platforms)).toEqual([
      'nano4-h200', 'nano5-h100', 'nano5-h200', 'nano4-gb200',
      'mac-studio-m5u-512', 'dgx-spark', 'mac-mini-m5pro-64', 'mac-mini-m6-32',
    ]);
  });

  it('NCHC platforms', () => {
    const n4 = b.platforms['nano4-h200']!;
    expect([n4.group, n4.unit, n4.hardware, n4.calibration]).toEqual(['nchc', 'gpu', 'h200-sxm', 'nvidia-default']);
    expectSV(n4.gpusPerNode, 8, 'official', 'nchc-nano4-iservice');
    expectSV(n4.nodes, 220, 'official', 'nchc-nano4-iservice');
    expect(n4.tpOptions).toEqual([1, 2, 4, 8]);

    const h100 = b.platforms['nano5-h100']!;
    expect([h100.group, h100.unit, h100.hardware, h100.calibration]).toEqual(['nchc', 'gpu', 'h100-sxm', 'nvidia-default']);
    expectSV(h100.gpusPerNode, 8, 'official', 'nchc-nano5-page');
    expectSV(h100.nodes, 21, 'official', 'nchc-nano5-page');
    expect(h100.tpOptions).toEqual([1, 2, 4, 8]);

    const h200 = b.platforms['nano5-h200']!;
    expect([h200.group, h200.unit, h200.hardware, h200.calibration]).toEqual(['nchc', 'gpu', 'h200-sxm', 'nvidia-default']);
    expectSV(h200.gpusPerNode, 8, 'official', 'nchc-nano5-page');
    expectSV(h200.nodes, 16, 'official', 'nchc-nano5-page');
    expect(h200.scheduling).toBe('Slurm partition normal2');
    expect(h200.tpOptions).toEqual([1, 2, 4, 8]);

    const gb = b.platforms['nano4-gb200']!;
    expect([gb.group, gb.unit, gb.hardware, gb.calibration]).toEqual(['nchc', 'gpu', 'gb200', 'nvidia-default']);
    expectSV(gb.gpusPerNode, 4, 'derived', 'nchc-nano4-manual');
    expect(gb.gpusPerNode.formula).toBe('72 GPU / 18 node per rack');
    expect(gb.tpOptions).toEqual([1, 2, 4]);
    expectSV(gb.nodes, 36, 'official', 'nchc-nano4-manual');
    expectSV(gb.allreduceLatencyUs, 11.0, 'measured', 'arxiv-2607.16100');
  });

  it('self-hosted machine platforms', () => {
    const cases: Array<[string, string, string, string]> = [
      ['mac-studio-m5u-512', 'm5-ultra-512', 'mac-mlx', 'apple-mac-studio-specs'],
      ['dgx-spark', 'gb10-spark', 'spark-default', 'nvidia-dgx-spark'],
      ['mac-mini-m5pro-64', 'm5-pro-64', 'mac-mini-mlx', 'apple-mac-mini-specs'],
      ['mac-mini-m6-32', 'm6-32', 'mac-mini-mlx', 'apple-mac-mini-specs'],
    ];
    for (const [id, hw, cal, src] of cases) {
      const p = b.platforms[id]!;
      expect([p.group, p.unit, p.hardware, p.calibration], id).toEqual(['self', 'machine', hw, cal]);
      expect(p.tpOptions, id).toEqual([1]);
      expectSV(p.gpusPerNode, 1, 'official', src);
    }
  });

  it('quantization', () => {
    expect(Object.keys(b.quantization)).toEqual(['bf16', 'fp8', 'int4-awq', 'mxfp4']);
    const bf16 = b.quantization['bf16']!;
    expectSV(bf16.bytesPerParam, 2, 'official', 'google-bfloat16');
    expect(bf16.computeDtype).toBe('bf16');
    expectSV(bf16.kvBytesPerElem, 2, 'derived', 'vllm-quantized-kv-cache');
    expect(bf16.kvBytesPerElem.inputs).not.toContain('arxiv-2209.05433');

    const fp8 = b.quantization['fp8']!;
    expectSV(fp8.bytesPerParam, 1, 'official', 'arxiv-2209.05433');
    expect(fp8.computeDtype).toBe('fp8');
    expectSV(fp8.kvBytesPerElem, 1, 'derived', 'vllm-quantized-kv-cache');

    const int4 = b.quantization['int4-awq']!;
    expectSV(int4.bytesPerParam, 0.53125, 'estimate', 'arxiv-2306.00978');
    expect(int4.bytesPerParam.basis).toContain('128');
    expect(int4.computeDtype).toBe('bf16');
    expectSV(int4.kvBytesPerElem, 2, 'derived', 'vllm-quantized-kv-cache');
    expect(int4.kvBytesPerElem.inputs).not.toContain('arxiv-2209.05433');
    // Ruling R12: vLLM packs AWQ zeros as 4-bit; 0.53125 stays as the conservative upper bound.
    expect(int4.bytesPerParam.evidence).toContain('vllm-awq-linear');
    expect(int4.bytesPerParam.basis).toContain('vLLM 實際以 4-bit 打包 zero，實際約 0.52；0.53125 為上限估計（保守）');

    // vLLM launch flags for the verify command (spec §3), sourced from vLLM v0.32.0. `--quantization fp8` is deprecated
    // there for online quantization ("use --quantization fp8_per_tensor instead"), so the command uses the new name.
    expectSV(bf16.vllmServe.args, '--dtype bfloat16', 'official', 'vllm-optimization-docs');
    expectSV(fp8.vllmServe.args, '--quantization fp8_per_tensor', 'official', 'vllm-fp8-docs');
    expectSV(int4.vllmServe.args, '--quantization awq', 'official', 'vllm-awq-docs');
    expect(bf16.vllmServe.checkpoint).toBeUndefined();
    expect(fp8.vllmServe.checkpoint).toBeUndefined();
    expect(int4.vllmServe.checkpoint).toBe('<AWQ checkpoint of {hfRepo}>');
    // Notes are sourced strings (review 7b): the kernel claim cites the vLLM source. v0.32.0 resolves awq / awq_marlin /
    // auto_awq to one AutoAWQConfig that picks the Marlin kernel on CUDA when supported (no more "forcing awq").
    expectSV(int4.vllmServe.note, int4.vllmServe.note?.value, 'official', 'vllm-awq-docs');
    expect(int4.vllmServe.note?.value).toContain('AWQ');
    expect(int4.vllmServe.note?.value).not.toContain('不會自動改用');
    expect(int4.vllmServe.note?.value).toContain('Marlin');
    expect(int4.vllmServe.note?.evidence).toEqual(['vllm-awq-marlin']);
    expectSV(fp8.vllmServe.note, 'FP8 = vLLM 線上動態量化（以 BF16 checkpoint 啟動，載入時轉 FP8）', 'official', 'vllm-fp8-docs');
    expect(fp8.vllmServe.nativeNote).toMatchObject({ status: 'official', source: 'vllm-config-quant-detect', evidence: ['vllm-v032-hf-quant-config'] });
    // Review 7d: the FP8 KV flag is data.
    expectSV(fp8.vllmServe.kvCacheArgs, '--kv-cache-dtype fp8', 'official', 'vllm-quantized-kv-cache');
    expect(bf16.vllmServe.kvCacheArgs).toBeUndefined();
    expect(int4.vllmServe.kvCacheArgs).toBeUndefined();
    // Unquantized checkpoints are served in BF16 ('native' for a model without nativeQuant).
    expect(Object.values(b.quantization).filter((q) => q.nativeForUnquantized).map((q) => q.id)).toEqual(['bf16']);
    // Review 7a: the engine-args source title covers --dtype and the other serve flags.
    expect(b.sources['vllm-optimization-docs']?.title).toContain('--dtype');
  });

  it('mxfp4 (OCP MX): 0.53125 B/param derived from the spec, bf16 compute, 2-byte KV, native checkpoints only', () => {
    const mx = b.quantization['mxfp4']!;
    expectSV(mx.bytesPerParam, 0.53125, 'derived', 'ocp-mx-spec');
    expect(mx.bytesPerParam.formula).toContain('(8 + 32 × 4) / 32 / 8');
    expect(mx.computeDtype).toBe('bf16');
    expectSV(mx.kvBytesPerElem, 2, 'derived', 'vllm-mxfp4-src');
    expect(mx.vllmServe.args).toBeUndefined();
    // vLLM v0.32.0 has an online MXFP4 path (--quantization mxfp4) whose activation recipe depends on the MoE backend,
    // so serving only native MXFP4 checkpoints is the calculator's restriction, an estimate, not a vLLM limit.
    expect(mx.vllmServe.nativeOnly).toMatchObject({ value: true, status: 'estimate' });
    expect(mx.vllmServe.nativeOnly?.evidence).toEqual(['vllm-mxfp4-src', 'vllm-v032-online-quant']);
    // The note combines several sourced claims (auto-detect, v0.10.1, default MoE backend, Marlin env, the InferenceX
    // runs that used Marlin): derived from all of them, not "official" from the auto-detect source alone (final-review M27).
    expect(mx.vllmServe.nativeNote).toMatchObject({
      status: 'derived',
      inputs: ['vllm-config-quant-detect', 'vllm-mxfp4-v0101', 'vllm-gpt-oss-recipe', 'vllm-v032-mxfp4-moe-backend', 'vllm-v022-mxfp4-marlin-env', 'inferencex-gptoss-h200-v022', 'inferencex-gptoss-h100-v021'],
    });
    expect(mx.vllmServe.nativeNote!.evidence).toBeUndefined();
    // Ruling R41: the command keeps the default MoE kernel and says the calibration points ran Marlin.
    expect(mx.vllmServe.nativeNote!.value).toContain('--moe-backend marlin');
    expect(mx.vllmServe.kvCacheArgs).toBeUndefined();
  });

  it('natively quantized checkpoints carry nativeQuant with their exact weight-file bytes (HF revision API)', () => {
    const expected: Record<string, [string, string, number]> = {
      'gpt-oss-20b': ['mxfp4', 'mxfp4', 13761316904],
      'gpt-oss-120b': ['mxfp4', 'mxfp4', 65248893184],
      'mistral-medium-3.5-128b': ['fp8', 'fp8', 133606164352],
      'mistral-small-4-119b-2603': ['fp8', 'fp8', 120922973936],
      // ModelOpt FP8: the quantization config is hf_quant_config.json, not config.json (vLLM reads either).
      'llama-3.3-70b-instruct-fp8': ['modelopt', 'fp8', 72656585760],
    };
    for (const m of Object.values(b.models)) {
      const e = expected[m.id];
      if (!e) {
        expect(m.nativeQuant, m.id).toBeUndefined();
        continue;
      }
      expect(m.nativeQuant).toMatchObject({ method: e[0], quant: e[1] });
      expectSV(m.nativeQuant!.checkpointWeightBytes, e[2], 'official', m.source);
      expect(b.sources[m.source]?.title).toContain('權重檔大小');
    }
  });

  it('benchmark margin for --max-model-len is a disclosed estimate with its vLLM sources', () => {
    expectSV(b.benchmark.maxModelLenMarginTokens, 256, 'estimate', 'bench-retokenize-drift');
    expect(b.benchmark.maxModelLenMarginTokens.evidence).toEqual(['bench-retokenize-drift', 'vllm-bench-random-dataset', 'vllm-serving-validate-input']);
    expect(b.benchmark.maxModelLenMarginTokens.basis).toContain('187');
  });

  it('funnel defaults cite GWDG (paper) and the planner page (secondary, so only an estimate)', () => {
    expectSV(b.funnel.dailyActiveShare, 0.05, 'measured', 'gwdg-chat-ai');
    expect(b.funnel.requestsPerActivePerDay).toMatchObject({ value: 7, status: 'derived', inputs: ['gwdg-chat-ai'] });
    expect(b.funnel.requestsPerActivePerDay.formula).toBeTruthy();
    expect(b.funnel.peakHourShare).toMatchObject({ value: 0.2, status: 'estimate', evidence: ['rate-limit-planner', 'gwdg-chat-ai'] });
    expect(b.sources['gwdg-chat-ai']).toMatchObject({ kind: 'paper', url: 'https://arxiv.org/abs/2407.00110' });
    expect(b.sources['rate-limit-planner']?.kind).toBe('secondary');
  });

  it('Ruling R41: NVIDIA t_fixed and per-request TTFT overhead are derived from the declared fit points; η unchanged', () => {
    const n = b.calibration['nvidia-default']!;
    expect(n.tFixedSec).toMatchObject({ value: 0.0029, unit: 's', status: 'derived', inputs: ['ix-h200-gptoss-mxfp4-tp1-1k1k-c4', 'ix-h200-llama70b-fp8-tp1-1k1k-c4'] });
    expect(n.ttftOverheadSec).toMatchObject({ value: 0.074, unit: 's', status: 'derived', inputs: ['ix-h200-gptoss-mxfp4-tp1-1k1k-c4-ttft', 'ix-h200-llama70b-fp8-tp1-1k1k-c4-ttft'] });
    for (const id of [...n.tFixedSec.inputs!, ...n.ttftOverheadSec.inputs!]) expect(b.calibrationPoints[id]?.role, id).toBe('fit');
    expect([n.etaBw.value, n.etaBwLow.value, n.etaCompute.value]).toEqual([0.7, 0.55, 0.5]);
    // MLX and DGX Spark are not NVIDIA-vLLM-HGX fits: they keep 0.
    for (const id of ['mac-mlx', 'mac-mini-mlx', 'spark-default']) {
      expect([b.calibration[id]!.tFixedSec.value, b.calibration[id]!.ttftOverheadSec.value], id).toEqual([0, 0]);
    }
  });

  it('workloads', () => {
    expect(Object.keys(b.workloads)).toEqual(['chat', 'doc', 'assist']);
    const chat = b.workloads['chat']!;
    expect(chat.kind).toBe('chat');
    expectSV(chat.inputTokens, 1020, 'measured', 'splitwise-azure');
    expectSV(chat.outputTokens, 129, 'measured', 'splitwise-azure');
    expectSV(chat.cacheHitRate, 0, 'estimate', 'splitwise-azure');
    expect(chat.cacheHitRate.basis).toContain('未報告');

    const doc = b.workloads['doc']!;
    expect(doc.kind).toBe('chat');
    expectSV(doc.inputTokens, 12035, 'measured', 'mooncake-trace');
    expectSV(doc.outputTokens, 343, 'measured', 'mooncake-trace');
    expectSV(doc.cacheHitRate, 0, 'estimate', 'mooncake-trace');
    expect(doc.cacheHitRate.basis).toContain('未報告');
    // Ruling R21: the user-facing text names the data source.
    expect(doc.description).toContain('Mooncake 公開 trace');

    const assist = b.workloads['assist']!;
    expect(assist.kind).toBe('agent');
    expectSV(assist.inputTokens, 126180, 'measured', 'tracelab');
    expectSV(assist.outputTokens, 252, 'measured', 'tracelab');
    expectSV(assist.cacheHitRate, 0.957, 'measured', 'tracelab');

    // Review I3: tier reference models are catalog ids from docs/research/open-models.md §4 (T1, T2, T3);
    // candidates not in the catalog (Muse-Spark-Open gated; Inkling, Nemotron unsupported MoE layouts) are not named.
    expect(chat.tierModels).toEqual(['gemma-4-12b-it', 'gemma-4-31b-it', 'gpt-oss-20b']);
    expect(doc.tierModels).toEqual(['muse-glimmer-30b', 'granite-4.2-30b', 'gemma-4-31b-it']);
    expect(assist.tierModels).toEqual(['mistral-medium-3.5-128b', 'muse-glimmer-30b']);
    for (const w of Object.values(b.workloads)) {
      expect(w.tierNote.value).not.toMatch(/Muse-Spark|Inkling|Nemotron/);
      expect(w.tierNote.status).toBe('estimate');
      expect(w.tierNote.evidence).toEqual(['bixbench', 'biomnibench', 'tw-legalbench']);
      expect(w.description.length).toBeGreaterThan(0);
      expect(w.demoText.length).toBeGreaterThan(0);
    }
  });

  it('speed presets', () => {
    expect(Object.keys(b.speedPresets)).toEqual(['smooth', 'ok']);
    expectSV(b.speedPresets['smooth']!.minTokensPerSec, 20, 'estimate', 'l1t-office-sizing');
    expectSV(b.speedPresets['smooth']!.maxTtftSec, 5, 'estimate', 'l1t-office-sizing');
    for (const v of [b.speedPresets['smooth']!.maxTtftSec, b.speedPresets['ok']!.minTokensPerSec, b.speedPresets['ok']!.maxTtftSec]) {
      expect(v.basis).toContain('計算機預設值');
    }
    expectSV(b.speedPresets['ok']!.minTokensPerSec, 8, 'estimate', 'l1t-office-sizing');
    expectSV(b.speedPresets['ok']!.maxTtftSec, 15, 'estimate', 'l1t-office-sizing');
  });

  it('vLLM engine defaults per platform (vLLM v0.32.0 arg_utils, review L9 / L10)', () => {
    for (const id of ['nano4-h200', 'nano5-h100', 'nano5-h200']) {
      expect(b.platforms[id]!.vllmDefaults?.maxNumSeqs.value).toBe(1024);
      expect(b.platforms[id]!.vllmDefaults?.maxNumBatchedTokens.value).toBe(8192);
    }
    expect(b.platforms['nano4-gb200']!.vllmDefaults?.maxNumBatchedTokens.value).toBe(16384);
    expect(b.platforms['mac-studio-m5u-512']!.vllmDefaults).toBeUndefined();
    expect(b.platforms['nano4-h200']!.vllmDefaults?.maxNumSeqs.inputs).toContain('vllm-v032-arg-utils');
    // Async scheduling is on by default with PP 1, so 2 batches are in flight (vllm/config/vllm.py; review L9 fix).
    for (const id of ['nano4-h200', 'nano5-h100', 'nano5-h200', 'nano4-gb200', 'dgx-spark']) {
      expect(b.platforms[id]!.vllmDefaults?.maxConcurrentBatches.value, id).toBe(2);
      expect(b.platforms[id]!.vllmDefaults?.maxConcurrentBatches.inputs, id).toContain('vllm-v032-vllm-config');
    }
  });

  it('KV allocation granularity: vLLM block sizes per GPU, mlx-lm KVCache step (spec §5.1)', () => {
    // Standard attention keeps CacheConfig.DEFAULT_BLOCK_SIZE 16 (FA3 / FlashInfer / Triton accept it).
    // MLA: Hopper FP8 KV → FlashMLA (64), 16-bit KV → FlashAttention MLA (16); Blackwell → FlashInfer MLA (32);
    // GB10 (SM 12.x) → Triton MLA (16).
    const want: Record<string, [number, number, number]> = {
      'nano4-h200': [16, 64, 16],
      'nano5-h100': [16, 64, 16],
      'nano5-h200': [16, 64, 16],
      'nano4-gb200': [16, 32, 32],
      'dgx-spark': [16, 16, 16],
    };
    // GB200: FlashInfer MLA only for qk_nope_head_dim ∈ {64, 128, 192}; otherwise CUTLASS MLA, block 128 (final-review M26).
    const gbMla = b.platforms['nano4-gb200']!.vllmDefaults!.mlaKvBlockSize;
    expect(gbMla.qkNopeHeadDims).toEqual([64, 128, 192]);
    expect([gbMla.otherwise?.fp8Kv.value, gbMla.otherwise?.bf16Kv.value]).toEqual([128, 128]);
    expect(gbMla.otherwise?.fp8Kv.inputs).toContain('vllm-v032-cutlass-mla');
    for (const id of ['nano4-h200', 'nano5-h100', 'nano5-h200', 'dgx-spark']) {
      expect(b.platforms[id]!.vllmDefaults!.mlaKvBlockSize.qkNopeHeadDims, id).toBeUndefined();
    }
    for (const [id, [std, fp8, bf16]] of Object.entries(want)) {
      const vd = b.platforms[id]!.vllmDefaults!;
      expect([vd.kvBlockSize.value, vd.mlaKvBlockSize.fp8Kv.value, vd.mlaKvBlockSize.bf16Kv.value], id).toEqual([std, fp8, bf16]);
      expect(vd.kvBlockSize.inputs, id).toContain('vllm-v032-block-size');
      expect(vd.mlaKvBlockSize.fp8Kv.inputs, id).toContain('vllm-v032-mla-backends');
    }
    for (const id of ['mac-mlx', 'mac-mini-mlx']) {
      expect(b.calibration[id]!.mlxDefaults?.kvCacheStep.value, id).toBe(256);
      expect(b.calibration[id]!.mlxDefaults?.kvCacheStep.source, id).toBe('mlx-lm-kv-cache-step');
      // mlx_lm.server --prefill-step-size default 2048: prompts run in chunks of it (Ruling R38).
      expect(b.calibration[id]!.mlxDefaults?.prefillStepSize.value, id).toBe(2048);
      expect(b.calibration[id]!.mlxDefaults?.prefillStepSize.source, id).toBe('mlx-lm-prefill-step');
    }
    expect(b.calibration['nvidia-default']!.mlxDefaults).toBeUndefined();
  });

  it('Mistral Small 4 MLA dimensions at its pinned config (Ruling R40)', () => {
    expect(b.models['mistral-small-4-119b-2603']!.mla).toEqual({ kvLoraRank: 256, qkRopeHeadDim: 64, qkNopeHeadDim: 64, vHeadDim: 128 });
  });

  it('vLLM citations are pinned to v0.32.0 (commit 5df63a7); older pins only for stated history (spec §5)', () => {
    // History: v0.10.1 (first mxfp4), v0.22.0 (the version the InferenceX gpt-oss points ran, Ruling R41).
    const historical = new Map([['vllm-mxfp4-v0101', /v0\.10\.1/], ['vllm-v022-mxfp4-marlin-env', /v0\.22\.0/]]);
    for (const [id, src] of Object.entries(b.sources)) {
      const url = src.url ?? '';
      if (!/github\.com\/vllm-project\/vllm\/|docs\.vllm\.ai/.test(url)) continue;
      if (historical.has(id)) {
        expect(src.title, id).toMatch(historical.get(id)!);
        continue;
      }
      expect(url, id).toContain('vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/');
      expect(src.title, id).toContain('v0.32.0');
    }
  });

  it('calibration profiles', () => {
    expect(Object.keys(b.calibration)).toEqual(['nvidia-default', 'mac-mlx', 'mac-mini-mlx', 'spark-default']);
    const nv = b.calibration['nvidia-default']!;
    expectSV(nv.etaBw, 0.7, 'estimate', 'martin-alderson-speed');
    expect(nv.etaBw.evidence).toEqual(['martin-alderson-speed', 'apple-mlx-distributed']);
    expect(nv.etaBw.basis).toBe('尚未以國網實測校正');
    expectSV(nv.etaBwLow, 0.55, 'estimate', 'martin-alderson-speed');
    expectSV(nv.etaCompute, 0.5, 'estimate', 'apple-mlx-distributed');
    expectSV(nv.memUtil, 0.92, 'official', 'vllm-v032-cache-config');
    expectSV(nv.allreduceLatencyUs, 11.0, 'estimate', 'arxiv-2607.16100');
    expect(nv.allreduceLatencyUs.evidence).toEqual(['arxiv-2607.16100', 'nccl-collectives-bench-h100', 'arxiv-2606.05951']);

    const mac = b.calibration['mac-mlx']!;
    expectSV(mac.kvBytesPerElemOverride, 2, 'derived', 'mlx-lm-kv-cache');
    expect(mac.kvBytesPerElemOverride?.inputs).toEqual(['mlx-lm-kv-cache', 'mlx-lm-server-kv-bits']);
    expect(nv.kvBytesPerElemOverride).toBeUndefined();
    // Recomputed with the decode step's KV read (review L11): 133.61 GB weights + 2.98 GB fp16 KV at 8256 tokens; then
    // with the input embedding read by its one looked-up row (Ruling R39): − 3.22 GB → 133.37 GB.
    expectSV(mac.etaBw, 0.86, 'derived', 'apple-mlx-distributed');
    for (const v of [mac.etaBw, mac.etaBwLow]) {
      expect(v.formula).toContain('Mistral Medium 3.5 128B');
      expect(v.formula).not.toMatch(/qwen/i);
      // Recomputed from the native FP8 checkpoint size on 2026-10-20 (5fc1b9a); verified follows (review M7).
      expect(v.verified).toBe('2026-10-20');
      expect(v.formula).toContain('KV');
      expect(v.formula).toContain('133.37 GB');
    }
    expectSV(mac.etaBwLow, 0.81, 'derived', 'apple-mlx-distributed');
    expectSV(mac.etaCompute, 1.0, 'derived', 'llamacpp-4167');
    expectSV(mac.memUtil, 0.75, 'estimate', 'apple-forum-max-working-set');
    expect(mac.memUtil.basis).toContain('沒有任何官方來源');

    const sp = b.calibration['spark-default']!;
    expectSV(sp.etaBw, 0.68, 'derived', 'storagereview-dgx-spark');
    expect(sp.etaBw.formula).toBe('23.2 tok/s × 8.03 GB ÷ 273 GB/s');
    expectSV(sp.etaBwLow, 0.55, 'estimate', 'storagereview-dgx-spark');
    expectSV(sp.etaCompute, 0.8, 'estimate', 'storagereview-dgx-spark');
    expect(sp.etaBwLow.basis).not.toContain('0.8');
    expect(sp.etaCompute.basis).not.toContain('NVIDIA 預設');
    expectSV(sp.memUtil, 0.92, 'official', 'vllm-v032-cache-config');
    expectSV(sp.allreduceLatencyUs, 0, 'derived', 'nvidia-dgx-spark');
  });

  it('concurrency rule', () => {
    // Review M6: TraceLab measured 3.3 % of session *time*; reading it as the share of open sessions generating at
    // once is an interpretation, so it is an estimate whose basis names the 14.5 % sensitivity (pauses capped at 1 h).
    expectSV(b.concurrency.agentGeneratingShare, 0.033, 'estimate', 'tracelab');
    expect(b.concurrency.agentGeneratingShare.basis).toContain('14.5%');
    expect(b.concurrency.agentRule.value).not.toContain('實測');
    expect(b.concurrency.chatRule.status).toBe('estimate');
    expect(b.concurrency.agentRule.status).toBe('derived');
    expect(b.concurrency.agentRule.inputs).toContain('tracelab');
    // Queueing model behind max_num_batched_tokens (Ruling R36): Little's law plus the vLLM scheduler budget; the closed,
    // deterministic fluid loop is an assumption, so an estimate.
    expect(b.concurrency.queueRule.status).toBe('estimate');
    expect(b.concurrency.queueRule.evidence).toEqual(expect.arrayContaining(['little-1961', 'vllm-v032-scheduler']));
    expect(b.concurrency.queueRule.value).toContain("Little's law");
    expect(b.sources['little-1961']!.url).toBe('https://doi.org/10.1287/opre.9.3.383');
  });

  it('HK and MO publishers fail data:build; no catalog model, tier model or calibration point has an excluded publisher country', () => {
    const raw = loadConfig(configDir);
    const m = raw.models[0]!;
    const withModel = (extra: Record<string, unknown>) => ({ ...raw, models: [{ ...m, data: { ...(m.data as object), ...extra } }, ...raw.models.slice(1)] });
    const errs = (r: typeof raw) => validateConfig(r).issues.filter((i) => i.level === 'error');
    const hkOrigin = errs(withModel({ origin: { developer: 'Example Org', country: 'HK' } }));
    expect(hkOrigin.length).toBeGreaterThan(0);
    expect(hkOrigin.every((i) => i.message.includes('HK') && i.message.startsWith('policy:'))).toBe(true);
    // An excluded HF org as hfRepo owner fails even with a US origin flag.
    const hkRepo = errs(withModel({ hfRepo: 'hkust-nlp/example-model' }));
    expect(hkRepo).toEqual([expect.objectContaining({ path: expect.stringMatching(/\.hfRepo$/), message: expect.stringContaining("org 'hkust-nlp'") })]);
    const moOrigin = errs(withModel({ origin: { developer: 'Example Org', country: 'MO' } }));
    expect(moOrigin.length).toBeGreaterThan(0);
    expect(moOrigin.every((i) => i.message.includes('MO') && i.message.startsWith('policy:'))).toBe(true);
    for (const x of Object.values(b.models)) expect(['CN', 'HK', 'MO']).not.toContain(x.origin.country);
    for (const x of Object.values(b.skippedCalibrationPoints)) {
      if (x.modelOrigin) expect(['CN', 'HK', 'MO']).not.toContain(x.modelOrigin.country);
    }
    // Tier reference models and calibration points name catalog models, whose publishers are checked above.
    for (const w of Object.values(b.workloads)) for (const id of w.tierModels) expect(['CN', 'HK', 'MO']).not.toContain(b.models[id]!.origin.country);
    for (const x of Object.values(b.calibrationPoints)) expect(['CN', 'HK', 'MO']).not.toContain(b.models[x.model]!.origin.country);
  });

  it('model catalog (Task 5): imported from pinned HF commits; no calibration points yet (Task 10)', () => {
    expect(Object.keys(b.models).sort()).toEqual([
      'gemma-4-12b-it', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gpt-oss-120b', 'gpt-oss-20b',
      'granite-3.3-8b-instruct', 'granite-4.2-30b', 'llama-3.3-70b-instruct-fp8', 'mistral-medium-3.5-128b',
      'mistral-small-3.1-24b-instruct-2503', 'mistral-small-4-119b-2603', 'muse-glimmer-30b',
      'olmo-2-0325-32b', 'phi-4',
    ]);
    expect(Object.keys(b.models)).toHaveLength(14);
    // NVIDIA (US) publishes the FP8 checkpoint; the Meta base is recorded lineage.
    expect(b.models['llama-3.3-70b-instruct-fp8']).toMatchObject({ origin: { developer: 'NVIDIA', country: 'US' }, baseModel: 'meta-llama/Llama-3.3-70B-Instruct' });
    for (const m of Object.values(b.models)) {
      expect(m.source).toBe(`hf:${m.hfRepo}@${m.source.slice(-7)}`);
      expect(m.source.slice(-7)).toMatch(/^[0-9a-f]{7}$/);
      expect(b.sources[m.source]?.kind).toBe('official');
      expect(m.totalParamsB).toMatchObject({ status: 'official', source: m.source });
      expect(b.policy.excludedCountries).not.toContain(m.origin.country);
    }
    const pts = Object.values(b.calibrationPoints);
    for (const p of pts.filter((x) => x.id.startsWith('apple-'))) expect(p.measured).toMatchObject({ status: 'measured', source: 'apple-mlx-distributed' });
    // InferenceX points cite the per-run raw-result API (benchmark sources, retrieved 2026-10-20) and their run link.
    const ix = pts.filter((x) => x.id.startsWith('ix-'));
    expect(ix).toHaveLength(40);
    for (const p of ix) {
      expect(b.sources[p.measured.source!]).toMatchObject({ kind: 'benchmark', accessed: '2026-10-20', originOrg: 'SemiAnalysis' });
      expect(b.sources[p.measured.source!]!.url).toMatch(/^https:\/\/inferencex\.semianalysis\.com\/api\/v1\/benchmarks\?.*runId=\d+&exactRun=true$/);
      expect(p.conditions?.runUrl).toMatch(/^https:\/\/github\.com\/SemiAnalysisAI\/InferenceX\/actions\/runs\/\d+\/attempts\/\d$/);
      expect(p.conditions?.lengths).toMatchObject({ sampling: 'uniform', rangeRatio: 0.8 });
      if (p.model === 'gpt-oss-120b') expect(p.conditions?.engineEnv).toMatchObject({ VLLM_MXFP4_USE_MARLIN: '1' });
    }
    for (const s of Object.values(b.skippedCalibrationPoints).filter((x) => x.id.startsWith('storagereview-'))) {
      expect(s.measured).toMatchObject({ status: 'measured', source: 'storagereview-dgx-spark' });
    }
  });

  it('unsupported MoE architectures are absent from the catalog and documented (Ruling R31b)', () => {
    const readme = readFileSync(fileURLToPath(new URL('../../../config/models/README.md', import.meta.url)), 'utf8');
    const section = readme.slice(readme.indexOf('## 待支援架構'));
    expect(section.length).toBeGreaterThan(0);
    const removed: Array<[string, string, string[]]> = [
      ['nvidia-nemotron-3.5-super-vl-120b-a12b-bf16', 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16 @ 1f8953f', ['moe_latent_size', 'relu2']],
      ['nvidia-nemotron-3-ultra-550b-a55b-bf16', 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16 @ 77df655', ['moe_latent_size']],
      ['inkling-small', 'thinkingmachines/Inkling-Small @ 8cc5877', ['dense_mlp_idx']],
      ['inkling', 'thinkingmachines/Inkling @ 828496e', ['dense_mlp_idx']],
    ];
    for (const [id, row, reasons] of removed) {
      expect(b.models[id], id).toBeUndefined();
      const line = section.split('\n').find((l) => l.startsWith(`| ${row} `));
      expect(line, row).toBeDefined();
      for (const r of reasons) expect(line).toContain(r);
    }
    expect(Object.keys(b.sources).some((s) => /Inkling|Nemotron/.test(s))).toBe(false);
  });

  it('every catalog MoE model has expert parameters within the total and positive active parameters', () => {
    for (const m of Object.values(b.models)) {
      if (!m.moe) continue;
      expect(expertParamsTotalB(m), m.id).toBeLessThanOrEqual(m.totalParamsB.value);
      expect(activeParamsB(m), m.id).toBeGreaterThan(0);
    }
  });

  it('every estimate has basis and evidence, and every referenced id exists in sources', () => {
    const all = sourcedValues(b, '', []);
    expect(all.length).toBeGreaterThan(50);
    for (const { path, v } of all) {
      if (v.status === 'estimate') {
        expect(v.evidence?.length, path).toBeGreaterThan(0);
        expect(v.basis, path).toBeTruthy();
        for (const id of v.evidence!) expect(b.sources[id], `${path} evidence ${id}`).toBeDefined();
      }
      for (const id of [v.source, ...(v.evidence ?? []), ...(v.inputs ?? [])].filter(Boolean) as string[]) {
        // A fitted value cites its fit points (Ruling R41); never a validate point.
        if (b.calibrationPoints[id]) expect(b.calibrationPoints[id]!.role, `${path} -> ${id}`).toBe('fit');
        else expect(b.sources[id], `${path} -> ${id}`).toBeDefined();
      }
    }
  });

  it('data-source origin is data, carried by the bundle (Ruling R21)', () => {
    const mc = b.sources['mooncake-trace']!;
    expect(mc).toMatchObject({ originOrg: 'Moonshot AI', originCountry: 'CN' });
    // Survives the JSON round trip the built bundle goes through.
    const rt = BundleSchema.parse(JSON.parse(JSON.stringify(b)));
    expect(rt.sources['mooncake-trace']).toMatchObject({ originOrg: 'Moonshot AI', originCountry: 'CN' });
  });

  it('internal sources with a repo-relative url point at a file that exists (review M8)', () => {
    const rel = Object.values(b.sources).filter((s) => !/^https?:/.test(s.url));
    expect(rel.map((s) => s.id).sort()).toEqual(['bench-retokenize-drift', 'nchc-model-policy']);
    for (const s of rel) {
      expect(s.kind).toBe('internal');
      expect(existsSync(join(REPO_ROOT, s.url.replace(/#.*$/, ''))), s.url).toBe(true);
    }
  });

  it('unverified values say why: a conflict text or the conflicting sources (spec §2.1, review M8)', () => {
    for (const { path, v } of sourcedValues(b, '', [])) {
      if (v.status === 'unverified') expect(!!v.conflict || (v.sources?.length ?? 0) >= 2, path).toBe(true);
    }
  });

  it('every source is referenced, keyed by its id, and accessed 2026-10-19 to 2026-10-21', () => {
    const used = new Set<string>();
    for (const { v } of sourcedValues(b, '', [])) {
      for (const id of [v.source, ...(v.evidence ?? []), ...(v.inputs ?? [])]) if (id) used.add(id);
    }
    used.add(b.policy.decision.source); // a plain id, not a sourced value
    for (const { v } of sourcedValues(b, '', [])) for (const id of v.sources ?? []) used.add(id);
    for (const [id, s] of Object.entries(b.sources)) {
      expect(used.has(id), `unused source ${id}`).toBe(true);
      expect(s.id).toBe(id);
      expect(['2026-10-19', '2026-10-20', '2026-10-21']).toContain(s.accessed);
    }
  });
});

describe('Mac mini bandwidth efficiency is an estimate (review)', () => {
  it('mac-mini-mlx borrows the Mac Studio values but labels them estimate, with the reason', () => {

    const mini = b.calibration['mac-mini-mlx']!;
    const studio = b.calibration['mac-mlx']!;
    expect(mini.etaBw.value).toBe(studio.etaBw.value);
    expect(mini.etaBwLow.value).toBe(studio.etaBwLow.value);
    expect(mini.etaBw.status).toBe('estimate');
    expect(mini.etaBwLow.status).toBe('estimate');
    expect(mini.etaBw.basis).toContain('Mac mini 沒有 MLX 實測');
    for (const p of ['mac-mini-m5pro-64', 'mac-mini-m6-32']) expect(b.platforms[p]!.calibration).toBe('mac-mini-mlx');
  });
});

describe('InferenceX H100 Llama-3.3-70B-FP8 launch flags (final-review I5)', () => {
  it('record --max-model-len 10240, as benchmarks/70b_fp8_h100_*.sh at 9596d23 sets it (H200 computes 2068)', () => {
    const pts = Object.values(b.calibrationPoints).filter((p) => p.id.startsWith('ix-h100-llama70b-fp8-'));
    expect(pts.length).toBe(6);
    for (const p of pts) {
      expect(p.conditions?.engineArgs, p.id).toContain('--max-model-len 10240');
      expect(p.conditions?.engineArgs, p.id).not.toContain('--max-model-len 2068');
    }
    const h200 = Object.values(b.calibrationPoints).filter((p) => p.id.startsWith('ix-h200-llama70b-fp8-') && p.id.includes('1k1k'));
    expect(h200.every((p) => p.conditions?.engineArgs?.includes('--max-model-len 2068'))).toBe(true);
  });
});

describe('unmeasured t_fixed / TTFT-overhead placeholders on MLX and DGX Spark (final-review M20)', () => {
  it('are documented placeholders tracked in issue #12, with evidence that records the absence (not support for 0)', () => {
    for (const id of ['mac-mlx', 'mac-mini-mlx', 'spark-default']) {
      for (const k of ['tFixedSec', 'ttftOverheadSec'] as const) {
        const v = b.calibration[id]![k];
        expect(v.value, `${id}.${k}`).toBe(0);
        expect(v.status).toBe('estimate');
        expect(v.basis).toContain('unmeasured placeholder');
        expect(v.basis).toContain('issue #12');
        expect(v.basis).not.toContain('issue #10');
        expect(v.evidence).toEqual(['gh-issue-12-mac-spark-calibration']);
      }
    }
    expect(b.sources['gh-issue-12-mac-spark-calibration']!.url).toBe('https://github.com/NCHC-bio/inference-deployment-calculator/issues/12');
  });
});

describe('provenance nits (final-review M27)', () => {
  it('the H100 vLLM-default formulas state only what their listed inputs support (no NVML MiB figure)', () => {
    const vd = b.platforms['nano5-h100']!.vllmDefaults!;
    for (const v of [vd.maxNumSeqs, vd.maxNumBatchedTokens]) {
      expect(v.formula).not.toContain('81,559');
      expect(v.formula).not.toContain('NVML');
      expect(v.inputs).toEqual(['vllm-v032-arg-utils', 'nvidia-h100']);
    }
  });
});

