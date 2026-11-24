/**
 * Searchable, printable full-session Script Book (`#/script`, `#/script/<slide-id>`; press R in the deck).
 *
 * One clean document: a sticky module outline, then every slide with its presenter badge, purpose,
 * "The room sees" summary, word-for-word SAY and CUE beats (optional "If needed" drawers expanded) and
 * sources. Search filters and highlights; Print produces one slide per page. It is generated from the
 * same model as the speaker view and `docs/SPEAKER-SCRIPT.md`, so the three cannot disagree.
 */

import type { Deck, Slide } from '../content/types';
import { esc } from '../content/html';
import type { ShellContext, View } from './deck';
import { deckHash, scriptHash, type Route } from './router';
import { presenterBadgeHtml, renderBeatsHtml, renderSourcesHtml } from './script';
import { renderRoomSees } from './room';
import { DECK_WINDOW } from './constants';

const EMBLEM =
  '<svg class="ms-emblem" viewBox="0 0 23 23" aria-hidden="true" focusable="false"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>';

const articleHtml = (s: Slide, n: number): string =>
  `<header class="bk-slide-head"><span class="bk-n">Slide ${n}</span><code class="bk-id">${esc(s.id)}</code>${presenterBadgeHtml(s)}</header>` +
  `<h3>${esc(s.title)}</h3>` +
  `<p class="bk-purpose">${esc(s.purpose)}</p>` +
  renderRoomSees(s) +
  `<div class="bk-script">${renderBeatsHtml(s, { openDrawers: true })}</div>` +
  renderSourcesHtml(s);

/** Wrap case-insensitive matches of `q` in `<mark>` inside text nodes only (never inside markup). */
function highlight(root: HTMLElement, q: string): number {
  const needle = q.toLowerCase();
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.toLowerCase().includes(needle) && !n.parentElement?.closest('button, pre, mark') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let from = 0;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
      frag.append(text.slice(from, at));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(at, at + needle.length);
      frag.append(mark);
      from = at + needle.length;
      count += 1;
    }
    frag.append(text.slice(from));
    node.replaceWith(frag);
  }
  return count;
}

