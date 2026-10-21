import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig, type RawConfig } from '../src/load';
import { validateConfig } from '../src/validate';

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Non-`good` fixtures hold only the files that differ from `good`; overlay them on top of it. */
function loadFixture(name: string): RawConfig {
  const base = loadConfig(fx('good'));
  if (name === 'good') return base;
  const over = loadConfig(fx(name));
  const docs = { ...base.docs };
  for (const [k, d] of Object.entries(over.docs)) if (d) docs[k as keyof typeof docs] = d;
  return { docs, models: [...base.models, ...over.models] };
}

const errors = (name: string) => validateConfig(loadFixture(name)).issues.filter((i) => i.level === 'error');
const errors2 = (raw: RawConfig) => validateConfig(raw).issues.filter((i) => i.level === 'error');

describe('validateConfig', () => {
  it('good fixture: no errors and a bundle', () => {
    const r = validateConfig(loadFixture('good'));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.bundle?.platforms['fx-node']?.hardware).toBe('fx-gpu');
    expect(r.bundle?.models['fx-model']?.origin.country).toBe('US');
    expect(r.bundle?.policy.excludedCountries).toEqual(['CN']);
  });

  it('dangling-ref: unknown hardware reported at platforms.x.hardware', () => {
    const e = errors('dangling-ref');
    expect(e.map((i) => i.path)).toContain('platforms.fx-node.hardware');
    expect(validateConfig(loadFixture('dangling-ref')).bundle).toBeUndefined();
  });

  it('missing-source: unknown source id is an error mentioning source', () => {
    const e = errors('missing-source');
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((i) => i.message.includes('source') && i.path === 'hardware.fx-gpu.memGB.source')).toBe(true);
  });

  it('estimate-no-evidence: rejected', () => {
    const e = errors('estimate-no-evidence');
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((i) => i.file.endsWith('quantization.yaml')
      && i.path === 'quantization.fx-fp8.bytesPerParam.evidence'
      && i.message.includes('evidence'))).toBe(true);
  });

  it('excluded-origin: model from an excluded country fails with policy error', () => {
    const e = errors('excluded-origin');
    expect(e.some((i) => i.message.includes('policy') && i.path.startsWith('models.synthetic-excluded'))).toBe(true);
  });

  it('cn-base-us-publisher: a US publisher with a base from an excluded country passes; the base is recorded, not checked', () => {
    const r = validateConfig(loadFixture('cn-base-us-publisher'));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.bundle?.models['synthetic-us-derived']?.baseOrigin?.country).toBe('CN');
  });

  it('reports duplicate ids', () => {
    const raw = loadFixture('good');
    const hw = raw.docs.hardware!;
    const list = hw.data as unknown[];
    const e = validateConfig({ ...raw, docs: { ...raw.docs, hardware: { ...hw, data: [...list, list[0]] } } })
      .issues.filter((i) => i.level === 'error');
    expect(e.some((i) => i.message.includes('duplicate') && i.path === 'hardware.fx-gpu')).toBe(true);
  });

  it('unknown keys are errors, so a misspelt field cannot slip past the origin check (review: strict schemas)', () => {
    const raw = loadFixture('good');
    const m = raw.models[0]!;
    for (const key of ['base_model', 'total_params', 'baseorigin']) {
      const data = { ...(m.data as Record<string, unknown>), [key]: { developer: 'X', country: 'CN' } };
      const e = validateConfig({ ...raw, models: [{ ...m, data }] }).issues.filter((i) => i.level === 'error');
      expect(e.some((i) => i.path.startsWith('models.fx-model') && i.message.includes(key)), key).toBe(true);
    }
    // Nested objects too (origin is where the policy reads the country).
    const data = { ...(m.data as Record<string, unknown>), origin: { developer: 'X', country: 'US', base_country: 'CN' } };
    const e = validateConfig({ ...raw, models: [{ ...m, data }] }).issues.filter((i) => i.level === 'error');
    expect(e.some((i) => i.message.includes('base_country'))).toBe(true);
  });

  it('excluded HF orgs: hfRepo and skipped modelRepo owners (the publisher) are policy errors, case-insensitive (review I2, M3)', () => {
    const raw = loadFixture('good');
    const m = raw.models[0]!;
    const withModel = (extra: Record<string, unknown>) => ({ ...raw, models: [{ ...m, data: { ...(m.data as object), ...extra } }] });
    // A non-excluded origin flag does not help: the repo owner itself is excluded.
    const hf = validateConfig(withModel({ hfRepo: 'FX-EXCLUDED-A/example-model' })).issues.filter((i) => i.level === 'error');
    expect(hf).toEqual([expect.objectContaining({ path: 'models.fx-model.hfRepo', message: expect.stringContaining("org 'FX-EXCLUDED-A'") })]);
    // A base model's owner and origin are not checked.
    const base = validateConfig(withModel({
      hfRepo: 'example/derived', baseModel: 'example-org/base', baseOrigin: { developer: 'X', country: 'CN' },
    })).issues.filter((i) => i.level === 'error');
    expect(base).toEqual([]);
    // baseModel alone (the card's base_model, origin unknown) is allowed.
    expect(errors2(withModel({ baseModel: 'example/base' }))).toEqual([]);
    expect(validateConfig(withModel({ hfRepo: 'example/fx-excluded-a-like-name' })).issues.filter((i) => i.level === 'error')).toEqual([]);

    const cal = raw.docs.calibration!;
    const data = structuredClone(cal.data) as Record<string, unknown>;
    const skipped = (modelRepo: string) => ({
      id: 'fx-skip', role: 'validate', platform: 'fx-node', modelRepo, quant: 'fx-fp8', concurrency: 1,
      metric: 'decodeTokPerSec', reason: 'not in catalog',
      measured: { value: 10, status: 'measured', source: 'fx-src', verified: '2026-10-19' },
    });
    data.skipped = [skipped('fx-excluded-a/example-model')];
    expect(errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } }).map((i) => i.path))
      .toEqual(['skippedCalibrationPoints.fx-skip.modelRepo']);
    // A plain name is no longer accepted (final-review I4): it needs the publisher origin, which the policy checks.
    data.skipped = [skipped('Some 8B')];
    expect(errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } }).length).toBeGreaterThan(0);
    const { modelRepo: _mr, ...named } = skipped('x/y');
    data.skipped = [{ ...named, modelName: 'Some 8B', modelOrigin: { developer: 'Example', country: 'US' } }];
    expect(errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } })).toEqual([]);
    data.skipped = [{ ...named, modelName: 'Some 8B', modelOrigin: { developer: 'Example', country: 'CN' } }];
    expect(errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } }).map((i) => i.path))
      .toEqual(['skippedCalibrationPoints.fx-skip.modelOrigin.country']);
  });

  it('malformed hfRepo values cannot bypass the org check; hfRepo is required (final-review I4)', () => {
    const raw = loadFixture('good');
    const m = raw.models[0]!;
    const withModel = (extra: Record<string, unknown>) => ({ ...raw, models: [{ ...m, data: { ...(m.data as object), ...extra } }] });
    for (const bad of ['https://huggingface.co/fx-excluded-a/example-model', 'fx-excluded-a']) {
      expect(errors2(withModel({ hfRepo: bad })).some((i) => i.path.startsWith('models.fx-model')), bad).toBe(true);
    }
    const { hfRepo: _h, ...noRepo } = m.data as Record<string, unknown>;
    expect(errors2({ ...raw, models: [{ ...m, data: noRepo }] }).some((i) => i.path.startsWith('models.fx-model'))).toBe(true);
  });

  it('excluded HF orgs must have a country in excludedCountries (review I2)', () => {
    const raw = loadFixture('good');
    const pol = raw.docs.policy!;
    const data = structuredClone(pol.data) as { excludedOrgs: Array<Record<string, unknown>> };
    data.excludedOrgs[0]!.country = 'US';
    expect(errors2({ ...raw, docs: { ...raw.docs, policy: { ...pol, data } } }).map((i) => i.path))
      .toEqual(['policy.excludedOrgs[0].country']);
  });

  it('workload tierModels must be catalog models (review I3)', () => {
    const raw = loadFixture('good');
    const wl = raw.docs.workloads!;
    const withTier = (tierModels: string[]) => {
      const data = structuredClone(wl.data) as { workloads: Array<Record<string, unknown>> };
      data.workloads[0]!.tierModels = tierModels;
      return { ...raw, docs: { ...raw.docs, workloads: { ...wl, data } } };
    };
    expect(errors2(withTier(['fx-model']))).toEqual([]);
    expect(errors2(withTier(['fx-model', 'no-such-model']))).toEqual([
      expect.objectContaining({ path: 'workloads.fx-chat.tierModels[1]', message: "unknown model id 'no-such-model'" }),
    ]);
  });

  it('every tpOptions value must fit in one node: tp <= gpusPerNode (review M4)', () => {
    const raw = loadFixture('good');
    const pl = raw.docs.platforms!;
    const data = structuredClone(pl.data) as Array<{ gpusPerNode: { value: number } }>;
    data[0]!.gpusPerNode.value = 4;
    expect(errors2({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data } } })).toEqual([
      expect.objectContaining({
        file: 'platforms.yaml', path: 'platforms.fx-node.tpOptions[3]',
        message: 'tp 8 exceeds gpusPerNode 4 (multi-node tensor parallelism is out of scope)',
      }),
    ]);
  });

  it('official / measured values cannot cite a secondary source (spec §2.1, review M8)', () => {
    const raw = loadFixture('good');
    const src = raw.docs.sources!;
    const data = structuredClone(src.data) as Array<Record<string, unknown>>;
    data[0]!.kind = 'secondary';
    const e = errors2({ ...raw, docs: { ...raw.docs, sources: { ...src, data } } });
    expect(e.length).toBeGreaterThan(0);
    expect(e).toContainEqual(expect.objectContaining({
      file: 'hardware.yaml', path: 'hardware.fx-gpu.memGB.source',
      message: "official value cites source 'fx-src' of kind secondary (official / measured need a primary source; use unverified)",
    }));
    expect(e.every((i) => i.message.includes('of kind secondary'))).toBe(true);
  });

  it("unverified values' sources[] ids are checked like source / evidence / inputs (review M8)", () => {
    const raw = loadFixture('good');
    const hw = raw.docs.hardware!;
    const data = structuredClone(hw.data) as Array<Record<string, unknown>>;
    data[0]!.tdpW = { value: null, status: 'unverified', source: 'fx-src', sources: ['fx-src', 'nope'], verified: '2026-10-19' };
    expect(errors2({ ...raw, docs: { ...raw.docs, hardware: { ...hw, data } } }).map((i) => i.path))
      .toEqual(['hardware.fx-gpu.tdpW.sources[1]']);
  });

  it('reports model file name / id mismatch', () => {
    const raw = loadFixture('good');
    const m = raw.models[0]!;
    const e = validateConfig({ ...raw, models: [{ ...m, file: m.file.replace('fx-model', 'other-name') }] })
      .issues.filter((i) => i.level === 'error');
    expect(e.some((i) => i.path === 'models.fx-model' && i.message.includes('file name'))).toBe(true);
  });

  it('reports dangling calibration point references', () => {
    const raw = loadFixture('good');
    const cal = raw.docs.calibration!;
    const data = structuredClone(cal.data) as { points: Array<Record<string, unknown>> };
    data.points[0]!.model = 'no-such-model';
    const e = validateConfig({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } })
      .issues.filter((i) => i.level === 'error');
    expect(e.map((i) => i.path)).toContain('calibrationPoints.fx-point.model');
  });

  it('validates skipped calibration points and gaps (references and sourcing, Ruling R28)', () => {
    const raw = loadFixture('good');
    const cal = raw.docs.calibration!;
    const data = structuredClone(cal.data) as Record<string, unknown>;
    data.skipped = [
      {
        id: 'fx-skip', role: 'validate', platform: 'no-such-platform', modelRepo: 'example/some-8b', quant: 'fx-fp8',
        concurrency: 1, metric: 'decodeTokPerSec', reason: 'not in catalog',
        measured: { value: 10, status: 'measured', source: 'no-such-source', verified: '2026-10-19' },
      },
      {
        id: 'fx-nosrc', role: 'validate', platform: 'fx-node', modelRepo: 'example/some-8b', quant: 'fx-fp8',
        concurrency: 1, metric: 'decodeTokPerSec', reason: 'x',
        measured: { value: 10, status: 'measured', verified: '2026-10-19' },
      },
    ];
    data.gaps = [{ id: 'fx-gap', platforms: ['fx-node', 'nope'], note: 'none yet' }];
    const e = validateConfig({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } })
      .issues.filter((i) => i.level === 'error')
      .map((i) => i.path);
    expect(e).toContain('skippedCalibrationPoints.fx-skip.platform');
    expect(e).toContain('skippedCalibrationPoints.fx-skip.measured.source');
    expect(e).toContain('skippedCalibrationPoints.fx-nosrc.measured.source');
    expect(e).toContain('calibrationGaps.fx-gap.platforms[1]');
  });

  it('no-nvlink: hardware behind a tp > 1 platform must have nvlinkBidirGBs (finding 2a)', () => {
    const e = errors('no-nvlink');
    expect(e).toEqual([
      expect.objectContaining({ file: 'hardware.yaml', path: 'hardware.fx-gpu.nvlinkBidirGBs', message: expect.stringContaining("platform 'fx-node' offers tp 2/4/8") }),
    ]);
    expect(validateConfig(loadFixture('no-nvlink')).bundle).toBeUndefined();
  });

  it('a vllm custom-hardware template platform must have vllmDefaults', () => {
    const raw = loadFixture('good');
    const pl = raw.docs.platforms!;
    const data = structuredClone(pl.data) as { platforms?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const list = (Array.isArray(data) ? data : data.platforms)!;
    delete list.find((p) => p.id === 'fx-node')!.vllmDefaults;
    const e = errors2({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data } } });
    expect(e).toContainEqual(expect.objectContaining({
      path: 'customHardware.templates.vllm.platform',
      message: expect.stringContaining('vllmDefaults'),
    }));
  });

  it('custom-hardware template must exist and match its engine', () => {
    const raw = loadFixture('good');
    const ch = raw.docs.customHardware!;
    const withTemplates = (vllm: string, mlx: string): RawConfig => {
      const data = structuredClone(ch.data) as { templates: Record<string, { platform: string }> };
      data.templates.vllm!.platform = vllm;
      data.templates.mlx!.platform = mlx;
      return { ...raw, docs: { ...raw.docs, customHardware: { ...ch, data } } };
    };
    expect(errors2(withTemplates('fx-nope', 'fx-mac'))).toEqual([
      expect.objectContaining({ file: 'custom-hardware.yaml', path: 'customHardware.templates.vllm.platform', message: "unknown platform id 'fx-nope'" }),
    ]);
    expect(errors2(withTemplates('fx-mac', 'fx-mac'))).toEqual([
      expect.objectContaining({ path: 'customHardware.templates.vllm.platform', message: expect.stringContaining("engine 'mlx'") }),
    ]);
    // Evidence ids are source ids like any other.
    const data = structuredClone(ch.data) as { templates: Record<string, { evidence: string[] }> };
    data.templates.mlx!.evidence = ['no-such-source'];
    expect(errors2({ ...raw, docs: { ...raw.docs, customHardware: { ...ch, data } } }).map((i) => i.path)).toEqual([
      'customHardware.templates.mlx.evidence[0]',
    ]);
    expect(validateConfig(raw).bundle?.customHardware.templates.mlx.platform).toBe('fx-mac');
    // The real config.
    expect(errors2(loadConfig(fileURLToPath(new URL('../../../config', import.meta.url))))).toEqual([]);
  });

  it('vllmDefaults: required on a vLLM platform, refused on an MLX one (review L9, L10)', () => {
    const raw = loadFixture('good');
    const pl = raw.docs.platforms!;
    const data = structuredClone(pl.data) as Array<Record<string, unknown>>;
    delete data[0]!.vllmDefaults;
    const e = errors2({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data } } });
    expect(e.map((i) => i.path)).toContain('platforms.fx-node.vllmDefaults');
    const cal = raw.docs.calibration!;
    const cdata = structuredClone(cal.data) as { profiles: Array<Record<string, unknown>> };
    cdata.profiles[0]!.engine = 'mlx';
    const e2 = errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data: cdata } } });
    expect(e2.some((i) => i.path === 'platforms.fx-node.vllmDefaults' && i.message.includes('mlx'))).toBe(true);
  });

  it('mlxDefaults: required on an MLX calibration profile, refused on a vLLM one (spec §5.1 KV allocation)', () => {
    const raw = loadFixture('good');
    const cal = raw.docs.calibration!;
    const vllmWith = structuredClone(cal.data) as { profiles: Array<Record<string, unknown>> };
    const sv = (value: number) => ({ value, status: 'official', source: 'fx-src', verified: '2026-10-20' });
    vllmWith.profiles[0]!.mlxDefaults = { kvCacheStep: sv(256), prefillStepSize: sv(2048) };
    const e = errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data: vllmWith } } });
    expect(e.some((i) => i.path === `calibration.${vllmWith.profiles[0]!.id}.mlxDefaults` && i.message.includes('vLLM'))).toBe(true);
    const mlxWithout = structuredClone(cal.data) as { profiles: Array<Record<string, unknown>> };
    mlxWithout.profiles[0]!.engine = 'mlx';
    const e2 = errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data: mlxWithout } } });
    expect(e2.some((i) => i.path === `calibration.${mlxWithout.profiles[0]!.id}.mlxDefaults`)).toBe(true);
  });

  it('no-nvlink is fine when the platform only offers tp 1', () => {
    const raw = loadFixture('no-nvlink');
    const pl = raw.docs.platforms!;
    const data = structuredClone(pl.data) as Array<Record<string, unknown>>;
    data[0]!.tpOptions = [1];
    const r = validateConfig({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data } } });
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('missing-tflops: hardware needs tflops[computeDtype] for every quantization, or effective (finding 2b)', () => {
    const e = errors('missing-tflops');
    expect(e).toEqual([
      expect.objectContaining({ path: 'hardware.fx-gpu.tflops.fp8', message: expect.stringContaining("quantization 'fx-fp8' (computeDtype fp8)") }),
    ]);
    // `effective` (Apple) satisfies every compute dtype.
    const raw = loadFixture('missing-tflops');
    const hw = raw.docs.hardware!;
    const data = structuredClone(hw.data) as Array<{ tflops: Record<string, unknown> }>;
    data[0]!.tflops = { effective: { value: 50, status: 'official', source: 'fx-src', verified: '2026-10-19' } };
    const r = validateConfig({ ...raw, docs: { ...raw.docs, hardware: { ...hw, data } } });
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('moe-inconsistent: expert parameters above totalParamsB are rejected with core\'s formula (Ruling R31c)', () => {
    const e = errors('moe-inconsistent');
    expect(e).toEqual([
      expect.objectContaining({
        file: 'models/fx-moe-bad.yaml',
        path: 'models.fx-moe-bad.moe',
        message: expect.stringContaining('expert parameters 360.8B'),
      }),
    ]);
  });

  it('mla-unsupported: MLA with layerGroups or a sliding window is rejected as not supported yet (Ruling R22)', () => {
    const e = errors('mla-unsupported');
    expect(e).toEqual([
      expect.objectContaining({
        file: 'models/fx-mla-groups.yaml',
        path: 'models.fx-mla-groups.layerGroups',
        message: expect.stringContaining("architecture combination not supported yet: attention 'mla' with layerGroups"),
      }),
      expect.objectContaining({
        file: 'models/fx-mla-window.yaml',
        path: 'models.fx-mla-window.slidingWindow',
        message: expect.stringContaining("architecture combination not supported yet: attention 'mla' with a non-null slidingWindow"),
      }),
    ]);
    expect(validateConfig(loadFixture('mla-unsupported')).bundle).toBeUndefined();
    // slidingWindow: null is fine for MLA.
    const raw = loadFixture('mla-unsupported');
    const models = raw.models
      .filter((m) => !m.file.endsWith('fx-mla-groups.yaml'))
      .map((m) => (m.file.endsWith('fx-mla-window.yaml') ? { ...m, data: { ...(m.data as object), slidingWindow: null } } : m));
    expect(validateConfig({ ...raw, models }).issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('layer-shape: catalog models get the override checks (layer-group sum, GQA head grouping) from core', () => {
    const raw = loadFixture('good');
    const withModel = (patch: object): RawConfig => ({
      ...raw,
      models: raw.models.map((m) => ({ ...m, data: { ...(m.data as object), ...patch } })),
    });
    expect(errors2(withModel({ kvHeads: 5 }))).toEqual([
      expect.objectContaining({
        file: 'models/fx-model.yaml',
        path: 'models.fx-model.kvHeads',
        message: expect.stringContaining('heads 32 is not a multiple of kvHeads 5'),
      }),
    ]);
    expect(errors2(withModel({ layerGroups: [{ kind: 'full', count: 30 }] }))).toEqual([
      expect.objectContaining({
        path: 'models.fx-model.layerGroups',
        message: 'layer group counts (mamba included) sum to 30, but layers is 32',
      }),
    ]);
    expect(errors2(withModel({ layerGroups: [{ kind: 'full', count: 32, kvHeads: 3 }] }))).toEqual([
      expect.objectContaining({ path: 'models.fx-model.layerGroups.0.kvHeads' }),
    ]);
  });

  it('zero-allreduce: a tp > 1 platform with effective all-reduce latency 0 is rejected (Ruling R14)', () => {
    const e = errors('zero-allreduce');
    expect(e).toEqual([
      expect.objectContaining({
        file: 'platforms.yaml',
        path: 'platforms.fx-node.allreduceLatencyUs',
        message: expect.stringContaining("offers tp 2/4/8 > 1, but its effective all-reduce latency is 0 µs (calibration profile 'fx-cal')"),
      }),
    ]);
    // A positive platform override is the effective value, so it fixes it.
    const raw = loadFixture('zero-allreduce');
    const pl = raw.docs.platforms!;
    const withOverride = structuredClone(pl.data) as Array<Record<string, unknown>>;
    withOverride[0]!.allreduceLatencyUs = { value: 11, status: 'estimate', basis: 'fixture', evidence: ['fx-src'], verified: '2026-10-19' };
    expect(validateConfig({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data: withOverride } } }).issues
      .filter((i) => i.level === 'error')).toEqual([]);
    // tp 1 only: 0 is allowed (single machine, no all-reduce).
    const tp1 = structuredClone(pl.data) as Array<Record<string, unknown>>;
    tp1[0]!.tpOptions = [1];
    expect(validateConfig({ ...raw, docs: { ...raw.docs, platforms: { ...pl, data: tp1 } } }).issues
      .filter((i) => i.level === 'error')).toEqual([]);
  });

  it('reports a missing required file', () => {
    const raw = loadFixture('good');
    const { policy: _p, ...docs } = raw.docs;
    const e = validateConfig({ ...raw, docs }).issues.filter((i) => i.level === 'error');
    expect(e.some((i) => i.file === 'policy.yaml' && i.message.includes('missing'))).toBe(true);
  });

  it('works with no models at all', () => {
    const raw = loadFixture('good');
    const raw2 = { ...raw, models: [] };
    // the calibration point and the workload's tierModels reference fx-model, so drop points and workloads too
    const cal = raw2.docs.calibration!;
    const data = { ...(cal.data as object), points: [] };
    const wl = raw2.docs.workloads!;
    const wlData = { ...(wl.data as object), workloads: [] };
    const r = validateConfig({ ...raw2, docs: { ...raw2.docs, calibration: { ...cal, data }, workloads: { ...wl, data: wlData } } });
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.bundle?.models).toEqual({});
  });
});

