/**
 * CLI: import one Hugging Face model into config/models/<id>.yaml.
 *
 *   pnpm data:import <owner/repo> --developer <name> --country <ISO2>
 *     [--base <owner/repo>] [--base-developer <name> --base-country <ISO2>]
 *     [--token-env HF_TOKEN] [--revision <commit>]
 *
 * `--revision` pins the import to a commit (default: the repo's current head); re-importing at the commit a
 * model was first imported from changes nothing but new parser fields.
 * The publisher's origin flags are required and never inferred (spec §2.2). Lineage is recorded: the model card's
 * `base_model` is recorded as `baseModel`
 * (several repos joined with ', ') and printed as `info:`; `--base` is only needed when the card lists none, and
 * must be one of the card's repos when it does (a contradiction is a maintainer error, exit 2). The base origin
 * flags are optional and describe that base. A checkpoint whose config.json declares a
 * `quantization_config` (or, without one, whose file listing has a ModelOpt `hf_quant_config.json`, read at the same
 * commit as vLLM does) also gets `nativeQuant` with its exact weight-file bytes (revision API + safetensors
 * index at the same commit). When config.json omits tie_word_embeddings, the index's tensor names decide it (a separate
 * lm_head.weight → untied; final-review M21). Exit codes: 0 ok, 1 network/other error, 2 missing flags or config fields,
 * a malformed repo / revision, an excluded publisher (policy.yaml, checked before any fetch), or a model id already
 * owned by another repo (nothing written; final-review M23), 3 gated repo (401/403 on any
 * request, the safetensors index included; final-review M24).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { HF_REPO_RE, PolicySchema, type Origin, type Source } from '@nchc/schema';
import { excludedOrgOf } from '@nchc/core';
import { cardBaseModels, fetchHfModel, type HfFetchDeps } from './hf-fetch';
import { CONFIG_DIR } from './paths';

export interface ImportDeps {
  fetch: HfFetchDeps['fetch'];
  configDir: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** ISO date written to `verified` / `accessed`. */
  today: string;
}

const SECTION = '# --- Hugging Face model configs (written by pnpm data:import; pinned to a commit) ---';

interface Args {
  repo?: string;
  developer?: string;
  country?: string;
  base?: string;
  baseDeveloper?: string;
  baseCountry?: string;
  tokenEnv: string;
  revision?: string;
}

function parseArgs(argv: string[]): { args: Args; errors: string[] } {
  const args: Args = { tokenEnv: 'HF_TOKEN' };
  const errors: string[] = [];
  const valued: Record<string, keyof Args> = {
    '--developer': 'developer', '--country': 'country', '--base': 'base',
    '--base-developer': 'baseDeveloper', '--base-country': 'baseCountry', '--token-env': 'tokenEnv',
    '--revision': 'revision',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') continue;
    if (a in valued) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) errors.push(`${a} needs a value`);
      else (args as unknown as Record<string, string>)[valued[a] as string] = v;
    } else if (a.startsWith('--')) errors.push(`unknown flag ${a}`);
    else if (args.repo === undefined) args.repo = a;
    else errors.push(`unexpected argument ${a}`);
  }
  return { args, errors };
}

/**
 * Insert `entry` into sources.yaml text; replaces an older `hf:<repo>@…` entry, or the same id when its fields
 * changed (e.g. the title now names the weight-file sizes); no-op if an identical entry is present.
 */
export function upsertSource(text: string, entry: Source): string {
  const existing = (parse(text) as Array<Record<string, unknown>> | null) ?? [];
  const same = existing.find((s) => s.id === entry.id);
  if (same && stringify(same) === stringify(entry)) return text;
  const block = stringify([entry]).trimEnd();
  const prefix = entry.id.slice(0, entry.id.lastIndexOf('@') + 1);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`- id: ${prefix}`));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && lines[end]!.startsWith('  ')) end++;
    lines.splice(start, end - start, block);
    return lines.join('\n');
  }
  const base = text.endsWith('\n') ? text : `${text}\n`;
  return base.includes(SECTION) ? `${base}${block}\n` : `${base}\n${SECTION}\n${block}\n`;
}

export { cardBaseModels };

