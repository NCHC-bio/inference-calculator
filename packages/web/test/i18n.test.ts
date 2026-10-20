import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import zhTW from '../src/i18n/zh-TW';
import { t } from '../src/i18n';

const placeholders = (msg: string): string[] => [...new Set([...msg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

describe('i18n catalogs', () => {
  it('every key has the same {placeholder} names in zh-TW and en', () => {
    const keys = Object.keys(zhTW) as (keyof typeof zhTW)[];
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
    for (const k of keys) expect({ key: k, names: placeholders(en[k]) }).toEqual({ key: k, names: placeholders(zhTW[k]) });
  });
  it("status labels follow spec §2.1's table (derived → 推算)", () => {
    expect(t('zh-TW', 'status.derived')).toBe('推算');
    expect(t('zh-TW', 'status.estimate')).toBe('推估');
    expect(t('zh-TW', 'status.unverified')).toBe('未查證');
    expect(t('zh-TW', 'status.measured')).toBe('實測');
    expect(t('zh-TW', 'status.user')).toBe('自訂');
  });
});
