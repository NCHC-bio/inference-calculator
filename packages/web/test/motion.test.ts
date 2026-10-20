import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import zhTW from '../src/i18n/zh-TW';
import { t } from '../src/i18n';
import { transitionMs } from '../src/motion';
import { setMedia } from './setup';

describe('motion', () => {
  it('reduced motion → 0 ms, otherwise 400', () => {
    setMedia({ reducedMotion: true });
    expect(transitionMs()).toBe(0);
    setMedia({ reducedMotion: false });
    expect(transitionMs()).toBe(400);
  });
});

describe('i18n', () => {
  it('every zh-TW key exists in en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
  });
  it('interpolates {name} vars', () => {
    expect(t('zh-TW', 'footer.dataVersion', { version: 'x1' })).toBe('資料版本 x1');
  });
});
