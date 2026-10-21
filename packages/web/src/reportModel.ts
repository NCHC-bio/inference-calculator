/** The project's GitHub repository (support requests and bug reports for imported models; issue #17). */
export const GITHUB_REPO = 'https://github.com/NCHC-bio/inference-calculator';

/** Reason text cap: the whole link stays far below the ~8 KB URL limit GitHub accepts. */
export const REPORT_REASON_MAX = 1500;

/**
 * A new issue from `.github/ISSUE_TEMPLATE/unsupported-model.yml` with every field filled in (GitHub issue forms take
 * a field's value from the query parameter named by its id): `support` asks to model an estimated architecture
 * precisely, `error` reports an import that failed (a bug). Only the repo, the commit and the reason go into the link:
 * never a token, whatever the repo is (the signature has no place for one).
 */
export function reportModelUrl(repo: string, sha: string | undefined, reason: string, kind: 'support' | 'error'): string {
  const cut = reason.length > REPORT_REASON_MAX ? `${reason.slice(0, REPORT_REASON_MAX - 1)}…` : reason;
  const at = sha ?? 'main';
  const q = new URLSearchParams({
    template: 'unsupported-model.yml',
    title: `${kind === 'support' ? 'Support model' : 'Import error'}: ${repo}`,
    repo,
    ...(sha ? { sha } : {}),
    reason: cut,
    config: `https://huggingface.co/${repo}/blob/${at}/config.json`,
  });
  return `${GITHUB_REPO}/issues/new?${q.toString()}`;
}
