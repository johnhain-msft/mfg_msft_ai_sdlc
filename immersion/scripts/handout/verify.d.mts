/** Types for scripts/handout/verify.mjs (the handout's content guards). */

import type { Deck, Slide } from '../../src/content/types';
import type { NoteEntry } from './notes.mjs';

export type BannedList = Array<[RegExp, string]>;

export const BANNED: BannedList;
export const BANNED_IN_SLIDES: BannedList;

/** One rule per presenter the deck declares (read from `deck.meta.presenters`). */
export function presenterRules(deck: Deck): BannedList;
/** One rule per confidential term supplied at run time. */
export function termRules(terms?: string[]): BannedList;
export function findBanned(text: string, list?: BannedList): Array<{ match: string; why: string }>;
export function spelledNumbers(text: string): Set<string>;
export function digitNumbers(text: string): string[];
export function corpusFor(slide: Slide, deck: Deck): string;
export function authoredStrings(entry: NoteEntry): string[];
export function checkNotes(opts: {
  deck: Deck;
  notes: Record<string, NoteEntry>;
  sourceLabel?: (label: string) => string;
  terms?: string[];
}): { errors: string[]; warnings: string[] };
export function checkDocumentText(opts: { textOutsideSlides: string; textInSlides: string; deck?: Deck; terms?: string[] }): string[];
