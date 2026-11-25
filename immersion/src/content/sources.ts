/**
 * Primary sources, one place. Every entry was opened from the primary page and verified when the
 * deck was authored (claims C01-C18). Slides cite them through `cite(...)` so a label or URL
 * is never retyped, and `claim` ties each link back to the claim it supports.
 */

import type { Source } from './types';

const HB = 'https://danielmeppiel.github.io/agentic-sdlc-handbook/';
const HBC = `${HB}handbook/`;
const CAF = 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/';
const GHD = 'https://docs.github.com/en/';

export const SRC = {
  hbIndex: { label: 'The Agentic SDLC Handbook (Daniel Meppiel)', url: HB },
  hbCh1: { label: 'Handbook Ch 1: the agentic SDLC thesis', url: `${HBC}ch01-the-agentic-sdlc-thesis.html` },
  hbCh3: { label: 'Handbook Ch 3: the business case', url: `${HBC}ch03-the-business-case.html` },
  hbCh4: { label: 'Handbook Ch 4: the reference architecture', url: `${HBC}ch04-the-reference-architecture.html` },
  hbCh5: { label: 'Handbook Ch 5: governance for AI-assisted delivery', url: `${HBC}ch05-governance-for-ai-assisted-delivery.html` },
  hbCh6: { label: 'Handbook Ch 6: team structures', url: `${HBC}ch06-team-structures.html` },
  hbCh7: { label: 'Handbook Ch 7: the agentic SDLC bill', url: `${HBC}ch07-the-agentic-sdlc-bill.html` },
  hbCh8: { label: 'Handbook Ch 8: planning the transition', url: `${HBC}ch08-planning-the-transition.html` },
  hbCh12: { label: 'Handbook Ch 12: the instrumented codebase', url: `${HBC}ch12-the-instrumented-codebase.html` },
  hbCh13: { label: 'Handbook Ch 13: the PROSE constraints', url: `${HBC}ch13-the-prose-specification.html` },
  hbCh15: { label: 'Handbook Ch 15: attention and context economy', url: `${HBC}ch15-attention-and-context-economy.html` },
  hbCh16: { label: 'Handbook Ch 16: the deterministic/probabilistic boundary', url: `${HBC}ch16-deterministic-probabilistic-boundary.html` },
  hbCh17: { label: 'Handbook Ch 17: multi-agent orchestration', url: `${HBC}ch17-multi-agent-orchestration.html` },
  hbCh19: { label: 'Handbook Ch 19: architectural patterns, a Rosetta Stone', url: `${HBC}ch19-architectural-patterns-rosetta-stone.html` },
  hbCh20: { label: 'Handbook Ch 20: anti-patterns and failure modes', url: `${HBC}ch20-anti-patterns-and-failure-modes.html` },

  liu: { label: 'Liu et al., Lost in the Middle (TACL 2024)', url: 'https://arxiv.org/abs/2307.03172' },
  peng: { label: 'Peng et al., The Impact of AI on Developer Productivity (2023)', url: 'https://arxiv.org/abs/2302.06590' },

  cafCoe: { label: 'Microsoft CAF: establish an AI Center of Excellence', url: `${CAF}scenarios/ai/center-of-excellence` },
  cafGov: { label: 'Microsoft CAF: govern and secure AI agents across the organization', url: `${CAF}ai-agents/governance-security-across-organization` },
  cafGovernAi: { label: 'Microsoft CAF: govern AI (golden datasets and independent review)', url: `${CAF}ai/govern` },
  cafAi: { label: 'Microsoft Cloud Adoption Framework: AI', url: `${CAF}ai/` },
  cafAgentPlan: { label: 'Microsoft CAF: business plan for AI agents', url: `${CAF}ai-agents/business-strategy-plan` },

  msAgentRoi: { label: 'Microsoft Learn: measure the impact and ROI of your agents', url: 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-measure-impact' },
  msAgentDefine: { label: 'Microsoft Learn: define value before you build your agent', url: 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-define-value' },
  msAgentStory: { label: 'Microsoft Learn: communicate the value story to stakeholders', url: 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-tell-value-story' },
  msAgentMaturity: { label: 'Microsoft Learn: agentic AI adoption maturity model', url: 'https://learn.microsoft.com/en-us/agents/adoption-maturity-model/' },
  msAgentMaturityHowTo: { label: 'Microsoft Learn: how to use the agentic AI adoption maturity model', url: 'https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-how-to-use' },
  msFinopsUnit: { label: 'Microsoft Learn: FinOps Framework unit economics', url: 'https://learn.microsoft.com/en-us/cloud-computing/finops/framework/quantify/unit-economics' },
  msSpace: { label: 'Microsoft Research: the SPACE of developer productivity (2021)', url: 'https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/' },
  dora2025: { label: 'DORA 2025: State of AI-assisted Software Development', url: 'https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report' },

  ghMetrics: { label: 'GitHub Docs: Copilot usage metrics', url: `${GHD}copilot/concepts/billing-and-usage/copilot-usage-metrics/copilot-metrics` },
  ghCodeql: { label: 'GitHub Docs: CodeQL code scanning', url: `${GHD}code-security/concepts/code-scanning/codeql/codeql-code-scanning` },
  ghAiScan: { label: 'GitHub Docs: AI Scan', url: `${GHD}code-security/concepts/code-scanning/ai-scan` },
  ghAiScanRepos: { label: 'GitHub Docs: AI Scan for repositories (public preview)', url: `${GHD}code-security/concepts/code-scanning/ai-scan-for-repositories` },
  ghAiDetections: { label: 'GitHub Docs: AI-powered security detections for pull requests', url: `${GHD}code-security/concepts/code-scanning/ai-powered-security-detections` },
  ghAiPrGa: { label: 'GitHub changelog: AI Scan for pull requests is generally available (2026-10-15)', url: 'https://github.blog/changelog/2026-10-15-ai-scan-for-pull-requests-generally-available/' },
  ghAutofix: { label: 'GitHub Docs: Copilot Autofix for code scanning', url: `${GHD}code-security/concepts/code-scanning/autofix-for-code-scanning` },
  ghResponsible: { label: 'GitHub Docs: responsible use of security and quality AI features', url: `${GHD}code-security/responsible-use/security-and-quality-ai-features` },
  ghCloudAgent: { label: 'GitHub Docs: Copilot cloud agent risks and mitigations', url: `${GHD}copilot/concepts/security-governance-and-network-settings/risks-and-mitigations` },
  ghAw: { label: 'GitHub Agentic Workflows: safe outputs', url: 'https://github.github.io/gh-aw/reference/safe-outputs/' },
  ghSecurityDocs: { label: 'GitHub Docs: code security', url: `${GHD}code-security` },
} as const;

export type SourceKey = keyof typeof SRC;

/** A source with the claim it supports (`C01` ... `C18`). */
export const cite = (key: SourceKey, claim?: string): Source => {
  const s = SRC[key];
  return claim ? { label: s.label, url: s.url, claim } : { label: s.label, url: s.url };
};
