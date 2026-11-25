/**
 * SAY + CUE beat rendering, shared by the speaker view, the script book, the Read-Along panel and
 * the markdown script (`docs/SPEAKER-SCRIPT.md`).
 *
 * In the markdown, `say` beats are plain paragraphs and every cue is a blockquote, so
 * deck-density.py (which drops `>` lines, `#` headings, whole-line `[tags]`) reads exactly the
 * spoken words. `ask`, `poll` and `next` cues are spoken aloud but live in blockquotes by design.
 *
 * Pure strings; no DOM.
 */

import { esc } from '../content/html';
import { SPOKEN_CUE_KINDS, presenterLabel, type Beat, type CueKind, type Slide } from '../content/types';

export const CUE_LABEL: Readonly<Record<CueKind, string>> = {
  show: 'SHOW',
  point: 'POINT',
  click: 'CLICK',
  ask: 'ASK',
  poll: 'POLL',
  wait: 'WAIT',
  switch: 'SWITCH',
  story: 'STORY SLOT',
  note: 'NOTE',
  next: 'NEXT',
};

export type BeatGroup =
  | { kind: 'beat'; index: number; beat: Beat }
  | { kind: 'drawer'; title: string; items: Array<{ index: number; beat: Beat }> };

/** Consecutive `optional` beats with the same `group` become one "If needed" drawer. */
export function groupBeats(beats: Beat[]): BeatGroup[] {
  const out: BeatGroup[] = [];
  beats.forEach((beat, index) => {
    if (!beat.optional) {
      out.push({ kind: 'beat', index, beat });
      return;
    }
    const title = beat.group ?? 'Deeper answer';
    const last = out[out.length - 1];
    if (last && last.kind === 'drawer' && last.title === title) last.items.push({ index, beat });
    else out.push({ kind: 'drawer', title, items: [{ index, beat }] });
  });
  return out;
}

// --------------------------------------------------------------------------- HTML

export interface BeatHtmlOptions {
  /** Open "If needed" drawers (the printable script book). */
  openDrawers?: boolean;
  /** Make beats focusable and clickable for the J/K tracker. */
  trackable?: boolean;
}

function beatHtml(index: number, beat: Beat, opts: BeatHtmlOptions): string {
  const track = opts.trackable ? ' tabindex="0"' : '';
  if (beat.t === 'say') {
    return `<div class="beat beat-say" data-beat="${index}"${track}><p>${esc(beat.text)}</p></div>`;
  }
  const spoken = SPOKEN_CUE_KINDS.has(beat.kind);
  const code = beat.code
    ? `<div class="code"><pre><code>${esc(beat.code)}</code></pre><button type="button" class="btn btn-sm" data-copy>Copy</button></div>`
    : '';
  return (
    `<div class="beat beat-cue cue-${beat.kind}${spoken ? ' is-spoken' : ''}" data-beat="${index}" data-kind="${beat.kind}"${track}>` +
    `<span class="cue-tag">${CUE_LABEL[beat.kind]}</span><p>${esc(beat.text)}</p>${code}</div>`
  );
}

export function renderBeatsHtml(slide: Slide, opts: BeatHtmlOptions = {}): string {
  return groupBeats(slide.script)
    .map((g) =>
      g.kind === 'beat'
        ? beatHtml(g.index, g.beat, opts)
        : `<details class="drawer"${opts.openDrawers ? ' open' : ''}><summary>If needed \u00b7 ${esc(g.title)}</summary>` +
          g.items.map((i) => beatHtml(i.index, i.beat, opts)).join('') +
          `</details>`,
    )
    .join('');
}

export function renderSourcesHtml(slide: Slide): string {
  if (!slide.sources.length) return '';
  return (
    `<p class="sources"><strong>Sources</strong> ` +
    slide.sources
      .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>${s.claim ? ` <span class="claim">${esc(s.claim)}</span>` : ''}`)
      .join(' \u00b7 ') +
    `</p>`
  );
}

export function presenterBadgeHtml(slide: Slide): string {
  return `<span class="presenter-badge">${esc(presenterLabel(slide.presenter))}</span>`;
}

// --------------------------------------------------------------------------- markdown

/** Script body for one slide as markdown lines (no heading). */
export function renderBeatsMarkdown(slide: Slide): string[] {
  const lines: string[] = [];
  let lastGroup: string | undefined;
  for (const beat of slide.script) {
    if (beat.optional) {
      const title = beat.group ?? 'Deeper answer';
      if (title !== lastGroup) {
        lines.push(`> **[IF NEEDED]** ${title}`, '');
        lastGroup = title;
      }
    } else {
      lastGroup = undefined;
    }
    if (beat.t === 'say') {
      lines.push(beat.text, '');
    } else {
      lines.push(`> **[CUE]** ${CUE_LABEL[beat.kind]}: ${beat.text}`);
      if (beat.code) {
        lines.push('>', '> ```text', ...beat.code.split('\n').map((l) => (l ? `> ${l}` : '>')), '> ```');
      }
      lines.push('');
    }
  }
  return lines;
}
