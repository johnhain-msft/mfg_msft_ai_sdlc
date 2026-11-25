/**
 * Module 3: metric evolution and evaluation frameworks (slides 8-10).
 */

import { genActivity, genFlow, genOutcomes, paradoxBars } from '../diagrams/m3';
import { cite } from './sources';
import type { Slide } from './types';

export const m3: Slide[] = [
  // ---- 8 ----------------------------------------------------------------------------------
  {
    id: 'm3-productivity-paradox',
    moduleCode: 'M3',
    presenter: 'John',
    layout: 'stat-bars-traps',
    purpose: 'Explain why a headline coding-speed gain overstates end-to-end delivery gains.',
    kicker: 'Metrics & evals',
    title: 'Faster coding is not faster delivery',
    blocks: [
      { kind: 'card', head: 'Denominator problem', body: 'At a 30% coding share, a 50% reduction in coding time saves 15%.', key: 'denominator', tone: 'azure', icon: 'gauge' },
      { kind: 'card', head: 'Quality discount', body: 'Rework and downstream debugging erase part of the speed gain.', key: 'quality', tone: 'amber', icon: 'loop' },
      { kind: 'card', head: 'Attribution problem', body: 'Crediting results to AI or developer alone misleads.', key: 'attribution', tone: 'violet', icon: 'search' },
    ],
    note: 'Lab finding: 55.8% less time on one JavaScript task',
    diagram: paradoxBars,
    script: [
      {
        t: 'say',
        text: "The number you've probably seen is 55 percent faster. It comes from a real lab study, Peng and colleagues, 2023, where developers finished one JavaScript HTTP-server task in 55.8 percent less time. It's a good study, but it's one task in a lab.",
      },
      {
        t: 'say',
        text: `The Handbook's point is that if you hand that to a board as "we are 55 percent faster," it falls apart in three places. First, the denominator. If coding is about thirty percent of a developer's week, halving it buys back roughly fifteen percent. That's still worth having. It just isn't fifty-five percent.`,
      },
      {
        t: 'say',
        text: "Second, the quality discount. Speed that arrives as rework isn't speed, and the thirty-to-sixty percent rework estimate I quoted earlier is the author's own estimate, with no controlled study behind it. Third, attribution. The developer prompts, the agent writes, the developer edits and prompts again. Credit the AI and you overstate its contribution; credit the developer and you understate the tool.",
      },
      {
        t: 'say',
        text: "The root cause is that we treat code as the output. Code is an intermediate artifact, and until it ships I'd call it inventory. So I'd judge return on investment in an agentic SDLC by whether we delivered valuable software faster, at lower unit cost, with equal or better quality, reliability, security, and developer experience.",
      },
      {
        t: 'say',
        text: "DORA's 2025 research frames AI as an amplifier of an organization's existing strengths and weaknesses. AI lifts throughput, but it keeps putting pressure on delivery stability unless automated testing, version control, fast feedback loops, and loosely coupled architecture hold the line.",
      },
      { t: 'cue', kind: 'ask', text: 'Has anyone here been asked to put a productivity number on this? What did you say?' },
      { t: 'cue', kind: 'next', text: 'If those are the wrong numbers, what do the right ones look like, and how do companies get there?' },
    ],
    sources: [cite('hbCh3', 'C07'), cite('peng', 'C07'), cite('dora2025', 'C17')],
  },

  // ---- 9 ----------------------------------------------------------------------------------
  {
    id: 'm3-metric-evolution',
    moduleCode: 'M3',
    presenter: 'John',
    layout: 'stepper-3gen',
    purpose: 'Show how enterprise AI metrics mature from activity counts to outcome measures.',
    kicker: 'Metrics & evals',
    title: 'Metrics grow up in three stages',
    blocks: [
      {
        kind: 'step',
        head: '1 \u00b7 Activity',
        body: 'Lines of code, PR volume, raw acceptance rate: more code, not better software.',
        key: 'gen1',
        stage: 'gen1',
        tone: 'neutral',
        art: genActivity,
      },
      {
        kind: 'step',
        head: '2 \u00b7 Flow and quality',
        body: 'Time-to-confident-merge, review rejection rate, and 30-day rework rate.',
        key: 'gen2',
        stage: 'gen2',
        tone: 'azure',
        art: genFlow,
      },
      {
        kind: 'step',
        head: '3 \u00b7 Outcomes and evals',
        body: 'Cost per outcome, defect escape rate, human intervention, golden dataset evaluations.',
        key: 'gen3',
        stage: 'gen3',
        tone: 'violet',
        art: genOutcomes,
      },
    ],
    note: 'Usage metrics show association, not causation.',
    widget: {
      kind: 'staged',
      mode: 'steps',
      stages: [
        { key: 'gen1', announce: 'Generation 1: activity metrics' },
        { key: 'gen2', announce: 'Generation 2: flow and quality metrics' },
        { key: 'gen3', announce: 'Generation 3: outcomes and evals' },
      ],
    },
    script: [
      {
        t: 'say',
        text: "I'll walk through the usual pattern for how companies pick their first AI metrics, find out they're flawed or gamed, and change course. Then I'd like to hear where your own dashboards sit.",
      },
      {
        t: 'say',
        text: "Most teams start with what's easy to count, because the tool emits it: seats activated, suggestions accepted, lines generated. The Handbook warns that optimizing for volume gets you more code rather than better software. GitHub's own usage-metrics documentation says these numbers show association, not that the tool caused a productivity gain.",
      },
      { t: 'cue', kind: 'click', text: 'Press Space once per stage. The stage you are talking about lifts and the other two step back.' },
      {
        t: 'say',
        text: "The second stage moves to flow and confidence. Separate creation time from elapsed delivery time. Cutting coding from eight hours to four creates little value if the work still spends nine days waiting for review and deployment. Time-to-confident-merge is the one I'd start with: how long until a reviewer approves without reservations. Then pair speed with quality metrics like rejection rate, thirty-day rework rate, and code survival, meaning how much generated code is still there at sixty and ninety days. Generated code that has to be corrected, secured, operated, and rewritten is a liability.",
      },
      {
        t: 'say',
        text: "The third stage gives leadership numbers it can use, like cost per outcome, escaped defects, and how often a person has to step in. Don't just count the interventions. Ask why each one happened. If a person stepped in because policy requires a security approval, that's a healthy control, not an agent failure. If they stepped in because of an unplanned failure, like a hallucinated API or a broken implementation, that's rework. Golden-dataset evaluations belong in this stage too, and Microsoft's Cloud Adoption Framework recommends them so quality is tested against known-good answers.",
      },
      {
        t: 'say',
        text: 'This one is a hypothetical, not a named customer. A team launches with a leaderboard for accepted suggestions and lines generated. Within weeks, pull requests balloon because developers accept verbose boilerplate, and senior reviewers drown in subtle defects. Swap the leaderboard for review rejection and thirty-day rework, and the incentive flips toward smaller diffs and grounded specs.',
      },
      {
        t: 'cue',
        kind: 'story',
        text: "Tell one anonymized customer story where an early metric, acceptance rate or lines generated, got gamed, what reviewers saw, and what replaced it. Tell only a story you can stand behind; no sourced case backs this slide.",
      },
      { t: 'cue', kind: 'ask', text: 'Which of the three stages does your dashboard look like today?' },
      { t: 'cue', kind: 'next', text: "Better metrics need a way to test quality. That's evals, and it starts with choosing the right gate." },
    ],
    sources: [cite('hbCh8', 'C08'), cite('hbCh3', 'C08'), cite('ghMetrics', 'C08'), cite('cafGovernAi', 'C08')],
  },

  // ---- 10 ---------------------------------------------------------------------------------
  {
    id: 'm3-gate-matrix',
    moduleCode: 'M3',
    presenter: 'John',
    layout: 'quad-decision-tree',
    purpose: 'Teach the room to match each quality gate to the failure it can catch.',
    kicker: 'Metrics & evals',
    title: 'Which gate catches it?',
    blocks: [
      { kind: 'tile', head: 'Programmatic-internal', body: 'Schema, lint, type check, unit tests, grounded lookups.', key: 'programmatic-internal', tone: 'azure' },
      { kind: 'tile', head: 'Judgement-internal', body: 'A goal-steward re-reads the spec: still on goal?', key: 'judgement-internal', tone: 'violet' },
      { kind: 'tile', head: 'Programmatic-external', body: 'Independent CI test runner or cold-reader rubric outside the agent.', key: 'programmatic-external', tone: 'green' },
      { kind: 'tile', head: 'Judgement-external', body: 'A human checkpoint: review, approval, or sign-off.', key: 'judgement-external', tone: 'amber' },
      { kind: 'chip', text: 'Goal drift' },
      { kind: 'chip', text: 'Schema break' },
      { kind: 'chip', text: 'Invented fact' },
      { kind: 'chip', text: 'Claimed green tests' },
    ],
    widget: {
      kind: 'decision-tree',
      map: {
        'goal-drift': ['judgement-internal', 'judgement-external'],
        'schema-break': ['programmatic-internal'],
        'invented-fact': ['programmatic-internal'],
        'claimed-green-tests': ['programmatic-external'],
      },
    },
    script: [
      {
        t: 'say',
        text: "The Handbook gives us a simple two-by-two for quality gates. One axis is who renders the verdict: something inside the agent's own process, or something outside it. The other is how: a programmatic check, or a judgment call.",
      },
      {
        t: 'say',
        text: 'As the Handbook puts it, if the failure mode you fear is goal drift, the test suite is theater. Tests green, lint clean, and the agent built the wrong feature. A programmatic gate inside the run verifies form, not intent.',
      },
      {
        t: 'say',
        text: "So pick the gate by the failure. A schema break wants a schema validator. An invented fact, say an issue filed for a customer that doesn't exist, wants a grounded lookup against the system of record, not a reviewer reading prose. Goal drift wants a judgment gate: a goal-steward re-reading the spec, or a human checkpoint at the design step. And when an agent says the tests pass, don't take its word. Re-run the suite in a separate pipeline, check the git diff, or score the output with an external rubric.",
      },
      {
        t: 'cue',
        kind: 'note',
        text: 'If the room already uses an independent reviewer agent, name it as an example; otherwise say a fresh-context reviewer. The lesson from many first versions is that tests passing inside an agent turn cannot catch goal drift or skipped tests; golden-fixture evals plus an independent reviewer close the gap.',
      },
      { t: 'cue', kind: 'ask', text: "Pick a failure from the chips and tell me which tile catches it. I'll click." },
      { t: 'cue', kind: 'next', text: "Gates cost engineering hours, and tokens cost money. So let's look at what all of this actually costs." },
    ],
    sources: [cite('hbCh16', 'C09'), cite('hbCh20', 'C09')],
  },
];
