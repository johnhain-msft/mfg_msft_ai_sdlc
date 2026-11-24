/**
 * Module 7: field gotchas, roadmap, six dimensions of maturity, and open floor (slides 21-25).
 */

import { bubbleArt, maturityRadar, quizProgress } from '../diagrams/m7';
import { SRC, cite } from './sources';
import type { Slide } from './types';

export const m7: Slide[] = [
  // ---- 20 ---------------------------------------------------------------------------------
  {
    id: 'm7-anti-patterns',
    moduleCode: 'M7',
    presenter: 'John',
    layout: 'gotcha-table',
    purpose: 'Give the room a shared vocabulary for six common agentic failures.',
    kicker: 'Field gotchas',
    title: 'Six anti-patterns, six recoveries',
    blocks: [
      {
        kind: 'table',
        label: 'Six agentic anti-patterns and their recoveries',
        rows: [
          ['Gotcha', 'Recovery'],
          ['Monolithic prompt', 'Split into scoped instructions and skills'],
          ['Trust fall', 'Run tests, check git diff'],
          ['Same-file collisions', 'One file, one agent'],
          ['Unfixed primitives', 'Patch the instruction or skill'],
          ['Almost-done trap', 'Commit the 90%, finish fresh'],
          ['Cost runaway', 'Two retries, then decompose or escalate'],
        ],
      },
    ],
    script: [
      {
        t: 'say',
        text: "The Handbook lists nineteen anti-patterns, and these six are the ones I'd watch for first.",
      },
      {
        t: 'say',
        text: 'The monolithic prompt is number one in the Handbook: one giant instruction file that does everything. Break it into scoped instruction files plus skills that load on demand. The trust fall is number seven, and my favorite line from the book: agent self-reports are generated text, not system logs. So run the test suite and verify file state with git diff. Same-file collisions are number eight: two agents editing one file in parallel. The fix is the one-file-one-agent rule per wave.',
      },
      {
        t: 'cue',
        kind: 'story',
        text: 'One short field story per gotcha, from your own work. Use only a story you can stand behind; do not invent one.',
      },
      {
        t: 'say',
        text: 'Not fixing the primitives is number ten. When an agent makes the same mistake twice, patch the instruction or the skill, not just the diff, or the mistake comes back tomorrow. The almost-done trap is number fifteen: the agent is ninety percent there and the loop drags on. Accept and commit the ninety, then finish by hand or in a fresh session. And cost runaway is number fourteen, the three-dispatch task that consumes fifteen. The fix is the retry budget we covered earlier: two failed dispatches, then change the approach.',
      },
      { t: 'cue', kind: 'ask', text: 'Which of these six have you hit this week? Call out the gotcha name or type it in chat.' },
      { t: 'cue', kind: 'next', text: "Now let's turn the whole session into a plan." },
    ],
    sources: [cite('hbCh20', 'C15'), cite('hbCh17', 'C15')],
  },

  // ---- 21 ---------------------------------------------------------------------------------
  {
    id: 'm7-roadmap',
    moduleCode: 'M7',
    presenter: 'John',
    layout: 'timeline-rail',
    purpose: "Turn the session's themes into one 90-day starting plan.",
    kicker: 'Next 90 days',
    title: 'A 30-60-90 plan',
    blocks: [
      {
        kind: 'step',
        head: 'Days 1\u201330 \u00b7 Charter',
        body: 'Charter a time-boxed enabling CoE, baseline three process costs, lock strong-form PR security gates.',
        key: 'charter',
        tone: 'azure',
      },
      {
        kind: 'step',
        head: 'Days 31\u201360 \u00b7 Metrics',
        body: 'Shift the dashboard to time-to-confident-merge and rework; ship three cost-engineered loops.',
        key: 'metrics',
        tone: 'violet',
      },
      {
        kind: 'step',
        head: 'Days 61\u201390 \u00b7 Scale',
        body: 'Pilot targeted AI scanning beside CodeQL; automate golden-dataset evals per product.',
        key: 'scale',
        tone: 'green',
      },
    ],
    script: [
      {
        t: 'say',
        text: "Take this plan as a suggested starting point, not a Handbook prescription, and adapt it. The first thirty days are about ownership and a charter. At least six to twelve months is the realistic enterprise window for the CoE, so write the shift to advisory guardrails into the charter on day one. Microsoft's Cloud Adoption Framework says to integrate with an existing center of excellence where you can, and to plan that move from hands-on building to advisory guardrails.",
      },
      {
        t: 'say',
        text: 'Put numbers on three process costs, using the X, Y, and V questions from earlier, so that in ninety days you can show something other than activity. And lock the gates: the agent never holds the merge or deploy credential.',
      },
      {
        t: 'say',
        text: "Days thirty-one to sixty are about changing what you report. Move the dashboard off activity counts and onto merge confidence and rework. That's the point where leadership gets a number that means something.",
      },
      {
        t: 'say',
        text: 'And ship the first loops that are engineered for cost. Pick recurring, ROI-positive tasks, and bake in the prefix, the tool subset, and the model routing so everybody inherits them.',
      },
      {
        t: 'say',
        text: "Days sixty-one to ninety are scale. Add golden datasets so quality doesn't silently degrade when a prompt or skill changes. Then a scanning pilot, with a budget.",
      },
      {
        t: 'say',
        text: 'Start narrow. One product, one high-risk path, one pull-request scan, and a credit budget you can explain.',
      },
      { t: 'cue', kind: 'ask', text: 'What would you need to start Monday, and who in this room would own it?' },
      { t: 'cue', kind: 'next', text: 'Beyond the first ninety days, how do you measure maturity across the whole organization?' },
    ],
    sources: [cite('cafCoe', 'C03'), cite('cafGovernAi', 'C08'), cite('hbCh7', 'C11'), cite('ghAiScan', 'C13')],
  },

  // ---- 23 ---------------------------------------------------------------------------------
  {
    id: 'm7-maturity-dimensions',
    moduleCode: 'M7',
    presenter: 'John',
    layout: 'maturity-dimensions',
    purpose: 'Assess organizational readiness across the six dimensions of agentic maturity.',
    kicker: 'Maturity model',
    title: 'Six dimensions of maturity',
    blocks: [
      {
        kind: 'table',
        header: false,
        label: 'Six dimensions of agentic maturity',
        rows: [
          ['Delivery practices', 'Does every role use AI across delivery?'],
          ['Agent-ready codebase', 'Are repos, docs, and tests agent-ready?'],
          ['Agent utilization', 'What share of work is agentic?'],
          ['Operations', 'Can AI monitor and heal production?'],
          ['Team autonomy & enablement', 'Do dependencies block team speed?'],
          ['Responsible AI', 'Which non-negotiables protect trust?'],
        ],
      },
    ],
    note: 'Illustrative enterprise profile',
    diagram: maturityRadar,
    script: [
      {
        t: 'say',
        text: "These six dimensions are how I'd measure maturity once you're past the first ninety days. They pair the six engineering maturity questions on the left with Microsoft Learn's Agentic AI Adoption Maturity Model, which runs from Level 100 Initial up to Level 500 Efficient. Microsoft's how-to-use guidance says to plot maturity as a radar profile and never collapse it into a single overall score, because a single score hides the recessed spokes that show where scaling will break next. On our slide, dashed is where you are today and solid is your near-term target.",
      },
      {
        t: 'say',
        text: 'The first three rows cover adoption and readiness. Is AI use limited to the people writing code, or do product, design, QA, and security use it too? Could an agent work in your repositories, architecture docs, and test harnesses without help from whoever remembers the history? And what share of eligible work actually runs through agentic workflows? Seat utilization is only a leading indicator. It tells you whether the investment has a chance to create value, not whether value was created.',
      },
      {
        t: 'say',
        text: "Row four is operations, and it matters most for site-reliability and incident agents. Measure the full operational loop: signal, diagnosis, proposed remediation, validation, approval, deployment, verified recovery, and preventive learning, where incident findings turn into durable tests or controls. Don't judge an SRE agent by how many recommendations it generates. Judge it by whether it shortens time to safe recovery and prevents recurrence.",
      },
      {
        t: 'say',
        text: 'Rows five and six are where speed and trust pull against each other. Team autonomy asks whether dependencies and manual handoffs still slow teams down after coding speeds up. Responsible AI asks which non-negotiables stay in place: audit provenance, secret protection, least-privilege access, and human sign-off on sensitive paths. Agent autonomy should be earned by demonstrated performance inside guardrails. Zero human touch is never the goal when policy requires a gate.',
      },
      { t: 'cue', kind: 'ask', text: 'Looking at the six rows, which one is your organization strongest on today, and which recessed spoke needs investment next?' },
      { t: 'cue', kind: 'next', text: 'Before we open the floor, a quick pulse check to see what stuck.' },
    ],
    sources: [cite('msAgentMaturity', 'C18'), cite('msAgentMaturityHowTo', 'C18'), cite('ghMetrics', 'C08'), cite('hbCh12', 'C04')],
  },

  // ---- 24 ---------------------------------------------------------------------------------
  {
    id: 'm7-quiz',
    moduleCode: 'M7',
    presenter: 'John',
    layout: 'quiz-widget',
    purpose: "Check whether the room can apply the session's decisions to fresh scenarios.",
    kicker: 'Room check',
    title: 'Three scenarios, three decisions',
    blocks: [
      { kind: 'card', head: '1 \u00b7 Board metric', body: 'AI-generated lines are up. Pick: acceptance rate, time-to-confident-merge, or seat count?', key: 'board-metric', tone: 'azure' },
      { kind: 'card', head: '2 \u00b7 Cost lever', body: 'Sixty-five tools load every turn. Pick: tool subset, model router, or bigger window?', key: 'cost-lever', tone: 'violet' },
      { kind: 'card', head: '3 \u00b7 Gate choice', body: 'Tests pass, wrong feature built. Pick: more tests, design checkpoint, or lint?', key: 'gate-choice', tone: 'amber' },
    ],
    widget: {
      kind: 'quiz',
      questions: [
        { key: 'board-metric', answer: 1, options: 3 },
        { key: 'cost-lever', answer: 0, options: 3 },
        { key: 'gate-choice', answer: 1, options: 3 },
      ],
    },
    diagram: quizProgress,
    script: [
      { t: 'say', text: "Three scenarios. Hands, or type A, B, or C in chat. I'll read each scenario and tally the votes as we go." },
      { t: 'cue', kind: 'click', text: 'Tap the dots under an option for each raised hand. Press Enter to reveal the active scenario; the answer rings green and the rest dim.' },
      {
        t: 'say',
        text: 'Scenario one is the board. Lines of AI-generated code are up, and someone wants to put that in the quarterly deck. Which measure would you rather defend?',
      },
      { t: 'cue', kind: 'wait', text: 'Collect hands and chat votes, tally them on the dots, then press Enter to reveal Scenario 1 before explaining.' },
      {
        t: 'say',
        text: 'The answer is the middle one. Lines and acceptance rates tell you the tool is busy. Seat counts tell you it is licensed. A reviewer approving without reservations tells you the work is landing.',
      },
      { t: 'say', text: 'Scenario two is the bill. Sixty-five tools load on every single turn. Which lever?' },
      { t: 'cue', kind: 'wait', text: 'Collect votes and tally on Scenario 2, then press Enter to reveal before explaining.' },
      {
        t: 'say',
        text: "The tool subset. A bigger window doesn't make the model pay attention to more, and a router helps pick a model, not shrink the tool list.",
      },
      { t: 'say', text: 'Scenario three is the build. Tests are green, the lint is clean, and the agent built the wrong feature. Which gate?' },
      { t: 'cue', kind: 'wait', text: 'Collect votes and tally on Scenario 3, then press Enter to reveal before explaining.' },
      {
        t: 'say',
        text: 'A design checkpoint. More tests and stricter lint verify form, not intent. If the failure you fear is goal drift, the test suite is theater.',
      },
      { t: 'cue', kind: 'ask', text: 'Which of the three surprised you? Which would you want to run on your own team first?' },
      { t: 'cue', kind: 'next', text: 'Good. On to your questions.' },
    ],
    sources: [],
  },

  // ---- 23 ---------------------------------------------------------------------------------
  {
    id: 'm7-open-floor',
    moduleCode: 'M7',
    presenter: 'John',
    layout: 'discussion-rail',
    purpose: 'Open the floor for candid questions from every role in the room.',
    kicker: 'Open floor',
    title: 'Ask us anything',
    blocks: [
      { kind: 'card', head: 'Leadership & product', body: 'How do we fund the CoE and prove value?', key: 'leadership', tone: 'azure', icon: 'flag', art: bubbleArt },
      { kind: 'card', head: 'Architecture & CoE', body: 'Which primitives, evals, and gates come first?', key: 'architecture', tone: 'violet', icon: 'layers', art: bubbleArt },
      { kind: 'card', head: 'Engineering, QA & security', body: 'Where do reviews, tests, and scans slow you down?', key: 'engineering', tone: 'green', icon: 'shield', art: bubbleArt },
      {
        kind: 'band',
        head: 'Keep reading',
        body: 'Agentic SDLC Handbook, Cloud Adoption Framework, and GitHub Copilot and security docs.',
        key: 'reading',
        tone: 'azure',
        links: [
          { icon: 'book', href: SRC.hbIndex.url, label: 'The Agentic SDLC Handbook' },
          { icon: 'compass', href: SRC.cafAi.url, label: 'Microsoft Cloud Adoption Framework: AI' },
          { icon: 'shield', href: SRC.ghSecurityDocs.url, label: 'GitHub Docs: code security' },
        ],
      },
    ],
    script: [
      {
        t: 'say',
        text: "The floor is yours, and that means every seat in the room, from leadership to DevOps. The three prompts on the screen are only starters. Ask the question you wouldn't ask in a steering meeting.",
      },
      {
        t: 'say',
        text: "I'll keep a parking lot for anything we need to follow up on. One closing thought for leadership. The goal of an agentic SDLC is to improve the organization's ability to turn an idea into a safe, valuable, supportable production outcome, proven with a baseline, an end-to-end trace, balanced measures of speed and quality, and unit economics. A workflow should scale only after it shows repeatable value without shifting cost or risk downstream.",
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'How big should the CoE be?',
        text: 'If needed, how big should the CoE be? The Handbook says a small central AI team, and that these roles are specializations existing team members grow into. No source prescribes a head count. Start small and time-boxed, and size it to the work that exists.',
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'ROI on brownfield modernization',
        text: 'If needed, how do we measure ROI on brownfield legacy modernization? There is no sourced benchmark. Baseline the process first, expect a dip and then compounding, and measure rework and time-to-confident-merge rather than lines.',
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'Preventing review fatigue',
        text: 'If needed, how do we prevent review fatigue? Thin slices, one file per agent, a two-round retry budget, an independent reviewer before a human sees it, and risk-tiered review for sensitive paths.',
      },
      {
        t: 'cue',
        kind: 'note',
        optional: true,
        group: 'Frontier or fast models?',
        text: 'If needed, frontier models or fast models? Route by stage: a heavy planner, a mid-tier executor, a lightweight triage model. Gate frontier access to a small central team, with a metered escape hatch for tasks that truly need it.',
      },
      { t: 'cue', kind: 'ask', text: 'Who wants to go first?' },
      {
        t: 'cue',
        kind: 'next',
        text: 'Thank you.',
      },
    ],
    sources: [cite('hbIndex'), cite('cafAi'), cite('ghSecurityDocs')],
  },
];
