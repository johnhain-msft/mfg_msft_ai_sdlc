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

:::cols 1fr 1fr
:::col Instance · This Repo
- `sdlc.yaml`
- `instructions/`
- `scripts/`
- `.github/workflows/`
:::col Engine · Public Package
- `ai-sdlc-factory v0.2.0`
- `sdlc-reconcile`
- `sdlc-bootstrap`
- `sdlc-onboard`
:::

:::callout note Reconciler Guardrails
Schema gate, strict `gh aw compile`, per-edge App tokens, and `auto-merge` always rejected.
:::

---

@id: s2-drift-harness
@layout: diagram
@minutes: 3

# S2 · Report-Driven Upkeep & Change Policy

:::diagram upkeep-explorer

:::spec specs/06-actionable-upkeep.md

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
