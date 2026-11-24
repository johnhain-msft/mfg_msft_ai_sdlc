/**
 * Pure HTML composition for the customer handout PDF. No I/O, no browser: strings in, strings out,
 * so the build, the guards and the tests all see exactly the same markup.
 *
 * Page model (Letter, 816 x 1056 CSS px):
 *   pages 1..N        one slide per page: the real pre-rendered <section class="slide"> scaled into a 16:9 frame,
 *                     then a header bar, the title, companion notes, a reflection prompt and the primary sources
 *   pages N+1..N+2    the AI-DLC and PROSE glossary (entries are paginated in the browser, see build-handout.mjs)
 *
 * Every class this file emits is prefixed `hx-` so nothing here can collide with the deck's own stylesheet
 * (which owns .card .band .tile .step .panel .box .note .label and friends).
 */

import { LABEL_FIXES, REFLECT_LABEL } from './notes.mjs';

// --------------------------------------------------------------------------- text helpers

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Typographic quotes. Straight quotes in the authored text become curly; existing curly quotes are left alone. */
export const smart = (s) =>
  s
    .replace(/(^|[\s(\[{\u2014\u2013-])"/g, '$1\u201c')
    .replace(/"/g, '\u201d')
    .replace(/(^|[\s(\[{\u2014\u2013-])'/g, '$1\u2018')
    .replace(/'/g, '\u2019');

/** Inline markup: **bold**, *italic*, `code`. Escapes first, so authored text can never inject HTML. */
export function inline(src) {
  const parts = String(src).split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(smart(part))
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    })
    .join('');
}

/** Plain text of an authored string (markup removed). Used by the guards and the text export. */
export const plain = (src) =>
  smart(String(src))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1');

const pad2 = (n) => String(n).padStart(2, '0');

export function fixLabel(label) {
  return LABEL_FIXES.reduce((s, [rx, to]) => s.replace(rx, to), label);
}

// --------------------------------------------------------------------------- icons (decorative, aria-hidden)

const EMBLEM =
  '<svg class="hx-emblem" viewBox="0 0 23 23" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>' +
  '<rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>';

const ICON_EXT =
  '<svg class="hx-ext" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M4.5 2.5H2.5v7h7v-2M7 2.5h2.5V5M9.5 2.5 5.5 6.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_CHECK =
  '<svg class="hx-check" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 6.3 5 8.8l4.5-5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The deck's tri-colour brand stripe, as three solid bars along the top edge of a page. */
const STRIPE = '<div class="hx-stripe" aria-hidden="true"><i></i><i></i><i></i></div>';

// --------------------------------------------------------------------------- body blocks

/** A body is an array of strings. Consecutive "- " strings form one list; everything else is a paragraph. */
export function renderBody(items = [], { keepList = false } = {}) {
  let html = '';
  let list = [];
  const flush = () => {
    if (list.length) html += `<ul class="hx-list${keepList ? ' hx-keep' : ''}">${list.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`;
    list = [];
  };
  for (const item of items) {
    if (item.startsWith('- ')) list.push(item.slice(2));
    else {
      flush();
      html += `<p>${inline(item)}</p>`;
    }
  }
  flush();
  return html;
}

function renderTable({ title, head, rows, widths }) {
  const cols = widths ? `<colgroup>${widths.map((w) => `<col style="width:${esc(w)}">`).join('')}</colgroup>` : '';
  return (
    `<section class="hx-block">${title ? `<p class="hx-h4">${esc(title)}</p>` : ''}` +
    `<table class="hx-table${widths ? ' hx-fixed' : ''}">${cols}<thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
    rows
      .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`)
      .join('') +
    `</tbody></table></section>`
  );
}

function renderSteps({ title, items, foot }) {
  return (
    `<section class="hx-block hx-steps">${title ? `<p class="hx-h4">${esc(title)}</p>` : ''}<ol>` +
    items.map(([head, text]) => `<li><span class="hx-step-h">${esc(head)}</span><span class="hx-step-t">${inline(text)}</span></li>`).join('') +
    `</ol>${foot ? `<p class="hx-foot-note">${inline(foot)}</p>` : ''}</section>`
  );
}

function renderCards({ items }) {
  const letters = 'ABCDEFG';
  return (
    `<div class="hx-tiles">` +
    items
      .map((it) => {
        const opts = it.options
          ? `<ul class="hx-opts">${it.options
              .map((o, i) => {
                const right = i === it.answer;
                return `<li class="${right ? 'is-answer' : ''}"><span class="hx-opt-k">${letters[i]}</span><span class="hx-opt-t">${esc(o)}</span>${
                  right ? `<span class="hx-opt-flag">${ICON_CHECK}Answer</span>` : ''
                }</li>`;
              })
              .join('')}</ul>`
          : '';
        const bullets = it.bullets ? `<ul class="hx-list">${it.bullets.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>` : '';
        const explain = it.explain ? `<p class="hx-explain"><strong>Why:</strong> ${inline(it.explain)}</p>` : '';
        return (
          `<article class="hx-tile">` +
          `<p class="hx-tile-tag">${esc(it.tag)}</p><p class="hx-tile-h">${esc(it.title)}</p>` +
          (it.body ? `<p class="hx-tile-b">${inline(it.body)}</p>` : '') +
          opts +
          bullets +
          explain +
          `</article>`
        );
      })
      .join('') +
    `</div>`
  );
}

function renderFaq({ title, items, foot }) {
  return (
    `<section class="hx-block">${title ? `<p class="hx-h4">${esc(title)}</p>` : ''}<div class="hx-faq">` +
    items.map(([q, a]) => `<div class="hx-faq-i"><p class="hx-faq-q">${inline(q)}</p><p class="hx-faq-a">${inline(a)}</p></div>`).join('') +
    `</div>${foot ? `<p class="hx-foot-note">${inline(foot)}</p>` : ''}</section>`
  );
}

/** Page ranges per module, plus the appendix, with links to the pages. */
function renderToc({ title }, ctx) {
  const rows = ctx.modules
    .map((m) => {
      const span = ctx.pagesOfModule(m.code);
      const label = span[0] === span[1] ? `p. ${span[0]}` : `pp. ${span[0]}\u2013${span[1]}`;
      return `<li><a href="#p${span[0]}"><span class="hx-toc-k">${esc(m.code)}</span><span class="hx-toc-t">${esc(m.title)}</span><span class="hx-toc-p">${label}</span></a></li>`;
    })
    .concat(
      `<li><a href="#p${ctx.glossaryPages[0]}"><span class="hx-toc-k">\u2736</span><span class="hx-toc-t">Appendix: AI-DLC and PROSE glossary</span><span class="hx-toc-p">pp. ${ctx.glossaryPages[0]}\u2013${ctx.glossaryPages[1]}</span></a></li>`,
    );
  return `<section class="hx-block">${title ? `<p class="hx-h4">${esc(title)}</p>` : ''}<ul class="hx-toc">${rows.join('')}</ul></section>`;
}

/** The token-cost assumptions behind the $41.01 to $4.81 exercise (slide 15), from the same model the slide runs. */
function renderAssumptions({ title }, ctx) {
  const a = ctx.assumptions;
  const rows = a.inputs.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const spend = a.spend.rows
    .map((r, i) => `<tr class="${i === a.spend.rows.length - 1 ? 'is-on' : ''}">${r.map((c, j) => (j === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`)
    .join('');
  return (
    `<aside class="hx-block hx-assume" aria-label="${esc(title)}">` +
    `<p class="hx-h4">${esc(title)}</p>` +
    `<p class="hx-assume-note">Not vendor pricing. Prices are relative.</p>` +
    `<table class="hx-table hx-table-sm"><thead><tr><th scope="col">Token inputs</th><th scope="col">Levers off \u2192 levers on</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="hx-assume-p"><strong>Relative unit costs</strong> (frontier input = 1.00): frontier output ${esc(a.relative.output)}, cached input ${esc(a.relative.cached)}, mid tier ${esc(a.relative.mid)}, solved so all levers on = ${esc(a.relative.on)}. <strong>Calibration:</strong> 1.00 price unit = ${esc(a.relative.unit)} per million input tokens, solved so all levers off = ${esc(a.relative.off)}.</p>` +
    `<table class="hx-table hx-table-sm hx-spend"><thead><tr>${a.spend.head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${spend}</tbody></table>` +
    `</aside>`
  );
}

function renderExtra(extra, ctx) {
  switch (extra.type) {
    case 'toc':
      return renderToc(extra, ctx);
    case 'table':
      return renderTable(extra);
    case 'steps':
      return renderSteps(extra);
    case 'cards':
      return renderCards(extra);
    case 'faq':
      return renderFaq(extra);
    case 'assumptions':
      return renderAssumptions(extra, ctx);
    default:
      throw new Error(`unknown extra block type: ${extra.type}`);
  }
}

// --------------------------------------------------------------------------- sources

export function sourcesFor(slide) {
  return slide.sources.map((s) => ({ label: fixLabel(s.label), url: s.url }));
}

function renderSources(sources) {
  if (!sources.length) return '';
  return (
    `<footer class="hx-srcs"><p class="hx-lab">Primary sources</p><ul>` +
    sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.label)}${ICON_EXT}</a></li>`).join('') +
    `</ul></footer>`
  );
}

// --------------------------------------------------------------------------- pages

const pageFooter = (ctx, n) =>
  `<div class="hx-foot"><div class="hx-brand">${EMBLEM}<b>Microsoft</b><span aria-hidden="true">\u00b7</span><span>Agentic SDLC Advisory</span></div>` +
  `<div class="hx-foot-r"><span>${esc(ctx.meta.title)} \u00b7 ${esc(ctx.meta.event)}</span>` +
  `<span class="hx-pg">Page ${n} of ${ctx.totalPages}</span></div></div>`;

/**
 * The slide's own h1/h3 are part of a picture here, not of the document's outline. `role="presentation"` keeps them
 * out of the PDF bookmarks (one entry per page: the page title) without changing a single style, because the
 * deck's CSS selects on the tag names.
 */
export const neutralizeHeadings = (html) => html.replace(/<(h[1-6])(?=[\s>])/g, '<$1 role="presentation"');

export function renderSlidePage({ ctx, slide, index, notes, slideHtml }) {
  const n = index + 1;
  const mod = ctx.modules.find((m) => m.code === slide.moduleCode);
  const total = ctx.deck.slides.length;
  const split = notes.layout === 'split';
  const body = renderBody(notes.body, { keepList: Boolean(notes.keepList) });
  const extra = notes.extra ? renderExtra(notes.extra, ctx) : '';
  // a short lead-in above a table or tiles reads as one line of prose, not as two ragged columns
  const short = !split && Boolean(notes.extra) && (notes.body ?? []).join(' ').split(/\s+/).length < 60;
  const prose = body ? `<div class="${split ? 'hx-prose' : short ? 'hx-cols hx-cols-1' : 'hx-cols'}">${body}</div>` : '';
  const main = split ? `<div class="hx-split"${notes.splitCols ? ` style="grid-template-columns:${esc(notes.splitCols)}"` : ''}>${prose}<div class="hx-aside">${extra}</div></div>` : `${prose}${extra}`;
  const reflect = notes.reflect
    ? `<aside class="hx-reflect"><p class="hx-lab">${esc(REFLECT_LABEL)}</p><p class="hx-reflect-q">${inline(notes.reflect)}</p></aside>`
    : '';
  return (
    `<section class="hx-page hx-slide-page" id="p${n}" data-slide="${esc(slide.id)}" aria-label="Page ${n}: ${esc(slide.title)}">` +
    STRIPE +
    `<div class="hx-shot" role="img" aria-label="${esc(slideAlt(slide, n))}"><div class="hx-canvas">${neutralizeHeadings(slideHtml)}</div></div>` +
    `<div class="hx-bar"><span class="hx-pill">Slide ${pad2(n)} / ${total}</span><span class="hx-mod">Module ${esc(mod.code)} \u00b7 ${esc(mod.title)}</span></div>` +
    `<h2 class="hx-title">${esc(slide.title)}</h2>` +
    `<p class="hx-purpose">${inline(notes.summary)}</p>` +
    `<div class="hx-notes"><p class="hx-lab hx-legend">Companion notes</p><div class="hx-zone">${main}${reflect}</div></div>` +
    renderSources(sourcesFor(slide)) +
    pageFooter(ctx, n) +
    `</section>`
  );
}

/** What the slide says, in reading order, as the alternative text of the picture of it. */
export function slideAlt(slide, n) {
  const parts = [`Slide ${n}: ${slide.title}.`];
  if (slide.kicker) parts.push(`${slide.kicker}.`);
  if (slide.lead) parts.push(slide.lead);
  for (const b of slide.blocks) {
    if (b.kind === 'table') parts.push(`${b.rows.map((r) => r.filter((c) => !/^[\u25cb\u25cf]$/.test(c)).join(', ')).join('; ')}.`);
    else if (b.kind === 'chip' || b.kind === 'label') parts.push(`${b.text}.`);
    else parts.push(`${b.head}: ${b.body}`);
  }
  if (slide.stat) parts.push(`${slide.stat}.`);
  if (slide.diagram && !slide.diagram.decorative) parts.push(`Diagram: ${slide.diagram.title}`);
  if (slide.note) parts.push(slide.note);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// --------------------------------------------------------------------------- glossary

/**
 * The glossary entries as flat, ordered blocks: a category heading, then its entries. The browser
 * paginates them into columns (build-handout.mjs), because only real layout can say what fits.
 */
export function renderGlossaryStage({ ctx, categories, entries, slideNumberOf }) {
  let html = '';
  for (const cat of categories) {
    const list = entries.filter((e) => cat.groups.includes(e.group));
    if (!list.length) continue;
    // The PDF bookmark is the heading's rendered text. The count is decorative, so it is aria-hidden (otherwise it
    // fuses onto the title, "SECURITY & GUARDRAILS6 terms"); the bar's white-space: pre-wrap keeps the space at a
    // soft wrap, so "SUPPLY CHAIN" does not become "SUPPLYCHAIN".
    html += `<h3 class="hx-gl-h" data-cat="${esc(cat.id)}"><span>${esc(cat.title)}</span><em aria-hidden="true">${list.length} terms</em></h3>`;
    for (const e of list) {
      const slides = (e.slides ?? []).map(slideNumberOf).filter(Boolean);
      const slideLinks = slides.map((s) => `<a href="#p${s}">${s}</a>`).join(', ');
      const src = e.source ? `<a class="hx-gl-src" href="${esc(e.source.url)}">${esc(e.source.label)}${ICON_EXT}</a>` : '';
      const where = slides.length ? `<span class="hx-gl-at">${slides.length > 1 ? 'Slides' : 'Slide'} ${slideLinks}</span>` : '';
      const meta = src || where ? ` <span class="hx-gl-m">${src}${src && where ? '<i aria-hidden="true">\u00b7</i>' : ''}${where}</span>` : '';
      html += `<div class="hx-gl" data-cat="${esc(cat.id)}"><p><strong>${esc(e.term)}</strong> ${esc(e.definition)}${meta}</p></div>`;
    }
  }
  return html;
}

/** The two glossary page shells. Their columns are empty here; the browser fills them from the stage. */
export function renderGlossaryPages({ ctx, intro, footnote, count }) {
  const [a, b] = ctx.glossaryPages;
  const col = '<div class="hx-gl-col"></div>';
  return (
    `<section class="hx-page hx-gloss" id="p${a}" aria-label="Page ${a}: Glossary">` +
    STRIPE +
    `<div class="hx-gl-head"><p class="hx-kicker">Appendix</p><h2 class="hx-title">AI-DLC and PROSE glossary</h2>` +
    `<p class="hx-purpose">${esc(intro.replace('{count}', String(count)))}</p></div>` +
    `<div class="hx-gl-cols" data-page="1">${col}${col}${col}</div>` +
    pageFooter(ctx, a) +
    `</section>` +
    `<section class="hx-page hx-gloss" id="p${b}" aria-label="Page ${b}: Glossary, continued">` +
    STRIPE +
    `<div class="hx-gl-head hx-gl-head-cont"><p class="hx-kicker">Appendix \u00b7 continued</p><p class="hx-title hx-title-sm">AI-DLC and PROSE glossary</p></div>` +
    `<div class="hx-gl-cols" data-page="2">${col}${col}${col}</div>` +
    `<p class="hx-gl-foot">${esc(footnote)}</p>` +
    pageFooter(ctx, b) +
    `</section>`
  );
}

// --------------------------------------------------------------------------- document

export function composeDocument({ ctx, css, printCss, slides, glossary }) {
  const pages = ctx.deck.slides
    .map((slide, i) =>
      renderSlidePage({
        ctx,
        slide,
        index: i,
        notes: ctx.notes[slide.id],
        slideHtml: slides[i],
      }),
    )
    .join('\n');
  const stage = renderGlossaryStage({ ctx, ...glossary });
  const shells = renderGlossaryPages({ ctx, ...glossary.page });
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${esc(ctx.meta.title)} \u00b7 ${esc(ctx.meta.event)} \u00b7 Customer companion</title>
<meta name="description" content="${esc(ctx.meta.subtitle)}. A slide-by-slide companion to the ${esc(ctx.meta.event)} session, with notes, reflection prompts, primary sources and a glossary.">
<style>
${css}
</style>
<style>
${printCss}
</style>
</head>
<body>
<main class="hx-doc">
${pages}
${shells}
</main>
<div id="hx-gl-stage" hidden>${stage}</div>
</body>
</html>
`;
}
