/**
 * The page: the single self-contained `dist/index.html` document.
 *
 * (This file is `page.ts`, not `template.ts`, on purpose: the repo's .gitignore has `TEMP*`, which git on
 * Windows matches case-insensitively, so a `template.ts` would be silently left out of every commit.)
 *
 * Layout of the page:
 *   #presentation   audience deck: brand header, #stage with every pre-rendered slide, footer
 *   #speaker-root   speaker view (mounted on demand)
 *   #book-root      script book (mounted on demand)
 *   <dialog>s       module map, glossary & cheat sheet, keyboard help
 *
 * All brand chrome (Microsoft emblem, counter, navigation, footer) lives OUTSIDE every
 * `<section class="slide">`, so chrome words are never counted in a slide's word budget.
 */

import { esc } from '../content/html';
import type { Deck } from '../content/types';
import { STORAGE_PREFIX } from './constants';
import { renderStage } from './render';
/** Official Microsoft four-square emblem. */
const EMBLEM =
  '<svg class="ms-emblem" viewBox="0 0 23 23" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>' +
  '<rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>';

const kbd = (k: string) => `<kbd>${k}</kbd>`;

const HELP_ROWS: Array<[string, string]> = [
  [`${kbd('\u2192')} ${kbd('Space')} ${kbd('PgDn')}`, 'Next. On a staged slide this steps the highlight first.'],
  [`${kbd('\u2190')} ${kbd('PgUp')}`, 'Previous step or slide'],
  [`${kbd('Home')} ${kbd('End')}`, 'First or last slide'],
  [`${kbd('1')}\u2013${kbd('9')} then ${kbd('Enter')}`, 'Go to a slide number. On a widget slide the digits drive the widget; use the map instead.'],
  [`${kbd('A')} or ${kbd('G')}`, 'Module map and overview (press again to close)'],
  [kbd('C'), 'Glossary and cheat sheet'],
  [kbd('M'), 'Read-Along script panel. Off automatically while presenting fullscreen.'],
  [kbd('S'), 'Speaker view in a second window, kept in sync'],
  [kbd('R'), 'Script Book in a new tab: searchable and printable'],
  [kbd('F'), 'Present fullscreen'],
  [`${kbd('B')} or ${kbd('.')}`, 'Blackout the screen'],
  [kbd('T'), 'Light or dark theme'],
  [kbd('?'), 'This help'],
  [kbd('Esc'), 'Close an overlay'],
];

const WIDGET_ROWS: Array<[string, string]> = [
  [`${kbd('1')}\u2013${kbd('4')}`, 'Prompt debugger: flip a cost lever. Gate selector: pick a failure. ' + kbd('0') + ' resets.'],
  [`${kbd('1')}\u2013${kbd('3')} ${kbd('Enter')}`, 'Room check: pick an option, then reveal the answer.'],
];

const row = ([k, v]: [string, string]) => `<div class="keys-k">${k}</div><div class="keys-v">${v}</div>`;

export interface DocumentInput {
  deck: Deck;
  css: string;
  js: string;
  /** Deterministic build stamp (content hash). Never a clock. */
  buildId?: string;
}

