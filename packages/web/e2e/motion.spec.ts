import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { tZh } from '../src/i18n/t';
import { answer, attachJson, bestRow, bundle, DEFAULT, expectedMain, need, openRow, row, settle, suggestedOf, url, watchConsole } from './helpers';

watchConsole();
test.skip(({ isMobile }) => isMobile, 'motion frames are taken on desktop only');
test.setTimeout(60_000);


/** Frame times after the region starts changing (design §3.6 / §9). */
const AT = [0, 100, 200, 400] as const;

/**
 * The typing demo runs on its own clock, independent of the input under test: hidden so the screenshots show only the
 * change being animated.
 */
async function hideTyping(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="typed"], [data-testid="waiting"], [data-testid="typed"] ~ span { visibility: hidden !important; }' });
}

/** What to read from the region that must transition: the answer's count, a box's width / height / top, an svg width. */
type Probe = { sel: string; read: 'count' | 'width' | 'height' | 'top' | 'attrWidth' };
/** One rAF sample: page time, wall clock (to line up with the screencast) and the region's value (null: not there). */
type Sample = { t: number; wall: number; v: number | null };

/** Starts sampling `probe` on every animation frame for `ms` (from now) into window.motionRec. */
async function startSampling(page: Page, probe: Probe, ms = 2000): Promise<void> {
  await page.evaluate(
    ([p, dur]) => {
      const w = window as unknown as { motionRec: { t: number; wall: number; v: number | null }[] };
      w.motionRec = [];
      const read = (): number | null => {
        const el = document.querySelector<HTMLElement>(p.sel);
        // A panel that is not mounted yet is 0 px high.
        if (!el) return p.read === 'height' ? 0 : null;
        if (p.read === 'count') {
          const m = /×\s*([\d,]+)/.exec(el.textContent ?? '');
          return m ? Number(m[1]!.replace(/,/g, '')) : null;
        }
        if (p.read === 'width') return el.getBoundingClientRect().width;
        if (p.read === 'height') return el.getBoundingClientRect().height;
        if (p.read === 'top') return parseFloat(getComputedStyle(el).top);
        return Number(el.getAttribute('width'));
      };
      const t0 = performance.now();
      const tick = () => {
        w.motionRec.push({ t: performance.now(), wall: Date.now(), v: read() });
        if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      };
      tick();
    },
    [probe, ms] as const,
  );
}

const samples = (page: Page) => page.evaluate(() => (window as unknown as { motionRec: Sample[] }).motionRec);

const EPS = 0.5;
const same = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) < EPS);

/** The samples from the first frame where the region differs from its value before the input. */
function fromChange(rec: Sample[]): { before: number | null; changed: Sample[]; final: number | null } {
  const before = rec[0]!.v;
  const i = rec.findIndex((r) => !same(r.v, before));
  const changed = i < 0 ? [] : rec.slice(i);
  return { before, changed, final: rec[rec.length - 1]!.v };
}

/**
 * Records the page with Chrome's screencast (one PNG per painted frame, with its paint time) while `act` runs; returns
 * a function that attaches the frames on screen 0 / 100 / 200 / 400 ms after `anchorWall` and the settled one. A
 * Playwright screenshot takes ~100 ms itself, too slow for 100 ms steps. The frames are evidence, not the assertion.
 */
