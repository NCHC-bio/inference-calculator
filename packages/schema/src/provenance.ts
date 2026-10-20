import { z } from 'zod';

/** Provenance status of a data value (spec §2.1). `user` exists only at core runtime. */
export const StatusSchema = z.enum(['official', 'measured', 'derived', 'estimate', 'unverified']);
export type Status = z.infer<typeof StatusSchema>;
export type CoreStatus = Status | 'user';

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
};
/** Repo-relative path (e.g. `docs/research/x.md#section`): no scheme, not absolute, no `..`. */
const isRepoPath = (s: string): boolean => /^[^/:\s][^:\s]*$/.test(s) && !s.split(/[/#]/).includes('..');

export const SourceSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Absolute http(s) URL; an `internal` source may instead give a repo-relative path (review M8). */
    url: z.string().min(1),
    accessed: z.iso.date(),
    kind: z.enum(['official', 'paper', 'benchmark', 'secondary', 'internal']),
    /** Organisation that produced the data (Ruling R21: data-source origin is data, not only a YAML comment). */
    originOrg: z.string().min(1).optional(),
    /** Country of `originOrg`, ISO-3166 alpha-2 uppercase. */
    originCountry: z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2 uppercase').optional(),
  })
  .superRefine((s, ctx) => {
    if (isHttpUrl(s.url) || (s.kind === 'internal' && isRepoPath(s.url))) return;
    ctx.addIssue({
      code: 'custom', path: ['url'],
      message: s.kind === 'internal'
        ? 'url must be an absolute http(s) URL or a repo-relative path'
        : 'url must be an absolute http(s) URL (only internal sources may use a repo-relative path)',
    });
  });
export type Source = z.infer<typeof SourceSchema>;

/**
 * Wrap a value schema with provenance fields and enforce the sourcing rules:
 * - official / measured / unverified require `source`
 * - unverified also requires `conflict` (why it could not be verified / how sources disagree) or `sources`
 *   listing at least two conflicting source ids (spec §2.1); both fields are for unverified values only
 * - derived requires (`formula` and non-empty `inputs`) or `source`
 * - estimate requires `basis` and at least one `evidence`; `judgedBy` (optional, estimate only) records who judged it,
 *   `verified` when (spec §2.1); without it the author of the commit that introduced the value is the record
 */
export function sourced<T extends z.ZodTypeAny>(inner: T) {
  return z
    .strictObject({
      value: inner,
      unit: z.string().optional(),
      status: StatusSchema,
      source: z.string().min(1).optional(),
      evidence: z.array(z.string().min(1)).optional(),
      basis: z.string().min(1).optional(),
      formula: z.string().min(1).optional(),
      inputs: z.array(z.string().min(1)).optional(),
      /** unverified: every source found, when they contradict each other (≥ 2 ids). */
      sources: z.array(z.string().min(1)).optional(),
      /** unverified: the contradiction, or why no source could verify the value. */
      conflict: z.string().min(1).optional(),
      /** estimate: who judged the value (spec §2.1). */
      judgedBy: z.string().min(1).optional(),
      verified: z.iso.date(),
    })
    .superRefine((v, ctx) => {
      const need = (ok: boolean, path: string, message: string) => {
        if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
      };
      switch (v.status) {
        case 'official':
        case 'measured':
          need(!!v.source, 'source', `${v.status} requires source`);
          break;
        case 'unverified':
          need(!!v.source, 'source', 'unverified requires source');
          need(
            !!v.conflict || (v.sources?.length ?? 0) >= 2,
            'conflict',
            'unverified requires conflict (the contradiction, or why it is unverifiable) or at least two sources',
          );
          break;
        case 'derived':
          need(
            !!v.source || (!!v.formula && !!v.inputs && v.inputs.length > 0),
            'formula',
            'derived requires formula+inputs or source',
          );
          break;
        case 'estimate':
          need(!!v.basis, 'basis', 'estimate requires basis');
          need(!!v.evidence && v.evidence.length > 0, 'evidence', 'estimate requires at least one evidence');
          break;
      }
      if (v.status !== 'unverified') {
        need(v.conflict === undefined, 'conflict', 'conflict is for unverified values only');
        need(v.sources === undefined, 'sources', 'sources is for unverified values only');
      }
      if (v.status !== 'estimate') need(v.judgedBy === undefined, 'judgedBy', 'judgedBy is for estimate values only');
    });
}
export type Sourced<T extends z.ZodTypeAny> = z.infer<ReturnType<typeof sourced<T>>>;
