/**
 * Browser-safe Hugging Face model fetch + parse, shared by the CLI importer (hf-import.ts) and the website's custom
 * model flow. No `node:` import, no fs, no yaml. The token (if any) is sent only to https://huggingface.co/ and is
 * never stored or logged here (direct-manipulation design §6.3).
 */
import { HF_REPO_RE, UNCHECKED_ORIGIN, type Model, type Origin, type Source } from '@nchc/schema';
import { checkpointWeightBytes, hfSourceId, parseHfConfig, quantizationConfig, type EstimatedFeature } from './hf-parse';

export { ESTIMATED_FEATURES, type EstimatedFeature } from './hf-parse';

const HF = 'https://huggingface.co';

export type HfFetchResponse = {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Present on a real Response; used to explain a 401/403 (X-Error-Code / X-Error-Message). */
  headers?: { get(name: string): string | null };
};

export type HfBaseSpec = { repo: string; origin?: Origin };

/**
 * The steps of an import, in order: the model API (sha, parameter count, file list), config.json, a ModelOpt
 * hf_quant_config.json, the checkpoint's weight-file sizes (revision API + safetensors index), the base model's parameter
 * count (a packed quantized checkpoint), a GGUF repo's base model, and reading the architecture. Steps a model does
 * not need are skipped.
 */
export const HF_STEPS = ['model-info', 'config', 'quant-config', 'checkpoint-size', 'base-params', 'gguf-base', 'parse'] as const;
export type HfStep = (typeof HF_STEPS)[number];

export type HfFetchDeps = {
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<HfFetchResponse>;
  token?: string;
  revision?: string;
  /**
   * Publisher origin recorded on the model. The CLI always passes it (--developer / --country; catalog models are
   * policy-checked, spec §2.2). The website does not: a user-imported model gets UNCHECKED_ORIGIN and the
   * custom-model warning instead (Ruling W12).
   */
  origin?: Origin;
  /** ISO date written to `verified` / `accessed`; defaults to today. */
  today?: string;
  /** Called as each step starts, so a caller can tell the user what is happening (HF_STEPS). */
  onProgress?: (step: HfStep, repo: string) => void;
  /** Estimates already made by the caller (a GGUF repo read through its base model). */
  estimates?: Array<{ feature: EstimatedFeature; detail: string }>;
  /**
   * Called with the model card's `base_model` repos right after the model API answers, before config.json is read.
   * Returns the lineage to record, or `error` to stop (status 'unparsable', message verbatim).
   */
  resolveBase?: (cardBases: string[]) => { base?: HfBaseSpec; error?: string };
};

/**
 * Hugging Face tasks (pipeline_tag) of models that generate text, the calculator's subject (LLM inference). A repo
 * tagged with another task (an image encoder, a speech recogniser, …) that has no language-model config is reported as
 * not a language model rather than as an importer bug.
 */
export const TEXT_GENERATION_TASKS: ReadonlySet<string> = new Set([
  'text-generation', 'text2text-generation', 'image-text-to-text', 'video-text-to-text', 'audio-text-to-text',
  'any-to-any', 'visual-question-answering', 'conversational',
]);

export type HfFetchResult =
  | {
    ok: true; repo: string; sha: string; model: Model; source: Source; notes: string[];
    /** Model card `base_model` repos (empty when none). */
    cardBases: string[];
  }
  | {
    ok: false;
    /**
     * `unparsable`: a field no estimate can do without is missing, an importer bug (CLAUDE.md "Goal for imported
     * models"); `gguf`: a GGUF-only repo whose model card names no base model to read the architecture from.
     */
    status: 'denied' | 'not-found' | 'invalid' | 'unparsable' | 'network' | 'gguf' | 'not-language-model';
    /** not-language-model: the repo's Hugging Face task (pipeline_tag), e.g. image-feature-extraction. */
    task?: string;
    /** One readable reason, each problem named once. */
    message: string;
    /** Every field that could not be read, each once. */
    missing?: string[];
    /** The repo and the commit it was read at, once the model API answered (for the "report this model" link). */
    repo?: string;
    sha?: string;
    baseModels?: string[];
  };

