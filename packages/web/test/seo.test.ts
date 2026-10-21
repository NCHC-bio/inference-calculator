import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';

const SITE = 'https://nchc-bio.github.io/inference-calculator/';
// jsdom gives import.meta.url an http scheme, so resolve from the working directory (repo root or packages/web).
const webDir = existsSync(join(process.cwd(), 'index.html')) ? process.cwd() : join(process.cwd(), 'packages', 'web');
const file = (p: string) => join(webDir, p);
const html = readFileSync(file('index.html'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const meta = (sel: string) => doc.querySelector(sel)?.getAttribute('content') ?? '';

describe('index.html SEO and link previews', () => {
  it('has a title, description and canonical URL', () => {
    expect(doc.title).toContain('國網推論算力計算機');
    expect(meta('meta[name="description"]').length).toBeGreaterThan(40);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE);
  });

  it('Open Graph and Twitter cards point at absolute URLs of files that exist', () => {
    for (const sel of ['meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="twitter:title"]']) {
      expect(meta(sel), sel).not.toBe('');
    }
    expect(meta('meta[property="og:url"]')).toBe(SITE);
    expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    for (const sel of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
      expect(meta(sel), sel).toBe(`${SITE}og-image.png`);
    }
    // The PNG in public/ is the size the tags declare (IHDR width/height at bytes 16–23).
    const png = readFileSync(file('public/og-image.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
      Number(meta('meta[property="og:image:width"]')),
      Number(meta('meta[property="og:image:height"]')),
    ]);
    expect(readFileSync(file('public/favicon.svg'), 'utf8')).toContain('<svg');
  });

  it('structured data is valid JSON describing the site', () => {
    const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(ld['@type']).toBe('WebApplication');
    expect(ld.url).toBe(SITE);
    expect(ld.publisher.logo).toBe(`${SITE}nchc-logo.png`);
    expect(readFileSync(file('public/nchc-logo.png')).subarray(1, 4).toString()).toBe('PNG');
  });

  it('hardware named in the static description exists in the bundle (no stale names)', () => {
    const names = new Set(Object.values(getBundle().platforms).map((p) => p.name));
    for (const name of ['H100', 'H200', 'GB200', 'Mac Studio', 'DGX Spark']) {
      expect(meta('meta[name="description"]')).toContain(name);
      expect(names.has(name), name).toBe(true);
    }
  });

  it('robots.txt and sitemap.xml point at the deployed site', () => {
    expect(readFileSync(file('public/robots.txt'), 'utf8')).toContain(`${SITE}sitemap.xml`);
    expect(readFileSync(file('public/sitemap.xml'), 'utf8')).toContain(`<loc>${SITE}</loc>`);
  });
});
