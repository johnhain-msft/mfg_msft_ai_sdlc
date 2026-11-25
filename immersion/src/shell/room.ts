/**
 * "The room sees": a plain-language summary of what is on screen for a slide, shared by the
 * speaker view, the script book and the markdown script. Generated from the same model that
 * renders the slide, so it cannot drift from it. Pure strings; no DOM.
 */

import { esc } from '../content/html';
import {
  isChip,
  isContainer,
  isTable,
  type Container,
  type ContainerKind,
  type Slide,
} from '../content/types';

export interface RoomSees {
  headline: string;
  items: string[];
  /** What the presenter can do on this slide, from the widget spec. */
  interaction: string | null;
}

const PLURAL: Record<ContainerKind, [string, string]> = {
  card: ['card', 'cards'],
  step: ['step', 'steps'],
  panel: ['panel', 'panels'],
  box: ['box', 'boxes'],
  tile: ['tile', 'tiles'],
  band: ['band', 'bands'],
};

const list = (xs: string[]): string => xs.join(', ');

/** What the presenter can do on this slide. Null when the slide is static. */
export function interactionHint(slide: Slide): string | null {
  const w = slide.widget;
  if (!w) return null;
  switch (w.kind) {
    case 'token-model':
    case 'prompt-debugger':
      return 'Press 1\u20134 (or click a tile) to flip a cost lever; 0 resets. The bar and readout move; no text changes.';
    case 'decision-tree': {
      const n = slide.blocks.filter(isChip).length;
      return `Press 1\u2013${n} (or click a chip) to pick a failure; the matching gate tiles ring. Press 0 to clear.`;
    }
    case 'staged':
      return w.mode === 'steps'
        ? `Space or \u2192 steps the highlight through ${w.stages.length} stages before moving on; click a stage to jump to it.`
        : 'Click a cell to place a row in a tier; click again to clear it.';
    case 'quiz':
      return 'Press 1\u20133 to pick an option for the active question, Enter to reveal it; click the dots to tally raised hands.';
  }
}

export function roomSees(slide: Slide): RoomSees {
  const interaction = interactionHint(slide);
  if (slide.roomSees) return { headline: slide.roomSees, items: [], interaction };

  const items: string[] = [];
  if (slide.lead) items.push(`Lead: ${slide.lead}`);
  const byKind = new Map<ContainerKind, Container[]>();
  for (const b of slide.blocks) if (isContainer(b)) byKind.set(b.kind, [...(byKind.get(b.kind) ?? []), b]);
  for (const [kind, cs] of byKind) {
    const [one, many] = PLURAL[kind];
    items.push(`${cs.length} ${cs.length === 1 ? one : many}: ${list(cs.map((c) => c.head))}`);
  }
  const table = slide.blocks.find(isTable);
  if (table) {
    const head = table.header === false ? '' : ` (${list(table.rows[0] ?? [])})`;
    items.push(`A table of ${table.rows.length - (table.header === false ? 0 : 1)} rows${head}`);
  }
  const chips = slide.blocks.filter(isChip);
  if (chips.length) items.push(`${chips.length} chips: ${list(chips.map((c) => c.text))}`);
  if (slide.diagram) items.push(`A diagram: ${slide.diagram.title}`);
  if (slide.stat) items.push(`Readout: ${slide.stat}`);
  if (slide.note) items.push(`Footnote: ${slide.note}`);
  const kicker = slide.kicker ? ` (${slide.kicker})` : '';
  return { headline: `${slide.title}${kicker}`, items, interaction };
}

/** HTML block for the speaker view and script book. */
export function renderRoomSees(slide: Slide): string {
  const r = roomSees(slide);
  return (
    `<section class="room-sees" aria-label="The room sees">` +
    `<h3>The room sees</h3>` +
    `<p class="rs-headline">${esc(r.headline)}</p>` +
    (r.items.length ? `<ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '') +
    (r.interaction ? `<p class="rs-interact"><strong>Interactive:</strong> ${esc(r.interaction)}</p>` : '') +
    `</section>`
  );
}

/** Markdown lines (each a blockquote line, so deck-density.py strips them from the spoken words). */
export function roomSeesMarkdown(slide: Slide): string[] {
  const r = roomSees(slide);
  const lines = [`> **The room sees:** ${r.headline}`];
  for (const i of r.items) lines.push(`> - ${i}`);
  if (r.interaction) lines.push(`> **Interactive:** ${r.interaction}`);
  return lines;
}
