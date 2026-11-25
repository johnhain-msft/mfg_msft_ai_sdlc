/**
 * Shared widget contracts.
 *
 * Every widget is a pair:
 *   1. render hooks   pure string functions that add STATIC markup (attributes, wrappers, SVG).
 *                     They run at build time and at runtime and may never add prose.
 *   2. a mount()      attaches behaviour to markup that already exists in the DOM.
 *
 * The pre-rendered `<section class="slide">` is the same DOM the runtime upgrades: nothing is
 * rebuilt, so slide-review and deck-density.py see exactly what the room sees.
 */

import type { ChipBlock, Container, Slide } from '../content/types';

export type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Extra static decoration for a block. `inner` is appended inside the container (zero words). */
export interface BlockDecor {
  attrs?: Attrs;
  classes?: string[];
  inner?: string;
}

export interface WidgetRenderHooks {
  /** Decorate a container (tile, card, ...). */
  block?(slide: Slide, block: Container, index: number): BlockDecor | undefined;
  /** Decorate a chip button. */
  chip?(slide: Slide, chip: ChipBlock, index: number): BlockDecor | undefined;
  /** Decorate a table cell (scorecard). `row` and `col` are zero-based, header row included. */
  cell?(slide: Slide, row: number, col: number, text: string): BlockDecor | undefined;
  /** Decorate a table row. `row` is zero-based, header row included; `first` is the first cell's text. */
  row?(slide: Slide, row: number, first: string): BlockDecor | undefined;
  /** Replace the default `<p class="stat">` markup. Must contain exactly the model's stat words. */
  stat?(slide: Slide): string | undefined;
  /** Static markup placed in the slide body before the blocks (e.g. an SVG bar). Zero prose. */
  prelude?(slide: Slide): string;
  /** Static markup placed in the slide body after the blocks. Zero prose. */
  coda?(slide: Slide): string;
  /** Attributes for the `<section>` itself. */
  root?(slide: Slide): Attrs | undefined;
}

export interface MountContext {
  /** False for speaker-view previews: show state, bind nothing. */
  interactive: boolean;
  /** Polite screen-reader announcement. */
  announce(message: string): void;
  /** The widget's own state changed (the deck broadcasts it to the speaker view). */
  changed(): void;
}

export interface WidgetHandle {
  readonly kind: string;
  /** Keyboard steps this widget adds before the deck moves to the next slide (staged `steps` only). */
  readonly steps: number;
  /** True when digit keys drive this widget, so the deck must not buffer them as a slide number. */
  readonly claimsDigits: boolean;
  getStep(): number;
  setStep(step: number): void;
  /** Offer a key to the widget. Returns true when it was used. */
  handleKey(e: KeyboardEvent): boolean;
  /** JSON-serializable snapshot, mirrored to speaker previews. */
  getState(): unknown;
  setState(state: unknown): void;
  dispose(): void;
}

export const noopHandle = (kind: string): WidgetHandle => ({
  kind,
  steps: 0,
  claimsDigits: false,
  getStep: () => 0,
  setStep: () => undefined,
  handleKey: () => false,
  getState: () => null,
  setState: () => undefined,
  dispose: () => undefined,
});

/** A digit key 1-9 (not 0), ignoring modifiers. Returns the number or 0. */
export function digitOf(e: KeyboardEvent): number {
  return !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
}

/** Keys that activate a focused custom control. */
export const isActivateKey = (e: KeyboardEvent): boolean => e.key === 'Enter' || e.key === ' ';
