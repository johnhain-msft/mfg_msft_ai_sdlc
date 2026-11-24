/** Types for scripts/handout/compose.mjs (pure HTML composition for the handout). */

import type { Slide } from '../../src/content/types';

export const esc: (s: unknown) => string;
export const smart: (s: string) => string;
export function inline(src: string): string;
export const plain: (src: string) => string;
export function fixLabel(label: string): string;
export function sourcesFor(slide: Slide): Array<{ label: string; url: string }>;
export function slideAlt(slide: Slide, n: number): string;
export const neutralizeHeadings: (html: string) => string;
