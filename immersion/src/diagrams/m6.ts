/**
 * Module 6 diagrams: the cost-meter gauge beside the defence stack (slide 18) and the seam where a
 * probabilistic proposal meets a deterministic gate (slide 19).
 */

import type { DiagramSpec } from '../content/types';
import { icon, n1, svg, text } from './kit';

// --------------------------------------------------------------------------- slide 18: cost meter

const GA = { w: 520, h: 681, cx: 260, cy: 262, r: 196 };

const pt = (deg: number, r = GA.r): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [n1(GA.cx + r * Math.cos(a)), n1(GA.cy - r * Math.sin(a))];
};

const arc = (from: number, to: number, cls: string): string => {
  const [x0, y0] = pt(from);
  const [x1, y1] = pt(to);
  return `<path class="${cls}" d="M${x0} ${y0}A${GA.r} ${GA.r} 0 0 1 ${x1} ${y1}"/>`;
};

const meter = (y: number, glyph: 'coin' | 'shield', fillW: number, tone: string): string =>
  `<circle class="f-surface s-${tone} sw4" cx="62" cy="${y}" r="38"/>` +
  icon(glyph, 42, y - 20, 40, `d-ico s-${tone}`) +
  `<rect class="d-track" x="124" y="${y - 16}" width="372" height="32" rx="16"/>` +
  `<rect class="f-${tone}" x="124" y="${y - 16}" width="${fillW}" height="32" rx="16"/>`;

/**
 * A small meter for a large idea: spend is the dial, and a second meter shows coverage growing as
 * the scope widens. Text-free and decorative, sitting beside the stack and pointing down at the
 * cost-rule band.
 */
export const costMeter: DiagramSpec = {
  id: 'cost-meter',
  title: 'A cost meter and a coverage meter: start small, then widen scope while spend stays in budget',
  viewBox: `0 0 ${GA.w} ${GA.h}`,
  decorative: true,
  svg: svg(
    arc(180, 120, 'd-arc d-arc-green'),
    arc(116, 64, 'd-arc d-arc-amber'),
    arc(60, 0, 'd-arc d-arc-red'),
    `<path class="d-needle" d="M${GA.cx} ${GA.cy}L${pt(150, 150).join(' ')}"/>`,
    `<circle class="f-ink" cx="${GA.cx}" cy="${GA.cy}" r="22"/>`,
    meter(408, 'coin', 130, 'amber'),
    meter(500, 'shield', 232, 'azure'),
    `<path class="nf s-line-strong sw5 rd" d="M${GA.cx} 574V650M${GA.cx - 18} 630L${GA.cx} 654L${GA.cx + 18} 630"/>`,
  ),
};

// --------------------------------------------------------------------------- slide 19: the seam

const SM = { w: 1712, h: 601, zone: 600, seam: 856, top: 18 };
const STATIONS = [
  { hl: 'schema', label: 'Schema', glyph: 'table' as const, cy: 214 },
  { hl: 'allowlist', label: 'Allowlist', glyph: 'check' as const, cy: 338 },
  { hl: 'audit', label: 'Audit log', glyph: 'eye' as const, cy: 462 },
];

const station = (s: (typeof STATIONS)[number]): string =>
  `<g class="d-station" data-hl="${s.hl}" aria-label="${s.label} station">` +
  `<rect class="d-st" x="${SM.seam - 160}" y="${s.cy - 44}" width="320" height="88" rx="44"/>` +
  icon(s.glyph, SM.seam - 132, s.cy - 20, 40, 'd-ico s-green') +
  text(SM.seam - 70, s.cy + 11, s.label, { size: 34, weight: 650 }) +
  `</g>`;

/** Handbook Fig 16.1 recast: the model proposes on the left; a seam of gates disposes on the right. */
export const seamDiagram: DiagramSpec = {
  id: 'seam',
  title: 'The seam: a probabilistic model proposes, then schema, allowlist and audit-log checks sit on the seam before the deterministic side disposes. A rejected proposal returns to the model.',
  viewBox: `0 0 ${SM.w} ${SM.h}`,
  svg: svg(
    // zones
    `<rect class="d-zone-l" x="0" y="${SM.top}" width="${SM.zone}" height="${SM.h - SM.top - 20}" rx="40"/>`,
    `<rect class="d-zone-r" x="${SM.w - SM.zone}" y="${SM.top}" width="${SM.zone}" height="${SM.h - SM.top - 20}" rx="40"/>`,
    text(44, 92, 'Probabilistic', { size: 42, weight: 700, cls: 'f-violet' }),
    text(44, 142, 'Model proposes', { size: 32, weight: 600 }),
    icon('spark', 44, 196, 84, 'd-ico s-violet'),
    `<path class="nf s-violet sw5 rd" d="M44 470q30-54 60 0t60 0t60 0t60 0t60 0t60 0"/>`,
    icon('lock', SM.w - SM.zone + 44, 196, 84, 'd-ico s-azure'),
    // a tidy row of passed checks, the opposite of the model's wavy line
    ...[0, 1, 2, 3].map(
      (i) =>
        `<rect class="f-surface s-azure sw3" x="${SM.w - SM.zone + 92 + i * 84}" y="440" width="64" height="64" rx="16"/>` +
        `<path class="nf s-azure sw5 rd" d="M${SM.w - SM.zone + 92 + i * 84 + 15} 473l12 12 22-26"/>`,
    ),
    // the seam
    `<rect class="d-seam" x="${SM.seam - 7}" y="108" width="14" height="${SM.h - 108 - 28}" rx="7"/>`,
    text(SM.seam, 80, 'The seam', { size: 38, weight: 700, anchor: 'middle' }),
    // proposals cross the seam: one lane per station
    ...STATIONS.map(
      (s) =>
        `<path class="d-lane" d="M470 ${s.cy}H${SM.w - SM.zone + 20}"/>` +
        `<path class="d-lane-head" d="M${SM.w - SM.zone + 4} ${s.cy - 15}L${SM.w - SM.zone + 34} ${s.cy}L${SM.w - SM.zone + 4} ${s.cy + 15}Z"/>`,
    ),
    ...STATIONS.map(station),
    // the deterministic side is named last, so the labels read left to right: model, seam, gate
    text(SM.w - SM.zone + 44, 92, 'Deterministic', { size: 42, weight: 700, cls: 'f-azure' }),
    text(SM.w - SM.zone + 44, 142, 'Gate disposes', { size: 32, weight: 600 }),
    // reject: back to the model
    `<path class="d-reject" d="M${SM.seam} ${462 + 44}V560H520V508"/>`,
    `<path class="d-reject-head" d="M506 520L520 494L534 520Z"/>`,
    `<circle class="d-reject-dot" cx="${SM.seam}" cy="560" r="22"/>`,
    `<path class="nf s-surface sw5 rd" d="M${SM.seam - 9} 551l18 18M${SM.seam + 9} 551l-18 18"/>`,
  ),
};
