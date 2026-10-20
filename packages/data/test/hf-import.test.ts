import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { runImport, upsertSource } from '../src/hf-import';

const fixtureText = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/hf/${name}.json`, import.meta.url)), 'utf8');

const SHA = 'b5c939de8f754692c1647ca79fbf85e8c1e70f8a';
const SOURCES_HEAD = '# header comment\n- id: existing\n  title: Existing\n  url: https://example.com\n  accessed: 2026-10-19\n  kind: official\n';

/**
 * Fake fetch: no network. `configStatus` simulates gated repos. The revision API (blobs=true) and the safetensors
 * index serve the gpt-oss-120b fixtures (fixtures/hf/README.md); `indexStatus` 404 simulates a single-file checkpoint.
 */
function fakeFetch(
  config: string, configStatus = 200, total: number | null = 116829156672, errorHeaders: Record<string, string> = {},
  indexStatus = 200,
  cardData: Record<string, unknown> = { license: 'apache-2.0' },
  indexBody?: string,
) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fn = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.includes('/revision/')) return new Response(fixtureText('gpt-oss-120b.revision'), { status: 200 });
    if (url.endsWith('/model.safetensors.index.json')) {
      return new Response(indexStatus === 200 ? (indexBody ?? fixtureText('gpt-oss-120b.index')) : 'not found', { status: indexStatus });
    }
    if (url.includes('/api/models/')) {
      const body = { sha: SHA, safetensors: total === null ? undefined : { total }, cardData };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(configStatus === 200 ? config : 'denied', { status: configStatus, headers: errorHeaders });
  };
  return { fn, calls };
}

let dir: string;
let out: string[];
const log = (s: string) => out.push(s);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hf-import-'));
  writeFileSync(join(dir, 'sources.yaml'), SOURCES_HEAD);
  out = [];
});

const deps = (fetch: ReturnType<typeof fakeFetch>['fn'], env: Record<string, string | undefined> = {}) =>
  ({ fetch, configDir: dir, env, log, today: '2026-10-19' });

describe('runImport: checks before any fetch', () => {
  const noFetch = { fn: (() => { throw new Error('fetch must not be called'); }) as unknown as ReturnType<typeof fakeFetch>['fn'] };
  const POLICY = 'excludedCountries: [CN, HK, MO]\nexcludedOrgs:\n  - { org: Qwen, country: CN }\ndecision: { value: x, source: existing }\n';

  it('rejects a repo that is not owner/name and a malformed revision (exit 2)', async () => {
    expect(await runImport(['https://huggingface.co/openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(noFetch.fn))).toBe(2);
    expect(out.join('\n')).toContain('is not a Hugging Face repo id owner/name');
    out = [];
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US', '--revision', '../x?y'], deps(noFetch.fn))).toBe(2);
    expect(out.join('\n')).toContain('is not a commit or branch name');
  });

  it('rejects an excluded country or org from policy.yaml, writing nothing (exit 2)', async () => {
    writeFileSync(join(dir, 'policy.yaml'), POLICY);
    expect(await runImport(['qwen/Qwen3-8B', '--developer', 'Alibaba', '--country', 'US'], deps(noFetch.fn))).toBe(2);
    expect(out.join('\n')).toContain("org 'qwen' is listed in policy.excludedOrgs");
    out = [];
    expect(await runImport(['someorg/model', '--developer', 'X', '--country', 'HK'], deps(noFetch.fn))).toBe(2);
    expect(out.join('\n')).toContain('--country HK is in policy.excludedCountries');
    expect(existsSync(join(dir, 'models'))).toBe(false);
  });
});

describe('runImport', () => {
  it('writes models/<id>.yaml and appends the pinned source', async () => {
    const f = fakeFetch(fixtureText('gpt-oss-120b'));
    const code = await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn));
    expect(code).toBe(0);
    const m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.id).toBe('gpt-oss-120b');
    expect(m.source).toBe('hf:openai/gpt-oss-120b@b5c939d');
    expect(m.origin).toEqual({ developer: 'OpenAI', country: 'US' });
    expect(m.license).toBe('apache-2.0');
    const sources = parse(readFileSync(join(dir, 'sources.yaml'), 'utf8'));
    expect(sources.map((s: { id: string }) => s.id)).toEqual(['existing', 'hf:openai/gpt-oss-120b@b5c939d']);
    expect(readFileSync(join(dir, 'sources.yaml'), 'utf8')).toContain('# header comment');
    // config is read at the pinned commit
    expect(f.calls.some((c) => c.url === `https://huggingface.co/openai/gpt-oss-120b/resolve/${SHA}/config.json`)).toBe(true);
  });

  it('a quantized checkpoint gets nativeQuant with the summed weight-file bytes at the pinned commit', async () => {
    const f = fakeFetch(fixtureText('gpt-oss-120b'));
    const code = await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn));
    expect(code).toBe(0);
    const m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.nativeQuant).toEqual({
      method: 'mxfp4', quant: 'mxfp4',
      checkpointWeightBytes: { value: 65248893184, unit: 'B', status: 'official', source: 'hf:openai/gpt-oss-120b@b5c939d', verified: '2026-10-19' },
    });
    expect(f.calls.some((c) => c.url === `https://huggingface.co/api/models/openai/gpt-oss-120b/revision/${SHA}?blobs=true`)).toBe(true);
    expect(f.calls.some((c) => c.url === `https://huggingface.co/openai/gpt-oss-120b/resolve/${SHA}/model.safetensors.index.json`)).toBe(true);
    const sources = parse(readFileSync(join(dir, 'sources.yaml'), 'utf8'));
    expect(sources[1].title).toContain('權重檔大小');
  });

  it('a BF16 checkpoint does not fetch file sizes', async () => {
    const f = fakeFetch(fixtureText('phi-4'), 200, 14659507200);
    const code = await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn));
    expect(code).toBe(0);
    expect(f.calls.some((c) => c.url.includes('/revision/') || c.url.endsWith('index.json'))).toBe(false);
    expect(parse(readFileSync(join(dir, 'models/phi-4.yaml'), 'utf8')).nativeQuant).toBeUndefined();
  });

  it('implicit defaults are printed and written into the YAML header (review M5)', async () => {
    const cfg = JSON.parse(fixtureText('phi-4')) as Record<string, unknown>;
    delete cfg.num_key_value_heads;
    const f = fakeFetch(JSON.stringify(cfg), 200, 14659507200);
    const code = await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn));
    expect(code).toBe(0);
    const note = 'num_key_value_heads absent: kvHeads = num_attention_heads (40), the Hugging Face convention for multi-head attention';
    expect(out).toContain(`note: ${note}`);
    const text = readFileSync(join(dir, 'models/phi-4.yaml'), 'utf8');
    expect(text).toContain(`# note: ${note}\n`);
    expect(parse(text).kvHeads).toBe(40);
  });

  it('quantized checkpoint whose weight files cannot be sized: exit 2, nothing written', async () => {
    // No index (404) → a single model.safetensors is expected, and the gpt-oss revision has none.
    const f = fakeFetch(fixtureText('gpt-oss-120b'), 200, 116829156672, {}, 404);
    const code = await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn));
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('missing: checkpoint file size: model.safetensors');
    expect(existsSync(join(dir, 'models/gpt-oss-120b.yaml'))).toBe(false);
    expect(readFileSync(join(dir, 'sources.yaml'), 'utf8')).toBe(SOURCES_HEAD);
  });

  it('--base flags reach the YAML', async () => {
    const f = fakeFetch(fixtureText('gpt-oss-120b'));
    const code = await runImport([
      'openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US',
      '--base', 'openai/base-x', '--base-developer', 'OpenAI', '--base-country', 'US',
    ], deps(f.fn));
    expect(code).toBe(0);
    const m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.baseModel).toBe('openai/base-x');
    expect(m.baseOrigin).toEqual({ developer: 'OpenAI', country: 'US' });
  });

  it('unsupported MoE layout (Nemotron 3.5 latent MoE): exit 2, missing listed, nothing written (Ruling R31)', async () => {
    const f = fakeFetch(fixtureText('nemotron-3.5-super'), 200, 124453395976);
    const code = await runImport(
      ['nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16', '--developer', 'NVIDIA', '--country', 'US'], deps(f.fn),
    );
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('moe_latent_size 1024');
    expect(existsSync(join(dir, 'models/nvidia-nemotron-3.5-super-vl-120b-a12b-bf16.yaml'))).toBe(false);
    expect(readFileSync(join(dir, 'sources.yaml'), 'utf8')).toBe(SOURCES_HEAD);
  });

  it('model card base_model is recorded as baseModel and printed; it does not block the import', async () => {
    const card = { license: 'apache-2.0', base_model: ['example-cn-lab/Synthetic-Base'] };
    const f = fakeFetch(fixtureText('gpt-oss-120b'), 200, 116829156672, {}, 200, card);
    // Publisher flags only: written, the card's base recorded (no base origin: it is never guessed).
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn))).toBe(0);
    expect(out.join('\n')).toContain('info: model card base_model: example-cn-lab/Synthetic-Base');
    let m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.baseModel).toBe('example-cn-lab/Synthetic-Base');
    expect(m.baseOrigin).toBeUndefined();
    // Base origin flags describe the card's base when --base is omitted; the base country is not checked.
    out = [];
    const baseOrigin = ['--base-developer', 'Example CN Lab', '--base-country', 'CN'];
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US', ...baseOrigin], deps(f.fn))).toBe(0);
    m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.baseModel).toBe('example-cn-lab/Synthetic-Base');
    expect(m.baseOrigin).toEqual({ developer: 'Example CN Lab', country: 'CN' });
    // A --base that contradicts the card is still a maintainer error: nothing written.
    out = [];
    const other = ['--base', 'openai/other', '--base-developer', 'OpenAI', '--base-country', 'US'];
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US', ...other], deps(f.fn))).toBe(2);
    expect(out.join('\n')).toContain("does not match the model card's base_model");
  });

  it('a model card listing several base_model repos records them all', async () => {
    const card = { license: 'apache-2.0', base_model: ['example/base-a', 'example/base-b'] };
    const f = fakeFetch(fixtureText('gpt-oss-120b'), 200, 116829156672, {}, 200, card);
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn))).toBe(0);
    const m = parse(readFileSync(join(dir, 'models/gpt-oss-120b.yaml'), 'utf8'));
    expect(m.baseModel).toBe('example/base-a, example/base-b');
  });

  it('base origin flags without any base (no --base, no card base_model): exit 2', async () => {
    const f = fakeFetch(fixtureText('gpt-oss-120b'));
    const flags = ['--base-developer', 'OpenAI', '--base-country', 'US'];
    expect(await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US', ...flags], deps(f.fn))).toBe(2);
    expect(out.join('\n')).toContain('missing: --base');
    expect(existsSync(join(dir, 'models/gpt-oss-120b.yaml'))).toBe(false);
  });

  it('missing origin flags: exit 2, nothing written, no network', async () => {
    const f = fakeFetch(fixtureText('phi-4'));
    const code = await runImport(['microsoft/phi-4'], deps(f.fn));
    expect(code).toBe(2);
    expect(out.join('\n')).toMatch(/^missing: .*--developer/m);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(dir, 'models/phi-4.yaml'))).toBe(false);
  });

  it('missing config fields: exit 2 and prints missing list', async () => {
    const f = fakeFetch(fixtureText('missing-fields'));
    const code = await runImport(['example/missing-fields', '--developer', 'Example Lab', '--country', 'US'], deps(f.fn));
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('missing: num_hidden_layers');
    expect(existsSync(join(dir, 'models/missing-fields.yaml'))).toBe(false);
    expect(readFileSync(join(dir, 'sources.yaml'), 'utf8')).toBe(SOURCES_HEAD);
  });

  it('gated (401/403): exit 3 with token hint', async () => {
    for (const status of [401, 403]) {
      out = [];
      const f = fakeFetch('', status);
      const code = await runImport(['example/gated', '--developer', 'Example Lab', '--country', 'US'], deps(f.fn));
      expect(code).toBe(3);
      expect(out.join('\n')).toContain('gated: set HF token via --token-env');
    }
  });

  it('401/403 prints the HF X-Error-Code and message, so a misspelled repo is not silently "gated"', async () => {
    const f = fakeFetch('', 401, 1e9, { 'X-Error-Code': 'RepositoryNotFound', 'X-Error-Message': 'Repository not found' });
    const code = await runImport(['example/misspeled', '--developer', 'Example Lab', '--country', 'US'], deps(f.fn));
    expect(code).toBe(3);
    const text = out.join('\n');
    expect(text).toContain('gated: set HF token via --token-env');
    expect(text).toContain('X-Error-Code: RepositoryNotFound');
    expect(text).toContain('Repository not found');
  });

  it('--token-env sends a bearer token without printing it', async () => {
    const f = fakeFetch(fixtureText('phi-4'), 200, 14659507200);
    const code = await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US', '--token-env', 'MY_TOK'],
      deps(f.fn, { MY_TOK: 'secret-123' }));
    expect(code).toBe(0);
    expect(f.calls.every((c) => c.auth === 'Bearer secret-123')).toBe(true);
    expect(out.join('\n')).not.toContain('secret-123');
  });
});

