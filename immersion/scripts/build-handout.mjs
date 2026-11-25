#!/usr/bin/env node
/**
 * Customer handout generator: one PDF that pairs every slide with companion notes.
 *
 *   node scripts/build-handout.mjs                     write docs/Scaling-the-Agentic-SDLC.pdf
 *   node scripts/build-handout.mjs --check             run the content guards only (no browser)
 *   node scripts/build-handout.mjs --html out.html     also keep the print HTML
 *   node scripts/build-handout.mjs --text out.txt      also keep the extracted text (for the sanitize scan)
 *
 *   HANDOUT_CONFIDENTIAL_TERMS=term1,term2             extra confidential terms the guards must reject (none are stored here)
 *
 * What it does
 *   1. loads the deck model from src/ (the same bundle the live build uses) and compiles the live deck's own
 *      stylesheet, so each slide is the real pre-rendered <section class="slide">, scaled as vector art;
 *   2. checks scripts/handout/notes.mjs against the deck (coverage, banned phrases, grounded numbers);
 *   3. composes one HTML document: 25 slide pages and 2 glossary pages, US Letter portrait;
 *   4. in Chromium, paginates the glossary into columns, then fails the build if ANY page overflows;
 *   5. prints to PDF (tagged, with an outline), and fails unless the PDF has exactly one page per page.
 *
 * It reads src/ and scripts/handout/ and writes only the files named above. It never touches dist/,
 * docs/SPEAKER-SCRIPT.md or src/content, so `npm run build:strict` and `npm test` are unaffected.
 *
 * Exit codes: 0 ok | 1 a guard or a layout gate failed | 2 usage.
 */

import { build as esbuild } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { composeDocument, fixLabel, plain } from './handout/compose.mjs';
import { GLOSSARY_CATEGORIES, GLOSSARY_FOOTNOTE, GLOSSARY_INTRO, NOTES } from './handout/notes.mjs';
import { checkDocumentText, checkNotes } from './handout/verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_OUT = join(ROOT, 'docs', 'Scaling-the-Agentic-SDLC.pdf');

/**
 * Confidential terms (comma-separated, from HANDOUT_CONFIDENTIAL_TERMS) that the guards must reject in addition to the
 * built-in rules. The repository stores no such term: whoever knows one supplies it when building.
 */
const confidentialTerms = () =>
  (process.env.HANDOUT_CONFIDENTIAL_TERMS ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);

// --------------------------------------------------------------------------- sources of truth

