#!/usr/bin/env node
/**
 * presentation/build.mjs — deck builder for the AI SDLC Orchestrator briefing. Zero dependencies.
 *
 * Inputs
 *   content/slides/NN-*.md    slide sources: file front matter (section, day), slides split on `---`,
 *                             per-slide attributes as leading `@key: value` lines, then a Markdown body
 *   content/script/NN-*.md    speaker script: `## [slide-id] Title` sections; prose is what you say,
 *                             `DO:` `SHOW:` `ASK:` `PAUSE:` `DEMO:` `CHECK:` `TIME:` `CLICK:` lines are cues,
 *                             `> …` is the bridge to the next slide, `SOURCE:` starts a source list
 *   content/diagrams/*.{html,svg}
 *                             diagram fragments (inline SVG/HTML) embedded with `:::diagram name`.
 *                             `{{data-uri:path/from/repo/root}}` inside a fragment is replaced by a base64
 *                             data URI of that file, so the deck stays one self-contained file.
 *   content/agenda.json       timed agenda shown in the deck and used for the running clock
 *   src/shell.html, src/styles.css, src/app.js   the runtime shell, inlined
 *
 * Outputs
 *   dist/index.html           one self-contained file. Every slide is pre-rendered as a
 *                             <section class="slide …"> inside #stage (for static readers such as
 *                             deck-density.py) AND the same slides ship as JSON in #deck-data (for the
 *                             runtime and for the portfolio importer). app.js replaces the pre-rendered
 *                             sections with sections built from the JSON, so #stage never holds duplicates.
 *   ../presenter/PRESENTER-SCRIPT.md
 *                             the read-aloud presenter script, generated from the same sources
 *
 * Usage
 *   node presentation/build.mjs                     build both outputs
 *   node presentation/build.mjs --check             validate only, write nothing
 *   node presentation/build.mjs --check --strict    validate only; warnings fail the run as well
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SLIDES_DIR = join(HERE, 'content', 'slides');
const SCRIPT_DIR = join(HERE, 'content', 'script');
const DIAGRAM_DIR = join(HERE, 'content', 'diagrams');
const AGENDA_FILE = join(HERE, 'content', 'agenda.json');
const SRC = join(HERE, 'src');
const DIST = join(HERE, 'dist');
const OUT_HTML = join(DIST, 'index.html');
const OUT_SCRIPT = join(ROOT, 'presenter', 'PRESENTER-SCRIPT.md');

// Where repository-relative links (specs/…, plan.md) point when the deck is opened on its own.
const SOURCE = { repo: 'johnhain-msft/mfg_msft_ai_sdlc', branch: 'main' };

// Content gates. deck-density.py and slide-review are authoritative; these keep the feedback loop fast.
const WORD_BUDGET = 58;          // visible words per slide (deck-density's own budget is 60, ceiling 90)
const WORD_CEILING = 90;
const MAX_ANCHORS = 14;          // deck-density: more competing blocks than this is a failure
const CONTAINER_BODY_MIN = 7;    // heading-bearing card/step/band/nopub/tile/panel/box needs 7..16 body words
const CONTAINER_BODY_MAX = 16;
const MIN_DIAGRAM_FONT = 22;     // inline SVG text must be readable from the back of the room
const SPOKEN_WPM = 150;

const LAYOUTS = new Set(['default', 'title', 'section', 'lab', 'break', 'quiz', 'end', 'cards', 'diagram', 'timeline', 'decision', 'media', 'split']);

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--check', '--strict']);
const badFlags = argv.filter((a) => !KNOWN_FLAGS.has(a));
if (badFlags.length) {
  console.error(`Unknown argument: ${badFlags.join(' ')}\nUsage: node presentation/build.mjs [--check] [--strict]`);
  process.exit(2);
}
const CHECK_ONLY = argv.includes('--check');
const STRICT = argv.includes('--strict');
const problems = [];
const warnings = [];

// ------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const attr = (s) => esc(s).replace(/`/g, '&#96;');

/** Markdown inline markers removed: what a screen reader, a document title or a script heading should say. */
function plain(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/\*([^*]+?)\*/g, '$1')
    .trim();
}

function parseFrontMatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(end + 5) };
}

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** True when `p` resolves inside the repository root (never lets a content file read outside it). */
function insideRoot(p) {
  const rel = relative(ROOT, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

// ------------------------------------------------------------------------------------------------
// Inline Markdown
// ------------------------------------------------------------------------------------------------
function renderInline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = esc(out);
  out = out.replace(/\[\[([^\]]+)\]\]/g, '<kbd>$1</kbd>');
  out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(>])\*([^*\s][^*]*?[^*\s]|[^*\s])\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${attr(u)}" target="_blank" rel="noopener">${t}</a>`);
  out = out.replace(/\{\{([^}]+)\}\}/g, '<span class="muted">$1</span>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Decorative and functional SVG vocabulary (no text, so none of it counts towards the word budget)
// ------------------------------------------------------------------------------------------------
const ICONS = {
  key: '<circle cx="16" cy="24" r="9"/><path d="M25 24h19M37 24v7M43 24v5"/><circle cx="16" cy="24" r="2.5" fill="currentColor" stroke="none"/>',
  shield: '<path d="M24 5l15 6v11c0 10-6.5 17.5-15 21C15.5 39.5 9 32 9 22V11z"/><path d="M17 24l5 5 9-10"/>',
  lock: '<rect x="10" y="21" width="28" height="21" rx="4"/><path d="M16 21v-6a8 8 0 0 1 16 0v6"/><circle cx="24" cy="31" r="2.6" fill="currentColor" stroke="none"/>',
  doc: '<path d="M13 5h16l9 9v29H13z"/><path d="M29 5v9h9M19 23h13M19 30h13M19 37h8"/>',
  box: '<rect x="6" y="9" width="36" height="30" rx="6" stroke-dasharray="5 4"/><circle cx="24" cy="24" r="6"/><circle cx="24" cy="24" r="1.8" fill="currentColor" stroke="none"/>',
  flow: '<circle cx="9" cy="24" r="4.5"/><circle cx="39" cy="24" r="4.5"/><path d="M14 24h17M26 18l7 6-7 6"/>',
};
const CALLOUT_ICONS = {
  note: '<circle cx="14" cy="14" r="11"/><path d="M14 12.5v7M14 8v1"/>',
  tip: '<path d="M9 17.5c-2.2-1.6-3.7-3.8-3.7-6.8a8.7 8.7 0 0 1 17.4 0c0 3-1.5 5.2-3.7 6.8V21H9z"/><path d="M10.5 24.5h7"/>',
  warn: '<path d="M14 3l12 21H2z"/><path d="M14 11v6M14 20.5v.5"/>',
};
const svgIcon = (name, cls) => `<svg class="${cls}" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
const calloutIcon = (kind) => `<svg class="callout-icon" viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${CALLOUT_ICONS[kind] || CALLOUT_ICONS.note}</svg>`;

const GLYPHS = {
  // eight repositories around the orchestrator hub: six upstreams flow in, two downstreams receive
  fleet: `<svg class="glyph-svg" viewBox="0 0 640 640" width="640" height="640" aria-hidden="true" focusable="false">
