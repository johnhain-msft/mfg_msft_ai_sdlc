/**
 * Slide 14 widget: Prompt Debugger & Cost Simulator (`m4-prompt-debugger`).
 *
 * Four levers (keys 1-4) drive a live SVG stacked cost bar and a numeric readout, from the
 * Handbook's illustrative undesigned run ($41.01) down to its designed run ($4.81):
 *
 *   1 Scope context   Progressive Disclosure       3,800 flat lines  -> 450 scoped lines
 *   2 Stable prefix   Cache-Aware Prefix           0% cache hits     -> 80%+
 *   3 Tool subset     Tool Subset                  65 tools a turn   -> 6 scoped tools
 *   4 Routed models   Model Router + Gradient      15 frontier turns -> 1 planner + 3 mid-tier,
 *                     Workflow + Retry/Turn Budget                      with a two-round cap
 *
 * It is a TEACHING MODEL, not a quote. Prices are relative (frontier input = 1.0); two constants
 * are solved in closed form at load so the corners land exactly on the targets. Intermediate
 * states are model outputs. Nothing here is vendor pricing.
 *
 * UNION OF STATES: the only text a state change touches is the first numeral of the readout,
 * `$41.01 -> $4.81 per run`, which stays one word. Bar geometry, tile state and colours change;
 * prose never does.
 */

import { esc } from '../content/html';
import { TOKEN_LEVERS, type Slide, type TokenLever, type TokenModelParams, type TokenModelSpec } from '../content/types';
import { type BlockDecor, type MountContext, type WidgetHandle, type WidgetRenderHooks, digitOf, isActivateKey } from './types';

// --------------------------------------------------------------------------- pure model

export type LeverState = Record<TokenLever, boolean>;

export const ALL_OFF: Readonly<LeverState> = { scope: false, prefix: false, tools: false, routing: false };
export const ALL_ON: Readonly<LeverState> = { scope: true, prefix: true, tools: true, routing: true };

/** Lever state <-> bitmask (bit i = TOKEN_LEVERS[i]). */
export const leversFromBits = (bits: number): LeverState =>
  Object.fromEntries(TOKEN_LEVERS.map((k, i) => [k, Boolean(bits & (1 << i))])) as LeverState;
export const bitsFromLevers = (s: LeverState): number =>
  TOKEN_LEVERS.reduce((n, k, i) => n | (s[k] ? 1 << i : 0), 0);

export interface Calibrated {
  params: TokenModelParams;
  /** Dollars per relative price unit per token (a frontier input token costs this much). */
  usdPerToken: number;
  /** Mid-tier price as a fraction of frontier price, solved so the all-on run hits `targets.on`. */
  midRatio: number;
  /** Frontier-input-token equivalents of the all-off run. */
  unitsOff: number;
}

export interface Cost {
  context: number;
  tools: number;
  work: number;
  total: number;
}

const cache = new WeakMap<TokenModelParams, Calibrated>();

const cachedMultiplier = (p: TokenModelParams, hit: number): number => 1 - hit * (1 - p.cachedPriceRatio);
const contextTokens = (p: TokenModelParams, on: boolean): number =>
  p.systemTokens + (on ? p.contextLines.on : p.contextLines.off) * p.tokensPerLine;
const toolTokens = (p: TokenModelParams, on: boolean): number => (on ? p.tools.on : p.tools.off) * p.tokensPerTool;
const workUnits = (p: TokenModelParams): number => p.work.inputTokens + p.outputPriceRatio * p.work.outputTokens;

/** Units (frontier input-token equivalents) per component for a lever state and mid-tier ratio. */
function units(p: TokenModelParams, s: LeverState, mid: number): Omit<Cost, 'total'> {
  const eff = cachedMultiplier(p, s.prefix ? p.cacheHit.on : p.cacheHit.off);
  const turnUnits = s.routing ? p.turns.plan + p.turns.exec * mid : p.turns.off;
  return {
    context: contextTokens(p, s.scope) * eff * turnUnits,
    tools: toolTokens(p, s.tools) * eff * turnUnits,
    work: workUnits(p) * (s.routing ? mid : 1),
  };
}

const sum = (c: Omit<Cost, 'total'>): number => c.context + c.tools + c.work;

/**
 * Solve the two free constants in closed form so the corners are exact:
 *   all-off total = targets.off      (fixes the dollar value of the price unit)
 *   all-on  total = targets.on       (fixes the mid-tier price ratio)
 * Throws when the inputs cannot produce a sensible model (mid-tier ratio outside 0..1).
 */
export function calibrate(p: TokenModelParams): Calibrated {
  const hit = cache.get(p);
  if (hit) return hit;
  const unitsOff = sum(units(p, ALL_OFF, 1));
  const rho = p.targets.on / p.targets.off;
  const eff = cachedMultiplier(p, p.cacheHit.on);
  const a = (contextTokens(p, true) + toolTokens(p, true)) * eff;
  const mid = (rho * unitsOff - a * p.turns.plan) / (a * p.turns.exec + workUnits(p));
  if (!(mid > 0 && mid < 1)) {
    throw new Error(`token model cannot be calibrated: mid-tier ratio ${mid.toFixed(3)} is outside (0, 1)`);
  }
  const out: Calibrated = { params: p, usdPerToken: p.targets.off / unitsOff, midRatio: mid, unitsOff };
  cache.set(p, out);
  return out;
}

