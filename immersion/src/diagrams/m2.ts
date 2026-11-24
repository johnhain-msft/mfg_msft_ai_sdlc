/**
 * Module 2 diagrams: the five-layer supply chain (slide 5) and the WHAT / HOW / OPERATIONS rail
 * (slide 6).
 */

import { esc } from '../content/html';
import type { DiagramSpec } from '../content/types';
import { icon, svg, text } from './kit';

// --------------------------------------------------------------------------- slide 5: supply chain

type Tone = 'azure' | 'violet' | 'green' | 'amber';

interface Layer {
  code: string;
  name: string;
  owner: string;
  tone: Tone;
  hl: string;
}

/** Handbook Ch 4 layers (bottom to top: L1 ... L5) with the Ch 6 section 6.4 owners. Colour = owner. */
const LAYERS: Layer[] = [
  { code: 'L5', name: 'SDLC phases', owner: 'Stream-aligned teams', tone: 'amber', hl: 'l5' },
  { code: 'L4', name: 'Agent harness', owner: 'Platform team', tone: 'azure', hl: 'l4' },
  { code: 'L3', name: 'Governance & distribution', owner: 'Platform + security', tone: 'violet', hl: 'l3' },
  { code: 'L2', name: 'Context & capabilities', owner: 'Domain specialist, workflow engineer', tone: 'green', hl: 'l2' },
  { code: 'L1', name: 'Platform', owner: 'Platform team', tone: 'azure', hl: 'l1' },
];

const SC = { w: 1712, h: 680, top: 12, bar: 120, gap: 14, x: 120 };

const layer = (l: Layer, i: number): string => {
  const y = SC.top + i * (SC.bar + SC.gap);
  const cy = y + SC.bar / 2;
  return (
    `<g class="d-layer tone-${l.tone}" data-hl="${l.hl}" aria-label="${esc(`${l.code} ${l.name}: ${l.owner}`)}">` +
    `<rect class="d-bar" x="${SC.x}" y="${y}" width="${SC.w - SC.x}" height="${SC.bar}" rx="24"/>` +
    `<path class="d-leader" d="M470 ${cy}H1070"/>` +
    // one label: the layer code in the owner's colour, then its name
    `<text x="${SC.x + 40}" y="${cy + 14}" font-size="38" font-weight="700" class="halo"><tspan class="f-tone">${l.code}</tspan><tspan dx="18">${esc(l.name)}</tspan></text>` +
    `<rect class="d-pill" x="1070" y="${cy - 36}" width="620" height="72" rx="36"/>` +
    text(1380, cy + 10, l.owner, { size: 29, weight: 650, anchor: 'middle' }) +
    `</g>`
  );
};

export const supplyChain: DiagramSpec = {
  id: 'supply-chain',
  title: 'The agentic supply chain, layer 1 (platform) at the base to layer 5 (SDLC phases) at the top, each with its owner',
  viewBox: `0 0 ${SC.w} ${SC.h}`,
  svg: svg(
    // supply runs upward: one arrow, a node per layer
    `<path class="nf s-line-strong sw6 rd" d="M52 656V44M30 68L52 36L74 68"/>`,
    ...LAYERS.map((_, i) => `<circle class="f-line-strong" cx="52" cy="${SC.top + i * (SC.bar + SC.gap) + SC.bar / 2}" r="10"/>`),
    ...LAYERS.map(layer),
  ),
};

// --------------------------------------------------------------------------- slide 6: roles rail

const RAIL = { w: 1712, h: 196, cy: 88, r: 68 };
const COLS = [273, 856, 1439];

const node = (cx: number, key: string, tone: Tone, glyph: 'doc' | 'layers' | 'gauge', later = false): string =>
  `<g class="d-role tone-${tone}${later ? ' is-later' : ''}" data-role="${key}">` +
  `<circle class="d-role-ring" cx="${cx}" cy="${RAIL.cy}" r="${RAIL.r}"/>` +
  icon(glyph, cx - 32, RAIL.cy - 32, 64, 'd-ico d-role-ico') +
  `<path class="d-stem" d="M${cx} ${RAIL.cy + RAIL.r + 6}V${RAIL.h - 2}"/>` +
  `</g>`;

export const rolesRail: DiagramSpec = {
  id: 'roles-rail',
  title: 'What a skill encodes, how it is built, then how it runs at scale',
  viewBox: `0 0 ${RAIL.w} ${RAIL.h}`,
  decorative: true,
  svg: svg(
    `<path class="nf s-line-strong sw6 rd" d="M367 ${RAIL.cy}H766M742 ${RAIL.cy - 20}L770 ${RAIL.cy}L742 ${RAIL.cy + 20}"/>`,
    `<path class="nf s-line-strong sw6 rd dash" d="M950 ${RAIL.cy}H1349M1325 ${RAIL.cy - 20}L1353 ${RAIL.cy}L1325 ${RAIL.cy + 20}"/>`,
    node(COLS[0] as number, 'what', 'azure', 'doc'),
    node(COLS[1] as number, 'how', 'violet', 'layers'),
    node(COLS[2] as number, 'operations', 'green', 'gauge', true),
  ),
};
