import { writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { estimateRequirements, type RequirementResult } from '@nchc/core';
import type { Bundle } from '@nchc/schema';
// Relative import, same as the core tests: the bundle is built in memory from config/.
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { needAnswerText } from '../src/components/answerText';
import { tZh } from '../src/i18n/t';
import { defaultState, type CalcState } from '../src/state/state';

export function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}

export const bundle = realBundle();
export const DEFAULT = defaultState(bundle);

export const need = (s: CalcState): RequirementResult =>
  estimateRequirements(bundle, {
    model: s.model,
    quant: s.quant,
    workload: s.workload as string,
    speed: s.speed as string,
    users: s.users,
  });
export const expectedMain = (s: CalcState): string => needAnswerText(need(s), bundle, tZh).main;

/** Every `console.error` and uncaught page error of the test; each spec asserts it stays empty. */
export function watchConsole(): () => string[] {
  let errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
  });
  return () => errors;
}

export async function widths(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await widths(page);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

export const row = (page: Page, key: string): Locator => page.locator(`.rows > .ant-collapse-item[data-row="${key}"]`);
export const bestRow = (page: Page): Locator => page.locator('.rows > .ant-collapse-item[data-best="true"]');
export const answer = (page: Page): Locator => page.getByTestId('answer-main');

/** Opens a platform row by its name (the only toggle) and waits for the workbench. */
export async function openRow(page: Page, key: string): Promise<Locator> {
  const r = row(page, key);
  await r.getByTestId('row-name').click();
  await expect(r.getByTestId('workbench')).toBeVisible();
  return r;
}

/** Query string for a state (the app's own URL format, design §7). */
export function url(q: { n?: number; w?: string; m?: string; q?: string; s?: string; o?: string; lang?: string }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return `/?${p.toString()}`;
}

/** Waits until no CSS animation / transition is running (antd motion, .reveal, BestMarker) and two frames have passed. */
export async function settle(page: Page): Promise<void> {
  // Endless animations (the hourglass spin, antd wave) never finish; only finite ones count.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
  );
  await page.waitForTimeout(600); // d3 transitions and number tweens (400 ms) are not Web Animations
}

/** Pixels that differ between two PNGs (decoded in a blank page's canvas) and their bounding box. */
export async function pngDiff(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ count: number; box: { x0: number; y0: number; x1: number; y1: number } | null }> {
  const p = await page.context().newPage();
  try {
    return await p.evaluate(
      async ([da, db]) => {
        const load = async (src: string) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        };
        const [x, y] = await Promise.all([load(da!), load(db!)]);
        if (x.width !== y.width || x.height !== y.height) return { count: -1, box: null };
        let count = 0;
        let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
        for (let i = 0; i < x.data.length; i += 4) {
          if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
            count++;
            const px = (i / 4) % x.width;
            const py = Math.floor(i / 4 / x.width);
            box = box
              ? { x0: Math.min(box.x0, px), y0: Math.min(box.y0, py), x1: Math.max(box.x1, px), y1: Math.max(box.y1, py) }
              : { x0: px, y0: py, x1: px, y1: py };
          }
        }
        return { count, box };
      },
      [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`],
    );
  } finally {
    await p.close();
  }
}

/** Attaches `data` as JSON to the report and writes it to the test's output folder. */
export async function attachJson(name: string, data: unknown): Promise<void> {
  const path = test.info().outputPath(`${name.replace(/[^\w.-]+/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(data, null, 1));
  await test.info().attach(name, { path, contentType: 'application/json' });
}

/** Core's suggested count for `platform` under `s` (throws when the platform is infeasible there). */
export function suggestedOf(s: CalcState, platform: string): number {
  const e = need(s).perPlatform.find((p) => p.platform === platform)?.expected;
  if (!e?.ok) throw new Error(`${platform} is not feasible for this state`);
  return e.gpus;
}
