/**
 * The deck: 7 modules, 25 slides, glossary. Single source of truth for the SPA and the script.
 *
 * Every slide carries its final ON SCREEN copy, its diagram or container art, its widget wiring and
 * its word-for-word script. They are authored per module (`slides-m1.ts` ... `slides-m7.ts`);
 * diagrams live in `src/diagrams/`.
 */

import type { Deck, Module, Slide } from './types';
import { glossary } from './glossary';
import { m1 } from './slides-m1';
import { m2 } from './slides-m2';
import { m3 } from './slides-m3';
import { m4 } from './slides-m4';
import { m5 } from './slides-m5';
import { m6 } from './slides-m6';
import { m7 } from './slides-m7';

export { promptModel } from './prompt-model';

export const modules: Module[] = [
  { code: 'M1', title: 'Opening & the scaling cliff', summary: 'Why a flawless demo predicts little, and why window size is not focus.' },
  { code: 'M2', title: 'Governance & the operating model', summary: 'From hero builders to an enabling CoE, the supply chain it owns, and a readiness scorecard.' },
  { code: 'M3', title: 'Metric evolution & evaluation frameworks', summary: 'What teams measure first, what replaces it, and how to pick the right quality gate.' },
  { code: 'M4', title: 'Process economics & prompt optimization', summary: 'Process cost, the executive ROI scorecard, the honest first-year bill, and four prompt levers.' },
  { code: 'M5', title: 'Whack-a-mole bottlenecks', summary: 'Where the constraint resurfaces when generation speeds up, and how roles evolve.' },
  { code: 'M6', title: 'Security tooling & guardrails', summary: 'Layered code security with a budget for AI scanning, and the seam where gates dispose.' },
  { code: 'M7', title: 'Field gotchas, maturity & open floor', summary: 'Six anti-patterns, a 30-60-90 plan, six dimensions of maturity, a room check, and open Q&A.' },
];

const slides: Slide[] = [...m1, ...m2, ...m3, ...m4, ...m5, ...m6, ...m7];

export const deck: Deck = {
  meta: {
    title: 'Scaling the Agentic SDLC',
    subtitle: 'Governance, economics, metrics & guardrails',
    event: 'AI-DLC Immersion',
    session: 'Microsoft Agentic SDLC Immersion \u00b7 Interactive Briefing & Workshop',
    presenters: {
      John: { name: 'John Hain', org: 'Microsoft' },
    },
  },
  modules,
  slides,
  glossary,
};