async function capture(page: Page, act: () => Promise<void>): Promise<(name: string, anchorWall: number) => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  const shots: { ts: number; buf: Buffer }[] = [];
  cdp.on('Page.screencastFrame', (e) => {
    shots.push({ ts: e.metadata.timestamp! * 1000, buf: Buffer.from(e.data, 'base64') });
    void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(300);
  await act();
  await page.waitForTimeout(500);
  await settle(page);
  await page.evaluate(() => {
    // One more paint so the settled state is in the stream even when nothing moved for a while.
    document.body.style.outline = '0px solid transparent';
  });
  await page.waitForTimeout(300);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  return async (name, anchor) => {
    for (const ms of AT) {
      const f = shots.filter((x) => x.ts <= anchor + ms).pop() ?? shots[0]!;
      const path = test.info().outputPath(`${name}-${ms}ms.png`);
      writeFileSync(path, f.buf);
      await test.info().attach(`${name} ${ms} ms after the region starts changing (painted at ${Math.round(f.ts - anchor)} ms)`, { path, contentType: 'image/png' });
    }
    const path = test.info().outputPath(`${name}-final.png`);
    writeFileSync(path, shots[shots.length - 1]!.buf);
    await test.info().attach(`${name} final`, { path, contentType: 'image/png' });
  };
}

const best = need(DEFAULT).best!;
const suggested = suggestedOf(DEFAULT, 'nano4-h200');
const users200 = { ...DEFAULT, users: 200 };
/** A user count with the same best platform as the default and a different count (the answer's number rolls). */
const usersSameBest = [20, 25, 30, 40, 50, 60, 80, 100, 10, 8, 6, 5, 4, 3, 2].find((u) => {
  const s = { ...DEFAULT, users: u };
  return need(s).best === best && suggestedOf(s, best) !== suggestedOf(DEFAULT, best);
})!;
const countInput = (page: Page) => row(page, 'nano4-h200').getByLabel(tZh('row.count', { name: bundle.platforms['nano4-h200']!.name }));
const h200 = '.rows > .ant-collapse-item[data-row="nano4-h200"]';
const backToSuggested = (page: Page) => row(page, 'nano4-h200').getByTestId('action-chip').filter({ hasText: new RegExp(`\\b${suggested}\\b`) }).last();

/** Each interaction of design §9: set-up, the input, the region that must transition, and the settled DOM. */
const CASES: { name: string; probe: Probe; setup: (page: Page) => Promise<void>; act: (page: Page) => Promise<void>; done: (page: Page) => Promise<void> }[] = [
  {
    name: `users-15-${usersSameBest}`,
    probe: { sel: '[data-testid="answer-main"]', read: 'count' },
    setup: async (page) => {
      await page.goto('/');
      await expect(answer(page)).toHaveText(expectedMain(DEFAULT));
      await page.getByLabel(tZh('aria.users'), { exact: true }).focus();
      await settle(page);
    },
    act: async (page) => {
      await page.getByLabel(tZh('aria.users'), { exact: true }).fill(String(usersSameBest));
    },
    done: async (page) => {
      await expect(answer(page)).toHaveText(expectedMain({ ...DEFAULT, users: usersSameBest }));
    },
  },
  {
    // 「改回建議的 N 張」 on a budget row: the count goes back to the suggestion, so the full capacity bar shrinks.
    name: 'apply-action',
    probe: { sel: `${h200} [data-testid="capacity"] .ant-progress-track`, read: 'width' },
    setup: async (page) => {
      await page.goto(url({ o: `nano4-h200:${Math.max(1, suggested - 2)}` }));
      await openRow(page, 'nano4-h200');
      await expect(backToSuggested(page)).toBeVisible();
      await settle(page);
    },
    act: async (page) => {
      await backToSuggested(page).click();
      await page.mouse.move(0, 0);
    },
    done: async (page) => {
      await expect(countInput(page)).toHaveValue(String(suggested));
    },
  },
  {
    name: 'expand-row',
    probe: { sel: '.rows > .ant-collapse-item[data-best="true"] > .ant-collapse-panel, .rows > .ant-collapse-item[data-best="true"] > .ant-collapse-content', read: 'height' },
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
    probe: { sel: '[data-testid="best-marker"]', read: 'top' },
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
    // The count is typed in set-up (it commits only on Enter, Ruling W6): the act is Enter alone.
    name: 'icons-cross-fit',
    probe: { sel: `${h200} [data-testid="isotype"]`, read: 'attrWidth' },
    setup: async (page) => {
      await page.goto('/');
      await expect(row(page, 'nano4-h200').locator('text.brace-label')).toHaveCount(0);
      await countInput(page).fill('480');
      await settle(page);
    },
    act: async (page) => {
      await countInput(page).press('Enter');
    },
    done: async (page) => {
      await expect(row(page, 'nano4-h200').locator('text.brace-label')).toHaveText(/× 60 node/);
    },
  },
];

for (const c of CASES) {
  test(`${c.name}: the region passes through in-between values (frames 0 / 100 / 200 / 400 ms attached)`, async ({ page }) => {
    await c.setup(page);
    await hideTyping(page);
    await startSampling(page, c.probe);
    const attach = await capture(page, () => c.act(page));
    await c.done(page);
    const rec = await samples(page);
    const { before, changed, final } = fromChange(rec);
    await attachJson(`${c.name} region per frame`, {
      probe: c.probe,
      before,
      final,
      changed: changed.map((r) => ({ ms: Math.round(r.t - changed[0]!.t), v: r.v })),
    });
    expect(changed.length, 'the region changed').toBeGreaterThan(0);
    await attach(c.name, changed[0]!.wall);
    expect(before).not.toBeNull();
    expect(final).not.toBeNull();
    expect(same(before, final), 'old and new values differ').toBe(false);
    const lo = Math.min(before!, final!) + EPS;
    const hi = Math.max(before!, final!) - EPS;
    const between = changed.filter((r) => r.v !== null && r.v > lo && r.v < hi);
    // The first changed frame is not already the final value, and in-between values were on screen.
    expect(same(changed[0]!.v, final), 'first changed frame is not the final value (no pop)').toBe(false);
    expect(between.length, 'frames with an in-between value').toBeGreaterThan(1);
  });

  test(`${c.name}: reduced motion: the first changed frame is the final value`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await c.setup(page);
    await startSampling(page, c.probe);
    await c.act(page);
    await c.done(page);
    await settle(page);
    const { before, changed, final } = fromChange(await samples(page));
    await attachJson(`${c.name} reduced region per frame`, {
      before,
      final,
      changed: changed.map((r) => ({ ms: Math.round(r.t - changed[0]!.t), v: r.v })),
    });
    expect(changed.length, 'the region changed').toBeGreaterThan(0);
    expect(changed.every((r) => same(r.v, final)), 'every frame after the change shows the final value').toBe(true);
    const path = test.info().outputPath(`${c.name}-reduced-final.png`);
    await page.screenshot({ path });
    await test.info().attach(`${c.name} reduced final`, { path, contentType: 'image/png' });
  });
}

