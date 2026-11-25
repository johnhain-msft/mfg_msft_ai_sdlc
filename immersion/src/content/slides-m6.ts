/**
 * Module 6: security tooling and guardrails (slides 18-19).
 */

import { costMeter, seamDiagram } from '../diagrams/m6';
import { cite } from './sources';
import type { Slide } from './types';

export const m6: Slide[] = [
  // ---- 18 ---------------------------------------------------------------------------------
  {
    id: 'm6-security-gap',
    moduleCode: 'M6',
    presenter: 'John',
    layout: 'defense-stack',
    purpose: 'Position AI scanning as a budgeted complement to deterministic code security.',
    kicker: 'Guardrails',
    title: 'Layered security, budgeted AI',
    blocks: [
      {
        kind: 'card',
        head: 'CodeQL',
        body: 'Deterministic analysis: identical results until query pack or CLI version changes.',
        key: 'codeql',
        tone: 'green',
        icon: 'code',
      },
      {
        kind: 'card',
        head: 'AI Scan',
        body: 'Repositories: Public preview. Pull requests: GA; advisory, no merge blocks.',
        key: 'ai-scan',
        tone: 'amber',
        icon: 'search',
      },
      {
        kind: 'card',
        head: 'Copilot Autofix',
        body: 'Suggests fixes for CodeQL alerts; humans review and test before merging.',
        key: 'autofix',
        tone: 'violet',
        icon: 'spark',
      },
      { kind: 'band', head: 'Cost rule', body: 'Start small, measure cost against coverage, then expand scope.', key: 'cost-rule', tone: 'azure' },
    ],
    diagram: costMeter,
    script: [
      {
        t: 'say',
        text: "Most enterprise teams already run an established security stack, and nothing I'm about to say replaces it. The question is where Microsoft and GitHub capabilities add something you don't have, and what they cost.",
      },
      {
        t: 'say',
        text: "Layer one is CodeQL, deterministic semantic analysis. GitHub documents that results stay identical until you upgrade the query pack or the CLI, which is why you can run it on every pull request without arguing about the output. It supports C and C++, C#, Go, Java and Kotlin, JavaScript and TypeScript, Python, Ruby, Rust, Swift, and Actions. Secret scanning is a separate feature, and it blends pattern-based and AI-powered detection, so don't file it under deterministic.",
      },
      {
        t: 'say',
        text: 'Layer two is AI Scan, in two modes. For repositories it is in public preview: an on-demand scan of the default branch in any language, with detection steps bounded at thirty minutes and 150,000 Code Security AI credits, governed through SKU budgets. For pull requests it is generally available, as of mid-October, and runs automatically on eligible updates for selected languages and frameworks that CodeQL does not cover, such as PHP and Terraform. Findings are advisory and do not enforce merge blocks.',
      },
      {
        t: 'say',
        text: "Layer three is Copilot Autofix, suggested fixes for CodeQL alerts. Standard Autofix does not consume AI credits. The agentic version runs end-to-end sessions that do consume credits and Actions minutes. GitHub's own guidance says outputs are non-deterministic, subtle logic flaws and complex multi-file dataflow remain limitations, and a human has to review and test before merge.",
      },
      {
        t: 'say',
        text: 'On cost, scope AI scans to high-risk paths first, like authentication, payments, and data boundaries. Compare what they find against what they cost in credits, then widen from there.',
      },
      { t: 'cue', kind: 'ask', text: "InfoSec and DevOps: which languages or frameworks in your estate fall outside CodeQL's list? That's where a pull-request scan is worth a pilot." },
      {
        t: 'cue',
        kind: 'note',
        text: 'Pre-flight before every delivery. Re-check both statuses and the credit limits in the GitHub docs; the AI Scan pages change often.',
      },
      { t: 'cue', kind: 'next', text: 'Scanners find problems after the fact. The bigger question is what the agent is allowed to do in the first place.' },
    ],
    sources: [
      cite('ghCodeql', 'C13'),
      cite('ghAiScan', 'C13'),
      cite('ghAiScanRepos', 'C13'),
      cite('ghAiDetections', 'C13'),
      cite('ghAiPrGa', 'C13'),
      cite('ghAutofix', 'C13'),
      cite('ghResponsible', 'C13'),
    ],
  },

  // ---- 19 ---------------------------------------------------------------------------------
  {
    id: 'm6-two-computers',
    moduleCode: 'M6',
    presenter: 'John',
    layout: 'seam-diagram',
    purpose: 'Establish the seam where model proposals meet deterministic gates.',
    kicker: 'Guardrails',
    title: 'Two computers, one program',
    blocks: [
      { kind: 'band', head: 'Strong-form supervision', body: 'The agent never holds merge or deploy credentials; gates run after its turn.', key: 'strong-form', tone: 'azure' },
      {
        kind: 'band',
        head: 'Where it exists today',
        body: 'Copilot cloud agent: one permitted branch. gh-aw safe-outputs: separate permissioned jobs apply requests.',
        key: 'today',
        tone: 'green',
      },
    ],
    diagram: seamDiagram,
    script: [
      {
        t: 'say',
        text: 'Chapter 16 of the Handbook says the placement of the seam, not the choice of model, not the size of the context window, not the elegance of the prompt, is the single most important architectural decision in any agentic design. The model proposes; the gate disposes.',
      },
      {
        t: 'say',
        text: "Think of two computers running in lockstep. The deterministic one is the machine you already know how to run: tests, lockfiles, API calls, audit logs. When it fails, it fails loudly. The probabilistic one is the model. When it fails, it fails quietly, in the Handbook's words: confident, plausible, wrong. Anything consequential has to happen on the deterministic side.",
      },
      {
        t: 'say',
        text: 'Strong-form supervised execution makes that real. The substrate denies the agent direct authority over protected effects like merging to trunk or shipping to production. The agent emits a structured proposal, and a deterministic stage validates the schema, checks an allowlist, logs the audit trail, and applies the effect. Weak-form is a prompt asking the agent to behave, which the Handbook considers adequate on a laptop, where a bad step is easy to revert, but not for anything consequential.',
      },
      { t: 'cue', kind: 'point', text: 'Hover or tab onto a station on the seam to light it: schema, allowlist, audit log. The red arrow is a rejected proposal going back to the model.' },
      {
        t: 'say',
        text: "Two real implementations show the two patterns. First, branch-scoped writes without merge authority. GitHub's Copilot cloud agent runs with restricted credentials and pushes only to one permitted branch, either a new copilot-prefixed branch or the existing pull request's branch. It cannot mark its draft ready, approve, or merge. Second, a read-only agent with separate execution jobs. GitHub Agentic Workflows has safe-outputs, where the agent job is read-only and emits structured requests, and separate permission-controlled jobs execute what is permitted, gated on human review or run under policy.",
      },
      {
        t: 'say',
        text: "The Handbook's illustration is an agent that filed an issue for a customer that didn't exist, because it held the write token and nothing checked the name. A better model wouldn't have fixed that; a gate would have.",
      },
      { t: 'cue', kind: 'ask', text: 'Does any agent in your world hold a credential it could use to merge or deploy? A yes is useful to know.' },
      { t: 'cue', kind: 'next', text: 'Next, the field gotchas that follow from all this.' },
    ],
    sources: [cite('hbCh16', 'C14'), cite('ghCloudAgent', 'C14'), cite('ghAw', 'C14')],
  },
];
