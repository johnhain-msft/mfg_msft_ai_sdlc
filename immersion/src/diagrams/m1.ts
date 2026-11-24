/**
 * Module 1 diagrams: the cover glyph, the two context-window gauges (slide 2) and the attention
 * curve (slide 3). Geometry is authored for the box each layout gives the figure on the
 * 1920x1080 stage (see styles/slides.css), so one user unit is about one stage pixel.
 */

import type { ArtSpec, DiagramSpec } from '../content/types';
import { icon, svg, text } from './kit';

// --------------------------------------------------------------------------- slide 1: hero loop

const heroGlyph = `
<g class="d-loop"><path d="M110 276 C110 400 530 400 530 276" fill="none"/></g>
<g class="d-edges" fill="none">
  <path d="M178 210 H262 M190 196 l-14 14 14 14 M250 196 l14 14 -14 14"/>
  <path d="M378 210 H462 M390 196 l-14 14 14 14 M450 196 l14 14 -14 14"/>
</g>
<g class="d-node d-node-human"><circle cx="110" cy="210" r="62"/><g class="d-icon" transform="translate(74 174) scale(3)" fill="none"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3.2-6 7-6s7 2 7 6"/></g></g>
<g class="d-node d-node-agent"><circle cx="320" cy="210" r="62"/><g class="d-icon" transform="translate(284 174) scale(3)" fill="none"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></g></g>
<g class="d-node d-node-platform"><circle cx="530" cy="210" r="62"/><g class="d-icon" transform="translate(494 174) scale(3)" fill="none"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/></g></g>`;

export const heroLoop: DiagramSpec = {
  id: 'hero-loop',
  title: 'Human, agent and platform loop',
  viewBox: '0 0 640 420',
  svg: heroGlyph,
  decorative: true,
};

// --------------------------------------------------------------------------- slide 2: context gauges

const GAUGE_W = 760;
const GAUGE_H = 300;
/** The context window: one frame, drawn the same in both cards so the two bars compare fairly. */
const frame =
  `<rect class="f-surface2 s-line-strong sw4" x="4" y="28" width="560" height="208" rx="30"/>` +
  `<path class="nf s-line-strong sw3 rd" d="M144 250v20M284 250v20M424 250v20"/>`;

/** A task that fits: the content bar sits well inside the window, with a check mark beside it. */
export const gaugeFits: ArtSpec = {
  viewBox: `0 0 ${GAUGE_W} ${GAUGE_H}`,
  svg: svg(
    frame,
    `<rect class="f-green" x="18" y="44" width="206" height="176" rx="18"/>`,
    `<circle class="f-green-soft s-green sw4" cx="662" cy="132" r="56"/>`,
    `<path class="nf s-green sw8 rd" d="M636 134l19 19 34-40"/>`,
  ),
};

/** The torn right edge of a bar that does not end: `teeth` zigzags from y0 to y1 at x. */
const torn = (x: number, y0: number, y1: number, teeth: number, depth: number): string => {
  const step = (y1 - y0) / (teeth * 2);
  let d = '';
  for (let i = 1; i <= teeth * 2; i++) d += `L${x + (i % 2 ? depth : 0)} ${Math.round((y0 + step * i) * 10) / 10}`;
  return d;
};

/** Brownfield: the content fills the window and keeps going, torn off at the edge of the picture. */
export const gaugeOverflows: ArtSpec = {
  viewBox: `0 0 ${GAUGE_W} ${GAUGE_H}`,
  svg: svg(
    `<defs><pattern id="hatch-s2" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="18" height="18" class="f-red-soft"/><path d="M0 0V18" class="s-red sw3"/></pattern></defs>`,
    frame,
    `<rect class="f-amber" x="18" y="44" width="536" height="176" rx="18"/>`,
    `<path class="s-red sw4 rd" fill="url(#hatch-s2)" d="M564 44H716${torn(716, 44, 220, 4, 26)}H564z"/>`,
    `<path class="nf s-red sw6 rd" d="M592 102l26 30-26 30M636 102l26 30-26 30"/>`,
  ),
};

// --------------------------------------------------------------------------- slide 3: attention curve

