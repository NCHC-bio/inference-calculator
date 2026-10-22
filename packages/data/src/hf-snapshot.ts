/**
 * CLI: snapshot Hugging Face responses as replayable regression fixtures (issue #17), or survey the trending models.
 *
 *   pnpm data:snapshot <owner/repo>... [--local] [--token-env HF_TOKEN]
 *     Resolves each repo's current commit and writes packages/data/test/fixtures/hf/snapshots/<owner>__<name>.json.gz with
 *     every response fetchHfModel can request at that commit (model API, config.json, hf_quant_config.json when listed,
 *     revision blobs, model.safetensors.index.json), trimmed as test/fixtures/hf/README.md describes. `--local` writes to
 *     the gitignored snapshots-local/ instead (kept on this machine, not committed). A repo that
 *     answers 401/403 is reported and skipped (gated repos are not fixtures).
 *   pnpm data:snapshot --survey <N> [--token-env HF_TOKEN]
 *     Imports the top N trending text-generation and image-text-to-text repos live and prints which parse; writes nothing.
 *
 * The token (if any) is sent only to https://huggingface.co/ and never written to a fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HF_REPO_RE } from '@nchc/schema';
import { fetchHfModel, type HfFetchDeps, type HfFetchResponse } from './hf-fetch';

const HF = 'https://huggingface.co';
export const SNAPSHOT_DIR = fileURLToPath(new URL('../test/fixtures/hf/snapshots/', import.meta.url));
/** Gitignored: snapshots kept on the developer's machine only, with their expectations in `cases.json`. */
export const SNAPSHOT_LOCAL_DIR = fileURLToPath(new URL('../test/fixtures/hf/snapshots-local/', import.meta.url));

/** One recorded response: status and body (parsed JSON when it parses, else the text). */
export type SnapshotResponse = { status: number; body: unknown };
export type Snapshot = { repo: string; sha: string; snapshotAt: string; responses: Record<string, SnapshotResponse> };

export const snapshotFile = (repo: string): string => `${repo.replace('/', '__')}.json.gz`;

