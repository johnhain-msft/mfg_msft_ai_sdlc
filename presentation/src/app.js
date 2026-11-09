/* ================================================================================================
   AI SDLC Orchestrator briefing — runtime
   One document, two surfaces. `#/<slide-id>` (or `#/<number>`) is the presentation; `#/speaker` is
   the speaker window. The two stay in sync through postMessage, BroadcastChannel and localStorage.
   The speaker window can drive the deck (prev/next/goto); the deck answers with its state.
   Nothing from the script is rendered on the presentation surface.

   build.mjs pre-renders every slide into #stage (for static readers) and ships the same slides as
   JSON in #deck-data. This file builds the live sections from the JSON and REPLACES the pre-rendered
   ones, so the JSON stays the single source of truth (the portfolio importer rewrites it) and #stage
   never holds a duplicate slide.
   ================================================================================================ */
(() => {
  'use strict';
  const DATA = JSON.parse(document.getElementById('deck-data').textContent);
  const SLIDES = DATA.slides;
  const byId = new Map(SLIDES.map((s) => [s.id, s]));
  const CHANNEL = 'ai-sdlc-deck';
  const LS_STATE = 'ai-sdlc-deck:state';
  const LS_TIMER = 'ai-sdlc-deck:timer';
  const LS_THEME = 'ai-sdlc-deck:theme';
  const LS_NOTES = 'ai-sdlc-deck:notes-size';
  const LS_TZ = 'ai-sdlc-deck:tz';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const live = $('#live');
  const announce = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const pad = (n) => String(n).padStart(2, '0');
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------------------------------------------------------------- theme
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(LS_THEME, t); } catch {}
  }
  function initTheme() {
    let t = null;
    try { t = localStorage.getItem(LS_THEME); } catch {}
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    applyTheme(t);
  }
  const toggleTheme = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

  // ---------------------------------------------------------------- transport
  // Three transports, used together: postMessage between the deck and the window it opened (works even
  // from file:// where each page is its own opaque origin), BroadcastChannel for same-origin windows,
  // and a localStorage write whose `storage` event reaches other same-origin windows.
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const listeners = new Set();
  let peer = null; // the other surface's window handle, when we have one
  function deliver(m) {
    if (!m || m.__deck !== CHANNEL) return;
    const key = `${m.type}:${m.ts}:${m.id || ''}:${m.frag || ''}`;
    if (key === deliver.last) return; // the same message can arrive on two transports
    deliver.last = key;
    listeners.forEach((fn) => fn(m));
  }
  function send(msg) {
    const payload = { ...msg, __deck: CHANNEL, ts: Date.now() };
    if (peer && !peer.closed) { try { peer.postMessage(payload, '*'); } catch {} }
    if (bc) bc.postMessage(payload);
    try { localStorage.setItem(`${CHANNEL}:msg`, JSON.stringify(payload)); } catch {}
  }
  function onMessage(fn) { listeners.add(fn); }
  if (bc) bc.onmessage = (e) => deliver(e.data);
  window.addEventListener('storage', (e) => {
    if (e.key === `${CHANNEL}:msg` && e.newValue) {
      try { deliver(JSON.parse(e.newValue)); } catch {}
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__deck === CHANNEL) {
      if (e.source && e.source !== window) peer = e.source; // adopt whoever talks to us
      deliver(e.data);
    }
  });

  // ---------------------------------------------------------------- shared timer (both surfaces)
  function readTimer() {
    try { return JSON.parse(localStorage.getItem(LS_TIMER) || 'null') || { startedAt: null, accumulated: 0, running: false }; }
    catch { return { startedAt: null, accumulated: 0, running: false }; }
  }
  function writeTimer(t) { try { localStorage.setItem(LS_TIMER, JSON.stringify(t)); } catch {} send({ type: 'timer', timer: t }); }
  function elapsedMs(t) { return t.accumulated + (t.running && t.startedAt ? Date.now() - t.startedAt : 0); }
  function fmtElapsed(ms) { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? `${h}:` : '') + `${pad(m)}:${pad(s % 60)}`; }

  // ---------------------------------------------------------------- routing
  function route() {
    const h = decodeURIComponent(window.location.hash || '');
    const m = h.match(/^#\/([^/]+)(?:\/(\d+))?/);
    if (!m) return { kind: 'slide', id: SLIDES[0]?.id, frag: 0 };
    if (m[1] === 'speaker') return { kind: 'speaker' };
    if (byId.has(m[1])) return { kind: 'slide', id: m[1], frag: Number(m[2] || 0) };
    const n = Number(m[1]);
    if (Number.isInteger(n) && SLIDES[n - 1]) return { kind: 'slide', id: SLIDES[n - 1].id, frag: 0 };
    return { kind: 'slide', id: SLIDES[0]?.id, frag: 0, unknown: m[1] };
  }

  // ---------------------------------------------------------------- repository links
  // Slides link to documents in this repository with root-relative paths (specs/…, plan.md). Opened on its
  // own, the deck points them at GitHub; the portfolio importer rewrites them in the JSON to the hosted
  // reader first, and those absolute paths do not match, so they are left alone.
  const SRC_REPO = DATA.source || { repo: 'johnhain-msft/mfg_msft_ai_sdlc', branch: 'main' };
  const REPO_PATH = /^(?:specs\/[\w.-]+\.md|plan\.md|README\.md|sdlc\.yaml|(?:src|bin|docs|schemas|prompts|instructions)\/[\w./-]+)(?:#.*)?$/;
  const repoUrl = (p) => `https://github.com/${SRC_REPO.repo}/blob/${SRC_REPO.branch}/${p}`;
  function resolveRepoLinks(root) {
    $$('a[href]', root).forEach((a) => {
      const h = a.getAttribute('href');
      if (REPO_PATH.test(h)) a.setAttribute('href', repoUrl(h));
    });
    $$('div.lab-path', root).forEach((d) => {
      const p = d.textContent.trim();
      if (!REPO_PATH.test(p)) return;
      const a = document.createElement('a');
      a.className = 'lab-path';
      a.href = repoUrl(p);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = p;
      d.replaceWith(a);
    });
  }

  // ---------------------------------------------------------------- slide DOM
  // Must stay identical to slideSection()/slideInner() in build.mjs, so the live DOM equals the pre-rendered one.
  function slideElement(s, { preview = false } = {}) {
    const el = document.createElement('section');
    el.className = `slide layout-${s.layout || 'default'}`;
    if (!preview) el.id = `s${s.n}`;
    el.dataset.id = s.id;
    el.setAttribute('aria-roledescription', 'slide');
    el.setAttribute('aria-label', `Slide ${s.n}: ${s.title || s.id}`);
    if (s.exempt) el.setAttribute('data-density-exempt', s.exempt);
    const kicker = s.kicker || (['title', 'break'].includes(s.layout) ? '' : s.section);
    const inner = [];
    if (kicker) inner.push(`<div class="slide-kicker">${escapeHtml(kicker)}</div>`);
    if (s.title) inner.push(`<h1>${s.titleHtml}</h1>`);
    inner.push(`<div class="slide-body">${s.html}</div>`);
    el.innerHTML = inner.join('');
    resolveRepoLinks(el);
    if (preview) el.classList.add('active');
    return el;
  }

  // ---------------------------------------------------------------- interactions inside slides
  function mountInteractions(root, { interactive = true } = {}) {
    // quiz
    $$('.quiz', root).forEach((q) => {
      const answer = q.dataset.answer;
      const expl = $('.quiz-expl', q);
      $$('.quiz-option', q).forEach((b) => {
        if (!interactive) { b.disabled = true; return; }
        b.addEventListener('click', () => {
          $$('.quiz-option', q).forEach((x) => { x.classList.remove('is-wrong'); x.classList.toggle('is-correct', x.dataset.key === answer); x.setAttribute('aria-pressed', String(x === b)); });
          if (b.dataset.key !== answer) b.classList.add('is-wrong');
          expl.hidden = false;
          announce(b.dataset.key === answer ? 'Correct.' : `Not quite. The answer is ${answer}.`);
        });
      });
    });
    // highlight groups in diagrams: hover or focus a node and its group stays lit
    $$('.diagram', root).forEach((fig) => {
      const nodes = $$('[data-hl]', fig);
      if (!nodes.length) return;
      const clear = () => { fig.classList.remove('has-focus'); nodes.forEach((n) => n.classList.remove('is-hl')); };
      nodes.forEach((n) => {
        n.setAttribute('tabindex', '0');
        const on = () => { fig.classList.add('has-focus'); const g = n.dataset.hl; nodes.forEach((x) => x.classList.toggle('is-hl', x.dataset.hl === g)); };
        n.addEventListener('mouseenter', on); n.addEventListener('focus', on);
        n.addEventListener('mouseleave', clear); n.addEventListener('blur', clear);
      });
    });
    // decision tree: a Yes/No walk that ends on one of the outcome cards. The tree is described by an
    // embedded JSON object: { start: {q, yes, no, step}, <key>: {q, yes, no, step} | {result, say, step} }
    $$('[data-decision]', root).forEach((tree) => {
      let cfg;
      try { cfg = JSON.parse($('script[type="application/json"]', tree).textContent); } catch { return; }
      const qEl = $('[data-dq]', tree);
      const actions = $('[data-dactions]', tree);
      const dots = $$('.dstep-dot', tree);
      const outcomes = $$('[data-outcome]', tree);
      const button = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        if (!interactive) b.disabled = true; else b.addEventListener('click', onClick);
        return b;
      };
      const render = (key, { focus = false } = {}) => {
        const node = cfg[key];
        if (!node) return;
        const done = Boolean(node.result);
        qEl.textContent = done ? node.say : node.q;
        qEl.classList.toggle('decision-result', done);
        dots.forEach((d, i) => d.classList.toggle('is-on', i < (node.step || 0)));
        outcomes.forEach((o) => {
          o.classList.toggle('is-picked', done && o.dataset.outcome === node.result);
          o.classList.toggle('is-dim', done && o.dataset.outcome !== node.result);
        });
        actions.replaceChildren(...(done
          ? [button('Start over', () => render('start', { focus: true }))]
          : [button('Yes', () => render(node.yes, { focus: true })), button('No', () => render(node.no, { focus: true }))]));
        if (focus && interactive) actions.querySelector('button')?.focus();
        if (focus) announce(done ? node.say : node.q);
      };
      render('start');
    });
    // pilot stepper on Slide 9: syncs the 6 ledger rows with the 6 vector telemetry panels
    $$('[data-pilot]', root).forEach((viewer) => {
      const slide = viewer.closest('.slide') || root;
      const panels = $$('[data-pilot-panel]', viewer);
      const rows = $$('[data-pilot-step]', slide);
      const status = $('[data-pilot-status]', viewer);
      const prevBtn = $('[data-pilot-prev]', viewer);
      const nextBtn = $('[data-pilot-next]', viewer);
      let idx = 0;
      const setStep = (next, { announceStep = false } = {}) => {
        idx = (next + panels.length) % panels.length;
        panels.forEach((p, i) => { p.hidden = i !== idx; });
        rows.forEach((r, i) => {
          r.classList.toggle('is-active', i === idx);
          r.setAttribute('aria-pressed', String(i === idx));
        });
        if (status) status.textContent = `${idx + 1} / ${panels.length}`;
        if (announceStep) announce(`Step ${idx + 1} of ${panels.length}`);
      };
      if (interactive) {
        rows.forEach((r, i) => {
          r.addEventListener('click', () => setStep(i, { announceStep: true }));
          r.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStep(i, { announceStep: true }); }
          });
        });
        prevBtn?.addEventListener('click', () => setStep(idx - 1, { announceStep: true }));
        nextBtn?.addEventListener('click', () => setStep(idx + 1, { announceStep: true }));
      } else {
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
      }
      setStep(0);
    });
  }

  // ================================================================ PRESENTATION SURFACE
  function mountPresentation() {
    const root = $('#presentation');
    root.hidden = false;
    document.title = DATA.title;
    const stage = $('#stage');
    const deck = $('#deck');
    const els = new Map();
    // adopt-or-replace: every pre-rendered section is swapped for the one built from the JSON
    const prerendered = new Map([...stage.children].filter((el) => el.matches('.slide[data-id]')).map((el) => [el.dataset.id, el]));
    for (const s of SLIDES) {
      const el = slideElement(s);
      const old = prerendered.get(s.id);
      if (old) { old.replaceWith(el); prerendered.delete(s.id); } else stage.appendChild(el);
      els.set(s.id, el);
    }
    prerendered.forEach((el) => el.remove());
    mountInteractions(stage);
    const days = DATA.agenda?.days || [];
    const dayBadge = days.length > 1 ? null : (days[0]?.label || '');
    $('#day-badge').textContent = dayBadge || '';

    let currentId = null;
    let frag = 0;
    let typed = '';

    function fragmentsOf(id) { return $$('.fragment', els.get(id)); }
    function applyFragments(id, n) {
      fragmentsOf(id).forEach((f, i) => f.classList.toggle('visible', i < n));
    }
    function show(id, n = 0, { push = true, announceIt = true } = {}) {
      if (!byId.has(id)) return;
      const s = byId.get(id);
      const frags = fragmentsOf(id);
      frag = clamp(n, 0, frags.length);
      if (currentId !== id) {
        if (currentId) els.get(currentId)?.classList.remove('active');
        currentId = id;
        els.get(id).classList.add('active');
      }
      applyFragments(id, frag);
      $('#kicker-section').textContent = s.section || '';
      const lab = $('#lab-badge');
      lab.hidden = true;
      if (days.length > 1) $('#day-badge').textContent = s.day ? `Day ${s.day}` : '';
      $('#counter').textContent = `${s.n} / ${SLIDES.length}`;
      $('#progress-bar').style.width = `${((s.n - 1) / Math.max(1, SLIDES.length - 1)) * 100}%`;
      document.title = `${s.n}. ${s.title || s.id} — ${DATA.title}`;
      const hash = `#/${id}${frag ? '/' + frag : ''}`;
      if (push && window.location.hash !== hash) history.replaceState(null, '', hash);
      if (announceIt) announce(`Slide ${s.n} of ${SLIDES.length}: ${s.title || s.id}`);
      broadcastState();
    }
    function broadcastState() {
      if (!currentId) return;
      const s = byId.get(currentId);
      const state = { type: 'state', id: currentId, frag, n: s.n, total: SLIDES.length, fragTotal: fragmentsOf(currentId).length };
      try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch {}
      send(state);
    }
    function next() {
      const frags = fragmentsOf(currentId);
      if (frag < frags.length) { show(currentId, frag + 1); return; }
      const i = byId.get(currentId).n; // n is 1-based, so SLIDES[i] is the next
      if (SLIDES[i]) show(SLIDES[i].id, 0);
    }
    function prev() {
      if (frag > 0) { show(currentId, frag - 1); return; }
      const i = byId.get(currentId).n - 2;
      if (SLIDES[i]) show(SLIDES[i].id, fragmentsOf(SLIDES[i].id).length);
    }

    // scale the stage to the deck area
    function fit() {
      const r = deck.getBoundingClientRect();
      const scale = Math.min(r.width / 1920, r.height / 1080);
      stage.style.setProperty('--scale', String(scale));
    }
    new ResizeObserver(fit).observe(deck);
    fit();

    // overlays
    const dlgHelp = $('#dlg-help');
    const dlgGrid = $('#dlg-grid');
    const dlgAgenda = $('#dlg-agenda');
    function openGrid() {
      const grid = $('#grid');
      grid.innerHTML = SLIDES.map((s) => `<button type="button" class="grid-item${s.id === currentId ? ' is-current' : ''}" data-go="${s.id}"><span class="gi-n">${s.n} · ${s.minutes} min</span><span class="gi-t">${escapeHtml(s.title || s.id)}</span><span class="gi-s">${escapeHtml(s.section || '')}</span></button>`).join('');
      $$('.grid-item', grid).forEach((b) => b.addEventListener('click', () => { dlgGrid.close(); show(b.dataset.go, 0); }));
      dlgGrid.showModal();
      $('.is-current', grid)?.focus();
    }
    function openAgenda() {
      renderAgenda(dlgAgenda, { currentId, onGo: (id) => { dlgAgenda.close(); show(id, 0); } });
      dlgAgenda.showModal();
      // focus the day tab, not the time-zone select, so the key that opened the dialog cannot type-ahead into it
      $('#agenda-tabs button[aria-selected="true"]')?.focus();
    }
    function closeDialogs() { [dlgHelp, dlgGrid, dlgAgenda].forEach((d) => d.open && d.close()); }

    // speaker window
    let speakerWin = null;
    function openSpeaker() {
      const url = window.location.href.split('#')[0] + '#/speaker';
      speakerWin = window.open(url, 'ai-sdlc-deck-speaker', 'width=1280,height=800');
      if (!speakerWin) { announce('The browser blocked the speaker window. Allow pop-ups for this page and press S again.'); return; }
      peer = speakerWin;
      setTimeout(broadcastState, 400);
      setTimeout(broadcastState, 1200);
    }
    // fullscreen
    async function present() {
      try {
        if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); }
        else await document.exitFullscreen();
      } catch { announce('Fullscreen is not available here. Use the browser\'s own fullscreen (F11).'); }
    }
    document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('presenting', !!document.fullscreenElement); fit(); });
    // blackout
    const blackout = $('#blackout');
    const toggleBlackout = () => { blackout.hidden = !blackout.hidden; };

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      const anyOpen = [dlgHelp, dlgGrid, dlgAgenda].some((d) => d.open);
      if (anyOpen) {
        // the key that opened an overlay closes it again, so a presenter never needs Esc (Esc also leaves fullscreen in every browser)
        const k = e.key.toLowerCase();
        if (e.key === 'Escape' || (k === 'g' && dlgGrid.open) || (k === 'a' && dlgAgenda.open) || ((e.key === '?' || e.key === '/') && dlgHelp.open)) { e.preventDefault(); closeDialogs(); }
        return;
      }
      // Enter and Space activate a focused quiz or decision button instead of changing slide
      if (e.target && e.target.closest && e.target.closest('.quiz, [data-decision]') && ['Enter', ' '].includes(e.key)) return;
      switch (e.key) {
        case 'ArrowRight': case ' ': case 'PageDown': case 'ArrowDown': e.preventDefault(); next(); break;
        case 'ArrowLeft': case 'PageUp': case 'ArrowUp': e.preventDefault(); prev(); break;
        case 'Home': e.preventDefault(); show(SLIDES[0].id, 0); break;
        case 'End': e.preventDefault(); show(SLIDES[SLIDES.length - 1].id, 0); break;
        case 'g': case 'G': openGrid(); break;
        case 'a': case 'A': openAgenda(); break;
        case 's': case 'S': openSpeaker(); break;
        case 'f': case 'F': present(); break;
        case 'b': case 'B': case '.': toggleBlackout(); break;
        case 't': case 'T': toggleTheme(); break;
        case 'p': case 'P': window.print(); break;
        case '?': case '/': dlgHelp.showModal(); break;
        case 'Escape': if (!blackout.hidden) toggleBlackout(); break;
        case 'Enter': if (typed) { const n = Number(typed); typed = ''; if (SLIDES[n - 1]) show(SLIDES[n - 1].id, 0); } break;
        default:
          if (/^\d$/.test(e.key)) { typed = (typed + e.key).slice(-3); setTimeout(() => { typed = ''; }, 2500); }
      }
    });
    $('#btn-prev').addEventListener('click', prev);
    $('#btn-next').addEventListener('click', next);
    $('#btn-agenda').addEventListener('click', openAgenda);
    $('#btn-grid').addEventListener('click', openGrid);
    $('#btn-speaker').addEventListener('click', openSpeaker);
    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-fullscreen').addEventListener('click', present);
    $('#btn-help').addEventListener('click', () => dlgHelp.showModal());
    // click right/left halves of the stage to advance when presenting (touch friendly)
    deck.addEventListener('click', (e) => {
      if (!document.fullscreenElement) return;
      if (e.target.closest('button, a, .quiz, [data-decision], [data-hl]')) return;
      const r = deck.getBoundingClientRect();
      if (e.clientX - r.left > r.width * 0.5) next(); else prev();
    });
    // messages from the speaker window
    onMessage((m) => {
      if (m.type === 'hello') broadcastState();
      else if (m.type === 'next') next();
      else if (m.type === 'prev') prev();
      else if (m.type === 'goto' && byId.has(m.id)) show(m.id, m.frag || 0);
    });
    window.addEventListener('hashchange', () => {
      const r = route();
      if (r.kind === 'speaker') { window.location.reload(); return; }
      if (r.id !== currentId || r.frag !== frag) show(r.id, r.frag, { push: false });
    });
    // print mode: reveal everything
    window.addEventListener('beforeprint', () => document.body.classList.add('print'));
    window.addEventListener('afterprint', () => document.body.classList.remove('print'));

    const r = route();
    show(r.id, r.frag, { announceIt: false });
    if (r.unknown) announce(`Unknown slide "${r.unknown}". Showing the first slide.`);
    deck.focus();
  }

  // ---------------------------------------------------------------- agenda rendering (shared)
  const TZ_CHOICES = [
    ['America/New_York', 'Eastern (US)'], ['America/Chicago', 'Central (US)'], ['America/Denver', 'Mountain (US)'],
    ['America/Los_Angeles', 'Pacific (US)'], ['America/Phoenix', 'Arizona'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'],
    ['America/Toronto', 'Toronto'], ['America/Sao_Paulo', 'São Paulo'], ['Europe/London', 'London'], ['Europe/Dublin', 'Dublin'],
    ['Europe/Paris', 'Paris / Berlin'], ['Europe/Madrid', 'Madrid'], ['Europe/Warsaw', 'Warsaw'], ['Asia/Kolkata', 'India'],
    ['Asia/Singapore', 'Singapore'], ['Asia/Tokyo', 'Tokyo'], ['Australia/Sydney', 'Sydney'], ['UTC', 'UTC'],
  ];
  function tzOffsetMinutes(tz, date) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  }
  function convertWall(hhmm, dateStr, fromTz, toTz) {
    if (!fromTz || !toTz || fromTz === toTz) return hhmm;
    const [h, m] = hhmm.split(':').map(Number);
    const ref = new Date(`${dateStr || '2026-11-08'}T12:00:00Z`);
    const base = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), h, m) - tzOffsetMinutes(fromTz, ref) * 60000;
    const target = new Date(base + tzOffsetMinutes(toTz, new Date(base)) * 60000);
    return `${pad(target.getUTCHours())}:${pad(target.getUTCMinutes())}`;
  }
  function renderAgenda(dlg, { currentId, onGo }) {
    const ag = DATA.agenda;
    if (!ag) { $('#agenda-body').innerHTML = '<p class="muted">No agenda in this build.</p>'; return; }
    const sel = $('#agenda-tz');
    let tz = ag.baseTz;
    try { tz = localStorage.getItem(LS_TZ) || ag.baseTz; } catch {}
    if (!sel.options.length) {
      const have = new Set();
      for (const [id, label] of [[ag.baseTz, `${ag.baseTzLabel || ag.baseTz} (briefing)`], ...TZ_CHOICES]) {
        if (have.has(id)) continue; have.add(id);
        const o = document.createElement('option'); o.value = id; o.textContent = label; sel.appendChild(o);
      }
      sel.addEventListener('change', () => { try { localStorage.setItem(LS_TZ, sel.value); } catch {} draw(sel.value); });
    }
    sel.value = tz;
    const tabs = $('#agenda-tabs');
    let dayIdx = Math.max(0, ag.days.findIndex((d) => d.blocks.some((b) => (b.slides || []).includes(currentId))));
    function draw(tzNow) {
      tabs.innerHTML = ag.days.map((d, i) => `<button type="button" role="tab" aria-selected="${i === dayIdx}">${escapeHtml(d.label || `Day ${d.day}`)}</button>`).join('');
      $$('button', tabs).forEach((b, i) => b.addEventListener('click', () => { dayIdx = i; draw(tzNow); }));
      const d = ag.days[dayIdx];
      const rows = d.blocks.map((b) => {
        const cur = (b.slides || []).includes(currentId);
        const icon = b.type === 'break' ? '☕' : b.type === 'lab' ? '🧪' : b.type === 'discussion' ? '💬' : '📖';
        const first = (b.slides || [])[0];
        return `<tr class="${cur ? 'is-current ' : ''}ag-${b.type}"><td class="ag-time">${convertWall(b.start, d.date, ag.baseTz, tzNow)}</td><td>${b.minutes} min</td><td>${icon} ${escapeHtml(b.title)}${b.detail ? `<div class="muted">${escapeHtml(b.detail)}</div>` : ''}</td><td>${first ? `<button type="button" class="ag-go" data-go="${first}">go</button>` : ''}</td></tr>`;
      }).join('');
      $('#agenda-body').innerHTML = `<p class="muted">${escapeHtml(d.title || '')}${d.date ? ` · ${d.date}` : ''} · times shown in ${escapeHtml(sel.options[sel.selectedIndex]?.textContent || tzNow)}</p><table class="agenda-table"><thead><tr><th>Start</th><th>Length</th><th>Block</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
      $$('.ag-go', $('#agenda-body')).forEach((b) => b.addEventListener('click', () => onGo && onGo(b.dataset.go)));
    }
    draw(tz);
  }

  // ================================================================ SPEAKER SURFACE
  function mountSpeaker() {
    const root = $('#speaker');
    root.hidden = false;
    $('#stage').replaceChildren(); // the pre-rendered slides are not needed here and would duplicate the previews
    document.title = `Speaker — ${DATA.title}`;
    $('#sp-deck-title').textContent = DATA.title;
    const cur = $('#sp-current');
    const nextWrap = $('#sp-next-preview');
    const notes = $('#sp-notes');
    const status = $('#sp-status');
    if (window.opener && window.opener !== window) peer = window.opener;
    let state = null;
    try { state = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch {}
    let notesSize = 22;
    try { notesSize = Number(localStorage.getItem(LS_NOTES)) || 22; } catch {}
    const applyNotesSize = () => { notes.style.setProperty('--notes-size', `${notesSize}px`); try { localStorage.setItem(LS_NOTES, String(notesSize)); } catch {} };
    applyNotesSize();

    function fitPreview() {
      for (const el of [cur, nextWrap]) {
        const w = el.parentElement.getBoundingClientRect().width;
        el.style.transform = `scale(${w / 1920})`;
      }
    }
    function blockFor(id) {
      const ag = DATA.agenda; if (!ag) return null;
      for (const d of ag.days) for (const b of d.blocks) if ((b.slides || []).includes(id)) return { day: d, block: b };
      return null;
    }
    function render(st) {
      if (!st || !byId.has(st.id)) { notes.innerHTML = '<p class="empty">Waiting for the deck. Open the deck in another window, or press Next here to start it.</p>'; return; }
      state = st;
      const s = byId.get(st.id);
      const nextS = SLIDES[s.n];
      cur.replaceChildren(slideElement(s, { preview: true }));
      $$('.fragment', cur).forEach((f, i) => f.classList.toggle('visible', i < (st.frag || 0)));
      mountInteractions(cur, { interactive: false });
      nextWrap.replaceChildren(nextS ? slideElement(nextS, { preview: true }) : Object.assign(document.createElement('div'), { className: 'muted', textContent: 'End of deck' }));
      if (nextS) mountInteractions(nextWrap, { interactive: false });
      $('#sp-slide-title').textContent = `${s.n}. ${s.title || s.id}`;
      $('#sp-counter').textContent = `${s.n} / ${SLIDES.length}${st.fragTotal ? ` · step ${st.frag}/${st.fragTotal}` : ''}`;
      $('#sp-words').textContent = s.words ? `${s.words} words · ~${Math.max(1, Math.round(s.words / 150))} min spoken · budget ${s.minutes || '—'} min` : '';
      notes.innerHTML = s.notes || '<p class="empty">No notes for this slide.</p>';
      notes.scrollTop = 0;
      const bf = blockFor(s.id);
      $('#sp-budget').textContent = bf ? `${bf.day.label || 'Day ' + bf.day.day} · ${bf.block.title} · ${bf.block.start} · ${bf.block.minutes} min block` : '';
      fitPreview();
    }
    // timer
    function tickTimer() {
      const t = readTimer();
      const el = $('#sp-elapsed');
      el.textContent = fmtElapsed(elapsedMs(t));
      $('#sp-timer-toggle').textContent = t.running ? 'Pause' : (t.accumulated ? 'Resume' : 'Start');
      $('#sp-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      // over budget? compare elapsed with the planned minutes up to and including the current slide
      if (state && byId.has(state.id)) {
        const s = byId.get(state.id);
        const planned = SLIDES.filter((x) => x.day === s.day && x.n <= s.n).reduce((n, x) => n + x.minutes, 0);
        el.classList.toggle('over', planned > 0 && elapsedMs(t) > planned * 60000);
        el.title = `Planned through this slide: ${planned} min`;
      }
    }
    $('#sp-timer-toggle').addEventListener('click', () => {
      const t = readTimer();
      if (t.running) { t.accumulated = elapsedMs(t); t.running = false; t.startedAt = null; }
      else { t.running = true; t.startedAt = Date.now(); }
      writeTimer(t); tickTimer();
    });
    $('#sp-timer-reset').addEventListener('click', () => { writeTimer({ startedAt: null, accumulated: 0, running: false }); tickTimer(); });
    setInterval(tickTimer, 1000); tickTimer();
    // controls
    $('#sp-prev').addEventListener('click', () => send({ type: 'prev' }));
    $('#sp-next').addEventListener('click', () => send({ type: 'next' }));
    $('#sp-font-dec').addEventListener('click', () => { notesSize = clamp(notesSize - 2, 14, 40); applyNotesSize(); });
    $('#sp-font-inc').addEventListener('click', () => { notesSize = clamp(notesSize + 2, 14, 40); applyNotesSize(); });
    $('#sp-open-deck').addEventListener('click', () => {
      const w = window.open(window.location.href.split('#')[0] + `#/${state?.id || SLIDES[0].id}`, 'ai-sdlc-deck-main');
      if (w) { peer = w; setTimeout(() => send({ type: 'hello' }), 800); }
    });
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) { e.preventDefault(); send({ type: 'next' }); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); send({ type: 'prev' }); }
      else if (e.key === 't' || e.key === 'T') toggleTheme();
      else if (e.key === '+' || e.key === '=') { notesSize = clamp(notesSize + 2, 14, 40); applyNotesSize(); }
      else if (e.key === '-') { notesSize = clamp(notesSize - 2, 14, 40); applyNotesSize(); }
    });
    onMessage((m) => {
      if (m.type === 'state') { render(m); status.textContent = `Synchronized with the deck · ${new Date(m.ts).toLocaleTimeString()}`; }
      else if (m.type === 'timer') tickTimer();
    });
    window.addEventListener('resize', fitPreview);
    render(state);
    status.textContent = state ? 'Showing the last known deck position. Waiting for the deck to answer…' : 'Waiting for the deck.';
    send({ type: 'hello' });
    setTimeout(() => { if (!status.textContent.startsWith('Synchronized')) status.textContent = 'No deck answered yet. Open the deck (button above) and this window will follow it.'; }, 1500);
  }

  // ================================================================ boot
  initTheme();
  const r = route();
  if (r.kind === 'speaker') mountSpeaker(); else mountPresentation();
})();
