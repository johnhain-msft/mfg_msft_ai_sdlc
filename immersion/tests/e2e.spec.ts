import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deck } from '../src/content';
import { presenterLabel } from '../src/content/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const URL_DECK = pathToFileURL(`${ROOT}dist/index.html`).href;
const TOTAL = 25;

// Observe the whole context, including speaker/script popups and explicitly created pages.
const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ context }, use) => {
    const errors: string[] = [];
    const observe = (page: Page) => {
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${page.url()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
    };
    context.pages().forEach(observe);
    context.on('page', observe);
    await use();
    context.off('page', observe);
    expect(errors, 'console and page errors in every window').toEqual([]);
  }, { auto: true }],
});

const open = async (page: Page, hash = ''): Promise<void> => {
  await page.goto(URL_DECK + hash);
  // attached, not visible: the speaker view and script book hide the deck surface on purpose
  await page.waitForSelector('#stage .slide.active', { state: 'attached' });
};
const activeId = (page: Page) => page.evaluate(() => document.querySelector('.slide.active')?.getAttribute('data-id') ?? null);
const activeIndex = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('.slide')).findIndex((s) => s.classList.contains('active')));
const press = async (page: Page, ...keys: string[]) => {
  for (const k of keys) await page.keyboard.press(k);
};
/** Words of the active slide under deck-density's tokenizer, ignoring nothing: the union-of-states probe. */
const activeWords = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.slide.active') as HTMLElement;
    return (el.innerText.match(/[A-Za-z0-9][A-Za-z0-9\-\u2019'.]*/g) ?? []).length;
  });

// ------------------------------------------------------------------------------------------ structure

test.describe('static twin and chrome', () => {
  test('pre-renders all 25 slides in #stage with exactly one active, chrome outside every slide', async ({ page }) => {
    await open(page);
    expect(await page.locator('#stage > section.slide').count()).toBe(TOTAL);
    expect(await page.locator('.slide.active').count()).toBe(1);
    const ids = await page.$$eval('#stage > section.slide', (els) => els.map((e) => `${e.id}:${(e as HTMLElement).dataset.id}`));
    expect(ids[0]).toBe('s1:m1-cover');
    expect(ids[11]).toBe('s12:m4-executive-roi');
    expect(ids[22]).toBe('s23:m7-maturity-dimensions');
    expect(ids[TOTAL - 1]).toBe('s25:m7-open-floor');
    for (const sel of ['#topbar', '#bottombar', '[data-nav="next"]', '[data-nav="prev"]', '#counter', '.ms-emblem']) {
      expect(await page.locator(`.slide ${sel}`).count(), `${sel} must not live inside a slide`).toBe(0);
      expect(await page.locator(sel).count()).toBeGreaterThan(0);
    }
  });

  test('non-active slides are inert and hidden from assistive tech', async ({ page }) => {
    await open(page);
    const state = await page.$$eval('#stage > section.slide', (els) =>
      els.map((e) => ({ active: e.classList.contains('active'), hidden: e.getAttribute('aria-hidden') === 'true', inert: e.hasAttribute('inert') })),
    );
    for (const s of state) expect({ hidden: s.hidden, inert: s.inert }).toEqual(s.active ? { hidden: false, inert: false } : { hidden: true, inert: true });
  });
});

// ------------------------------------------------------------------------------------------ navigation

test.describe('audience deck navigation', () => {
  test('arrow, space and page keys move one slide; home and end jump', async ({ page }) => {
    // slides 11-13 carry no staged widget, so every key moves exactly one slide (a staged slide steps first)
    await open(page, '#/m4-process-economics');
    expect(await activeIndex(page)).toBe(10);
    await press(page, 'ArrowRight');
    expect(await activeIndex(page)).toBe(11);
    await press(page, 'Space');
    expect(await activeIndex(page)).toBe(12);
    await press(page, 'ArrowLeft');
    expect(await activeIndex(page)).toBe(11);
    await press(page, 'PageDown');
    expect(await activeIndex(page)).toBe(12);
    await press(page, 'PageUp');
    expect(await activeIndex(page)).toBe(11);
    await press(page, 'End');
    expect(await activeIndex(page)).toBe(TOTAL - 1);
    await press(page, 'ArrowRight');
    expect(await activeIndex(page), 'no wrap past the last slide').toBe(TOTAL - 1);
    await press(page, 'Home');
    expect(await activeIndex(page)).toBe(0);
    await press(page, 'ArrowLeft');
    expect(await activeIndex(page), 'no wrap before the first slide').toBe(0);
  });

  test('on-screen next and previous buttons navigate', async ({ page }) => {
    await open(page);
    await page.locator('[data-nav="next"]').click();
    expect(await activeIndex(page)).toBe(1);
    await page.locator('[data-nav="prev"]').click();
    expect(await activeIndex(page)).toBe(0);
    await expect(page.locator('#counter')).toHaveText(`1 / ${TOTAL}`);
  });

  test('hash routing: id, number, s<n>, #s<n> all reach slide 3; bad refs fall back to slide 1', async ({ page }) => {
    await open(page);
    for (const h of ['#/3', '#/s3', '#s3', '#/m1-attention-economy']) {
      await page.evaluate((x) => {
        location.hash = '';
        location.hash = x;
      }, h);
      await expect.poll(() => activeIndex(page), { message: h }).toBe(2);
    }
    await page.evaluate(() => (location.hash = '#/25'));
    await expect.poll(() => activeIndex(page)).toBe(TOTAL - 1);
    await page.evaluate(() => (location.hash = '#/nonsense'));
    await expect.poll(() => activeIndex(page)).toBe(0);
    await page.evaluate(() => (location.hash = '#/99'));
    await expect.poll(() => activeIndex(page)).toBe(0);
  });

  test('hashchange updates the active slide before the next timer tick', async ({ page }) => {
    await open(page);
    const idx = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          location.hash = '#/5';
          setTimeout(() => resolve(Array.from(document.querySelectorAll('.slide')).findIndex((s) => s.classList.contains('active'))), 0);
        }),
    );
    expect(idx).toBe(4);
  });

  test('the location bar tracks the slide as a canonical, shareable id hash', async ({ page }) => {
    await open(page);
    await press(page, 'ArrowRight');
    expect(await page.evaluate(() => location.hash)).toBe('#/m1-vibe-cliff');
    await page.reload();
    expect(await activeId(page)).toBe('m1-vibe-cliff');
  });

  test('typing digits then Enter jumps to that slide', async ({ page }) => {
    await open(page);
    await press(page, '1', '2', 'Enter');
    expect(await activeIndex(page)).toBe(11);
    await press(page, '2', 'Enter');
    expect(await activeIndex(page)).toBe(1);
    await press(page, '9', '9', 'Enter');
    expect(await activeIndex(page), 'out-of-range numbers are ignored').toBe(1);
  });

  test('Space on a focused button activates the button instead of double-advancing', async ({ page }) => {
    await open(page);
    await page.locator('[data-nav="next"]').focus();
    await press(page, 'Space');
    expect(await activeIndex(page)).toBe(1);
  });

  test('navigation keys are ignored while typing in a text field', async ({ page, context }) => {
    await open(page);
    await press(page, 'c');
    await expect(page.locator('#dlg-glossary')).toHaveAttribute('open', '');
    await page.locator('#glossary-search').fill('gate');
    await press(page, 'ArrowRight', 's');
    expect(await activeIndex(page)).toBe(0);
    expect(context.pages(), 'typing S in a field must not open the speaker window').toHaveLength(1);
    await expect(page.locator('#glossary-search'), 'the letter is typed, not treated as a shortcut').toHaveValue('gates');
  });
});

