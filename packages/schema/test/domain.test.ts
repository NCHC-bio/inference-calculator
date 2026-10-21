import { describe, it, expect } from 'vitest';
import {
  HardwareSchema, PlatformSchema, ModelSchema, WorkloadSchema, QuantizationSchema, PolicySchema,
  CalibrationProfileSchema, LayerGroupSchema, BenchmarkRuleSchema, CalibrationPointSchema, SkippedCalibrationPointSchema,
} from '../src/domain';
import { BundleSchema } from '../src/bundle';

const v = '2026-10-19';
const off = <T>(value: T, unit?: string) => ({ value, unit, status: 'official', source: 'src-a', verified: v });

const hardware = {
  id: 'h200', name: 'NVIDIA H200',
  memGB: off(141, 'GB'), memBwTBs: off(4.8, 'TB/s'),
  tflops: { fp8: off(1979), bf16: off(989) },
  tdpW: off(700, 'W'), nvlinkBidirGBs: off(900),
};
const model = {
  id: 'gpt-oss-120b', name: 'gpt-oss-120b', hfRepo: 'openai/gpt-oss-120b',
  origin: { developer: 'OpenAI', country: 'US' },
  totalParamsB: off(117), layers: 36, heads: 64, kvHeads: 8, headDim: 64, hidden: 2880,
  attention: 'gqa',
  layerGroups: [{ kind: 'full', count: 18 }, { kind: 'sliding', count: 18, window: 128 }],
  moe: { experts: 128, topK: 4, expertFfnDim: 2880 },
  slidingWindow: 128,
  source: 'src-a', verified: v,
};
const platform = {
  id: 'nchc-h200', name: 'H200', sub: 'x', group: 'nchc', unit: 'gpu', hardware: 'h200',
  gpusPerNode: off(8), tpOptions: [1, 2, 4, 8], calibration: 'nvidia-default',
  allreduceLatencyUs: off(10),
};
const workload = {
  id: 'chat', name: 'Chat', kind: 'chat',
  inputTokens: off(1000), outputTokens: off(500), cacheHitRate: off(0.5),
  description: 'd', tierNote: off('n'), tierModels: ['gpt-oss-120b'], demoText: 't',
};

