/**
 * Module 5 diagrams: the paired time-allocation bars (slide 15), the pipeline bottleneck map
 * (slide 16) and the before-to-after role art (slide 17).
 */

import { esc } from '../content/html';
import type { ArtSpec, DiagramSpec, IconName } from '../content/types';
import { icon, lines, svg, text } from './kit';

// --------------------------------------------------------------------------- slide 15: time shift

const TS = { w: 1712, h: 626, x0: 400, perPct: 31, row: 132, top: 96 };

interface Activity {
  name: string;
  pre: number;
  post: number;
  /** down = shrinks, up = grows, new = appears. */
  dir: 'down' | 'up' | 'new';
}

/** Handbook Ch 6 section 6.1 author projection (non-normalized, so paired bars, never stacked). */
const ACTIVITIES: Activity[] = [
  { name: 'Write code', pre: 32, post: 12, dir: 'down' },
  { name: 'Spec & design', pre: 12, post: 22, dir: 'up' },
  { name: 'Code review', pre: 12, post: 22, dir: 'up' },
  { name: 'Context engineering', pre: 0, post: 12, dir: 'new' },
];

const arrow = (cx: number, cy: number, dir: Activity['dir']): string => {
  if (dir === 'new') {
    return `<circle class="f-green-soft s-green sw4" cx="${cx}" cy="${cy}" r="36"/><path class="nf s-green sw6 rd" d="M${cx - 15} ${cy}h30M${cx} ${cy - 15}v30"/>`;
  }
  const up = dir === 'up';
  const tone = up ? 's-violet' : 's-muted';
  const fill = up ? 'f-violet-soft' : 'f-surface2';
  const a = up ? -1 : 1;
  return (
    `<circle class="${fill} ${tone} sw4" cx="${cx}" cy="${cy}" r="36"/>` +
    `<path class="nf ${tone} sw6 rd" d="M${cx} ${cy - 16 * a}V${cy + 16 * a}M${cx - 13} ${cy + 3 * a}L${cx} ${cy + 17 * a}L${cx + 13} ${cy + 3 * a}"/>`
  );
};

const timeRow = (a: Activity, i: number): string => {
  const y0 = TS.top + i * TS.row;
  const wPre = Math.max(a.pre * TS.perPct, 8);
  const wPost = Math.max(a.post * TS.perPct, 8);
  const mid = y0 + 59;
  return (
    text(0, mid + 11, a.name, { size: 33, weight: 650 }) +
    `<rect class="d-pre" x="${TS.x0}" y="${y0 + 6}" width="${wPre}" height="48" rx="12"/>` +
    text(TS.x0 + wPre + 18, y0 + 41, `~${a.pre}%`, { size: 30, weight: 650, cls: 'f-muted' }) +
    `<rect class="d-post" x="${TS.x0}" y="${y0 + 62}" width="${wPost}" height="48" rx="12"/>` +
    text(TS.x0 + wPost + 18, y0 + 97, `~${a.post}%`, { size: 30, weight: 650, cls: 'f-violet' }) +
    arrow(1636, mid, a.dir) +
    (i < ACTIVITIES.length - 1 ? `<path class="nf s-line sw2" d="M0 ${y0 + 122}H${TS.w}"/>` : '')
  );
};

export const timeShift: DiagramSpec = {
  id: 'time-shift',
  title: 'Share of engineer time, before and with agentic tools (projection): writing code shrinks while specification and review grow and context engineering appears',
  viewBox: `0 0 ${TS.w} ${TS.h}`,
  svg: svg(
    `<rect class="d-pre" x="${TS.x0}" y="10" width="44" height="28" rx="8"/>`,
    text(TS.x0 + 60, 36, 'Pre-agentic', { size: 30, weight: 650 }),
    `<rect class="d-post" x="${TS.x0 + 330}" y="10" width="44" height="28" rx="8"/>`,
    text(TS.x0 + 390, 36, 'With agentic tools\u2020', { size: 30, weight: 650 }),
    ...ACTIVITIES.map(timeRow),
  ),
};

