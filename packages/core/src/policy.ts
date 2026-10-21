/**
 * Publisher-org lookup against `policy.excludedOrgs` (spec §2.2), used by the config validator (@nchc/data) on the
 * catalog. Not applied to user-entered models; their results carry CUSTOM_MODEL_WARNING. Pure.
 */
import { HF_REPO_RE, type ExcludedOrg, type Policy } from '@nchc/schema';

/**
 * The excluded HF org owning `repo` (the part before '/', compared case-insensitively), or undefined; an undefined repo
 * → undefined (nothing to check). Fails closed (final-review I4): a value that is not `owner/name` (a URL, a bare
 * owner, free text) throws instead of passing unchecked; the schemas reject such values first.
 */
export function excludedOrgOf(policy: Pick<Policy, 'excludedOrgs'>, repo: string | undefined): ExcludedOrg | undefined {
  if (repo === undefined) return undefined;
  if (typeof repo !== 'string' || !HF_REPO_RE.test(repo)) {
    throw new Error(`HF repo '${String(repo)}' is not owner/name, so its publisher cannot be checked against policy.excludedOrgs`);
  }
  const owner = repo.slice(0, repo.indexOf('/')).toLowerCase();
  return policy.excludedOrgs.find((o) => o.org.toLowerCase() === owner);
}

/**
 * Spec §2.1 secondary-source rule: an `official` / `measured` value may not cite a source of kind `secondary` (secondary-only
 * data is `unverified`; review M8). Returns the problem text, or undefined when the value is fine. Shared by the config
 * validator (@nchc/data) and the imported-model path in api.ts, so the rule has one copy.
 */
export function secondarySourceIssue(status: string | undefined, sourceId: string, sourceKind: string | undefined): string | undefined {
  if ((status === 'official' || status === 'measured') && sourceKind === 'secondary') {
    return `${status} value cites source '${sourceId}' of kind secondary (official / measured need a primary source; use unverified)`;
  }
  return undefined;
}

/** What `nativeQuantIssue` found: which side is at fault, so a caller can point at the right config location. */
export type NativeQuantIssue = { code: 'unknown-quant' | 'no-native-note'; quant: string; message: string };

/**
 * A model's `nativeQuant.quant` must name an existing quantization whose `vllmServe.nativeNote` is set (the verify command
 * needs the native-checkpoint note). Returns the problem, or undefined. Shared by the config validator and the imported-model path.
 */
export function nativeQuantIssue(
  quantId: string,
  findQuant: (id: string) => { vllmServe: { nativeNote?: unknown } } | undefined,
): NativeQuantIssue | undefined {
  const q = findQuant(quantId);
  if (!q) return { code: 'unknown-quant', quant: quantId, message: `unknown quantization id '${quantId}'` };
  if (!q.vllmServe.nativeNote) {
    return { code: 'no-native-note', quant: quantId, message: `quantization '${quantId}' has no vllmServe.nativeNote (the verify command needs the native-checkpoint note)` };
  }
  return undefined;
}