describe('domain schemas', () => {
  it('parses minimal H200 hardware', () => {
    expect(HardwareSchema.safeParse(hardware).success).toBe(true);
  });
  it('allows null tdp', () => {
    expect(HardwareSchema.safeParse({ ...hardware, tdpW: off(null) }).success).toBe(true);
  });
  it('parses a hybrid model', () => {
    expect(ModelSchema.safeParse(model).success).toBe(true);
  });
  it('rejects model missing kvHeads', () => {
    const { kvHeads, ...rest } = model;
    expect(ModelSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects lowercase / bad country', () => {
    expect(ModelSchema.safeParse({ ...model, origin: { developer: 'x', country: 'us' } }).success).toBe(false);
  });
  it('baseModel may stand alone (card lineage, origin unknown); baseOrigin needs a baseModel', () => {
    const bo = { developer: 'Meta', country: 'US' };
    expect(ModelSchema.safeParse({ ...model, baseModel: 'meta/x', baseOrigin: bo }).success).toBe(true);
    expect(ModelSchema.safeParse({ ...model, baseModel: 'meta/x' }).success).toBe(true);
    expect(ModelSchema.safeParse({ ...model, baseOrigin: bo }).success).toBe(false);
  });
  it('slidingWindow may be null', () => {
    expect(ModelSchema.safeParse({ ...model, slidingWindow: null }).success).toBe(true);
  });
  it('parses platform; rejects tpOptions containing 3', () => {
    expect(PlatformSchema.safeParse(platform).success).toBe(true);
    expect(PlatformSchema.safeParse({ ...platform, tpOptions: [1, 3] }).success).toBe(false);
    // Review M4: GPUs per node is a positive integer.
    expect(PlatformSchema.safeParse({ ...platform, gpusPerNode: off(4.5) }).success).toBe(false);
    expect(PlatformSchema.safeParse({ ...platform, gpusPerNode: off(0) }).success).toBe(false);
  });
  it('workload: cacheHitRate must be < 1, outputTokens >= 1', () => {
    expect(WorkloadSchema.safeParse(workload).success).toBe(true);
    expect(WorkloadSchema.safeParse({ ...workload, cacheHitRate: off(1) }).success).toBe(false);
    expect(WorkloadSchema.safeParse({ ...workload, cacheHitRate: off(0) }).success).toBe(true);
    expect(WorkloadSchema.safeParse({ ...workload, outputTokens: off(0) }).success).toBe(false);
  });
  it('quantization requires kvBytesPerElem > 0', () => {
    const q = {
      id: 'fp8', name: 'FP8', bytesPerParam: off(1), computeDtype: 'fp8', description: 'd', kvBytesPerElem: off(1), embeddingBytesPerParam: off(2),
      vllmServe: { args: off('--quantization fp8') },
    };
    expect(QuantizationSchema.safeParse(q).success).toBe(true);
    const { kvBytesPerElem, ...rest } = q;
    expect(QuantizationSchema.safeParse(rest).success).toBe(false);
    expect(QuantizationSchema.safeParse({ ...q, kvBytesPerElem: off(0) }).success).toBe(false);
  });
  it('quantization requires sourced vllmServe args; a checkpoint placeholder requires a note', () => {
    const q = {
      id: 'int4', name: 'INT4', bytesPerParam: off(0.5), computeDtype: 'bf16', description: 'd', kvBytesPerElem: off(2), embeddingBytesPerParam: off(2),
      vllmServe: { args: off('--quantization awq'), checkpoint: '<AWQ checkpoint of {hfRepo}>', note: off('replace it') },
    };
    expect(QuantizationSchema.safeParse(q).success).toBe(true);
    const { vllmServe, ...noServe } = q;
    expect(QuantizationSchema.safeParse(noServe).success).toBe(false);
    expect(QuantizationSchema.safeParse({ ...q, vllmServe: { args: { value: '--x', status: 'official', verified: v } } }).success).toBe(false);
    const { note, ...noNote } = vllmServe;
    const r = QuantizationSchema.safeParse({ ...q, vllmServe: noNote });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'vllmServe.note')).toBe(true);
  });
  it('vllmServe notes are sourced strings (review 7b), not bare text', () => {
    const q = {
      id: 'int4', name: 'INT4', bytesPerParam: off(0.5), computeDtype: 'bf16', description: 'd', kvBytesPerElem: off(2), embeddingBytesPerParam: off(2),
      vllmServe: { args: off('--quantization awq'), checkpoint: '<x {hfRepo}>', note: 'bare text' },
    };
    expect(QuantizationSchema.safeParse(q).success).toBe(false);
  });
  it('vllmServe: exactly one of args / nativeOnly; nativeOnly needs a nativeNote and no checkpoint', () => {
    const base = { id: 'mxfp4', name: 'MXFP4', bytesPerParam: off(0.53125), computeDtype: 'bf16', description: 'd', kvBytesPerElem: off(2), embeddingBytesPerParam: off(2) };
    const nativeOnly = { nativeOnly: off(true), nativeNote: off('auto-detected') };
    expect(QuantizationSchema.safeParse({ ...base, vllmServe: nativeOnly }).success).toBe(true);
    expect(QuantizationSchema.safeParse({ ...base, vllmServe: {} }).success).toBe(false);
    expect(QuantizationSchema.safeParse({ ...base, vllmServe: { ...nativeOnly, args: off('--quantization mxfp4') } }).success).toBe(false);
    const noNote = QuantizationSchema.safeParse({ ...base, vllmServe: { nativeOnly: off(true) } });
    expect(noNote.error?.issues.some((i) => i.path.join('.') === 'vllmServe.nativeNote')).toBe(true);
    expect(QuantizationSchema.safeParse({ ...base, vllmServe: { ...nativeOnly, checkpoint: '<x>', note: off('n') } }).success).toBe(false);
    // kvCacheArgs is an optional sourced flag string (review 7d: the FP8 KV flag is data, not core).
    expect(QuantizationSchema.safeParse({ ...base, vllmServe: { args: off('--x'), kvCacheArgs: off('--kv-cache-dtype fp8') } }).success).toBe(true);
    expect(QuantizationSchema.safeParse({ ...base, nativeForUnquantized: true, vllmServe: { args: off('--x') } }).success).toBe(true);
    expect(QuantizationSchema.safeParse({ ...base, nativeForUnquantized: false, vllmServe: { args: off('--x') } }).success).toBe(false);
  });
  it('model nativeQuant: HF quant_method verbatim, quantization id, sourced integer checkpoint bytes', () => {
    const nq = { method: 'mxfp4', quant: 'mxfp4', checkpointWeightBytes: off(65248893184, 'B') };
    expect(ModelSchema.safeParse({ ...model, nativeQuant: nq }).success).toBe(true);
    expect(ModelSchema.safeParse({ ...model, nativeQuant: { ...nq, checkpointWeightBytes: off(1.5) } }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, nativeQuant: { ...nq, method: '' } }).success).toBe(false);
    const { source: _s, ...unsourced } = nq.checkpointWeightBytes;
    expect(ModelSchema.safeParse({ ...model, nativeQuant: { ...nq, checkpointWeightBytes: unsourced } }).success).toBe(false);
  });
  it('benchmark rule: max-model-len margin is a sourced non-negative integer', () => {
    expect(BenchmarkRuleSchema.safeParse({ maxModelLenMarginTokens: off(256) }).success).toBe(true);
    expect(BenchmarkRuleSchema.safeParse({ maxModelLenMarginTokens: off(0) }).success).toBe(true);
    expect(BenchmarkRuleSchema.safeParse({ maxModelLenMarginTokens: off(-1) }).success).toBe(false);
    expect(BenchmarkRuleSchema.safeParse({ maxModelLenMarginTokens: off(1.5) }).success).toBe(false);
  });
  it('workload tier reference models are a non-empty list of catalog ids (review I3)', () => {
    expect(WorkloadSchema.safeParse(workload).success).toBe(true);
    const { tierModels: _t, ...noTier } = workload;
    expect(WorkloadSchema.safeParse(noTier).success).toBe(false);
    expect(WorkloadSchema.safeParse({ ...workload, tierModels: [] }).success).toBe(false);
  });
  it('policy and bundle', () => {
    const org = { org: 'fx-excluded-a', country: 'CN' };
    const policy = { excludedCountries: ['CN'], excludedOrgs: [org], decision: { value: 'fixture', source: 'src-a' } };
    expect(PolicySchema.safeParse(policy).success).toBe(true);
    // An empty list is rejected; unknown keys are rejected (strict).
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: [] }).success).toBe(false);
    // A list without CN is rejected (review M1).
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['RU'] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['RU', 'CN'] }).success).toBe(true);
    // HK and MO are data, not schema requirements: [CN, HK, MO] passes, a list without CN does not.
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['CN', 'HK'] }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['CN', 'HK', 'MO'] }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['HK'] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, excludedCountries: ['HK', 'MO'] }).success).toBe(false);
    // Excluded HF orgs (review I2): required, non-empty, an owner slug (no '/'); org and country only.
    const { excludedOrgs: _o, ...noOrgs } = policy;
    expect(PolicySchema.safeParse(noOrgs).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, excludedOrgs: [] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, excludedOrgs: [{ ...org, org: 'fx-excluded-a/example-model' }] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, excludedOrgs: [{ ...org, source: 'src-a' }] }).success).toBe(false);
    const { country: _c, ...noCountry } = org;
    expect(PolicySchema.safeParse({ ...policy, excludedOrgs: [noCountry] }).success).toBe(false);
    // decision: value and source only.
    const { decision: _d, ...noDecision } = policy;
    expect(PolicySchema.safeParse(noDecision).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, decision: { ...policy.decision, status: 'official' } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...policy, allowedCountries: ['CN'] }).success).toBe(false);
    const bundle = {
      meta: { dataVersion: v }, policy, sources: {}, hardware: { h200: hardware }, platforms: { p: platform },
      quantization: {}, models: { m: model }, workloads: { chat: workload }, speedPresets: {},
      calibration: {}, concurrency: {
        agentGeneratingShare: off(0.033), chatRule: off('r'), agentRule: off('r'), queueRule: off('r'),
      }, benchmark: { maxModelLenMarginTokens: off(256) },
      funnel: { dailyActiveShare: off(0.05), requestsPerActivePerDay: off(7), peakHourShare: off(0.2) },
      calibrationPoints: {}, skippedCalibrationPoints: {}, calibrationGaps: {},
      customHardware: { templates: { vllm: { platform: 'p', rationale: 'r', evidence: ['s'] }, mlx: { platform: 'p', rationale: 'r', evidence: ['s'] } } },
    };
    expect(BundleSchema.safeParse(bundle).success).toBe(true);
    const { policy: _p, ...noPolicy } = bundle;
    expect(BundleSchema.safeParse(noPolicy).success).toBe(false);
    const { benchmark: _b, ...noBenchmark } = bundle;
    expect(BundleSchema.safeParse(noBenchmark).success).toBe(false);
    const { funnel: _f, ...noFunnel } = bundle;
    expect(BundleSchema.safeParse(noFunnel).success).toBe(false);
    const { customHardware: _ch, ...noCustomHardware } = bundle;
    expect(BundleSchema.safeParse(noCustomHardware).success).toBe(false);
  });
});

