/**
 * Helpers for authoring inline SVG diagrams. Pure strings, no DOM, importable from Node.
 *
 * House rules (rules.ts enforces the first two, slide-review measures the rest):
 *   - every <text> carries its own explicit `font-size`, at least 22 in user units;
 *   - a diagram's `viewBox` matches the box the layout gives it on the 1920x1080 stage, so one
 *     user unit is about one stage pixel and a 26-unit label really is about 26px tall;
 *   - colour comes from the theme tokens through the utility classes in `styles/diagrams.css`
 *     (`f-azure`, `s-violet`, `t-green` ...), never from literals, so light and dark both work;
 *   - labels are exactly the slide's LABEL copy: nothing is added to a diagram that the
 *     slide copy did not put there.
 */

import { esc } from '../content/html';
import type { IconName } from '../content/types';
import { ICONS } from '../shell/render';

export interface TextOpts {
  /** Font size in user units. Always written as an explicit attribute. Default 26. */
  size?: number;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  /** Utility classes (`f-muted`, `halo`, ...). */
  cls?: string;
  /** Extra raw attributes, e.g. `data-x="1"`. */
  attrs?: string;
}

/** One `<text>` label. */
export function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const { size = 26, weight, anchor, cls, attrs } = o;
  return (
    `<text x="${x}" y="${y}" font-size="${size}"` +
    (weight ? ` font-weight="${weight}"` : '') +
    (anchor && anchor !== 'start' ? ` text-anchor="${anchor}"` : '') +
    (cls ? ` class="${cls}"` : '') +
    (attrs ? ` ${attrs}` : '') +
    `>${esc(s)}</text>`
  );
}

/**
 * A label that wraps over several lines but stays ONE `<text>` (one label to the rules): the
 * lines are `<tspan>`s and read back as `"line1 line2"`.
 */
export function lines(x: number, y: number, parts: string[], o: TextOpts & { lh?: number } = {}): string {
  const { size = 26, weight, anchor, cls, attrs, lh = Math.round(size * 1.22) } = o;
  const spans = parts.map((p, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(p)}</tspan>`).join('');
  return (
    `<text x="${x}" y="${y}" font-size="${size}"` +
    (weight ? ` font-weight="${weight}"` : '') +
    (anchor && anchor !== 'start' ? ` text-anchor="${anchor}"` : '') +
    (cls ? ` class="${cls}"` : '') +
    (attrs ? ` ${attrs}` : '') +
    `>${spans}</text>`
  );
}

/** A stroke glyph from the shared icon set, top-left at (x, y), `size` user units wide. */
export function icon(name: IconName, x: number, y: number, size: number, cls = 'd-ico'): string {
  return `<g class="${cls}" transform="translate(${x} ${y}) scale(${+(size / 24).toFixed(4)})">${ICONS[name]}</g>`;
}

/** Round to one decimal so path strings stay short and stable. */
export const n1 = (n: number): number => Math.round(n * 10) / 10;

/** Join already-built SVG fragments. */
export const svg = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join('');
