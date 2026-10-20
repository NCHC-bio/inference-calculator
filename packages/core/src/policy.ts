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