export function mountScriptBook(deck: Deck, ctx: ShellContext, initial: Extract<Route, { kind: 'script' }>): View {
  const root = document.getElementById('book-root') as HTMLElement;
  const slides = deck.slides;

  const outline = deck.modules
    .map((m) => {
      const items = slides
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.moduleCode === m.code)
        .map(({ s, i }) => `<li><a href="${scriptHash(s.id)}" data-go="${esc(s.id)}"><span class="bk-ol-n">${i + 1}</span> ${esc(s.title)}</a></li>`)
        .join('');
      return `<section><h2><span class="bk-code">${m.code}</span> ${esc(m.title)}</h2><ol>${items}</ol></section>`;
    })
    .join('');

  const content = deck.modules
    .map((m) => {
      const arts = slides
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.moduleCode === m.code)
        .map(({ s, i }) => `<article class="bk-slide" id="bk-${esc(s.id)}" data-id="${esc(s.id)}">${articleHtml(s, i + 1)}</article>`)
        .join('');
      return `<section class="bk-module" data-module="${m.code}"><h2 class="bk-module-title"><span class="bk-code">${m.code}</span> ${esc(m.title)}</h2><p class="muted">${esc(m.summary)}</p>${arts}</section>`;
    })
    .join('');

  root.innerHTML = `
<div class="bk" id="book">
  <header class="bk-top">
    <div class="bk-brand">${EMBLEM}<strong>Script Book</strong><span class="muted">${esc(deck.meta.title)} \u00b7 ${esc(deck.meta.event)}</span></div>
    <div class="bk-tools">
      <label class="bk-search"><span class="sr-only">Search the script</span><input id="bk-q" type="search" placeholder="Search the script  ( / )" autocomplete="off"></label>
      <output id="bk-count" class="muted" aria-live="polite"></output>
      <button type="button" id="bk-print" class="btn">Print</button>
      <button type="button" id="bk-deck" class="btn">Open deck</button>
      <button type="button" id="bk-theme" class="btn btn-sm">Theme <kbd>T</kbd></button>
    </div>
  </header>
  <div class="bk-main">
    <nav class="bk-outline" aria-label="Script outline">${outline}</nav>
    <main class="bk-content">${content}<p id="bk-none" class="bk-none" hidden>No slide matches that search.</p></main>
  </div>
</div>`;

  const q = root.querySelector<HTMLInputElement>('#bk-q') as HTMLInputElement;
  const count = root.querySelector<HTMLElement>('#bk-count') as HTMLElement;
  const none = root.querySelector<HTMLElement>('#bk-none') as HTMLElement;
  const arts = Array.from(root.querySelectorAll<HTMLElement>('.bk-slide'));
  const original = new Map(arts.map((a) => [a, a.innerHTML]));
  const modules = Array.from(root.querySelectorAll<HTMLElement>('.bk-module'));

  const disposers: Array<() => void> = [];
  const on = (el: EventTarget, ev: string, fn: (e: never) => void) => {
    el.addEventListener(ev, fn as unknown as EventListener);
    disposers.push(() => el.removeEventListener(ev, fn as unknown as EventListener));
  };

  function applySearch(): void {
    const query = q.value.trim();
    let shown = 0;
    let marks = 0;
    for (const a of arts) {
      a.innerHTML = original.get(a) as string;
      const hit = !query || (a.textContent ?? '').toLowerCase().includes(query.toLowerCase());
      a.hidden = !hit;
      if (hit) shown += 1;
      if (hit && query) marks += highlight(a, query);
    }
    for (const m of modules) m.hidden = !m.querySelector('.bk-slide:not([hidden])');
    none.hidden = shown > 0;
    count.textContent = query ? `${marks} match${marks === 1 ? '' : 'es'} in ${shown} of ${arts.length} slides` : `${arts.length} slides`;
  }
  count.textContent = `${arts.length} slides`;
  on(q, 'input', applySearch);

  let currentId: string | null = initial.id;
  const scrollTo = (id: string | null) => {
    currentId = id;
    const target = id ? root.querySelector<HTMLElement>(`#bk-${CSS.escape(id)}`) : null;
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    for (const a of arts) a.classList.toggle('is-target', a === target);
  };

  on(root.querySelector('.bk-outline') as HTMLElement, 'click', (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-go]');
    if (!a) return;
    e.preventDefault();
    const id = a.dataset.go as string;
    if (q.value) {
      q.value = '';
      applySearch();
    }
    history.replaceState(null, '', scriptHash(id));
    scrollTo(id);
  });
  on(root.querySelector('#bk-print') as HTMLElement, 'click', () => window.print());
  on(root.querySelector('#bk-theme') as HTMLElement, 'click', () => ctx.toggleTheme());
  on(root.querySelector('#bk-deck') as HTMLElement, 'click', () => {
    window.open(location.href.split('#')[0] + deckHash(currentId ?? (slides[0] as Slide).id), DECK_WINDOW);
  });
  on(root, 'click', (e: MouseEvent) => {
    const copy = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (!copy) return;
    const code = copy.closest('.code')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code).then(
      () => ctx.announce('Copied.'),
      () => ctx.announce('Copy failed. Select the text and copy it manually.'),
    );
  });
  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const typing = Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
    if (e.key === 'Escape' && typing && q.value) {
      q.value = '';
      applySearch();
    } else if (!typing && e.key === '/') {
      e.preventDefault();
      q.focus();
    } else if (!typing && e.key.toLowerCase() === 't') ctx.toggleTheme();
  });

  scrollTo(initial.id);

  return {
    onRoute(r) {
      if (r.kind === 'script') scrollTo(r.id);
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      root.replaceChildren();
    },
  };
}