// ------------------------------------------------------------------------------------------ fit

test.describe('responsive fit', () => {
  for (const [w, h] of [
    [1920, 1080],
    [1536, 864],
    [1366, 768],
    [1024, 700],
  ] as const) {
    test(`nothing clips at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page);
      // the same probe slide-review's fit audit uses: every visible text-bearing element stays inside the viewport
      const clip = await page.evaluate(([vw, vh]) => {
        let worst = 0;
        const bearsText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') === 0 || !bearsText(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          worst = Math.max(worst, r.right - (vw as number), r.bottom - (vh as number), -r.left, -r.top);
        }
        const stage = document.getElementById('stage')?.getBoundingClientRect();
        return { worst, stageFits: Boolean(stage && stage.left >= -1 && stage.top >= -1 && stage.right <= (vw as number) + 1 && stage.bottom <= (vh as number) + 1) };
      }, [w, h]);
      expect(clip.worst).toBeLessThanOrEqual(1);
      expect(clip.stageFits).toBe(true);
    });
  }

  test('the stage keeps a 16:9 shape however the window is shaped', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page);
    const r = await page.evaluate(() => {
      const b = (document.getElementById('stage') as HTMLElement).getBoundingClientRect();
      return b.width / b.height;
    });
    expect(r).toBeCloseTo(16 / 9, 2);
  });
});

// ------------------------------------------------------------------------------------------ overlays, theme

test.describe('overlays and toggles', () => {
  test('T toggles light and dark and remembers it', async ({ page }) => {
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await press(page, 't');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await press(page, 't');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('A and G open the module map, the same key closes it, and a click jumps', async ({ page }) => {
    await open(page);
    await press(page, 'a');
    await expect(page.locator('#dlg-overview')).toHaveAttribute('open', '');
    expect(await page.locator('#overview-grid .ov-module').count()).toBe(7);
    expect(await page.locator('#overview-grid .ov-slide').count()).toBe(TOTAL);
    await press(page, 'a');
    await expect(page.locator('#dlg-overview')).not.toHaveAttribute('open', '');
    await press(page, 'g');
    await page.locator('.ov-slide[data-go="m4-prompt-debugger"]').click();
    expect(await activeIndex(page)).toBe(14);
  });

  test('C opens the glossary, search filters it, Escape closes it', async ({ page }) => {
    await open(page);
    await press(page, 'c');
    const all = await page.locator('#glossary-list dt').count();
    expect(all).toBeGreaterThan(40);
    await page.locator('#glossary-search').fill('PROSE');
    const some = await page.locator('#glossary-list dt').count();
    expect(some).toBeGreaterThan(0);
    expect(some).toBeLessThan(all);
    await page.locator('#glossary-search').fill('zzzz-no-such-term');
    await expect(page.locator('.gl-empty')).toBeVisible();
    await press(page, 'Escape');
    await expect(page.locator('#dlg-glossary')).not.toHaveAttribute('open', '');
  });

  test('? opens keyboard help; B blacks out the screen and B restores it', async ({ page }) => {
    await open(page);
    await press(page, '?');
    await expect(page.locator('#dlg-help')).toHaveAttribute('open', '');
    await press(page, 'Escape');
    await press(page, 'b');
    await expect(page.locator('#blackout')).toBeVisible();
    await press(page, 'ArrowRight');
    expect(await activeIndex(page), 'keys do nothing while blacked out').toBe(0);
    await press(page, 'b');
    await expect(page.locator('#blackout')).toBeHidden();
  });

  test('M shows the Read-Along script panel for the current slide; the room never sees it by default', async ({ page }) => {
    await open(page);
    await expect(page.locator('#readalong')).toBeHidden();
    await press(page, 'm');
    await expect(page.locator('#readalong')).toBeVisible();
    await expect(page.locator('#ra-badge')).toContainText(presenterLabel('John'));
    await expect(page.locator('#ra-body')).toContainText('Welcome, everyone');
    await press(page, 'ArrowRight');
    await expect(page.locator('#ra-body')).not.toContainText('Welcome, everyone');
    await press(page, 'm');
    await expect(page.locator('#readalong')).toBeHidden();
  });

  test('Present (F) enters fullscreen and Read-Along is forced off and locked', async ({ page }) => {
    await open(page);
    await press(page, 'm');
    await expect(page.locator('#readalong')).toBeVisible();
    await press(page, 'f');
    const fs = await page.waitForFunction(() => Boolean(document.fullscreenElement), undefined, { timeout: 4000 }).then(
      () => true,
      () => false,
    );
    test.skip(!fs, 'this browser build refused fullscreen in automation');
    await expect(page.locator('body')).toHaveClass(/presenting/);
    await expect(page.locator('#readalong')).toBeHidden();
    await press(page, 'm');
    await expect(page.locator('#readalong'), 'M is locked off while presenting').toBeHidden();
    await expect(page.locator('#btn-readalong')).toBeDisabled();
    await press(page, 'f');
    await expect(page.locator('body')).not.toHaveClass(/presenting/);
  });
});

// ------------------------------------------------------------------------------------------ widgets

test.describe('widgets add no prose in any state', () => {
  test('slide 14 prompt debugger: keys 1-4 flip levers from $41.01 down to $4.81, 0 resets', async ({ page }) => {
    await open(page, '#/m4-prompt-debugger');
    const readout = page.locator('.slide.active [data-readout]');
    await expect(readout).toHaveText('$41.01 \u2192 $4.81 per run');
    const words0 = await activeWords(page);
    expect(words0).toBe(55);

    const seen: string[] = [];
    for (const k of ['1', '2', '3', '4']) {
      await press(page, k);
      seen.push((await page.locator('.slide.active [data-cost-now]').textContent()) ?? '');
      expect(await activeWords(page), 'word count is identical in every state').toBe(words0);
    }
    expect(seen).toEqual(['$25.46', '$20.68', '$19.72', '$4.81']);
    const nums = seen.map((s) => parseFloat(s.slice(1)));
    expect(nums[0]).toBeLessThan(41.01);
    expect(nums[1]).toBeLessThan(nums[0] as number);
    expect(nums[2]).toBeLessThan(nums[1] as number);
    expect(nums[3]).toBe(4.81);
    await expect(page.locator('.slide.active')).toHaveAttribute('data-levers', '1111');
    await expect(page.locator('.slide.active [data-lever][aria-checked="true"]')).toHaveCount(4);

    await press(page, '0');
    await expect(page.locator('.slide.active [data-cost-now]')).toHaveText('$41.01');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-levers', '0000');
  });

  test('slide 14: the stacked bar shrinks with the cost and clicking a tile flips its lever', async ({ page }) => {
    await open(page, '#/m4-prompt-debugger');
    const barWidth = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('.slide.active [data-seg]')).reduce((n, r) => n + parseFloat(r.getAttribute('width') ?? '0'), 0));
    const full = await barWidth();
    expect(full).toBeCloseTo(1200, 0);
    await page.locator('.slide.active [data-lever="routing"]').click();
    await expect(page.locator('.slide.active [data-lever="routing"]')).toHaveAttribute('aria-checked', 'true');
    expect(await barWidth()).toBeLessThan(full * 0.25);
    await press(page, '1', '2', '3');
    expect(await barWidth()).toBeCloseTo((4.81 / 41.01) * 1200, 0);
  });

  test('slide 14: digits drive the widget, not the slide jump buffer', async ({ page }) => {
    await open(page, '#/m4-prompt-debugger');
    await press(page, '1', '2', 'Enter');
    expect(await activeId(page)).toBe('m4-prompt-debugger');
  });

  test('slide 10 decision tree: keys 1-4 ring the matching gate tiles; the same key clears', async ({ page }) => {
    await open(page, '#/m3-gate-matrix');
    const words0 = await activeWords(page);
    const targets = () => page.$$eval('.slide.active .gate.is-target', (els) => els.map((e) => (e as HTMLElement).dataset.gate).sort());
    await press(page, '1');
    expect(await targets()).toEqual(['judgement-external', 'judgement-internal']);
    await expect(page.locator('.slide.active')).toHaveAttribute('data-how', 'judgement');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-who', 'internal external');
    await press(page, '2');
    expect(await targets()).toEqual(['programmatic-internal']);
    await press(page, '3');
    expect(await targets()).toEqual(['programmatic-internal']);
    await press(page, '4');
    expect(await targets()).toEqual(['programmatic-external']);
    await expect(page.locator('.slide.active .chip[aria-pressed="true"]')).toHaveText('Claimed green tests');
    expect(await activeWords(page)).toBe(words0);
    await press(page, '4');
    expect(await targets()).toEqual([]);
    await page.locator('.slide.active .chip', { hasText: 'Goal drift' }).click();
    expect(await targets()).toEqual(['judgement-external', 'judgement-internal']);
  });

  test('slide 4 staged: Space steps the highlight 1 to 3 before the deck moves on, and back again', async ({ page }) => {
    await open(page, '#/m2-hero-trap');
    const stage = () => page.locator('.slide.active').getAttribute('data-stage');
    expect(await stage()).toBe('');
    const words0 = await activeWords(page);
    await press(page, 'Space');
    expect(await stage()).toBe('hero');
    expect(await activeId(page)).toBe('m2-hero-trap');
    await press(page, 'Space');
    expect(await stage()).toBe('coe');
    await press(page, 'ArrowRight');
    expect(await stage()).toBe('advisory');
    expect(await page.locator('.slide.active .step.is-dim').count()).toBe(2);
    expect(await activeWords(page), 'every container stays in the DOM and counted').toBe(words0);
    expect(await page.evaluate(() => location.hash)).toBe('#/m2-hero-trap/3');
    await press(page, 'Space');
    expect(await activeId(page)).toBe('m2-supply-chain');
    await press(page, 'ArrowLeft');
    expect(await activeId(page), 'going back lands on the last stage of the previous slide').toBe('m2-hero-trap');
    expect(await stage()).toBe('advisory');
    await press(page, 'ArrowLeft', 'ArrowLeft', 'ArrowLeft');
    expect(await stage()).toBe('');
    await page.locator('.slide.active .step[data-stage="coe"]').click();
    expect(await stage()).toBe('coe');
    await page.locator('.slide.active .step[data-stage="coe"]').click();
    expect(await stage()).toBe('');
  });

  test('a deep link restores the stage step', async ({ page }) => {
    await open(page, '#/m2-hero-trap/2');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-stage', 'coe');
  });

  test('slide 7 scorecard: clicking a cell places the row in a tier; clicking again clears it; no text appears', async ({ page }) => {
    await open(page, '#/m2-governance-matrix');
    const words0 = await activeWords(page);
    const row = page.locator('.slide.active tr[data-row="cost-controls"]');
    await row.locator('td[data-tier="basic"]').click();
    await expect(row).toHaveAttribute('data-tier', 'basic');
    await expect(row.locator('td[data-tier="basic"]')).toHaveText('\u25cf');
    await expect(row.locator('td[data-tier="none"]')).toHaveText('\u25cb');
    await row.locator('td[data-tier="enterprise"]').click();
    await expect(row).toHaveAttribute('data-tier', 'enterprise');
    await row.locator('td[data-tier="enterprise"]').click();
    await expect(row).toHaveAttribute('data-tier', '');
    expect(await activeWords(page)).toBe(words0);
  });

  test('slide 22 room check: 1-3 pick, Enter reveals the answer with glyphs only, dots tally hands', async ({ page }) => {
    await open(page, '#/m7-quiz');
    const words0 = await activeWords(page);
    await press(page, '2');
    await expect(page.locator('.slide.active [data-q="board-metric"] .opt').nth(1)).toHaveClass(/is-picked/);
    await press(page, 'Enter');
    const q1 = page.locator('.slide.active [data-q="board-metric"]');
    await expect(q1).toHaveClass(/is-revealed/);
    await expect(q1.locator('.opt.is-correct')).toHaveCount(1);
    await expect(q1.locator('.opt').nth(1)).toHaveClass(/is-correct/);
    await expect(page.locator('.slide.active')).toHaveAttribute('data-active', '1');
    await press(page, '3', 'Enter');
    const q2 = page.locator('.slide.active [data-q="cost-lever"]');
    await expect(q2.locator('.opt').nth(0)).toHaveClass(/is-correct/);
    await expect(q2.locator('.opt').nth(2)).toHaveClass(/is-wrong/);
    await q2.locator('.tally').nth(0).click();
    await q2.locator('.tally').nth(0).click();
    expect(await q2.locator('.tally').nth(0).locator('i').count()).toBe(2);
    await q2.locator('.tally').nth(0).click({ modifiers: ['Shift'] });
    expect(await q2.locator('.tally').nth(0).locator('i').count()).toBe(1);
    expect(await activeWords(page), 'a quiz adds no words in any state').toBe(words0);
  });
});

// ------------------------------------------------------------------------------------------ custom diagrams

test.describe('custom diagrams respond to the stage steps and to hover, and never add prose', () => {
  test('slide 3 attention curve: Space lifts the trough lever by lever; the fourth press moves on', async ({ page }) => {
    await open(page, '#/m1-attention-economy');
    const words0 = await activeWords(page);
    const step = () => page.locator('.slide.active').getAttribute('data-step');
    expect(await step()).toBe('0');
    await expect(page.locator('.slide.active .d-s1 .d-cv')).toHaveCSS('opacity', '0');
    for (const [n, key] of [[1, 'progressive'], [2, 'scope'], [3, 'orchestrated']] as const) {
      await press(page, 'Space');
      expect(await step()).toBe(String(n));
      await expect(page.locator(`.slide.active .d-stage[data-stage="${key}"]`)).toHaveClass(/is-stage/);
      await expect(page.locator(`.slide.active .d-stage[data-stage="${key}"] .d-cv`)).toHaveCSS('opacity', '1');
      expect(await activeWords(page), 'the curve adds no words').toBe(words0);
    }
    await expect(page.locator('.slide.active .d-s1')).toHaveClass(/is-past/);
    await press(page, 'Space');
    expect(await activeId(page)).toBe('m2-hero-trap');
  });

  test('slide 6 roles: the rail lights the concern the stage names', async ({ page }) => {
    await open(page, '#/m2-three-roles/2');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-stage', 'how');
    await expect(page.locator('.slide.active .panel[data-stage="how"]')).toHaveClass(/is-stage/);
    await expect(page.locator('.slide.active .d-role[data-role="how"]')).toHaveCSS('opacity', '1');
    await expect(page.locator('.slide.active .d-role[data-role="what"]')).toHaveCSS('opacity', '0.45');
  });

  test('slide 9 metric stages: Space lifts one generation and dims the others', async ({ page }) => {
    await open(page, '#/m3-metric-evolution');
    await press(page, 'Space', 'Space');
    await expect(page.locator('.slide.active .step[data-stage="gen2"]')).toHaveClass(/is-stage/);
    expect(await page.locator('.slide.active .step.is-dim').count()).toBe(2);
    expect(await page.locator('.slide.active .step.is-past').count()).toBe(1);
  });

  test('slide 16 pipeline: a stage rings the bottleneck node and its panel together; a node click jumps', async ({ page }) => {
    await open(page, '#/m5-whack-a-mole');
    await press(page, 'Space');
    await expect(page.locator('.slide.active .d-bn[data-stage="intake"]')).toHaveClass(/is-stage/);
    await expect(page.locator('.slide.active .panel[data-stage="intake"]')).toHaveClass(/is-stage/);
    await expect(page.locator('.slide.active .d-bn.is-dim')).toHaveCount(2);
    await expect(page.locator('.slide.active .d-fast')).not.toHaveClass(/is-dim/);
    await page.locator('.slide.active .d-bn[data-stage="qa"] .d-node-r').click();
    await expect(page.locator('.slide.active')).toHaveAttribute('data-stage', 'qa');
    await expect(page.locator('.slide.active .panel[data-stage="qa"]')).toHaveClass(/is-stage/);
  });

  test('slide 5 supply chain: hovering a layer lights it with its owner and steps the others back', async ({ page }) => {
    await open(page, '#/m2-supply-chain');
    const words0 = await activeWords(page);
    await page.locator('.slide.active .d-layer[data-hl="l2"] .d-bar').hover();
    await expect(page.locator('.slide.active')).toHaveClass(/has-hl/);
    await expect(page.locator('.slide.active .d-layer[data-hl="l2"]')).toHaveClass(/is-hl/);
    await expect(page.locator('.slide.active .d-layer[data-hl="l4"]')).toHaveCSS('opacity', '0.45');
    expect(await activeWords(page)).toBe(words0);
  });

  test('slide 19 seam: focusing a station lights it; the others grey out but stay opaque over the seam', async ({ page }) => {
    await open(page, '#/m6-two-computers');
    await page.locator('.slide.active .d-station[data-hl="allowlist"]').focus();
    await expect(page.locator('.slide.active .d-station[data-hl="allowlist"]')).toHaveClass(/is-hl/);
    await expect(page.locator('.slide.active .d-station[data-hl="schema"]')).toHaveCSS('opacity', '1');
    await expect(page.locator('.slide.active .d-station[data-hl="schema"] .d-st')).not.toHaveCSS('fill', 'rgb(255, 255, 255)');
  });

  test('slide 22 progress rail follows the active question', async ({ page }) => {
    await open(page, '#/m7-quiz');
    await expect(page.locator('.slide.active .d-qp[data-qp="0"] .d-qp-dot')).toHaveCSS('opacity', '1');
    await press(page, '2', 'Enter');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-active', '1');
    await expect(page.locator('.slide.active .d-qp[data-qp="1"] .d-qp-dot')).toHaveCSS('opacity', '1');
    await expect(page.locator('.slide.active .d-qp[data-qp="0"] .d-qp-dot')).toHaveCSS('opacity', '0');
  });

  test('slide 23 reading rail: three icon-only links with accessible names that open in a new tab', async ({ page }) => {
    await open(page, '#/m7-open-floor');
    const links = page.locator('.slide.active .band .lico');
    await expect(links).toHaveCount(3);
    for (const l of await links.all()) {
      expect(await l.getAttribute('aria-label')).toBeTruthy();
      expect(await l.getAttribute('href')).toMatch(/^https:\/\//);
      expect(await l.getAttribute('target')).toBe('_blank');
      expect(await l.getAttribute('rel')).toContain('noopener');
      expect((await l.innerText()).trim(), 'icon only, no visible text').toBe('');
    }
  });
});

// ------------------------------------------------------------------------------------------ speaker view

const settleSpeaker = async (speaker: Page) => {
  await speaker.waitForSelector('#sp-title');
};

test.describe('speaker view', () => {
  test('renders the badge, the room-sees summary, SAY and CUE beats and miniature previews', async ({ page }) => {
    await open(page, '#/speaker/m2-governance-matrix');
    await settleSpeaker(page);
    await expect(page.locator('#sp-title')).toHaveText('7. Governance readiness scorecard');
    await expect(page.locator('#sp-badge .presenter-badge')).toHaveText(presenterLabel('John'));
    await expect(page.locator('#sp-room')).toContainText('The room sees');
    await expect(page.locator('#sp-room')).toContainText('A table of 6 rows');
    await expect(page.locator('#sp-room')).toContainText('Click a cell');
    expect(await page.locator('#sp-script .beat-say').count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator('#sp-script .beat-cue').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#sp-script .cue-poll .cue-tag')).toHaveText('POLL');
    await expect(page.locator('#sp-script .by'), 'a single presenter needs no speaker tags').toHaveCount(0);
    await expect(page.locator('#sp-current .slide.active')).toHaveCount(1);
    await expect(page.locator('#sp-next-frame .slide.active')).toHaveCount(1);
    await expect(page.locator('#sp-next-title')).toContainText('8.');
    expect(await page.locator('#stage .slide').count(), 'the deck surface is hidden, not rebuilt').toBe(TOTAL);
    await expect(page.locator('#presentation')).toBeHidden();
  });

  test('J and K move a beat highlight; A+ and A- change the text size; the stopwatch only counts up', async ({ page }) => {
    await open(page, '#/speaker/m1-cover');
    await settleSpeaker(page);
    expect(await page.locator('#sp-script .beat.is-current').count()).toBe(0);
    await press(page, 'j');
    await expect(page.locator('#sp-script .beat').first()).toHaveClass(/is-current/);
    await press(page, 'j');
    await expect(page.locator('#sp-script .beat').nth(1)).toHaveClass(/is-current/);
    await press(page, 'k');
    await expect(page.locator('#sp-script .beat').first()).toHaveClass(/is-current/);
    expect(await page.locator('#sp-script .beat.is-current').count()).toBe(1);

    const font = () => page.locator('#speaker').evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue('--sp-font')));
    const f0 = await font();
    await page.locator('#sp-font-inc').click();
    expect(await font()).toBe(f0 + 2);
    await page.locator('#sp-font-dec').click();
    await page.locator('#sp-font-dec').click();
    expect(await font()).toBe(f0 - 2);

    await expect(page.locator('#sp-watch')).toHaveText('00:00');
    await page.locator('#sp-watch-toggle').click();
    await expect.poll(() => page.locator('#sp-watch').textContent(), { timeout: 4000 }).not.toBe('00:00');
    await page.locator('#sp-watch-toggle').click();
    await page.locator('#sp-watch-reset').click();
    await expect(page.locator('#sp-watch')).toHaveText('00:00');
  });

  test('optional beats collapse into an "If needed" drawer and code can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '#/speaker/m4-prompt-debugger');
    await settleSpeaker(page);
    const drawer = page.locator('#sp-script details.drawer');
    await expect(drawer).toHaveCount(1);
    await expect(drawer).not.toHaveAttribute('open', '');
    await expect(drawer.locator('summary')).toContainText('If needed');
    await drawer.locator('summary').click();
    await expect(drawer.locator('pre code')).toContainText('Illustrative model, not vendor pricing');
    await drawer.locator('[data-copy]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Token inputs');
  });

  test('speaker and deck windows stay in sync in both directions', async ({ context }) => {
    const deck = await context.newPage();
    await open(deck);
    const speaker = await context.newPage();
    await speaker.goto(`${URL_DECK}#/speaker/m1-cover`);
    await settleSpeaker(speaker);

    await deck.keyboard.press('ArrowRight');
    await expect(speaker.locator('#sp-title')).toHaveText('2. Greenfield demos hit a cliff');
    await expect(speaker.locator('#sp-sync')).toHaveText('Synchronized with the audience deck');

    await speaker.locator('#sp-next').click();
    await expect.poll(() => activeId(deck)).toBe('m1-attention-economy');
    await speaker.keyboard.press('ArrowLeft');
    await expect.poll(() => activeId(deck)).toBe('m1-vibe-cliff');

    await deck.evaluate(() => (location.hash = '#/m4-prompt-debugger'));
    await expect(speaker.locator('#sp-title')).toHaveText('15. Debug one prompt');
    await deck.bringToFront();
    await deck.keyboard.press('4');
    await deck.keyboard.press('2');
    await expect.poll(() => speaker.locator('#sp-current [data-cost-now]').textContent()).not.toBe('$41.01');
    expect(await speaker.locator('#sp-current [data-lever][aria-checked="true"]').count()).toBe(2);
  });

  test('a speaker window opened with S follows the deck (postMessage path)', async ({ page }) => {
    await open(page, '#/m3-gate-matrix');
    const [speaker] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('s')]);
    await speaker.waitForSelector('#sp-title');
    await expect(speaker.locator('#sp-title')).toHaveText('10. Which gate catches it?');
    await page.keyboard.press('ArrowRight');
    await expect(speaker.locator('#sp-title')).toHaveText('11. Can we build it? Should we?');
    await expect(speaker.locator('#sp-sync')).toHaveText('Synchronized with the audience deck');
    await speaker.close();
  });

  test('stage steps are mirrored into the speaker preview', async ({ context }) => {
    const deck = await context.newPage();
    await open(deck, '#/m2-hero-trap');
    const speaker = await context.newPage();
    await speaker.goto(`${URL_DECK}#/speaker/m2-hero-trap`);
    await settleSpeaker(speaker);
    await deck.bringToFront();
    await deck.keyboard.press('Space');
    await expect(speaker.locator('#sp-counter')).toContainText('step 1/3');
    await expect(speaker.locator('#sp-current .slide')).toHaveAttribute('data-stage', 'hero');
  });
});

