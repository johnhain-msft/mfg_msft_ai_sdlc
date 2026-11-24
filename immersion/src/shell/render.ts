/**
 * Pure slide renderer: `Slide` -> `<section class="slide">` markup.
 *
 * Shared by the build (pre-rendered static twin in `dist/index.html`) and by tests. The runtime
 * never rebuilds these sections: it adopts the pre-rendered DOM and upgrades it in place.
 *
 * Markup rules that keep the gates honest:
 *   - Only the `kicker`, `title`, `lead`, container, table, chip, label, stat and note text of a
 *     slide is ever emitted. Widget hooks add attributes, classes and word-free SVG, never prose.
 *   - Heading-bearing containers are `<div class="card|step|panel|box|tile|band"><h3>..</h3><p>..</p></div>`
 *     with exact class tokens, and nothing else on a slide wears those tokens.
 *   - Brand chrome (emblem, counter, nav, footer) is NOT rendered here; it lives outside the section.
 */

import { attrs, cx, esc } from '../content/html';
import {
  blockKey,
  isChip,
  isContainer,
  isLabel,
  isTable,
  type Block,
  type ChipBlock,
  type Container,
  type Deck,
  type IconName,
  type LabelBlock,
  type Slide,
  type TableBlock,
} from '../content/types';
import { hooksFor } from '../widgets';
import type { BlockDecor, WidgetRenderHooks } from '../widgets/types';

