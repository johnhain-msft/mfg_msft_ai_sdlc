/**
 * Staged steppers and highlighters (slides 3, 4, 6, 7, 9, 16).
 *
 *  steps   Space / ArrowRight / PageDown walk a highlight through the stages before the deck
 *          moves on (ArrowLeft / PageUp walk back). Clicking a stage target jumps to it; clicking
 *          the active stage returns to the neutral step 0. Stage targets are containers with
 *          `stage` and diagram elements with `data-stage`.
 *  place   Clicking a scorecard cell places that row in a tier (None / Basic / Enterprise).
 *
 * Neither mode hides or injects text. Every container stays in the DOM and stays readable, so
 * slide-review and deck-density.py measure exactly the slide the room sees. Emphasis is carried
 * by classes (`is-stage`, `is-dim`, `is-past`) and by `data-step` on the slide, which diagrams
 * can key on (for example the slide 3 attention curve flattening).
 *
 * `mountHighlights` is the hover/focus highlighter for diagram `data-hl` groups.
 */

import { slug, type Slide, type StagedSpec } from '../content/types';
import { type BlockDecor, type MountContext, type WidgetHandle, type WidgetRenderHooks, isActivateKey } from './types';

type Steps = Extract<StagedSpec, { mode: 'steps' }>;
type Place = Extract<StagedSpec, { mode: 'place' }>;

const stagedOf = (slide: Slide): StagedSpec | undefined => (slide.widget?.kind === 'staged' ? slide.widget : undefined);
const stepsOf = (slide: Slide): Steps | undefined => {
  const w = stagedOf(slide);
  return w?.mode === 'steps' ? w : undefined;
};
const placeOf = (slide: Slide): Place | undefined => {
  const w = stagedOf(slide);
  return w?.mode === 'place' ? w : undefined;
};

export const TIER_GLYPH = { empty: '\u25cb', filled: '\u25cf' } as const;

// --------------------------------------------------------------------------- render hooks

export const stagedHooks: WidgetRenderHooks = {
  block(slide, block): BlockDecor | undefined {
    if (!stepsOf(slide) || !block.stage) return undefined;
    return {
      classes: ['stage-target'],
      attrs: { 'data-stage': block.stage, role: 'button', tabindex: 0, 'aria-pressed': 'false' },
    };
  },
  row(slide, row, first): BlockDecor | undefined {
    const spec = placeOf(slide);
    if (!spec || row === 0) return undefined;
    return { attrs: { 'data-row': slug(first), 'data-tier': '' } };
  },
  cell(slide, row, col, text): BlockDecor | undefined {
    const spec = placeOf(slide);
    if (!spec || row === 0 || col === 0) return undefined;
    const tier = spec.tiers[col - 1];
    if (!tier) return undefined;
    void text;
    return { classes: ['place'], attrs: { 'data-tier': slug(tier), role: 'button', tabindex: 0, 'aria-pressed': 'false' } };
  },
  root(slide) {
    const w = stagedOf(slide);
    if (!w) return undefined;
    return w.mode === 'steps'
      ? { 'data-widget': 'staged', 'data-step': '0', 'data-stage': '' }
      : { 'data-widget': 'scorecard' };
  },
};

// --------------------------------------------------------------------------- steps mode

function mountSteps(root: HTMLElement, spec: Steps, ctx: MountContext): WidgetHandle {
  const keys = spec.stages.map((s) => s.key);
  const targets = Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[data-stage]')).filter(
    (el) => el !== root && keys.includes(el.getAttribute('data-stage') ?? ''),
  );
  for (const el of targets) {
    // Diagram elements are authored in SVG markup; make them keyboard-reachable like containers.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', ctx.interactive ? '0' : '-1');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!ctx.interactive) el.setAttribute('tabindex', '-1');
  }
  let step = 0;

  const apply = () => {
    root.dataset.step = String(step);
    root.dataset.stage = step ? (keys[step - 1] as string) : '';
    for (const el of targets) {
      const idx = keys.indexOf(el.getAttribute('data-stage') as string) + 1;
      el.classList.toggle('is-stage', step === idx);
      el.classList.toggle('is-past', step > idx);
      el.classList.toggle('is-dim', step !== 0 && step !== idx);
      el.setAttribute('aria-pressed', String(step === idx));
    }
  };

  const goto = (n: number, announce: boolean) => {
    step = Math.max(0, Math.min(keys.length, n));
    apply();
    if (announce) {
      const stage = step ? spec.stages[step - 1] : undefined;
      ctx.announce(stage ? (stage.announce ?? `Stage ${step} of ${keys.length}`) : 'Highlight cleared');
    }
  };

  const off: Array<() => void> = [];
  if (ctx.interactive) {
    for (const el of targets) {
      const idx = keys.indexOf(el.getAttribute('data-stage') as string) + 1;
      const click = () => {
        goto(step === idx ? 0 : idx, true);
        ctx.changed();
      };
      const key = (e: Event) => {
        const ke = e as KeyboardEvent;
        if (isActivateKey(ke)) {
          ke.preventDefault();
          ke.stopPropagation();
          click();
        }
      };
      el.addEventListener('click', click);
      el.addEventListener('keydown', key);
      off.push(() => el.removeEventListener('click', click), () => el.removeEventListener('keydown', key));
    }
  }
  apply();

  return {
    kind: 'staged',
    steps: keys.length,
    claimsDigits: false,
    getStep: () => step,
    setStep: (n) => goto(n, ctx.interactive),
    handleKey: () => false,
    getState: () => ({ step }),
    setState(s) {
      const n = (s as { step?: unknown } | null)?.step;
      goto(typeof n === 'number' ? n : 0, false);
    },
    dispose() {
      for (const f of off) f();
    },
  };
}