describe('upsertSource', () => {
  const entry = { id: 'hf:a/b@1234567', title: 'T', url: 'https://huggingface.co/a/b/tree/1234567', accessed: '2026-10-19', kind: 'official' as const };
  it('is idempotent', () => {
    const once = upsertSource(SOURCES_HEAD, entry);
    expect(upsertSource(once, entry)).toBe(once);
  });
  it('replaces an entry with the same id whose fields changed', () => {
    const once = upsertSource(SOURCES_HEAD, entry);
    const next = upsertSource(once, { ...entry, title: 'T2' });
    expect(parse(next).map((s: { id: string; title: string }) => [s.id, s.title])).toEqual([['existing', 'Existing'], [entry.id, 'T2']]);
  });
  it('replaces an older commit of the same repo', () => {
    const old = upsertSource(SOURCES_HEAD, { ...entry, id: 'hf:a/b@aaaaaaa' });
    const next = upsertSource(old, entry);
    const ids = parse(next).map((s: { id: string }) => s.id);
    expect(ids).toEqual(['existing', 'hf:a/b@1234567']);
  });
});

describe('runImport: ModelOpt checkpoint with hf_quant_config.json (nvidia/Llama-3.3-70B-Instruct-FP8)', () => {
  const LSHA = 'fde04ee76a27704c88f569542ef023b57d4d0362';
  const repo = 'nvidia/Llama-3.3-70B-Instruct-FP8';
  /** Fixtures at the pinned commit (fixtures/hf/README.md); `withQuantFile` false drops hf_quant_config.json from the listing. */
  function llamaFetch(withQuantFile = true) {
    const calls: string[] = [];
    const rev = JSON.parse(fixtureText('llama-3.3-70b-instruct-fp8.revision')) as { siblings: Array<{ rfilename: string }> };
    const siblings = rev.siblings.filter((s) => withQuantFile || s.rfilename !== 'hf_quant_config.json');
    const fn = async (url: string) => {
      calls.push(url);
      if (url.includes('blobs=true')) return new Response(JSON.stringify({ ...rev, siblings }), { status: 200 });
      if (url.includes('/api/models/')) {
        const body = { sha: LSHA, safetensors: { total: 70553706496 }, cardData: { base_model: ['meta-llama/Llama-3.3-70B-Instruct'] }, siblings: siblings.map((s) => ({ rfilename: s.rfilename })) };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.endsWith(`/resolve/${LSHA}/config.json`)) return new Response(fixtureText('llama-3.3-70b-instruct-fp8'), { status: 200 });
      if (url.endsWith(`/resolve/${LSHA}/hf_quant_config.json`)) return new Response(fixtureText('llama-3.3-70b-instruct-fp8.hf_quant_config'), { status: 200 });
      if (url.endsWith(`/resolve/${LSHA}/model.safetensors.index.json`)) return new Response(fixtureText('llama-3.3-70b-instruct-fp8.index'), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    return { fn, calls };
  }

  it('reads hf_quant_config.json at the pinned commit and sizes the checkpoint from its weight files', async () => {
    const f = llamaFetch();
    const code = await runImport([repo, '--developer', 'NVIDIA', '--country', 'US', '--revision', LSHA], deps(f.fn));
    expect(code).toBe(0);
    expect(f.calls).toContain(`https://huggingface.co/${repo}/resolve/${LSHA}/hf_quant_config.json`);
    const m = parse(readFileSync(join(dir, 'models/llama-3.3-70b-instruct-fp8.yaml'), 'utf8'));
    expect(m.nativeQuant).toEqual({
      method: 'modelopt', quant: 'fp8',
      checkpointWeightBytes: { value: 72656585760, unit: 'B', status: 'official', source: 'hf:nvidia/Llama-3.3-70B-Instruct-FP8@fde04ee', verified: '2026-10-19' },
    });
    // Lineage is recorded, not judged: the publisher is NVIDIA (US).
    expect(m.baseModel).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(m.origin).toEqual({ developer: 'NVIDIA', country: 'US' });
    expect(out.some((l) => l.startsWith('info: model card base_model: meta-llama/Llama-3.3-70B-Instruct'))).toBe(true);
  });

  it('a repo without hf_quant_config.json does not fetch it', async () => {
    const f = llamaFetch(false);
    const code = await runImport([repo, '--developer', 'NVIDIA', '--country', 'US', '--revision', LSHA], deps(f.fn));
    expect(code).toBe(0);
    expect(f.calls.some((u) => u.endsWith('hf_quant_config.json'))).toBe(false);
    expect(parse(readFileSync(join(dir, 'models/llama-3.3-70b-instruct-fp8.yaml'), 'utf8')).nativeQuant).toBeUndefined();
  });
});

describe('importer safety (final-review M23, M24)', () => {
  it('refuses to overwrite an existing model file whose hfRepo differs (slug collision)', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'models'), { recursive: true });
    const other = '# hand-made\nid: phi-4\nhfRepo: someone-else/phi-4\n';
    writeFileSync(join(dir, 'models/phi-4.yaml'), other);
    const f = fakeFetch(fixtureText('phi-4'), 200, 14659507200);
    const code = await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn));
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('someone-else/phi-4');
    expect(readFileSync(join(dir, 'models/phi-4.yaml'), 'utf8')).toBe(other);
    expect(readFileSync(join(dir, 'sources.yaml'), 'utf8')).toBe(SOURCES_HEAD);
  });
  it('re-importing the same repo over its own file is allowed', async () => {
    const f = fakeFetch(fixtureText('phi-4'), 200, 14659507200);
    expect(await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn))).toBe(0);
    expect(await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn))).toBe(0);
  });
  it('401/403 on model.safetensors.index.json exits 3 (gated / auth), not 1', async () => {
    for (const status of [401, 403]) {
      out = [];
      const f = fakeFetch(fixtureText('gpt-oss-120b'), 200, 116829156672, {}, status);
      const code = await runImport(['openai/gpt-oss-120b', '--developer', 'OpenAI', '--country', 'US'], deps(f.fn));
      expect(code).toBe(3);
      expect(out.join('\n')).toContain('model.safetensors.index.json');
    }
  });
  it('tie_word_embeddings absent: the index is read for its tensor names (lm_head present → untied)', async () => {
    const cfg = JSON.parse(fixtureText('phi-4')) as Record<string, unknown>;
    delete cfg.tie_word_embeddings;
    const index = JSON.stringify({ weight_map: { 'model.embed_tokens.weight': 'model-00001-of-00006.safetensors', 'lm_head.weight': 'model-00006-of-00006.safetensors' } });
    const f = fakeFetch(JSON.stringify(cfg), 200, 14659507200, {}, 200, { license: 'mit' }, index);
    expect(await runImport(['microsoft/phi-4', '--developer', 'Microsoft', '--country', 'US'], deps(f.fn))).toBe(0);
    expect(f.calls.some((c) => c.url.endsWith('/model.safetensors.index.json'))).toBe(true);
    const text = readFileSync(join(dir, 'models/phi-4.yaml'), 'utf8');
    expect(parse(text).tieWordEmbeddings).toBe(false);
    expect(text).toContain('# note: tie_word_embeddings absent');
  });
});

