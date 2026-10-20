import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle, loadConfig, validateConfig } from '../src/index';

describe('loadBundle', () => {
  it('round-trips a validated bundle through JSON, preserving key order', () => {
    const { bundle } = validateConfig(loadConfig(fileURLToPath(new URL('../../../config', import.meta.url))));
    expect(bundle).toBeDefined();
    const file = join(mkdtempSync(join(tmpdir(), 'nchc-bundle-')), 'bundle.json');
    writeFileSync(file, JSON.stringify(bundle));
    const b = loadBundle(file);
    expect(b).toEqual(bundle);
    expect(Object.keys(b.platforms)[0]).toBe('nano4-h200');
  });

  it('rejects a bundle that fails the schema', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nchc-bundle-')), 'bundle.json');
    writeFileSync(file, JSON.stringify({ meta: { dataVersion: '2026-10-19' } }));
    expect(() => loadBundle(file)).toThrow();
  });
});