export function costOf(m: Calibrated, s: LeverState): Cost {
  const u = units(m.params, s, m.midRatio);
  const k = m.usdPerToken;
  return { context: u.context * k, tools: u.tools * k, work: u.work * k, total: sum(u) * k };
}

export const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

export const READOUT_SEPARATOR = '\u2192';

/** Static readout copy: `$41.01 -> $4.81 per run`. The slide's `stat` must equal this. */
export function readoutText(m: Calibrated): string {
  return `${formatUsd(m.params.targets.off)} ${READOUT_SEPARATOR} ${formatUsd(m.params.targets.on)} per run`;
}

// --------------------------------------------------------------------------- bar geometry

export const BAR_WIDTH = 1200;
const TRACK_Y = 30;
const TRACK_H = 104;
const VIEW_H = TRACK_Y + TRACK_H + 30;

export interface Seg {
  key: 'context' | 'tools' | 'work';
  x: number;
  width: number;
}

/** Segment geometry in SVG units: the full track is the undesigned run, so savings read as empty track. */
export function barLayout(m: Calibrated, s: LeverState): { segs: Seg[]; floorX: number } {
  const c = costOf(m, s);
  const px = (usd: number) => (usd / m.params.targets.off) * BAR_WIDTH;
  const ctx = px(c.context);
  const tools = px(c.tools);
  const work = px(c.work);
  return {
    segs: [
      { key: 'context', x: 0, width: ctx },
      { key: 'tools', x: ctx, width: tools },
      { key: 'work', x: ctx + tools, width: work },
    ],
    floorX: px(m.params.targets.on),
  };
}

const n1 = (n: number): string => (Math.round(n * 10) / 10).toString();

const SEG_CLASS: Record<Seg['key'], string> = { context: 'ctx', tools: 'tools', work: 'work' };

function barSvg(m: Calibrated): string {
  const { segs, floorX } = barLayout(m, ALL_OFF);
  const rects = segs
    .map(
      (g) =>
        `<rect class="seg seg-${SEG_CLASS[g.key]}" data-seg="${g.key}" x="${n1(g.x)}" y="${TRACK_Y}" width="${n1(g.width)}" height="${TRACK_H}" rx="6"/>`,
    )
    .join('');
  return (
    `<figure class="costbar" data-costbar>` +
    `<svg viewBox="0 0 ${BAR_WIDTH} ${VIEW_H}" role="img" aria-label="Estimated cost per run, stacked by context, tools and task work">` +
    `<rect class="track" x="0" y="${TRACK_Y}" width="${BAR_WIDTH}" height="${TRACK_H}" rx="16"/>` +
    rects +
    `<g class="floor" data-floor aria-hidden="true"><line x1="${n1(floorX)}" x2="${n1(floorX)}" y1="14" y2="${TRACK_Y + TRACK_H + 16}"/>` +
    `<path d="M${n1(floorX - 12)} 4h24l-12 18z"/></g>` +
    `</svg></figure>`
  );
}

// --------------------------------------------------------------------------- speaker drawer text

const int = (n: number): string => Math.round(n).toLocaleString('en-US');
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Plain-text assumptions for the speaker-only drawer: every token count and relative unit cost. */
export function describeAssumptions(m: Calibrated): string {
  const p = m.params;
  return [
    'Illustrative model, not vendor pricing. Prices are relative; corners are calibrated.',
    '',
    'Token inputs',
    `  Context payload   ${int(p.contextLines.off)} lines \u2192 ${int(p.contextLines.on)} lines, ${p.tokensPerLine} tokens per line`,
    `  Standing prompt   ${int(p.systemTokens)} tokens, always loaded`,
    `  Prefix cache      ${pct(p.cacheHit.off)} \u2192 ${pct(p.cacheHit.on)} of the repeated prefix cached`,
    `  Tool definitions  ${p.tools.off} \u2192 ${p.tools.on} tools, ${p.tokensPerTool} tokens each`,
    `  Turns             ${p.turns.off} frontier \u2192 ${p.turns.plan} frontier planner + ${p.turns.exec} mid-tier executors`,
    `  Task work         ${int(p.work.inputTokens)} input + ${int(p.work.outputTokens)} output tokens, identical in every state`,
    '',
    'Relative unit costs (frontier input = 1.00)',
    `  Frontier input 1.00 \u00b7 frontier output ${p.outputPriceRatio.toFixed(2)} \u00b7 cached input ${p.cachedPriceRatio.toFixed(2)}`,
    `  Mid tier ${m.midRatio.toFixed(2)} of frontier (solved so all levers on = ${formatUsd(p.targets.on)})`,
    '',
    'Calibration',
    `  1.00 price unit = ${formatUsd(m.usdPerToken * 1e6)} per million input tokens (solved so all levers off = ${formatUsd(p.targets.off)})`,
  ].join('\n');
}