describe('calibration points are measurements (review M2)', () => {
  const meas = { value: 7.7, unit: 'tok/s', status: 'measured', source: 'src-a', verified: v };
  const point = {
    id: 'pt', role: 'fit', platform: 'p', model: 'm', quant: 'fp8',
    workload: { inputTokens: 8192, outputTokens: 128, cacheHitRate: 0 }, tp: 1, concurrency: 1,
    metric: 'decodeTokPerSec', measured: meas, engine: 'mlx',
  };
  const skipped = {
    id: 'sk', role: 'validate', platform: 'p', modelRepo: 'org/m', quant: 'fp8', concurrency: 1,
    metric: 'decodeTokPerSec', measured: meas, reason: 'r',
  };
  it('measured must have status measured', () => {
    expect(CalibrationPointSchema.safeParse(point).success).toBe(true);
    expect(SkippedCalibrationPointSchema.safeParse(skipped).success).toBe(true);
    for (const status of ['official', 'derived', 'estimate', 'unverified']) {
      const m = { ...meas, status, formula: 'f', inputs: ['src-a'], basis: 'b', evidence: ['src-a'] };
      const r = CalibrationPointSchema.safeParse({ ...point, measured: m });
      expect(r.success, status).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('measured.status');
      expect(SkippedCalibrationPointSchema.safeParse({ ...skipped, measured: m }).success, status).toBe(false);
    }
  });
});