export async function runImport(argv: string[], deps: ImportDeps): Promise<number> {
  const { args, errors } = parseArgs(argv);
  const need: string[] = [];
  if (!args.repo) need.push('<owner/repo>');
  if (!args.developer) need.push('--developer');
  if (!args.country) need.push('--country');
  if (args.country && !/^[A-Z]{2}$/.test(args.country)) errors.push('--country must be ISO-3166 alpha-2 uppercase');
  if ((args.baseDeveloper === undefined) !== (args.baseCountry === undefined)) {
    need.push('--base-developer and --base-country (both together)');
  }
  if (args.baseCountry && !/^[A-Z]{2}$/.test(args.baseCountry)) errors.push('--base-country must be ISO-3166 alpha-2 uppercase');
  // The repo and revision go into URLs and the repo into the output file name: checked before any fetch.
  if (args.repo && !HF_REPO_RE.test(args.repo)) errors.push(`<owner/repo> '${args.repo}' is not a Hugging Face repo id owner/name`);
  if (args.revision && !/^[\w.-]+$/.test(args.revision)) errors.push(`--revision '${args.revision}' is not a commit or branch name`);
  if (errors.length > 0) deps.log(`error: ${errors.join('; ')}`);
  if (need.length > 0) deps.log(`missing: ${need.join(', ')}`);
  if (errors.length > 0 || need.length > 0) return 2;
  const repo = args.repo as string;

  // Origin policy (spec §2.2) before any fetch or write; data:build checks the catalog again.
  const policyFile = join(deps.configDir, 'policy.yaml');
  if (existsSync(policyFile)) {
    const policy = PolicySchema.parse(parse(readFileSync(policyFile, 'utf8')));
    const why = [
      policy.excludedCountries.includes(args.country as string) && `--country ${args.country} is in policy.excludedCountries`,
      excludedOrgOf(policy, repo) && `org '${repo.slice(0, repo.indexOf('/'))}' is listed in policy.excludedOrgs`,
    ].filter(Boolean);
    if (why.length > 0) {
      deps.log(`error: policy: ${why.join('; ')}; the catalog may not include this model (spec §2.2); nothing written`);
      return 2;
    }
  }

  const origin: Origin = { developer: args.developer as string, country: args.country as string };
  const token = deps.env[args.tokenEnv];
  const r = await fetchHfModel(repo, {
    fetch: deps.fetch,
    ...(token ? { token } : {}),
    ...(args.revision ? { revision: args.revision } : {}),
    origin,
    today: deps.today,
    resolveBase: (cardBases) => {
      // The model card's base_model (string or list) is recorded lineage. A --base that contradicts the card is
      // refused, so the record stays true.
      if (cardBases.length > 0 && args.base && !cardBases.includes(args.base)) {
        return { error: `error: --base ${args.base} does not match the model card's base_model: ${cardBases.join(', ')}` };
      }
      const baseRepo = args.base ?? (cardBases.length > 0 ? cardBases.join(', ') : undefined);
      if (args.baseDeveloper && !baseRepo) {
        return { error: 'missing: --base (the base origin flags describe a base, and the model card lists no base_model)' };
      }
      if (cardBases.length > 0) deps.log(`info: model card base_model: ${cardBases.join(', ')} (recorded as baseModel)`);
      return {
        base: baseRepo
          ? { repo: baseRepo, ...(args.baseDeveloper ? { origin: { developer: args.baseDeveloper, country: args.baseCountry as string } } : {}) }
          : undefined,
      };
    },
  });
  if (!r.ok) {
    // denied → 3; unparsable (missing fields, base-flag contradiction) or invalid (repo id / revision) → 2; everything else → 1.
    deps.log(r.status === 'denied' || r.status === 'unparsable' ? r.message : `error: ${r.message}`);
    return r.status === 'denied' ? 3 : r.status === 'unparsable' || r.status === 'invalid' ? 2 : 1;
  }
  const { model, notes, sha, source: entry } = r;

  // Implicit defaults are stated, in the CLI output and in the file (review M5).
  for (const n of notes) deps.log(`note: ${n}`);
  const header = `# Generated by: pnpm data:import ${repo} (commit ${sha}). Do not hand-edit; re-run the import.\n` +
    notes.map((n) => `# note: ${n}\n`).join('');
  const modelFile = join(deps.configDir, 'models', `${model.id}.yaml`);
  // Slug collision (final-review M23): another repo already owns this id; never overwrite it.
  if (existsSync(modelFile)) {
    const prev = parse(readFileSync(modelFile, 'utf8')) as { hfRepo?: unknown } | null;
    if (prev && prev.hfRepo !== repo) {
      deps.log(`error: config/models/${model.id}.yaml belongs to ${String(prev.hfRepo)}, not ${repo} (model id collision); nothing written`);
      return 2;
    }
  }
  mkdirSync(join(deps.configDir, 'models'), { recursive: true });
  writeFileSync(modelFile, header + stringify(model));

  const sourcesFile = join(deps.configDir, 'sources.yaml');
  writeFileSync(sourcesFile, upsertSource(readFileSync(sourcesFile, 'utf8'), entry));
  deps.log(`wrote config/models/${model.id}.yaml (source ${entry.id})`);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runImport(process.argv.slice(2), {
    fetch: (url, init) => fetch(url, { ...init, redirect: 'follow' }),
    configDir: CONFIG_DIR,
    env: process.env,
    log: (l) => console.log(l),
    today: new Date().toISOString().slice(0, 10),
  }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
