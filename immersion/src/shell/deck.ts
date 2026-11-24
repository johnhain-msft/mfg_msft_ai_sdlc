/**
 * Audience deck: the default view.
 *
 * The pre-rendered `<section class="slide">` elements in `#stage` are adopted, never rebuilt. Only
 * the active section carries `.active` (and is visible, focusable and announced); the rest are
 * `aria-hidden` + `inert`. Routing is synchronous: `hashchange` flips `.active` before it returns,
 * so `location.hash = '#/3'` is visible to the next line of any driver script.
 *
 * Keys  Right / Space / PageDown   next (a staged slide steps its highlight first)
 *       Left / PageUp              previous
 *       Home / End                 first / last
 *       1-9 then Enter             go to slide N (digits drive the widget on widget slides)
 *       A or G  map   C  glossary   ?  help   M  read-along   S  speaker   R  script book
 *       F  present    B or .  blackout    T  theme    Esc  close
 *
 * Nothing in the script is ever rendered on the presentation surface; the Read-Along panel is a
 * separate, explicitly opened aside that is forced off while presenting fullscreen.
 */

import type { Deck, GlossaryGroup, ModuleCode, Slide } from '../content/types';
import { GLOSSARY_GROUPS, presenterLabel } from '../content/types';
import { esc } from '../content/html';
import { mountSlide, type SlideInteractions } from '../widgets';
import type { Bus, Msg, StateMsg } from './bus';
import { SCRIPT_WINDOW, SPEAKER_WINDOW } from './constants';
import { fitStage } from './fit';
import { renderRoomSees } from './room';
import { deckHash, scriptHash, speakerHash, type Route } from './router';
import { presenterBadgeHtml, renderBeatsHtml, renderSourcesHtml } from './script';

export interface ShellContext {
  bus: Bus;
  announce(message: string): void;
  toggleTheme(): void;
}

export interface View {
  dispose(): void;
  /** The hash changed to another route of the same kind. */
  onRoute(route: Route): void;
}

const GROUP_LABEL: Record<GlossaryGroup, string> = {
  prose: 'PROSE constraints',
  primitives: 'Primitives and the supply chain',
  'operating-model': 'Operating model',
  governance: 'Governance',
  metrics: 'Metrics and evals',
  quality: 'Quality gates',
  economics: 'Process and prompt economics',
  security: 'Security and guardrails',
};

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const isTextEntry = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/** A control that owns Space / Enter itself, so the deck must not advance. */
const ownsActivation = (t: EventTarget | null): boolean =>
  Boolean((t as HTMLElement | null)?.closest?.('button, a[href], summary, [role="button"], [role="switch"], [role="radio"], select, input, textarea, details'));