describe('calibration profile and layer group refinements (R10, R11)', () => {
  const profile = {
    id: 'p', engine: 'vllm', etaBw: off(0.7), etaBwLow: off(0.55), etaCompute: off(0.5), memUtil: off(0.9),
    allreduceLatencyUs: off(11), tFixedSec: off(0), ttftOverheadSec: off(0),
  };
  it('parses a valid profile', () => {
    expect(CalibrationProfileSchema.safeParse(profile).success).toBe(true);
  });
  it('engine is explicit: vllm or mlx, required (review M-6)', () => {
    const { engine: _e, ...noEngine } = profile;
    expect(CalibrationProfileSchema.safeParse(noEngine).success).toBe(false);
    expect(CalibrationProfileSchema.safeParse({ ...profile, engine: 'mlx' }).success).toBe(true);
    expect(CalibrationProfileSchema.safeParse({ ...profile, engine: 'sglang' }).success).toBe(false);
  });
  it.each(['etaBw', 'etaBwLow', 'etaCompute', 'memUtil'] as const)('%s must be > 0 and <= 1', (k) => {
    expect(CalibrationProfileSchema.safeParse({ ...profile, [k]: off(0) }).success).toBe(false);
    expect(CalibrationProfileSchema.safeParse({ ...profile, [k]: off(1.01) }).success).toBe(false);
    expect(CalibrationProfileSchema.safeParse({ ...profile, [k]: off(1) }).success).toBe(true);
  });
  it('allreduceLatencyUs may be 0 but not negative', () => {
    expect(CalibrationProfileSchema.safeParse({ ...profile, allreduceLatencyUs: off(0) }).success).toBe(true);
    expect(CalibrationProfileSchema.safeParse({ ...profile, allreduceLatencyUs: off(-1) }).success).toBe(false);
  });
  it('sliding layer group requires window', () => {
    expect(LayerGroupSchema.safeParse({ kind: 'sliding', count: 18 }).success).toBe(false);
    expect(LayerGroupSchema.safeParse({ kind: 'sliding', count: 18, window: 128 }).success).toBe(true);
  });
  it('mamba layer group requires ssm', () => {
    expect(LayerGroupSchema.safeParse({ kind: 'mamba', count: 40 }).success).toBe(false);
    expect(LayerGroupSchema.safeParse({
      kind: 'mamba', count: 40, ssm: { heads: 128, headDim: 64, stateSize: 128 },
    }).success).toBe(true);
  });
  it('mamba ssm accepts an optional positive stateBytesPerElem', () => {
    const ssm = { heads: 128, headDim: 64, stateSize: 128 };
    const g = (extra: object) => LayerGroupSchema.safeParse({ kind: 'mamba', count: 40, ssm: { ...ssm, ...extra } }).success;
    expect(g({ stateBytesPerElem: 4 })).toBe(true);
    expect(g({ stateBytesPerElem: 2 })).toBe(true);
    expect(g({ stateBytesPerElem: 0 })).toBe(false);
    expect(g({ stateBytesPerElem: -2 })).toBe(false);
  });
  it('full layer group needs neither', () => {
    expect(LayerGroupSchema.safeParse({ kind: 'full', count: 8 }).success).toBe(true);
  });
});

