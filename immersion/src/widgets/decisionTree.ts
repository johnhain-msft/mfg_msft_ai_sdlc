/**
 * Slide 10 widget: the 2x2 Quality Gate Selector (`m3-gate-matrix`).
 *
 * Four failure chips (keys 1-4, or click) light a glyph-only breadcrumb (Internal/External, then
 * Programmatic/Judgement) and ring the tile or tiles that catch that failure. Adds no prose in
 * any state: it only toggles attributes and classes on markup that is already on the slide.
 *
 *   Goal drift          -> both judgement tiles
 *   Schema break        -> programmatic-internal
 *   Invented fact       -> programmatic-internal (a grounded lookup)
 *   Claimed green tests -> programmatic-external (re-run outside the agent)
 */

import { blockKey, isChip, type ChipBlock, type Container, type DecisionTreeSpec, type Slide } from '../content/types';
import { type MountContext, type WidgetHandle, type WidgetRenderHooks, digitOf } from './types';

const specOf = (slide: Slide): DecisionTreeSpec | undefined => (slide.widget?.kind === 'decision-tree' ? slide.widget : undefined);

/** Axis tokens of a gate key: `programmatic-internal` -> who `internal`, how `programmatic`. */
export function axesOf(gateKeys: string[]): { who: string[]; how: string[] } {
  const who = new Set<string>();
  const how = new Set<string>();
  for (const k of gateKeys) {
    const [h, w] = k.split('-');
    if (h) how.add(h);
    if (w) who.add(w);
  }
  return { who: [...who], how: [...how] };
}

// Glyph-only breadcrumb: a two-level tree. Shapes only (no <text>), so it adds zero words.
// Level 1 (who): a dot inside a ring = internal, a dot beside a ring = external.
// Level 2 (how): angle brackets = programmatic, a balance beam = judgement.
const BREADCRUMB =
  `<figure class="gate-path" data-gate-path aria-hidden="true">` +
  `<svg viewBox="0 0 420 150" focusable="false">` +
  `<g class="edges"><path class="e e-int" d="M40 75 C90 75 90 36 150 36"/><path class="e e-ext" d="M40 75 C90 75 90 114 150 114"/>` +
  `<path class="e e-prog" d="M205 36 C250 36 250 36 300 36" data-how-edge="programmatic"/>` +
  `<path class="e e-judge" d="M205 114 C250 114 250 114 300 114" data-how-edge="judgement"/></g>` +
  `<circle class="root" cx="28" cy="75" r="12"/>` +
  `<g class="who who-internal" data-who-node="internal"><circle class="ring" cx="178" cy="36" r="26"/><circle class="dot" cx="178" cy="36" r="9"/></g>` +
  `<g class="who who-external" data-who-node="external"><circle class="ring" cx="170" cy="114" r="26"/><circle class="dot" cx="212" cy="114" r="9"/></g>` +
  `<g class="how how-programmatic" data-how-node="programmatic"><rect class="pill" x="300" y="14" width="104" height="44" rx="12"/>` +
  `<path class="glyph" d="M334 26 l-12 10 12 10 M370 26 l12 10 -12 10 M356 24 l-8 24"/></g>` +
  `<g class="how how-judgement" data-how-node="judgement"><rect class="pill" x="300" y="92" width="104" height="44" rx="12"/>` +
  `<path class="glyph" d="M352 102 v28 M322 112 h60 M326 112 l-10 16 h20 z M378 112 l-10 16 h20 z"/></g>` +
  `</svg></figure>`;

export const decisionTreeHooks: WidgetRenderHooks = {
  block(slide, block: Container): { attrs: Record<string, string>; classes: string[] } | undefined {
    if (!specOf(slide) || block.kind !== 'tile') return undefined;
    return { classes: ['gate'], attrs: { 'data-gate': blockKey(block) } };
  },
  chip(slide, chip: ChipBlock, index) {
    if (!specOf(slide)) return undefined;
    return { attrs: { 'data-chip': blockKey(chip), 'data-hint': index + 1, 'aria-pressed': 'false' } };
  },
  prelude(slide) {
    return specOf(slide) ? BREADCRUMB : '';
  },
  root(slide) {
    return specOf(slide) ? { 'data-widget': 'decision-tree', 'data-active': '', 'data-who': '', 'data-how': '' } : undefined;
  },
};

export function mountDecisionTree(root: HTMLElement, slide: Slide, ctx: MountContext): WidgetHandle {
  const spec = specOf(slide);
  if (!spec) throw new Error('mountDecisionTree: slide has no decision-tree widget');
  const chipKeys = slide.blocks.filter(isChip).map(blockKey);
  const chips = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-chip]')) chips.set(el.dataset.chip as string, el);
  const gates = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-gate]')) gates.set(el.dataset.gate as string, el);

  let active: string | null = null;

  const headOf = (k: string) => gates.get(k)?.querySelector('h3')?.textContent?.trim() ?? k;

  const apply = () => {
    const targets = active ? (spec.map[active] ?? []) : [];
    const { who, how } = axesOf(targets);
    root.dataset.active = active ?? '';
    root.dataset.who = who.join(' ');
    root.dataset.how = how.join(' ');
    for (const [k, el] of chips) {
      el.setAttribute('aria-pressed', String(k === active));
      el.classList.toggle('is-active', k === active);
    }
    for (const [k, el] of gates) {
      el.classList.toggle('is-target', targets.includes(k));
      el.classList.toggle('is-dim', Boolean(active) && !targets.includes(k));
    }
  };

  const select = (key: string | null, announce = true) => {
    active = key === active ? null : key;
    apply();
    if (announce) {
      const t = active ? (spec.map[active] ?? []) : [];
      const chipText = active ? (chips.get(active)?.textContent?.trim() ?? active) : '';
      ctx.announce(active ? `${chipText}: ${t.map(headOf).join(' and ')}.` : 'Selection cleared.');
    }
    ctx.changed();
  };

  const off: Array<() => void> = [];
  if (ctx.interactive) {
    for (const [k, el] of chips) {
      const click = () => select(k);
      el.addEventListener('click', click);
      off.push(() => el.removeEventListener('click', click));
    }
  } else {
    for (const el of chips.values()) el.setAttribute('tabindex', '-1');
  }
  apply();

  return {
    kind: 'decision-tree',
    steps: 0,
    claimsDigits: true,
    getStep: () => 0,
    setStep: () => undefined,
    handleKey(e) {
      if (!ctx.interactive) return false;
      const d = digitOf(e);
      if (d >= 1 && d <= chipKeys.length) {
        select(chipKeys[d - 1] as string);
        return true;
      }
      if (e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (active) select(active);
        return true;
      }
      return false;
    },
    getState: () => ({ active }),
    setState(s) {
      const a = (s as { active?: unknown } | null)?.active;
      active = typeof a === 'string' && chips.has(a) ? a : null;
      apply();
    },
    dispose() {
      for (const f of off) f();
    },
  };
}