<circle class="g-ring" cx="320" cy="320" r="268"/>
<circle class="g-ring g-ring-inner" cx="320" cy="320" r="176"/>
<g class="g-edges">
<path d="M194 83L320 320"/><path d="M107 158L320 320"/><path d="M58 262L320 320"/><path d="M58 378L320 320"/><path d="M107 482L320 320"/><path d="M194 557L320 320"/>
<path class="g-edge-out" d="M320 320L538 240"/><path class="g-edge-out" d="M320 320L538 400"/>
</g>
<g class="g-dots"><circle cx="257" cy="202" r="7"/><circle cx="214" cy="239" r="7"/><circle cx="189" cy="291" r="7"/><circle cx="189" cy="349" r="7"/><circle cx="214" cy="401" r="7"/><circle cx="257" cy="439" r="7"/><circle cx="446" cy="274" r="7"/><circle cx="446" cy="366" r="7"/></g>
<g class="g-nodes">
<circle class="g-node" cx="194" cy="83" r="26"/><circle class="g-node" cx="107" cy="158" r="26"/><circle class="g-node" cx="58" cy="262" r="26"/><circle class="g-node" cx="58" cy="378" r="26"/><circle class="g-node" cx="107" cy="482" r="26"/><circle class="g-node" cx="194" cy="557" r="26"/>
<circle class="g-hub" cx="320" cy="320" r="58"/><circle class="g-hub-core" cx="320" cy="320" r="18"/>
<circle class="g-node-bg" cx="572" cy="228" r="36"/><circle class="g-node-bg" cx="572" cy="412" r="36"/>
<circle class="g-node g-node-out" cx="572" cy="228" r="36"/><circle class="g-node g-node-out" cx="572" cy="412" r="36"/>
</g>
<text class="g-label g-label-mono" x="320" y="408" font-size="22" text-anchor="middle">sdlc.yaml</text>
<text class="g-label" x="628" y="178" font-size="22" text-anchor="end">ai_asset_management</text>
<text class="g-label" x="628" y="478" font-size="22" text-anchor="end">portfolio</text>
</svg>`,
};

// ------------------------------------------------------------------------------------------------
// Block Markdown with containers
// ------------------------------------------------------------------------------------------------
const SELF_CLOSING = new Set(['diagram', 'spacer', 'glyph', 'spec']);
const MARKERS = new Set(['col', 'card']);

function isOpener(l) {
  const m = l.match(/^:::\s*([a-z-]+)(.*)$/);
  if (!m) return null;
  return { name: m[1], rest: m[2].trim() };
}

function collectContainer(lines, start) {
  let depth = 1;
  const inner = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const open = isOpener(l);
    if (open && !SELF_CLOSING.has(open.name) && !MARKERS.has(open.name)) depth++;
    else if (/^:::\s*$/.test(l)) {
      depth--;
      if (depth === 0) return { inner, next: i + 1 };
    }
    inner.push(l);
  }
  problems.push(`Unclosed container starting at: ${lines[start]}`);
  return { inner, next: i };
}

function splitMarkers(inner, marker) {
  const parts = [];
  let cur = null;
  let depth = 0;
  for (const l of inner) {
    const open = isOpener(l);
    if (open && open.name === marker && depth === 0) {
      cur = { title: open.rest, lines: [] };
      parts.push(cur);
      continue;
    }
    if (open && !SELF_CLOSING.has(open.name) && !MARKERS.has(open.name)) depth++;
    else if (/^:::\s*$/.test(l)) depth--;
    if (!cur) { cur = { title: '', lines: [] }; parts.push(cur); }
    cur.lines.push(l);
  }
  return parts;
}

function renderList(lines, ctx) {
  const items = lines.map((l) => {
    const m = l.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] };
  });
  let idx = 0;
  function build(level, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    while (idx < items.length && items[idx].indent >= level) {
      const it = items[idx];
      if (it.indent > level) it.indent = level;
      idx++;
      const liClass = ctx.steps ? ' class="fragment"' : '';
      let li = `<li${liClass}>${renderInline(it.text)}`;
      if (idx < items.length && items[idx].indent > level) {
        li += build(items[idx].indent, items[idx].ordered);
      }
      html += li + '</li>';
    }
    return html + `</${tag}>`;
  }
  return build(items[0].indent, items[0].ordered);
}

function renderTable(lines) {
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const [head, sep2, ...body] = rows;
  const aligns = (sep2 || []).map((s) => (/^:-+:$/.test(s) ? 'center' : /-+:$/.test(s) ? 'right' : 'left'));
  const th = head.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${renderInline(c)}</th>`).join('');
  const tb = body.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${aligns[i] || 'left'}">${renderInline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

const diagramFonts = new Map(); // diagram name -> linted once per fragment