const VB3 = { w: 998, h: 827 };
const X0 = 130;
const X1 = 968;
const XM = 550;
const YB = 560;
const YT = 70;
const HEAD_Y = 129;
const TAIL_Y = 168;

/** U-shaped accuracy curve whose middle trough sits at `ty` (a bigger y is a deeper trough). */
const curve = (ty: number): string =>
  `M${X0} ${HEAD_Y} C 270 ${Math.round((HEAD_Y + (ty - HEAD_Y) * 0.04) * 10) / 10} 390 ${ty - 3} ${XM} ${ty} ` +
  `C 710 ${ty - 3} 830 ${Math.round((TAIL_Y + (ty - TAIL_Y) * 0.04) * 10) / 10} ${X1} ${TAIL_Y}`;

interface Lever {
  key: string;
  cls: string;
  ty: number;
  glyph: 'funnel' | 'target' | 'branch';
  label: string;
}

/** The three PROSE constraints that act directly on attention, each lifting the trough further. */
const LEVERS: Lever[] = [
  { key: 'progressive', cls: 'd-s1', ty: 318, glyph: 'funnel', label: 'Progressive Disclosure lifts the trough' },
  { key: 'scope', cls: 'd-s2', ty: 250, glyph: 'target', label: 'Reduced Scope lifts it further' },
  { key: 'orchestrated', cls: 'd-s3', ty: 182, glyph: 'branch', label: 'Orchestrated Composition nearly flattens it' },
];

const leverGroup = (l: Lever): string =>
  `<g class="d-stage ${l.cls}" data-stage="${l.key}" aria-label="${l.label}">` +
  `<path class="d-cv" d="${curve(l.ty)}"/>` +
  `<g class="d-mk"><circle cx="${XM}" cy="${l.ty}" r="27"/>${icon(l.glyph, XM - 15, l.ty - 15, 30, 'd-ico d-mk-ico')}</g>` +
  `</g>`;

export const attentionCurve: DiagramSpec = {
  id: 'attention-curve',
  title: 'Accuracy by position in the context window: highest at the head and tail, lowest in the middle trough. Three PROSE levers lift the trough.',
  viewBox: `0 0 ${VB3.w} ${VB3.h}`,
  svg: svg(
    // zone + frame
    `<rect class="d-zone" x="410" y="${YT}" width="280" height="${YB - YT}"/>`,
    `<path class="nf s-line sw2 dash-sm" d="M${X0} ${YT + 122}H${X1}M${X0} ${YT + 245}H${X1}M${X0} ${YT + 368}H${X1}"/>`,
    // axes
    `<path class="nf s-line-strong sw4 rd" d="M${X0} ${YB}V44M112 72L${X0} 42L148 72M${X0} ${YB}H986M960 542L990 ${YB}L960 578"/>`,
    // baseline curve, with the trough marked
    `<path class="d-base" d="${curve(364)}"/>`,
    `<circle class="f-red" cx="${XM}" cy="364" r="11"/>`,
    // the three levers
    ...LEVERS.map(leverGroup),
    // labels
    text(160, 52, 'Accuracy', { size: 32, weight: 650 }),
    text(270, 614, 'Head', { size: 30, weight: 650, anchor: 'middle' }),
    text(XM, 614, 'Middle trough', { size: 30, weight: 650, anchor: 'middle' }),
    text(829, 614, 'Tail', { size: 30, weight: 650, anchor: 'middle' }),
    // the window itself: instructions at the head, everything dragged in between, the task at the tail
    `<rect class="f-azure-soft s-azure sw3" x="${X0}" y="656" width="280" height="76" rx="14"/>`,
    `<rect class="f-azure" x="158" y="678" width="150" height="10" rx="5"/><rect class="f-azure" x="158" y="698" width="100" height="10" rx="5"/>`,
    `<rect class="f-amber-soft s-amber sw3 dash" x="410" y="656" width="280" height="76" rx="14"/>`,
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect class="f-amber" x="${438 + i * 34}" y="682" width="22" height="22" rx="5"/>`),
    `<rect class="f-azure-soft s-azure sw3" x="690" y="656" width="278" height="76" rx="14"/>`,
    `<rect class="f-azure" x="718" y="688" width="190" height="12" rx="6"/>`,
  ),
};
