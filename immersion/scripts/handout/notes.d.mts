/** Types for scripts/handout/notes.mjs (the customer-facing companion notes). */

export interface NoteExtra {
  type: 'toc' | 'table' | 'steps' | 'cards' | 'faq' | 'assumptions';
  title?: string;
  head?: string[];
  widths?: string[];
  rows?: string[][];
  /** steps and faq: [label, text] pairs; cards: tile objects */
  items?: Array<[string, string] | NoteTile>;
  foot?: string;
}

export interface NoteTile {
  tag: string;
  title: string;
  body?: string;
  options?: string[];
  answer?: number;
  explain?: string;
  bullets?: string[];
}

export interface NoteEntry {
  summary: string;
  body?: string[];
  layout?: 'split';
  splitCols?: string;
  extra?: NoteExtra;
  reflect?: string;
  /** Numbers that are sourced but spelled differently in the slide or script (for example 95,000 for "ninety-five"). */
  allowNumbers?: string[];
  /** Keep the (short) bullet list together in one column instead of splitting it across the two. */
  keepList?: boolean;
}

export const REFLECT_LABEL: string;
export const LABEL_FIXES: Array<[RegExp, string]>;
export const NOTES: Record<string, NoteEntry>;
export const GLOSSARY_CATEGORIES: Array<{ id: string; title: string; groups: string[] }>;
export const GLOSSARY_INTRO: string;
export const GLOSSARY_FOOTNOTE: string;