describe('native quantization and benchmark rules', () => {
  const raw = loadFixture('good');
  const q = raw.docs.quantization!;
  const quants = () => structuredClone(q.data) as Array<Record<string, unknown>>;
  const withQuants = (data: unknown, models = raw.models) => ({ ...raw, models, docs: { ...raw.docs, quantization: { ...q, data } } });
  const nq = (quant: string) => ({ method: 'fp8', quant, checkpointWeightBytes: { value: 8e9, unit: 'B', status: 'official', source: 'fx-src', verified: '2026-10-19' } });
  const withModel = (extra: Record<string, unknown>) =>
    raw.models.map((m) => ({ ...m, data: { ...(m.data as object), ...extra } }));
  const errs = (r: RawConfig) => validateConfig(r).issues.filter((i) => i.level === 'error');

  it("the quantization id 'native' is reserved", () => {
    const data = quants();
    data.push({ ...data[0]!, id: 'native', nativeForUnquantized: undefined });
    expect(errs(withQuants(data)).some((i) => i.path === 'quantization.native' && i.message.includes('reserved'))).toBe(true);
  });

  it('exactly one quantization sets nativeForUnquantized', () => {
    const none = quants();
    delete none[0]!.nativeForUnquantized;
    expect(errs(withQuants(none)).some((i) => i.message.includes('exactly one quantization must set nativeForUnquantized'))).toBe(true);
    const two = quants();
    two.push({ ...two[0]!, id: 'fx-other' });
    expect(errs(withQuants(two)).some((i) => i.message.includes('found 2: fx-fp8, fx-other'))).toBe(true);
  });

  it("a model's nativeQuant must name a quantization that has a nativeNote", () => {
    expect(errs(withQuants(q.data, withModel({ nativeQuant: nq('no-such') }))).map((i) => i.path))
      .toContain('models.fx-model.nativeQuant.quant');
    const noteless = errs(withQuants(q.data, withModel({ nativeQuant: nq('fx-fp8') })));
    expect(noteless.map((i) => i.path)).toContain('quantization.fx-fp8.vllmServe.nativeNote');
    const withNote = quants();
    (withNote[0]!.vllmServe as Record<string, unknown>).nativeNote = { value: 'n', status: 'official', source: 'fx-src', verified: '2026-10-19' };
    const r = validateConfig(withQuants(withNote, withModel({ nativeQuant: nq('fx-fp8') })));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.bundle?.models['fx-model']?.nativeQuant?.checkpointWeightBytes.value).toBe(8e9);
  });

  it('workloads.yaml benchmark is required and its sources are checked', () => {
    const wl = raw.docs.workloads!;
    const { benchmark: _b, ...noBench } = wl.data as Record<string, unknown>;
    const r = validateConfig({ ...raw, docs: { ...raw.docs, workloads: { ...wl, data: noBench } } });
    expect(r.bundle).toBeUndefined();
    expect(r.issues.some((i) => i.path.startsWith('benchmark'))).toBe(true);
    const badSrc = { ...(wl.data as object), benchmark: { maxModelLenMarginTokens: { value: 1, status: 'official', source: 'nope', verified: '2026-10-19' } } };
    expect(errs({ ...raw, docs: { ...raw.docs, workloads: { ...wl, data: badSrc } } }).map((i) => i.path))
      .toContain('benchmark.maxModelLenMarginTokens.source');
    expect(validateConfig(raw).bundle?.benchmark.maxModelLenMarginTokens.value).toBe(0);
  });
});

