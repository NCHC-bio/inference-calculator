import { expect, test, type Page } from '@playwright/test';
import { estimateRequirements, type RequirementResult } from '@nchc/core';
import type { Bundle } from '@nchc/schema';
// Relative import, same as the core tests: the bundle is built in memory from config/.
import { CONFIG_DIR, loadConfig, validateConfig } from '../../data/src/index';
import { needAnswerText } from '../src/components/answerText';
import { tZh } from '../src/i18n/t';
import { defaultState, quantFor, type CalcState } from '../src/state/state';

function realBundle(): Bundle {
  const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
  if (!bundle) throw new Error(`config invalid: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
  return bundle;
}

const bundle = realBundle();
const DEFAULT = defaultState(bundle);

const need = (s: CalcState): RequirementResult =>
  estimateRequirements(bundle, { model: s.model, quant: s.quant, workload: s.workload, speed: s.speed, users: s.users });
const expectedMain = (s: CalcState): string => needAnswerText(need(s), bundle, tZh).main;

type SelectKey = 'workload' | 'speed' | 'model';
const LABEL: Record<SelectKey, string> = { workload: tZh('aria.workload'), speed: tZh('aria.speed'), model: tZh('aria.model') };
const NAMES: Record<SelectKey, Record<string, { name: string }>> = {
  workload: bundle.workloads,
  speed: bundle.speedPresets,
  model: bundle.models,
};

const withChoice = (s: CalcState, key: SelectKey, id: string): CalcState =>
  key === 'model' ? { ...s, model: id, quant: quantFor(bundle, id, s.quant) } : { ...s, [key]: id };

const ORDER = ['workload', 'speed', 'model'] as const;

/** Options to pick for each select in ORDER (depth-first over the catalog) so that every pick changes the answer. */
function changingPath(s: CalcState, i = 0): string[] | null {
  if (i === ORDER.length) return [];
  const key = ORDER[i]!;
  const now = expectedMain(s);
  for (const id of Object.keys(NAMES[key])) {
    if (id === s[key]) continue;
    const next = withChoice(s, key, id);
    if (expectedMain(next) === now) continue;
    const rest = changingPath(next, i + 1);
    if (rest) return [id, ...rest];
  }
  return null;
}

/** The visible value of a Select: its content box carries the selected label as `title`. */
const shownValue = (page: Page, key: SelectKey) =>
  page.locator('.ant-select').filter({ has: page.getByLabel(LABEL[key], { exact: true }) }).locator('.ant-select-content');

async function choose(page: Page, key: SelectKey, id: string): Promise<void> {
  const name = NAMES[key][id]!.name;
  const input = page.getByLabel(LABEL[key], { exact: true });
  await input.click();
  // The model list is long and virtualised: filter by typing so the option is rendered.
  if (key === 'model') await input.fill(name);
  await page.locator(`.ant-select-dropdown:visible [role="option"][title="${name}"]`).click();
}

const bestRow = (page: Page) => page.locator('[data-testid="platform-row"][data-best="true"]');

let consoleErrors: string[] = [];
test.beforeEach(({ page }) => {
  consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
});
test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('default URL shows the core answer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sentence')).toBeVisible();
  await expect(page.getByTestId('answer-main')).toHaveText(expectedMain(DEFAULT));
  await expect(page.getByText(tZh('footer.dataVersion', { version: bundle.meta.dataVersion }))).toBeVisible();
  await noHorizontalScroll(page);
});

test('workload, speed and model each change the answer and leave the other selects alone', async ({ page }) => {
  await page.goto('/');
  let s = DEFAULT;
  const path = changingPath(s);
  expect(path, 'some workload → speed → model sequence changes the answer at every step').not.toBeNull();
  await expect(page.getByTestId('answer-main')).toHaveText(expectedMain(s));
  for (const [i, key] of ORDER.entries()) {
    const before = expectedMain(s);
    const others = ORDER.filter((k) => k !== key);
    const othersBefore = await Promise.all(others.map((k) => shownValue(page, k).getAttribute('title')));
    const id = path![i]!;
    s = withChoice(s, key, id);
    await choose(page, key, id);
    await expect(shownValue(page, key)).toHaveAttribute('title', NAMES[key][id]!.name);
    await expect(page.getByTestId('answer-main')).toHaveText(expectedMain(s));
    expect(expectedMain(s)).not.toBe(before);
    for (const [i, k] of others.entries()) await expect(shownValue(page, k)).toHaveAttribute('title', othersBefore[i]!);
  }
});

test('the user count is in the URL and a reload restores the same screen', async ({ page }) => {
  await page.goto('/');
  const users = page.getByLabel(tZh('aria.users'), { exact: true });
  const next = DEFAULT.users * 3;
  await users.fill(String(next));
  await expect(page).toHaveURL(new RegExp(`[?&]n=${next}(&|$)`));
  const s = { ...DEFAULT, users: next };
  await expect(page.getByTestId('answer-main')).toHaveText(expectedMain(s));

  const snapshot = async () => ({
    main: await page.getByTestId('answer-main').innerText(),
    sub: await page.getByTestId('answer-sub').innerText(),
    users: await users.inputValue(),
    rows: await page.getByTestId('platform-row').allInnerTexts(),
    selects: await page.locator('[data-testid="sentence"] .ant-select-content').evaluateAll((els) => els.map((e) => e.getAttribute('title'))),
  });
  const url = page.url();
  const before = await snapshot();
  await page.goto(url);
  await expect(page.getByTestId('answer-main')).toHaveText(before.main);
  expect(page.url()).toBe(url);
  expect(await snapshot()).toEqual(before);
});

test('the best row expands to four usage bars and a typing demo that starts in time', async ({ page }) => {
  const r = need(DEFAULT);
  expect(r.best).not.toBeNull();
  const ttftSec = r.perPlatform.find((p) => p.platform === r.best)!.usage!.ttftSec;
  await page.goto('/');
  const row = bestRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-platform', r.best!);
  const toggle = row.getByTestId('row-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const started = Date.now();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const detail = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
  await expect(detail).toHaveAttribute('data-testid', 'row-detail');
  await expect(detail.getByTestId('usage-bar')).toHaveCount(4);
  for (const key of ['usage.mem', 'usage.bw', 'usage.compute', 'usage.ttft'] as const) {
    await expect(detail.getByText(tZh(key), { exact: true })).toBeVisible();
  }
  await expect(detail.getByTestId('typed')).toHaveText(/\S/, { timeout: Math.max(1000, (ttftSec + 2) * 1000 - (Date.now() - started)) });
  await noHorizontalScroll(page);
});

test('dark colour scheme repaints the page background', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByTestId('answer-main')).toBeVisible();
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(bg).not.toBe(light);
  await noHorizontalScroll(page);
});

test.describe('touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch-only behaviour');

  test('tapping 推估 opens its popover', async ({ page }) => {
    expect(need(DEFAULT).hasEstimate).toBe(true);
    await page.goto('/');
    const tag = page
      .locator('.ant-flex')
      .filter({ has: page.getByTestId('answer-main') })
      .last()
      .locator('.ant-tag', { hasText: tZh('tag.estimate') });
    await tag.tap();
    await expect(page.locator('.ant-popover:visible').filter({ hasText: tZh('answer.estimates.title') })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('the workload menu shows option descriptions inline', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(tZh('aria.workload'), { exact: true }).tap();
    for (const w of Object.values(bundle.workloads)) {
      await expect(page.locator(`.ant-select-dropdown:visible [role="option"][title="${w.name}"]`).getByText(w.description, { exact: true })).toBeVisible();
    }
    await noHorizontalScroll(page);
  });
});
