---
section: Overview & Security
day: 1
---

@id: cover
@layout: title
@minutes: 2
@kicker: Architecture Briefing

# AI SDLC Orchestrator

:::glyph fleet

Declarative fleet upkeep and downstream cascade on GitHub Actions and `gh-aw v1.0.1`.

:::chips
- GitHub App #5671833
- Zero External Servers
- Human-Merged PRs
:::

:::aside
John Hain · L300 · 30 minutes
:::

---

@id: fleet-problem
@layout: default
@minutes: 2

# Why Multi-Repo Fleets Drift

:::cols 1fr 1fr
:::col Independent Crons Break
Scattered schedules miss vendor doc changes and diverge silently.
:::col Downstream Copy-Paste Stalls
Merged upstream fixes leave portfolio bundles pinned to stale commits.
:::

:::stats
6 | Tracked Fleet Repos | 5 upstreams + 1 downstreams
1 | Declarative Manifest | `sdlc.yaml` owns every edge
0 | Webhook Servers | 100% GitHub Actions native
:::

---

@id: architecture
@layout: diagram
@minutes: 3

# Five Workstreams, One Control Plane

:::diagram fleet-topology

:::callout tip Zero-Infrastructure State
Actions variables (`SDLC_SYNC_STATE_*`) hold ETag and SHA watermarks, with no external database.
:::

---

@id: security-boundary
@layout: cards
@minutes: 3

# Six Permissions, Zero Autonomous Merges

:::cards 3
:::card [icon=key] 6-Permission App Ceiling
`mfg-msft-ai-sdlc` holds only contents, pull_requests, issues, actions, variables, and metadata.
:::card [icon=box] AWF Firewall Sandbox
Agent turns run in `gh-aw` strict mode, with dependencies pre-installed and domains allowlisted.
:::card [icon=lock] Immutable Post‑Agent Gates
Tests, builds, and zero-diff checks run outside the agent before `safe_outputs`.
:::
