/**
 * Module 7 diagrams and art: the progress rail under the room check (slide 22) and the speech bubble
 * that sits at the foot of each open-floor card (slide 23). Text-free and decorative.
 */

/**
 * Module 7 diagrams and art: the six-axis maturity radar (slide 23), the progress rail under the
 * room check (slide 24), and the speech bubble at the foot of each open-floor card (slide 25).
 * Text-free and decorative.
 */

import type { ArtSpec, DiagramSpec } from '../content/types';
import { n1, svg } from './kit';

/** A progress rail under the three scenario cards: the node for the active question lights up. */
const QP = { w: 1712, h: 96, cy: 48, r: 30 };
const QP_COLS = [275, 856, 1437] as const;
const QP_TONES = ['azure', 'violet', 'amber'] as const;

export const quizProgress: DiagramSpec = {
  id: 'quiz-progress',
  title: 'Progress through the three scenarios',
  viewBox: `0 0 ${QP.w} ${QP.h}`,
  decorative: true,
  svg: svg(
    `<path class="nf s-line-strong sw5 rd dash" d="M${QP_COLS[0] + QP.r + 24} ${QP.cy}H${QP_COLS[1] - QP.r - 24}M${QP_COLS[1] + QP.r + 24} ${QP.cy}H${QP_COLS[2] - QP.r - 24}"/>`,
    ...QP_COLS.map(
      (cx, i) =>
        `<g class="d-qp tone-${QP_TONES[i]}" data-qp="${i}"><circle class="d-qp-ring" cx="${cx}" cy="${QP.cy}" r="${QP.r}"/><circle class="d-qp-dot" cx="${cx}" cy="${QP.cy}" r="10"/></g>`,
    ),
  ),
};

/** Six-axis maturity radar profile: concentric levels, baseline polygon, target polygon, and numbered spoke badges 1-6. */
const MR = { w: 540, h: 560, cx: 270, cy: 256, r: 186 };
const MR_TONES = ['green', 'violet', 'amber', 'azure', 'green', 'violet'] as const;
const MR_CURRENT = [0.68, 0.52, 0.58, 0.36, 0.44, 0.62] as const;
const MR_TARGET = [0.88, 0.84, 0.8, 0.74, 0.78, 0.9] as const;

/** Stroke-path numerals 1..6 centered at (0,0) in a 24x24 box so each spoke matches its numbered row without adding DOM words. */
const DIGIT_PATHS: readonly string[] = [
  'M-3 -7L1 -11V11M-5 11H7',
  'M-7 -6C-7 -12 7 -12 7 -4C7 2 -7 5 -7 11H8',
  'M-7 -9H6L-1 -1C6 -1 8 11 -1 11C-5 11 -7 9 -8 7',
  'M4 11V-11L-8 4H8',
  'M7 -11H-6L-7 -1C-4 -3 8 -3 8 5C8 11 -4 12 -8 8',
  'M6 -8C3 -12 -7 -10 -7 1C-7 10 7 12 7 4C7 -2 -6 -2 -7 3',
];

const hexPt = (idx: number, radius: number): [number, number] => {
  const rad = ((-90 + idx * 60) * Math.PI) / 180;
  return [n1(MR.cx + radius * Math.cos(rad)), n1(MR.cy + radius * Math.sin(rad))];
};

const poly = (radii: readonly number[]): string =>
  radii.map((f, i) => hexPt(i, MR.r * f).join(' ')).join(' ');

export const maturityRadar: DiagramSpec = {
  id: 'maturity-radar',
  title: 'Six-axis maturity radar comparing uneven current state (dashed) against target capability profile (solid) across spokes 1 to 6',
  viewBox: `0 0 ${MR.w} ${MR.h}`,
  decorative: true,
  svg: svg(
    ...[0.33, 0.66, 1].map(
      (ring) => `<polygon class="nf s-line sw3" points="${poly([ring, ring, ring, ring, ring, ring])}"/>`,
    ),
    ...Array.from({ length: 6 }, (_, i) => {
      const [x, y] = hexPt(i, MR.r);
      return `<line class="s-line-strong sw3" x1="${MR.cx}" y1="${MR.cy}" x2="${x}" y2="${y}"/>`;
    }),
    `<polygon class="f-violet-soft s-violet sw4 dash-sm" points="${poly(MR_CURRENT)}"/>`,
    `<polygon class="nf s-azure sw6 rd" points="${poly(MR_TARGET)}"/>`,
    ...MR_TONES.map((tone, i) => {
      const [x, y] = hexPt(i, MR.r + 36);
      const [tx, ty] = hexPt(i, MR.r * MR_TARGET[i]!);
      return (
        `<circle class="f-${tone}" cx="${tx}" cy="${ty}" r="9"/>` +
        `<rect class="f-${tone}-soft s-${tone} sw4" x="${n1(x - 24)}" y="${n1(y - 24)}" width="48" height="48" rx="12"/>` +
        `<path class="nf s-ink sw4 rd" transform="translate(${x} ${y})" d="${DIGIT_PATHS[i]}"/>`
      );
    }),
    // Visual key at foot: dashed = current profile, solid = target profile
    `<rect class="f-violet-soft s-violet sw4 dash-sm" x="148" y="514" width="88" height="24" rx="8"/>`,
    `<path class="nf s-line-strong sw4 rd" d="M254 526H286M276 518L288 526L276 534"/>`,
    `<rect class="f-surface s-azure sw5" x="304" y="514" width="88" height="24" rx="8"/>`,
  ),
};

/** A speech bubble with three "typing" dots, colored by the card's tone. */
export const bubbleArt: ArtSpec = {
  viewBox: '0 0 300 150',
  svg: svg(
    `<path class="f-tone-soft s-tone sw4" d="M34 14H266a26 26 0 0 1 26 26V92a26 26 0 0 1-26 26H112L72 146V118H34A26 26 0 0 1 8 92V40A26 26 0 0 1 34 14Z"/>`,
    `<circle class="f-tone" cx="100" cy="66" r="11"/>`,
    `<circle class="f-tone" cx="150" cy="66" r="11"/>`,
    `<circle class="f-tone" cx="200" cy="66" r="11"/>`,
  ),
};