describe('calibration point shape and conditions', () => {
  const raw = loadFixture('good');
  const cal = raw.docs.calibration!;
  const point = () => structuredClone((cal.data as { points: Array<Record<string, unknown>> }).points[0]!);
  const withPoints = (points: Array<Record<string, unknown>>): RawConfig => ({
    ...raw, docs: { ...raw.docs, calibration: { ...cal, data: { ...(cal.data as object), points } } },
  });
  const errs = (r: RawConfig) => validateConfig(r).issues.filter((i) => i.level === 'error');

  it('a point states the tp it was measured at', () => {
    const p = point();
    delete p.tp;
    expect(errs(withPoints([p])).map((i) => i.path)).toContain('calibrationPoints.fx-point.tp');
  });

  it("a point's tp must be one vLLM accepts for the model on the platform", () => {
    // fx-model: 32 heads / 8 KV heads on an 8-GPU node with tpOptions 1/2/4/8: all legal. Remove 8 from tpOptions.
    const pl = raw.docs.platforms!;
    const plData = structuredClone(pl.data) as Array<Record<string, unknown>>;
    plData[0]!.tpOptions = [1, 2, 4];
    const r: RawConfig = { ...withPoints([{ ...point(), tp: 8 }]), docs: { ...withPoints([{ ...point(), tp: 8 }]).docs, platforms: { ...pl, data: plData } } };
    const e = errs(r).find((i) => i.path === 'calibrationPoints.fx-point.tp');
    expect(e?.message).toMatch(/tp 8 .*legal .*1, 2, 4/);
    expect(errs(withPoints([{ ...point(), tp: 4 }]))).toEqual([]);
  });

  it('uniform length sampling: the workload holds the mean of the integer range [floor(r × L), L]', () => {
    const lengths = { sampling: 'uniform', rangeRatio: 0.8, nominalInputTokens: 1024, nominalOutputTokens: 1024 };
    // floor(0.8 × 1024) = 819 → mean (819 + 1024) / 2 = 921.5; 921 and 922 are both within ±0.5.
    const ok = { ...point(), workload: { inputTokens: 922, outputTokens: 921, cacheHitRate: 0 }, conditions: { engineVersion: 'v0.22.0', lengths } };
    expect(errs(withPoints([ok]))).toEqual([]);
    const nominal = { ...ok, workload: { inputTokens: 1024, outputTokens: 1024, cacheHitRate: 0 } };
    const e = errs(withPoints([nominal])).map((i) => `${i.path}: ${i.message}`);
    expect(e.some((m) => m.startsWith('calibrationPoints.fx-point.workload.inputTokens') && m.includes('921.5'))).toBe(true);
    expect(e.some((m) => m.startsWith('calibrationPoints.fx-point.workload.outputTokens'))).toBe(true);
  });

  it('conditions record engine version, flags, environment, run link and deviations', () => {
    const p = {
      ...point(),
      conditions: {
        engineVersion: 'v0.22.0',
        engineArgs: ['--max-num-batched-tokens 8192'],
        engineEnv: { VLLM_MXFP4_USE_MARLIN: '1' },
        runUrl: 'https://github.com/example/run/1',
        deviations: ['forces the Marlin MoE kernel'],
      },
    };
    const r = validateConfig(withPoints([p]));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.bundle?.calibrationPoints['fx-point']?.conditions?.engineEnv).toEqual({ VLLM_MXFP4_USE_MARLIN: '1' });
    expect(errs(withPoints([{ ...p, conditions: { ...p.conditions, runUrl: 'not a url' } }])).map((i) => i.path))
      .toContain('calibrationPoints.fx-point.conditions.runUrl');
  });
});