// --------------------------------------------------------------------------- place mode

function mountPlace(root: HTMLElement, spec: Place, ctx: MountContext): WidgetHandle {
  const rows = new Map<string, HTMLElement>();
  for (const tr of root.querySelectorAll<HTMLElement>('tr[data-row]')) rows.set(tr.dataset.row as string, tr);
  const tierKeys = spec.tiers.map(slug);
  const placed = new Map<string, string>();

  const apply = () => {
    for (const [row, tr] of rows) {
      const tier = placed.get(row) ?? '';
      tr.dataset.tier = tier;
      for (const cell of tr.querySelectorAll<HTMLElement>('td.place')) {
        const on = cell.dataset.tier === tier;
        cell.setAttribute('aria-pressed', String(on));
        cell.classList.toggle('is-placed', on);
        cell.textContent = on ? TIER_GLYPH.filled : TIER_GLYPH.empty;
      }
    }
  };

  const place = (row: string, tier: string, announce: boolean) => {
    if (placed.get(row) === tier) placed.delete(row);
    else placed.set(row, tier);
    apply();
    if (announce) {
      const label = rows.get(row)?.querySelector('th, td')?.textContent?.trim() ?? row;
      const t = placed.get(row);
      ctx.announce(t ? `${label}: ${spec.tiers[tierKeys.indexOf(t)] ?? t}.` : `${label}: cleared.`);
    }
  };

  const off: Array<() => void> = [];
  if (ctx.interactive) {
    for (const cell of root.querySelectorAll<HTMLElement>('td.place')) {
      const row = cell.closest<HTMLElement>('tr[data-row]')?.dataset.row;
      if (!row) continue;
      const act = () => {
        place(row, cell.dataset.tier as string, true);
        ctx.changed();
      };
      const key = (e: KeyboardEvent) => {
        if (isActivateKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          act();
        }
      };
      cell.addEventListener('click', act);
      cell.addEventListener('keydown', key);
      off.push(() => cell.removeEventListener('click', act), () => cell.removeEventListener('keydown', key));
    }
  } else {
    for (const cell of root.querySelectorAll<HTMLElement>('td.place')) cell.setAttribute('tabindex', '-1');
  }
  apply();

  return {
    kind: 'staged',
    steps: 0,
    claimsDigits: false,
    getStep: () => 0,
    setStep: () => undefined,
    handleKey: () => false,
    getState: () => ({ placed: Object.fromEntries(placed) }),
    setState(s) {
      placed.clear();
      const p = (s as { placed?: Record<string, string> } | null)?.placed ?? {};
      for (const [row, tier] of Object.entries(p)) if (rows.has(row) && tierKeys.includes(tier)) placed.set(row, tier);
      apply();
    },
    dispose() {
      for (const f of off) f();
    },
  };
}

export function mountStaged(root: HTMLElement, slide: Slide, ctx: MountContext): WidgetHandle {
  const spec = stagedOf(slide);
  if (!spec) throw new Error('mountStaged: slide has no staged widget');
  return spec.mode === 'steps' ? mountSteps(root, spec, ctx) : mountPlace(root, spec, ctx);
}

// --------------------------------------------------------------------------- hover / focus highlighter

/**
 * Diagram highlight groups: hovering or focusing any element with `data-hl="g"` lights every element
 * in group `g` and dims the rest of the figure. Visual only. Works on any slide, widget or not.
 */
export function mountHighlights(root: HTMLElement, interactive: boolean): () => void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[data-hl]'));
  if (!nodes.length || !interactive) return () => undefined;
  const off: Array<() => void> = [];
  const clear = () => {
    root.classList.remove('has-hl');
    for (const n of nodes) n.classList.remove('is-hl');
  };
  for (const n of nodes) {
    if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
    const on = () => {
      const g = n.getAttribute('data-hl');
      root.classList.add('has-hl');
      for (const x of nodes) x.classList.toggle('is-hl', x.getAttribute('data-hl') === g);
    };
    n.addEventListener('mouseenter', on);
    n.addEventListener('focus', on);
    n.addEventListener('mouseleave', clear);
    n.addEventListener('blur', clear);
    off.push(
      () => n.removeEventListener('mouseenter', on),
      () => n.removeEventListener('focus', on),
      () => n.removeEventListener('mouseleave', clear),
      () => n.removeEventListener('blur', clear),
    );
  }
  return () => {
    clear();
    for (const f of off) f();
  };
}