// Optional, named adaptations for a file embedded with {{data-uri:path|name}}. The source file is never modified.
const EMBED_TRANSFORMS = {
  // The production walkthrough draws its caption panel at 16–17px on a 1440px canvas. Placed as tall as the slide
  // allows, those labels land near 13px on screen. Only the small text sizes are enlarged (to 22px, which lands
  // at ~17px with the standard slide header); the frames, timing and wording are untouched.
  // The longest enlarged caption (131 characters) now runs under the step-pager bars, which sit at y=940 right
  // beside the caption baseline at y=950, so the bars move to the empty strip below the caption (y=964, still
  // inside the 978px canvas). Layout is otherwise unchanged.
  'legible-captions': (svg) => {
    let n = 0;
    let pager = 0;
    const out = svg
      .replace(/(<text\b[^>]*?\bfont-size=")(?:16|17)(")/g, (_, a, b) => { n++; return `${a}22${b}`; })
      .replace(/(<rect\b[^>]*?\by=")940(" width="30" height="6")/g, (_, a, b) => { pager++; return `${a}964${b}`; });
    if (n === 0) warnings.push('legible-captions: no 16px or 17px text found to enlarge in the embedded SVG');
    if (pager !== 16) warnings.push(`legible-captions: expected 16 pager bars (8 tracks + 8 active markers) to move, moved ${pager}`);
    return out;
  },
};

function loadDiagram(name) {
  for (const ext of ['.html', '.svg']) {
    const p = join(DIAGRAM_DIR, name + ext);
    if (!existsSync(p)) continue;
    // comments are stripped: an HTML comment inside the embedded JSON would end the <script> data early
    let html = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/\{\{data-uri:([^}\s|]+)(?:\|([\w-]+))?\}\}/g, (_, rel, transform) => {
      const target = resolve(ROOT, rel);
      if (!insideRoot(target) || !existsSync(target)) {
        problems.push(`Diagram "${name}": {{data-uri:${rel}}} does not point at a file inside the repository`);
        return '';
      }
      if (transform && !EMBED_TRANSFORMS[transform]) {
        problems.push(`Diagram "${name}": unknown embed transform "${transform}"`);
        return '';
      }
      const mime = /\.svg$/i.test(rel) ? 'image/svg+xml' : /\.png$/i.test(rel) ? 'image/png' : /\.jpe?g$/i.test(rel) ? 'image/jpeg' : 'application/octet-stream';
      let bytes = readFileSync(target);
      if (transform) bytes = Buffer.from(EMBED_TRANSFORMS[transform](bytes.toString('utf8')), 'utf8');
      return `data:${mime};base64,${bytes.toString('base64')}`;
    });
    if (!diagramFonts.has(name)) {
      diagramFonts.set(name, true);
      lintDiagramFonts(name, html);
    }
    return html.trim();
  }
  problems.push(`Diagram not found: ${name}`);
  return `<div class="diagram-missing">diagram "${esc(name)}" missing</div>`;
}

/** Every <text>/<tspan> of an inline SVG must declare a font size the room can read. */
function lintDiagramFonts(name, html) {
  const svgs = html.match(/<svg\b[\s\S]*?<\/svg>/g) || [];
  for (const svg of svgs) {
    for (const m of svg.matchAll(/<(text|tspan)\b([^>]*)>/g)) {
      const fs = m[2].match(/\bfont-size\s*=\s*"([\d.]+)"/);
      if (!fs) {
        if (m[1] === 'text') warnings.push(`Diagram "${name}": a <text> element has no explicit font-size attribute`);
        continue;
      }
      if (Number(fs[1]) < MIN_DIAGRAM_FONT) warnings.push(`Diagram "${name}": <${m[1]}> font-size ${fs[1]} is below ${MIN_DIAGRAM_FONT}`);
    }
  }
}

function renderQuiz(inner, ctx) {
  let q = '';
  const opts = [];
  let answer = '';
  let expl = '';
  for (const l of inner) {
    const mq = l.match(/^Q:\s*(.*)$/);
    const mo = l.match(/^[-*]\s+([A-F])\)\s*(.*)$/);
    const ma = l.match(/^Answer:\s*([A-F])\s*(?:[—–-]\s*(.*))?$/);
    if (mq) q = mq[1];
    else if (mo) opts.push({ key: mo[1], text: mo[2] });
    else if (ma) { answer = ma[1]; expl = ma[2] || ''; }
    else if (l.trim() && answer) expl += ' ' + l.trim();
  }
  if (!q || opts.length < 2 || !answer) problems.push(`Quiz in slide "${ctx.slideId}" needs Q:, at least two options and an Answer:`);
  ctx.quizCount = (ctx.quizCount || 0) + 1;
  const qid = `${ctx.slideId}-q${ctx.quizCount}`;
  const options = opts.map((o) => `<button type="button" class="quiz-option" data-key="${o.key}"><span class="quiz-key" aria-hidden="true">${o.key}</span><span>${renderInline(o.text)}</span></button>`).join('');
  return `<div class="quiz" data-answer="${answer}" id="${qid}"><p class="quiz-q">${renderInline(q)}</p><div class="quiz-options">${options}</div><p class="quiz-expl" hidden><strong>Answer: ${answer}.</strong> ${renderInline(expl.trim())}</p></div>`;
}

function renderStats(inner) {
  const tiles = inner.filter((l) => l.trim()).map((l) => {
    const [value, label, ...note] = l.split('|').map((s) => s.trim());
    return `<li class="stat"><div class="stat-value">${renderInline(value || '')}</div><div class="stat-label">${renderInline(label || '')}</div>${note.length ? `<div class="stat-note">${renderInline(note.join(' | '))}</div>` : ''}</li>`;
  });
  return `<ul class="stats">${tiles.join('')}</ul>`;
}

function renderTimeline(inner, ctx) {
  const rows = inner.filter((l) => l.trim()).map((l) => {
    const [date, text, state] = l.split('|').map((s) => s.trim());
    const cls = state ? ` tl-${state.toLowerCase().replace(/[^a-z]+/g, '-')}` : '';
    return `<li class="tl-row${cls}${ctx.steps ? ' fragment' : ''}"><div class="tl-date">${renderInline(date)}</div><div class="tl-text">${renderInline(text || '')}</div></li>`;
  });
  return `<ol class="timeline">${rows.join('')}</ol>`;
}

function renderBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const lang = fence[1] || 'text';
      out.push(`<pre class="code" data-lang="${attr(lang)}"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // a bare ":::" that closes nothing (for example after a self-closing :::diagram) is ignored
    if (/^:::\s*$/.test(line)) { i++; continue; }

    const open = isOpener(line);
    if (open) {
      const { name, rest } = open;
      if (SELF_CLOSING.has(name)) {
        i++;
        if (name === 'diagram') {
          const [dname, ...cap] = rest.split(/\s+/);
          const caption = cap.join(' ');
          out.push(`<figure class="diagram" data-diagram="${attr(dname)}">${loadDiagram(dname)}${caption ? `<figcaption>${renderInline(caption)}</figcaption>` : ''}</figure>`);
          ctx.diagrams.push(dname);
        } else if (name === 'spacer') {
          out.push('<div class="spacer"></div>');
        } else if (name === 'glyph') {
          if (!GLYPHS[rest]) problems.push(`Unknown glyph "${rest}" in slide ${ctx.slideId}`);
          out.push(`<div class="glyph" aria-hidden="true">${GLYPHS[rest] || ''}</div>`);
        } else if (name === 'spec') {
          // a link to a document in this repository; app.js points it at GitHub, the importer at the hosted reader
          out.push(`<p class="spec-ref"><a href="${attr(rest)}" target="_blank" rel="noopener">${esc(rest)}</a></p>`);
          ctx.links.push(rest);
        }
        continue;
      }
      const { inner, next } = collectContainer(lines, i);
      i = next;
      switch (name) {
        case 'cols': {
          const cols = splitMarkers(inner, 'col');
          const style = rest ? ` style="grid-template-columns:${attr(rest)}"` : '';
          // a column or card title is the slide's first subheading, so it is an h2 (the slide title is the h1); styles.css sizes it
          out.push(`<div class="cols"${style}>${cols.map((c) => `<div class="col">${c.title ? `<h2>${renderInline(c.title)}</h2>` : ''}${renderBlocks(c.lines, ctx)}</div>`).join('')}</div>`);
          break;
        }
        case 'cards': {
          const cards = splitMarkers(inner, 'card');
          const n = rest ? ` data-count="${attr(rest)}"` : '';
          out.push(`<div class="cards"${n}>${cards.map((c, k) => {
            const m = c.title.match(/^\[([^\]]+)\]\s*(.*)$/);
            const flags = m ? m[1].split(/\s+/) : [];
            const tone = flags.find((f) => ['good', 'warn', 'bad', 'purple', 'muted'].includes(f));
            const icon = (flags.find((f) => f.startsWith('icon=')) || '').slice(5);
            if (icon && !ICONS[icon]) problems.push(`Unknown card icon "${icon}" in slide ${ctx.slideId}`);
            const title = m ? m[2] : c.title;
            return `<div class="card${tone ? ` card-${tone}` : ''}${ctx.steps ? ' fragment' : ''}" data-i="${k + 1}">${icon && ICONS[icon] ? svgIcon(icon, 'card-icon') : ''}${title ? `<h2>${renderInline(title)}</h2>` : ''}${renderBlocks(c.lines, ctx)}</div>`;
          }).join('')}</div>`);
          break;
        }
        case 'callout': {
          const [kind, ...t] = rest.split(/\s+/);
          const title = t.join(' ');
          out.push(`<div class="callout callout-${attr(kind || 'note')}"><div class="callout-title">${calloutIcon(kind)}<span>${renderInline(title || kind || 'Note')}</span></div>${renderBlocks(inner, ctx)}</div>`);
          break;
        }
        case 'steps': out.push(`<div class="steps">${renderBlocks(inner, { ...ctx, steps: true })}</div>`); break;
        case 'labtile': {
          const [num, dur, path] = (inner.find((l) => l.trim()) || '').split('|').map((s) => s.trim());
          if (path) ctx.links.push(path);
          out.push(`<div class="lab-tile"><div class="lab-num">${esc(num || '')}</div><div class="lab-dur">${renderInline(dur || '')}</div>${path ? `<div class="lab-path">${esc(path)}</div>` : ''}</div><!--/lab-tile-->`);
          break;
        }
        case 'quiz': out.push(renderQuiz(inner, ctx)); break;
        case 'stats': out.push(renderStats(inner)); break;
        case 'timeline': out.push(renderTimeline(inner, ctx)); break;
        case 'aside': out.push(`<aside class="aside">${renderBlocks(inner, ctx)}</aside>`); break;
        case 'center': out.push(`<div class="center">${renderBlocks(inner, ctx)}</div>`); break;
        case 'big': out.push(`<div class="big">${renderBlocks(inner, ctx)}</div>`); break;
        case 'chips': {
          const chips = inner.filter((l) => l.trim()).map((l) => `<li class="chip${ctx.steps ? ' fragment' : ''}">${renderInline(l.replace(/^[-*]\s+/, ''))}</li>`);
          out.push(`<ul class="chips">${chips.join('')}</ul>`);
          break;
        }
        case 'kv': {
          const rows = inner.filter((l) => l.trim()).map((l) => {
            const at = l.indexOf('|');
            const k = at === -1 ? l : l.slice(0, at);
            const v = at === -1 ? '' : l.slice(at + 1);
            return `<div class="kv-row${ctx.steps ? ' fragment' : ''}"><dt class="kv-k">${renderInline(k.trim())}</dt><dd class="kv-v">${renderInline(v.trim())}</dd></div>`;
          });
          out.push(`<dl class="kv">${rows.join('')}</dl>`);
          break;
        }
        case 'ledger': {
          // a real list of real buttons: the <li> stays a list item for assistive technology, the <button> inside it is the step
          // control (native focus, Enter and Space)
          const rows = inner.filter((l) => l.trim()).map((l, idx) => {
            const at = l.indexOf('|');
            return `<li class="ledger-item"><button type="button" class="ledger-row${idx === 0 ? ' is-active' : ''}" data-pilot-step="${idx}" aria-pressed="${idx === 0 ? 'true' : 'false'}"><div class="ledger-k">${renderInline(l.slice(0, at).trim())}</div><div class="ledger-v">${renderInline(l.slice(at + 1).trim())}</div></button></li>`;
          });
          out.push(`<ol class="ledger">${rows.join('')}</ol>`);
          break;
        }
        default:
          problems.push(`Unknown container ":::${name}" in slide ${ctx.slideId}`);
          out.push(renderBlocks(inner, ctx));
      }
      continue;
    }

    if (/^\|/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\|/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(renderTable(buf));
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(renderList(buf, ctx));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${renderBlocks(buf, ctx)}</blockquote>`);
      continue;
    }

    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      out.push(`<img src="${attr(img[2])}" alt="${attr(img[1])}">`);
      i++;
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|:::|\||>\s?|\s*([-*]|\d+[.)])\s+|!\[)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${para.map(renderInline).join(' ')}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------
// Slides
// ------------------------------------------------------------------------------------------------
const slideKicker = (s) => s.kicker || (['title', 'break'].includes(s.layout) ? '' : s.section);

