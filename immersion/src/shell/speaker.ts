/**
 * Synchronized dual-screen Speaker View (`#/speaker/<slide-id>`, press S in the deck).
 *
 * Shows the presenter badge, "The room sees", live miniatures of the current and next slide
 * (clones of the pre-rendered sections, with the deck's step and widget state mirrored), large-type
 * SAY paragraphs and distinct CUE cards, a J/K beat tracker, collapsible "If needed" drawers,
 * A-/A+ text size, and an optional elapsed stopwatch.
 *
 * The stopwatch only counts up. There is no pace target, no words-per-minute reading, no
 * countdown and no alert: humans manage pacing in the room.
 *
 * Sync is bidirectional over `bus`: this window sends commands (next, prev, first, last, goto); the
 * deck answers with its state. Navigation is also applied locally, so the script stays browsable
 * when no deck window is connected yet.
 */

import type { Deck, Slide } from '../content/types';
import { esc } from '../content/html';
import { mountSlide, type SlideInteractions } from '../widgets';
import { readLastState, type Command, type Msg, type StateMsg } from './bus';
import { DECK_WINDOW, FONT_KEY, SCRIPT_WINDOW, WATCH_KEY } from './constants';
import type { ShellContext, View } from './deck';
import { fitStage } from './fit';
import { renderRoomSees } from './room';
import { deckHash, scriptHash, speakerHash, type Route } from './router';
import { presenterBadgeHtml, renderBeatsHtml, renderSourcesHtml } from './script';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const $ = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`speaker: missing ${sel}`);
  return el;
};

interface Watch {
  running: boolean;
  startedAt: number | null;
  accumulated: number;
}

const readWatch = (): Watch => {
  try {
    return { running: false, startedAt: null, accumulated: 0, ...(JSON.parse(localStorage.getItem(WATCH_KEY) ?? 'null') as Partial<Watch> | null) };
  } catch {
    return { running: false, startedAt: null, accumulated: 0 };
  }
};
const elapsed = (w: Watch): number => w.accumulated + (w.running && w.startedAt ? Date.now() - w.startedAt : 0);
const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:${pad(m)}` : pad(m)}:${pad(s % 60)}`;
};

const EMBLEM =
  '<svg class="ms-emblem" viewBox="0 0 23 23" aria-hidden="true" focusable="false"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>';

