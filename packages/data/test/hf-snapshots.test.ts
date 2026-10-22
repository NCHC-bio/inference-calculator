/**
 * Import coverage (issue #17; CLAUDE.md "Goal for imported models"): trending Hugging Face repos replayed from their
 * pinned snapshots (test/fixtures/hf/snapshots, written by `pnpm data:snapshot`) through fetchHfModel, exactly as the
 * website and the CLI run it, then through core. Every repo must import and get an answer; a failure is a bug.
 * `features` are the structures estimated conservatively (empty = precise compute); as an architecture gets modelled
 * precisely, its feature leaves the list. `via`: a GGUF repo is read through its base model.
 * Snapshots in the gitignored snapshots-local/ (expectations in its cases.json) run too when present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateRequirements, quantOptionsFor } from '@nchc/core';
import { fetchHfModel, type HfFetchDeps } from '../src/hf-fetch';
import { loadSnapshot, replayFetch, SNAPSHOT_LOCAL_DIR, type Snapshot } from '../src/hf-snapshot';
import { CONFIG_DIR, loadConfig, validateConfig } from '../src/index';

type Case = { repo: string; via?: string; features: string[]; model: Record<string, unknown> };

const CASES: Case[] = [
  {repo: 'LiquidAI/LFM2.5-24B-A2B',features: ['short-conv'],model: {layers: 40,attention: 'gqa',layerGroups: [{kind: 'state',count: 30},{kind: 'full',count: 10}],moe: {experts: 64,topK: 4,expertFfnDim: 1536,layers: 38}}},
  {repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF',via: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-BF16',features: ['heterogeneous-blocks','moe-layout','gguf'],model: {layers: 88,attention: 'gqa',layerGroups: [{kind: 'mamba',count: 40},{kind: 'none',count: 40},{kind: 'full',count: 8}],moe: {experts: 240,topK: 9,expertFfnDim: 3364,layers: 40,matrices: 2,width: 1024}}},
  {repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB',features: ['heterogeneous-blocks','moe-layout','native-quant'],model: {layers: 88,attention: 'gqa',layerGroups: [{kind: 'mamba',count: 40},{kind: 'none',count: 40},{kind: 'full',count: 8}],moe: {experts: 240,topK: 9,expertFfnDim: 3364,layers: 40,matrices: 2,width: 1024},nativeQuant: {quant: 'native-other'}}},
  {repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-BF16',features: ['heterogeneous-blocks','moe-layout'],model: {layers: 88,attention: 'gqa',layerGroups: [{kind: 'mamba',count: 40},{kind: 'none',count: 40},{kind: 'full',count: 8}],moe: {experts: 240,topK: 9,expertFfnDim: 3364,layers: 40,matrices: 2,width: 1024}}},
  {repo: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16',features: ['moe-layout'],model: {layers: 88,attention: 'gqa',layerGroups: [{kind: 'mamba',count: 40},{kind: 'none',count: 40},{kind: 'full',count: 8}],moe: {experts: 512,topK: 22,expertFfnDim: 2688,layers: 40,matrices: 2,width: 1024}}},
  {repo: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4',features: ['moe-layout','native-quant'],model: {layers: 88,attention: 'gqa',layerGroups: [{kind: 'mamba',count: 40},{kind: 'none',count: 40},{kind: 'full',count: 8}],moe: {experts: 512,topK: 22,expertFfnDim: 2688,layers: 40,matrices: 2,width: 1024},nativeQuant: {quant: 'native-other'}}},
  {repo: 'nvidia/NVIDIA-Nemotron-Labs-Dory1.0-4B-BF16',features: ['recurrent-depth'],model: {layers: 72,attention: 'gqa',layerGroups: [{kind: 'sliding',count: 27},{kind: 'none',count: 36},{kind: 'full',count: 9}],extraCache: {bytesPerToken: 81920,stateBytes: 0}}},
  {repo: 'unsloth/LFM2.5-24B-A2B-GGUF',via: 'LiquidAI/LFM2.5-24B-A2B',features: ['short-conv','gguf'],model: {layers: 40,attention: 'gqa',layerGroups: [{kind: 'state',count: 30},{kind: 'full',count: 10}],moe: {experts: 64,topK: 4,expertFfnDim: 1536,layers: 38}}},
];

const localCasesFile = `${SNAPSHOT_LOCAL_DIR}cases.json`;
const LOCAL_CASES: Case[] = existsSync(localCasesFile) ? (JSON.parse(readFileSync(localCasesFile, 'utf8')) as Case[]) : [];

const { bundle } = validateConfig(loadConfig(CONFIG_DIR));

/** Replays every snapshot a case needs: its own and, for a GGUF repo or a quantized derivative, its base model's. */
const loaded = new Map<string, Snapshot | null>();
const snapshotOf = (repo: string): Snapshot | null => {
  if (!loaded.has(repo)) {
    try { loaded.set(repo, loadSnapshot(repo)); } catch { loaded.set(repo, null); }
  }
  return loaded.get(repo)!;
};
function replayAll(repos: string[]): HfFetchDeps['fetch'] {
  const snaps = repos.map(snapshotOf).filter((x): x is Snapshot => x !== null);
  return async (url, init) => {
    for (const s of snaps) {
      try { return await replayFetch(s)(url, init); } catch { /* the next snapshot */ }
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'not in any snapshot' };
  };
}

async function check(c: Case, bases: string[]): Promise<void> {
  const s = snapshotOf(c.repo)!;
  const r = await fetchHfModel(c.repo, { fetch: replayAll([c.repo, ...bases]), revision: s.sha });
  if (!r.ok) throw new Error(`import failed (a bug): ${r.status} ${r.message}`);
  expect(r.repo).toBe(c.via ?? c.repo);
  expect(r.model).toMatchObject(c.model);
  expect([...new Set((r.model.estimates ?? []).map((e) => e.feature))].sort()).toEqual([...c.features].sort());
  const res = estimateRequirements(bundle!, {
    model: { imported: { model: r.model, source: r.source } },
    quant: quantOptionsFor(bundle!, r.model)[0]!, workload: 'chat', speed: 'smooth', users: 15,
  });
  expect(res.perPlatform.length).toBeGreaterThan(0);
  expect(res.warnings.some((w) => w.code === 'nonstandard-config')).toBe(c.features.length > 0);
}

const allRepos = [...CASES, ...LOCAL_CASES].flatMap((c) => [c.repo, ...(c.via ? [c.via] : [])]);
const basesOf = (c: Case) => allRepos.filter((r) => r !== c.repo);

describe('Hugging Face import coverage (issue #17 snapshots)', { timeout: 30_000 }, () => {
  it.each(CASES)('$repo', (c) => check(c, basesOf(c)));
});

describe.runIf(LOCAL_CASES.length > 0)('Hugging Face import coverage (local snapshots)', { timeout: 30_000 }, () => {
  it.each(LOCAL_CASES)('$repo', (c) => check(c, basesOf(c)));
});
