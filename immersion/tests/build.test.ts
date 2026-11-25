import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from '../scripts/build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A tiny deck, written to a temp dir, to drive the build without touching the committed content.
const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const slideSrc = (over: Record<string, unknown> = {}) => ({
  id: 'one',
  moduleCode: 'M1',
  presenter: 'John',
  layout: 'cover-hero-grid',
  purpose: 'Show the build.',
  kicker: 'Kicker',
  title: 'Title one',
  blocks: [],
  script: [{ t: 'say', text: 'Narration that shares nothing with the screen at all.' }],
  sources: [],
  ...over,
});

const contentSrc = (slides: unknown[]) =>
  `export const deck = ${JSON.stringify({
    meta: {
      title: 'Test deck', subtitle: 'sub', event: 'Event', session: 'session',
      presenters: { John: { name: 'Test Presenter', org: 'Microsoft' } },
    },
    modules: [{ code: 'M1', title: 'One', summary: 's' }],
    slides,
    glossary: [],
  })};\n`;

let tmp = '';
const content = (slides: unknown[]): string => {
  tmp = mkdtempSync(join(tmpdir(), 'immersion-build-'));
  const file = join(tmp, 'content.mjs');
  writeFileSync(file, contentSrc(slides));
  return file;
};
afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

describe('scripts/build.mjs: the dual compiler', () => {
  beforeAll(() => {
    // bundling twice with esbuild is quick, but give a cold machine room
  }, 60_000);

  it('builds the committed deck in memory: ok, zero findings, 25 pre-rendered slides, 25 script sections', async () => {
    const r = await build({ write: false, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.html.match(/<section class="slide/g)).toHaveLength(25);
    expect(r.script.match(/^### \[SLIDE \d+\]/gm)).toHaveLength(25);
    expect(r.wrote).toEqual([]);
  });

  it('strict mode also passes the committed deck', async () => {
    const r = await build({ write: false, quiet: true, strict: true });
    expect(r.ok).toBe(true);
  });

  it('dist/index.html and docs/SPEAKER-SCRIPT.md are fresh (run `npm run build` if this fails)', async () => {
    const r = await build({ write: false, quiet: true });
    expect(readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8')).toBe(r.html);
    expect(readFileSync(join(ROOT, 'docs', 'SPEAKER-SCRIPT.md'), 'utf8')).toBe(r.script);
  });

  it('the output is deterministic: no clock, same bytes on every build', async () => {
    const a = await build({ write: false, quiet: true });
    const b = await build({ write: false, quiet: true });
    expect(b.html).toBe(a.html);
    expect(a.html).toMatch(/<meta name="generator" content="ai-sdlc-immersion-deck [0-9a-f]{12}">/);
  });

  it('the page is self-contained: inline CSS and one inline runtime, no external requests', async () => {
    const { html } = await build({ write: false, quiet: true });
    expect(html).toMatch(/<style>[\s\S]+--azure[\s\S]+<\/style>/);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/(?!(github|learn|docs|arxiv|danielmeppiel|www\.w3\.org|www\.microsoft\.com|cloud\.google\.com))/i);
    expect(html.length).toBeGreaterThan(100_000);
  });

  it('writes both outputs once and leaves unchanged files alone (idempotent)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'immersion-out-'));
    try {
      const outHtml = join(dir, 'dist', 'index.html');
      const outScript = join(dir, 'docs', 'SPEAKER-SCRIPT.md');
      const first = await build({ outHtml, outScript, quiet: true });
      expect(first.wrote.sort()).toEqual([outHtml, outScript].sort());
      const stamp = statSync(outHtml).mtimeMs;
      await new Promise((r) => setTimeout(r, 30));
      const second = await build({ outHtml, outScript, quiet: true });
      expect(second.wrote).toEqual([]);
      expect(statSync(outHtml).mtimeMs).toBe(stamp);
      expect(readFileSync(outScript, 'utf8')).toBe(first.script);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds alternative content through the same pipeline (both the Node and the browser bundle)', async () => {
    const r = await build({ write: false, quiet: true, contentEntry: content([slideSrc()]) });
    expect(r.ok).toBe(true);
    expect(r.html).toContain('<title>Test deck \u00b7 Event</title>');
    expect(r.html.match(/<section class="slide/g)).toHaveLength(1);
    expect(r.html, 'the runtime bundle carries the override, not the real deck').toContain('Title one');
    expect(r.html).not.toContain('Scaling the Agentic SDLC');
  });
});

describe('build policy: warnings report, strict fails, structure always fails', () => {
  it('a slide over the 58-word target is a warning: reported, build still succeeds', async () => {
    quiet();
    const r = await build({ write: false, quiet: true, contentEntry: content([slideSrc({ lead: filler(60) })]) });
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.rule)).toContain('words.target');
    expect(r.failures).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('--strict fails on that same warning and writes nothing', async () => {
    quiet();
    const dir = mkdtempSync(join(tmpdir(), 'immersion-out-'));
    try {
      const outHtml = join(dir, 'index.html');
      const r = await build({ outHtml, outScript: join(dir, 's.md'), quiet: true, strict: true, contentEntry: content([slideSrc({ lead: filler(60) })]) });
      expect(r.ok).toBe(false);
      expect(r.failures.map((f) => f.rule)).toContain('words.target');
      expect(r.wrote).toEqual([]);
      expect(() => statSync(outHtml)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a content-rule error (past the 90-word ceiling) is reported without --strict, and fails with it', async () => {
    quiet();
    const src = content([slideSrc({ lead: filler(95) })]);
    const lax = await build({ write: false, quiet: true, contentEntry: src });
    expect(lax.ok).toBe(true);
    expect(lax.findings.map((f) => f.rule)).toContain('words.ceiling');
    const strict = await build({ write: false, quiet: true, strict: true, contentEntry: src });
    expect(strict.ok).toBe(false);
  });

  it('hollow containers and lifted narration are caught by --strict', async () => {
    quiet();
    const hollow = slideSrc({ blocks: [{ kind: 'card', head: 'Hollow', body: 'Too short.' }] });
    const lifted = slideSrc({
      id: 'two',
      title: 'Greenfield demos hit a cliff',
      blocks: [{ kind: 'card', head: 'Brownfield', body: 'Unwritten conventions overflow any 200K token window; rework estimated high.' }],
      script: [{ t: 'say', text: 'Remember that unwritten conventions overflow any 200K token window rework estimated high today.' }],
    });
    const r = await build({ write: false, quiet: true, strict: true, contentEntry: content([hollow, lifted]) });
    expect(r.ok).toBe(false);
    const rules = r.failures.map((f) => f.rule);
    expect(rules).toContain('container.hollow');
    expect(rules).toContain('seen-said.verbatim');
  });

  it('structure errors fail even without --strict', async () => {
    quiet();
    const dup = await build({ write: false, quiet: true, contentEntry: content([slideSrc(), slideSrc()]) });
    expect(dup.ok).toBe(false);
    expect(dup.failures.map((f) => f.rule)).toContain('structure.duplicate-id');
    const silent = await build({ write: false, quiet: true, contentEntry: content([slideSrc({ script: [{ t: 'cue', kind: 'next', text: 'only a cue' }] })]) });
    expect(silent.ok).toBe(false);
    expect(silent.failures.map((f) => f.rule)).toContain('structure.script');
  });
});

describe('command line', () => {
  it('rejects unknown options with exit code 2 and a usage line', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--nope'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option/);
    expect(r.stderr).toMatch(/usage: node scripts\/build\.mjs \[--strict\]/);
  });

  it('exits 0 on a clean strict build of the committed deck', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--strict'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/25 slides \u00b7 7 modules/);
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
  });
});