const safeInline = (s: string): string => s.replace(/<\/(script|style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

export function renderDocument({ deck, css, js, buildId }: DocumentInput): string {
  const { meta } = deck;
  const total = deck.slides.length;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(meta.title)} \u00b7 ${esc(meta.event)}</title>
<meta name="description" content="${esc(meta.subtitle)}. ${esc(meta.event)}. One file: the audience deck, a synchronized speaker view and a printable script book.">
${buildId ? `<meta name="generator" content="ai-sdlc-immersion-deck ${esc(buildId)}">\n` : ''}<script>(function(){try{if(localStorage.getItem('${STORAGE_PREFIX}:theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}})()</script>
<style>
${safeInline(css)}
</style>
</head>
<body>
<a class="skip-link" href="#deck">Skip to slides</a>
<noscript><p class="noscript">This presentation needs JavaScript. The slides below are the static copy.</p></noscript>

<div id="presentation">
  <header id="topbar" class="chrome">
    <div class="brand topbar-left">${EMBLEM}<span class="brand-name">Microsoft</span><span class="brand-sep" aria-hidden="true">\u00b7</span><span class="brand-product">Agentic SDLC Advisory</span></div>
    <div class="prepared">${esc(meta.event)} \u00b7 ${esc(meta.subtitle)}</div>
  </header>

  <main id="deck" aria-label="Slides" tabindex="-1">
    <div id="stage-area">
      <div id="stage">
${renderStage(deck)}
      </div>
    </div>
    <aside id="readalong" class="readalong" aria-label="Read-along script" hidden>
      <div class="ra-head"><span id="ra-badge" class="ra-badge"></span><button type="button" id="ra-close" class="btn btn-icon" aria-label="Close read-along">\u00d7</button></div>
      <p class="ra-warn">Presenter notes. Never share this panel with the room.</p>
      <div id="ra-body" class="ra-body"></div>
    </aside>
  </main>

  <footer id="bottombar" class="chrome">
    <div id="progress" aria-hidden="true"><div id="progress-bar"></div></div>
    <div class="bar-row">
      <div class="nav-buttons">
        <button type="button" id="btn-prev" class="btn btn-nav" data-nav="prev" aria-label="Previous slide">\u2039</button>
        <button type="button" id="btn-next" class="btn btn-nav" data-nav="next" aria-label="Next slide">\u203a</button>
        <span id="counter" class="counter" aria-live="off">1 / ${total}</span>
        <span id="module-chip" class="module-chip"></span>
      </div>
      <div class="toolbar" role="toolbar" aria-label="Presentation tools">
        <button type="button" id="btn-readalong" class="btn" aria-pressed="false" aria-label="Read-Along script (M)"><span class="lbl">Read-Along</span> ${kbd('M')}</button>
        <button type="button" id="btn-overview" class="btn" aria-haspopup="dialog" aria-label="Module map (A)"><span class="lbl">Map</span> ${kbd('A')}</button>
        <button type="button" id="btn-glossary" class="btn" aria-haspopup="dialog" aria-label="Glossary and cheat sheet (C)"><span class="lbl">Glossary</span> ${kbd('C')}</button>
        <button type="button" id="btn-speaker" class="btn" aria-label="Speaker view (S)"><span class="lbl">Speaker</span> ${kbd('S')}</button>
        <button type="button" id="btn-script" class="btn" aria-label="Script book (R)"><span class="lbl">Script</span> ${kbd('R')}</button>
        <button type="button" id="btn-theme" class="btn" aria-label="Toggle light and dark theme (T)"><span class="lbl">Theme</span> ${kbd('T')}</button>
        <button type="button" id="btn-present" class="btn" aria-label="Present fullscreen (F)"><span class="lbl">Present</span> ${kbd('F')}</button>
        <button type="button" id="btn-help" class="btn" aria-haspopup="dialog" aria-label="Keyboard shortcuts (?)">${kbd('?')}</button>
      </div>
    </div>
  </footer>

  <div id="blackout" hidden aria-hidden="true"></div>
</div>

<div id="speaker-root" hidden></div>
<div id="book-root" hidden></div>

<dialog id="dlg-overview" class="dlg dlg-wide" aria-labelledby="dlg-overview-title">
  <div class="dlg-head"><h2 id="dlg-overview-title">Module map</h2><form method="dialog"><button class="btn">Close</button></form></div>
  <div id="overview-grid" class="overview"></div>
</dialog>

<dialog id="dlg-glossary" class="dlg dlg-wide" aria-labelledby="dlg-glossary-title">
  <div class="dlg-head"><h2 id="dlg-glossary-title">AI-DLC glossary and cheat sheet</h2><form method="dialog"><button class="btn">Close</button></form></div>
  <input id="glossary-search" class="search" type="search" placeholder="Search terms" aria-label="Search glossary terms" autocomplete="off">
  <div id="glossary-list" class="glossary"></div>
</dialog>

<dialog id="dlg-help" class="dlg" aria-labelledby="dlg-help-title">
  <div class="dlg-head"><h2 id="dlg-help-title">Keyboard shortcuts</h2><form method="dialog"><button class="btn">Close</button></form></div>
  <div class="keys">${HELP_ROWS.map(row).join('')}</div>
  <h3 class="keys-sub">Widgets</h3>
  <div class="keys">${WIDGET_ROWS.map(row).join('')}</div>
</dialog>

<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>

<script>
${safeInline(js)}
</script>
</body>
</html>
`;
}