// Carried from Task 5: the first open must not show an empty panel for a frame. Every animation frame after the click
// records whether the opened panel is visible and whether the workbench is inside it.
test('first open: the panel is never empty (every frame, plus 0 / 100 ms frames)', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  await page.evaluate(() => {
    const w = window as unknown as { openRec: { wall: number; t: number; panelH: number; wb: boolean }[] };
    w.openRec = [];
    document.addEventListener(
      'click',
      () => {
        const t0 = performance.now();
        const tick = () => {
          const item = document.querySelector('.rows > .ant-collapse-item[data-best="true"]');
          const panel = item?.querySelector<HTMLElement>(':scope > .ant-collapse-panel, :scope > .ant-collapse-content');
          w.openRec.push({ wall: Date.now(), t: performance.now() - t0, panelH: panel ? panel.getBoundingClientRect().height : -1, wb: !!panel?.querySelector('[data-testid="workbench"]') });
          if (performance.now() - t0 < 800) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: true },
    );
  });
  const attach = await capture(page, () => bestRow(page).getByTestId('row-name').click());
  const rec = await page.evaluate(() => (window as unknown as { openRec: { wall: number; t: number; panelH: number; wb: boolean }[] }).openRec);
  await attachJson('first open per frame', rec);
  const empty = rec.filter((r) => r.panelH > 0 && !r.wb);
  expect(empty.map((r) => `${Math.round(r.t)} ms: panel ${Math.round(r.panelH)} px without workbench`)).toEqual([]);
  // The panel grows (Collapse height motion) instead of appearing at full height.
  const heights = rec.map((r) => r.panelH).filter((h) => h > 0);
  expect(new Set(heights.map(Math.round)).size, `panel heights: ${heights.map(Math.round).join(', ')}`).toBeGreaterThan(2);
  const grow = rec.find((x) => x.panelH > 0);
  if (grow) await attach('first-open', grow.wall);
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