/** The markup inside a slide's <section>. app.js builds exactly the same markup from the JSON. */
function slideInner(s) {
  const out = [];
  const kicker = slideKicker(s);
  if (kicker) out.push(`<div class="slide-kicker">${esc(kicker)}</div>`);
  if (s.title) out.push(`<h1>${s.titleHtml}</h1>`);
  out.push(`<div class="slide-body">${s.html}</div>`);
  return out.join('');
}

function slideSection(s, i) {
  const exempt = s.exempt ? ` data-density-exempt="${attr(s.exempt)}"` : '';
  return `<section class="slide layout-${s.layout || 'default'}${i === 0 ? ' active' : ''}" id="s${s.n}" data-id="${esc(s.id)}" aria-roledescription="slide" aria-label="Slide ${s.n}: ${esc(s.title || s.id)}"${exempt}>${slideInner(s)}</section>`;
}

function loadSlides() {
  if (!existsSync(SLIDES_DIR)) { problems.push('content/slides is missing'); return []; }
  const files = readdirSync(SLIDES_DIR).filter((f) => f.endsWith('.md')).sort();
  const slides = [];
  const ids = new Set();
  for (const f of files) {
    const { meta, body } = parseFrontMatter(readFileSync(join(SLIDES_DIR, f), 'utf8'));
    const chunks = body.split(/\n---\s*\n/);
    for (const chunk of chunks) {
      const lines = chunk.replace(/^\s*\n/, '').split('\n');
      const attrs = { section: meta.section || '', day: Number(meta.day || 1), layout: 'default', minutes: 0, kicker: '', exempt: '' };
      while (lines.length && /^@[a-z-]+:/i.test(lines[0])) {
        const m = lines.shift().match(/^@([a-z-]+):\s*(.*)$/i);
        attrs[m[1]] = m[2].trim();
      }
      const text = lines.join('\n').trim();
      if (!text && !attrs.id) continue;
      if (!attrs.id) { problems.push(`Slide without @id in ${f}: "${text.slice(0, 40)}"`); continue; }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(attrs.id)) problems.push(`Slide id "${attrs.id}" must be kebab-case (${f})`);
      if (ids.has(attrs.id)) problems.push(`Duplicate slide id "${attrs.id}" in ${f}`);
      ids.add(attrs.id);
      if (!LAYOUTS.has(attrs.layout)) warnings.push(`Slide "${attrs.id}" uses unknown layout "${attrs.layout}"`);
      attrs.minutes = Number(attrs.minutes || 0);
      attrs.day = Number(attrs.day);
      if (!attrs.minutes) warnings.push(`Slide "${attrs.id}" has no @minutes`);
      if (/^(SAY|DO|SHOW):/m.test(text)) problems.push(`Slide "${attrs.id}" contains script cues on the audience surface`);
      const ctx = { slideId: attrs.id, diagrams: [], links: [] };
      const bodyLines = text.split('\n');
      let titleRaw = '';
      const tIdx = bodyLines.findIndex((l) => /^#\s+/.test(l));
      if (tIdx !== -1) { titleRaw = bodyLines[tIdx].replace(/^#\s+/, ''); bodyLines.splice(tIdx, 1); }
      let html = renderBlocks(bodyLines, ctx);
      if (html.includes('<!--/lab-tile-->')) {
        const [tile, rest] = html.split('<!--/lab-tile-->');
        html = `${tile}<div class="lab-main">${rest}</div>`;
      }
      slides.push({ ...attrs, source: f, title: plain(titleRaw), titleHtml: renderInline(titleRaw), html, diagrams: ctx.diagrams, links: ctx.links });
    }
  }
  slides.forEach((s, i) => { s.n = i + 1; });
  return slides;
}

// ------------------------------------------------------------------------------------------------
// Static analysis of the rendered slides — a fast twin of deck-density.py (which stays authoritative)
// ------------------------------------------------------------------------------------------------
const WORDS_RE = /[A-Za-z0-9][A-Za-z0-9\-\u2019'.]*/g;       // deck-density `words()`: the visible-word budget
const BODY_RE = /[A-Za-z0-9_\u2019'-]+/g;                     // `body_words()` / slide-review: the hollow-container floor
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|<!--[\s\S]*?-->|([^<]+)/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'head']);
const CONTAINER_CLASSES = new Set(['card', 'step', 'band', 'nopub', 'tile', 'panel', 'box']);
const BLOCK = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'dt', 'dd', 'caption']);
const HEADING = /^h[1-6]$/;

