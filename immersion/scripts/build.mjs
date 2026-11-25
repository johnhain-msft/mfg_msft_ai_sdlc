#!/usr/bin/env node
/**
 * Dual compiler: one canonical content source, two outputs.
 *
 *   node scripts/build.mjs             build dist/index.html and docs/SPEAKER-SCRIPT.md
 *   node scripts/build.mjs --strict    ...and fail on ANY rules.ts finding (warnings included)
 *
 * What it does
 *   1. bundles the TypeScript content + validators for Node (esbuild) and loads them;
 *   2. validates the deck (src/content/rules.ts): structure always fails the build; the audience
 *      word budget, hollow-container floor, anchors, seen/said separation and diagram text size
 *      are reported as warnings, and fail the build under --strict;
 *   3. pre-renders every <section class="slide" id="sN" data-id="..."> into #stage, so static
 *      tools (deck-density.py, slide-review) read exactly the slides the room sees;
 *   4. bundles the browser runtime (audience deck, speaker view, script book, widgets) and the
 *      CSS, and inlines both into one self-contained dist/index.html;
 *   5. generates docs/SPEAKER-SCRIPT.md from the same model, then cross-checks both
 *      artifacts against the model (the static twin of deck-density.py);
 *   6. writes only files whose bytes changed, and never embeds a clock.
 *
 * There is no pacing math anywhere: no words-per-minute, no minutes budget, no countdown.
 *
 * Exit codes: 0 clean | 1 build failed or --strict findings | 2 usage.
 */

import { build as esbuild } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Findings that mean the build itself is inconsistent: they fail even without --strict. */
const STRUCTURAL = (rule) => rule.startsWith('structure.') || ['twin.words', 'twin.anchors', 'twin.containers', 'twin.missing'].includes(rule);

/**
 * Re-point `src/content/index.ts` at another module (tests and content rehearsals use this).
 * Applies to both the Node bundle and the browser bundle, so the two can never disagree.
 */
function contentOverride(root, contentEntry) {
  const real = new Set([join(root, 'src', 'content', 'index.ts'), join(root, 'src', 'content')].map((p) => resolve(p).toLowerCase()));
  return {
    name: 'content-override',
    setup(b) {
      b.onResolve({ filter: /content(\/index)?(\.ts)?$/ }, (args) => {
        if (args.kind !== 'import-statement' || !args.path.startsWith('.')) return undefined;
        const target = resolve(args.resolveDir, args.path).toLowerCase().replace(/\.ts$/, '');
        const hit = [...real].some((r) => r.replace(/\.ts$/, '') === target || r.replace(/\.ts$/, '') === target.replace(/[\\/]index$/, ''));
        return hit ? { path: resolve(contentEntry) } : undefined;
      });
    },
  };
}

async function bundleNode(root, contentEntry) {
  const out = await esbuild({
    entryPoints: [join(root, 'src', 'build', 'entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    plugins: contentEntry ? [contentOverride(root, contentEntry)] : [],
  });
  const text = out.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
}

async function bundleBrowser(root, contentEntry) {
  const js = await esbuild({
    entryPoints: [join(root, 'src', 'shell', 'main.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
    plugins: contentEntry ? [contentOverride(root, contentEntry)] : [],
  });
  const css = await esbuild({
    entryPoints: [join(root, 'src', 'styles', 'index.css')],
    bundle: true,
    write: false,
    logLevel: 'silent',
    loader: { '.css': 'css' },
  });
  return { js: js.outputFiles[0].text, css: css.outputFiles[0].text };
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  writeFileSync(path, text, 'utf8');
  return true;
}

const pct = (n) => n.toFixed(1).padStart(5);

/**
 * Build both artifacts.
 * @param {object} [opts]
 * @param {string}  [opts.root]          project root (default: the repository root)
 * @param {boolean} [opts.strict]        fail on any content finding, warnings included
 * @param {string}  [opts.contentEntry]  alternative content module (same exports as src/content/index.ts)
 * @param {string}  [opts.outHtml]       default <root>/dist/index.html
 * @param {string}  [opts.outScript]     default <root>/docs/SPEAKER-SCRIPT.md
 * @param {boolean} [opts.write]         false = build in memory only
 * @param {boolean} [opts.quiet]
 * @returns {Promise<{ok: boolean, findings: object[], failures: object[], html: string, script: string, wrote: string[]}>}
 */
export async function build(opts = {}) {
  const root = opts.root ?? ROOT;
  const strict = Boolean(opts.strict);
  const write = opts.write !== false;
  const say = opts.quiet ? () => {} : (m) => console.log(m);
  const outHtml = opts.outHtml ?? join(root, 'dist', 'index.html');
  const outScript = opts.outScript ?? join(root, 'docs', 'SPEAKER-SCRIPT.md');

  const mod = await bundleNode(root, opts.contentEntry);
  const { deck, checkDeck, checkArtifacts, formatFinding, renderDocument, renderPresenterScript } = mod;

  const report = checkDeck(deck);
  const { js, css } = await bundleBrowser(root, opts.contentEntry);
  const buildId = createHash('sha256').update(JSON.stringify(deck)).update(css).update(js).digest('hex').slice(0, 12);
  const html = renderDocument({ deck, css, js, buildId });
  const script = renderPresenterScript(deck);
  const findings = [...report.findings, ...checkArtifacts(deck, html, script)];
  const failures = findings.filter((f) => STRUCTURAL(f.rule) || strict);

  for (const f of findings) {
    const line = formatFinding(f);
    if (failures.includes(f)) console.error(strict && !STRUCTURAL(f.rule) ? `${line}  [strict]` : line);
    else console.warn(line);
  }

  say('  #  id                        words anchors boxes  said8% said5%');
  for (const m of report.metrics) {
    say(`${String(m.n).padStart(3)}  ${m.id.padEnd(25)} ${String(m.words).padStart(5)} ${String(m.anchors).padStart(7)} ${String(m.containers).padStart(5)}  ${pct(m.lift8)}  ${pct(m.lift5)}${m.exempt ? '  exempt' : ''}`);
  }
  const maxWords = Math.max(...report.metrics.map((m) => m.words));
  say(`${deck.slides.length} slides \u00b7 ${deck.modules.length} modules \u00b7 ${deck.glossary.length} glossary terms \u00b7 max ${maxWords} on-screen words \u00b7 ${findings.length} finding(s)${strict ? ' \u00b7 strict' : ''}`);

  if (failures.length) {
    console.error(`FAILED: ${failures.length} finding(s)${strict ? ' (strict: warnings fail too)' : ''}. Nothing was written.`);
    return { ok: false, findings, failures, html, script, wrote: [] };
  }

  const wrote = [];
  if (write) {
    if (writeIfChanged(outHtml, html)) wrote.push(outHtml);
    if (writeIfChanged(outScript, script)) wrote.push(outScript);
    say(wrote.length ? `wrote ${wrote.join(' and ')} (${(html.length / 1024).toFixed(0)} KB html, ${(script.length / 1024).toFixed(0)} KB script)` : 'outputs already up to date');
  }
  return { ok: true, findings, failures, html, script, wrote };
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--strict']);
  const bad = argv.filter((a) => !known.has(a));
  if (bad.length) {
    console.error(`unknown option(s): ${bad.join(' ')}\nusage: node scripts/build.mjs [--strict]`);
    process.exit(2);
  }
  try {
    const result = await build({ strict: argv.includes('--strict') });
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