export function mountSpeaker(deck: Deck, ctx: ShellContext, initial: Extract<Route, { kind: 'speaker' }>): View {
  const root = document.getElementById('speaker-root') as HTMLElement;
  const slides = deck.slides;
  const ids = slides.map((s) => s.id);
  const total = slides.length;

  root.innerHTML = `
<div class="sp" id="speaker" style="--sp-font:26px">
  <header class="sp-top">
    <div class="sp-brand">${EMBLEM}<strong>Speaker view</strong><span class="muted">${esc(deck.meta.title)}</span></div>
    <div class="sp-tools">
      <span id="sp-sync" class="sp-sync" role="status">Waiting for the audience deck\u2026</span>
      <button type="button" id="sp-open-deck" class="btn">Open audience deck</button>
      <button type="button" id="sp-open-script" class="btn">Script book <kbd>R</kbd></button>
      <span class="sp-watch" role="group" aria-label="Optional stopwatch">
        <output id="sp-watch" aria-label="Elapsed time">00:00</output>
        <button type="button" id="sp-watch-toggle" class="btn btn-sm">Start</button>
        <button type="button" id="sp-watch-reset" class="btn btn-sm">Reset</button>
      </span>
      <span class="sp-font" role="group" aria-label="Text size">
        <button type="button" id="sp-font-dec" class="btn btn-sm" aria-label="Smaller text">A\u2212</button>
        <button type="button" id="sp-font-inc" class="btn btn-sm" aria-label="Larger text">A+</button>
      </span>
      <button type="button" id="sp-theme" class="btn btn-sm">Theme <kbd>T</kbd></button>
    </div>
  </header>
  <div class="sp-body">
    <section class="sp-left" aria-label="Slide previews">
      <div class="sp-frame" id="sp-current" aria-hidden="true"></div>
      <div class="sp-nav">
        <button type="button" id="sp-prev" class="btn">\u2039 Back</button>
        <span id="sp-counter" class="counter"></span>
        <button type="button" id="sp-next" class="btn">Next \u203a</button>
      </div>
      <div class="sp-next">
        <h3>Up next</h3>
        <div class="sp-frame sp-frame-small" id="sp-next-frame" aria-hidden="true"></div>
        <p id="sp-next-title" class="muted"></p>
      </div>
    </section>
    <section class="sp-right" aria-label="Script">
      <div class="sp-head">
        <div id="sp-badge"></div>
        <h2 id="sp-title"></h2>
        <p id="sp-module" class="muted"></p>
        <p id="sp-purpose" class="sp-purpose"></p>
      </div>
      <div id="sp-room"></div>
      <div id="sp-script" class="sp-script"></div>
      <div id="sp-sources"></div>
      <p class="sp-keys muted"><kbd>J</kbd> <kbd>K</kbd> beat \u00b7 <kbd>\u2192</kbd> <kbd>Space</kbd> next slide \u00b7 <kbd>\u2190</kbd> back \u00b7 <kbd>+</kbd> <kbd>\u2212</kbd> text size</p>
    </section>
  </div>
</div>`;

  const disposers: Array<() => void> = [];
  const onEl = (el: Element | Document | Window, ev: string, fn: (e: never) => void) => {
    el.addEventListener(ev, fn as unknown as EventListener);
    disposers.push(() => el.removeEventListener(ev, fn as unknown as EventListener));
  };

  const frameCur = $<HTMLElement>(root, '#sp-current');
  const frameNext = $<HTMLElement>(root, '#sp-next-frame');
  const scriptEl = $<HTMLElement>(root, '#sp-script');
  const syncEl = $<HTMLElement>(root, '#sp-sync');

  // ------------------------------------------------------------------ position
  let pos = { id: initial.id, step: 0 };
  let lastState: StateMsg | null = readLastState();
  if (lastState && ids.includes(lastState.id)) pos = { id: lastState.id, step: lastState.step };
  else lastState = null;

  const stepTotalOf = (s: Slide): number => (s.widget?.kind === 'staged' && s.widget.mode === 'steps' ? s.widget.stages.length : 0);
  const indexOf = (id: string): number => Math.max(0, ids.indexOf(id));

  // ------------------------------------------------------------------ previews
  interface Preview {
    id: string;
    handle: SlideInteractions;
    stop: () => void;
  }
  let curPrev: Preview | null = null;
  let nextPrev: Preview | null = null;

  function buildPreview(frame: HTMLElement, slide: Slide): Preview | null {
    frame.replaceChildren();
    const src = document.querySelector<HTMLElement>(`#stage .slide[data-id="${slide.id}"]`);
    if (!src) return null;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.removeAttribute('id');
    for (const n of clone.querySelectorAll('[id]')) n.removeAttribute('id');
    clone.classList.add('active');
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    const fitBox = document.createElement('div');
    fitBox.className = 'stage-fit';
    fitBox.appendChild(clone);
    frame.appendChild(fitBox);
    const stop = fitStage(frame, fitBox);
    const handle = mountSlide(clone, slide, { interactive: false, announce: () => undefined, changed: () => undefined });
    return { id: slide.id, handle, stop };
  }
  const disposePreview = (p: Preview | null) => {
    p?.stop();
    p?.handle.dispose();
  };

  // ------------------------------------------------------------------ beats
  let beatIdx = -1;
  const visibleBeats = (): HTMLElement[] =>
    Array.from(scriptEl.querySelectorAll<HTMLElement>('.beat')).filter((b) => !b.closest('details:not([open])'));
  const markBeat = (el: HTMLElement | null, scroll = true) => {
    for (const b of scriptEl.querySelectorAll('.beat.is-current')) b.classList.remove('is-current');
    if (!el) return;
    el.classList.add('is-current');
    beatIdx = visibleBeats().indexOf(el);
    if (scroll) el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const stepBeat = (delta: 1 | -1) => {
    const beats = visibleBeats();
    if (!beats.length) return;
    const nextIdx = clamp(beatIdx + delta, 0, beats.length - 1);
    markBeat(beats[nextIdx] ?? null);
  };

  onEl(scriptEl, 'click', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const copy = t.closest<HTMLElement>('[data-copy]');
    if (copy) {
      const code = copy.closest('.code')?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard?.writeText(code).then(
        () => ctx.announce('Copied.'),
        () => ctx.announce('Copy failed. Select the text and copy it manually.'),
      );
      return;
    }
    const beat = t.closest<HTMLElement>('.beat');
    if (beat) markBeat(beat, false);
  });

  // ------------------------------------------------------------------ render
  let renderedId = '';
  function render(): void {
    const slide = slides[indexOf(pos.id)] as Slide;
    const i = indexOf(pos.id);
    const nxt = slides[i + 1];

    if (renderedId !== slide.id) {
      renderedId = slide.id;
      $<HTMLElement>(root, '#sp-badge').innerHTML = presenterBadgeHtml(slide);
      $<HTMLElement>(root, '#sp-title').textContent = `${i + 1}. ${slide.title}`;
      const mod = deck.modules.find((m) => m.code === slide.moduleCode);
      $<HTMLElement>(root, '#sp-module').textContent = `${slide.moduleCode} \u00b7 ${mod?.title ?? ''}`;
      $<HTMLElement>(root, '#sp-purpose').textContent = slide.purpose;
      $<HTMLElement>(root, '#sp-room').innerHTML = renderRoomSees(slide);
      scriptEl.innerHTML = renderBeatsHtml(slide, { trackable: true });
      $<HTMLElement>(root, '#sp-sources').innerHTML = renderSourcesHtml(slide);
      scriptEl.scrollTop = 0;
      beatIdx = -1;
      disposePreview(curPrev);
      disposePreview(nextPrev);
      curPrev = buildPreview(frameCur, slide);
      nextPrev = nxt ? buildPreview(frameNext, nxt) : null;
      if (!nxt) frameNext.replaceChildren();
      $<HTMLElement>(root, '#sp-next-title').textContent = nxt ? `${i + 2}. ${nxt.title}` : 'End of deck';
      document.title = `Speaker \u00b7 ${i + 1}. ${slide.title}`;
    }
    curPrev?.handle.setStep(pos.step);
    if (lastState && lastState.id === slide.id && lastState.widget !== null) curPrev?.handle.setState(lastState.widget);
    $<HTMLElement>(root, '#sp-counter').textContent = `${i + 1} / ${total}${stepTotalOf(slide) ? ` \u00b7 step ${pos.step}/${stepTotalOf(slide)}` : ''}`;
    const hash = speakerHash(slide.id);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  // ------------------------------------------------------------------ commands
  const send = (cmd: Command, id?: string): void => {
    ctx.bus.send(id ? { type: 'cmd', cmd, id } : { type: 'cmd', cmd });
  };
  function localNav(cmd: Command): void {
    const s = slides[indexOf(pos.id)] as Slide;
    const i = indexOf(pos.id);
    if (cmd === 'next') {
      if (pos.step < stepTotalOf(s)) pos = { id: s.id, step: pos.step + 1 };
      else if (i < total - 1) pos = { id: ids[i + 1] as string, step: 0 };
    } else if (cmd === 'prev') {
      if (pos.step > 0) pos = { id: s.id, step: pos.step - 1 };
      else if (i > 0) pos = { id: ids[i - 1] as string, step: stepTotalOf(slides[i - 1] as Slide) };
    } else if (cmd === 'first') pos = { id: ids[0] as string, step: 0 };
    else if (cmd === 'last') pos = { id: ids[total - 1] as string, step: 0 };
    lastState = null;
    render();
  }
  const navigate = (cmd: Command): void => {
    localNav(cmd);
    send(cmd);
  };

  onEl($(root, '#sp-prev'), 'click', () => navigate('prev'));
  onEl($(root, '#sp-next'), 'click', () => navigate('next'));
  onEl($(root, '#sp-theme'), 'click', () => ctx.toggleTheme());

  const baseUrl = (): string => location.href.split('#')[0] as string;
  function openDeck(): void {
    const w = window.open(baseUrl() + deckHash(pos.id, pos.step), DECK_WINDOW);
    if (!w) return ctx.announce('The browser blocked the deck window. Allow pop-ups for this page and try again.');
    ctx.bus.setPeer(w);
    for (const ms of [500, 1500]) setTimeout(() => ctx.bus.send({ type: 'hello', role: 'speaker' }), ms);
  }
  const openScript = (): void => void window.open(baseUrl() + scriptHash(pos.id), SCRIPT_WINDOW);
  onEl($(root, '#sp-open-deck'), 'click', openDeck);
  onEl($(root, '#sp-open-script'), 'click', openScript);

  // ------------------------------------------------------------------ font size
  const speaker = $<HTMLElement>(root, '#speaker');
  let font = 26;
  try {
    font = clamp(Number(localStorage.getItem(FONT_KEY)) || 26, 16, 56);
  } catch {
    /* default */
  }
  const applyFont = () => {
    speaker.style.setProperty('--sp-font', `${font}px`);
    try {
      localStorage.setItem(FONT_KEY, String(font));
    } catch {
      /* ignore */
    }
  };
  const bump = (d: number) => {
    font = clamp(font + d, 16, 56);
    applyFont();
  };
  applyFont();
  onEl($(root, '#sp-font-dec'), 'click', () => bump(-2));
  onEl($(root, '#sp-font-inc'), 'click', () => bump(2));

  // ------------------------------------------------------------------ stopwatch (count-up only)
  const watchOut = $<HTMLOutputElement>(root, '#sp-watch');
  const watchBtn = $<HTMLButtonElement>(root, '#sp-watch-toggle');
  const writeWatch = (w: Watch) => {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  };
  const tick = () => {
    const w = readWatch();
    watchOut.textContent = clock(elapsed(w));
    watchBtn.textContent = w.running ? 'Pause' : w.accumulated ? 'Resume' : 'Start';
  };
  onEl(watchBtn, 'click', () => {
    const w = readWatch();
    if (w.running) writeWatch({ running: false, startedAt: null, accumulated: elapsed(w) });
    else writeWatch({ running: true, startedAt: Date.now(), accumulated: w.accumulated });
    tick();
  });
  onEl($(root, '#sp-watch-reset'), 'click', () => {
    writeWatch({ running: false, startedAt: null, accumulated: 0 });
    tick();
  });
  const watchTimer = setInterval(tick, 500);
  disposers.push(() => clearInterval(watchTimer));
  tick();

  // ------------------------------------------------------------------ keyboard
  onEl(document, 'keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if ((e.key === ' ' || e.key === 'Enter') && t?.closest('button, a[href], summary, [role="button"]')) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') {
      e.preventDefault();
      navigate('next');
    } else if (k === 'ArrowLeft' || k === 'PageUp') {
      e.preventDefault();
      navigate('prev');
    } else if (k === 'Home') {
      e.preventDefault();
      navigate('first');
    } else if (k === 'End') {
      e.preventDefault();
      navigate('last');
    } else if (k === '+' || k === '=') bump(2);
    else if (k === '-' || k === '_') bump(-2);
    else {
      const lk = k.toLowerCase();
      if (lk === 'j') stepBeat(1);
      else if (lk === 'k') stepBeat(-1);
      else if (lk === 't') ctx.toggleTheme();
      else if (lk === 'r') openScript();
      else if (lk === 'o') openDeck();
    }
  });

  // ------------------------------------------------------------------ sync
  let heard = false;
  disposers.push(
    ctx.bus.on((m: Msg) => {
      if (m.type !== 'state' || !ids.includes(m.id)) return;
      heard = true;
      lastState = m;
      pos = { id: m.id, step: m.step };
      syncEl.textContent = 'Synchronized with the audience deck';
      syncEl.dataset.state = 'live';
      render();
    }),
  );
  if (window.opener && window.opener !== window) ctx.bus.setPeer(window.opener as Window);
  ctx.bus.send({ type: 'hello', role: 'speaker' });
  const lateHello = setTimeout(() => {
    if (!heard) {
      syncEl.textContent = lastState ? 'Showing the last known position. Waiting for the deck\u2026' : 'No deck answered yet. Open the audience deck.';
      syncEl.dataset.state = 'waiting';
      ctx.bus.send({ type: 'hello', role: 'speaker' });
    }
  }, 1500);
  disposers.push(() => clearTimeout(lateHello));

  render();

  return {
    onRoute(r) {
      if (r.kind === 'speaker' && ids.includes(r.id) && r.id !== pos.id) {
        pos = { id: r.id, step: 0 };
        lastState = null;
        render();
      }
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      disposePreview(curPrev);
      disposePreview(nextPrev);
      root.replaceChildren();
    },
  };
}
