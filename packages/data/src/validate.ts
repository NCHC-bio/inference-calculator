import type { z } from 'zod';
import {
  BenchmarkRuleSchema, FunnelSchema, BundleSchema, CalibrationPointSchema, CalibrationProfileSchema, ConcurrencyRuleSchema, HardwareSchema,
  CustomHardwareSchema, MetaSchema, ModelSchema, PlatformSchema, PolicySchema, QuantizationSchema, SourceSchema, SpeedPresetSchema,
  WorkloadSchema, SkippedCalibrationPointSchema, CalibrationGapSchema, type Bundle, type CalibrationPoint, type Hardware, type Model, type Platform, type Quantization,
} from '@nchc/schema';
import { excludedOrgOf, layerShapeIssues, legalTpOptions, mlaLayoutIssues, moeParamsIssue } from '@nchc/core';
import { CONFIG_FILES, type ConfigSection, type RawConfig, type RawDoc } from './load';

export interface ValidationIssue {
  level: 'error' | 'warning';
  /** Config-relative file, e.g. `platforms.yaml` or `models/x.yaml`. */
  file: string;
  /** Dotted path keyed by id, e.g. `platforms.nano4-h200.hardware`. */
  path: string;
  message: string;
}

type Collection =
  | 'sources' | 'hardware' | 'platforms' | 'quantization' | 'models'
  | 'workloads' | 'speedPresets' | 'calibration' | 'calibrationPoints'
  | 'skippedCalibrationPoints' | 'calibrationGaps';

interface Item { id: string; file: string; value: Record<string, unknown> }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const joinPath = (...parts: Array<string | number>) =>
  parts.filter((p) => p !== '').map(String).join('.');

/**
 * Validate raw config, in order: (1) zod-parse every file, (2) duplicate ids, (3) referential integrity
 * (platform → hardware/calibration, every source/evidence/inputs/sources id, no official / measured value citing a
 * secondary source, calibration point → platform/model/quant,
 * hardware behind a tp > 1 platform has nvlinkBidirGBs, a tp > 1 platform has an effective all-reduce latency > 0
 * (platform override ?? calibration profile; Ruling R14), every tpOptions value ≤ gpusPerNode, hardware has tflops for every quantization's computeDtype
 * or `effective`,
 * a calibration point's tp is one vLLM accepts for its model on its platform (legalTpOptions) and, with uniform length
 * sampling, its workload holds the mean length (Ruling R41),
 * skipped calibration point → platform/quant, calibration gap → platforms, workload tierModels → catalog models,
 * custom-hardware template → a platform whose calibration engine equals the template key),
 * (3b) quantization: the id 'native' is reserved (API input), exactly one sets `nativeForUnquantized`; a model's
 * `nativeQuant.quant` names a quantization whose vllmServe has a `nativeNote`,
 * (4) model file name = id, (4b) MoE expert parameters ≤ totalParamsB and active parameters > 0 (Ruling R31),
 * (4c) attention 'mla' with layerGroups or a non-null slidingWindow is not supported yet (Ruling R22),
 * (5) policy (spec §2.2): the publisher's origin country against policy.excludedCountries, and the owner of
 * hfRepo / skipped calibration point modelRepo against policy.excludedOrgs (whose countries must be excluded
 * countries). baseModel / baseOrigin are not checked. Applies to the catalog, tier reference models and calibration
 * points.
 * Returns a bundle only when there are no errors.
 */
