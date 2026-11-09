---
section: Pilot & Onboarding
day: 1
---

@id: live-pilot
@layout: media
@minutes: 4

# Live Production Run: `gh-admin-msft` → `portfolio`

:::ledger
Dry run | #42525239087
Live drift | #42531290378
Drift PR | gh-admin-msft#19
Router | #42532934615
Cascade | #42532946999
Cascade PR | portfolio#1
:::

:::diagram live-pipeline-demo

:::spec docs/media/gh-admin-sdlc-pipeline-demo.svg

---

@id: self-cascade-onboard
@layout: split
@minutes: 2

# S5 · Self-Cascade & Two-Command Onboarding

:::cols 1fr 1fr
:::col Bootstrap & Onboard CLI
`sdlc-bootstrap.mjs` provisions the App and state variables; `sdlc-onboard.mjs` writes manifest entries.

```bash
node bin/sdlc-bootstrap.mjs
node bin/sdlc-onboard.mjs --repo <owner/repo>
```

:::spec specs/05-packaging-bootstrap-and-governance.md
:::col Self-Cascading edge: `ai-sdlc`
```yaml
edgeId: ai-sdlc
upstreamRepo: johnhain-msft/mfg_msft_ai_sdlc
downstreamRepo: johnhain-msft/portfolio
mode: mechanical
importCommands:
  - npm run import:ai-sdlc -- <checkout>
```
:::

---

@id: knowledge-check
@layout: quiz
@minutes: 2

# Architecture Check: Who Grades the Agent?

:::quiz
Q: An adaptation agent edits a locked test file. What happens?
- A) The pull request opens with a warning.
- B) `verify-immutable-gates.mjs` fails; `safe_outputs` never runs.
- C) The router resets `SDLC_SYNC_STATE`.
Answer: B — Gates run outside the agent turn; `safe_outputs` depends on them.
:::

---

@id: takeaways
@layout: end
@minutes: 1
@kicker: Takeaways

# Declarative, Sandboxed, Self-Cascading

:::cards 3
:::card [icon=doc] Declare Fleet Intent
Keep watch URLs, verify gates, and cascade edges in `sdlc.yaml` ([SPEC-01](specs/01-manifest-and-reconciler.md)).
:::card [icon=box] Isolate Agent Execution
Bound AI turns with `.github/sdlc/`, `awf` sandboxing, and deterministic `post-steps` ([SPEC-02](specs/02-upstream-drift-automation.md), [SPEC-04](specs/04-ai-downstream-adaptation.md)).
:::card [icon=flow] Automate the Cascade
Pair push bridge dispatch with ETag polling and human-merged PRs ([SPEC-03](specs/03-event-routing-and-mechanical-cascade.md), [SPEC-05](specs/05-packaging-bootstrap-and-governance.md)).
:::

:::spec plan.md