// --------------------------------------------------------------------------- slide 16: pipeline

const PL = { w: 1712, h: 446, nodeW: 370, nodeH: 190, y: 36 };
const STEP = (PL.w - PL.nodeW) / 3;
const NODES = [
  { x: 0, label: ['Product intake'], stage: 'intake', panel: 275 },
  { x: STEP, label: ['Agent build'], stage: '', panel: 0 },
  { x: STEP * 2, label: ['PR review'], stage: 'review', panel: 856 },
  { x: STEP * 3, label: ['Automated', 'QA'], stage: 'qa', panel: 1437 },
];

const cyNode = PL.y + PL.nodeH / 2;

const pipeNode = (n: (typeof NODES)[number]): string => {
  const cx = n.x + PL.nodeW / 2;
  const label =
    n.label.length === 1
      ? text(cx, cyNode + 12, n.label[0] as string, { size: 36, weight: 700, anchor: 'middle' })
      : lines(cx, cyNode - 4, n.label, { size: 34, weight: 700, anchor: 'middle', lh: 40 });
  const body =
    `<rect class="d-node-r" x="${n.x}" y="${PL.y}" width="${PL.nodeW}" height="${PL.nodeH}" rx="28"/>` +
    label;
  if (!n.stage) return `<g class="d-pn tone-green d-fast">${body}</g>`;
  // elbow connector from the node down to its constraint panel
  const bendY = PL.y + PL.nodeH + 84;
  const connector =
    `<path class="d-conn" d="M${cx} ${PL.y + PL.nodeH}V${bendY}H${n.panel}V${PL.h - 20}"/>` +
    `<path class="d-conn-head" d="M${n.panel - 11} ${PL.h - 22}L${n.panel} ${PL.h - 2}L${n.panel + 11} ${PL.h - 22}Z"/>`;
  return (
    `<g class="d-pn tone-amber d-bn" data-stage="${n.stage}" aria-label="${esc(n.label.join(' '))} constraint">` +
    body +
    `<circle class="d-pulse" cx="${n.x + PL.nodeW - 22}" cy="${PL.y + 22}" r="13"/>` +
    connector +
    `</g>`
  );
};

const flowArrows = NODES.slice(0, 3)
  .map((n, i) => {
    const a = n.x + PL.nodeW + 10;
    const b = (NODES[i + 1] as (typeof NODES)[number]).x - 10;
    return `<path class="nf s-line-strong sw5 rd" d="M${a} ${cyNode}H${b}M${b - 14} ${cyNode - 14}L${b} ${cyNode}L${b - 14} ${cyNode + 14}"/>`;
  })
  .join('');

export const pipelineMap: DiagramSpec = {
  id: 'pipeline-map',
  title: 'Delivery pipeline: product intake, agent build, pull-request review, then automated QA. Agent build is fast; the constraint pops up at intake, review and QA.',
  viewBox: `0 0 ${PL.w} ${PL.h}`,
  svg: svg(flowArrows, ...NODES.map(pipeNode)),
};

// --------------------------------------------------------------------------- slide 17: before to after

const roleArt = (before: IconName, after: IconName): ArtSpec => ({
  viewBox: '0 0 440 120',
  svg: svg(
    `<circle class="f-surface s-line-strong sw4" cx="58" cy="68" r="46"/>`,
    icon(before, 36, 46, 44, 'd-ico s-muted'),
    `<path class="nf s-tone sw5 rd dash-sm" d="M112 40C176 -2 266 -2 328 40"/>`,
    `<path class="nf s-tone sw6 rd" d="M308 24L330 41L304 52"/>`,
    `<circle class="f-tone-soft s-tone sw5" cx="382" cy="68" r="46"/>`,
    icon(after, 360, 46, 44, 'd-ico s-tone'),
  ),
});

export const roleSenior: ArtSpec = roleArt('code', 'layers');
export const roleLead: ArtSpec = roleArt('doc', 'branch');
export const roleJunior: ArtSpec = roleArt('code', 'eye');
