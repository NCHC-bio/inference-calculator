import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { tZh } from '../src/i18n/t';
import { answer, attachJson, bestRow, bundle, DEFAULT, expectedMain, need, openRow, row, settle, suggestedOf, url, watchConsole } from './helpers';

watchConsole();
test.skip(({ isMobile }) => isMobile, 'motion frames are taken on desktop only');
test.setTimeout(60_000);


/** Frame times after the input (design §3.6 / §9). */
const AT = [0, 100, 200, 400] as const;

type Frame = { at: number; buf: Buffer };
/** `between`: a frame painted after the input that is neither the frame before it nor the settled one. */
type Frames = { frames: Frame[]; last: Buffer; between: number | null };

/**
 * The typing demo runs on its own clock, independent of the input under test: hidden in every frame so a frame differs
 * from the final one only because of the change being animated.
 */
async function hideTyping(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="typed"], [data-testid="waiting"], [data-testid="typed"] ~ span { visibility: hidden !important; }' });
}

/**
 * Records the page with Chrome's screencast (one PNG per painted frame, with its paint time), runs `act`, and picks the
 * frame on screen 0 / 100 / 200 / 400 ms after the input, plus the last frame once everything has settled. A Playwright
 * screenshot takes ~100 ms itself, too slow to catch a 400 ms transition at 100 ms steps.
 */
