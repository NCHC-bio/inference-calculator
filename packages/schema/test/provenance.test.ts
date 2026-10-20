import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SourceSchema, sourced } from '../src/provenance';
const S = sourced(z.number());
describe('sourced()', () => {
  it('official 需要 source', () => {
    expect(S.safeParse({ value: 141, unit: 'GB', status: 'official', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 141, unit: 'GB', status: 'official', source: 'nvidia-h200', verified: '2026-10-19' }).success).toBe(true);
  });
  it('estimate 需要 basis 與至少一個 evidence', () => {
    expect(S.safeParse({ value: 0.7, status: 'estimate', basis: 'x', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 0.7, status: 'estimate', basis: 'x', evidence: ['apple-mlx'], verified: '2026-10-19' }).success).toBe(true);
  });
  it('judgedBy（由誰判斷）只用於 estimate', () => {
    expect(S.safeParse({ value: 0.7, status: 'estimate', basis: 'x', evidence: ['apple-mlx'], judgedBy: 'whats2000', verified: '2026-10-19' }).success).toBe(true);
    expect(S.safeParse({ value: 141, status: 'official', source: 'nvidia-h200', judgedBy: 'whats2000', verified: '2026-10-19' }).success).toBe(false);
  });
  it('derived 需要 formula+inputs 或 source', () => {
    expect(S.safeParse({ value: 4, status: 'derived', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 4, status: 'derived', formula: '72/18', inputs: ['nchc-nano4-manual'], verified: '2026-10-19' }).success).toBe(true);
  });
  it('unverified 需要矛盾說明（conflict）或至少兩個互相矛盾的 sources（spec §2.1，review M8）', () => {
    const u = { value: null, status: 'unverified', source: 'a', verified: '2026-10-19' };
    const N = sourced(z.number().nullable());
    expect(N.safeParse(u).success).toBe(false);
    expect(N.safeParse({ ...u, conflict: '官方未公布單 GPU 數值' }).success).toBe(true);
    expect(N.safeParse({ ...u, sources: ['a', 'b'] }).success).toBe(true);
    expect(N.safeParse({ ...u, sources: ['a'] }).success).toBe(false);
    // conflict / sources describe an unverified value only.
    expect(S.safeParse({ value: 1, status: 'official', source: 'a', conflict: 'x', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 1, status: 'official', source: 'a', sources: ['a', 'b'], verified: '2026-10-19' }).success).toBe(false);
  });
  it('verified 必須是日期', () => {
    expect(S.safeParse({ value: 1, status: 'official', source: 'a', verified: 'yesterday' }).success).toBe(false);
  });
  it('不接受 user 狀態（user 只存在於 core 執行期）', () => {
    expect(S.safeParse({ value: 1, status: 'user', verified: '2026-10-19' }).success).toBe(false);
  });
});
describe('SourceSchema origin (Ruling R21)', () => {
  const src = { id: 'x', title: 't', url: 'https://example.org', accessed: '2026-10-19', kind: 'paper' };
  it('originOrg / originCountry are optional; country is ISO-3166 alpha-2 uppercase', () => {
    expect(SourceSchema.safeParse(src).success).toBe(true);
    expect(SourceSchema.parse({ ...src, originOrg: 'Org', originCountry: 'CN' })).toMatchObject({ originOrg: 'Org', originCountry: 'CN' });
    expect(SourceSchema.safeParse({ ...src, originCountry: 'cn' }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...src, originCountry: 'CHN' }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...src, originOrg: '' }).success).toBe(false);
  });
  it('url is an absolute http(s) URL; only internal sources may use a repo-relative path (review M8)', () => {
    for (const url of ['example.org', 'ftp://example.org/x', 'https://', 'not a url', '/abs/path']) {
      expect(SourceSchema.safeParse({ ...src, url }).success, url).toBe(false);
    }
    expect(SourceSchema.safeParse({ ...src, url: 'docs/research/x.md' }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...src, kind: 'internal', url: 'docs/research/x.md#section' }).success).toBe(true);
    expect(SourceSchema.safeParse({ ...src, kind: 'internal', url: '../outside.md' }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...src, kind: 'internal', url: 'https://example.org/x' }).success).toBe(true);
  });
});
