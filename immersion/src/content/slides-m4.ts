/**
 * Module 4: process economics, executive ROI, and prompt optimization (slides 11-15).
 */

import { balanceScale, honestTco, roiTraceDiagram, twinBarsDiagram } from '../diagrams/m4';
import { calibrate, describeAssumptions } from '../widgets/tokenModel';
import { promptModel } from './prompt-model';
import { cite } from './sources';
import type { Slide } from './types';

export const m4: Slide[] = [
  // ---- 11 ---------------------------------------------------------------------------------
  {
    id: 'm4-process-economics',
    moduleCode: 'M4',
    presenter: 'John',
    layout: 'balance-compare',
    purpose: 'Reframe AI cost as a business-process question before a token question.',
    kicker: 'Process economics',
    title: 'Can we build it? Should we?',
    blocks: [
      { kind: 'card', head: 'Token-only view', body: 'Asks what the model call cost; ignores human hours and calendar delay.', key: 'token-only', tone: 'amber', icon: 'coin' },
      {
        kind: 'card',
        head: 'Business-process view',
        body: 'Compare process cost today X with AI-enabled cost Y, weighed against value V.',
        key: 'business-process',
        tone: 'green',
        icon: 'table',
      },
      { kind: 'band', head: 'Baseline three processes', body: 'Requirements intake, legacy analysis, QA triage: where is friction highest?', tone: 'azure' },
    ],
    diagram: balanceScale,
    script: [
      {
        t: 'say',
        text: "You've all heard that AI lets us build software faster than ever. True. But just because we can build it faster, should we? Engineering activity isn't the return. The return shows up when improved engineering performance changes a business outcome.",
      },
      {
        t: 'say',
        text: "Most cost conversations stop at the model call, tokens in and tokens out. That's easy to measure, and it's the wrong denominator. A business-process view starts with what the process costs today in human hours and in calendar delay, the weeks a requirement sits waiting for an answer.",
      },
      {
        t: 'say',
        text: "Microsoft's business-value guidance starts by defining success metrics, unit value, and a baseline before you build. In software delivery, we recommend measuring that value in concrete outcome units: a feature released, a vulnerability remediated, an incident resolved, an application migrated, or a customer workflow automated. Then ask three questions. What does this process cost now? What would it cost with AI in it? What is the outcome worth?",
      },
      {
        t: 'say',
        text: "Aim at the highest friction first: a requirements intake that takes weeks, a legacy analysis nobody wants to start, QA triage that eats a senior engineer's Monday. Those are illustrations of a typical enterprise profile, not measurements from your own organization.",
      },
      { t: 'cue', kind: 'ask', text: 'Which of the three has the longest calendar delay in your organization today? Call it out.' },
      { t: 'cue', kind: 'next', text: 'Once you define a unit of value, how do you put executive ROI on a single page for the board?' },
    ],
    sources: [cite('msAgentDefine', 'C17'), cite('cafAgentPlan', 'C17')],
  },

  // ---- 12 ---------------------------------------------------------------------------------
  {
    id: 'm4-executive-roi',
    moduleCode: 'M4',
    presenter: 'John',
    layout: 'roi-scorecard',
    purpose: 'Give executives a six-part ROI scorecard, unit-cost formula, and trace protocol.',
    kicker: 'Process economics',
    title: 'Measuring executive ROI',
    blocks: [
      {
        kind: 'table',
        label: 'Six-category executive balanced scorecard for agentic SDLC ROI',
        rows: [
          ['Category', 'Executive measure'],
          ['Business value', 'Outcomes delivered, value per dollar'],
          ['Flow', 'Idea-to-production lead time, predictability'],
          ['Quality', 'First-pass acceptance, rework, escaped defects'],
          ['Reliability & risk', 'Change failures, recovery, compliance'],
          ['People & adoption', 'SPACE experience, workflow maturity'],
          ['Economics', 'Total cost, cost per outcome'],
        ],
      },
      {
        kind: 'band',
        head: 'ROI & trace',
        body: 'Weigh verified value and cost avoided against full operating cost.',
        key: 'roi-trace',
        tone: 'green',
      },
    ],
    diagram: roiTraceDiagram,
    script: [
      {
        t: 'say',
        text: "For an executive review, I wouldn't walk in with one universal productivity number. Microsoft Research's SPACE framework and GitHub's metrics guidance both warn that no single metric captures engineering productivity. Our full measurement guide covers nine engineering areas: business outcomes, end-to-end flow, quality and rework, reliability and operations, security and governance, agent effectiveness, developer experience, adoption and maturity, and total cost and unit economics. Those roll up into the six executive scorecard categories on this slide.",
      },
      {
        t: 'say',
        text: "On the People row, combine telemetry with short pulse surveys on focus, cognitive load, and review fatigue. And never use agent telemetry to evaluate individual developers. If agents save authoring time but developers spend the savings verifying low-confidence output, all we've done is move the work.",
      },
      {
        t: 'say',
        text: "On the Economics row, Microsoft's agent ROI guidance warns against the time-savings trap: claiming financial value from theoretical time savings with no chain of evidence to business outcomes. In practice, saved hours only become financial return when they're redirected to additional outcomes, lower external spend, or avoided hiring, or when you intentionally reinvest them in tests, docs, security, and technical debt.",
      },
      {
        t: 'say',
        text: "A practical way to calculate net ROI is to take verified value created plus verified cost avoided, subtract total agentic operating cost, and divide by that same operating cost. Then pair it with FinOps unit economics, where you pick a unit and cost it. For delivery, that could be a completed story, an accepted pull request, a release, a resolved defect or incident, or a migrated application. Token cost alone isn't agent cost. The denominator in that formula has to include licenses, hosting, integration, human review, retries, governance, and maintenance.",
      },
      {
        t: 'say',
        text: "To make those numbers hold up in a boardroom, I'd do three things. First, capture a baseline of four to eight weeks of data, or the ninety days Microsoft Learn recommends. Segment it by work complexity, repository, team, stack, legacy versus greenfield, and risk tier.",
      },
      {
        t: 'say',
        text: "Second, run a pilot cohort and a comparison cohort on one or two repeatable workflows, like unit-test generation, vulnerability remediation, defect triage, dependency upgrades, docs, incident diagnosis, or Playwright validation. Test an initial target, say a twenty-to-thirty percent cycle-time improvement, with zero quality or compliance loss. Don't scale from a demo or a naive before-and-after.",
      },
      {
        t: 'say',
        text: "Third, instrument one trace ID from business request through work item, agent run, model and tool calls, commit, pull request, tests and evaluations, deployment, and production result.",
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'Executive ROI cautions',
        text: 'If asked about metric pitfalls: (1) never use lines of code, commits, prompts, tokens, or acceptance rate as ROI; (2) never evaluate individual developers from agent telemetry—report at team and workflow level; (3) do not claim causation from a naive before-and-after comparison; (4) do not optimize for zero human touch where policy gates belong; (5) do not scale from a demo without sustained production evidence.',
      },
      { t: 'cue', kind: 'ask', text: 'If you had to pick one repeatable lighthouse workflow to baseline and trace for the next sixty days, which one would it be?' },
      { t: 'cue', kind: 'next', text: "Now for the denominator of that equation: what the first year actually costs." },
    ],
    sources: [
      cite('msAgentRoi', 'C17'),
      cite('msAgentDefine', 'C17'),
      cite('msAgentStory', 'C17'),
      cite('msFinopsUnit', 'C17'),
      cite('msSpace', 'C17'),
      cite('ghMetrics', 'C08'),
      cite('dora2025', 'C17'),
    ],
  },

  // ---- 13 ---------------------------------------------------------------------------------
  {
    id: 'm4-honest-tco',
    moduleCode: 'M4',
    presenter: 'John',
    layout: 'cost-bar-jcurve',
    purpose: 'Set a realistic first-year total-cost expectation, including the adoption dip.',
    kicker: 'Process economics',
    title: 'The honest Year-1 bill',
    blocks: [
      {
        kind: 'band',
        head: 'Hold through the valley',
        body: 'Expect 60\u201390 days of slower delivery; context debt, not tool failure, drives it.',
        key: 'valley',
        tone: 'amber',
      },
    ],
    note: '\u2020 Handbook author estimates for a ten-person team',
    diagram: honestTco,
    script: [
      {
        t: 'say',
        text: "Every vendor pitch includes the license fee. In the Handbook's illustrative model, a ten-person team spends about ninety-five to two hundred forty-nine thousand dollars in year one, and licenses are roughly a fifth to a quarter of that. It's an author's estimate from advisory work with early adopters. Your team size, region, and codebase will move it. The ratio is the point, not the dollars.",
      },
      {
        t: 'say',
        text: 'The rest is context engineering, which shows up as engineering time rather than an invoice, plus token and compute spend, training and change management, governance setup, and the opportunity cost of the dip. A business case that shows only the first row is incomplete.',
      },
      {
        t: 'say',
        text: 'Now the dip, in four phases. Months one and two are setup, with impact near zero or slightly negative. Months two to four are the valley: rework runs higher than expected, developers hit the cliff on your specific codebase, and somebody proposes restricting the tools to autocomplete. By months four to six, cycle time starts to fall, modestly, around fifteen to twenty-five percent on measurable tasks, again an author estimate. Months six to twelve are where compounding begins, which the Handbook treats as a working hypothesis, not a settled result.',
      },
      {
        t: 'say',
        text: "For the leaders in the room: if rejection rates spike and engineers say it doesn't understand our codebase, that's context debt showing up, not a failed tool. Teams that quit in the valley never reach the compounding phase.",
      },
      { t: 'cue', kind: 'ask', text: 'Where does your organization feel it is on that curve?' },
      { t: 'cue', kind: 'next', text: "Next is the run cost, where the biggest variance sits." },
    ],
    sources: [cite('hbCh3', 'C10')],
  },

  // ---- 13 ---------------------------------------------------------------------------------
  {
    id: 'm4-cost-spread',
    moduleCode: 'M4',
    presenter: 'John',
    layout: 'twin-bars',
    purpose: 'Show that identical work can differ 8.5 times in cost by workflow design.',
    kicker: 'Process economics',
    title: 'The same task, an 8.5\u00d7 bill',
    blocks: [
      { kind: 'card', head: 'Undesigned loop $41.01', body: 'File by file on a frontier model; re-read, re-plan, retry.', key: 'undesigned', tone: 'red' },
      { kind: 'card', head: 'Designed loop $4.81', body: 'Plan once, batch edits, route to a cheaper model, verify.', key: 'designed', tone: 'green' },
      { kind: 'band', head: 'Identical output', body: 'Same nineteen files, same passing tests; only the workflow design differs.', tone: 'azure' },
    ],
    note: 'Illustrative single run, not a benchmark',
    diagram: twinBarsDiagram,
    script: [
      {
        t: 'say',
        text: 'Take one ordinary task: refactor nineteen files to adopt a new error-handling convention. Run it two ways. In the first, the agent grinds through the files one at a time on a frontier model, re-reading context, re-planning, and retrying after every failure. In the second, a designed workflow plans once, batches the edits, sends the mechanical work to a cheaper model, and verifies at the end.',
      },
      {
        t: 'say',
        text: "Nineteen files either way, and the tests pass either way. In the Handbook's illustrative run, one path cost forty-one dollars and one cent, the other four dollars and eighty-one cents: an 8.5-times spread, or 88.3 percent lower on the designed path. The Handbook says these are single runs at point-in-time prices, not benchmarks. Treat them as an existence proof that variance can be engineered, not as a promised saving.",
      },
      {
        t: 'say',
        text: "Your AI bill is more a variance problem than a price problem, and the Handbook borrows portfolio thinking for it: you don't manage a portfolio by its average, you manage it by its tail. A designed workflow bounds your worst case to the worst planned step. An undesigned one bounds it to nothing.",
      },
      {
        t: 'say',
        text: "Can't every developer just optimize their own prompts? The Handbook says no, for structural reasons. Nobody should have to be a cost expert, nobody re-derives the cheap path on every prompt, and you can't switch harness per task. So you engineer it once, centrally, and everyone reuses the result. A small central AI team on gated frontier models codes the loops, and everyone else runs them on baseline tiers. That's the cost-effective-loop factory.",
      },
      { t: 'cue', kind: 'ask', text: 'If a forty-one-dollar run and a five-dollar run of the same work landed on your bill, would anyone notice today?' },
      { t: 'cue', kind: 'next', text: "Let's debug one live." },
    ],
    sources: [cite('hbCh7', 'C11'), cite('hbCh19', 'C11')],
  },

  // ---- 14 ---------------------------------------------------------------------------------
  {
    id: 'm4-prompt-debugger',
    moduleCode: 'M4',
    presenter: 'John',
    layout: 'token-model-sim',
    purpose: 'Let the room see which four levers drive the gap in prompt cost.',
    kicker: 'Live exercise',
    title: 'Debug one prompt',
    blocks: [
      { kind: 'tile', head: 'Scope context', body: '3,800 flat lines become 450 scoped lines.', key: 'scope', tone: 'azure' },
      { kind: 'tile', head: 'Stable prefix', body: 'Cache hits rise from 0% to 80%+.', key: 'prefix', tone: 'amber' },
      { kind: 'tile', head: 'Tool subset', body: '65 tools every turn become six scoped tools.', key: 'tools', tone: 'violet' },
      { kind: 'tile', head: 'Routed models', body: 'Fifteen frontier retries become plan, execute, and a two-round cap.', key: 'routing', tone: 'green' },
    ],
    stat: '$41.01 \u2192 $4.81 per run',
    note: 'Illustrative model, not vendor pricing',
    widget: { kind: 'prompt-debugger', params: promptModel },
    script: [
      {
        t: 'say',
        text: "This is the model I use to explain why the gap exists. It's mine, it's illustrative, and I tuned it so that with everything switched on it lands near the Handbook's run. Treat it as a teaching device, not a price quote. Flip the toggles and watch the bar.",
      },
      {
        t: 'say',
        text: 'Toggle one is the context. A flat dump of thousands of lines loads on every turn whether or not it is relevant. Loading only what the step needs is progressive disclosure, and it trims the tokens you pay for on every call.',
      },
      {
        t: 'say',
        text: 'Toggle two is the prefix. If something in your header changes every run, a timestamp or a reordered tool list, the provider cannot reuse the cached part. A cache-aware prefix keeps the stable part first and untouched, so repeat turns bill that part at a fraction of full input.',
      },
      {
        t: 'say',
        text: 'Toggle three is the tool surface. Loading dozens of tools on every turn is a token tax and widens the error surface. A tool subset exposes only what the step needs.',
      },
      {
        t: 'say',
        text: 'Toggle four is models and turns. The Handbook calls routing mechanical work to a frontier model the most common way teams overpay. A gradient workflow gives each stage the smallest model class it needs, a heavy planner and a mid-tier executor, and a retry or turn budget stops the loop from burning money.',
      },
      { t: 'cue', kind: 'ask', text: "Which toggle would save you the most today? Hands for one through four, and I'll flip them in the order you vote." },
      {
        t: 'say',
        text: "Nobody should hand-tune this per prompt. Bake it into shared skills and everybody inherits it. That's the case for a central team.",
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'Assumptions behind the model',
        text: 'Open the speaker-only assumptions drawer to show the unit costs and token counts in the model. Remind the room once more: not vendor pricing.',
        code: describeAssumptions(calibrate(promptModel)),
      },
      { t: 'cue', kind: 'next', text: 'Cheaper loops move the bottleneck. When coding gets faster, where does the time go?' },
    ],
    sources: [
      { ...cite('hbCh7', 'C11'), label: "Handbook Ch 7: the agentic SDLC bill (lever inputs are the presenter's own illustrative model)" },
      cite('hbCh19', 'C11'),
    ],
  },
];
