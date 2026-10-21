/**
 * Regression tests for Hugging Face import coverage (issue #17): every target repo replayed from its pinned snapshot
 * (test/fixtures/hf/snapshots, written by `pnpm data:snapshot`) through fetchHfModel, exactly as the website and the
 * CLI run it. `cls` is the issue's failure class (A–H). Snapshots in the gitignored snapshots-local/ run too when
 * present. Repos the calculator cannot model yet must fail closed with one readable reason per feature; as each class gets modelled, its rows change to `ok` with the key fields asserted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchHfModel, type UnsupportedFeature } from '../src/hf-fetch';
import { loadSnapshot, replayFetch, SNAPSHOT_LOCAL_DIR } from '../src/hf-snapshot';

type Expected =
  | { status: 'unparsable'; features: UnsupportedFeature[] }
  | { status: 'gguf'; baseModels: string[] };

type Case = { repo: string; cls: string } & Expected;

const CASES: Case[] = [
  // C: LFM2 short convolution (and num_dense_layers, unchecked before)
  { repo: 'LiquidAI/LFM2.5-24B-A2B', cls: 'C', status: 'unparsable', features: ['short-conv', 'dense-and-moe'] },
  // D / F: ModelOpt in config.json; Nemotron latent MoE, relu2, MoE on a subset of blocks, per-block configs
  { repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB', cls: 'D+F', status: 'unparsable', features: ['heterogeneous-blocks', 'moe-layout', 'dense-and-moe', 'native-quant'] },
  { repo: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16', cls: 'F', status: 'unparsable', features: ['moe-layout', 'dense-and-moe'] },
  { repo: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4', cls: 'D+F', status: 'unparsable', features: ['moe-layout', 'dense-and-moe', 'native-quant'] },
  // E: GGUF-only repos → the model they were converted from
  { repo: 'unsloth/LFM2.5-24B-A2B-GGUF', cls: 'E', status: 'gguf', baseModels: ['LiquidAI/LFM2.5-24B-A2B'] },
  { repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF', cls: 'E', status: 'gguf', baseModels: ['nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-BF16'] },
  // H: outside the supported structures (stay refused, with a readable reason)
  { repo: 'nvidia/NVIDIA-Nemotron-Labs-Dory1.0-4B-BF16', cls: 'H', status: 'unparsable', features: ['recurrent-depth'] },
];

/** Snapshots kept on the developer's machine (gitignored snapshots-local/, expectations in its cases.json). */
const localCasesFile = `${SNAPSHOT_LOCAL_DIR}cases.json`;
const LOCAL_CASES: Case[] = existsSync(localCasesFile) ? (JSON.parse(readFileSync(localCasesFile, 'utf8')) as Case[]) : [];

const ORIGIN = { developer: 'Test', country: 'ZZ' };

async function check(c: Case): Promise<void> {
    const s = loadSnapshot(c.repo);
    const r = await fetchHfModel(c.repo, { fetch: replayFetch(s), revision: s.sha, origin: ORIGIN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(c.status);
    // The failure names the repo and the commit it was read at (the "report this model" link needs both).
    expect(r).toMatchObject({ repo: c.repo, sha: s.sha });
    if (c.status === 'gguf') {
      expect(r.baseModels).toEqual(c.baseModels);
      expect(r.message).toContain(c.baseModels[0]);
      return;
    }
    expect(r.unsupported?.map((u) => u.feature)).toEqual(c.features);
    // Each problem once: no repeated line, no repeated clause in the one-sentence message.
    expect(new Set(r.missing).size).toBe(r.missing?.length);
    const clauses = r.message.split(/; |\. /);
    expect(new Set(clauses).size).toBe(clauses.length);
    expect(r.message).toMatch(/^unsupported architecture: /);
}

describe('Hugging Face import coverage (issue #17 snapshots)', () => {
  it.each(CASES)('$cls $repo → $status', check);
});

describe.runIf(LOCAL_CASES.length > 0)('Hugging Face import coverage (local snapshots)', () => {
  it.each(LOCAL_CASES)('$cls $repo → $status', check);
});