describe('derived calibration values cite fit points (Rulings R30, R41)', () => {
  const raw = loadFixture('good');
  const cal = raw.docs.calibration!;
  const withCal = (mut: (d: { profiles: Array<Record<string, any>>; points: Array<Record<string, any>> }) => void): RawConfig => {
    const data = structuredClone(cal.data) as { profiles: Array<Record<string, any>>; points: Array<Record<string, any>> };
    mut(data);
    return { ...raw, docs: { ...raw.docs, calibration: { ...cal, data } } };
  };
  const derived = (inputs: string[]) => ({ value: 0.003, unit: 's', status: 'derived', formula: 'f', inputs, verified: '2026-10-20' });
  const errs = (r: RawConfig) => validateConfig(r).issues.filter((i) => i.level === 'error');

  it('a derived value may name a fit point (with or without sources) in inputs', () => {
    const r = withCal((d) => {
      d.points[0]!.role = 'fit';
      d.profiles[0]!.tFixedSec = derived(['fx-point', 'fx-src']);
    });
    expect(errs(r)).toEqual([]);
  });

  it('naming a validate point is refused: validate points are independent checks, never fitted', () => {
    const r = withCal((d) => { d.profiles[0]!.tFixedSec = derived(['fx-point']); });
    const e = errs(r).find((i) => i.path === 'calibration.fx-cal.tFixedSec.inputs[0]');
    expect(e?.message).toMatch(/validate point 'fx-point'/);
  });

  it('an id that is neither a source nor a calibration point is still unknown', () => {
    const r = withCal((d) => { d.profiles[0]!.tFixedSec = derived(['no-such']); });
    expect(errs(r).map((i) => i.message)).toContain("unknown source id 'no-such' in inputs");
  });
});

describe('calibration.yaml and workloads.yaml have strict top-level keys (final-review M18)', () => {
  it('a misspelt top-level key is an error, not silently ignored', () => {
    const raw = loadFixture('good');
    const cal = raw.docs.calibration!;
    const calData = { ...(cal.data as Record<string, unknown>), poitns: [] };
    expect(errors2({ ...raw, docs: { ...raw.docs, calibration: { ...cal, data: calData } } }))
      .toEqual([expect.objectContaining({ path: 'calibration.poitns', message: expect.stringContaining('unknown top-level key') })]);
    const wl = raw.docs.workloads!;
    const wlData = { ...(wl.data as Record<string, unknown>), speedPreset: [] };
    expect(errors2({ ...raw, docs: { ...raw.docs, workloads: { ...wl, data: wlData } } }))
      .toEqual([expect.objectContaining({ path: 'workloads.speedPreset', message: expect.stringContaining('unknown top-level key') })]);
  });
});
