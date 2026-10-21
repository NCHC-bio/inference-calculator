import { expect, test, type Page } from '@playwright/test';
import { estimatePerformance, estimatePerformanceSweep } from '@nchc/core';
import { fmt } from '../src/components/answerText';
import { tZh } from '../src/i18n/t';
import { quantFor, type CalcState } from '../src/state/state';
import { answer, bundle, DEFAULT, expectedMain, need, noHorizontalScroll, openRow, row, settle, suggestedOf, url, watchConsole, widths } from './helpers';

watchConsole();

/** Screenshot to the test's output folder and the HTML report. */
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

const dialog = (page: Page) => page.getByRole('dialog');

/** Opens a Drawer / Modal with `open`, screenshots it, closes it with Escape. */
async function dialogShot(page: Page, name: string, open: () => Promise<void>): Promise<void> {
  await open();
  await expect(dialog(page)).toHaveCount(1);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
}

async function pickCustom(page: Page, aria: string): Promise<void> {
  await page.getByLabel(aria, { exact: true }).click();
  await page.locator(`.ant-select-dropdown:visible [role="option"][title="${tZh('opt.custom')}"]`).click();
}

/** Budget scenario of design §3.5: chat, gemma-4-12b-it, ok speed; 480 H200 (60 nodes) and 20 Mac Studios. */
const OVERFLOW: CalcState = { ...DEFAULT, workload: 'chat', model: 'gemma-4-12b-it', quant: quantFor(bundle, 'gemma-4-12b-it', DEFAULT.quant), speed: 'ok' };
/** The first machine-unit platform that serves the scenario on 20 machines (spec: mac-studio-m5u-512 unless it cannot). */
const MAC = ['mac-studio-m5u-512', ...Object.keys(bundle.platforms)].find((id) => {
  if (bundle.platforms[id]!.unit !== 'machine') return false;
  const { users, workload, speed, model, quant } = OVERFLOW;
  return estimatePerformance(bundle, { users, workload: workload as string, speed: speed as string, model, quant, platform: id, gpus: 20 }).ok;
})!;
const OVERFLOW_URL = url({ w: 'chat', m: 'gemma-4-12b-it', s: 'ok', o: `nano4-h200:480,${MAC}:20` });

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`screenshots (${colorScheme})`, () => {
    test.use({ colorScheme });
    test.setTimeout(120_000);

    test('every state of design §9', async ({ page }) => {
      const best = need(DEFAULT).best!;
      await page.goto('/');
      await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
      await shot(page, 'default');

      await openRow(page, best);
      await shot(page, 'workbench', true);
      await noHorizontalScroll(page);

      // Comparison: pin the best row, then a second one.
      await row(page, best).getByRole('button', { name: tZh('wb.pin') }).click();
      const second = need(DEFAULT).perPlatform.find((p) => p.expected.ok && p.platform !== best)!.platform;
      await openRow(page, second);
      await row(page, second).getByRole('button', { name: tZh('wb.pin') }).click();
      await expect(page.getByTestId('compare').locator('tbody tr.ant-table-row')).toHaveCount(2);
      await page.getByTestId('compare').scrollIntoViewIfNeeded();
      await shot(page, 'compare');

      // Every Drawer / Modal reachable from the open workbench and the answer line.
      await dialogShot(page, 'drawer-verify', () => row(page, second).getByRole('button', { name: tZh('wb.verify') }).click());
      await page.evaluate(() => window.scrollTo(0, 0));
      await dialogShot(page, 'modal-basis', () => page.getByRole('button', { name: tZh('answer.basis') }).click());
      await dialogShot(page, 'modal-cite', () => page.getByRole('button', { name: tZh('answer.cite') }).click());
      await dialogShot(page, 'drawer-accuracy', () => page.getByRole('button', { name: tZh('footer.accuracy') }).click());
      await dialogShot(page, 'drawer-workload', () => pickCustom(page, tZh('aria.workload')));
      await dialogShot(page, 'drawer-speed', () => pickCustom(page, tZh('aria.speed')));

      // Users field focused: the funnel hint under it, then its Drawer.
      await page.goto('/');
      await page.getByLabel(tZh('aria.users'), { exact: true }).focus();
      const funnel = page.getByRole('button', { name: tZh('users.funnelHint') });
      await expect(funnel).toBeVisible();
      await shot(page, 'users-focus');
      await dialogShot(page, 'drawer-funnel', () => funnel.click());

      // Model search finds nothing: HF import and manual entry.
      const model = page.getByLabel(tZh('aria.model'), { exact: true });
      await model.click();
      await model.fill('acme/no-such-model');
      const importBtn = page.getByRole('button', { name: tZh('model.importRepo', { repo: 'acme/no-such-model' }) });
      await expect(importBtn).toBeVisible();
      await shot(page, 'model-not-found');
      await dialogShot(page, 'drawer-hf', () => importBtn.click());
      await model.click();
      await model.fill('zzzz');
      await dialogShot(page, 'drawer-manual-model', () => page.getByRole('button', { name: tZh('model.manual') }).click());

      // Budget-limited row (fewer cards than suggested) and well-funded row (more), both expanded.
      const suggested = suggestedOf(DEFAULT, best);
      await page.goto(url({ o: `${best}:${Math.max(1, Math.floor(suggested / 2))}` }));
      await openRow(page, best);
      await expect(row(page, best).getByTestId('speed-line')).toBeVisible();
      await shot(page, 'row-under-budget', true);
      await page.goto(url({ o: `${best}:${suggested * 4}` }));
      await openRow(page, best);
      await shot(page, 'row-over-budget', true);

      // Add hardware: the form, then the new row (fixture values typed by a user, not hardware data).
      await page.goto('/');
      await page.getByRole('button', { name: tZh('platforms.addHardware') }).click();
      const form = dialog(page);
      await form.getByLabel(tZh('hw.name')).fill('Lab GPU box');
      await form.getByLabel(tZh('hw.gpn')).fill('4');
      await form.getByLabel(tZh('hw.mem.gpu')).fill('96');
      await form.getByLabel(tZh('hw.bw.gpu')).fill('3');
      await form.getByLabel(tZh('hw.tflops.vllm')).fill('900');
      await form.getByLabel(tZh('hw.nvlink')).fill('600');
      await shot(page, 'drawer-hardware');
      await page.getByRole('button', { name: tZh('hw.add') }).click();
      await expect(dialog(page)).toHaveCount(0);
      const custom = row(page, 'custom:0');
      await expect(custom).toContainText('Lab GPU box');
      await custom.scrollIntoViewIfNeeded();
      await shot(page, 'hardware-row', true);
    });
  });
}