export function validateConfig(raw: RawConfig): { bundle?: Bundle; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (file: string, path: string, message: string) => issues.push({ level: 'error', file, path, message });

  const doc = (section: ConfigSection): RawDoc | undefined => {
    const d = raw.docs[section];
    if (!d) err(CONFIG_FILES[section], section, `missing required file ${CONFIG_FILES[section]}`);
    return d;
  };

  const zodIssues = (file: string, prefix: string, e: z.ZodError) => {
    for (const i of e.issues) err(file, joinPath(prefix, ...i.path.map(String)), i.message);
  };

  const parseOne = <S extends z.ZodType>(file: string, prefix: string, data: unknown, schema: S): z.infer<S> | undefined => {
    const r = schema.safeParse(data);
    if (r.success) return r.data;
    zodIssues(file, prefix, r.error);
    return undefined;
  };

  // ---- 1 + 2: parse, de-duplicate ----
  const collections = {} as Record<Collection, Item[]>;
  const addList = (label: Collection, file: string, data: unknown, schema: z.ZodType) => {
    const items: Item[] = [];
    const seen = new Set<string>();
    if (!Array.isArray(data)) {
      err(file, label, `${label} must be a YAML list`);
    } else {
      data.forEach((el, i) => {
        const id = isObj(el) && typeof el.id === 'string' ? el.id : `[${i}]`;
        const v = parseOne(file, joinPath(label, id), el, schema);
        if (v === undefined) return;
        if (seen.has(id)) {
          err(file, joinPath(label, id), `duplicate id '${id}'`);
          return;
        }
        seen.add(id);
        items.push({ id, file, value: v as Record<string, unknown> });
      });
    }
    collections[label] = [...(collections[label] ?? []), ...items];
  };

  const metaDoc = doc('meta');
  const meta = metaDoc && parseOne(metaDoc.file, 'meta', metaDoc.data, MetaSchema);
  const policyDoc = doc('policy');
  const policy = policyDoc && parseOne(policyDoc.file, 'policy', policyDoc.data, PolicySchema);
  const chDoc = doc('customHardware');
  const customHardware = chDoc && parseOne(chDoc.file, 'customHardware', chDoc.data, CustomHardwareSchema);

  for (const [label, schema] of [
    ['sources', SourceSchema], ['hardware', HardwareSchema], ['platforms', PlatformSchema],
    ['quantization', QuantizationSchema],
  ] as const) {
    const d = doc(label);
    if (d) addList(label, d.file, d.data, schema);
    else collections[label] = [];
  }

  let concurrency: z.infer<typeof ConcurrencyRuleSchema> | undefined;
  let benchmark: z.infer<typeof BenchmarkRuleSchema> | undefined;
  let funnel: z.infer<typeof FunnelSchema> | undefined;
  const wl = doc('workloads');
  collections.workloads = [];
  collections.speedPresets = [];
  // Strict top-level keys (final-review M18): a misspelt section (e.g. `poitns:`) would otherwise be ignored silently.
  const strictTop = (d: { file: string; data: Record<string, unknown> }, label: string, keys: readonly string[]) => {
    for (const k of Object.keys(d.data)) {
      if (!keys.includes(k)) err(d.file, `${label}.${k}`, `unknown top-level key '${k}' (allowed: ${keys.join(', ')})`);
    }
  };
  if (wl) {
    if (!isObj(wl.data)) err(wl.file, 'workloads', 'workloads.yaml must be a mapping with workloads, speedPresets, concurrency, benchmark, funnel');
    else {
      strictTop({ file: wl.file, data: wl.data }, 'workloads', ['workloads', 'speedPresets', 'concurrency', 'benchmark', 'funnel']);
      addList('workloads', wl.file, wl.data.workloads, WorkloadSchema);
      addList('speedPresets', wl.file, wl.data.speedPresets, SpeedPresetSchema);
      concurrency = parseOne(wl.file, 'concurrency', wl.data.concurrency, ConcurrencyRuleSchema);
      benchmark = parseOne(wl.file, 'benchmark', wl.data.benchmark, BenchmarkRuleSchema);
      funnel = parseOne(wl.file, 'funnel', wl.data.funnel, FunnelSchema);
    }
  }

  const cal = doc('calibration');
  collections.calibration = [];
  collections.calibrationPoints = [];
  collections.skippedCalibrationPoints = [];
  collections.calibrationGaps = [];
  if (cal) {
    if (!isObj(cal.data)) err(cal.file, 'calibration', 'calibration.yaml must be a mapping with profiles, points, skipped, gaps');
    else {
      strictTop({ file: cal.file, data: cal.data }, 'calibration', ['profiles', 'points', 'skipped', 'gaps']);
      addList('calibration', cal.file, cal.data.profiles, CalibrationProfileSchema);
      addList('calibrationPoints', cal.file, cal.data.points ?? [], CalibrationPointSchema);
      addList('skippedCalibrationPoints', cal.file, cal.data.skipped ?? [], SkippedCalibrationPointSchema);
      addList('calibrationGaps', cal.file, cal.data.gaps ?? [], CalibrationGapSchema);
    }
  }

  collections.models = [];
  const modelSeen = new Set<string>();
  for (const m of raw.models) {
    const id = isObj(m.data) && typeof m.data.id === 'string' ? m.data.id : m.file;
    const v = parseOne(m.file, joinPath('models', id), m.data, ModelSchema);
    if (v === undefined) continue;
    if (modelSeen.has(id)) {
      err(m.file, joinPath('models', id), `duplicate id '${id}'`);
      continue;
    }
    modelSeen.add(id);
    collections.models.push({ id, file: m.file, value: v as Record<string, unknown> });
  }

  // ---- 3: referential integrity ----
  const ids = (c: Collection) => new Set(collections[c].map((i) => i.id));
  const has = { hardware: ids('hardware'), calibration: ids('calibration'), platforms: ids('platforms'),
    models: ids('models'), quantization: ids('quantization'), sources: ids('sources') };

  const ref = (item: Item, label: Collection, field: string, target: keyof typeof has, what: string) => {
    const v = item.value[field];
    if (typeof v === 'string' && !has[target].has(v)) {
      err(item.file, joinPath(label, item.id, field), `unknown ${what} id '${v}'`);
    }
  };
  for (const p of collections.platforms) {
    ref(p, 'platforms', 'hardware', 'hardware', 'hardware');
    ref(p, 'platforms', 'calibration', 'calibration', 'calibration profile');
  }
  // Platform → hardware capabilities the API needs (finding 2): without these resolvePlatform / allReduceSec throw.
  const hwItems = new Map(collections.hardware.map((h) => [h.id, h]));
  const reported = new Set<string>(); // one error per hardware path, even when several platforms share it
  const hwErr = (file: string, path: string, message: string) => {
    if (!reported.has(path)) err(file, path, message);
    reported.add(path);
  };
  for (const p of collections.platforms) {
    const pv = p.value as unknown as Platform;
    const hwItem = hwItems.get(pv.hardware);
    if (!hwItem) continue;
    const hw = hwItem.value as unknown as Hardware;
    const multi = pv.tpOptions.filter((t) => t > 1);
    if (multi.length > 0 && !hw.nvlinkBidirGBs) {
      hwErr(hwItem.file, joinPath('hardware', hw.id, 'nvlinkBidirGBs'),
        `required: platform '${pv.id}' offers tp ${multi.join('/')} > 1, and tensor-parallel all-reduce needs the link bandwidth`);
    }
    if (!hw.tflops.effective) {
      for (const q of collections.quantization) {
        const dtype = (q.value as unknown as Quantization).computeDtype;
        if (!hw.tflops[dtype]) {
          hwErr(hwItem.file, joinPath('hardware', hw.id, 'tflops', dtype),
            `required: platform '${pv.id}' can run quantization '${q.id}' (computeDtype ${dtype}), but hardware has neither tflops.${dtype} nor tflops.effective`);
        }
      }
    }
  }
  // Tensor parallelism stays inside one node (multi-node sharding is out of scope; review M4).
  for (const p of collections.platforms) {
    const pv = p.value as unknown as Platform;
    pv.tpOptions.forEach((t, i) => {
      if (t > pv.gpusPerNode.value) {
        err(p.file, `${joinPath('platforms', pv.id, 'tpOptions')}[${i}]`,
          `tp ${t} exceeds gpusPerNode ${pv.gpusPerNode.value} (multi-node tensor parallelism is out of scope)`);
      }
    });
  }
  // A tp > 1 platform must have a positive all-reduce latency (Ruling R14): 0 would make tensor-parallel
  // communication look free. Effective value = platform override ?? calibration profile (as resolvePlatform).
  const calItems = new Map(collections.calibration.map((c) => [c.id, c]));
  for (const p of collections.platforms) {
    const pv = p.value as unknown as Platform;
    const multi = pv.tpOptions.filter((t) => t > 1);
    if (multi.length === 0) continue;
    const prof = calItems.get(pv.calibration)?.value as { allreduceLatencyUs?: { value: number } } | undefined;
    const latency = pv.allreduceLatencyUs ?? prof?.allreduceLatencyUs;
    if (latency !== undefined && !(latency.value > 0)) {
      err(p.file, joinPath('platforms', pv.id, 'allreduceLatencyUs'),
        `platform '${pv.id}' offers tp ${multi.join('/')} > 1, but its effective all-reduce latency is ${latency.value} µs ` +
        `(${pv.allreduceLatencyUs ? 'platform override' : `calibration profile '${pv.calibration}'`}); it must be > 0`);
    }
  }
  // vLLM engine defaults exist exactly on vLLM platforms (review L9, L10): the KV and verify math read them.
  for (const p of collections.platforms) {
    const pv = p.value as unknown as Platform;
    const engine = (calItems.get(pv.calibration)?.value as { engine?: string } | undefined)?.engine;
    if (engine === 'vllm' && pv.vllmDefaults === undefined) {
      err(p.file, joinPath('platforms', pv.id, 'vllmDefaults'),
        `platform '${pv.id}' runs vLLM (calibration profile '${pv.calibration}'), so it needs vllmDefaults (maxNumSeqs, maxNumBatchedTokens)`);
    }
    if (engine === 'mlx' && pv.vllmDefaults !== undefined) {
      err(p.file, joinPath('platforms', pv.id, 'vllmDefaults'),
        `platform '${pv.id}' runs mlx (calibration profile '${pv.calibration}'); vllmDefaults apply to vLLM platforms only`);
    }
  }
  // mlx-lm defaults exist exactly on MLX calibration profiles (spec §5.1): the KV allocation reads them.
  for (const c of collections.calibration) {
    const cv = c.value as { id: string; engine: string; mlxDefaults?: unknown };
    if (cv.engine === 'mlx' && cv.mlxDefaults === undefined) {
      err(c.file, joinPath('calibration', cv.id, 'mlxDefaults'), `calibration profile '${cv.id}' runs mlx, so it needs mlxDefaults (kvCacheStep, prefillStepSize)`);
    }
    if (cv.engine === 'vllm' && cv.mlxDefaults !== undefined) {
      err(c.file, joinPath('calibration', cv.id, 'mlxDefaults'), `calibration profile '${cv.id}' runs vLLM; mlxDefaults apply to mlx profiles only`);
    }
  }
  const platformItems = new Map(collections.platforms.map((p) => [p.id, p]));
  // Custom hardware templates (spec 2026-10-21 §6.2): a custom platform of engine E borrows the calibration and vLLM
  // defaults of templates[E].platform, so that platform must exist and run E.
  if (customHardware && chDoc) {
    for (const [engine, t] of Object.entries(customHardware.templates)) {
      const path = joinPath('customHardware', 'templates', engine, 'platform');
      const plat = platformItems.get(t.platform)?.value as unknown as Platform | undefined;
      if (!plat) {
        err(chDoc.file, path, `unknown platform id '${t.platform}'`);
        continue;
      }
      const profEngine = (calItems.get(plat.calibration)?.value as { engine?: string } | undefined)?.engine;
      if (profEngine !== undefined && profEngine !== engine) {
        err(chDoc.file, path,
          `template platform '${t.platform}' runs engine '${profEngine}' (calibration profile '${plat.calibration}'), not '${engine}'`);
      }
    }
  }
  const modelById = new Map(collections.models.map((m) => [m.id, m]));
  for (const pt of collections.calibrationPoints) {
    ref(pt, 'calibrationPoints', 'platform', 'platforms', 'platform');
    ref(pt, 'calibrationPoints', 'model', 'models', 'model');
    ref(pt, 'calibrationPoints', 'quant', 'quantization', 'quantization');
    const pv = pt.value as unknown as CalibrationPoint;
    // The prediction runs at the point's own tp (Ruling R41), so it must be a TP vLLM accepts for this model here.
    const plat = platformItems.get(pv.platform)?.value as unknown as Platform | undefined;
    const mod = modelById.get(pv.model)?.value as unknown as Model | undefined;
    if (plat && mod) {
      const legal = legalTpOptions(plat.tpOptions, plat.gpusPerNode.value, mod);
      if (!legal.includes(pv.tp)) {
        err(pt.file, joinPath('calibrationPoints', pt.id, 'tp'),
          `tp ${pv.tp} is not a legal TP for model '${mod.id}' on platform '${plat.id}' (legal: ${legal.join(', ') || 'none'}; tpOptions, ≤ gpusPerNode, head divisibility)`);
      }
    }
    // Uniform length sampling: the calculator takes one length, the mean of the integers in [floor(r × L), L].
    const lengths = pv.conditions?.lengths;
    if (lengths?.sampling === 'uniform') {
      const pairs = [['inputTokens', lengths.nominalInputTokens], ['outputTokens', lengths.nominalOutputTokens]] as const;
      for (const [field, nominal] of pairs) {
        const mean = (Math.floor(lengths.rangeRatio * nominal + 1e-9) + nominal) / 2;
        if (Math.abs(pv.workload[field] - mean) > 0.5) {
          err(pt.file, joinPath('calibrationPoints', pt.id, 'workload', field),
            `uniform length sampling (range ratio ${lengths.rangeRatio}, nominal ${nominal}): the workload must hold the mean ${mean} (±0.5), got ${pv.workload[field]}`);
        }
      }
    }
  }
  for (const sk of collections.skippedCalibrationPoints) {
    ref(sk, 'skippedCalibrationPoints', 'platform', 'platforms', 'platform');
    ref(sk, 'skippedCalibrationPoints', 'quant', 'quantization', 'quantization');
  }
  // Workload tier reference models (review I3): catalog ids (the catalog itself is checked in step 5).
  const modelItems = new Map(collections.models.map((m) => [m.id, m]));
  for (const w of collections.workloads) {
    const list = w.value.tierModels;
    if (!Array.isArray(list)) continue;
    list.forEach((mid, i) => {
      if (typeof mid !== 'string') return;
      const path = `${joinPath('workloads', w.id, 'tierModels')}[${i}]`;
      const m = modelItems.get(mid);
      if (!m) err(w.file, path, `unknown model id '${mid}'`);
    });
  }
  for (const g of collections.calibrationGaps) {
    const list = g.value.platforms;
    if (Array.isArray(list)) {
      list.forEach((p, i) => {
        if (typeof p === 'string' && !has.platforms.has(p)) {
          err(g.file, `${joinPath('calibrationGaps', g.id, 'platforms')}[${i}]`, `unknown platform id '${p}'`);
        }
      });
    }
  }

  // ---- 3b: quantization ids and native quantization (API `quant: 'native'`) ----
  const quantItems = new Map(collections.quantization.map((q) => [q.id, q]));
  for (const q of collections.quantization) {
    if (q.id === 'native') err(q.file, joinPath('quantization', q.id), "quantization id 'native' is reserved (API input resolving to a model's native format)");
  }
  const unq = collections.quantization.filter((q) => (q.value as unknown as Quantization).nativeForUnquantized === true);
  if (unq.length !== 1) {
    const qDoc = raw.docs.quantization;
    if (qDoc) {
      err(qDoc.file, 'quantization', `exactly one quantization must set nativeForUnquantized (the format an unquantized checkpoint is served in); found ${unq.length}${unq.length > 0 ? `: ${unq.map((q) => q.id).join(', ')}` : ''}`);
    }
  }
  for (const m of collections.models) {
    const nq = (m.value as unknown as Model).nativeQuant;
    if (!nq) continue;
    const q = quantItems.get(nq.quant);
    if (!q) err(m.file, joinPath('models', m.id, 'nativeQuant', 'quant'), `unknown quantization id '${nq.quant}'`);
    else if (!(q.value as unknown as Quantization).vllmServe.nativeNote) {
      err(q.file, joinPath('quantization', q.id, 'vllmServe', 'nativeNote'),
        `required: model '${m.id}' is natively '${q.id}', and its verify command needs the native-checkpoint note`);
    }
  }

  /**
   * Walk any parsed value; check `source`, `evidence[]`, `inputs[]`, `sources[]` ids against sources (`inputs` may also name
   * fit calibration points, never validate ones; Ruling R41), and that an
   * official / measured value does not cite a secondary source (spec §2.1: secondary-only data is unverified; review M8).
   */
  const sourceKind = new Map(collections.sources.map((s) => [s.id, s.value.kind]));
  const pointRoles = new Map(collections.calibrationPoints.map((p) => [p.id, (p.value as unknown as CalibrationPoint).role]));
  const checkSources = (file: string, path: string, node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => checkSources(file, `${path}[${i}]`, x));
      return;
    }
    if (!isObj(node)) return;
    if (typeof node.source === 'string' && !has.sources.has(node.source)) {
      err(file, joinPath(path, 'source'), `unknown source id '${node.source}'`);
    }
    if ((node.status === 'official' || node.status === 'measured') && typeof node.source === 'string'
      && sourceKind.get(node.source) === 'secondary') {
      err(file, joinPath(path, 'source'),
        `${node.status} value cites source '${node.source}' of kind secondary (official / measured need a primary source; use unverified)`);
    }
    for (const key of ['evidence', 'inputs', 'sources'] as const) {
      const list = node[key];
      if (Array.isArray(list)) {
        list.forEach((id, i) => {
          // A derived value's inputs may name the calibration points it was fitted on (Ruling R41): fit points only,
          // since validate points are independent checks that must never set a value (Ruling R30).
          const pointRole = key === 'inputs' && typeof id === 'string' ? pointRoles.get(id) : undefined;
          if (pointRole === 'validate') {
            err(file, `${joinPath(path, key)}[${i}]`, `inputs names validate point '${id}'; only fit points may set a value (Ruling R30)`);
            return;
          }
          if (pointRole === 'fit') return;
          if (typeof id === 'string' && !has.sources.has(id)) {
            err(file, `${joinPath(path, key)}[${i}]`, `unknown source id '${id}' in ${key}`);
          }
        });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'evidence' && k !== 'inputs' && k !== 'sources') checkSources(file, joinPath(path, k), v);
    }
  };
  for (const label of Object.keys(collections) as Collection[]) {
    if (label === 'sources') continue;
    for (const item of collections[label]) checkSources(item.file, joinPath(label, item.id), item.value);
  }
  if (policy && policyDoc) checkSources(policyDoc.file, 'policy', policy);
  if (customHardware && chDoc) checkSources(chDoc.file, 'customHardware', customHardware);
  if (concurrency && wl) checkSources(wl.file, 'concurrency', concurrency);
  if (benchmark && wl) checkSources(wl.file, 'benchmark', benchmark);
  if (funnel && wl) checkSources(wl.file, 'funnel', funnel);

  // ---- 4: model file name = id ----
  for (const m of collections.models) {
    const base = m.file.replace(/^models\//, '').replace(/\.ya?ml$/, '');
    if (base !== m.id) err(m.file, joinPath('models', m.id), `file name '${base}' does not match id '${m.id}'`);
  }

  // ---- 4b: MoE parameter split (Ruling R31c; core's formula, not a copy) ----
  for (const m of collections.models) {
    const issue = moeParamsIssue(m.value as unknown as Model);
    if (issue) err(m.file, joinPath('models', m.id, 'moe'), `MoE parameters inconsistent: ${issue}`);
  }

  // ---- 4c: MLA layouts the KV math does not model (Ruling R22; core's check, not a copy) ----
  for (const m of collections.models) {
    for (const i of mlaLayoutIssues(m.value as unknown as Model)) err(m.file, joinPath('models', m.id, i.field), i.message);
  }

  // ---- 4d: layer-group sum and GQA head grouping (core's check, not a copy; the importer guarantees them, a hand edit may not) ----
  for (const m of collections.models) {
    for (const i of layerShapeIssues(m.value as unknown as Model)) err(m.file, joinPath('models', m.id, ...i.path), i.message);
  }

  // ---- 5: policy (spec §2.2) ----
  if (policy) {
    const excluded = new Set(policy.excludedCountries);
    // The publisher's country is checked; a base model's origin is not.
    for (const m of collections.models) {
      const o = m.value.origin;
      if (isObj(o) && typeof o.country === 'string' && excluded.has(o.country)) {
        err(m.file, joinPath('models', m.id, 'origin', 'country'),
          `policy: model origin (publisher) country ${o.country} is in policy.excludedCountries`);
      }
    }
    // Excluded HF orgs (review I2, M3): the repo owner is checked, whatever origin flags the file
    // claims. A skipped calibration point names an owner/name modelRepo (owner checked) or a modelName with its
    // modelOrigin (country checked); free text is a schema error (final-review I4).
    policy.excludedOrgs.forEach((o, i) => {
      if (!excluded.has(o.country)) {
        err(policyDoc!.file, `policy.excludedOrgs[${i}].country`,
          `excluded org '${o.org}' has country ${o.country}, which is not in policy.excludedCountries`);
      }
    });
    const checkRepo = (item: Item, label: Collection, field: string) => {
      const repo = item.value[field];
      if (typeof repo !== 'string') return;
      let o: ReturnType<typeof excludedOrgOf>;
      try {
        o = excludedOrgOf(policy, repo);
      } catch (e) {
        // Fail closed (final-review I4); the schema already rejects such values, so this is a second line.
        err(item.file, joinPath(label, item.id, field), `policy: ${(e as Error).message}`);
        return;
      }
      if (o) {
        const owner = repo.slice(0, repo.indexOf('/')).trim();
        err(item.file, joinPath(label, item.id, field),
          `policy: ${field} '${repo}' is from org '${owner}' (${o.country}), listed in policy.excludedOrgs`);
      }
    };
    for (const m of collections.models) checkRepo(m, 'models', 'hfRepo');
    for (const sk of collections.skippedCalibrationPoints) {
      checkRepo(sk, 'skippedCalibrationPoints', 'modelRepo');
      // Without an exact repo the point names its publisher, which the country rule judges (final-review I4).
      const mo = sk.value.modelOrigin;
      if (isObj(mo) && typeof mo.country === 'string' && excluded.has(mo.country)) {
        err(sk.file, joinPath('skippedCalibrationPoints', sk.id, 'modelOrigin', 'country'),
          `policy: skipped point's model publisher country ${mo.country} is in policy.excludedCountries`);
      }
    }
  }

  if (issues.some((i) => i.level === 'error') || !meta || !policy || !concurrency || !benchmark || !funnel || !customHardware) return { issues };

  const record = (c: Collection) => Object.fromEntries(collections[c].map((i) => [i.id, i.value]));
  const assembled = {
    meta, policy,
    sources: record('sources'), hardware: record('hardware'), platforms: record('platforms'),
    quantization: record('quantization'), models: record('models'), workloads: record('workloads'),
    speedPresets: record('speedPresets'), calibration: record('calibration'), concurrency, benchmark, funnel,
    calibrationPoints: record('calibrationPoints'),
    skippedCalibrationPoints: record('skippedCalibrationPoints'), calibrationGaps: record('calibrationGaps'),
    customHardware,
  };
  const r = BundleSchema.safeParse(assembled);
  if (!r.success) {
    zodIssues('(bundle)', '', r.error);
    return { issues };
  }
  return { bundle: r.data, issues };
}