/** Model-card `base_model` as a list of repos: a string, a list of strings, or absent. */
export function cardBaseModels(v: unknown): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/** Start of every `denied` message; CLI-neutral since the browser shows it too (the CLI swaps in its flag hint). */
export const DENIED_PREFIX = 'gated or private repo: an access token is required';

/**
 * 401/403 message. HF also answers 401 for a misspelled or private repo, so the X-Error-Code /
 * X-Error-Message headers (e.g. GatedRepo vs RepositoryNotFound) and a body snippet are included.
 */
async function deniedMessage(res: HfFetchResponse, what: string): Promise<string> {
  const code = res.headers?.get('X-Error-Code');
  const msg = res.headers?.get('X-Error-Message');
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = [code && `X-Error-Code: ${code}`, msg, body && body !== msg ? `body: ${body}` : ''].filter(Boolean).join('; ');
  return `${DENIED_PREFIX} (HTTP ${res.status} on ${what}${hint ? `; ${hint}` : ''})`;
}

class Stop extends Error {
  constructor(readonly result: HfFetchResult) { super('stop'); }
}

export async function fetchHfModel(repo: string, deps: HfFetchDeps): Promise<HfFetchResult> {
  if (!HF_REPO_RE.test(repo)) {
    return { ok: false, status: 'invalid', message: `'${repo}' is not a Hugging Face repo id owner/name` };
  }
  if (deps.revision && !/^[\w.-]+$/.test(deps.revision)) {
    return { ok: false, status: 'invalid', message: `revision '${deps.revision}' is not a commit or branch name` };
  }
  const init = deps.token ? { headers: { Authorization: `Bearer ${deps.token}` } } : undefined;
  // Only huggingface.co ever sees the token.
  const get = async (url: string, what: string): Promise<HfFetchResponse> => {
    let res: HfFetchResponse;
    try {
      res = await deps.fetch(url, url.startsWith(`${HF}/`) ? init : undefined);
    } catch (e) {
      throw new Stop({ ok: false, status: 'network', message: e instanceof Error ? e.message : String(e) });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Stop({ ok: false, status: 'denied', message: await deniedMessage(res, what) });
    }
    return res;
  };
  const httpFail = (res: HfFetchResponse, what: string): Stop =>
    new Stop({ ok: false, status: res.status === 404 ? 'not-found' : 'network', message: `${what} HTTP ${res.status}` });
  const json = async (res: HfFetchResponse, what: string, viaText: boolean): Promise<unknown> => {
    try {
      return viaText ? (JSON.parse(await res.text()) as unknown) : await res.json();
    } catch {
      throw new Stop({ ok: false, status: 'network', message: `${what} is not valid JSON` });
    }
  };

  try {
    const at = deps.revision ? `/revision/${deps.revision}` : '';
    deps.onProgress?.('model-info', repo);
    const apiRes = await get(`${HF}/api/models/${repo}${at}?expand[]=safetensors&expand[]=sha&expand[]=cardData&expand[]=siblings`, 'model API');
    if (!apiRes.ok) throw httpFail(apiRes, 'model API');
    const api = (await json(apiRes, 'model API', false)) as {
      sha?: string;
      safetensors?: { total?: number };
      cardData?: { license?: string; license_name?: string; base_model?: unknown };
      siblings?: Array<{ rfilename?: unknown }>;
    };
    if (!api.sha) throw new Stop({ ok: false, status: 'network', message: 'model API returned no sha' });
    const sha = api.sha;

    const cardBases = cardBaseModels(api.cardData?.base_model);
    const resolved = deps.resolveBase?.(cardBases);
    if (resolved?.error) throw new Stop({ ok: false, status: 'unparsable', message: resolved.error });

    // A GGUF-only repo has no config.json: the model it was converted from (card base_model) gives the architecture and
    // parameters, an estimate of the GGUF model (its precision is chosen in the calculator).
    const names = (api.siblings ?? []).map((s) => s.rfilename).filter((n): n is string => typeof n === 'string');
    if (!names.includes('config.json') && names.some((n) => /.gguf$/i.test(n))) {
      const base = cardBases[0];
      if (base === undefined || deps.estimates?.some((e) => e.feature === 'gguf')) {
        throw new Stop({
          ok: false, status: 'gguf', repo, sha, baseModels: cardBases,
          message: 'GGUF repo without config.json, and its model card names no base model to read the architecture from',
        });
      }
      const { revision: _r, resolveBase: _b, ...rest } = deps;
      deps.onProgress?.('gguf-base', base);
      return fetchHfModel(base, {
        ...rest,
        estimates: [...(deps.estimates ?? []), {
          feature: 'gguf',
          detail: `${repo} is a GGUF conversion: architecture and parameter count read from its base model ${base}; the GGUF file's own precision is chosen in the calculator`,
        }],
      });
    }

    // config.json at the same commit the API reported, so source and values match.
    deps.onProgress?.('config', repo);
    const cfgRes = await get(`${HF}/${repo}/resolve/${sha}/config.json`, 'config.json');
    if (!cfgRes.ok) throw httpFail(cfgRes, 'config.json');
    const config = await json(cfgRes, 'config.json', true);

    // ModelOpt <= 0.29 keeps its quantization config in hf_quant_config.json; fetched only when listed.
    let hfQuantConfig: unknown;
    const listed = (api.siblings ?? []).some((s) => s.rfilename === 'hf_quant_config.json');
    if (listed && !quantizationConfig(config)) {
      deps.onProgress?.('quant-config', repo);
      const hqRes = await get(`${HF}/${repo}/resolve/${sha}/hf_quant_config.json`, 'hf_quant_config.json');
      if (!hqRes.ok) throw httpFail(hqRes, 'hf_quant_config.json');
      hfQuantConfig = await json(hqRes, 'hf_quant_config.json', true);
    }

    // A natively quantized checkpoint is sized by its own weight files (revision API blobs + safetensors index).
    let ckptBytes: number | null | undefined;
    const ckptMissing: string[] = [];
    let weightIndex: unknown;
    const readIndex = async (): Promise<unknown> => {
      const idxRes = await get(`${HF}/${repo}/resolve/${sha}/model.safetensors.index.json`, 'model.safetensors.index.json');
      if (idxRes.ok) return json(idxRes, 'model.safetensors.index.json', true);
      if (idxRes.status !== 404) throw httpFail(idxRes, 'model.safetensors.index.json');
      return null;
    };
    if (quantizationConfig(config, hfQuantConfig)) {
      deps.onProgress?.('checkpoint-size', repo);
      const revRes = await get(`${HF}/api/models/${repo}/revision/${sha}?blobs=true`, 'revision API');
      if (!revRes.ok) throw httpFail(revRes, 'revision API');
      const rev = (await json(revRes, 'revision API', false)) as { siblings?: unknown };
      const index = await readIndex();
      const r = checkpointWeightBytes(index, rev.siblings);
      ckptBytes = r.bytes ?? null;
      ckptMissing.push(...r.missing);
      weightIndex = index;
    }

    // tie_word_embeddings absent: the checkpoint's tensor names decide; read the index when not read above.
    const textCfg = (c: unknown): Record<string, unknown> | undefined => {
      if (!c || typeof c !== 'object') return undefined;
      const o = c as Record<string, unknown>;
      const inner = (o.text_config ?? o.llm_config) as Record<string, unknown> | undefined;
      return inner && typeof inner === 'object' ? inner : o;
    };
    const tieKnown = typeof textCfg(config)?.tie_word_embeddings === 'boolean' ||
      typeof (config as Record<string, unknown>)?.tie_word_embeddings === 'boolean';
    if (!tieKnown && weightIndex === undefined) weightIndex = await readIndex();
    const weightMap = weightIndex && typeof weightIndex === 'object' ? (weightIndex as { weight_map?: unknown }).weight_map : undefined;
    const weightNames = weightMap && typeof weightMap === 'object' ? Object.keys(weightMap as Record<string, unknown>) : undefined;

    // A quantized derivative: its base model's parameter count (a packed checkpoint counts elements, not parameters).
    // Best effort: the base may be gated or gone, which only leaves the checkpoint's own count.
    let baseParams: { repo: string; total: number } | undefined;
    const baseRepo = cardBases[0];
    if (quantizationConfig(config, hfQuantConfig) && baseRepo !== undefined && HF_REPO_RE.test(baseRepo)) {
      deps.onProgress?.('base-params', baseRepo);
      try {
        const res = await deps.fetch(`${HF}/api/models/${baseRepo}?expand[]=safetensors`, init);
        const total = res.ok ? ((await res.json()) as { safetensors?: { total?: unknown } }).safetensors?.total : undefined;
        if (typeof total === 'number' && total > 0) baseParams = { repo: baseRepo, total };
      } catch { /* the checkpoint's own count stays */ }
    }

    const today = deps.today ?? new Date().toISOString().slice(0, 10);
    const license = api.cardData?.license_name ?? api.cardData?.license;
    deps.onProgress?.('parse', repo);
    const { model, missing, notes } = parseHfConfig(repo, sha, config, api.safetensors?.total ?? null, {
      origin: deps.origin ?? UNCHECKED_ORIGIN,
      ...(resolved?.base ? { base: resolved.base } : {}),
      license, verified: today,
      ...(ckptBytes !== undefined ? { checkpointWeightBytes: ckptBytes } : {}),
      ...(hfQuantConfig !== undefined ? { hfQuantConfig } : {}),
      ...(weightNames ? { weightNames } : {}),
      ...(deps.estimates ? { estimates: deps.estimates } : {}),
      ...(baseParams ? { baseParams } : {}),
    });
    if (!model || ckptMissing.length > 0) {
      const all = [...new Set([...ckptMissing, ...missing])];
      // Not a language model at all (its task says so): say that, not "missing fields".
      if (!model) {
        try {
          const res = await deps.fetch(`${HF}/api/models/${repo}?expand[]=pipeline_tag`, init);
          const task = res.ok ? ((await res.json()) as { pipeline_tag?: unknown }).pipeline_tag : undefined;
          if (typeof task === 'string' && !TEXT_GENERATION_TASKS.has(task)) {
            return {
              ok: false, status: 'not-language-model', task, repo, sha, missing: all,
              message: `${repo} is not a language model (Hugging Face task: ${task}); the calculator sizes LLM inference`,
            };
          }
        } catch { /* fall through to the importer error */ }
      }
      return { ok: false, status: 'unparsable', message: `missing: ${all.join(', ')}`, missing: all, repo, sha };
    }
    const source: Source = {
      id: hfSourceId(repo, sha),
      title: model.nativeQuant
        ? `${repo} config.json、safetensors 參數量與權重檔大小（Hugging Face，commit ${sha.slice(0, 7)}）`
        : `${repo} config.json 與 safetensors 參數量（Hugging Face，commit ${sha.slice(0, 7)}）`,
      url: `${HF}/${repo}/tree/${sha}`,
      accessed: today,
      kind: 'official',
    };
    return { ok: true, repo, sha, model, source, notes, cardBases };
  } catch (e) {
    if (e instanceof Stop) return e.result;
    return { ok: false, status: 'network', message: e instanceof Error ? e.message : String(e) };
  }
}
