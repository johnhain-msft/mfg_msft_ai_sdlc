/**
 * Static consistency checks between a slide's `widget` spec and the markup the model will render.
 * Pure: used by `checkDeck` (rules.ts) so a mis-wired widget fails the build, not the room.
 * Returns human-readable problems; an empty array means the wiring is sound.
 */

import {
  TOKEN_LEVERS,
  blockKey,
  isChip,
  isContainer,
  isTable,
  slug,
  type Slide,
} from '../content/types';
import { calibrate, readoutText } from './tokenModel';

const GATE_KEY = /^(programmatic|judgement)-(internal|external)$/;

export function validateWidget(slide: Slide): string[] {
  const problems: string[] = [];
  const w = slide.widget;
  const containers = slide.blocks.filter(isContainer);
  const keys = new Set(containers.map(blockKey));
  const chips = slide.blocks.filter(isChip);

  if (!w) {
    for (const c of containers) if (c.stage) problems.push(`${c.kind} [${c.head}] has a stage but the slide has no staged widget`);
    return problems;
  }

  switch (w.kind) {
    case 'token-model':
    case 'prompt-debugger': {
      for (const lever of TOKEN_LEVERS) {
        const tiles = containers.filter((c) => c.kind === 'tile' && blockKey(c) === lever);
        if (tiles.length !== 1) problems.push(`token-model needs exactly one tile with key "${lever}" (found ${tiles.length})`);
      }
      try {
        const m = calibrate(w.params);
        const want = readoutText(m);
        if (slide.stat !== want) problems.push(`stat must equal the model's static readout "${want}" (got "${slide.stat ?? ''}")`);
      } catch (e) {
        problems.push((e as Error).message);
      }
      break;
    }

    case 'decision-tree': {
      if (chips.length < 2) problems.push('decision-tree needs at least two chips');
      if (chips.length > 9) problems.push('decision-tree supports at most nine chips (keys 1-9)');
      const chipKeys = new Set(chips.map(blockKey));
      for (const k of chipKeys) if (!w.map[k]) problems.push(`chip "${k}" has no entry in map`);
      for (const [k, targets] of Object.entries(w.map)) {
        if (!chipKeys.has(k)) problems.push(`map entry "${k}" matches no chip`);
        if (targets.length === 0) problems.push(`map entry "${k}" rings no tile`);
        for (const t of targets) {
          if (!GATE_KEY.test(t)) problems.push(`gate key "${t}" must look like <programmatic|judgement>-<internal|external>`);
          else if (!keys.has(t)) problems.push(`map entry "${k}" rings "${t}" but no container has that key`);
        }
      }
      break;
    }

    case 'staged': {
      if (w.mode === 'steps') {
        if (w.stages.length < 2) problems.push('staged steps needs at least two stages');
        const seen = new Set<string>();
        const svg = slide.diagram?.svg ?? '';
        for (const st of w.stages) {
          if (seen.has(st.key)) problems.push(`duplicate stage "${st.key}"`);
          seen.add(st.key);
          const used = containers.some((c) => c.stage === st.key) || svg.includes(`data-stage="${st.key}"`);
          if (!used) problems.push(`stage "${st.key}" is not used by any container or diagram element`);
        }
        for (const c of containers) {
          if (c.stage && !seen.has(c.stage)) problems.push(`${c.kind} [${c.head}] uses unknown stage "${c.stage}"`);
        }
      } else {
        const table = slide.blocks.find(isTable);
        if (!table) {
          problems.push('staged place needs a table block');
        } else {
          const body = table.rows.slice(table.header === false ? 0 : 1);
          const rowKeys = body.map((r) => slug(r[0] ?? ''));
          const want = new Set(w.rows);
          if (rowKeys.length !== w.rows.length || rowKeys.some((k) => !want.has(k))) {
            problems.push(`rows must be the slugs of the table's first column: ${rowKeys.join(', ')}`);
          }
          const cols = (table.rows[0]?.length ?? 1) - 1;
          if (w.tiers.length !== cols) problems.push(`tiers (${w.tiers.length}) must match the table's value columns (${cols})`);
        }
      }
      break;
    }

    case 'quiz': {
      if (w.questions.length < 1) problems.push('quiz needs at least one question');
      for (const q of w.questions) {
        if (!keys.has(q.key)) problems.push(`question "${q.key}" matches no container key`);
        if (q.options < 2 || q.options > 4) problems.push(`question "${q.key}" needs 2-4 options`);
        if (q.answer < 0 || q.answer >= q.options) problems.push(`question "${q.key}" answer ${q.answer} is out of range`);
      }
      break;
    }
  }
  return problems;
}