async function capture(page: Page, name: string, act: () => Promise<void>): Promise<Frames> {
  const cdp = await page.context().newCDPSession(page);
  const shots: { ts: number; buf: Buffer }[] = [];
  cdp.on('Page.screencastFrame', (e) => {
    shots.push({ ts: e.metadata.timestamp! * 1000, buf: Buffer.from(e.data, 'base64') });
    void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await act();
  await page.waitForTimeout(500);
  await settle(page);
  // Nudge one more paint so the settled state is in the stream even when nothing moved for a while.
  await page.evaluate(() => {
    document.body.style.outline = '0px solid transparent';
  });
  await page.waitForTimeout(300);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  const pick = (ms: number): Frame => {
    const before = shots.filter((x) => x.ts <= t0 + ms);
    const f = before[before.length - 1] ?? shots[0]!;
    return { at: Math.round(f.ts - t0), buf: f.buf };
  };
  const frames = AT.map(pick);
  const last = shots[shots.length - 1]!.buf;
  const pre = frames[0]!.buf;
  const mid = shots.find((x) => x.ts > t0 && !x.buf.equals(pre) && !x.buf.equals(last));
  const between = mid ? Math.round(mid.ts - t0) : null;
  for (const [i, f] of frames.entries()) {
    const path = test.info().outputPath(`${name}-${AT[i]}ms.png`);
    writeFileSync(path, f.buf);
    await test.info().attach(`${name} ${AT[i]} ms (painted at ${f.at} ms)`, { path, contentType: 'image/png' });
  }
  const path = test.info().outputPath(`${name}-final.png`);
  writeFileSync(path, last);
  await test.info().attach(`${name} final`, { path, contentType: 'image/png' });
  await attachJson(`${name} paint times`, { between, paints: shots.map((x) => Math.round(x.ts - t0)) });
  return { frames, last, between };
}

/**
 * The change transitions instead of popping: the 100 ms frame differs from the settled one, and at least one painted frame
 * after the input is neither the old screen nor the final one (an in-between state was on screen).
 */
function expectMoving({ frames, last, between }: Frames): void {
  expect(frames[1]!.buf.equals(last), '100 ms frame differs from the final frame').toBe(false);
  expect(between, 'an in-between frame was painted').not.toBeNull();
}


const best = need(DEFAULT).best!;
const suggested = suggestedOf(DEFAULT, 'nano4-h200');
const users200 = { ...DEFAULT, users: 200 };
let applyFrom = '';
const countInput = (page: Page) => row(page, 'nano4-h200').getByLabel(tZh('row.count', { name: bundle.platforms['nano4-h200']!.name }));

/** Each interaction of design §9: how to set it up, the input, and the settled DOM it must reach. */
const CASES: { name: string; setup: (page: Page) => Promise<void>; act: (page: Page) => Promise<void>; done: (page: Page) => Promise<void> }[] = [
  {
    name: 'users-15-200',
    setup: async (page) => {
      await page.goto('/');
      await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
    },
    act: async (page) => {
      await page.getByLabel(tZh('aria.users'), { exact: true }).fill('200');
    },
    done: async (page) => {
      await expect(answer(page)).toHaveText(expectedMain(users200));
    },
  },
  {
    name: 'apply-action',
    setup: async (page) => {
      await page.goto(url({ o: `nano4-h200:${Math.max(1, suggested - 2)}` }));
      await openRow(page, 'nano4-h200');
      await expect(row(page, 'nano4-h200').getByTestId('action-chip').first()).toBeVisible();
      await settle(page);
    },
    act: async (page) => {
      applyFrom = page.url();
      await row(page, 'nano4-h200').getByTestId('action-chip').first().click();
      await page.mouse.move(0, 0);
    },
    done: async (page) => {
      await expect.poll(() => page.url()).not.toBe(applyFrom);
    },
  },
  {
    name: 'expand-row',
    setup: async (page) => {
      await page.goto('/');
      await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
      await settle(page);
    },
    act: async (page) => {
      await bestRow(page).getByTestId('row-name').click();
    },
    done: async (page) => {
      await expect(bestRow(page).getByTestId('workbench')).toBeVisible();
    },
  },
  {
    name: 'best-row-changes',
    setup: async (page) => {
      await page.goto('/');
      await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
      await page.getByLabel(tZh('aria.users'), { exact: true }).focus();
      await settle(page);
    },
    act: async (page) => {
      await page.getByLabel(tZh('aria.users'), { exact: true }).fill('200');
    },
    done: async (page) => {
      await expect(page.getByTestId('best-marker')).toHaveAttribute('data-row', need(users200).best!);
    },
  },
  {
    name: 'icons-cross-fit',
    setup: async (page) => {
      await page.goto('/');
      await expect(row(page, 'nano4-h200').locator('text.brace-label')).toHaveCount(0);
      await countInput(page).focus();
      await settle(page);
    },
    act: async (page) => {
      await countInput(page).fill('480');
      await countInput(page).press('Enter');
    },
    done: async (page) => {
      await expect(row(page, 'nano4-h200').locator('text.brace-label')).toHaveText(/× 60 node/);
    },
  },
];

for (const c of CASES) {
  test(`${c.name}: 0 / 100 / 200 / 400 ms frames move`, async ({ page }) => {
    await c.setup(page);
    await hideTyping(page);
    const f = await capture(page, c.name, () => c.act(page));
    await c.done(page);
    expectMoving(f);
  });

  test(`${c.name}: reduced motion reaches the final state at once`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await c.setup(page);
    await c.act(page);
    // The DOM has the new state (core computed it); the first frame must already be the settled one.
    await c.done(page);
    const first = await page.screenshot();
    await settle(page);
    const last = await page.screenshot();
    for (const [label, buf] of [['first', first], ['final', last]] as const) {
      const path = test.info().outputPath(`${c.name}-reduced-${label}.png`);
      writeFileSync(path, buf);
      await test.info().attach(`${c.name} reduced ${label}`, { path, contentType: 'image/png' });
    }
    expect(first.equals(last), 'first frame equals the final frame').toBe(true);
  });
}

// Carried from Task 5: the first open must not show an empty panel for a frame. Every animation frame after the click
// records whether the opened panel is visible and whether the workbench is inside it.
test('first open: the panel is never empty (every frame, plus 0 / 100 ms frames)', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  await page.evaluate(() => {
    const w = window as unknown as { openRec: { t: number; panelH: number; wb: boolean }[] };
    w.openRec = [];
    document.addEventListener(
      'click',
      () => {
        const t0 = performance.now();
        const tick = () => {
          const item = document.querySelector('.rows > .ant-collapse-item[data-best="true"]');
          const panel = item?.querySelector<HTMLElement>(':scope > .ant-collapse-panel, :scope > .ant-collapse-content');
          w.openRec.push({ t: performance.now() - t0, panelH: panel ? panel.getBoundingClientRect().height : -1, wb: !!panel?.querySelector('[data-testid="workbench"]') });
          if (performance.now() - t0 < 800) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: true },
    );
  });
  const f = await capture(page, 'first-open', () => bestRow(page).getByTestId('row-name').click());
  const rec = await page.evaluate(() => (window as unknown as { openRec: { t: number; panelH: number; wb: boolean }[] }).openRec);
  await attachJson('first open per frame', rec);
  const empty = rec.filter((r) => r.panelH > 0 && !r.wb);
  expect(empty.map((r) => `${Math.round(r.t)} ms: panel ${Math.round(r.panelH)} px without workbench`)).toEqual([]);
  // The panel grows (Collapse height motion) instead of appearing at full height.
  const heights = rec.map((r) => r.panelH).filter((h) => h > 0);
  expect(new Set(heights.map(Math.round)).size, `panel heights: ${heights.map(Math.round).join(', ')}`).toBeGreaterThan(2);
  expectMoving(f);
});

// Carried from Task 7: when the best platform changes, the answer never pairs one platform's name with another's count.
test('best platform change: the answer never shows a mismatched name and count', async ({ page }) => {
  await page.goto('/');
  await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
  const before = need(DEFAULT).best;
  const after = need(users200).best;
  expect(after).not.toBe(before);
  await page.evaluate(() => {
    const w = window as unknown as { rec: { t: number; a: string; top: string }[] };
    w.rec = [];
    const t0 = performance.now();
    const tick = () => {
      const a = document.querySelector('[data-testid="answer-main"]')?.textContent ?? '';
      const m = document.querySelector<HTMLElement>('[data-testid="best-marker"]');
      w.rec.push({ t: performance.now() - t0, a, top: m ? getComputedStyle(m).top : '' });
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByLabel(tZh('aria.users'), { exact: true }).fill('200');
  await page.waitForTimeout(1600);
  const rec = await page.evaluate(() => (window as unknown as { rec: { t: number; a: string; top: string }[] }).rec);
  await attachJson('answer and marker per frame', rec);
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  const allowed = new Set([norm(expectedMain(DEFAULT)), norm(expectedMain(users200))]);
  const bad = rec.filter((r) => !allowed.has(norm(r.a)));
  expect(bad.map((r) => `${Math.round(r.t)} ms: ${r.a}`)).toEqual([]);
  // The marker slides: it passes through positions between the old and the new row.
  const tops = new Set(rec.map((r) => r.top));
  expect(tops.size).toBeGreaterThan(3);
});

// Carried from Task 3: the first real measurement draws the icons at once (no slide from the 300 px fallback layout).
test('isotype: no animation on mount', async ({ page }) => {
  // Sample the row's icon svg width every frame from the first script on.
  await page.addInitScript(() => {
    const w = window as unknown as { iconWidths: string[] };
    w.iconWidths = [];
    const t0 = performance.now();
    const tick = () => {
      const svg = document.querySelector('.rows > .ant-collapse-item[data-row="nano4-h200"] [data-testid="isotype"]');
      const v = svg?.getAttribute('width');
      if (v && w.iconWidths[w.iconWidths.length - 1] !== v) w.iconWidths.push(v);
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(url({ o: 'nano4-h200:480' }));
  await page.waitForTimeout(1500);
  const seen = await page.evaluate(() => (window as unknown as { iconWidths: string[] }).iconWidths);
  await attachJson('isotype widths after load', seen);
  // A tween from the fallback layout would pass through many widths; drawing at once shows at most fallback → measured.
  expect(seen.length, `widths seen: ${seen.join(', ')}`).toBeLessThanOrEqual(2);
});
