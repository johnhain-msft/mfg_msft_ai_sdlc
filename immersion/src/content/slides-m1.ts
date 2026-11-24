/**
 * Module 1: opening and the scaling cliff (slides 1-3).
 *
 * Every spoken line is a `say` beat that never re-voices the slide. Stage directions are `cue` beats.
 */

import { attentionCurve, gaugeFits, gaugeOverflows, heroLoop } from '../diagrams/m1';
import { cite } from './sources';
import type { Slide } from './types';

export const m1: Slide[] = [
  // ---- 1 ----------------------------------------------------------------------------------
  {
    id: 'm1-cover',
    moduleCode: 'M1',
    presenter: 'John',
    layout: 'cover-hero-grid',
    purpose: 'Frame the session around the four capabilities the room should leave with.',
    kicker: 'Microsoft \u00b7 AI-DLC Immersion',
    title: 'Scaling the Agentic SDLC',
    lead: 'Governance, economics, metrics & guardrails',
    blocks: [
      { kind: 'tile', head: 'Operating model', body: 'Charter an enabling CoE for standards and evals.', icon: 'people', tone: 'azure' },
      { kind: 'tile', head: 'Metrics & evals', body: 'Measure flow and quality, not activity or volume.', icon: 'gauge', tone: 'violet' },
      { kind: 'tile', head: 'Prompt economics', body: 'Price the process, then pull four cost levers.', icon: 'loop', tone: 'green' },
      { kind: 'tile', head: 'Bottlenecks & security', body: 'Unblock handoffs and enforce gates agents cannot bypass.', icon: 'shield', tone: 'amber' },
    ],
    note: 'John Hain \u00b7 Microsoft',
    diagram: heroLoop,
    script: [
      {
        t: 'say',
        text: "Welcome, everyone. I'm John Hain, and I'm with Microsoft. This isn't a pitch for AI. Most leadership teams are already all in, and most engineering groups have a working V1. This session is about year two, when the novelty fades and the questions become who owns this, what does it cost, and is it working.",
      },
      {
        t: 'say',
        text: "We'll move through seven modules: why demos break at scale, the operating model, metrics and evals, process economics with a prompt-cost exercise, bottlenecks, security scanning and guardrails, and finally field gotchas, a maturity check, and an open floor.",
      },
      { t: 'cue', kind: 'point', text: 'Point at the glyph. The loop runs human, agent, platform. Most of what hurts at scale lives on the platform side of that loop, not inside the model.' },
      { t: 'cue', kind: 'ask', text: "Two ground rules. Interrupt me by voice, by hand, or in the chat. And I'll stop a few times on purpose to poll the room, starting with the governance section." },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'If earlier sessions came first',
        text: 'Optional. If the room has already been through related sessions, name one thing from them that connects to what is coming next.',
      },
      { t: 'cue', kind: 'next', text: "Let's start with why the demo works and the real codebase doesn't." },
    ],
    sources: [],
  },

  // ---- 2 ----------------------------------------------------------------------------------
  {
    id: 'm1-vibe-cliff',
    moduleCode: 'M1',
    presenter: 'John',
    layout: 'split-compare-gauge',
    purpose: 'Show why a flawless greenfield demo predicts little about brownfield results.',
    kicker: 'The scaling cliff',
    title: 'Greenfield demos hit a cliff',
    blocks: [
      { kind: 'card', head: 'Greenfield demo', body: 'No legacy to respect, so the task fits in context.', key: 'greenfield', tone: 'green', art: gaugeFits },
      {
        kind: 'card',
        head: '10M-line brownfield',
        body: 'Unwritten conventions overflow any 200K\u20132M token window; rework estimated at ~30\u201360%\u2020',
        key: 'brownfield',
        tone: 'red',
        art: gaugeOverflows,
      },
      { kind: 'band', head: 'Three structural properties', body: 'Context is finite and fragile; context must be explicit; output is probabilistic.', tone: 'azure' },
    ],
    note: '\u2020 Handbook author estimate; no controlled study',
    script: [
      {
        t: 'say',
        text: "Take any greenfield demo. The agent builds a clean service in minutes, because there is no history to trip over. Point the same model at a codebase with years of decisions in it, and the experience changes.",
      },
      {
        t: 'say',
        text: "The Agentic SDLC Handbook, written by Daniel Meppiel at Microsoft in his personal capacity, calls this the vibe coding cliff. The thirty-to-sixty percent rework figure on the slide is the author's own synthesis, and the Handbook says no controlled study has settled on a single number. Treat it as a ballpark and measure your own repos.",
      },
      {
        t: 'say',
        text: "Why does it happen? Three structural reasons, and none is a bug a vendor patches next quarter. Attention is finite and fragile. The model only uses what is explicitly in front of it, so a convention that lives in a senior engineer's head doesn't exist for the agent. And the output is a draw from a distribution, so the same prompt can give different diffs on different days.",
      },
      {
        t: 'say',
        text: 'Picture a rule your best architect never wrote down, say, never call that internal service synchronously. The agent will happily do it, and everything compiles.',
      },
      { t: 'cue', kind: 'ask', text: 'Quick hands, or chat: who has watched an agent shine in a clean repo and then stumble in a module with history?' },
      { t: 'cue', kind: 'next', text: "So let's look at what's in the window, and where it sits." },
    ],
    sources: [cite('hbCh1', 'C01')],
  },

  // ---- 3 ----------------------------------------------------------------------------------
  {
    id: 'm1-attention-economy',
    moduleCode: 'M1',
    presenter: 'John',
    layout: 'curve-diagram-staged',
    purpose: 'Establish that a bigger context window does not mean more of it is in focus.',
    kicker: 'The scaling cliff',
    title: 'Window size is not focus',
    blocks: [
      { kind: 'card', head: 'Liu et al., TACL 2024', body: 'Accuracy is highest at the start and end of context, lowest in the middle.', key: 'liu', tone: 'azure' },
      {
        kind: 'band',
        head: 'Five PROSE constraints',
        body: 'Direct levers: Progressive Disclosure, Reduced Scope, Orchestrated Composition. Also: Safety Boundaries, Explicit Hierarchy.',
        key: 'prose',
        tone: 'violet',
      },
    ],
    diagram: attentionCurve,
    widget: {
      kind: 'staged',
      mode: 'steps',
      stages: [
        { key: 'progressive', announce: 'Lever 1: progressive disclosure lifts the trough' },
        { key: 'scope', announce: 'Lever 2: reduced scope lifts it further' },
        { key: 'orchestrated', announce: 'Lever 3: orchestrated composition nearly flattens it' },
      ],
    },
    script: [
      {
        t: 'say',
        text: "The context window is how much the model can hold, not how much it's paying attention to. Liu and colleagues made that measurable. They took long inputs, in multi-document question answering and key-value retrieval, and moved the one relevant fact around.",
      },
      {
        t: 'say',
        text: 'Accuracy followed position. It was best when the fact sat at the beginning or the end, and it fell significantly when the fact was buried mid-input, even for models built for long context. Chapter 15 of the Handbook connects that middle drop-off to context rot as a long session fills up.',
      },
      {
        t: 'say',
        text: 'Translate that to a coding session. This is an illustration, not a measurement: your standing instructions load at the head, your current task sits at the tail, and everything you drag in between competes for the weak part of the curve.',
      },
      {
        t: 'cue',
        kind: 'click',
        text: 'Press Space three times as you name the levers. Each press lifts the middle of the curve: progressive disclosure first, then reduced scope, then orchestrated composition.',
      },
      {
        t: 'say',
        text: "PROSE is the Handbook's answer. Three of its five constraints are direct levers on attention. Progressive disclosure means loading the instructions for the module you are touching and nothing else. Reduced scope means smaller tasks. Orchestrated composition means chaining small, single-purpose primitives and handing sub-tasks to fresh agents with clean windows. The other two, safety boundaries and explicit hierarchy, keep that discipline safe and predictable.",
      },
      { t: 'cue', kind: 'ask', text: "Practitioners, how many lines is your biggest instructions file? Call out a number. I'll wait." },
      {
        t: 'cue',
        kind: 'story',
        text: 'Tell one real, anonymized example of an instruction file that grew until the agent stopped following rules. Use only a story you can stand behind; no sourced case backs this slide.',
      },
      { t: 'cue', kind: 'note', text: 'The plain-language definitions of the three levers paraphrase Chapter 13 of the Handbook.' },
      { t: 'cue', kind: 'next', text: "That's the technical cliff. The organizational one is next." },
    ],
    sources: [cite('hbCh15', 'C02'), cite('liu', 'C02'), cite('hbCh13', 'C02')],
  },
];