test.describe('no horizontal scroll', () => {
  for (const width of [390, 768, 1024, 1440]) {
    test(`${width} px: 480 H200 and 20 ${MAC}, collapsed and expanded`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(OVERFLOW_URL);
      const h200 = row(page, 'nano4-h200');
      await expect(h200.locator('text.brace-label')).toHaveText(/× 60 node/);
      await expect(row(page, MAC).getByTestId('isotype')).toBeVisible();
      await settle(page);
      const collapsed = await widths(page);
      await page.screenshot({ path: test.info().outputPath(`overflow-${width}.png`), fullPage: true });
      await openRow(page, 'nano4-h200');
      await settle(page);
      const expanded = await widths(page);
      await page.screenshot({ path: test.info().outputPath(`overflow-${width}-open.png`), fullPage: true });
      const report = { width, collapsed, expanded };
      console.log(`overflow ${JSON.stringify(report)}`);
      await test.info().attach(`overflow-${width}.json`, { body: JSON.stringify(report), contentType: 'application/json' });
      expect(collapsed.scrollWidth).toBeLessThanOrEqual(collapsed.innerWidth);
      expect(expanded.scrollWidth).toBeLessThanOrEqual(expanded.innerWidth);
    });
  }
});

test.describe('values match core', () => {
  test('the answer is needAnswerText of estimateRequirements', async ({ page }) => {
    await page.goto('/');
    await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
    await page.goto(OVERFLOW_URL);
    await expect(answer(page)).toHaveText(expectedMain(OVERFLOW));
  });

  test('the expanded nano4-h200 row shows estimatePerformance numbers', async ({ page }) => {
    const r = need(DEFAULT).perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(r.expected.ok).toBe(true);
    const { users, workload, speed, model, quant } = DEFAULT;
    const perf = estimatePerformance(bundle, { users, workload: workload as string, speed: speed as string, model, quant, platform: 'nano4-h200', gpus: suggestedOf(DEFAULT, 'nano4-h200') });
    await page.goto('/');
    const h200 = await openRow(page, 'nano4-h200');
    await expect(h200.getByTestId('metric-tps')).toHaveText(fmt('zh-TW', perf.usage!.tokPerSecPerUser));
    await expect(h200.getByTestId('metric-ttft')).toHaveText(fmt('zh-TW', perf.usage!.ttftSec, 1));
    await expect(h200.getByTestId('metric-max')).toHaveText(fmt('zh-TW', perf.maxConcurrent));
    await expect(h200.getByLabel(tZh('row.count', { name: bundle.platforms['nano4-h200']!.name }))).toHaveValue(String(suggestedOf(DEFAULT, 'nano4-h200')));
  });

  // Ruling W9: the cards chart plots the fastest split that serves the users, so speed never drops as cards are added.
  test('the cards → speed chart is non-decreasing', async ({ page }) => {
    await page.goto('/');
    const h200 = await openRow(page, 'nano4-h200');
    await settle(page);
    const d = await h200.locator('[data-testid="chart-cards"] path.line').getAttribute('d');
    const pts = [...(d ?? '').matchAll(/[ML]\s*([-\d.e]+)[ ,]([-\d.e]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(pts.length).toBeGreaterThan(3);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.x).toBeGreaterThan(pts[i - 1]!.x);
      // SVG y grows downwards: a faster point sits higher (smaller y).
      expect(pts[i]!.y).toBeLessThanOrEqual(pts[i - 1]!.y + 0.01);
    }
    // Same in core's data for the plotted counts.
    const { users, workload, speed, model, quant } = DEFAULT;
    const sweep = estimatePerformanceSweep(bundle, {
      users,
      workload: workload as string,
      speed: speed as string,
      model,
      quant,
      platform: 'nano4-h200',
      gpusList: Array.from({ length: 32 }, (_, i) => i + 1),
    });
    const ys = sweep.points.flatMap((p) => (p.fastest ? [p.fastest.tokPerSecPerUser] : []));
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
  });
});

test.describe('carried checks', () => {
  test('without pins the comparison takes no height and Tab never reaches 清除', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard');
    await page.goto('/');
    const box = await page.getByTestId('compare').locator('xpath=../..').boundingBox();
    expect(box?.height ?? 0).toBe(0);
    const seen: string[] = [];
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          return el?.closest('[data-testid="compare"]') ? 'COMPARE' : (el?.textContent ?? '').slice(0, 20);
        }),
      );
    }
    expect(seen).not.toContain('COMPARE');
  });
});

test('console stays clean through a full flow', async ({ page }) => {
  await page.goto('/');
  const users = page.getByLabel(tZh('aria.users'), { exact: true });
  await users.fill('200');
  await expect(answer(page)).toHaveText(expectedMain({ ...DEFAULT, users: 200 }));
  const best = need({ ...DEFAULT, users: 200 }).best!;
  await openRow(page, best);
  // A budget row: its workbench offers actions; apply the first.
  const suggested = suggestedOf(DEFAULT, 'nano4-h200');
  await page.goto(url({ o: `nano4-h200:${Math.max(1, suggested - 2)}` }));
  const h200 = await openRow(page, 'nano4-h200');
  await h200.getByTestId('action-chip').first().click();
  await page.goto(OVERFLOW_URL);
  await openRow(page, 'nano4-h200');
  await page.getByText(tZh('lang.en'), { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await settle(page);
});
