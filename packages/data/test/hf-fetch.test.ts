import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchHfModel, type HfFetchDeps } from '../src/hf-fetch';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const fixture = (name: string) => read(`./fixtures/hf/${name}.json`);
const SHA = 'b5c939de8f754692c1647ca79fbf85e8c1e70f8a';
const ORIGIN = { developer: 'OpenAI', country: 'US' };

type Res = Awaited<ReturnType<HfFetchDeps['fetch']>>;
const res = (status: number, body: string): Res => ({
  status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body), text: async () => body,
});

function fake(config = fixture('gpt-oss-120b'), apiStatus = 200) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fn: HfFetchDeps['fetch'] = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.includes('/revision/')) return res(200, fixture('gpt-oss-120b.revision'));
    if (url.endsWith('/model.safetensors.index.json')) return res(200, fixture('gpt-oss-120b.index'));
    if (url.includes('/api/models/')) {
      return apiStatus === 200
        ? res(200, JSON.stringify({ sha: SHA, safetensors: { total: 116829156672 }, cardData: { license: 'apache-2.0' } }))
        : res(apiStatus, 'no');
    }
    return res(200, config);
  };
  return { fn, calls };
}

describe('fetchHfModel', () => {
  it('parses a public repo into model + source', async () => {
    const r = await fetchHfModel('openai/gpt-oss-120b', { fetch: fake().fn, origin: ORIGIN });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.sha).toBe(SHA);
    expect(r.repo).toBe('openai/gpt-oss-120b');
    expect(r.model.totalParamsB.source).toBe(r.source.id);
    expect(r.source.url).toContain(SHA);
  });

  it('401 → denied', async () => {
    const r = await fetchHfModel('openai/gpt-oss-120b', { fetch: fake(undefined, 401).fn, origin: ORIGIN });
    expect(r).toMatchObject({ ok: false, status: 'denied' });
  });

  it('404 → not-found', async () => {
    const r = await fetchHfModel('openai/gpt-oss-120b', { fetch: fake(undefined, 404).fn, origin: ORIGIN });
    expect(r).toMatchObject({ ok: false, status: 'not-found' });
  });

  it('malformed repo id or revision → invalid (never reaches the network)', async () => {
    const f = fake();
    expect(await fetchHfModel('not a repo', { fetch: f.fn, origin: ORIGIN })).toMatchObject({ ok: false, status: 'invalid', message: expect.stringContaining('owner/name') });
    expect(await fetchHfModel('openai/gpt-oss-120b', { fetch: f.fn, origin: ORIGIN, revision: 'a/../b' })).toMatchObject({ ok: false, status: 'invalid' });
    expect(f.calls.length).toBe(0);
  });

  it('fetch throws → network', async () => {
    const r = await fetchHfModel('openai/gpt-oss-120b', { fetch: async () => { throw new Error('offline'); }, origin: ORIGIN });
    expect(r).toMatchObject({ ok: false, status: 'network' });
  });

  it('config missing hidden_size → unparsable with missing', async () => {
    const cfg = JSON.parse(fixture('gpt-oss-120b')) as Record<string, unknown>;
    delete cfg.hidden_size;
    const r = await fetchHfModel('openai/gpt-oss-120b', { fetch: fake(JSON.stringify(cfg)).fn, origin: ORIGIN });
    expect(r).toMatchObject({ ok: false, status: 'unparsable' });
    if (!r.ok) expect(r.missing).toContain('hidden_size');
  });

  it('token goes only to huggingface.co', async () => {
    const f = fake();
    await fetchHfModel('openai/gpt-oss-120b', { fetch: f.fn, token: 'hf_secret', origin: ORIGIN });
    expect(f.calls.length).toBeGreaterThan(2);
    for (const c of f.calls) {
      if (c.auth) expect(c.url.startsWith('https://huggingface.co/')).toBe(true);
    }
    expect(f.calls.every((c) => c.auth === 'Bearer hf_secret')).toBe(true);
    const anon = fake();
    await fetchHfModel('openai/gpt-oss-120b', { fetch: anon.fn, origin: ORIGIN });
    expect(anon.calls.every((c) => c.auth === undefined)).toBe(true);
  });

  it('hf-fetch imports no node module', () => {
    const seen = new Set<string>();
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = read(`../src/${rel}.ts`);
      expect(src).not.toMatch(/from\s+['"]node:/);
      expect(src).not.toMatch(/from\s+['"](yaml|fs|path)['"]/);
      for (const m of src.matchAll(/from\s+['"]\.\/([\w-]+)['"]/g)) walk(m[1] as string);
    };
    walk('hf-fetch');
    expect(seen.has('hf-parse')).toBe(true);
  });
});
