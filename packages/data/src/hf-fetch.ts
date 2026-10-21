/**
 * Browser-safe Hugging Face model fetch + parse, shared by the CLI importer (hf-import.ts) and the website's custom
 * model flow. No `node:` import, no fs, no yaml. The token (if any) is sent only to https://huggingface.co/ and is
 * never stored or logged here (direct-manipulation design §6.3).
 */
import { HF_REPO_RE, type Model, type Origin, type Source } from '@nchc/schema';
import { checkpointWeightBytes, hfSourceId, parseHfConfig, quantizationConfig } from './hf-parse';

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

export type HfFetchDeps = {
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<HfFetchResponse>;
  token?: string;
  revision?: string;
  /** Publisher origin recorded on the model: required (CLI: --developer/--country; website: asked from the user). */
  origin: Origin;
  /** ISO date written to `verified` / `accessed`; defaults to today. */
  today?: string;
  /**
   * Called with the model card's `base_model` repos right after the model API answers, before config.json is read.
   * Returns the lineage to record, or `error` to stop (status 'unparsable', message verbatim).
   */
  resolveBase?: (cardBases: string[]) => { base?: HfBaseSpec; error?: string };
};

export type HfFetchResult =
  | {
    ok: true; repo: string; sha: string; model: Model; source: Source; notes: string[];
    /** Model card `base_model` repos (empty when none). */
    cardBases: string[];
  }
  | { ok: false; status: 'denied' | 'not-found' | 'invalid' | 'unparsable' | 'network'; message: string; missing?: string[] };

/** Model-card `base_model` as a list of repos: a string, a list of strings, or absent. */
export function cardBaseModels(v: unknown): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * 401/403 message. HF also answers 401 for a misspelled or private repo, so the X-Error-Code /
 * X-Error-Message headers (e.g. GatedRepo vs RepositoryNotFound) and a body snippet are included.
 */
async function deniedMessage(res: HfFetchResponse, what: string): Promise<string> {
  const code = res.headers?.get('X-Error-Code');
  const msg = res.headers?.get('X-Error-Message');
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = [code && `X-Error-Code: ${code}`, msg, body && body !== msg ? `body: ${body}` : ''].filter(Boolean).join('; ');
  return `gated: set HF token via --token-env (HTTP ${res.status} on ${what}${hint ? `; ${hint}` : ''})`;
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

    // config.json at the same commit the API reported, so source and values match.
    const cfgRes = await get(`${HF}/${repo}/resolve/${sha}/config.json`, 'config.json');
    if (!cfgRes.ok) throw httpFail(cfgRes, 'config.json');
    const config = await json(cfgRes, 'config.json', true);

    // ModelOpt <= 0.29 keeps its quantization config in hf_quant_config.json; fetched only when listed.
    let hfQuantConfig: unknown;
    const listed = (api.siblings ?? []).some((s) => s.rfilename === 'hf_quant_config.json');
    if (listed && !quantizationConfig(config)) {
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

    const today = deps.today ?? new Date().toISOString().slice(0, 10);
    const license = api.cardData?.license_name ?? api.cardData?.license;
    const { model, missing, notes } = parseHfConfig(repo, sha, config, api.safetensors?.total ?? null, {
      origin: deps.origin,
      ...(resolved?.base ? { base: resolved.base } : {}),
      license, verified: today,
      ...(ckptBytes !== undefined ? { checkpointWeightBytes: ckptBytes } : {}),
      ...(hfQuantConfig !== undefined ? { hfQuantConfig } : {}),
      ...(weightNames ? { weightNames } : {}),
    });
    if (!model || ckptMissing.length > 0) {
      const all = [...ckptMissing, ...missing];
      return { ok: false, status: 'unparsable', message: `missing: ${all.join(', ')}`, missing: all };
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