/** Read a snapshot written by this tool (gzip: ModelOpt mixed-precision configs list every layer and run to MBs). */
export const loadSnapshot = (repo: string): Snapshot => {
  const file = [SNAPSHOT_DIR, SNAPSHOT_LOCAL_DIR].map((d) => `${d}${snapshotFile(repo)}`).find((p) => existsSync(p));
  if (!file) throw new Error(`no snapshot for ${repo}: run pnpm data:snapshot ${repo}`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Snapshot;
};

/** The model API URL fetchHfModel requests for a pinned revision. */
export const modelApiPath = (repo: string, sha: string): string =>
  `/api/models/${repo}/revision/${sha}?expand[]=safetensors&expand[]=sha&expand[]=cardData&expand[]=siblings`;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Model API: sha, safetensors, the card fields the importer reads, sibling names. */
function trimModelApi(b: unknown): unknown {
  if (!isObj(b)) return b;
  const out = pick(b, ['id', 'sha', 'safetensors', 'pipeline_tag']);
  if (isObj(b.cardData)) out.cardData = pick(b.cardData, ['license', 'license_name', 'base_model', 'base_model_relation']);
  if (Array.isArray(b.siblings)) out.siblings = b.siblings.map((s) => (isObj(s) ? pick(s, ['rfilename']) : s));
  return out;
}

/** Revision blobs: id, sha and each sibling's rfilename / size / lfs.size (file sizes verbatim). */
function trimRevision(b: unknown): unknown {
  if (!isObj(b)) return b;
  const out = pick(b, ['id', 'sha']);
  if (Array.isArray(b.siblings)) {
    out.siblings = b.siblings.map((s) => {
      if (!isObj(s)) return s;
      const t = pick(s, ['rfilename', 'size']);
      if (isObj(s.lfs) && typeof s.lfs.size === 'number') t.lfs = { size: s.lfs.size };
      return t;
    });
  }
  return out;
}

/** Safetensors index: metadata verbatim; weight_map keeps one tensor per file plus every lm_head tensor. */
function trimIndex(b: unknown): unknown {
  if (!isObj(b) || !isObj(b.weight_map)) return b;
  const seen = new Set<string>();
  const map: Obj = {};
  for (const [name, file] of Object.entries(b.weight_map)) {
    const keep = /(^|\.)lm_head\.weight$/.test(name) || (typeof file === 'string' && !seen.has(file));
    if (typeof file === 'string') seen.add(file);
    if (keep) map[name] = file;
  }
  return { ...pick(b, ['metadata']), weight_map: map };
}

async function record(
  fetchFn: HfFetchDeps['fetch'], init: { headers?: Record<string, string> } | undefined, path: string,
  trim: (b: unknown) => unknown = (b) => b,
): Promise<SnapshotResponse> {
  const res = await fetchFn(`${HF}${path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: res.ok ? trim(body) : typeof body === 'string' ? body.slice(0, 200) : body };
}

/** Snapshot one repo at its current commit. Returns undefined (with a reason) when the repo is gated or missing. */
export async function snapshotRepo(
  repo: string, fetchFn: HfFetchDeps['fetch'], token?: string, today = new Date().toISOString().slice(0, 10),
): Promise<{ snapshot?: Snapshot; reason?: string }> {
  const init = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
  const head = await fetchFn(`${HF}/api/models/${repo}?expand[]=sha`, init);
  if (!head.ok) return { reason: `model API HTTP ${head.status}` };
  const sha = ((await head.json()) as { sha?: string }).sha;
  if (!sha) return { reason: 'model API returned no sha' };
  const responses: Record<string, SnapshotResponse> = {};
  const api = await record(fetchFn, init, modelApiPath(repo, sha), trimModelApi);
  responses[modelApiPath(repo, sha)] = api;
  if (api.status === 401 || api.status === 403) return { reason: `gated (HTTP ${api.status})` };
  const files = isObj(api.body) && Array.isArray(api.body.siblings)
    ? api.body.siblings.map((s) => (isObj(s) ? s.rfilename : undefined)) : [];
  const resolve = (f: string) => `/${repo}/resolve/${sha}/${f}`;
  responses[resolve('config.json')] = await record(fetchFn, init, resolve('config.json'));
  if (files.includes('hf_quant_config.json')) {
    responses[resolve('hf_quant_config.json')] = await record(fetchFn, init, resolve('hf_quant_config.json'));
  }
  const rev = `/api/models/${repo}/revision/${sha}?blobs=true`;
  responses[rev] = await record(fetchFn, init, rev, trimRevision);
  responses[resolve('model.safetensors.index.json')] = await record(fetchFn, init, resolve('model.safetensors.index.json'), trimIndex);
  return { snapshot: { repo, sha, snapshotAt: today, responses } };
}

/** A fetch that replays a snapshot; a URL it never recorded throws, so a test cannot silently pass on a gap. */
export function replayFetch(s: Snapshot): HfFetchDeps['fetch'] {
  return async (url) => {
    const path = url.startsWith(HF) ? url.slice(HF.length) : url;
    // The unpinned model API (a GGUF repo's base model is read at its current commit) answers with the snapshot's commit.
    // The unpinned model API (a GGUF repo's base model, a quantized repo's base parameter count) answers with the
    // snapshot's commit.
    const unpinned = [`/api/models/${s.repo}?expand[]=safetensors&expand[]=sha&expand[]=cardData&expand[]=siblings`, `/api/models/${s.repo}?expand[]=safetensors`];
    const r = s.responses[unpinned.includes(path) ? modelApiPath(s.repo, s.sha) : path];
    if (!r) throw new Error(`not in snapshot ${s.repo}@${s.sha.slice(0, 7)}: ${path}`);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const res: HfFetchResponse = {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      json: async () => JSON.parse(text) as unknown, text: async () => text,
    };
    return res;
  };
}

async function survey(n: number, fetchFn: HfFetchDeps['fetch'], token: string | undefined, log: (l: string) => void): Promise<void> {
  const repos: string[] = [];
  for (const tag of ['text-generation', 'image-text-to-text']) {
    const res = await fetchFn(`${HF}/api/models?pipeline_tag=${tag}&sort=trendingScore&limit=${n}`);
    const list = (await res.json()) as Array<{ id?: string }>;
    for (const m of list) if (m.id && !repos.includes(m.id)) repos.push(m.id);
  }
  let ok = 0;
  for (const repo of repos) {
    const r = await fetchHfModel(repo, {
      fetch: fetchFn, ...(token ? { token } : {}),
    });
    if (r.ok) ok++;
    log(`${r.ok ? 'ok        ' : r.status.padEnd(10)} ${repo}${r.ok ? '' : `  ${r.message.slice(0, 160)}`}`);
  }
  log(`\n${ok} / ${repos.length} parsed`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const local = process.argv.includes('--local');
  const argv = process.argv.slice(2).filter((a) => a !== '--' && a !== '--local');
  const dir = local ? SNAPSHOT_LOCAL_DIR : SNAPSHOT_DIR;
  const tokenEnvAt = argv.indexOf('--token-env');
  const tokenEnv = tokenEnvAt >= 0 ? argv.splice(tokenEnvAt, 2)[1] ?? 'HF_TOKEN' : 'HF_TOKEN';
  const token = process.env[tokenEnv];
  const fetchFn: HfFetchDeps['fetch'] = (url, init) => fetch(url, { ...init, redirect: 'follow' });
  const run = async (): Promise<number> => {
    if (argv[0] === '--survey') {
      await survey(Number(argv[1] ?? 25), fetchFn, token, (l) => console.log(l));
      return 0;
    }
    if (argv.length === 0 || argv.some((r) => !HF_REPO_RE.test(r))) {
      console.log('usage: pnpm data:snapshot <owner/repo>... [--local] | --survey <N>');
      return 2;
    }
    mkdirSync(dir, { recursive: true });
    for (const repo of argv) {
      const { snapshot, reason } = await snapshotRepo(repo, fetchFn, token);
      if (!snapshot) { console.log(`skip ${repo}: ${reason}`); continue; }
      writeFileSync(`${dir}${snapshotFile(repo)}`, gzipSync(`${JSON.stringify(snapshot, null, 1)}\n`, { level: 9 }));
      console.log(`wrote ${local ? 'snapshots-local' : 'snapshots'}/${snapshotFile(repo)} (${snapshot.sha})`);
    }
    return 0;
  };
  run().then((c) => process.exit(c), (e: unknown) => { console.error(e); process.exit(1); });
}