// --------------------------------------------------------------------------- render hooks

const specOf = (slide: Slide): TokenModelSpec | undefined =>
  slide.widget?.kind === 'token-model' || slide.widget?.kind === 'prompt-debugger' ? slide.widget : undefined;

export const tokenModelHooks: WidgetRenderHooks = {
  block(slide, block): BlockDecor | undefined {
    const key = block.key as TokenLever | undefined;
    if (!specOf(slide) || !key || !(TOKEN_LEVERS as readonly string[]).includes(key)) return undefined;
    return {
      classes: ['lever'],
      attrs: { role: 'switch', tabindex: 0, 'aria-checked': 'false', 'data-lever': key },
    };
  },
  stat(slide) {
    const spec = specOf(slide);
    if (!spec || !slide.stat) return undefined;
    const m = calibrate(spec.params);
    const off = formatUsd(m.params.targets.off);
    const html = esc(slide.stat).replace(esc(off), () => `<span data-cost-now>${esc(off)}</span>`);
    return `<p class="stat" data-readout aria-live="polite">${html}</p>`;
  },
  prelude(slide) {
    const spec = specOf(slide);
    return spec ? barSvg(calibrate(spec.params)) : '';
  },
  root(slide) {
    return specOf(slide) ? { 'data-widget': 'token-model', 'data-levers': '0000' } : undefined;
  },
};

// --------------------------------------------------------------------------- mount

export function mountTokenModel(root: HTMLElement, slide: Slide, ctx: MountContext): WidgetHandle {
  const spec = specOf(slide);
  if (!spec) throw new Error('mountTokenModel: slide has no token-model widget');
  const model = calibrate(spec.params);
  const tiles = new Map<TokenLever, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-lever]')) tiles.set(el.dataset.lever as TokenLever, el);
  const segs = new Map<string, SVGRectElement>();
  for (const el of root.querySelectorAll<SVGRectElement>('[data-seg]')) segs.set(el.dataset.seg as string, el);
  const floor = root.querySelector<SVGGElement>('[data-floor]');
  const now = root.querySelector<HTMLElement>('[data-cost-now]');

  let state: LeverState = { ...ALL_OFF };

  const apply = () => {
    const { segs: layout } = barLayout(model, state);
    for (const g of layout) {
      const el = segs.get(g.key);
      el?.setAttribute('x', n1(g.x));
      el?.setAttribute('width', n1(g.width));
    }
    const total = costOf(model, state).total;
    if (now) now.textContent = formatUsd(total);
    const allOn = TOKEN_LEVERS.every((k) => state[k]);
    root.dataset.levers = TOKEN_LEVERS.map((k) => (state[k] ? '1' : '0')).join('');
    root.classList.toggle('is-floor', allOn);
    floor?.classList.toggle('is-reached', allOn);
    for (const [k, el] of tiles) {
      el.setAttribute('aria-checked', String(state[k]));
      el.classList.toggle('is-on', state[k]);
    }
  };

  const nameOf = (k: TokenLever): string => tiles.get(k)?.querySelector('h3')?.textContent?.trim() ?? k;

  const flip = (k: TokenLever) => {
    state = { ...state, [k]: !state[k] };
    apply();
    ctx.announce(`${nameOf(k)} ${state[k] ? 'on' : 'off'}. Estimated ${formatUsd(costOf(model, state).total)} per run.`);
    ctx.changed();
  };

  const reset = () => {
    state = { ...ALL_OFF };
    apply();
    ctx.announce(`All levers off. Estimated ${formatUsd(costOf(model, state).total)} per run.`);
    ctx.changed();
  };

  const off: Array<() => void> = [];
  if (ctx.interactive) {
    for (const [k, el] of tiles) {
      const click = () => flip(k);
      const key = (e: KeyboardEvent) => {
        if (isActivateKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          flip(k);
        }
      };
      el.addEventListener('click', click);
      el.addEventListener('keydown', key);
      off.push(() => el.removeEventListener('click', click), () => el.removeEventListener('keydown', key));
    }
  } else {
    for (const el of tiles.values()) el.setAttribute('tabindex', '-1');
  }
  apply();

  return {
    kind: 'token-model',
    steps: 0,
    claimsDigits: true,
    getStep: () => 0,
    setStep: () => undefined,
    handleKey(e) {
      if (!ctx.interactive) return false;
      const d = digitOf(e);
      if (d >= 1 && d <= TOKEN_LEVERS.length) {
        flip(TOKEN_LEVERS[d - 1] as TokenLever);
        return true;
      }
      if (e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        reset();
        return true;
      }
      return false;
    },
    getState: () => ({ bits: bitsFromLevers(state) }),
    setState(s) {
      const bits = typeof (s as { bits?: unknown } | null)?.bits === 'number' ? (s as { bits: number }).bits : 0;
      state = leversFromBits(bits);
      apply();
    },
    dispose() {
      for (const f of off) f();
    },
  };
}
