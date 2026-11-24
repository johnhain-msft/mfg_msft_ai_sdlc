/**
 * Module 3 diagrams: the to-scale stat bars (slide 8) and the three metric-generation
 * pictograms (slide 9).
 */

import type { ArtSpec, DiagramSpec } from '../content/types';
import { icon, svg, text } from './kit';

// --------------------------------------------------------------------------- slide 8: 50% vs 15%

const PX_PER_PCT = 28;
const W8 = 1712;
const H8 = 331;

/**
 * Two bars drawn to the same scale (28 units per percentage point): the headline 50% cut in coding
 * time, and the 15% it is worth once coding is 30% of the week. The dashed ghost under the second bar
 * is the extent of the first, so the gap reads at a glance. Numerals only.
 */
export const paradoxBars: DiagramSpec = {
  id: 'paradox-bars',
  title: 'Two bars to the same scale: a 50% reduction in coding time against the 15% it saves overall',
  viewBox: `0 0 ${W8} ${H8}`,
  svg: svg(
    `<path class="nf s-line-strong sw4 rd" d="M2 20V${H8 - 22}"/>`,
    // headline: 50%
    `<rect class="d-claim" x="4" y="36" width="${50 * PX_PER_PCT}" height="104" rx="18"/>`,
    text(4 + 50 * PX_PER_PCT + 32, 112, '50%', { size: 84, weight: 750 }),
    // reality: 15% inside the ghost of the first bar
    `<rect class="d-ghost" x="4" y="190" width="${50 * PX_PER_PCT}" height="104" rx="18"/>`,
    `<rect class="d-real" x="4" y="190" width="${15 * PX_PER_PCT}" height="104" rx="18"/>`,
    text(4 + 15 * PX_PER_PCT + 32, 266, '15%', { size: 84, weight: 750, cls: 'f-azure' }),
  ),
};

// --------------------------------------------------------------------------- slide 9: three generations

const ART9 = '0 0 450 200';

/** Generation 1, activity: a lot of volume, rising for its own sake. */
export const genActivity: ArtSpec = {
  viewBox: ART9,
  svg: svg(
    `<path class="nf s-line-strong sw3 rd" d="M6 188H446"/>`,
    ...[40, 64, 54, 86, 76, 110, 100, 132, 122, 154, 142, 170].map(
      (h, i) => `<rect class="f-seg-work" x="${10 + i * 36}" y="${188 - h}" width="24" height="${h}" rx="5"/>`,
    ),
  ),
};

/** Generation 2, flow and quality: a change moves through review and is merged with confidence. */
export const genFlow: ArtSpec = {
  viewBox: ART9,
  svg: svg(
    `<path class="nf s-line-strong sw5 rd" d="M122 100H160M148 87L162 100L148 113M286 100H324M312 87L326 100L312 113"/>`,
    `<circle class="f-surface s-azure sw5" cx="64" cy="100" r="54"/>`,
    icon('branch', 38, 74, 52, 'd-ico f-none s-azure'),
    `<circle class="f-surface s-violet sw5" cx="225" cy="100" r="54"/>`,
    icon('eye', 199, 74, 52, 'd-ico f-none s-violet'),
    `<circle class="f-green-soft s-green sw5" cx="386" cy="100" r="54"/>`,
    icon('check', 360, 74, 52, 'd-ico f-none s-green'),
  ),
};

/** Generation 3, outcomes and evals: a bullseye, and a golden dataset that stays green. */
export const genOutcomes: ArtSpec = {
  viewBox: ART9,
  svg: svg(
    `<circle class="f-surface s-violet sw5" cx="92" cy="100" r="82"/>`,
    `<circle class="nf s-violet sw5" cx="92" cy="100" r="52"/>`,
    `<circle class="f-violet" cx="92" cy="100" r="22"/>`,
    ...[0, 1, 2].map(
      (i) =>
        `<rect class="f-green-soft s-green sw3" x="198" y="${26 + i * 52}" width="244" height="44" rx="14"/>` +
        `<path class="nf s-green sw5 rd" d="M216 ${48 + i * 52}l10 10 17-21"/>` +
        `<rect class="f-green" x="262" y="${43 + i * 52}" width="${[150, 118, 166][i]}" height="10" rx="5"/>`,
    ),
  ),
};