// ------------------------------------------------------------------------------------------ script book

test.describe('script book', () => {
  test('R opens the script book in a new window at the current slide; the deck stays on screen', async ({ page }) => {
    await open(page, '#/m2-governance-matrix');
    const [book] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('r')]);
    await book.waitForSelector('.bk-slide');
    await expect(book.locator('#bk-m2-governance-matrix')).toHaveClass(/is-target/);
    expect(await activeId(page)).toBe('m2-governance-matrix');
    await expect(page.locator('#presentation')).toBeVisible();
    await book.close();
  });

  test('renders every slide with outline, badges, room-sees and beats; deep link scrolls to a slide', async ({ page }) => {
    await open(page, '#/script/m4-prompt-debugger');
    await page.waitForSelector('.bk-slide');
    expect(await page.locator('.bk-slide').count()).toBe(TOTAL);
    expect(await page.locator('.bk-outline a').count()).toBe(TOTAL);
    expect(await page.locator('.bk-module').count()).toBe(7);
    await expect(page.locator('#bk-m4-prompt-debugger')).toHaveClass(/is-target/);
    expect(await page.locator('#bk-m4-prompt-debugger').evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(260);
    await expect(page.locator('#bk-m4-prompt-debugger details.drawer')).toHaveAttribute('open', '');
    await expect(page.locator('#bk-m2-governance-matrix .presenter-badge')).toContainText(presenterLabel('John'));
  });

  test('search filters slides, highlights matches, and Escape clears it', async ({ page }) => {
    await open(page, '#/script');
    await page.waitForSelector('.bk-slide');
    // a phrase that only one slide's script carries ("weak-form" is on two since the full script landed)
    await page.locator('#bk-q').fill('circuit breaker');
    await expect.poll(() => page.locator('.bk-slide:not([hidden])').count()).toBe(1);
    expect(await page.locator('.bk-slide:not([hidden]) mark').count()).toBeGreaterThan(0);
    await expect(page.locator('#bk-count')).toContainText(`1 of ${TOTAL} slides`);
    await page.locator('#bk-q').press('Escape');
    await expect.poll(() => page.locator('.bk-slide:not([hidden])').count()).toBe(TOTAL);
    await page.locator('#bk-q').fill('qqqqzzzz');
    await expect(page.locator('#bk-none')).toBeVisible();
  });

  test('#/book is an alias and print styles hide the controls', async ({ page }) => {
    await open(page, '#/book');
    await page.waitForSelector('.bk-slide');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.bk-top')).toBeHidden();
    await expect(page.locator('.bk-outline')).toBeHidden();
    await expect(page.locator('.bk-slide').first()).toBeVisible();
  });

  test('switching routes in one window swaps the view cleanly', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (location.hash = '#/script'));
    await page.waitForSelector('.bk-slide');
    await expect(page.locator('#presentation')).toBeHidden();
    await page.evaluate(() => (location.hash = '#/2'));
    await expect(page.locator('#presentation')).toBeVisible();
    await expect.poll(() => activeIndex(page)).toBe(1);
    await expect(page.locator('#book-root')).toBeEmpty();
  });
});