/** The deck model and renderers, bundled for Node exactly the way scripts/build.mjs does it. */
async function loadModel(root) {
  const out = await esbuild({
    stdin: {
      contents: [
        "export { deck } from './src/content';",
        "export { renderSlideSection } from './src/shell/render';",
        "export { calibrate, costOf, ALL_OFF, ALL_ON, formatUsd } from './src/widgets/tokenModel';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'handout-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** The deck's own stylesheet, compiled from src/styles so the handout never depends on a stale dist/. */
async function loadCss(root) {
  const out = await esbuild({
    entryPoints: [join(root, 'src', 'styles', 'index.css')],
    bundle: true,
    write: false,
    logLevel: 'silent',
    loader: { '.css': 'css' },
  });
  return out.outputFiles[0].text;
}

/** The slide-15 cost model as the table a reader can check, computed from the same params the slide runs. */
function assumptionsFor(model, slide) {
  const p = slide.widget.params;
  const m = model.calibrate(p);
  const int = (n) => Math.round(n).toLocaleString('en-US');
  const pct = (n) => `${Math.round(n * 100)}%`;
  const usd = model.formatUsd;
  const off = model.costOf(m, model.ALL_OFF);
  const on = model.costOf(m, model.ALL_ON);
  return {
    inputs: [
      ['Context payload', `${int(p.contextLines.off)} \u2192 ${int(p.contextLines.on)} lines, ${p.tokensPerLine} tokens per line`],
      ['Standing prompt', `${int(p.systemTokens)} tokens, always loaded`],
      ['Prefix cache', `${pct(p.cacheHit.off)} \u2192 ${pct(p.cacheHit.on)} of the repeated prefix cached`],
      ['Tool definitions', `${p.tools.off} \u2192 ${p.tools.on} tools, ${p.tokensPerTool} tokens each`],
      ['Turns', `${p.turns.off} frontier \u2192 ${p.turns.plan} frontier planner + ${p.turns.exec} mid-tier executors`],
      ['Task work', `${int(p.work.inputTokens)} input + ${int(p.work.outputTokens)} output tokens, identical in every state`],
    ],
    relative: {
      output: p.outputPriceRatio.toFixed(2),
      cached: p.cachedPriceRatio.toFixed(2),
      mid: m.midRatio.toFixed(2),
      on: usd(p.targets.on),
      off: usd(p.targets.off),
      unit: usd(m.usdPerToken * 1e6),
    },
    spend: {
      head: ['Where the dollars go', 'Context', 'Tools', 'Task work', 'Total'],
      rows: [
        ['Levers off', usd(off.context), usd(off.tools), usd(off.work), usd(off.total)],
        ['Levers on', usd(on.context), usd(on.tools), usd(on.work), usd(on.total)],
      ],
    },
  };
}

// --------------------------------------------------------------------------- in-browser helpers (serialised into the page)

/** Distribute the glossary stage into six columns (3 per page) by real layout, then balance the last page. */
function paginateGlossary() {
  const stage = document.getElementById('hx-gl-stage');
  const blocks = Array.from(stage.children);
  const cols = Array.from(document.querySelectorAll('.hx-gl-col'));
  const titles = {};
  for (const b of blocks) if (b.classList.contains('hx-gl-h')) titles[b.dataset.cat] = b.querySelector('span').textContent;
  const heading = (cat, cont) => {
    const h = document.createElement('p'); // not a heading element: only the first occurrence of a category belongs in the outline
    h.className = 'hx-gl-h is-cont';
    h.dataset.cat = cat;
    h.innerHTML = `<span>${titles[cat]}</span><em>${cont}</em>`;
    return h;
  };
  const used = (col) => {
    const last = col.lastElementChild;
    return last ? last.offsetTop + last.offsetHeight : 0;
  };

  /** Greedy fill of `list` into `target` columns; `limit(col)` is the usable height. Returns blocks that did not fit. */
  const pack = (list, target, limit) => {
    let ci = 0;
    let i = 0;
    while (i < list.length) {
      if (ci >= target.length) return list.slice(i);
      const col = target[ci];
      const b = list[i];
      const isHead = b.classList.contains('hx-gl-h');
      const group = isHead && list[i + 1] ? [b, list[i + 1]] : [b];
      const lead = !isHead && col.children.length === 0 ? heading(b.dataset.cat, 'continued') : null;
      if (lead) col.appendChild(lead);
      for (const el of group) col.appendChild(el);
      if (used(col) <= limit(col) + 0.5) {
        i += group.length;
        continue;
      }
      for (const el of group) col.removeChild(el);
      if (lead) col.removeChild(lead);
      if (col.children.length === 0) return list.slice(i); // a single block taller than a column
      ci += 1;
    }
    return [];
  };

  const rest = pack(blocks, cols, (c) => c.clientHeight);
  if (rest.length) {
    // diagnostics: how tall is everything in one column of the real width, against what the six columns can hold?
    const probe = document.createElement('div');
    probe.className = 'hx-gl-col';
    probe.style.cssText = `position:absolute;left:-9999px;top:0;height:auto;overflow:visible;width:${cols[0].clientWidth}px`;
    document.body.appendChild(probe);
    for (const col of cols) for (const el of Array.from(col.children)) probe.appendChild(el.cloneNode(true));
    for (const el of rest) probe.appendChild(el.cloneNode(true));
    const needed = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    const capacity = cols.reduce((n, c) => n + c.clientHeight, 0);
    return { ok: false, left: rest.length, total: blocks.length, needed, capacity };
  }

  // Balance the last page: re-pack its blocks into three even columns instead of one full and two part-empty ones.
  const lastCols = cols.slice(3);
  const lastBlocks = lastCols.flatMap((c) => Array.from(c.children)).filter((el) => !el.classList.contains('is-cont'));
  if (lastBlocks.length) {
    const total = lastCols.reduce((n, c) => n + used(c), 0);
    for (const c of lastCols) c.textContent = '';
    let cap = Math.ceil(total / 3);
    for (let tries = 0; tries < 40; tries += 1, cap += 6) {
      for (const c of lastCols) c.textContent = '';
      if (pack(lastBlocks.slice(), lastCols, () => cap).length === 0) break;
    }
  }
  const perColumn = cols.map((c) => c.querySelectorAll('.hx-gl').length);
  stage.remove();
  return { ok: true, perColumn, entries: blocks.filter((b) => b.classList.contains('hx-gl')).length };
}

/** Fit the notes: for each slide page, the largest body size (14px down to 11.5px) at which the notes zone does not overflow. */
function fitNotes() {
  const sizes = [14, 13.75, 13.5, 13.25, 13, 12.75, 12.5, 12.25, 12, 11.75, 11.5];
  const chosen = [];
  for (const pg of document.querySelectorAll('.hx-slide-page')) {
    const zone = pg.querySelector('.hx-zone');
    let picked = null;
    for (const s of sizes) {
      pg.style.setProperty('--hx-fs', `${s}px`);
      if (zone.scrollHeight <= zone.clientHeight + 0.5) {
        picked = s;
        break;
      }
    }
    if (picked === null) pg.style.setProperty('--hx-fs', `${sizes[sizes.length - 1]}px`);
    chosen.push([Number(pg.id.slice(1)), picked ?? sizes[sizes.length - 1]]);
  }
  return chosen;
}

/** Layout gates: nothing overflows a page, a notes zone or a glossary column, and nothing leaves the margins. */
function measureGates() {
  const problems = [];
  const round = (n) => Math.round(n * 10) / 10;
  for (const pg of document.querySelectorAll('.hx-page')) {
    if (pg.scrollHeight > pg.clientHeight + 0.5) problems.push(`${pg.id}: content is ${round(pg.scrollHeight - pg.clientHeight)}px taller than the page`);
    const zone = pg.querySelector('.hx-zone');
    if (zone && zone.scrollHeight > zone.clientHeight + 0.5) problems.push(`${pg.id}: notes overflow their zone by ${round(zone.scrollHeight - zone.clientHeight)}px even at the smallest body size`);
    for (const col of pg.querySelectorAll('.hx-gl-col')) {
      if (col.scrollHeight > col.clientHeight + 0.5) problems.push(`${pg.id}: a glossary column overflows by ${round(col.scrollHeight - col.clientHeight)}px`);
    }
    const pr = pg.getBoundingClientRect();
    for (const el of pg.querySelectorAll('.hx-zone *, .hx-srcs *, .hx-gl-col *, .hx-foot *, .hx-gl-head *')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.right > pr.right - 14 + 0.5 || r.left < pr.left + 14 - 0.5 || r.bottom > pr.bottom - 6 + 0.5) {
        problems.push(`${pg.id}: <${el.tagName.toLowerCase()}> "${(el.textContent || '').trim().slice(0, 40)}" leaves the page margins`);
        break;
      }
    }
    const shot = pg.querySelector('.hx-shot');
    if (shot) {
      const sr = shot.getBoundingClientRect();
      if (Math.abs(sr.width - 760) > 0.5 || Math.abs(sr.height - 427.5) > 0.5) problems.push(`${pg.id}: slide frame is ${round(sr.width)}x${round(sr.height)}, expected 760x427.5`);
      const cr = pg.querySelector('.hx-canvas').getBoundingClientRect();
      if (Math.abs(cr.width - 760) > 0.6 || Math.abs(cr.height - 427.5) > 0.6) problems.push(`${pg.id}: scaled slide is ${round(cr.width)}x${round(cr.height)}, expected 760x427.5`);
    }
  }
  return problems;
}

/** Text of each page, split into what is inside the slide frames and what is not. */
function pageTexts() {
  const inSlides = [];
  const outside = [];
  const lines = [];
  for (const pg of document.querySelectorAll('.hx-page')) {
    const shot = pg.querySelector('.hx-shot');
    if (shot) inSlides.push(shot.innerText);
    const clone = pg.cloneNode(true);
    clone.querySelector('.hx-shot')?.remove();
    document.body.appendChild(clone);
    clone.style.cssText = 'position:absolute;left:-9999px;top:0';
    outside.push(clone.innerText);
    clone.remove();
    lines.push(`# ${pg.getAttribute('aria-label') || pg.id}`);
    for (const el of pg.querySelectorAll('.hx-title, .hx-purpose, .hx-bar, .hx-cols p, .hx-cols li, .hx-prose p, .hx-prose li, .hx-block, .hx-tile, .hx-faq-i, .hx-reflect, .hx-srcs li, .hx-gl, .hx-gl-h, .hx-gl-foot')) {
      const t = el.innerText.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
    if (shot) lines.push(`[slide] ${shot.innerText.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return { inSlides: inSlides.join('\n'), outside: outside.join('\n'), text: lines.join('\n') };
}

// --------------------------------------------------------------------------- the build

const countPdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;

export async function buildHandout(opts = {}) {
  const root = opts.root ?? ROOT;
  const out = opts.out ?? DEFAULT_OUT;
  const say = opts.quiet ? () => {} : (m) => console.log(m);
  const fail = (msgs) => {
    for (const m of msgs) console.error(`  \u2717 ${m}`);
    console.error(`FAILED: ${msgs.length} problem(s). Nothing was written.`);
    return { ok: false, problems: msgs };
  };
  if (opts.force && resolve(out) === DEFAULT_OUT) return fail(['--force may not write the flagship PDF; pass --out to a scratch path']);

  const model = await loadModel(root);
  const { deck } = model;

  // 1. content guards (no browser needed)
  const terms = confidentialTerms();
  const checked = checkNotes({ deck, notes: NOTES, sourceLabel: fixLabel, terms });
  if (checked.errors.length) return fail(checked.errors);
  say(`notes ok: ${deck.slides.length} slides, every number grounded, no banned phrases`);
  if (opts.check) return { ok: true };

  // 2. compose
  const css = await loadCss(root);
  const printCss = readFileSync(join(HERE, 'handout', 'print.css'), 'utf8');
  const total = deck.slides.length;
  const glossaryPages = [total + 1, total + 2];
  const slideNumberOf = (id) => {
    const i = deck.slides.findIndex((s) => s.id === id);
    return i < 0 ? 0 : i + 1;
  };
  const modules = deck.modules;
  const ctx = {
    deck,
    meta: deck.meta,
    modules,
    notes: NOTES,
    glossaryPages,
    totalPages: total + 2,
    pagesOfModule: (code) => {
      const ns = deck.slides.map((s, i) => (s.moduleCode === code ? i + 1 : 0)).filter(Boolean);
      return [ns[0], ns[ns.length - 1]];
    },
    assumptions: assumptionsFor(model, deck.slides.find((s) => s.widget?.kind === 'prompt-debugger')),
  };
  const slides = deck.slides.map((s, i) => model.renderSlideSection(s, i + 1, { active: true }));
  const html = composeDocument({
    ctx,
    css,
    printCss,
    slides,
    glossary: {
      categories: GLOSSARY_CATEGORIES,
      entries: deck.glossary,
      slideNumberOf,
      page: { intro: GLOSSARY_INTRO, footnote: GLOSSARY_FOOTNOTE, count: deck.glossary.length },
    },
  });

  // 3. lay it out in Chromium and gate it
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const external = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      external.push(url);
      return route.abort();
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready);

    const gloss = await page.evaluate(paginateGlossary);
    if (!gloss.ok) {
      return fail([`glossary does not fit on two pages: ${gloss.left} of ${gloss.total} blocks left over (needs ${gloss.needed}px of column height, the six columns hold ${gloss.capacity}px)`]);
    }
    say(`glossary: ${gloss.entries} entries -> columns [${gloss.perColumn.join(', ')}]`);

    const fitted = await page.evaluate(fitNotes);
    const sizes = fitted.map(([, s]) => s);
    say(`notes type: ${Math.min(...sizes)}px to ${Math.max(...sizes)}px (${fitted.filter(([, s]) => s <= 11.75).map(([n]) => n).join(', ') || 'none'} at or below 11.75px)`);

    const problems = [...(await page.evaluate(measureGates))];
    if (external.length) problems.push(`external requests were attempted: ${external.slice(0, 3).join(', ')}`);

    const texts = await page.evaluate(pageTexts);
    problems.push(...checkDocumentText({ textOutsideSlides: texts.outside, textInSlides: texts.inSlides, deck, terms }));
    if (/[A-Za-z]:\\Users\\/i.test(html)) problems.push('the print HTML contains an absolute local path');
    if (problems.length && !opts.force) return fail(problems);
    if (problems.length) for (const p of problems) console.warn(`  ! (forced) ${p}`);
    else say('layout gates ok: no page, notes zone or glossary column overflows; every frame is 760 x 427.5');

    const pdf = await page.pdf({
      width: '8.5in',
      height: '11in',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      tagged: true,
      outline: true,
    });
    const pages = countPdfPages(pdf);
    if (pages !== total + 2) return fail([`the PDF has ${pages} pages, expected ${total + 2} (a page spilled over or went missing)`]);

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pdf);
    say(`wrote ${out} (${(pdf.length / 1024).toFixed(0)} KB, ${pages} pages)`);
    if (opts.html) writeFileSync(opts.html, await page.content(), 'utf8');
    if (opts.text) writeFileSync(opts.text, texts.text, 'utf8');
    return { ok: true, pages, bytes: pdf.length, out };
  } finally {
    await browser.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--force') opts.force = true; // development only: emit the PDF even if a layout gate fails (never to docs/)
    else if (a === '--out') opts.out = resolve(argv[++i] ?? '');
    else if (a === '--html') opts.html = resolve(argv[++i] ?? '');
    else if (a === '--text') opts.text = resolve(argv[++i] ?? '');
    else {
      console.error(`unknown option: ${a}\nusage: node scripts/build-handout.mjs [--check] [--out file.pdf] [--html file.html] [--text file.txt]`);
      process.exit(2);
    }
  }
  try {
    const r = await buildHandout(opts);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

// `plain` is re-exported for tests that want the same text normalisation the guards use.
export { plain };
