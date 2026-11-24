/**
 * Module 5: whack-a-mole bottlenecks (slides 15-17).
 */

import { pipelineMap, roleJunior, roleLead, roleSenior, timeShift } from '../diagrams/m5';
import { cite } from './sources';
import type { Slide } from './types';

export const m5: Slide[] = [
  // ---- 15 ---------------------------------------------------------------------------------
  {
    id: 'm5-time-shift',
    moduleCode: 'M5',
    presenter: 'John',
    layout: 'paired-bar-chart',
    purpose: 'Show where engineer time moves when agents write the first draft.',
    kicker: 'Bottlenecks',
    title: 'Where engineer time goes next',
    blocks: [
      {
        kind: 'band',
        head: 'Review gets harder',
        body: 'Agent output looks plausible and passes tests, yet may hide subtle misunderstandings.',
        key: 'review',
        tone: 'violet',
      },
    ],
    note: '\u2020 Handbook author projection, not survey data',
    diagram: timeShift,
    script: [
      {
        t: 'say',
        text: "Cheaper, faster generation sounds like pure upside until you ask what happens to the rest of the week. The Handbook's projection, based on author observation and early-adopter reports rather than a survey, is that writing code stops being the biggest slice. The time moves into specification, into review, and into a brand-new activity, context engineering.",
      },
      {
        t: 'say',
        text: "These are independent estimates per activity, and they don't sum to a hundred, so read each pair of bars on its own.",
      },
      {
        t: 'say',
        text: 'Reviewing agent output is harder, not easier, according to the Handbook, because the output comes from a statistical process. The code can have clean syntax and passing tests and still be quietly wrong about intent. Review skill becomes a core competency.',
      },
      {
        t: 'say',
        text: 'Speed up generation without redesigning intake and review, and unmerged work piles up.',
      },
      { t: 'cue', kind: 'ask', text: "Where do your senior engineers' hours go in a normal week now?" },
      { t: 'cue', kind: 'next', text: "So where does the constraint move once generation is fast?" },
    ],
    sources: [cite('hbCh6', 'C12')],
  },

  // ---- 16 ---------------------------------------------------------------------------------
  {
    id: 'm5-whack-a-mole',
    moduleCode: 'M5',
    presenter: 'John',
    layout: 'pipeline-map',
    purpose: 'Map where the delivery constraint resurfaces once generation speeds up.',
    kicker: 'Bottlenecks',
    title: 'Whack-a-mole in the pipeline',
    blocks: [
      {
        kind: 'panel',
        head: 'Intake starves',
        body: 'Product cannot supply dev-ready specs fast enough; size and ground specs first.',
        key: 'intake',
        stage: 'intake',
        tone: 'amber',
      },
      {
        kind: 'panel',
        head: 'Review drowns',
        body: 'Plausible diffs flood reviewers; use one file per agent and a two-round cap.',
        key: 'review',
        stage: 'review',
        tone: 'amber',
      },
      {
        kind: 'panel',
        head: 'QA lags',
        body: 'Features outrun manual cycles; run deterministic tests outside the agent.',
        key: 'qa',
        stage: 'qa',
        tone: 'amber',
      },
    ],
    diagram: pipelineMap,
    widget: {
      kind: 'staged',
      mode: 'steps',
      stages: [
        { key: 'intake', announce: 'Constraint 1: product intake starves' },
        { key: 'review', announce: 'Constraint 2: pull-request review drowns' },
        { key: 'qa', announce: 'Constraint 3: QA lags' },
      ],
    },
    script: [
      {
        t: 'say',
        text: "Practitioners call this whack-a-mole, and it fits. Speed up the build step and the constraint pops up somewhere else. Let's walk the three places it surfaces.",
      },
      { t: 'cue', kind: 'click', text: 'Press Space once per bottleneck. The node and its panel light together; agent build stays green because it is the part that got fast.' },
      {
        t: 'say',
        text: "Upstream, intake starves. Product can't produce development-ready specs as fast as agents can consume them. The fixes live on the spec side: size the work before it enters the pipeline, and ground the spec in what the legacy system actually does rather than what the ticket claims.",
      },
      {
        t: 'say',
        text: "In the middle, review drowns. Reviewers face plausible diffs at volume. The Handbook has two rules for this. One file, one agent, per wave, so agents never collide on the same file. And a retry budget: after two failed dispatches, decompose, add context, or escalate. Its anti-pattern list has a symptom you may recognize, a three-dispatch task that quietly burns fifteen.",
      },
      {
        t: 'say',
        text: "Downstream, QA lags. Most teams already have automated end-to-end and load tests. Run those suites outside the agent, deterministically, and never take the agent's word that the tests pass. Check the git diff and the CI exit code. And prove a new test can fail before you trust that it passes.",
      },
      { t: 'cue', kind: 'ask', text: "Which constraint hurts most in your pipeline right now: intake, review, or QA? I'll tally." },
      { t: 'cue', kind: 'next', text: 'Try one of these fixes on a real pipeline soon. Before we leave bottlenecks, the human side.' },
    ],
    sources: [cite('hbCh20', 'C15'), cite('hbCh17', 'C15')],
  },

  // ---- 17 ---------------------------------------------------------------------------------
  {
    id: 'm5-junior-senior-shift',
    moduleCode: 'M5',
    presenter: 'John',
    layout: 'evolution-rows',
    purpose: 'Show how engineering roles evolve under agentic delivery.',
    kicker: 'Bottlenecks',
    title: 'Roles evolve, judgment stays',
    blocks: [
      {
        kind: 'card',
        head: 'Senior engineers',
        body: 'Implementers become context architects: architecture, context engineering, escalated reviews, mentoring.',
        key: 'senior',
        tone: 'azure',
        art: roleSenior,
      },
      {
        kind: 'card',
        head: 'Tech leads',
        body: 'Task assigners become orchestrators across humans and agents, owning the feedback loop.',
        key: 'lead',
        tone: 'violet',
        art: roleLead,
      },
      {
        kind: 'card',
        head: 'Junior engineers',
        body: 'Code writers become AI-augmented contributors who review output, write specs, diagnose failures.',
        key: 'junior',
        tone: 'green',
        art: roleJunior,
      },
    ],
    script: [
      {
        t: 'say',
        text: "The same pressure changes jobs. The Handbook's framing is that adoption shifts the proportion of time, not which activities need human judgment. A senior engineer goes from the person who writes the hardest code to the person who shapes the system that writes it. And the cases that reach a senior engineer get harder, not fewer, so their judgment is worth more.",
      },
      {
        t: 'say',
        text: 'Tech leads become owners of the feedback loop: which context gaps keep producing the same agent failure, and who fixes them. That ties straight back to the CoE.',
      },
      {
        t: 'say',
        text: 'Juniors are the sensitive one. If agents take the tasks juniors used to learn on, how do juniors learn? The Handbook offers three models: review-intensive apprenticeship, agent-assisted learning with scaffolded complexity, and specification-first roles. It calls them informed hypotheses, and says no organization has run any of them for a full cycle of twelve months or more with measured results.',
      },
      {
        t: 'say',
        text: "I'd measure it, and pair every junior's agent work with a senior who reviews the reasoning as well as the output.",
      },
      { t: 'cue', kind: 'ask', text: 'How do juniors on your teams learn the codebase today, and what changed in the last six months?' },
      { t: 'cue', kind: 'next', text: "Security is next, and that's where trust-but-verify gets sharpest." },
    ],
    sources: [cite('hbCh6', 'C12')],
  },
];
