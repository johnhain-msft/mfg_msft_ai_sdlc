/**
 * Customer-facing companion notes for the PDF handout (docs/Scaling-the-Agentic-SDLC.pdf).
 *
 * These are AUTHORED, not machine-filtered, from the presenter script. The live deck keeps its full
 * spoken script (src/content/*, docs/SPEAKER-SCRIPT.md); this file is the reader-facing edition:
 *   - no stage directions, no room mechanics (polls, tallies, "press Space", hover cues);
 *   - no story slots and no confidential preparation notes;
 *   - no speaker tags, hand-offs or room banter; second person ("you", "your organization");
 *   - author estimates and illustrations keep their caveats.
 *
 * scripts/handout/verify.mjs fails the build if a banned phrase slips in, if a number appears that is
 * not in the slide, its script or the glossary, or if a slide has no entry here.
 *
 * Text conventions (rendered by scripts/handout/compose.mjs):
 *   **bold**  *italic*  `code`     straight quotes become typographic quotes
 *   a body string starting with "- " is a list item; consecutive items form one list.
 */

export const REFLECT_LABEL = 'Team reflection';

/** Source labels that must read differently in a reader-facing document. */
export const LABEL_FIXES = [
  [/\(lever inputs are the presenter[\u2019']s own illustrative model\)/, '(with illustrative lever model)'],
];

export const NOTES = {
  // ------------------------------------------------------------------------------------ M1
  'm1-cover': {
    summary: 'An executive overview of the session: four capabilities that carry an agentic SDLC past its first successful pilot.',
    body: [
      "This session is not a pitch for AI. Most leadership teams are already committed, and most engineering groups have a working V1. The focus is year two, when the novelty fades and the questions become **who owns this, what does it cost, and is it working?**",
      'Four capabilities answer those questions, and each has a section ahead.',
      "The glyph on the slide is a loop: human, agent, platform. Most of what hurts at scale lives on the platform side of that loop, not inside the model.",
    ],
    extra: { type: 'toc', title: 'Inside this handout' },
  },

  'm1-vibe-cliff': {
    summary: 'A flawless greenfield demo predicts little about results in a real, brownfield codebase.',
    body: [
      "Take any greenfield demo: the agent builds a clean service in minutes because there is no history to trip over. Point the same model at a codebase with years of decisions in it and the experience changes. The Agentic SDLC Handbook (written by Daniel Meppiel at Microsoft in a personal capacity) calls this the **vibe coding cliff**.",
      "**Treat the 30–60% rework figure as a ballpark.** It is the author's own synthesis, and the Handbook says no controlled study has settled on a single number. Measure your own repositories.",
      "**Three structural properties explain the cliff, and none is a bug a vendor patches next quarter.** Attention is finite and fragile. The model only uses what is explicitly in front of it, so a convention that lives in a senior engineer's head does not exist for the agent. And the output is a draw from a distribution, so the same prompt can produce different diffs on different days.",
      "Picture a rule your best architect never wrote down, such as never calling a particular service synchronously. The agent will happily do it, and everything compiles.",
    ],
    reflect: 'Who on your team has watched an agent shine in a clean repository and then stumble in a module with history?',
  },

  'm1-attention-economy': {
    summary: 'A bigger context window does not mean more of it is in focus.',
    body: [
      "The context window is how much the model can hold, not how much it is paying attention to. Liu et al. made that measurable: they moved the one relevant fact around inside long inputs, in multi-document question answering and key-value retrieval. **Accuracy followed position.** It was best when the fact sat at the beginning or the end, and it fell significantly when the fact was buried mid-input, even for models built for long context. Handbook Chapter 15 connects that drop-off to context rot as a long session fills up.",
      "Translate that to a coding session (an illustration, not a measurement): your standing instructions load at the head, your current task sits at the tail, and everything you drag in between competes for the weak part of the curve.",
      "**PROSE is the Handbook's answer, and three of its five constraints are direct levers on attention.** In plain terms:",
      '- **Progressive disclosure:** load the instructions for the module you are touching and nothing else.',
      '- **Reduced scope:** give agents smaller tasks.',
      '- **Orchestrated composition:** chain small, single-purpose primitives and hand sub-tasks to fresh agents with clean windows.',
      'The other two, safety boundaries and explicit hierarchy, keep that discipline safe and predictable.',
    ],
    reflect: 'How many lines is your biggest instructions file today?',
  },

  // ------------------------------------------------------------------------------------ M2
  'm2-hero-trap': {
    summary: 'How a successful hero pilot matures into an enabling Center of Excellence, then into advisory guardrails.',
    body: [
      "This is how many programs start: two or three of the strongest architects and developers build V1. That works, and it is why so many organizations have a working V1 at all. The Handbook names the risk on the far side of that success, the **hero pilot**: a few top people, a friendly problem, brilliant results, and nothing they learned transfers. In practice it lives in their heads instead of in shared assets.",
      "**What the Handbook describes instead is two small groups:** an enabling team with a finite lifespan that guides other groups and writes practices down, and a small central group that encodes the cost-effective workflows everyone else reuses.",
      "**Microsoft's Cloud Adoption Framework says much the same.** Fold AI expertise into an existing center of excellence where you can. Start centralized early, so you build reusable assets and avoid fragmented adoption. Then move to an advisory guardrail role so the group never becomes the approval choke point.",
      "**How long?** At least six to twelve months is the realistic enterprise window. That fits the enabling-team idea: dedicated focus while practices take root, then a planned shift to advisory guardrails.",
      "**Watch for coach burnout.** Handbook Chapter 8 warns of it when pilot members spend more than roughly a quarter to a third of their time coaching. Its remedy is dedicated enablement or a slower rollout.",
    ],
    reflect: 'Without naming anyone: who owns your standards, evals and cost loops today, and how much of their week does it take?',
  },

  'm2-supply-chain': {
    summary: 'A single map of ownership across the agentic supply chain.',
    body: [
      "This map answers who owns what. Handbook Chapter 4 calls it the **agentic supply chain**. Read it from the bottom: your cloud, source control, identity and audit substrate; above that, the AI capabilities your teams author; above that, a layer that makes those capabilities versioned, owned and auditable; then the agent harness, which could be Copilot CLI or whatever else your people prefer; and at the top, the delivery phases people actually work in.",
      "**Standardize below the harness.** Tools will keep changing, but if the files that steer your agents are versioned and have named owners, they move with you. The Handbook defines seven primitive types, each with a file convention: `.instructions.md`, `.agent.md`, `SKILL.md`, `.prompt.md`, `.memory.md`, `.spec.md` and hooks.",
      "**Ownership, per the Handbook's figure.** Platform teams own the base and the harness. Platform and security teams share the governance layer. Domain specialists and workflow engineers own the capability layer. Stream-aligned product teams own the phases.",
    ],
    reflect: 'Which of these five layers has a named owner today, and which one belongs to whoever noticed it first?',
  },

  'm2-three-roles': {
    summary: 'The three authorship concerns a new AI-DLC function must cover.',
    body: [
      "In our view, the function you would be chartering is a new one: it blends software engineering with business-process knowledge. The Handbook splits it into three concerns.",
      "- **Domain Specialist (WHAT)** owns what a skill encodes: the procedure, rules, success criteria and eval. The Handbook is explicit that this person is not always an engineer. It can be the analyst or compliance officer who knows what a correct answer looks like.",
      "- **Agentic Workflow Engineer (HOW)** owns how the skill is built and composed. In a small team that is a senior engineer wearing a second hat, which is often one of the architects who built V1.",
      "- **Agent Operations Specialist (OPERATIONS)** owns cost, traces, eval drift and rate limits at scale. This is the role to resist hiring early: the Handbook says it emerges when more than one skill is in production and cost or drift needs dedicated attention. Do not staff it before the work exists.",
      "**A warning from the same chapter:** a central AI team that handles every agent interaction becomes the bottleneck. The CoE should build reusable loops and guardrails, not turn into a ticket queue that runs prompts for people.",
    ],
    reflect: 'Looking at WHAT, HOW and OPERATIONS: who is already doing one of these jobs without the title?',
  },

  'm2-governance-matrix': {
    summary: 'Place your organization on the six governance capabilities and find the sharpest gap.',
    body: [
      "Handbook Chapter 5 turns governance into **six capabilities and three tiers**. *None* means no control at all. *Basic* is the weak-form floor: a human reviews what the agent produced, after the fact. *Enterprise* is the strong-form bar: the action itself is gated when it executes.",
      "The Handbook treats Enterprise as directional. Most organizations at this stage sit at None or Basic on at least four rows, and that is expected. The goal is nothing at None where the risk is material.",
      "**Start with the first two rows.** Without knowing what agents did (audit trails) and limiting what they can do (agent access controls), the other four have no foundation. Microsoft's Cloud Adoption Framework says the same: audit and monitoring baselines and least-privilege access come before you widen agent autonomy.",
      "**Watch the cost controls row.** Basic is a per-team token budget and an alert on unusual use. Enterprise is cost attributed to each agent task, with a circuit breaker on runaway sessions. Slides 11–15 return to it.",
    ],
    reflect: 'Where does your organization sit on each of the six rows today, and which gap feels sharpest for 2027?',
  },

  // ------------------------------------------------------------------------------------ M3
  'm3-productivity-paradox': {
    summary: 'Why a headline coding-speed gain overstates end-to-end delivery gains.',
    body: [
      "The number you have probably seen is 55% faster. It comes from a real lab study (Peng et al., 2023) in which developers finished one JavaScript HTTP-server task in 55.8% less time. It is a good study, but it is one task in a lab.",
      "**Handed to a board as “we are 55% faster,” the claim falls apart in three places.**",
      "- **The denominator.** If coding is about 30% of a developer's week, halving it buys back roughly 15%. That is still worth having. It just is not 55%.",
      "- **The quality discount.** Speed that arrives as rework is not speed. The 30–60% rework estimate cited earlier is the Handbook author's own, with no controlled study behind it.",
      "- **Attribution.** The developer prompts, the agent writes, the developer edits and prompts again. Credit the AI and you overstate its contribution; credit the developer and you understate the tool.",
      "**The underlying problem is treating code as the output.** Code is an intermediate artifact, and until it ships it is closer to inventory. Judge return on investment by whether you delivered valuable software faster, at lower unit cost, with equal or better quality, reliability, security and developer experience.",
      "DORA's 2025 research frames AI as an **amplifier** of an organization's existing strengths and weaknesses. AI lifts throughput, but it keeps putting pressure on delivery stability unless automated testing, version control, fast feedback loops and loosely coupled architecture hold the line.",
    ],
    reflect: 'Have you been asked to put a single productivity number on AI-assisted delivery? What did you say?',
  },

  'm3-metric-evolution': {
    summary: 'How AI metrics mature from activity counts to outcome measures.',
    body: [
      "**Stage 1: activity.** Most teams start with what is easy to count because the tool emits it: seats activated, suggestions accepted, lines generated. The Handbook warns that optimizing for volume gets you more code rather than better software, and GitHub's usage-metrics documentation says these numbers show association, not that the tool caused a productivity gain.",
      "**Stage 2: flow and quality.** Separate creation time from elapsed delivery time: cutting coding from eight hours to four creates little value if the work still waits nine days for review and deployment. Start with **time-to-confident-merge**, how long until a reviewer approves without reservations. Pair speed with rejection rate, 30-day rework rate and code survival, meaning how much generated code is still there at 60 and 90 days. Generated code that has to be corrected, secured, operated and rewritten is a liability.",
      "**Stage 3: outcomes and evals.** Leadership gets numbers it can use: cost per outcome, escaped defects and how often a person has to step in. Ask why each intervention happened. A person stepping in because policy requires a security approval is a healthy control; one stepping in after a hallucinated API or a broken implementation is rework. Golden-dataset evaluations belong here too, and Microsoft's Cloud Adoption Framework recommends them so quality is tested against known-good answers.",
      "**An illustrative scenario (hypothetical, not a named customer).** A team launches with a leaderboard for accepted suggestions and lines generated. Within weeks, pull requests balloon with verbose boilerplate and senior reviewers drown in subtle defects. Swapping the leaderboard for review rejection and 30-day rework flips the incentive toward smaller diffs and grounded specs.",
    ],
    reflect: 'Which of the three stages does your dashboard look like today?',
  },

  'm3-gate-matrix': {
    summary: 'Match each quality gate to the failure it can actually catch.',
    layout: 'split',
    body: [
      "The Handbook offers a simple two-by-two for quality gates. One axis is **who renders the verdict**: something inside the agent's own process, or something outside it. The other is **how**: a programmatic check or a judgment call.",
      "**If the failure mode you fear is goal drift, the test suite is theater.** Tests green, lint clean, and the agent built the wrong feature. A programmatic gate inside the run verifies form, not intent.",
      "**Pick the gate by the failure.** An invented fact, such as an issue filed for a customer that does not exist, needs a grounded lookup against the system of record, not a reviewer reading prose. When an agent says the tests pass, do not take its word: re-run the suite in a separate pipeline, check the git diff, or score the output with an external rubric.",
      "Tests passing inside an agent turn cannot catch goal drift or skipped tests. Golden-fixture evaluations plus an independent fresh-context reviewer close the gap.",
    ],
    extra: {
      type: 'table',
      title: 'Which gate catches which failure',
      head: ['Failure', 'Gate that catches it'],
      widths: ['30%', '70%'],
      rows: [
        ['Goal drift', 'A judgment gate: a goal-steward re-reading the spec, or a human checkpoint at the design step.'],
        ['Schema break', 'Programmatic-internal: a schema validator.'],
        ['Invented fact', 'Programmatic-internal: a grounded lookup against the system of record.'],
        ['Claimed green tests', 'Programmatic-external: an independent CI re-run, the git diff, or an external rubric.'],
      ],
    },
    reflect: 'Pick a failure from the slide. Which gate would catch it in your pipeline today?',
  },

  // ------------------------------------------------------------------------------------ M4
  'm4-process-economics': {
    summary: 'Treat AI cost as a business-process question before it is a token question.',
    body: [
      "You have heard that AI lets teams build software faster than ever. True. But just because we can build it faster, should we? **Engineering activity is not the return.** The return shows up when improved engineering performance changes a business outcome.",
      "Most cost conversations stop at the model call, tokens in and tokens out. That is easy to measure, and it is the wrong denominator. A **business-process view** starts with what the process costs today in human hours and in calendar delay, the weeks a requirement sits waiting for an answer.",
      "**Define value before you build.** Microsoft's business-value guidance starts with success metrics, unit value and a baseline. For software delivery, measure value in concrete outcome units: a feature released, a vulnerability remediated, an incident resolved, an application migrated, or a customer workflow automated. Then ask three questions: What does this process cost now (X)? What would it cost with AI in it (Y)? What is the outcome worth (V)?",
      "**Aim at the highest friction first:** a requirements intake that takes weeks, a legacy analysis nobody wants to start, QA triage that eats a senior engineer's Monday. These are illustrations, not data from your organization.",
    ],
    reflect: 'Which of those three has the longest calendar delay in your organization today?',
  },

  'm4-executive-roi': {
    summary: 'A six-part executive ROI scorecard, a unit-cost formula and a trace protocol.',
    layout: 'split',
    splitCols: 'minmax(0, 0.92fr) minmax(0, 1fr)',
    body: [
      "**No single metric.** Microsoft Research's SPACE framework and GitHub's metrics guidance both warn that no single metric captures engineering productivity, so the slide balances six categories.",
      "**People.** Pair telemetry with short pulse surveys on focus, cognitive load and review fatigue. Never use agent telemetry to evaluate individual developers.",
      "**Economics.** Avoid the time-savings trap: claiming financial value from theoretical time savings with no chain of evidence to business outcomes. Saved hours count only when redirected to more outcomes, lower external spend or avoided hiring, or reinvested in tests, docs and security.",
      "**Net ROI** = (verified value + verified cost avoided − total agentic operating cost) ÷ total agentic operating cost, paired with FinOps unit economics: cost a unit such as a completed story, an accepted pull request or a release. The denominator is more than tokens: licenses, hosting, integration, human review, retries, governance and maintenance.",
    ],
    extra: {
      type: 'steps',
      title: 'Make the numbers hold up in a boardroom',
      items: [
        ['Baseline', 'Four to eight weeks of data, or the 90 days Microsoft Learn recommends, segmented by work complexity, repository, team, stack, legacy versus greenfield and risk tier.'],
        ['Compare', 'A pilot cohort against a comparison cohort on one or two repeatable workflows, never a naive before-and-after. Target a 20–30% cycle-time gain with zero quality or compliance loss.'],
        ['Trace', 'One trace ID from business request through work item, agent run, model and tool calls, commit, pull request, tests, evaluations, deployment and production result.'],
      ],
      foot: 'Never use lines of code, commits, prompts, tokens or acceptance rate as ROI, and do not scale from a demo without sustained production evidence.',
    },
    reflect: 'Which single repeatable workflow would you baseline and trace over the next 60 days?',
  },

  'm4-honest-tco': {
    summary: 'A realistic first-year total-cost expectation, including the adoption dip.',
    body: [
      "Every vendor pitch includes the license fee. In the Handbook's illustrative model, a ten-person team spends about $95,000–$249,000 in year one, and licenses are roughly a fifth to a quarter of that. It is an author's estimate from advisory work with early adopters, and your team size, region and codebase will move it. **The ratio is the point, not the dollars.**",
      "The rest is context engineering (engineering time rather than an invoice), token and compute spend, training and change management, governance setup, and the opportunity cost of the dip. A business case that shows only the license row is incomplete.",
      "**The adoption dip, in four phases:**",
      '- **Months 1–2, setup.** Impact is near zero or slightly negative.',
      '- **Months 2–4, the valley.** Rework runs higher than expected, developers hit the cliff on your specific codebase, and someone proposes restricting the tools to autocomplete.',
      '- **Months 4–6, inflection.** Cycle time starts to fall, modestly: around 15–25% on measurable tasks, again an author estimate.',
      '- **Months 6–12, compounding.** The Handbook treats this as a working hypothesis, not a settled result.',
      "**For leaders:** if rejection rates spike and engineers say the tool does not understand your codebase, that is context debt showing up, not a failed tool. Teams that quit in the valley never reach the compounding phase.",
    ],
    reflect: 'Where does your team feel it is on that curve?',
    allowNumbers: ['95000'],
    keepList: true,
  },

  'm4-cost-spread': {
    summary: 'Identical work can differ 8.5 times in cost, depending on workflow design.',
    body: [
      "Take one ordinary task: refactor 19 files to adopt a new error-handling convention, run two ways. In the first, the agent grinds through the files one at a time on a frontier model, re-reading context, re-planning and retrying after every failure. In the second, a designed workflow plans once, batches the edits, sends the mechanical work to a cheaper model and verifies at the end.",
      "**Same output, very different bill.** Nineteen files either way, and the tests pass either way. In the Handbook's illustrative run one path cost $41.01 and the other $4.81: an 8.5× spread, or 88.3% lower on the designed path. The Handbook is clear that these are single runs at point-in-time prices, not benchmarks. Treat them as an existence proof that variance can be engineered, not as a promised saving.",
      "**Your AI bill is a variance problem more than a price problem.** The Handbook borrows portfolio thinking: you do not manage a portfolio by its average, you manage it by its tail. A designed workflow bounds your worst case to the worst planned step. An undesigned one bounds it to nothing.",
      "**Why not let every developer optimize their own prompts?** The Handbook says no, for structural reasons: nobody should have to be a cost expert, nobody re-derives the cheap path on every prompt, and you cannot switch harness per task. Engineer it once, centrally, and everyone reuses the result. A small central AI team on gated frontier models codes the loops; everyone else runs them on baseline tiers. That is the cost-effective-loop factory.",
    ],
    reflect: 'If a $41 run and a $5 run of the same work landed on your bill, would anyone notice today?',
  },

  'm4-prompt-debugger': {
    summary: 'The four levers behind the gap in prompt cost, and the assumptions behind the model.',
    layout: 'split',
    splitCols: 'minmax(0, 0.74fr) minmax(0, 1fr)',
    body: [
      "The lever model on this slide is an illustrative teaching device, not a price quote. It is tuned so that, with every lever on, it lands near the Handbook's $4.81 run.",
      "- **1. Scope context.** A flat dump of thousands of lines loads on every turn, relevant or not. Load only what the step needs and you pay for fewer tokens on every call.",
      "- **2. Stable prefix.** A header that changes every run, such as a timestamp or a reordered tool list, defeats the cache. Keep the stable part first and untouched, and repeat turns bill it at a fraction of full input.",
      "- **3. Tool subset.** Dozens of tools on every turn are a token tax and widen the error surface. Expose only what the step needs.",
      "- **4. Routed models and turns.** The Handbook calls routing mechanical work to a frontier model the most common way teams overpay. Give each stage the smallest model class it needs, and cap retries.",
      "Nobody should hand-tune this per prompt. Bake it into shared skills so everybody inherits it.",
    ],
    extra: { type: 'assumptions', title: 'Illustrative model assumptions' },
    reflect: 'Which lever would save you the most today?',
  },

  // ------------------------------------------------------------------------------------ M5
  'm5-time-shift': {
    summary: 'Where engineer time moves when agents write the first draft.',
    body: [
      "Cheaper, faster generation sounds like pure upside until you ask what happens to the rest of the week. The Handbook's projection, based on author observation and early-adopter reports rather than a survey, is that **writing code stops being the biggest slice**. The time moves into specification, into review, and into a brand-new activity, **context engineering**. On the slide, writing code falls from about 32% to about 12% of engineer time, spec and design and code review each rise from about 12% to about 22%, and context engineering appears at about 12%.",
      "These are independent estimates per activity and they do not sum to 100%, so read each pair of bars on its own.",
      "**Reviewing agent output is harder, not easier**, according to the Handbook, because the output comes from a statistical process. The code can have clean syntax and passing tests and still be quietly wrong about intent. Review skill becomes a core competency.",
      "Speed up generation without redesigning intake and review, and you pile up unmerged work.",
    ],
    reflect: "Where do your senior engineers' hours go in a normal week now?",
  },

  'm5-whack-a-mole': {
    summary: 'Where the delivery constraint resurfaces once generation speeds up.',
    body: [
      "Speed up the build step and the constraint pops up somewhere else: the whack-a-mole that practitioners describe. It surfaces in three places.",
      "- **Upstream, intake starves.** Product cannot produce development-ready specs as fast as agents can consume them. The fixes live on the spec side: size the work before it enters the pipeline, and ground the spec in what the legacy system actually does rather than what the ticket claims.",
      "- **In the middle, review drowns.** Reviewers face plausible diffs at volume. The Handbook has two rules: *one file, one agent, per wave*, so agents never collide on the same file, and a *retry budget*: after two failed dispatches, decompose, add context or escalate. Its anti-pattern list names a symptom you may recognize, a three-dispatch task that quietly burns fifteen.",
      "- **Downstream, QA lags.** Run your automated test suites outside the agent, deterministically, and never take the agent's word that the tests pass. Check the git diff and the CI exit code, and prove a new test can fail before you trust that it passes.",
    ],
    reflect: 'Which constraint hurts most in your organization right now: intake, review or QA?',
  },

  'm5-junior-senior-shift': {
    summary: 'How engineering roles evolve under agentic delivery while judgment stays human.',
    body: [
      "The same pressure changes jobs. The Handbook's framing is that adoption shifts the **proportion of time**, not which activities need human judgment.",
      "- **Senior engineers** go from the person who writes the hardest code to the person who shapes the system that writes it. The cases that reach a senior engineer get harder, not fewer, so their judgment is worth more.",
      "- **Tech leads** become owners of the feedback loop: which context gaps keep producing the same agent failure, and who fixes them. That ties straight back to the CoE.",
      "- **Junior engineers** are the sensitive case. If agents take the tasks juniors used to learn on, how do juniors learn? The Handbook offers three models: review-intensive apprenticeship, agent-assisted learning with scaffolded complexity, and specification-first roles. It calls them informed hypotheses, and says no organization has run any of them for a full cycle of twelve months or more with measured results.",
      "Our suggestion: measure it, and pair every junior's agent work with a senior who reviews the reasoning as well as the output.",
    ],
    reflect: 'How do juniors on your teams learn the codebase today, and what has changed in the last six months?',
  },

  // ------------------------------------------------------------------------------------ M6
  'm6-security-gap': {
    summary: 'AI scanning as a budgeted complement to deterministic code security.',
    body: [
      "An established security stack stays in place; nothing here replaces it. The question is where Microsoft and GitHub capabilities add something you do not have, and what they cost.",
      "- **Layer 1: CodeQL, deterministic.** Results stay identical until you upgrade the query pack or the CLI, so you can run it on every pull request without arguing about the output. It supports C and C++, C#, Go, Java and Kotlin, JavaScript and TypeScript, Python, Ruby, Rust, Swift and Actions. Secret scanning is a separate feature that blends pattern-based and AI-powered detection, so it is not purely deterministic.",
      "- **Layer 2: AI Scan, in two modes.** For repositories (public preview): an on-demand scan of the default branch in any language, with detection steps bounded at 30 minutes and 150,000 Code Security AI credits, governed through SKU budgets. For pull requests (generally available since mid-October 2026): runs automatically on eligible updates for selected languages and frameworks that CodeQL does not cover, such as PHP and Terraform. Findings are advisory and do not enforce merge blocks.",
      "- **Layer 3: Copilot Autofix.** Suggested fixes for CodeQL alerts. Standard Autofix does not consume AI credits; the agentic version runs end-to-end sessions that do consume credits and Actions minutes. GitHub's guidance: outputs are non-deterministic, subtle logic flaws and complex multi-file dataflow remain limitations, and a human must review and test before merge.",
      "**Cost rule.** Scope AI scans to high-risk paths first, such as authentication, payments and data boundaries. Compare what they find against what they cost in credits, then widen. Statuses and credit limits reflect GitHub's documentation in November 2026; confirm current terms in the linked pages.",
    ],
    reflect: "Which languages or frameworks in your estate fall outside CodeQL's list? That is where a pull-request scan is worth a pilot.",
  },

  'm6-two-computers': {
    summary: 'Where model proposals meet deterministic gates.',
    body: [
      "Handbook Chapter 16 argues that **where you place the seam**, not the choice of model, the size of the context window or the elegance of the prompt, is the most important architectural decision in any agentic design. *The model proposes; the gate disposes.*",
      "**Two computers running in lockstep.** The deterministic one is the machine you already know how to run: tests, lockfiles, API calls, audit logs. When it fails, it fails loudly. The probabilistic one is the model. When it fails, it fails quietly: in the Handbook's words, confident, plausible, wrong. Anything consequential has to happen on the deterministic side.",
      "**Strong-form supervised execution makes that real.** The substrate denies the agent direct authority over protected effects such as merging to trunk or shipping to production. The agent emits a structured proposal; a deterministic stage validates the schema, checks an allowlist, logs the audit trail and applies the effect. *Weak-form* supervision is a prompt asking the agent to behave, which the Handbook considers adequate on a laptop, where a bad step is easy to revert, but not for anything consequential.",
      "**Two real implementations.** *Branch-scoped writes without merge authority:* GitHub's Copilot cloud agent runs with restricted credentials and pushes only to one permitted branch, either a new copilot-prefixed branch or the existing pull request's branch. It cannot mark its draft ready, approve or merge. *A read-only agent with separate execution jobs:* in GitHub Agentic Workflows, safe-outputs keep the agent job read-only; it emits structured requests, and separate permission-controlled jobs execute what is permitted, gated on human review or run under policy.",
      "The Handbook's illustration: an agent filed an issue for a customer that did not exist, because it held the write token and nothing checked the name. A better model would not have fixed that; a gate would have.",
    ],
    reflect: 'Does any agent in your environment hold a credential it could use to merge or deploy?',
  },

  // ------------------------------------------------------------------------------------ M7
  'm7-anti-patterns': {
    summary: 'A shared vocabulary for six common agentic failures, and how to recover from each.',
    body: [
      "The Handbook lists nineteen anti-patterns. These six are the ones to watch for first; the numbers in brackets are the Handbook's own.",
    ],
    extra: {
      type: 'table',
      head: ['Anti-pattern', 'What goes wrong', 'Recovery'],
      widths: ['25%', '33%', '42%'],
      rows: [
        ['**Monolithic prompt** (#1)', 'One giant instruction file that does everything.', 'Break it into scoped instruction files plus skills that load on demand.'],
        ['**Trust fall** (#7)', 'Agent self-reports are generated text, not system logs.', 'Run the test suite and verify file state with git diff.'],
        ['**Same-file collisions** (#8)', 'Two agents edit one file in parallel.', 'Apply the one-file-one-agent rule per wave.'],
        ['**Unfixed primitives** (#10)', 'An agent makes the same mistake twice.', 'Patch the instruction or the skill, not just the diff, or the mistake comes back tomorrow.'],
        ['**Almost-done trap** (#15)', 'The agent is 90% there and the loop drags on.', 'Accept and commit the 90%, then finish by hand or in a fresh session.'],
        ['**Cost runaway** (#14)', 'A three-dispatch task quietly consumes fifteen.', 'Use the retry budget: two failed dispatches, then change the approach.'],
      ],
    },
    reflect: 'Which of these six have you hit this week?',
  },

  'm7-roadmap': {
    summary: "The session's themes turned into one 90-day starting plan.",
    body: [
      "Take this plan as a suggested starting point, not a Handbook prescription, and adapt it. Microsoft's Cloud Adoption Framework says to integrate with an existing center of excellence where you can, and to plan the move from hands-on building to advisory guardrails.",
    ],
    extra: {
      type: 'cards',
      items: [
        {
          tag: 'Days 1–30',
          title: 'Charter',
          bullets: [
            'Charter a time-boxed enabling CoE. At least six to twelve months is the realistic enterprise window, so write the shift to advisory guardrails into the charter on day one.',
            'Put numbers on three process costs, using the X, Y and V questions from slide 11, so that in 90 days you can show something other than activity.',
            'Lock the gates: the agent never holds the merge or deploy credential.',
          ],
        },
        {
          tag: 'Days 31–60',
          title: 'Metrics',
          bullets: [
            'Change what you report. Move the dashboard off activity counts and onto merge confidence and rework: that is where leadership gets a number that means something.',
            'Ship the first loops engineered for cost. Pick recurring, ROI-positive tasks and bake in the prefix, the tool subset and the model routing so everybody inherits them.',
          ],
        },
        {
          tag: 'Days 61–90',
          title: 'Scale',
          bullets: [
            'Add golden datasets so quality does not silently degrade when a prompt or skill changes.',
            'Pilot AI scanning with a budget. Start narrow: one product, one high-risk path, one pull-request scan and a credit budget you can explain.',
          ],
        },
      ],
    },
    reflect: 'What would you need to start Monday, and who would own it?',
  },

  'm7-maturity-dimensions': {
    summary: 'Assess organizational readiness across six dimensions of agentic maturity.',
    body: [
      "These six dimensions measure maturity once you are past the first 90 days. They pair six engineering maturity questions with Microsoft Learn's Agentic AI Adoption Maturity Model, which runs from Level 100 (Initial) to Level 500 (Efficient). Its how-to-use guidance says to **plot maturity as a radar profile and never collapse it into a single score**, because a single score hides the recessed spokes that show where scaling will break next. The profile on the slide is illustrative, not your data.",
      "**Rows 1–3, adoption and readiness.** Is AI use limited to the people writing code, or do product, design, QA and security use it too? Could an agent work in your repositories, architecture docs and test harnesses without help from whoever remembers the history? What share of eligible work actually runs through agentic workflows? Seat utilization is only a leading indicator: it tells you whether the investment has a chance to create value, not whether value was created.",
      "**Row 4, operations.** This matters most for site-reliability and incident agents. Measure the full loop: signal, diagnosis, proposed remediation, validation, approval, deployment, verified recovery and preventive learning, where incident findings turn into durable tests or controls. Judge an SRE agent by whether it shortens time to safe recovery and prevents recurrence, not by how many recommendations it generates.",
      "**Rows 5–6, where speed and trust pull against each other.** Team autonomy asks whether dependencies and manual handoffs still slow teams down after coding speeds up. Responsible AI asks which non-negotiables stay in place: audit provenance, secret protection, least-privilege access and human sign-off on sensitive paths. Agent autonomy should be earned by demonstrated performance inside guardrails; zero human touch is never the goal when policy requires a gate.",
    ],
    reflect: 'Which of the six rows is your organization strongest on today, and which recessed spoke needs investment next?',
  },

  'm7-quiz': {
    summary: "A self-check: apply the session's decisions to three fresh scenarios.",
    body: ['Try each scenario before you read the recommended answer.'],
    extra: {
      type: 'cards',
      items: [
        {
          tag: 'Scenario 1',
          title: 'The board metric',
          body: 'AI-generated lines of code are up, and someone wants to put that in the quarterly deck. Which measure would you rather defend?',
          options: ['Acceptance rate', 'Time-to-confident-merge', 'Seat count'],
          answer: 1,
          explain: 'Lines and acceptance rates tell you the tool is busy. Seat counts tell you it is licensed. A reviewer approving without reservations tells you the work is landing.',
        },
        {
          tag: 'Scenario 2',
          title: 'The bill',
          body: 'Sixty-five tools load on every single turn. Which lever do you pull?',
          options: ['Tool subset', 'Model router', 'Bigger window'],
          answer: 0,
          explain: 'A bigger window does not make the model pay attention to more, and a router helps pick a model, not shrink the tool list.',
        },
        {
          tag: 'Scenario 3',
          title: 'The build',
          body: 'Tests are green, the lint is clean, and the agent built the wrong feature. Which gate catches it?',
          options: ['More tests', 'Design checkpoint', 'Lint'],
          answer: 1,
          explain: 'More tests and stricter lint verify form, not intent. If the failure you fear is goal drift, the test suite is theater.',
        },
      ],
    },
    reflect: 'Which of the three surprised you, and which would you run on your own team first?',
  },

  'm7-open-floor': {
    summary: 'Questions from every role, a closing thought for leadership, and four common questions answered.',
    body: [
      "The floor is open to every seat, from leadership to DevOps. The three prompts on the slide are starters. Bring the question you would hesitate to raise in a steering meeting.",
      "**A closing thought for leadership.** The goal of an agentic SDLC is to improve the organization's ability to turn an idea into a safe, valuable, supportable production outcome, proven with a baseline, an end-to-end trace, balanced measures of speed and quality, and unit economics. A workflow should scale only after it shows repeatable value without shifting cost or risk downstream.",
    ],
    extra: {
      type: 'faq',
      title: 'Four common questions',
      items: [
        ['How big should the CoE be?', 'Start small and time-boxed. The Handbook describes a small central AI team and treats these roles as specializations that existing team members grow into. Size the team to the work that exists, not to a target head count.'],
        ['How do we measure ROI on brownfield modernization?', 'Baseline the process first. Expect a dip and then compounding (the adoption curve on slide 13). Measure rework and time-to-confident-merge rather than lines of code.'],
        ['How do we prevent review fatigue?', 'Cut work into thin slices, keep to one file per agent, set a two-round retry budget, put an independent reviewer ahead of the human reviewer, and use risk-tiered review for sensitive paths.'],
        ['Frontier models or fast models?', 'Route by stage: a heavy planner, a mid-tier executor and a lightweight triage model. Gate frontier access to a small central team, with a metered escape hatch for tasks that truly need it.'],
      ],
    },
  },
};

// ------------------------------------------------------------------------------------ glossary

/** The reader-facing glossary categories, in order. Each lists the raw `group` values (src/content/glossary.ts) it absorbs. */
export const GLOSSARY_CATEGORIES = [
  { id: 'prose', title: 'PROSE & Context', groups: ['prose'] },
  { id: 'primitives', title: 'Primitives & Supply Chain', groups: ['primitives'] },
  { id: 'operating-model', title: 'Operating Model & Governance', groups: ['operating-model', 'governance'] },
  { id: 'metrics', title: 'Metrics & Quality Gates', groups: ['metrics', 'quality'] },
  { id: 'economics', title: 'Process & Prompt Economics', groups: ['economics'] },
  { id: 'security', title: 'Security & Guardrails', groups: ['security'] },
];

export const GLOSSARY_INTRO =
  'Plain-language definitions of the {count} terms used in the session, each with its source and the slides where it appears.';

export const GLOSSARY_FOOTNOTE =
  '\u2020 Handbook author estimate or projection, not survey data or a controlled study. Definitions are plain-language summaries; the cited source is authoritative.';