describe('hfRepo is owner/name and required for catalog models (final-review I4)', () => {
  it('rejects the URL form, a bare owner and a missing hfRepo', () => {
    expect(ModelSchema.safeParse(model).success).toBe(true);
    for (const bad of ['https://huggingface.co/fx-org/example-model', 'fx-org', 'fx-org/', '/example-model', 'a/b/c', 'org/name with space']) {
      expect(ModelSchema.safeParse({ ...model, hfRepo: bad }).success, bad).toBe(false);
    }
    const { hfRepo: _r, ...noRepo } = model;
    expect(ModelSchema.safeParse(noRepo).success).toBe(false);
  });
  it('a skipped calibration point names an owner/repo, or a model name with its publisher origin', () => {
    const meas = { value: 7.7, unit: 'tok/s', status: 'measured', source: 'src-a', verified: v };
    const sk = { id: 'sk', role: 'validate', platform: 'p', quant: 'fp8', concurrency: 1, metric: 'decodeTokPerSec', measured: meas, reason: 'r' };
    expect(SkippedCalibrationPointSchema.safeParse({ ...sk, modelRepo: 'org/m' }).success).toBe(true);
    expect(SkippedCalibrationPointSchema.safeParse({ ...sk, modelRepo: 'Llama 3.1 8B (Meta)' }).success).toBe(false);
    expect(SkippedCalibrationPointSchema.safeParse({ ...sk, modelName: 'Llama 3.1 8B' }).success).toBe(false);
    expect(
      SkippedCalibrationPointSchema.safeParse({ ...sk, modelName: 'Llama 3.1 8B', modelOrigin: { developer: 'Meta', country: 'US' } }).success,
    ).toBe(true);
    expect(SkippedCalibrationPointSchema.safeParse(sk).success).toBe(false);
  });
});