export function mountDeck(deck: Deck, ctx: ShellContext, initial: Extract<Route, { kind: 'deck' }>): View {
  const slides = deck.slides;
  const total = slides.length;
  const ids = slides.map((s) => s.id);
  const sections = slides.map((s) => $<HTMLElement>(`#stage .slide[data-id="${s.id}"]`));
  const stageArea = $<HTMLElement>('#stage-area');
  const stage = $<HTMLElement>('#stage');
  const body = document.body;

  const disposers: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(t: Document, ev: K, fn: (e: DocumentEventMap[K]) => void) => {
    t.addEventListener(ev, fn as EventListener);
    disposers.push(() => t.removeEventListener(ev, fn as EventListener));
  };
  const onEl = (el: HTMLElement, ev: string, fn: (e: Event) => void) => {
    el.addEventListener(ev, fn);
    disposers.push(() => el.removeEventListener(ev, fn));
  };

  let index = 0;
  let step = 0;
  let blackout = false;

  // ------------------------------------------------------------------ widgets
  const handles: SlideInteractions[] = slides.map((slide, i) =>
    mountSlide(sections[i] as HTMLElement, slide, {
      interactive: true,
      announce: ctx.announce,
      changed: () => {
        if (slides[index]?.id === slide.id) {
          step = handles[i]!.getStep();
          const hash = deckHash(slide.id, step);
          if (location.hash !== hash) history.replaceState(null, '', hash);
          broadcast();
        }
      },
    }),
  );
  disposers.push(() => handles.forEach((h) => h.dispose()));
  const handle = (): SlideInteractions => handles[index] as SlideInteractions;

  // ------------------------------------------------------------------ chrome
  const counter = $<HTMLElement>('#counter');
  const progress = $<HTMLElement>('#progress-bar');
  const moduleChip = $<HTMLElement>('#module-chip');
  const moduleTitle = (code: ModuleCode) => deck.modules.find((m) => m.code === code)?.title ?? '';

  const readalong = $<HTMLElement>('#readalong');
  const raBody = $<HTMLElement>('#ra-body');
  const raBadge = $<HTMLElement>('#ra-badge');
  const btnRead = $<HTMLButtonElement>('#btn-readalong');

  const presenting = (): boolean => Boolean(document.fullscreenElement);

  function renderReadAlong(): void {
    if (readalong.hidden) return;
    const s = slides[index] as Slide;
    raBadge.innerHTML = presenterBadgeHtml(s);
    raBody.innerHTML = renderRoomSees(s) + renderBeatsHtml(s, { openDrawers: false }) + renderSourcesHtml(s);
    raBody.scrollTop = 0;
  }

  function setReadAlong(open: boolean, say = true): void {
    if (open && presenting()) {
      ctx.announce('Read-Along stays off while presenting fullscreen, so the room never sees the script.');
      return;
    }
    readalong.hidden = !open;
    readalong.toggleAttribute('inert', !open);
    body.classList.toggle('readalong-on', open);
    btnRead.setAttribute('aria-pressed', String(open));
    if (open) renderReadAlong();
    if (say) ctx.announce(open ? 'Read-Along on. Presenter notes are visible in the side panel.' : 'Read-Along off.');
  }

  // ------------------------------------------------------------------ show
  function show(i: number, st: number, opts: { push?: boolean; say?: boolean } = {}): void {
    const ni = clamp(i, 0, total - 1);
    const h = handles[ni] as SlideInteractions;
    const ns = clamp(st, 0, h.steps);
    if (ni !== index || !sections[ni]?.classList.contains('active')) {
      const prev = sections[index];
      if (prev && index !== ni) {
        prev.classList.remove('active');
        prev.setAttribute('aria-hidden', 'true');
        prev.setAttribute('inert', '');
      }
      const next = sections[ni] as HTMLElement;
      next.classList.add('active');
      next.removeAttribute('aria-hidden');
      next.removeAttribute('inert');
      index = ni;
    }
    step = ns;
    if (h.steps > 0) h.setStep(ns);

    const s = slides[index] as Slide;
    counter.textContent = `${index + 1} / ${total}`;
    progress.style.width = `${total > 1 ? (index / (total - 1)) * 100 : 100}%`;
    moduleChip.textContent = `${s.moduleCode} \u00b7 ${moduleTitle(s.moduleCode)}`;
    document.title = `${index + 1}. ${s.title} \u00b7 ${deck.meta.title}`;
    if (opts.push !== false) {
      const hash = deckHash(s.id, step);
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }
    if (opts.say !== false) ctx.announce(`Slide ${index + 1} of ${total}: ${s.title}`);
    renderReadAlong();
    broadcast();
  }

  const next = (): void => {
    const h = handle();
    if (step < h.steps) show(index, step + 1, { say: false });
    else if (index < total - 1) show(index + 1, 0);
  };
  const prev = (): void => {
    if (step > 0) show(index, step - 1, { say: false });
    else if (index > 0) show(index - 1, (handles[index - 1] as SlideInteractions).steps);
  };

  // ------------------------------------------------------------------ bus
  function stateMsg(): StateMsg {
    const s = slides[index] as Slide;
    return {
      type: 'state',
      id: s.id,
      step,
      n: index + 1,
      total,
      stepTotal: handle().steps,
      blackout,
      widget: handle().hasWidget ? handle().getState() : null,
    };
  }
  function broadcast(): void {
    ctx.bus.send(stateMsg());
  }
  disposers.push(
    ctx.bus.on((m: Msg) => {
      if (m.type === 'hello') broadcast();
      else if (m.type === 'cmd') {
        if (m.cmd === 'next') next();
        else if (m.cmd === 'prev') prev();
        else if (m.cmd === 'first') show(0, 0);
        else if (m.cmd === 'last') show(total - 1, 0);
        else if (m.cmd === 'goto' && m.id && ids.includes(m.id)) show(ids.indexOf(m.id), m.step ?? 0);
      }
    }),
  );

  // ------------------------------------------------------------------ overlays
  const dlgOverview = $<HTMLDialogElement>('#dlg-overview');
  const dlgGlossary = $<HTMLDialogElement>('#dlg-glossary');
  const dlgHelp = $<HTMLDialogElement>('#dlg-help');
  const dialogs = [dlgOverview, dlgGlossary, dlgHelp];
  const openDialog = (): HTMLDialogElement | undefined => dialogs.find((d) => d.open);
  const closeDialogs = (): void => dialogs.forEach((d) => d.open && d.close());

  function toggleOverview(): void {
    if (dlgOverview.open) return dlgOverview.close();
    closeDialogs();
    const grid = $<HTMLElement>('#overview-grid');
    grid.innerHTML = deck.modules
      .map((m) => {
        const items = slides
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.moduleCode === m.code)
          .map(
            ({ s, i }) =>
              `<button type="button" class="ov-slide${i === index ? ' is-current' : ''}" data-go="${esc(s.id)}">` +
              `<span class="ov-n">${i + 1}</span><span class="ov-t">${esc(s.title)}</span>` +
              `<span class="ov-p">${esc(presenterLabel(s.presenter))}${s.widget ? ' \u00b7 interactive' : ''}</span></button>`,
          )
          .join('');
        return `<section class="ov-module"><h3><span class="ov-code">${m.code}</span> ${esc(m.title)}</h3><p>${esc(m.summary)}</p>${items}</section>`;
      })
      .join('');
    for (const b of grid.querySelectorAll<HTMLButtonElement>('.ov-slide')) {
      b.addEventListener('click', () => {
        dlgOverview.close();
        show(ids.indexOf(b.dataset.go as string), 0);
      });
    }
    dlgOverview.showModal();
    grid.querySelector<HTMLElement>('.is-current')?.focus();
  }

  const search = $<HTMLInputElement>('#glossary-search');
  const glossaryList = $<HTMLElement>('#glossary-list');
  function renderGlossary(query: string): void {
    const q = query.trim().toLowerCase();
    const hit = (g: Deck['glossary'][number]) =>
      !q || [g.term, g.definition, ...(g.aliases ?? [])].some((x) => x.toLowerCase().includes(q));
    const html = GLOSSARY_GROUPS.map((group) => {
      const entries = deck.glossary.filter((g) => g.group === group && hit(g));
      if (!entries.length) return '';
      return (
        `<section class="gl-group"><h3>${esc(GROUP_LABEL[group])}</h3><dl>` +
        entries
          .map(
            (g) =>
              `<dt>${esc(g.term)}</dt><dd>${esc(g.definition)}${
                g.source ? ` <a href="${esc(g.source.url)}" target="_blank" rel="noopener noreferrer">${esc(g.source.label)}</a>` : ''
              }</dd>`,
          )
          .join('') +
        `</dl></section>`
      );
    }).join('');
    glossaryList.innerHTML = html || `<p class="gl-empty">No terms match \u201c${esc(query)}\u201d.</p>`;
  }
  function toggleGlossary(): void {
    if (dlgGlossary.open) return dlgGlossary.close();
    closeDialogs();
    search.value = '';
    renderGlossary('');
    dlgGlossary.showModal();
    search.focus();
  }
  onEl(search, 'input', () => renderGlossary(search.value));

  const toggleHelp = (): void => {
    if (dlgHelp.open) return dlgHelp.close();
    closeDialogs();
    dlgHelp.showModal();
  };

  // ------------------------------------------------------------------ windows, theme, present, blackout
  const baseUrl = (): string => location.href.split('#')[0] as string;

  function openSpeaker(): void {
    const w = window.open(baseUrl() + speakerHash(slides[index]?.id ?? null), SPEAKER_WINDOW, 'popup=yes,width=1360,height=900');
    if (!w) return ctx.announce('The browser blocked the speaker window. Allow pop-ups for this page and press S again.');
    ctx.bus.setPeer(w);
    for (const ms of [400, 1200, 2500]) setTimeout(broadcast, ms);
    ctx.announce('Speaker view opened in a second window.');
  }
  function openScript(): void {
    const w = window.open(baseUrl() + scriptHash(slides[index]?.id ?? null), SCRIPT_WINDOW);
    if (!w) ctx.announce('The browser blocked the script book window. Allow pop-ups for this page and press R again.');
  }

  async function togglePresent(): Promise<void> {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      ctx.announce("Fullscreen is not available here. Use the browser's own fullscreen (F11).");
    }
  }
  on(document, 'fullscreenchange', () => {
    const p = presenting();
    body.classList.toggle('presenting', p);
    btnRead.disabled = p;
    if (p && !readalong.hidden) setReadAlong(false, false);
    ctx.announce(p ? 'Presenting fullscreen. Read-Along is off.' : 'Left fullscreen.');
  });

  const blackoutEl = $<HTMLElement>('#blackout');
  function setBlackout(b: boolean): void {
    blackout = b;
    blackoutEl.hidden = !b;
    broadcast();
  }

  // ------------------------------------------------------------------ keyboard
  let typed = '';
  let typedTimer: ReturnType<typeof setTimeout> | undefined;

  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // Escape always closes an overlay, even from the glossary search box (where it would otherwise only clear the field).
    if (e.key === 'Escape' && openDialog()) {
      e.preventDefault();
      closeDialogs();
      return;
    }
    if (isTextEntry(e.target)) return;
    const k = e.key;
    const lk = k.length === 1 ? k.toLowerCase() : k;

    const open = openDialog();
    if (open) {
      if (k === 'Escape' || (open === dlgOverview && (lk === 'a' || lk === 'g')) || (open === dlgGlossary && lk === 'c') || (open === dlgHelp && (k === '?' || k === '/'))) {
        e.preventDefault();
        open.close();
      }
      return;
    }
    if (blackout) {
      if (k === 'Escape' || lk === 'b' || k === '.') {
        e.preventDefault();
        setBlackout(false);
      }
      return;
    }

    if ((k === ' ' || k === 'Enter') && ownsActivation(e.target)) return;

    // The active widget gets first refusal (digits, Enter).
    if (handle().handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (handle().claimsDigits && /^[0-9]$/.test(k)) return;

    switch (k) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault();
        next();
        return;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        prev();
        return;
      case 'Home':
        e.preventDefault();
        show(0, 0);
        return;
      case 'End':
        e.preventDefault();
        show(total - 1, 0);
        return;
      case 'Enter':
        if (typed) {
          e.preventDefault();
          const n = parseInt(typed, 10);
          typed = '';
          if (n >= 1 && n <= total) show(n - 1, 0);
          else ctx.announce(`There is no slide ${n}.`);
        }
        return;
      case 'Escape':
        typed = '';
        return;
      case '?':
      case '/':
        e.preventDefault();
        toggleHelp();
        return;
      case '.':
        e.preventDefault();
        setBlackout(true);
        return;
      default:
    }
    if (/^[0-9]$/.test(k)) {
      typed = (typed + k).slice(-3);
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => (typed = ''), 2500);
      ctx.announce(`Go to slide ${typed}. Press Enter.`);
      return;
    }
    switch (lk) {
      case 'a':
      case 'g':
        e.preventDefault();
        return toggleOverview();
      case 'c':
        e.preventDefault();
        return toggleGlossary();
      case 'm':
        e.preventDefault();
        return setReadAlong(Boolean(readalong.hidden));
      case 's':
        e.preventDefault();
        return openSpeaker();
      case 'r':
        e.preventDefault();
        return openScript();
      case 'f':
        e.preventDefault();
        return void togglePresent();
      case 'b':
        e.preventDefault();
        return setBlackout(true);
      case 't':
        e.preventDefault();
        return ctx.toggleTheme();
      default:
    }
  });

  // ------------------------------------------------------------------ buttons and pointer
  onEl($('#btn-prev'), 'click', prev);
  onEl($('#btn-next'), 'click', next);
  onEl(btnRead, 'click', () => setReadAlong(Boolean(readalong.hidden)));
  onEl($('#ra-close'), 'click', () => setReadAlong(false));
  onEl($('#btn-overview'), 'click', toggleOverview);
  onEl($('#btn-glossary'), 'click', toggleGlossary);
  onEl($('#btn-speaker'), 'click', openSpeaker);
  onEl($('#btn-script'), 'click', openScript);
  onEl($('#btn-theme'), 'click', () => ctx.toggleTheme());
  onEl($('#btn-present'), 'click', () => void togglePresent());
  onEl($('#btn-help'), 'click', toggleHelp);

  // Presenting without a clicker: the right half of the stage advances, the left half goes back.
  onEl(stageArea, 'click', (e) => {
    if (!presenting()) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, [role="button"], [role="switch"], [role="radio"], [data-hl], summary')) return;
    const r = stageArea.getBoundingClientRect();
    if ((e as MouseEvent).clientX - r.left > r.width / 2) next();
    else prev();
  });

  // ------------------------------------------------------------------ routing and fit
  const stopFit = fitStage(stageArea, stage);
  disposers.push(stopFit);

  const route = (r: Extract<Route, { kind: 'deck' }>, opts: { push?: boolean; say?: boolean } = {}): void => {
    show(ids.indexOf(r.id), r.step, opts);
    if (r.unknown) ctx.announce(`There is no slide "${r.unknown}". Showing slide 1.`);
  };

  const view: View = {
    onRoute(r) {
      if (r.kind === 'deck') route(r, { push: false });
    },
    dispose() {
      closeDialogs();
      setReadAlong(false, false);
      setBlackout(false);
      body.classList.remove('presenting', 'readalong-on');
      for (const d of disposers.splice(0)) d();
      for (const s of sections) s.classList.remove('active');
    },
  };

  // Initial slide: the static markup marks slide 1 active; take over, then canonicalise the hash.
  for (const s of sections) {
    s.classList.remove('active');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('inert', '');
  }
  index = -1;
  route(initial, { say: false });
  $<HTMLElement>('#deck').focus({ preventScroll: true });

  return view;
}