/** Decorative 24x24 stroke icons. aria-hidden, zero words. */
export const ICONS: Readonly<Record<IconName, string>> = {
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3.2-6 7-6s7 2 7 6"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><circle cx="17" cy="9.5" r="2.5"/><path d="M3 19c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5"/><path d="M15.5 14.2c3 .2 5.5 1.8 5.5 4.8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.2"/>',
  loop: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M20 4v5h-5"/><path d="M4 20v-5h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  scale: '<path d="M12 4v16M8 20h8M4 8h16"/><path d="M4 8l-2.5 6h5zM20 8l-2.5 6h5z"/>',
  funnel: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10"/><path d="M18 11c0 4-6 3-12 6"/>',
  flag: '<path d="M5 21V4"/><path d="M5 5h12l-2 4 2 4H5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  table: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 10v9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1.5 5-1.5 5 0s-5 1.5-5 3 5 1.5 5 0"/>',
  code: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

export const iconSvg = (name: IconName): string =>
  `<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${ICONS[name]}</svg></span>`;

const decorAttrs = (d: BlockDecor | undefined) => d?.attrs ?? {};

/** Text-free decorative art inside a container: an aria-hidden SVG after the body (zero words). */
const artSvg = (b: Container): string =>
  b.art ? `<svg class="art" viewBox="${esc(b.art.viewBox)}" aria-hidden="true" focusable="false">${b.art.svg}</svg>` : '';

/** Icon-only link rail inside a container. Each link has an accessible name and no visible text. */
const linksHtml = (b: Container): string =>
  b.links?.length
    ? `<div class="links" role="group" aria-label="Further reading">` +
      b.links
        .map(
          (l) =>
            `<a class="lico" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(l.label)}">` +
            `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[l.icon]}</svg></a>`,
        )
        .join('') +
      `</div>`
    : '';

function renderContainer(slide: Slide, b: Container, index: number, hooks: WidgetRenderHooks | undefined): string {
  const d = hooks?.block?.(slide, b, index);
  const a = attrs({
    class: cx(b.kind, b.tone && `tone-${b.tone}`, b.icon && 'has-icon', b.art && 'has-art', Boolean(b.links?.length) && 'has-links', ...(d?.classes ?? [])),
    'data-key': blockKey(b),
    'data-stage': b.stage,
    'data-hl': b.hl,
    ...decorAttrs(d),
  });
  return `<div${a}>${b.icon ? iconSvg(b.icon) : ''}<h3>${esc(b.head)}</h3><p>${esc(b.body)}</p>${artSvg(b)}${linksHtml(b)}${d?.inner ?? ''}</div>`;
}

function renderTable(slide: Slide, t: TableBlock, hooks: WidgetRenderHooks | undefined): string {
  const header = t.header !== false;
  const row = (cells: string[], r: number): string => {
    const isHead = header && r === 0;
    const rd = hooks?.row?.(slide, r, cells[0] ?? '');
    const tds = cells
      .map((text, c) => {
        const cd = hooks?.cell?.(slide, r, c, text);
        const classes = cx(...(cd?.classes ?? []));
        const a = attrs({ class: classes || undefined, ...decorAttrs(cd) });
        if (isHead) return `<th scope="col"${a}>${esc(text)}</th>`;
        return c === 0 ? `<th scope="row"${a}>${esc(text)}</th>` : `<td${a}>${esc(text)}</td>`;
      })
      .join('');
    return `<tr${attrs({ class: cx(...(rd?.classes ?? [])) || undefined, ...decorAttrs(rd) })}>${tds}</tr>`;
  };
  const head = header && t.rows[0] ? `<thead>${row(t.rows[0], 0)}</thead>` : '';
  const body = t.rows
    .slice(header ? 1 : 0)
    .map((cells, i) => row(cells, i + (header ? 1 : 0)))
    .join('');
  return `<table${attrs({ class: 'grid', 'aria-label': t.label })}>${head}<tbody>${body}</tbody></table>`;
}

function renderChip(slide: Slide, c: ChipBlock, index: number, hooks: WidgetRenderHooks | undefined): string {
  const d = hooks?.chip?.(slide, c, index);
  const a = attrs({ type: 'button', class: cx('chip', ...(d?.classes ?? [])), 'data-key': blockKey(c), ...decorAttrs(d) });
  return `<button${a}>${esc(c.text)}</button>`;
}

const renderLabel = (l: LabelBlock): string => `<span class="label" data-key="${esc(blockKey(l))}">${esc(l.text)}</span>`;

/** Render blocks in reading order, wrapping runs of chips and labels so layouts can place them as a group. */
function renderBlocks(slide: Slide, blocks: Block[], hooks: WidgetRenderHooks | undefined): string {
  let out = '';
  let chipIndex = 0;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i] as Block;
    if (isChip(b)) {
      let run = '';
      while (i < blocks.length && isChip(blocks[i] as Block)) run += renderChip(slide, blocks[i++] as ChipBlock, chipIndex++, hooks);
      out += `<div class="chips" role="group">${run}</div>`;
    } else if (isLabel(b)) {
      let run = '';
      while (i < blocks.length && isLabel(blocks[i] as Block)) run += renderLabel(blocks[i++] as LabelBlock);
      out += `<div class="labels">${run}</div>`;
    } else if (isContainer(b)) {
      out += renderContainer(slide, b, i, hooks);
      i += 1;
    } else if (isTable(b)) {
      out += renderTable(slide, b, hooks);
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

function renderDiagram(slide: Slide): string {
  const d = slide.diagram;
  if (!d) return '';
  const a = d.decorative
    ? attrs({ viewBox: d.viewBox, 'aria-hidden': 'true', focusable: 'false' })
    : attrs({ viewBox: d.viewBox, role: 'img', 'aria-label': d.title, focusable: 'false' });
  return `<figure class="diagram" data-diagram="${esc(d.id)}"><svg${a}>${d.svg}</svg></figure>`;
}

/** The `<section class="slide">` for slide number `n` (1-based). Slide 1 is `active` in the static markup. */
export function renderSlideSection(slide: Slide, n: number, opts: { active?: boolean } = {}): string {
  const hooks = hooksFor(slide);
  const active = opts.active ?? n === 1;
  const rootAttrs = attrs({
    class: cx('slide', active && 'active'),
    id: `s${n}`,
    'data-id': slide.id,
    'data-n': n,
    'data-module': slide.moduleCode,
    'data-layout': slide.layout,
    'data-has-diagram': slide.diagram ? 'true' : 'false',
    'data-density-exempt': slide.exempt,
    'aria-roledescription': 'slide',
    'aria-label': `Slide ${n}: ${slide.title}`,
    'aria-hidden': active ? undefined : 'true',
    inert: active ? undefined : true,
    ...(hooks?.root?.(slide) ?? {}),
  });

  const head =
    `<header class="slide-head">` +
    (slide.kicker ? `<p class="kicker">${esc(slide.kicker)}</p>` : '') +
    `<h1>${esc(slide.title)}</h1>` +
    (slide.lead ? `<p class="lead">${esc(slide.lead)}</p>` : '') +
    `</header>`;

  const stat = slide.stat ? (hooks?.stat?.(slide) ?? `<p class="stat">${esc(slide.stat)}</p>`) : '';
  const body =
    `<div class="slide-body">` +
    renderDiagram(slide) +
    (hooks?.prelude?.(slide) ?? '') +
    renderBlocks(slide, slide.blocks, hooks) +
    (hooks?.coda?.(slide) ?? '') +
    stat +
    `</div>`;
  const note = slide.note ? `<p class="note">${esc(slide.note)}</p>` : '';

  return `<section${rootAttrs}>${head}${body}${note}</section>`;
}


export function renderStage(deck: Deck): string {
  return deck.slides.map((s, i) => renderSlideSection(s, i + 1)).join('\n');
}