function analyzeHtml(html) {
  const stack = [];
  const frames = [];
  const finished = [];
  let skip = 0;
  let headingDepth = 0;
  let blockDepth = 0;
  let tableDepth = 0;
  let blockHasText = false;
  let anchors = 0;
  let text = '';
  for (const m of html.matchAll(TAG_RE)) {
    if (m[5] !== undefined) {
      if (skip) continue;
      const t = decodeEntities(m[5]);
      if (!t.trim()) continue;
      text += ` ${t}`;
      blockHasText = true;
      const a = (t.match(WORDS_RE) || []).length;
      const b = (t.match(BODY_RE) || []).length;
      for (const f of frames) {
        if (headingDepth) f.hasH = true;
        else { f.bodyWords += a; f.bodyTokens += b; }
      }
      continue;
    }
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (SKIP.has(tag)) {
      if (closing) { if (skip) skip--; } else if (!m[4]) skip++;
      continue;
    }
    if (skip || VOID.has(tag)) continue;
    if (!closing) {
      stack.push(tag);
      if (HEADING.test(tag)) headingDepth++;
      const cls = (attrs.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1] || '';
      if (cls.split(/\s+/).some((c) => CONTAINER_CLASSES.has(c))) frames.push({ depth: stack.length, hasH: false, bodyWords: 0, bodyTokens: 0, cls });
      if (tag === 'table') { tableDepth++; if (tableDepth === 1) anchors++; }
      else if (!tableDepth && BLOCK.has(tag)) { blockDepth++; blockHasText = false; }
    } else {
      if (tag === 'table' && tableDepth) tableDepth--;
      else if (BLOCK.has(tag) && blockDepth && !tableDepth) {
        blockDepth--;
        if (blockHasText) anchors++;
        blockHasText = false;
      }
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) {
        const t = stack.pop();
        if (HEADING.test(t) && headingDepth) headingDepth--;
        while (frames.length && frames[frames.length - 1].depth > stack.length) finished.push(frames.pop());
      }
    }
  }
  finished.push(...frames);
  const flat = text.replace(/\s+/g, ' ').trim();
  return {
    words: (flat.match(WORDS_RE) || []).length,
    tokens: (flat.match(WORDS_RE) || []).map((w) => w.toLowerCase()),
    anchors,
    containers: finished.filter((f) => f.hasH),
  };
}

function lintSlide(s) {
  const a = analyzeHtml(slideInner(s));
  s.visibleWords = a.words;
  s.anchors = a.anchors;
  s.tokens = a.tokens;
  s.containerCount = a.containers.length;
  if (s.exempt) return;
  if (a.words > WORD_CEILING) problems.push(`Slide "${s.id}": ${a.words} visible words is over the ${WORD_CEILING}-word ceiling`);
  else if (a.words > WORD_BUDGET) warnings.push(`Slide "${s.id}": ${a.words} visible words is over the ${WORD_BUDGET}-word budget`);
  if (a.anchors > MAX_ANCHORS) problems.push(`Slide "${s.id}": ${a.anchors} competing text blocks is over ${MAX_ANCHORS}`);
  for (const c of a.containers) {
    if (c.bodyWords < CONTAINER_BODY_MIN || c.bodyTokens > CONTAINER_BODY_MAX) {
      warnings.push(`Slide "${s.id}": a .${c.cls.split(/\s+/).join('.')} holds ${c.bodyWords}–${c.bodyTokens} body words; keep ${CONTAINER_BODY_MIN}–${CONTAINER_BODY_MAX}`);
    }
  }
}

