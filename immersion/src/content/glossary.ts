/**
 * AI-DLC and PROSE glossary: the terms behind the `C` Cheat Sheet overlay.
 *
 * Every definition is grounded in the verified claims behind the cited sources (C01-C18). Entries
 * flagged `paraphrase` are plain-language glosses of a named concept rather than quoted wording;
 * re-check them against the cited chapter before the script is final. Dollar figures are omitted
 * on purpose, and author estimates keep their dagger.
 *
 * Statuses that can change over time (AI Scan, Autofix) reflect the docs as of 2026-11-09;
 * re-check them before each delivery.
 */

import type { GlossaryEntry, Source } from './types';

const HB = 'https://danielmeppiel.github.io/agentic-sdlc-handbook/handbook/';
const hb = (label: string, file: string): Source => ({ label, url: `${HB}${file}.html` });

const CH01 = hb('Handbook Ch 1', 'ch01-the-agentic-sdlc-thesis');
const CH03 = hb('Handbook Ch 3', 'ch03-the-business-case');
const CH04 = hb('Handbook Ch 4', 'ch04-the-reference-architecture');
const CH05 = hb('Handbook Ch 5', 'ch05-governance-for-ai-assisted-delivery');
const CH06 = hb('Handbook Ch 6', 'ch06-team-structures');
const CH07 = hb('Handbook Ch 7', 'ch07-the-agentic-sdlc-bill');
const CH08 = hb('Handbook Ch 8', 'ch08-planning-the-transition');
const CH12 = hb('Handbook Ch 12', 'ch12-the-instrumented-codebase');
const CH13 = hb('Handbook Ch 13', 'ch13-the-prose-specification');
const CH16 = hb('Handbook Ch 16', 'ch16-deterministic-probabilistic-boundary');
const CH17 = hb('Handbook Ch 17', 'ch17-multi-agent-orchestration');
const CH19 = hb('Handbook Ch 19', 'ch19-architectural-patterns-rosetta-stone');
const CH20 = hb('Handbook Ch 20', 'ch20-anti-patterns-and-failure-modes');
const LIU: Source = { label: 'Liu et al., TACL 2024', url: 'https://arxiv.org/abs/2307.03172' };
const CAF_COE: Source = {
  label: 'Microsoft CAF: AI Center of Excellence',
  url: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/ai/center-of-excellence',
};
const CAF_GOVERN: Source = {
  label: 'Microsoft CAF: Govern AI',
  url: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ai/govern',
};
const GH_CODEQL: Source = {
  label: 'GitHub Docs: CodeQL code scanning',
  url: 'https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning',
};
const GH_AISCAN: Source = {
  label: 'GitHub Docs: AI Scan',
  url: 'https://docs.github.com/en/code-security/concepts/code-scanning/ai-scan',
};
const GH_AUTOFIX: Source = {
  label: 'GitHub Docs: Autofix for code scanning',
  url: 'https://docs.github.com/en/code-security/concepts/code-scanning/autofix-for-code-scanning',
};
const GH_AW: Source = { label: 'gh-aw safe outputs', url: 'https://github.github.io/gh-aw/reference/safe-outputs/' };
const MS_ROI: Source = {
  label: 'Microsoft Learn: Measure the impact of your agents',
  url: 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-measure-impact',
};
const MS_SPACE: Source = {
  label: 'Microsoft Research: The SPACE of Developer Productivity',
  url: 'https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/',
};
const MS_MATURITY: Source = {
  label: 'Microsoft Learn: Agentic AI adoption maturity model',
  url: 'https://learn.microsoft.com/en-us/agents/adoption-maturity-model/',
};
const DORA_2025: Source = {
  label: '2025 DORA Report: State of AI-Assisted Software Development',
  url: 'https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report',
};

