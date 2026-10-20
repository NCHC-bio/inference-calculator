/**
 * The error contract of the public API (spec §9): every problem with the CALLER'S input throws a
 * CoreInputError, so the website / MCP server can tell "fix your request" from a config or core bug
 * (plain Error). Pure; no Node or DOM APIs.
 */
import type { z } from 'zod';

export type CoreInputErrorCode =
  /** The input does not match the entry point's zod schema; `issues` lists every problem (the ZodError is `cause`). */
  | 'invalid-input'
  /** A config id (model, quantization, platform, workload, speed preset) that the bundle does not have. */
  | 'unknown-id';

export class CoreInputError extends Error {
  readonly code: CoreInputErrorCode;
  /** Zod issues for 'invalid-input'; empty otherwise. */
  readonly issues: z.core.$ZodIssue[];
  constructor(code: CoreInputErrorCode, message: string, opts?: { issues?: z.core.$ZodIssue[]; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CoreInputError';
    this.code = code;
    this.issues = opts?.issues ?? [];
  }
}

/** Parse `raw` with `schema`; a failure becomes CoreInputError('invalid-input') listing every issue. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  throw new CoreInputError('invalid-input', `輸入不合法：${lines.join('；')}`, { issues: r.error.issues, cause: r.error });
}
