/**
 * Module 2: governance and the operating model (slides 4-7).
 */

import { rolesRail, supplyChain } from '../diagrams/m2';
import { cite } from './sources';
import type { Slide } from './types';

export const m2: Slide[] = [
  // ---- 4 ----------------------------------------------------------------------------------
  {
    id: 'm2-hero-trap',
    moduleCode: 'M2',
    presenter: 'John',
    layout: 'stage-ladder',
    purpose: 'Show the maturation path from a few hero builders to an enabling CoE.',
    kicker: 'Operating model',
    title: 'From hero builders to an enabling CoE',
    blocks: [
      { kind: 'step', head: '1 \u00b7 Hero pilot', body: 'Top builders prove it works; what they learn stays with them.', key: 'hero', stage: 'hero', tone: 'amber', icon: 'person' },
      { kind: 'step', head: '2 \u00b7 Enabling CoE', body: 'A small, time-boxed team encodes reusable workflows and coaches other teams.', key: 'coe', stage: 'coe', tone: 'azure', icon: 'people' },
      { kind: 'step', head: '3 \u00b7 Advisory guardrails', body: 'Guidance replaces gatekeeping so the CoE never becomes an approval bottleneck.', key: 'advisory', stage: 'advisory', tone: 'violet', icon: 'compass' },
    ],
    widget: {
      kind: 'staged',
      mode: 'steps',
      stages: [
        { key: 'hero', announce: 'Stage 1: hero pilot' },
        { key: 'coe', announce: 'Stage 2: enabling CoE' },
        { key: 'advisory', announce: 'Stage 3: advisory guardrails' },
      ],
    },
    script: [
      {
        t: 'say',
        text: "This is how a lot of programs start. Two or three of the strongest architects and developers build V1. That works, and it's why so many organizations have a working V1 at all.",
      },
      {
        t: 'say',
        text: 'The Handbook names the risk on the far side of that success: the hero pilot. A few top people, a friendly problem, brilliant results, and nothing they learned transfers. In practice, that usually means it lives in their heads instead of in shared assets.',
      },
      {
        t: 'cue',
        kind: 'click',
        text: 'Press Space to step the ladder: hero pilot, then enabling CoE, then advisory guardrails. Leave each rung lit while you talk about it.',
      },
      {
        t: 'say',
        text: "What the Handbook describes instead is two small groups. An enabling team with a finite lifespan that guides other groups and writes practices down. And a small central group that encodes the cost-effective workflows everyone else reuses. Microsoft's Cloud Adoption Framework says much the same from the other direction. Fold AI expertise into an existing center of excellence where you can. Start centralized early, so you build reusable assets and avoid fragmented adoption. Then move to an advisory guardrail role, so the group never turns into the approval choke point.",
      },
      {
        t: 'say',
        text: "How long? Handbook Chapter 8 gives six to twelve months for a mid-sized engineering organization, shorter for smaller groups and longer for large enterprises. That fits the enabling-team idea: dedicated focus while practices take root, with a planned shift to advisory guardrails.",
      },
      { t: 'cue', kind: 'ask', text: 'Without naming anyone: who owns your standards, evals, and cost loops today, and how much of their week does it take?' },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'Coach burnout',
        text: 'Optional depth for a skeptical CTO. Handbook Chapter 8 warns of coach burnout when pilot members spend more than roughly a quarter to a third of their time coaching, and its remedy is dedicated enablement or a slower rollout.',
      },
      { t: 'cue', kind: 'next', text: "To staff that team you need to know what it owns, so next is the supply chain it governs." },
    ],
    sources: [cite('hbCh8', 'C03'), cite('hbCh6', 'C03'), cite('cafCoe', 'C03')],
  },

  // ---- 5 ----------------------------------------------------------------------------------
  {
    id: 'm2-supply-chain',
    moduleCode: 'M2',
    presenter: 'John',
    layout: 'layer-stack-diagram',
    purpose: 'Give the room a single map of ownership across the agentic supply chain.',
    kicker: 'Operating model',
    title: 'Five layers, five owners',
    blocks: [
      {
        kind: 'band',
        head: 'Primitives as code',
        body: 'Seven versioned primitives (instructions, agents, skills, prompts, memory, specs, hooks) ship like internal packages.',
        key: 'primitives',
        tone: 'azure',
      },
    ],
    diagram: supplyChain,
    script: [
      {
        t: 'say',
        text: 'This map answers who owns what. Handbook Chapter 4 calls it the agentic supply chain. Read it from the bottom. Your cloud, source control, identity, and audit substrate. Above that, the AI capabilities your teams author. Above that, a layer that makes those capabilities versioned, owned, and auditable. Then the agent harness, which could be Copilot CLI or whatever else your people prefer. And at the top, the delivery phases people actually work in.',
      },
      {
        t: 'say',
        text: "I'd standardize below the harness. Tools will keep changing, but if the files that steer your agents are versioned and have named owners, they move with you. The Handbook defines seven primitive types, each with a file convention: instructions dot md, agent dot md, SKILL dot md, prompt dot md, memory dot md, spec dot md, and hooks.",
      },
      {
        t: 'say',
        text: "On ownership, the Handbook's figure has platform teams owning the base and the harness, security and compliance sharing the governance layer, domain specialists and workflow engineers owning the capability layer, and product teams owning the phases.",
      },
      { t: 'cue', kind: 'point', text: 'Hover or tab onto a layer to light it with its owner. The color is the owner: blue is the platform team, violet is shared with security, green is the capability authors, amber is the product teams.' },
      { t: 'cue', kind: 'ask', text: 'Which of these five layers has a named owner in your organization today, and which one belongs to whoever noticed it first?' },
      { t: 'cue', kind: 'next', text: "That capability layer is where a new kind of job lives. Let's name it." },
    ],
    sources: [cite('hbCh4', 'C04'), cite('hbCh12', 'C04'), cite('hbCh6', 'C16')],
  },

  // ---- 6 ----------------------------------------------------------------------------------
  {
    id: 'm2-three-roles',
    moduleCode: 'M2',
    presenter: 'John',
    layout: 'tabbed-roles',
    purpose: 'Name the three authorship concerns that a new AI-DLC function must cover.',
    kicker: 'Operating model',
    title: 'A new function: three concerns',
    blocks: [
      { kind: 'panel', head: 'Domain Specialist \u00b7 WHAT', body: 'Owns the procedure, rules, success criteria, and eval.', key: 'what', stage: 'what', tone: 'azure' },
      { kind: 'panel', head: 'Agentic Workflow Engineer \u00b7 HOW', body: 'Owns how skills compose, including PROSE-level composition and evals.', key: 'how', stage: 'how', tone: 'violet' },
      { kind: 'panel', head: 'Agent Operations Specialist \u00b7 OPERATIONS', body: 'Owns cost, traces, eval drift, and rate limits at scale.', key: 'operations', stage: 'operations', tone: 'green' },
    ],
    note: 'Operations emerges only at scale, not on day one.',
    diagram: rolesRail,
    widget: {
      kind: 'staged',
      mode: 'steps',
      stages: [
        { key: 'what', announce: 'Concern 1: what the skill encodes' },
        { key: 'how', announce: 'Concern 2: how it is built' },
        { key: 'operations', announce: 'Concern 3: operations at scale' },
      ],
    },
    script: [
      {
        t: 'say',
        text: "In my view, the function you'd be chartering is a new one. It blends software engineering with business-process knowledge. The Handbook splits it into three concerns.",
      },
      {
        t: 'say',
        text: 'The Domain Specialist owns what a skill encodes, and the Handbook is explicit that this person is not always an engineer. It can be the analyst or compliance officer who knows what a correct answer looks like.',
      },
      {
        t: 'say',
        text: "The Agentic Workflow Engineer owns how it is built. In a small team that's a senior engineer wearing a second hat, often one of the architects who built V1.",
      },
      {
        t: 'say',
        text: "The Agent Operations Specialist is the one to resist hiring early. The Handbook says that role emerges when more than one skill is in production and cost or drift needs dedicated attention. Don't staff it before the work exists.",
      },
      { t: 'cue', kind: 'click', text: 'Press Space once per role as you introduce it. The rail above the panels lights the same concern.' },
      {
        t: 'say',
        text: "The same chapter has a warning: a central AI team that handles every agent interaction becomes the bottleneck. The CoE builds reusable loops and guardrails; it shouldn't turn into a ticket queue that runs prompts for people.",
      },
      { t: 'cue', kind: 'ask', text: 'Looking at WHAT, HOW, and OPERATIONS, who here is already doing one of these jobs without the title?' },
      { t: 'cue', kind: 'next', text: "Titles and teams mean little unless you can tell whether you're governed. Here's the scorecard." },
    ],
    sources: [cite('hbCh6', 'C05')],
  },

  // ---- 7 ----------------------------------------------------------------------------------
  {
    id: 'm2-governance-matrix',
    moduleCode: 'M2',
    presenter: 'John',
    layout: 'scorecard-matrix',
    purpose: 'Let the room place their organization on the six governance capabilities.',
    kicker: 'Operating model',
    title: 'Governance readiness scorecard',
    lead: 'Where does your organization sit today? Name the sharpest gap.',
    blocks: [
      {
        kind: 'table',
        label: 'Governance readiness by capability and tier',
        rows: [
          ['Capability', 'None', 'Basic', 'Enterprise'],
          ['Audit trails', '\u25cb', '\u25cb', '\u25cb'],
          ['Agent access controls', '\u25cb', '\u25cb', '\u25cb'],
          ['Approval workflows', '\u25cb', '\u25cb', '\u25cb'],
          ['Data boundaries', '\u25cb', '\u25cb', '\u25cb'],
          ['Cost controls', '\u25cb', '\u25cb', '\u25cb'],
          ['Compliance reporting', '\u25cb', '\u25cb', '\u25cb'],
        ],
      },
      { kind: 'band', head: 'Start here', body: 'Audit trails and agent access controls unblock the other four capabilities.', tone: 'green' },
    ],
    widget: {
      kind: 'staged',
      mode: 'place',
      rows: ['audit-trails', 'agent-access-controls', 'approval-workflows', 'data-boundaries', 'cost-controls', 'compliance-reporting'],
      tiers: ['None', 'Basic', 'Enterprise'],
    },
    script: [
      {
        t: 'say',
        text: "Chapter 5 of the Handbook turns governance into six rows and three tiers. None means no control at all. Basic is the weak-form floor: a human reviews what the agent produced, after the fact. Enterprise is the strong-form bar: the action itself is gated when it executes. The Handbook treats Enterprise as directional. Most organizations at this stage sit at None or Basic on at least four rows, and that's expected. The goal is nothing at None where the risk is material.",
      },
      {
        t: 'say',
        text: "Start with the first two rows. Without knowing what agents did and limiting what they can do, the other four have no foundation. Microsoft's Cloud Adoption Framework says the same: audit and monitoring baselines and least-privilege access come before you widen agent autonomy.",
      },
      { t: 'cue', kind: 'poll', text: "Let's place your organization. I'll read a row. Call out None, Basic, or Enterprise by voice or in chat, and I'll tap the cell. Don't be generous. This is for you, not for me." },
      { t: 'cue', kind: 'click', text: 'Click the cell the room names; click it again to clear. The row tints amber, azure or green.' },
      { t: 'cue', kind: 'ask', text: 'Now that the grid is filled in, which gap feels sharpest for 2027?' },
      {
        t: 'say',
        text: "I'd also watch the cost controls row. Basic is a per-team token budget and an alert on unusual use. Enterprise is cost attributed to each agent task, with a circuit breaker on runaway sessions. We'll come back to it in the economics section.",
      },
      { t: 'cue', kind: 'next', text: "That's what has to be true. Next, how you'll know it's working: metrics." },
    ],
    sources: [cite('hbCh5', 'C06'), cite('cafGov', 'C06')],
  },
];
