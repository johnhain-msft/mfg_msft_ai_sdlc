---
section: Workstreams & Cascade
day: 1
---

@id: s1-reconciler
@layout: lab
@minutes: 2

# S1 · Manifest & Deterministic Reconciler

:::labtile
S1 | SPEC-01 · Reconciler | specs/01-manifest-and-reconciler.md
:::

:::kv
Schema Gate | Validates `sdlc.yaml` against `schemas/sdlc.schema.json`, then cross-field semantic rules.
Compiler Pipeline | Renders `.md` workflows, then runs `gh aw compile --strict --purge`.
Token & Merge Guardrails | Scopes each App token to its edge's repositories and rejects `auto-merge`.
:::

---

@id: s2-drift-harness
@layout: diagram
@minutes: 3

# S2 · Upstream Drift & Remote-Only Harness

:::diagram drift-pipeline

:::kv
Why a separate folder? | Local sessions load `.github/agents/`, never `.github/sdlc/`; only remote runs read it.
Three Specialist Roles | `source-verifier` corroborates changes, `curriculum-updater` edits labs and decks, `regression-tester` runs validators.
:::

:::spec specs/02-upstream-drift-automation.md

---

@id: s3-event-router
@layout: timeline
@minutes: 3

# S3 · Hybrid Push + ETag Event Router

:::timeline
Push | `sdlc-bridge-dispatch.yml` posts `upstream_pr_merged` on a merge in this repository. | push
Check | `route-upstream.mjs` sends `If-None-Match` and compares recorded state. | check
Dispatch | Router starts `cascade-mechanical-*` or `cascade-ai-*` with a correlation id. | dispatch
Every 6 h | Poll at :17 covers every other upstream; `304` answers cost no primary rate limit. | poll
:::

:::spec specs/03-event-routing-and-mechanical-cascade.md

---

@id: s4-cascade-modes
@layout: decision
@minutes: 3

# S4 · Mechanical vs AI-Adaptation Cascade

:::diagram cascade-decision

:::spec specs/04-ai-downstream-adaptation.md
