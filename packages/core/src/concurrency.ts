/**
 * Interpretation of "at most N users at the same time".
 * Basis: spec §8.3.3 (concurrency interpretation; not covered by the lecture).
 * - chat: generating = N, resident (holding KV cache) = N.
 * - agent: resident sessions = N, generating = max(1, ceil(N x agentGeneratingShare)).
 */
export function concurrencyFor(
  n: number,
  kind: 'chat' | 'agent',
  agentGeneratingShare: number,
): { generating: number; resident: number } {
  if (kind === 'chat') return { generating: n, resident: n };
  return { generating: Math.max(1, Math.ceil(n * agentGeneratingShare)), resident: n };
}