export const glossary: GlossaryEntry[] = [
  // ---------------------------------------------------------------- PROSE
  {
    id: 'prose',
    term: 'PROSE',
    group: 'prose',
    definition:
      'The Handbook\u2019s five constraints for agentic work: Progressive Disclosure, Reduced Scope, Orchestrated Composition, Safety Boundaries, and Explicit Hierarchy. The first three are direct levers on attention.',
    aliases: ['constraints', 'five constraints'],
    slides: ['m1-attention-economy'],
    source: CH13,
  },
  {
    id: 'progressive-disclosure',
    term: 'Progressive Disclosure',
    group: 'prose',
    definition: 'Load the instructions and context for the module you are touching and nothing else, instead of everything at once.',
    slides: ['m1-attention-economy', 'm4-prompt-debugger'],
    source: CH13,
    paraphrase: true,
  },
  {
    id: 'reduced-scope',
    term: 'Reduced Scope',
    group: 'prose',
    definition: 'Give an agent a smaller task, so less has to stay in focus at once.',
    slides: ['m1-attention-economy'],
    source: CH13,
    paraphrase: true,
  },
  {
    id: 'orchestrated-composition',
    term: 'Orchestrated Composition',
    group: 'prose',
    definition: 'Hand sub-tasks to fresh agents with clean context windows, then combine what they return.',
    slides: ['m1-attention-economy'],
    source: CH13,
    paraphrase: true,
  },
  {
    id: 'safety-boundaries',
    term: 'Safety Boundaries',
    group: 'prose',
    definition: 'Limits that keep agent work safe and predictable, such as constraining what an agent may change.',
    slides: ['m1-attention-economy'],
    source: CH13,
    paraphrase: true,
  },
  {
    id: 'explicit-hierarchy',
    term: 'Explicit Hierarchy',
    group: 'prose',
    definition: 'Instructions organized in clear, named levels rather than one flat pile.',
    slides: ['m1-attention-economy'],
    source: CH13,
    paraphrase: true,
  },
  {
    id: 'context-rot',
    term: 'Context rot (lost in the middle)',
    group: 'prose',
    definition:
      'Accuracy is highest when the relevant fact sits at the start or end of the context and drops significantly when it is buried in the middle, even for long-context models.',
    aliases: ['attention curve', 'u-shaped', 'lost in the middle'],
    slides: ['m1-attention-economy'],
    source: LIU,
  },
  {
    id: 'vibe-coding-cliff',
    term: 'Vibe coding cliff',
    group: 'prose',
    definition:
      'A greenfield demo succeeds because there is no legacy to respect; a brownfield codebase has unwritten conventions that overflow any window. The ~30\u201360% rework figure is the Handbook author\u2019s estimate, not a controlled study.',
    aliases: ['greenfield', 'brownfield'],
    slides: ['m1-vibe-cliff'],
    source: CH01,
  },

  // ---------------------------------------------------------------- primitives and supply chain
  {
    id: 'agentic-supply-chain',
    term: 'Agentic supply chain',
    group: 'primitives',
    definition:
      'Five layers, bottom to top: Platform, Context & Capabilities, Governance & Distribution, Agent Harness, and SDLC Phases. Standardize below the harness and tools can change without losing your assets.',
    aliases: ['five layers', 'L1', 'L2', 'L3', 'L4', 'L5'],
    slides: ['m2-supply-chain'],
    source: CH04,
  },
  {
    id: 'seven-primitives',
    term: 'Seven primitives',
    group: 'primitives',
    definition:
      'Versioned files that steer agents: instructions, agents, skills, prompts, memory, orchestration specs, and hooks. They ship like internal packages.',
    aliases: ['.instructions.md', '.agent.md', 'SKILL.md', '.prompt.md', '.memory.md', '.spec.md', 'hooks'],
    slides: ['m2-supply-chain'],
    source: CH12,
  },
  {
    id: 'agent-harness',
    term: 'Agent harness',
    group: 'primitives',
    definition: 'The runtime that executes agents: layer 4 of the supply chain.',
    slides: ['m2-supply-chain'],
    source: CH04,
    paraphrase: true,
  },
  {
    id: 'context-engineering',
    term: 'Context engineering',
    group: 'primitives',
    definition:
      'The new activity of deciding what an agent sees, and where. The Handbook projects it growing from about 0% to about 12% of engineer time (author projection\u2020, not survey data).',
    slides: ['m5-time-shift'],
    source: CH06,
  },

  // ---------------------------------------------------------------- operating model
  {
    id: 'coe',
    term: 'AI Center of Excellence (CoE)',
    group: 'operating-model',
    definition:
      'A small, time-boxed enabling team that encodes reusable workflows and coaches other teams, then moves to advisory guardrails so it never becomes an approval bottleneck.',
    aliases: ['CoE', 'center of excellence', 'enabling team'],
    slides: ['m2-hero-trap'],
    source: CAF_COE,
  },
  {
    id: 'hero-pilot',
    term: 'Hero pilot',
    group: 'operating-model',
    definition: 'An anti-pattern: a few top builders succeed on a friendly project, but nothing they learn transfers because it lives in their heads.',
    slides: ['m2-hero-trap'],
    source: CH08,
  },
  {
    id: 'enabling-team',
    term: 'Enabling team',
    group: 'operating-model',
    definition: 'A small team with a finite lifespan that helps stream-aligned teams adopt agentic practices and writes those practices down.',
    slides: ['m2-hero-trap'],
    source: CH06,
  },
  {
    id: 'domain-specialist',
    term: 'Domain Specialist (WHAT)',
    group: 'operating-model',
    definition: 'Owns the procedure, business rules, success criteria, and eval that a skill encodes. Not always an engineer.',
    slides: ['m2-three-roles'],
    source: CH06,
  },
  {
    id: 'agentic-workflow-engineer',
    term: 'Agentic Workflow Engineer (HOW)',
    group: 'operating-model',
    definition: 'Owns how a skill is built and composed, including PROSE-level composition and eval scaffolding.',
    slides: ['m2-three-roles'],
    source: CH06,
  },
  {
    id: 'agent-operations-specialist',
    term: 'Agent Operations Specialist (OPERATIONS)',
    group: 'operating-model',
    definition: 'Emerges at scale to own cost, traces, eval drift, and rate limits. Do not staff it before the work exists.',
    slides: ['m2-three-roles'],
    source: CH06,
  },

  // ---------------------------------------------------------------- governance
  {
    id: 'governance-checklist',
    term: 'Six-capability governance checklist',
    group: 'governance',
    definition:
      'Audit trails, agent access controls, approval workflows, data boundaries, cost controls, and compliance reporting, each scored None, Basic, or Enterprise. Audit trails and access controls come first.',
    aliases: ['scorecard', 'readiness'],
    slides: ['m2-governance-matrix'],
    source: CH05,
  },
  {
    id: 'weak-form-supervision',
    term: 'Weak-form supervision',
    group: 'governance',
    definition: 'A human reviews what the agent produced, after the fact. The Basic floor.',
    slides: ['m2-governance-matrix'],
    source: CH05,
  },
  {
    id: 'strong-form-supervision',
    term: 'Strong-form supervision',
    group: 'governance',
    definition:
      'The action itself is gated when it executes: the agent never holds merge or deploy credentials, and a deterministic gate validates, logs, and applies the side effect. The Enterprise bar.',
    aliases: ['strong-form supervised execution'],
    slides: ['m2-governance-matrix', 'm6-two-computers'],
    source: CH16,
  },

  // ---------------------------------------------------------------- metrics and evals
  {
    id: 'time-to-confident-merge',
    term: 'Time-to-confident-merge',
    group: 'metrics',
    definition: 'How long until a reviewer approves a change without reservations. Hard to game, because a reviewer has to agree.',
    slides: ['m3-metric-evolution', 'm7-quiz'],
    source: CH03,
  },
  {
    id: 'review-rejection-rate',
    term: 'Review rejection rate',
    group: 'metrics',
    definition: 'How often agent work is sent back in review.',
    slides: ['m3-metric-evolution'],
    source: CH08,
    paraphrase: true,
  },
  {
    id: 'thirty-day-rework-rate',
    term: '30-day rework rate',
    group: 'metrics',
    definition: 'Changes that passed review but had to be reworked within thirty days.',
    slides: ['m3-metric-evolution'],
    source: CH08,
    paraphrase: true,
  },
  {
    id: 'defect-escape-rate',
    term: 'Defect escape rate',
    group: 'metrics',
    definition: 'How many defects reach production instead of being caught earlier.',
    slides: ['m3-metric-evolution'],
    source: CH04,
    paraphrase: true,
  },
  {
    id: 'cost-per-outcome',
    term: 'Cost per outcome',
    group: 'metrics',
    definition: 'What a delivered outcome costs, rather than what one model call costs.',
    slides: ['m3-metric-evolution'],
    source: CH07,
    paraphrase: true,
  },
  {
    id: 'golden-dataset',
    term: 'Golden dataset evaluation',
    group: 'metrics',
    definition: 'Testing quality against known-good answers, with independent review, instead of the model\u2019s opinion of itself.',
    aliases: ['evals', 'golden fixtures'],
    slides: ['m3-metric-evolution'],
    source: CAF_GOVERN,
  },
  {
    id: 'denominator-problem',
    term: 'Denominator problem',
    group: 'metrics',
    definition:
      'Writing code is roughly 20\u201335% of developer time, so a 50% reduction in coding time on 30% of the work saves 15% of the total, not 50%.',
    aliases: ['productivity paradox', 'quality discount', 'attribution problem'],
    slides: ['m3-productivity-paradox'],
    source: CH03,
  },
  {
    id: 'space-framework',
    term: 'SPACE framework',
    group: 'metrics',
    definition:
      'Five dimensions of developer productivity (Satisfaction and well-being, Performance, Activity, Communication and collaboration, Efficiency and flow). Productivity cannot be captured by a single metric.',
    aliases: ['satisfaction', 'cognitive load', 'review fatigue'],
    slides: ['m4-executive-roi'],
    source: MS_SPACE,
  },
  {
    id: 'dora-amplifier',
    term: 'AI as an organizational amplifier (DORA 2025)',
    group: 'metrics',
    definition:
      'The 2025 DORA report finds that AI magnifies an organization\u2019s existing strengths and weaknesses, increasing throughput while continuing to pressure delivery stability unless automated testing, version control, and fast feedback loops are in place.',
    aliases: ['dora', 'stability', 'amplifier'],
    slides: ['m3-productivity-paradox', 'm4-executive-roi', 'm7-maturity-dimensions'],
    source: DORA_2025,
  },
  {
    id: 'executive-roi-scorecard',
    term: 'Executive ROI balanced scorecard & unit economics',
    group: 'economics',
    definition:
      'Six executive measurement categories (Business value, Flow, Quality, Reliability and risk, People and adoption, Economics) paired with net ROI = (verified value + cost avoided \u2212 total operating cost) \u00f7 total operating cost and unit cost per delivered outcome.',
    aliases: ['roi', 'unit economics', 'balanced scorecard', 'time-savings trap'],
    slides: ['m4-executive-roi'],
    source: MS_ROI,
  },
  {
    id: 'six-dimensions-maturity',
    term: 'Six dimensions of maturity',
    group: 'operating-model',
    definition:
      'Delivery practices, Agent-ready codebase, Agent utilization, Operations, Team autonomy & enablement, and Responsible AI\u2014plotted as a multi-axis radar profile (Level 100 Initial to Level 500 Efficient) rather than collapsed into a single score.',
    aliases: ['maturity model', 'radar', 'operations', 'sre agent'],
    slides: ['m7-maturity-dimensions'],
    source: MS_MATURITY,
  },

  // ---------------------------------------------------------------- quality gates and failure modes
  {
    id: 'quality-gate-matrix',
    term: '2\u00d72 quality gate matrix',
    group: 'quality',
    definition:
      'Verification along two axes: who renders the verdict (internal to the agent process or external to it) and how (a programmatic check or a judgement call).',
    aliases: ['gates', 'programmatic', 'judgement', 'internal', 'external'],
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'programmatic-internal',
    term: 'Programmatic-internal',
    group: 'quality',
    definition: 'Schema validation, lint, type checks, unit tests, and grounded lookups that run inside the agent\u2019s own process.',
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'judgement-internal',
    term: 'Judgement-internal',
    group: 'quality',
    definition: 'A goal-steward thread re-reads the spec and asks whether the work is still on goal.',
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'programmatic-external',
    term: 'Programmatic-external',
    group: 'quality',
    definition: 'An independent CI test runner or fresh-context cold reader applying a deterministic rubric outside the agent\u2019s process.',
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'judgement-external',
    term: 'Judgement-external',
    group: 'quality',
    definition: 'A human checkpoint: review, approval, or sign-off.',
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'goal-drift',
    term: 'Goal drift',
    group: 'quality',
    definition: 'Tests green, lint clean, and the agent built the wrong feature. \u201cIf the failure mode you fear is goal drift, the test suite is theater.\u201d',
    aliases: ['test theater'],
    slides: ['m3-gate-matrix', 'm7-quiz'],
    source: CH16,
  },
  {
    id: 'grounded-lookup',
    term: 'Grounded lookup',
    group: 'quality',
    definition: 'Checking a claim against the system of record instead of reading prose. It catches invented facts, such as a customer that does not exist.',
    slides: ['m3-gate-matrix'],
    source: CH16,
  },
  {
    id: 'trust-fall',
    term: 'The Trust Fall (#7)',
    group: 'quality',
    definition: '\u201cAgent self-reports are generated text, not system logs.\u201d Run the test suite and verify file state with git diff instead of taking the agent\u2019s word.',
    slides: ['m5-whack-a-mole', 'm7-anti-patterns'],
    source: CH20,
  },
  {
    id: 'one-file-one-agent',
    term: 'One-File-One-Agent rule',
    group: 'quality',
    definition: 'Within a wave, no two agents edit the same file, so parallel agents never collide.',
    slides: ['m5-whack-a-mole', 'm7-anti-patterns'],
    source: CH17,
  },

  // ---------------------------------------------------------------- process and prompt economics
  {
    id: 'year-1-tco',
    term: 'Year-1 total cost',
    group: 'economics',
    definition:
      'Six components: tool licenses (about 20\u201325%\u2020 of the total), context engineering, token and compute spend, training and change management, governance setup, and the opportunity cost of the adoption dip. Author estimates for a ten-person team.',
    slides: ['m4-honest-tco'],
    source: CH03,
  },
  {
    id: 'adoption-j-curve',
    term: 'Adoption J-curve (the valley)',
    group: 'economics',
    definition:
      'Expect 60\u201390 days of slower delivery: months 1\u20132 setup, 2\u20134 the valley, 4\u20136 inflection, 6\u201312 compounding. Teams that quit in the valley never reach compounding.',
    slides: ['m4-honest-tco'],
    source: CH03,
  },
  {
    id: 'variance-not-price',
    term: 'Variance, not price',
    group: 'economics',
    definition:
      'Cost control is mainly a variance-reduction problem, not a unit-price problem. In the Handbook\u2019s illustrative run, the same 19-file refactor cost $41.01 undesigned and $4.81 designed: an 8.5\u00d7 spread on a single run, not a benchmark.',
    slides: ['m4-cost-spread'],
    source: CH07,
  },
  {
    id: 'cost-effective-loop-factory',
    term: 'Cost-effective-loop factory',
    group: 'economics',
    definition: 'A small central AI team on gated frontier models encodes reusable loops that everyone else runs on baseline tiers.',
    slides: ['m4-cost-spread', 'm4-prompt-debugger'],
    source: CH07,
  },
  {
    id: 'model-router',
    term: 'Model Router',
    group: 'economics',
    definition: 'Send each task to the model class it needs instead of sending everything to a frontier model.',
    slides: ['m4-prompt-debugger'],
    source: CH19,
    paraphrase: true,
  },
  {
    id: 'gradient-workflow',
    term: 'Gradient Workflow',
    group: 'economics',
    definition: 'A frontier planner, a mid-tier executor, and a lightweight triage model, with a metered frontier escape hatch.',
    slides: ['m4-prompt-debugger'],
    source: CH19,
  },
  {
    id: 'cache-aware-prefix',
    term: 'Cache-Aware Prefix',
    group: 'economics',
    definition: 'Keep mutable content out of the head of the prompt so the stable prefix bills at cached input rates on repeat turns.',
    slides: ['m4-prompt-debugger'],
    source: CH19,
  },
  {
    id: 'tool-subset',
    term: 'Tool Subset',
    group: 'economics',
    definition: 'Expose only the tools the current step needs instead of loading dozens on every turn.',
    slides: ['m4-prompt-debugger', 'm7-quiz'],
    source: CH19,
    paraphrase: true,
  },
  {
    id: 'retry-budget',
    term: 'Retry budget',
    group: 'economics',
    definition: 'After two failed dispatches, decompose the task, add context, or escalate. It stops Cost Runaway (#14), where a three-dispatch task quietly burns fifteen.',
    aliases: ['turn budget', 'cost runaway'],
    slides: ['m5-whack-a-mole', 'm7-anti-patterns'],
    source: CH20,
  },

  // ---------------------------------------------------------------- security and guardrails
  {
    id: 'codeql',
    term: 'CodeQL',
    group: 'security',
    definition: 'Deterministic semantic code analysis: identical results until the query pack or CLI version changes.',
    slides: ['m6-security-gap'],
    source: GH_CODEQL,
  },
  {
    id: 'ai-scan',
    term: 'AI Scan',
    group: 'security',
    definition:
      'Complements CodeQL. For repositories: public preview. For pull requests: generally available; findings are advisory and do not block merges. AI output is non-deterministic, so humans review and test.',
    aliases: ['AI-powered security detections'],
    slides: ['m6-security-gap'],
    source: GH_AISCAN,
  },
  {
    id: 'copilot-autofix',
    term: 'Copilot Autofix',
    group: 'security',
    definition: 'Suggests fixes for CodeQL alerts. Humans review and test before merging.',
    slides: ['m6-security-gap'],
    source: GH_AUTOFIX,
  },
  {
    id: 'two-computers',
    term: 'Two computers, one program',
    group: 'security',
    definition:
      '\u201cThe model proposes; the gate disposes.\u201d Deterministic computers fail loudly and probabilistic models fail quietly, so the seam between them is the most important architectural decision.',
    slides: ['m6-two-computers'],
    source: CH16,
  },
  {
    id: 'the-seam',
    term: 'The seam',
    group: 'security',
    definition: 'Where a model\u2019s structured proposal meets deterministic gates: schema validation, an allowlist filter, an audit log, and immutable post-steps.',
    slides: ['m6-two-computers'],
    source: CH16,
  },
  {
    id: 'safe-outputs',
    term: 'gh-aw safe-outputs',
    group: 'security',
    definition: 'The read-only agent job emits structured output requests; separate permission-controlled jobs apply the permitted actions.',
    slides: ['m6-two-computers'],
    source: GH_AW,
  },
];
