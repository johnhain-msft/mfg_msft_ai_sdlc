/**
 * Runtime entry. One page, three views, chosen by the hash:
 *
 *   #/<slide-id> | #/<n> | #/s<n> | #s<n>      audience deck (default)
 *   #/speaker[/<ref>]                           speaker view
 *   #/script[/<ref>]  (alias #/book)            script book
 *
 * The page ships with every slide pre-rendered in `#stage`. This file only upgrades it.
 */

import { deck } from '../content';
import { createBus } from './bus';
import { THEME_KEY } from './constants';
import { mountDeck, type ShellContext, type View } from './deck';
import { parseHash, type Route } from './router';
import { mountScriptBook } from './scriptbook';
import { mountSpeaker } from './speaker';

const ids = deck.slides.map((s) => s.id);
const bus = createBus();

const live = document.getElementById('live') as HTMLElement;
function announce(message: string): void {
  live.textContent = '';
  if (message) setTimeout(() => (live.textContent = message), 30);
}

function toggleTheme(): void {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* the choice just will not persist */
  }
  announce(`${next === 'dark' ? 'Dark' : 'Light'} theme.`);
}

const ctx: ShellContext = { bus, announce, toggleTheme };

const presentation = document.getElementById('presentation') as HTMLElement;
const speakerRoot = document.getElementById('speaker-root') as HTMLElement;
const bookRoot = document.getElementById('book-root') as HTMLElement;

let current: { kind: Route['kind']; view: View } | null = null;

function mount(route: Route): void {
  current?.view.dispose();
  presentation.hidden = route.kind !== 'deck';
  speakerRoot.hidden = route.kind !== 'speaker';
  bookRoot.hidden = route.kind !== 'script';
  document.body.dataset.view = route.kind === 'script' ? 'book' : route.kind;
  const view =
    route.kind === 'deck' ? mountDeck(deck, ctx, route) : route.kind === 'speaker' ? mountSpeaker(deck, ctx, route) : mountScriptBook(deck, ctx, route);
  current = { kind: route.kind, view };
}

window.addEventListener('hashchange', () => {
  const route = parseHash(location.hash, ids);
  if (current && current.kind === route.kind) current.view.onRoute(route);
  else mount(route);
});

mount(parseHash(location.hash, ids));
