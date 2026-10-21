import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { isotypeLayout } from '../src/components/Isotype';
import { t, type MsgKey } from '../src/i18n';

const en = (k: MsgKey, v?: Record<string, string | number>) => t('en', k, v);
const zh = (k: MsgKey, v?: Record<string, string | number>) => t('zh-TW', k, v);
const rowOf = (key: string) => screen.getAllByTestId('platform-row').find((x) => x.dataset.row === key)!;
const addon = (key: string) => within(rowOf(key)).getByTestId('count-control').querySelector('.ant-space-addon, .ant-space-compact-addon')?.textContent
  ?? within(within(rowOf(key)).getByTestId('count-control')).getByText(/^(GPUs?|machines?|張|台)$/).textContent;

describe('English unit plurals (fix round E)', () => {
  it('unit words: singular for 1, plural otherwise; zh-TW has no plural', () => {
    expect(en('unit.gpu', { n: '1' })).toBe('GPU');
    expect(en('unit.gpu', { n: '2' })).toBe('GPUs');
    expect(en('unit.gpu', { n: '1,200' })).toBe('GPUs');
    expect(en('unit.machine', { n: '1' })).toBe('machine');
    expect(en('unit.machine', { n: '20' })).toBe('machines');
    expect(zh('unit.gpu', { n: '1' })).toBe('張');
    expect(zh('unit.machine', { n: '2' })).toBe('台');
  });

  it('the brace label: × 1 node・1 GPU, × 60 nodes, × 1 machine', () => {
    expect(isotypeLayout({ expected: 1, conservative: null, unit: 'gpu', gpusPerNode: 8 }, 300, en).label).toBe('× 1 node・1 GPU');
    expect(isotypeLayout({ expected: 480, conservative: null, unit: 'gpu', gpusPerNode: 8 }, 300, en).label).toBe('× 60 nodes・480 GPUs');
    expect(isotypeLayout({ expected: 1, conservative: null, unit: 'machine', gpusPerNode: 1 }, 300, en).label).toBe('× 1 machine');
    expect(isotypeLayout({ expected: 2, conservative: null, unit: 'machine', gpusPerNode: 1 }, 300, en).label).toBe('× 2 machines');
    expect(isotypeLayout({ expected: 1, conservative: null, unit: 'gpu', gpusPerNode: 8 }, 300, zh).label).toBe(zh('isotype.label.gpu', { nodes: '1', gpus: '1' }));
  });

  it('answer line and count controls in en: × 1 GPU, 2 GPUs, 1 machine', async () => {
    history.replaceState(null, '', '/?lang=en&w=chat&m=gemma-4-12b-it&s=ok&o=nano5-h100:2');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('answer-main')).toHaveTextContent(/× 1 GPU(?!s)/));
    expect(screen.getByTestId('answer-sub')).toHaveTextContent(/Conservative × 1 GPU(?!s)/);
    expect(addon('nano4-h200')).toBe('GPU');
    expect(addon('nano5-h100')).toBe('GPUs');
    expect(addon('dgx-spark')).toBe('machine');
    expect(document.body.textContent).not.toMatch(/\b1 GPUs\b|\b1 machines\b/);
  });
});