// ------------------------------------------------------------------------------------------ build output

test.describe('generated speaker script', () => {
  const md = readFileSync(`${ROOT}docs/SPEAKER-SCRIPT.md`, 'utf8');

  test('has one heading per slide, cues as blockquotes and no pacing language', () => {
    const headings = md.match(/^### \[SLIDE \d+\] \u00b7 [a-z0-9-]+ \u00b7 .+$/gm) ?? [];
    expect(headings).toHaveLength(TOTAL);
    expect(headings[0]).toBe('### [SLIDE 1] \u00b7 m1-cover \u00b7 Scaling the Agentic SDLC');
    expect(md).toContain('> **[CUE]** ASK:');
    expect(md, 'a single presenter needs no whole-line speaker tags').not.toMatch(/^\[[^\]\n]+\]\s*$/m);
    expect(md).not.toMatch(/\b(wpm|words per minute|countdown|minutes? left|behind schedule)\b/i);
  });
});

// A second context proves state does not leak between visitors (theme lives in localStorage).
test('a fresh browser context starts in the light theme at slide 1', async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await activeIndex(page)).toBe(0);
  await ctx.close();
});

// ------------------------------------------------------------------------------------------ authored-slide gaps

test.describe('Authored-slide edge cases', () => {
  test('all 25 slides fit all three target viewports in both themes', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const issues: string[] = [];
    for (const [width, height] of [[1920, 1080], [1536, 864], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await press(page, 't');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const slide of deck.slides) {
          await page.evaluate((id) => { location.hash = `#/${id}`; }, slide.id);
          await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-id', slide.id);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const clipped = await page.locator('#stage .slide.active').evaluate((root) => {
            const stage = root.getBoundingClientRect();
            const bad: string[] = [];
            if (stage.left < -1 || stage.top < -1 || stage.right > innerWidth + 1 || stage.bottom > innerHeight + 1) bad.push('stage outside viewport');
            for (const el of root.querySelectorAll('*')) {
              if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) continue;
              if (r.left < stage.left - 1 || r.top < stage.top - 1 || r.right > stage.right + 1 || r.bottom > stage.bottom + 1) {
                bad.push(`${el.tagName}: ${(el.textContent ?? '').trim().slice(0, 50)}`);
              }
            }
            return bad;
          });
          issues.push(...clipped.map((x) => `${width}x${height} ${theme} ${slide.id}: ${x}`));
        }
      }
    }
    expect(issues).toEqual([]);
  });

  test('every diagram highlight group clears after pointer leave and keyboard blur', async ({ page }) => {
    await open(page);
    for (const id of ['m2-supply-chain', 'm6-two-computers']) {
      await page.evaluate((id) => { location.hash = `#/${id}`; }, id);
      const slide = page.locator('#stage .slide.active');
      await expect(slide).toHaveAttribute('data-id', id);
      const words0 = await activeWords(page);
      const groups = await slide.locator('[data-hl]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-hl') as string))]);
      expect(groups.length).toBeGreaterThan(1);
      for (const group of groups) {
        const nodes = slide.locator(`[data-hl="${group}"]`);
        await nodes.first().hover();
        await expect(slide).toHaveClass(/has-hl/);
        await expect(slide.locator('.is-hl')).toHaveCount(await nodes.count());
        await page.mouse.move(1, 1);
        await expect(slide).not.toHaveClass(/has-hl/);
        await expect(slide.locator('.is-hl')).toHaveCount(0);
        await nodes.first().focus();
        await expect(slide.locator('.is-hl')).toHaveCount(await nodes.count());
        await page.locator('#deck').focus();
        await expect(slide).not.toHaveClass(/has-hl/);
        await expect(slide.locator('.is-hl')).toHaveCount(0);
      }
      expect(await activeWords(page)).toBe(words0);
    }
  });

  test('all five steppers clamp oversized deep links and walk back to a neutral state', async ({ page }) => {
    const cases = [
      ['m1-attention-economy', 'orchestrated'], ['m2-hero-trap', 'advisory'],
      ['m2-three-roles', 'operations'], ['m3-metric-evolution', 'gen3'], ['m5-whack-a-mole', 'qa'],
    ] as const;
    await open(page);
    for (const [id, last] of cases) {
      await page.evaluate((id) => { location.hash = `#/${id}/99`; }, id);
      const slide = page.locator('#stage .slide.active');
      await expect(slide).toHaveAttribute('data-id', id);
      await expect(slide).toHaveAttribute('data-stage', last);
      await expect(slide).toHaveAttribute('data-step', '3');
      const words0 = await activeWords(page);
      await page.locator('#deck').focus();
      await press(page, 'PageUp', 'PageUp', 'PageUp');
      await expect(slide).toHaveAttribute('data-step', '0');
      await expect(slide).toHaveAttribute('data-stage', '');
      await expect(slide.locator('.is-dim, .is-stage, .is-past')).toHaveCount(0);
      await expect(slide.locator('[data-stage][aria-pressed="true"]')).toHaveCount(0);
      await press(page, 'PageDown', 'PageDown', 'PageDown');
      await expect(slide).toHaveAttribute('data-stage', last);
      expect(await activeWords(page)).toBe(words0);
      await page.reload();
      await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-step', '3');
    }
  });

  test('all six scorecard rows support independent keyboard placement and mirror to a read-only preview', async ({ page }) => {
    await open(page, '#/m2-governance-matrix');
    const [speaker] = await Promise.all([page.waitForEvent('popup'), press(page, 's')]);
    await expect(speaker.locator('#sp-title')).toContainText('Governance readiness');
    const rows = ['audit-trails', 'agent-access-controls', 'approval-workflows', 'data-boundaries', 'cost-controls', 'compliance-reporting'];
    const tiers = ['none', 'basic', 'enterprise'];
    for (const [i, row] of rows.entries()) {
      const tier = tiers[i % tiers.length] as string;
      const cell = page.locator(`.slide.active tr[data-row="${row}"] td[data-tier="${tier}"]`);
      await cell.focus();
      await cell.press('Enter');
      await expect(cell).toHaveText('\u25cf');
      await cell.press('Space');
      await expect(cell).toHaveText('\u25cb');
      await cell.press('Enter');
      await expect(cell).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.slide.active .place[aria-pressed="true"]')).toHaveCount(i + 1);
      await expect(speaker.locator(`#sp-current tr[data-row="${row}"]`)).toHaveAttribute('data-tier', tier);
    }
    await expect(speaker.locator('#sp-current .slide')).toHaveAttribute('inert', '');
    await expect(speaker.locator('#sp-current .place[tabindex="0"]')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/m3-productivity-paradox'; });
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-id', 'm3-productivity-paradox');
    await page.evaluate(() => { location.hash = '#/m2-governance-matrix'; });
    await expect(page.locator('.slide.active .place[aria-pressed="true"]')).toHaveCount(6);
    await speaker.close();
  });

  test('gate reset clears chips, target tiles, axes and the synchronized preview', async ({ page }) => {
    await open(page, '#/m3-gate-matrix');
    const [speaker] = await Promise.all([page.waitForEvent('popup'), press(page, 's')]);
    await expect(speaker.locator('#sp-title')).toContainText('Which gate catches it');
    const slide = page.locator('#stage .slide.active');
    for (let n = 1; n <= 4; n++) {
      await press(page, String(n));
      const targetCount = n === 1 ? 2 : 1;
      await expect(slide.locator('.gate.is-target')).toHaveCount(targetCount);
      await expect(speaker.locator('#sp-current .gate.is-target')).toHaveCount(targetCount);
      await press(page, '0');
      await expect(slide).toHaveAttribute('data-active', '');
      await expect(slide).toHaveAttribute('data-how', '');
      await expect(slide).toHaveAttribute('data-who', '');
      await expect(slide.locator('.is-target, .is-dim, .chip[aria-pressed="true"]')).toHaveCount(0);
      await expect(speaker.locator('#sp-current .gate.is-target')).toHaveCount(0);
    }
    await speaker.close();
  });

  test('all 16 prompt lever combinations update cost and geometry and remount without duplicate handlers', async ({ page }) => {
    await open(page, '#/m4-prompt-debugger');
    // Recorded model outputs, not vendor prices; pure-model math has separate unit coverage.
    const costs = ['41.01', '25.46', '25.04', '20.68', '37.59', '22.04', '24.08', '19.72', '7.29', '5.48', '5.43', '4.92', '6.89', '5.08', '5.32', '4.81'];
    const levers = ['scope', 'prefix', 'tools', 'routing'];
    let previous = 0;
    for (let bits = 0; bits < 16; bits++) {
      for (let bit = 0; bit < 4; bit++) {
        if (!((previous ^ bits) & (1 << bit))) continue;
        if (bit % 2 === 0) await page.locator(`.slide.active [data-lever="${levers[bit]}"]`).press('Enter');
        else await press(page, String(bit + 1));
      }
      previous = bits;
      const flags = levers.map((_, bit) => bits & (1 << bit) ? '1' : '0').join('');
      await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-levers', flags);
      await expect(page.locator('.slide.active [data-cost-now]')).toHaveText(`$${costs[bits]}`);
      for (const [bit, lever] of levers.entries()) {
        await expect(page.locator(`.slide.active [data-lever="${lever}"]`)).toHaveAttribute('aria-checked', String(Boolean(bits & (1 << bit))));
      }
      const width = await page.locator('.slide.active [data-seg]').evaluateAll((els) => els.reduce((sum, el) => sum + Number(el.getAttribute('width')), 0));
      expect(width).toBeCloseTo(Number(costs[bits]) / 41.01 * 1200, 0);
      expect(await activeWords(page)).toBe(55);
    }
    await expect(page.locator('.slide.active [data-floor]')).toHaveClass(/is-reached/);
    await page.evaluate(() => { location.hash = '#/script/m4-prompt-debugger'; });
    await expect(page.locator('#book')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/m4-prompt-debugger'; });
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-levers', '0000');
    await page.locator('.slide.active [data-lever="scope"]').press('Space');
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-levers', '1000');
  });

  test('quiz picks clear before reveal, tallies clamp at both bounds, and revealed answers are immutable', async ({ page }) => {
    await open(page, '#/m7-quiz');
    const slide = page.locator('#stage .slide.active');
    const words0 = await activeWords(page);
    await press(page, '2', '0', '4');
    await expect(slide.locator('.opt.is-picked')).toHaveCount(0);
    await expect(slide).toHaveAttribute('data-active', '0');
    const tally = slide.locator('[data-q="board-metric"] .tally').first();
    await tally.click({ modifiers: ['Shift'] });
    await expect(tally.locator('i')).toHaveCount(0);
    for (let i = 0; i < 14; i++) await tally.click();
    await expect(tally.locator('i')).toHaveCount(12);
    for (let i = 0; i < 14; i++) await tally.click({ modifiers: ['Shift'] });
    await expect(tally.locator('i')).toHaveCount(0);
    await page.locator('#deck').focus();
    await press(page, '2', 'Enter', '1', 'Enter', '2', 'Enter');
    await expect(slide.locator('.q.is-revealed')).toHaveCount(3);
    await expect(slide.locator('.opt.is-picked.is-correct')).toHaveCount(3);
    for (const key of ['board-metric', 'cost-lever', 'gate-choice']) {
      await slide.locator(`[data-q="${key}"] .pick`).nth(2).click();
      await expect(slide.locator(`[data-q="${key}"]`)).toHaveAttribute('data-state', 'revealed');
    }
    await page.locator('#deck').focus();
    await press(page, '1', '0', 'Enter', 'Enter');
    await expect(slide.locator('.opt.is-picked.is-correct')).toHaveCount(3);
    await expect(slide.locator('.opt.is-wrong')).toHaveCount(0);
    await expect(slide).toHaveAttribute('data-active', '2');
    expect(await activeId(page)).toBe('m7-quiz');
    expect(await activeWords(page)).toBe(words0);
  });

  test('all 25 scripts, voices and citations agree across Script Book, Speaker View and Read-Along', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, '#/script');
    const checkScript = async (container: ReturnType<Page['locator']>, id: string) => {
      const slide = deck.slides.find((s) => s.id === id)!;
      expect(await container.locator('.beat-say > p').allTextContents()).toEqual(slide.script.filter((b) => b.t === 'say').map((b) => b.text));
      expect(await container.locator('.beat-cue > p').allTextContents()).toEqual(slide.script.filter((b) => b.t === 'cue').map((b) => b.text));
    };
    for (const slide of deck.slides) {
      const article = page.locator(`#bk-${slide.id}`);
      await checkScript(article, slide.id);
      await expect(article.locator('.presenter-badge')).toContainText(presenterLabel(slide.presenter));
      expect(await article.locator('.sources a').evaluateAll((els) => els.map((el) => el.getAttribute('href')))).toEqual(slide.sources.map((s) => s.url));
    }
    await page.locator('#bk-theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    for (const [i, slide] of deck.slides.entries()) {
      await page.evaluate((id) => { location.hash = `#/speaker/${id}`; }, slide.id);
      await expect(page.locator('#sp-title')).toHaveText(`${i + 1}. ${slide.title}`);
      await checkScript(page.locator('#sp-script'), slide.id);
      await expect(page.locator('#sp-badge')).toContainText(presenterLabel(slide.presenter));
      expect(await page.locator('#sp-sources .sources a').evaluateAll((els) => els.map((el) => el.getAttribute('href')))).toEqual(slide.sources.map((s) => s.url));
      await expect(page.locator('#sp-current .slide')).toHaveAttribute('data-id', slide.id);
      if (i < deck.slides.length - 1) await expect(page.locator('#sp-next-frame .slide')).toHaveAttribute('data-id', deck.slides[i + 1]!.id);
      else await expect(page.locator('#sp-next-frame')).toBeEmpty();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await press(page, 't');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => { location.hash = '#/m1-cover'; });
    await expect(page.locator('#presentation')).toBeVisible();
    await press(page, 'm');
    for (const slide of deck.slides) {
      await page.evaluate((id) => { location.hash = `#/${id}`; }, slide.id);
      await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-id', slide.id);
      await checkScript(page.locator('#ra-body'), slide.id);
      await expect(page.locator('#ra-badge')).toContainText(presenterLabel(slide.presenter));
    }
    await page.evaluate(() => { location.hash = '#/script/m7-open-floor'; });
    await expect(page.locator('#book')).toBeVisible();
    await expect(page.locator('#readalong')).toBeHidden();
    await expect(page.locator('#readalong')).toHaveAttribute('inert', '');
    await page.evaluate(() => { location.hash = '#/m7-open-floor'; });
    await expect(page.locator('#presentation')).toBeVisible();
    await expect(page.locator('#readalong')).toBeHidden();
  });

  test('Script Book search treats markup and regex characters literally and outline navigation clears filters', async ({ page }) => {
    await open(page, '#/script');
    const search = page.locator('#bk-q');
    for (const query of ['[', '(', '.*', '<img src=x onerror=alert(1)>', 'x'.repeat(2048)]) {
      await search.fill(query);
      await expect(page.locator('#book img')).toHaveCount(0);
      const visible = await page.locator('.bk-slide:not([hidden])').count();
      const expected = await page.locator('.bk-slide').evaluateAll((els, q) =>
        els.filter((el) => (el.textContent ?? '').toLowerCase().includes(q.toLowerCase())).length, query);
      expect(visible).toBe(expected);
    }
    await search.fill('   ');
    await expect(page.locator('.bk-slide:not([hidden])')).toHaveCount(TOTAL);
    await search.fill('circuit breaker');
    await expect(page.locator('.bk-slide:not([hidden])')).toHaveCount(1);
    await page.locator('.bk-outline a[data-go="m7-open-floor"]').click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.bk-slide:not([hidden])')).toHaveCount(TOTAL);
    await expect(page.locator('#bk-m7-open-floor')).toHaveClass(/is-target/);
    await expect(page.locator('#book mark')).toHaveCount(0);
  });

  test('postMessage synchronization and theme toggles still work with storage and BroadcastChannel unavailable', async ({ page, context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } });
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    });
    await open(page);
    await press(page, 't');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const [speaker] = await Promise.all([page.waitForEvent('popup'), press(page, 's')]);
    await expect(speaker.locator('#sp-title')).toHaveText('1. Scaling the Agentic SDLC');
    await expect(speaker.locator('#sp-sync')).toHaveText('Synchronized with the audience deck');
    await page.locator('#deck').focus();
    await press(page, 'ArrowRight');
    await expect(speaker.locator('#sp-title')).toHaveText('2. Greenfield demos hit a cliff');
    await speaker.locator('#sp-next').click();
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-id', 'm1-attention-economy');
    await speaker.keyboard.press('t');
    await expect(speaker.locator('html')).toHaveAttribute('data-theme', 'dark');
    await speaker.close();
  });

  test('all three resource links really open their exact destinations without replacing or exposing the deck', async ({ page, context }) => {
    const urls = [
      'https://danielmeppiel.github.io/agentic-sdlc-handbook/',
      'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ai/',
      'https://docs.github.com/en/code-security',
    ];
    // Exercise actual navigation, but never depend on or send requests to external websites.
    await context.route(/^https?:\/\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>QA resource destination</title>' }));
    await open(page, '#/m7-open-floor');
    const links = page.locator('.slide.active .band .lico');
    for (const [i, url] of urls.entries()) {
      const [popup] = await Promise.all([page.waitForEvent('popup'), links.nth(i).click()]);
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toBe(url);
      await expect(popup.evaluate(() => window.opener)).resolves.toBeNull();
      expect(await activeId(page)).toBe('m7-open-floor');
      await popup.close();
    }
  });

  test('keyboard navigation continues from a clicked stage', async ({ page }) => {
    await open(page, '#/m2-hero-trap');
    await page.locator('.slide.active .step[data-stage="coe"]').click();
    await expect(page.locator('.slide.active')).toHaveAttribute('data-stage', 'coe');
    await page.locator('#deck').focus();
    await press(page, 'ArrowRight');
    await expect(page.locator('.slide.active')).toHaveAttribute('data-stage', 'advisory');
  });

  test('Enter activates a focused quiz option without revealing its answer', async ({ page }) => {
    await open(page, '#/m7-quiz');
    const question = page.locator('.slide.active [data-q="board-metric"]');
    const answer = question.locator('.pick').nth(1);
    await answer.focus();
    await page.keyboard.press('Enter');
    await expect(question).toHaveAttribute('data-state', 'picked');
    await expect(answer).toHaveAttribute('aria-checked', 'true');
  });

  test('Open deck in Script Book follows the currently selected slide', async ({ page }) => {
    await open(page, '#/script/m1-cover');
    await page.locator('.bk-outline a[data-go="m7-open-floor"]').click();
    const [deckPage] = await Promise.all([page.waitForEvent('popup'), page.locator('#bk-deck').click()]);
    await deckPage.waitForSelector('#stage .slide.active');
    await expect(deckPage.locator('#stage .slide.active')).toHaveAttribute('data-id', 'm7-open-floor');
    await deckPage.close();
  });

  test('executive ROI scorecard and six dimensions of maturity render their six rows, diagrams, and numbered badges', async ({ page }) => {
    await open(page, '#/m4-executive-roi');
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-layout', 'roi-scorecard');
    await expect(page.locator('#stage .slide.active tbody tr')).toHaveCount(6);
    await expect(page.locator('#stage .slide.active [data-diagram="roi-trace"] svg')).toBeVisible();
    await expect(page.locator('#stage .slide.active .band')).toContainText('ROI & trace');

    await open(page, '#/m7-maturity-dimensions');
    await expect(page.locator('#stage .slide.active')).toHaveAttribute('data-layout', 'maturity-dimensions');
    await expect(page.locator('#stage .slide.active tbody tr')).toHaveCount(6);
    await expect(page.locator('#stage .slide.active [data-diagram="maturity-radar"] svg')).toBeVisible();
    const dims = await page.locator('#stage .slide.active tbody th').allTextContents();
    expect(dims).toEqual([
      'Delivery practices',
      'Agent-ready codebase',
      'Agent utilization',
      'Operations',
      'Team autonomy & enablement',
      'Responsible AI',
    ]);
  });
});