function lintLinks(s) {
  for (const m of s.html.matchAll(/\bhref="([^"]+)"/g)) {
    const href = decodeEntities(m[1]);
    if (/^(https?:|mailto:|#|\/)/i.test(href)) continue;
    s.links.push(href);
  }
  if (!existsSync(join(ROOT, '.git'))) return;
  for (const link of new Set(s.links)) {
    const path = link.split('#')[0];
    const target = resolve(ROOT, path);
    if (!insideRoot(target) || !existsSync(target)) problems.push(`Slide "${s.id}": the link "${link}" does not exist in the repository`);
  }
}

// ------------------------------------------------------------------------------------------------
// Speaker script
// ------------------------------------------------------------------------------------------------
const CUE_RE = /^(DO|SHOW|ASK|PAUSE|DEMO|CHECK|TIME|LAB|CLICK):\s*(.*)$/;
const CUE_ICON = { DO: '🎬', SHOW: '👁', ASK: '💬', PAUSE: '⏸', DEMO: '🖥', CHECK: '🔎', TIME: '⏱', LAB: '🧪', CLICK: '👉' };

function loadScript() {
  const sections = new Map();
  if (!existsSync(SCRIPT_DIR)) { warnings.push('content/script is missing'); return sections; }
  const files = readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.md')).sort();
  for (const f of files) {
    const { body } = parseFrontMatter(readFileSync(join(SCRIPT_DIR, f), 'utf8'));
    let cur = null;
    let inSources = false;
    let para = [];
    const flush = () => { if (para.length && cur) cur.parts.push({ type: 'say', text: para.join(' ') }); para = []; };
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const head = line.match(/^##\s+\[([^\]]+)\]\s*(.*)$/);
      if (head) {
        flush();
        cur = { title: head[2].trim(), parts: [], file: f };
        if (sections.has(head[1])) problems.push(`Script section "[${head[1]}]" defined twice (${f})`);
        sections.set(head[1], cur);
        inSources = false;
        continue;
      }
      if (!cur) continue;
      if (/^#\s/.test(line)) continue;
      if (/^SOURCE:/i.test(line)) {
        flush();
        inSources = true;
        const first = line.replace(/^SOURCE:\s*/i, '').trim();
        cur.parts.push({ type: 'sources', items: first ? [first] : [] });
        continue;
      }
      if (inSources) {
        if (line.trim() === '') { inSources = false; continue; }
        cur.parts[cur.parts.length - 1].items.push(line.trim());
        continue;
      }
      const cue = line.match(CUE_RE);
      if (cue) { flush(); cur.parts.push({ type: 'cue', kind: cue[1], text: cue[2] }); continue; }
      if (/^>\s?/.test(line)) { flush(); cur.parts.push({ type: 'transition', text: line.replace(/^>\s?/, '') }); continue; }
      if (line.trim() === '') { flush(); continue; }
      para.push(line.trim());
    }
    flush();
  }
  return sections;
}

function sourceHtml(u) {
  if (/^https?:/.test(u)) return `<li><a href="${attr(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a></li>`;
  return `<li>${renderInline(u)}</li>`;
}

function notesHtml(section) {
  if (!section) return '';
  return section.parts.map((p) => {
    switch (p.type) {
      case 'say': return `<p class="say">${renderInline(p.text)}</p>`;
      case 'cue': return `<p class="cue cue-${p.kind.toLowerCase()}"><span class="cue-kind" aria-hidden="true">${CUE_ICON[p.kind]}</span><span class="cue-label">${p.kind}</span> ${renderInline(p.text)}</p>`;
      case 'transition': return `<p class="transition"><span class="cue-label">Bridge</span> ${renderInline(p.text)}</p>`;
      case 'sources': return p.items.length ? `<details class="sources"><summary>Sources (${p.items.length})</summary><ul>${p.items.map(sourceHtml).join('')}</ul></details>` : '';
      default: return '';
    }
  }).join('\n');
}

const spokenText = (section) => (section ? section.parts.filter((p) => p.type === 'say').map((p) => p.text).join(' ') : '');
const wordCount = (section) => (section ? section.parts.filter((p) => p.type === 'say').reduce((n, p) => n + p.text.split(/\s+/).length, 0) : 0);

/** Share of the spoken words that sit inside verbatim runs of >= n words lifted from the slide (deck-density's measure). */
function verbatimOverlap(spoken, slideTokens, n = 8) {
  const sc = (spoken.replace(/[*_`]/g, '').match(WORDS_RE) || []).map((w) => w.toLowerCase());
  if (sc.length < n || slideTokens.length < n) return 0;
  const grams = new Set();
  for (let j = 0; j <= slideTokens.length - n; j++) grams.add(slideTokens.slice(j, j + n).join('\u0001'));
  const covered = new Array(sc.length).fill(false);
  for (let j = 0; j <= sc.length - n; j++) {
    if (grams.has(sc.slice(j, j + n).join('\u0001'))) for (let k = j; k < j + n; k++) covered[k] = true;
  }
  return (100 * covered.filter(Boolean).length) / sc.length;
}

// ------------------------------------------------------------------------------------------------
// Agenda
// ------------------------------------------------------------------------------------------------
function loadAgenda() {
  if (!existsSync(AGENDA_FILE)) { warnings.push('content/agenda.json is missing'); return null; }
  try { return JSON.parse(readFileSync(AGENDA_FILE, 'utf8')); } catch (e) { problems.push(`content/agenda.json is not valid JSON: ${e.message}`); return null; }
}

function lintAgenda(agenda, slides) {
  if (!agenda) return;
  const byId = new Map(slides.map((s) => [s.id, s]));
  const seen = new Map();
  let blockMinutes = 0;
  for (const d of agenda.days || []) {
    for (const b of d.blocks || []) {
      let planned = 0;
      for (const ref of b.slides || []) {
        const s = byId.get(ref);
        if (!s) { problems.push(`agenda.json references unknown slide "${ref}"`); continue; }
        if (seen.has(ref)) warnings.push(`agenda.json lists slide "${ref}" in two blocks`);
        seen.set(ref, true);
        planned += s.minutes;
      }
      blockMinutes += b.minutes || 0;
      if (planned !== b.minutes) warnings.push(`agenda block "${b.title}" is ${b.minutes} min but its slides add up to ${planned} min`);
      if (!/^\d{2}:\d{2}$/.test(b.start || '')) problems.push(`agenda block "${b.title}" needs a start time like 10:00`);
    }
  }
  for (const s of slides) if (!seen.has(s.id)) warnings.push(`Slide "${s.id}" is not in any agenda block`);
  const slideMinutes = slides.reduce((n, s) => n + s.minutes, 0);
  if (blockMinutes !== slideMinutes) warnings.push(`agenda blocks add up to ${blockMinutes} min but the slides plan ${slideMinutes} min`);
}

// ------------------------------------------------------------------------------------------------
// Presenter script document (Markdown)
// ------------------------------------------------------------------------------------------------
function fmtClock(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function presenterMarkdown(slides, script, agenda, dateStr = new Date().toISOString().slice(0, 10)) {
  const L = [];
  const title = agenda?.title || 'AI SDLC Orchestrator';
  L.push(`# Presenter Script — ${title} (L300)`);
  L.push('');
  L.push(`> Generated by \`node presentation/build.mjs\` from \`presentation/content/script/\` on ${dateStr}. Edit the script sources, not this file.`);
  L.push('');
  L.push('## How to read this script');
  L.push('');
  L.push('- **Plain text is what you say.** It is written to be spoken: short sentences, one idea each, in the order you will say them. Read it as prose, not as bullets.');
  L.push('- **Quoted lines are things you do, not things you say.** 🎬 DO, 👁 SHOW, 💬 ASK, ⏸ PAUSE, 🖥 DEMO, 🔎 CHECK, 👉 CLICK. Pauses are deliberate: give the room the seconds they ask for.');
  L.push('- **The ➜ line is the bridge to the next slide.** Say it while you press Next, so the screen never changes in silence.');
  L.push('- **The clock** under each heading is the slide\'s budget and the running total. Thirty minutes is tight: if you are two minutes behind at the live pilot, shorten the quiz, not the pilot.');
  L.push('- **Nothing in this script appears on the audience screen.** The deck shows sparse slides; the speaker window (press **S** in the deck) shows these notes beside the current and next slide.');
  L.push('');
  L.push('Oratory rules this script follows: say the point before the detail, one number per sentence, name the slide element you are pointing at, land every section with a takeaway, and never read the slide aloud.');
  L.push('');
  const days = [...new Set(slides.map((s) => s.day))].sort();
  for (const day of days) {
    const dayAgenda = agenda?.days?.find((d) => d.day === day);
    L.push(`## ${dayAgenda?.label || `Day ${day}`}${dayAgenda ? ` — ${dayAgenda.title}` : ''}`);
    L.push('');
    if (dayAgenda) {
      L.push('| Start | Min | Block |');
      L.push('|---|---|---|');
      for (const b of dayAgenda.blocks) L.push(`| ${b.start} | ${b.minutes} | ${b.type === 'break' ? '☕ ' : b.type === 'lab' ? '🧪 ' : ''}${b.title} |`);
      L.push('');
    }
    let running = 0;
    let lastSection = null;
    for (const s of slides.filter((x) => x.day === day)) {
      if (s.section !== lastSection) {
        L.push(`### ▶ ${s.section}`);
        L.push('');
        lastSection = s.section;
      }
      const sec = script.get(s.id);
      L.push(`#### [SLIDE ${s.n}] · ${s.title || s.id}`);
      L.push('');
      const budget = s.minutes ? `⏱ ${s.minutes} min` : '⏱ —';
      L.push(`> *${budget} · running ${fmtClock(running)} → ${fmtClock(running + s.minutes)}*`);
      L.push('');
      running += s.minutes;
      if (!sec) { L.push('_No script section for this slide._'); L.push(''); continue; }
      for (const p of sec.parts) {
        if (p.type === 'say') { L.push(p.text); L.push(''); }
        else if (p.type === 'cue') { L.push(`> ${CUE_ICON[p.kind]} **${p.kind}** ${p.text}`); L.push(''); }
        else if (p.type === 'transition') { L.push(`> ➜ ${p.text}`); L.push(''); }
        else if (p.type === 'sources' && p.items.length) { L.push(`> 🔗 Source: ${p.items.join(' · ')}`); L.push(''); }
      }
    }
  }
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------
// Build
// ------------------------------------------------------------------------------------------------
function main() {
  const slides = loadSlides();
  const script = loadScript();
  const agenda = loadAgenda();

  const slideIds = new Set(slides.map((s) => s.id));
  for (const s of slides) {
    lintSlide(s);
    lintLinks(s);
    if (!script.has(s.id)) warnings.push(`No script for slide "${s.id}" (${s.source})`);
    const sec = script.get(s.id);
    s.notes = notesHtml(sec);
    s.words = wordCount(sec);
    s.overlap = sec ? verbatimOverlap(spokenText(sec), s.tokens) : 0;
    if (s.overlap > 0) warnings.push(`Slide "${s.id}": ${s.overlap.toFixed(1)}% of the script repeats the slide verbatim (8-word runs)`);
    if (s.minutes && s.words / SPOKEN_WPM > s.minutes * 1.25) warnings.push(`Slide "${s.id}": ${s.words} words for ${s.minutes} min (~${(s.words / SPOKEN_WPM).toFixed(1)} min spoken)`);
    if (s.minutes && sec && s.words / SPOKEN_WPM < s.minutes * 0.55) warnings.push(`Slide "${s.id}": only ${s.words} words for ${s.minutes} min (~${(s.words / SPOKEN_WPM).toFixed(1)} min spoken)`);
  }
  for (const id of script.keys()) if (!slideIds.has(id)) warnings.push(`Script section "[${id}]" has no slide`);
  lintAgenda(agenda, slides);

  const totalWords = slides.reduce((n, s) => n + s.words, 0);
  const totalMin = slides.reduce((n, s) => n + s.minutes, 0);
  const maxVisible = slides.reduce((n, s) => Math.max(n, s.visibleWords || 0), 0);

  if (STRICT) {
    for (const w of warnings) problems.push(`[strict] ${w}`);
    warnings.length = 0;
  }
  for (const w of warnings) console.warn(`warn: ${w}`);
  for (const p of problems) console.error(`ERROR: ${p}`);
  if (CHECK_ONLY) {
    console.log('  #  id                     min  on-screen  anchors  cards  spoken  overlap');
    for (const s of slides) {
      console.log(`${String(s.n).padStart(3)}  ${s.id.padEnd(22)} ${String(s.minutes).padStart(3)}  ${String(s.visibleWords).padStart(9)}  ${String(s.anchors).padStart(7)}  ${String(s.containerCount).padStart(5)}  ${String(s.words).padStart(6)}  ${s.overlap.toFixed(1).padStart(6)}%`);
    }
  }
  console.log(`${slides.length} slides · ${script.size} script sections · ${totalWords} spoken words · ${totalMin} planned minutes · max ${maxVisible} on-screen words${STRICT ? ' · strict' : ''}`);
  if (problems.length) process.exit(1);
  if (CHECK_ONLY) return;

  const shell = readFileSync(join(SRC, 'shell.html'), 'utf8').replace(/\r\n/g, '\n');
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const js = readFileSync(join(SRC, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const slidesHtml = slides.map(slideSection).join('\n');
  const renderHtml = (builtIso) => {
    const data = {
      title: agenda?.title || 'AI SDLC Orchestrator',
      subtitle: agenda?.subtitle || '',
      built: builtIso,
      source: SOURCE,
      slides: slides.map(({ id, n, day, section, layout, kicker, exempt, minutes, title, titleHtml, html, notes, words }) => ({ id, n, day, section, layout, kicker, exempt, minutes, title, titleHtml, html, notes, words })),
      agenda,
    };
    // keep the JSON safe inside a <script> element: neither "</" nor "<!--" may appear literally
    const json = JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--');
    return shell
      .replace('{{TITLE}}', () => esc(data.title))
      .replace('{{STYLES}}', () => css)
      .replace('{{SLIDES_HTML}}', () => slidesHtml)
      .replace('{{DATA}}', () => json)
      .replace('{{SCRIPT}}', () => js);
  };

  // Idempotent output: when nothing but the clock changed, keep the previous bytes (and its timestamp).
  let html = renderHtml(new Date().toISOString());
  if (existsSync(OUT_HTML)) {
    const prevHtml = readFileSync(OUT_HTML, 'utf8');
    const prevBuilt = (prevHtml.match(/"built":"([^"]+)"/) || [])[1];
    if (prevBuilt && renderHtml(prevBuilt).replace(/\r\n/g, '\n') === prevHtml.replace(/\r\n/g, '\n')) {
      html = prevHtml;
    }
  }

  let scriptOut = presenterMarkdown(slides, script, agenda);
  if (existsSync(OUT_SCRIPT)) {
    const prevScript = readFileSync(OUT_SCRIPT, 'utf8');
    const prevDate = (prevScript.match(/from `presentation\/content\/script\/` on (\d{4}-\d{2}-\d{2})\./) || [])[1];
    if (prevDate && presenterMarkdown(slides, script, agenda, prevDate).replace(/\r\n/g, '\n') === prevScript.replace(/\r\n/g, '\n')) {
      scriptOut = prevScript;
    }
  }

  mkdirSync(DIST, { recursive: true });
  writeFileSync(OUT_HTML, html);
  mkdirSync(dirname(OUT_SCRIPT), { recursive: true });
  writeFileSync(OUT_SCRIPT, scriptOut);
  console.log(`wrote ${OUT_HTML} (${(html.length / 1024).toFixed(0)} KB) and ${OUT_SCRIPT}`);
}

main();
