/**
 * Module 4 diagrams: the balance scale (slide 11), the executive ROI trace (slide 12),
 * the honest Year-1 bill with its J-curve (slide 13), and the to-scale twin cost bars (slide 14).
 */

import type { DiagramSpec, IconName } from '../content/types';
import { icon, lines, n1, svg, text } from './kit';

/** Uniform Catmull-Rom spline through `pts`, as one SVG path of cubic Beziers. */
export function smooth(pts: Array<[number, number]>): string {
  const p = (i: number): [number, number] => pts[Math.max(0, Math.min(pts.length - 1, i))] as [number, number];
  let d = `M${n1(p(0)[0])} ${n1(p(0)[1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = p(i - 1);
    const [x1, y1] = p(i);
    const [x2, y2] = p(i + 1);
    const [x3, y3] = p(i + 2);
    d += ` C${n1(x1 + (x2 - x0) / 6)} ${n1(y1 + (y2 - y0) / 6)} ${n1(x2 - (x3 - x1) / 6)} ${n1(y2 - (y3 - y1) / 6)} ${n1(x2)} ${n1(y2)}`;
  }
  return d;
}

// --------------------------------------------------------------------------- slide 11: balance scale

/**
 * A balance between the two cards. The token bill is one small chip on the lighter pan; the
 * business process is a stack of three blocks (cost today, cost with AI, value) on the heavier one.
 * Text-free and decorative: the cards beside it name the two views.
 */
const BAL = { w: 430, h: 530, oy: -106, cx: 215, half: 140, tilt: 8 };

const balance = (): string => {
  const { cx, oy, half, tilt } = BAL;
  const rad = (tilt * Math.PI) / 180;
  const dx = half * Math.cos(rad);
  const dy = half * Math.sin(rad);
  const pivotY = 150 + oy;
  const lx = cx - dx;
  const ly = pivotY - dy;
  const rx = cx + dx;
  const ry = pivotY + dy;
  const drop = 176;
  const pan = (px: number, py: number): string =>
    `<path class="d-str" d="M${n1(px)} ${n1(py)}L${n1(px - 62)} ${n1(py + drop)}M${n1(px)} ${n1(py)}L${n1(px + 62)} ${n1(py + drop)}"/>` +
    `<path class="d-pan" transform="translate(${n1(px)} ${n1(py + drop)})" d="M-64 0H64C64 32 32 42 0 42C-32 42-64 32-64 0Z"/>`;
  const leftTop = ly + drop;
  const rightTop = ry + drop;
  return svg(
    `<rect class="f-line" x="${cx - 120}" y="${630 + oy - 40}" width="240" height="30" rx="15"/>`,
    `<rect class="f-line-strong" x="${cx - 11}" y="${pivotY}" width="22" height="${630 + oy - 40 - pivotY}" rx="11"/>`,
    `<g transform="rotate(${tilt} ${cx} ${pivotY})"><rect class="f-ink" x="${cx - half - 12}" y="${pivotY - 11}" width="${(half + 12) * 2}" height="22" rx="11"/></g>`,
    pan(lx, ly),
    pan(rx, ry),
    `<circle class="f-ink" cx="${cx}" cy="${pivotY}" r="24"/>`,
    // the token bill: one small chip
    `<rect class="f-azure" x="${n1(lx - 26)}" y="${n1(leftTop - 44)}" width="52" height="44" rx="10"/>`,
    // the business process: cost today, cost with AI, value
    `<rect class="f-azure" x="${n1(rx - 56)}" y="${n1(rightTop - 44)}" width="112" height="44" rx="10"/>`,
    `<rect class="f-violet" x="${n1(rx - 44)}" y="${n1(rightTop - 92)}" width="88" height="44" rx="10"/>`,
    `<rect class="f-green" x="${n1(rx - 32)}" y="${n1(rightTop - 140)}" width="64" height="44" rx="10"/>`,
  );
};

export const balanceScale: DiagramSpec = {
  id: 'balance-scale',
  title: 'A balance: the token bill on one pan, the whole business process on the heavier pan',
  viewBox: `0 0 ${BAL.w} ${BAL.h}`,
  decorative: true,
  svg: balance(),
};

// --------------------------------------------------------------------------- slide 12: Year-1 bill + J-curve

const TCO = { w: 1712, h: 626 };

const chip = (x: number, y: number, label: string, w: number): string =>
  `<rect class="d-chip" x="${x}" y="${y}" width="${w}" height="62" rx="31"/>` +
  text(x + w / 2, y + 41, label, { size: 28, weight: 600, anchor: 'middle' });

const costBar = (): string => {
  const oy = 50;
  return svg(
    text(0, 56 + oy, 'Licenses ~20\u201325%\u2020', { size: 32, weight: 700, cls: 'f-azure' }),
    // two segments only: licenses, and everything else (no widths are implied for the five costs)
    `<rect class="f-azure" x="0" y="${90 + oy}" width="172" height="104" rx="20"/>`,
    `<rect class="d-rest" x="184" y="${90 + oy}" width="596" height="104" rx="20"/>`,
    `<path class="nf s-line-strong sw4 rd" d="M204 ${212 + oy}v18h556v-18M482 ${230 + oy}v26"/>`,
    chip(204, 268 + oy, 'Context engineering', 350),
    chip(574, 268 + oy, 'Tokens', 150),
    chip(204, 350 + oy, 'Training', 180),
    chip(404, 350 + oy, 'Governance', 216),
    chip(204, 432 + oy, 'Adoption dip', 244),
  );
};

const JX = 860;
const PHASE = 213;
const JPLOT = { top: 24, bottom: 520, base: 290 };

const jCurve = (): string => {
  const pts: Array<[number, number]> = [
    [0, JPLOT.base],
    [PHASE * 0.5, 296],
    [PHASE, 316],
    [PHASE * 1.5, 412],
    [PHASE * 2, 290],
    [PHASE * 2.5, 228],
    [PHASE * 3, 168],
    [PHASE * 3.5, 104],
    [PHASE * 4, 46],
  ];
  const phases: Array<[string, string[]]> = [
    ['d-ph', ['1\u20132', 'Setup']],
    ['d-ph d-ph-valley', ['2\u20134', 'Valley']],
    ['d-ph', ['4\u20136', 'Inflection']],
    ['d-ph', ['6\u201312', 'Compounding']],
  ];
  return (
    `<g transform="translate(${JX} 0)">` +
    phases.map(([cls], i) => `<rect class="${cls}" x="${i * PHASE}" y="${JPLOT.top}" width="${PHASE}" height="${JPLOT.bottom - JPLOT.top}"/>`).join('') +
    `<path class="nf s-line-strong sw3 dash-sm" d="M0 ${JPLOT.base}H${PHASE * 4}"/>` +
    `<path class="nf s-line-strong sw4 rd" d="M0 ${JPLOT.bottom}H${PHASE * 4 + 6}"/>` +
    `<path class="d-jcurve" d="${smooth(pts)}"/>` +
    `<circle class="f-violet" cx="${PHASE * 4}" cy="46" r="13"/>` +
    text(PHASE * 4 - 16, JPLOT.bottom - 24, 'Months', { size: 26, weight: 600, anchor: 'end', cls: 'f-muted' }) +
    phases.map(([, parts], i) => lines(PHASE * i + PHASE / 2, 566, parts, { size: 28, weight: 650, anchor: 'middle', lh: 32 })).join('') +
    `</g>`
  );
};

export const honestTco: DiagramSpec = {
  id: 'honest-tco',
  title: 'The Year-1 bill: licenses are roughly a fifth to a quarter, beside five other costs; and the four-phase adoption J-curve',
  viewBox: `0 0 ${TCO.w} ${TCO.h}`,
  svg: svg(costBar(), jCurve()),
};

// --------------------------------------------------------------------------- slide 13: twin bars

const TW = { w: 1040, h: 626, x0: 100, full: 840, loops: 5, gap: 8 };
const PRICE = { undesigned: 41.01, designed: 4.81 };

const twinBars = (): string => {
  const perDollar = TW.full / PRICE.undesigned;
  const segW = (TW.full - (TW.loops - 1) * TW.gap) / TW.loops;
  const longBar = Array.from(
    { length: TW.loops },
    (_, i) => `<rect class="d-loop-seg" x="${n1(TW.x0 + i * (segW + TW.gap))}" y="100" width="${n1(segW)}" height="100" rx="16"/>`,
  ).join('');
  const shortW = n1(PRICE.designed * perDollar);
  const endX = TW.x0 + TW.full;
  return svg(
    `<circle class="f-surface s-red sw5" cx="44" cy="150" r="40"/>`,
    icon('loop', 24, 130, 40, 'd-ico f-none s-red'),
    longBar,
    `<circle class="f-surface s-green sw5" cx="44" cy="476" r="40"/>`,
    icon('check', 24, 456, 40, 'd-ico f-none s-green'),
    `<rect class="d-short" x="${TW.x0}" y="426" width="${shortW}" height="100" rx="16"/>`,
    // one bracket joins both rows: same output
    `<path class="nf s-line-strong sw4 rd" d="M${endX + 20} 150H${endX + 56}V476H${endX + 20}"/>`,
    `<circle class="f-surface s-line-strong sw4" cx="${endX + 56}" cy="313" r="34"/>`,
    `<path class="nf s-ink sw6 rd" d="M${endX + 40} 303h32M${endX + 40} 323h32"/>`,
  );
};

export const twinBarsDiagram: DiagramSpec = {
  id: 'twin-bars',
  title: 'Two bars drawn to scale, $41.01 and $4.81, joined by a bracket because the output is identical',
  viewBox: `0 0 ${TW.w} ${TW.h}`,
  decorative: true,
  svg: twinBars(),
};

// --------------------------------------------------------------------------- slide 12: executive ROI trace + net value

const ROI = { w: 480, h: 520 };

const roiTrace = (): string => {
  const nodes: Array<[number, IconName, string]> = [
    [76, 'flag', 'azure'],
    [192, 'spark', 'violet'],
    [308, 'check', 'green'],
    [424, 'target', 'amber'],
  ];
  return svg(
    // End-to-end trace spine on the left: request -> agent run -> PR/evals -> prod outcome
    `<path class="nf s-line-strong sw5 rd dash-sm" d="M88 76V424"/>`,
    ...nodes.map(
      ([cy, ic, tone]) =>
        `<circle class="f-${tone}-soft s-${tone} sw5" cx="88" cy="${cy}" r="40"/>` +
        icon(ic, 66, cy - 22, 44, `d-ico f-none s-${tone}`),
    ),
    // Connector into the executive ROI stack on the right
    `<path class="nf s-line-strong sw4 rd" d="M138 250H196M184 238L198 250L184 262"/>`,
    // Net ROI frame: verified value + cost avoided vs full operating cost
    `<rect class="f-surface s-line-strong sw4" x="212" y="44" width="248" height="412" rx="26"/>`,
    `<rect class="f-green-soft s-green sw4" x="238" y="72" width="196" height="106" rx="18"/>`,
    icon('spark', 314, 103, 44, 'd-ico f-none s-green'),
    `<rect class="f-azure-soft s-azure sw4" x="238" y="196" width="196" height="96" rx="18"/>`,
    icon('shield', 314, 222, 44, 'd-ico f-none s-azure'),
    `<path class="nf s-line-strong sw4 rd" d="M238 314H434"/>`,
    `<rect class="f-amber-soft s-amber sw4" x="238" y="334" width="196" height="94" rx="18"/>`,
    icon('coin', 314, 359, 44, 'd-ico f-none s-amber'),
  );
};

export const roiTraceDiagram: DiagramSpec = {
  id: 'roi-trace',
  title: 'End-to-end trace from business request to production outcome feeding the net ROI ratio',
  viewBox: `0 0 ${ROI.w} ${ROI.h}`,
  decorative: true,
  svg: roiTrace(),
};

