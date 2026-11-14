# Script · Workstreams and cascade

## [s1-reconciler] S1 · Manifest & Deterministic Reconciler

SHOW: The tile on the left, then the three rows on the right.

The input to S1 is sdlc.yaml and the engine is reconcile.mjs. It's deterministic: the same manifest produces the same output, byte for byte, every time.

Row one is the schema gate. First the file is checked against a JSON Schema. Then a second pass checks the rules a schema can't express: no dependency cycles, unique state variable names, reviewers and a non-empty list of allowed files on every edge, and a variable name that matches its upstream's slug.

Row two is the compiler pipeline. It renders a markdown workflow for each project and each edge, then calls the gh-aw compiler in strict mode with purge, which writes the lockfiles and removes any stale ones.

Row three covers token and merge guardrails on what it generates. Each workflow mints an App token, and the reconciler scopes that token to the repositories of that one edge. Then an audit of the rendered output rejects disallowed settings: auto-merge turned on, the option that lets a workflow push workflow files, and strict mode switched off.

DO: If you want to open the spec, click the path on the tile.

That's why the other workstreams stay consistent. Nobody hand-edits a workflow, and if the rendered output violates policy, the build fails before anything is written.

> S1 produces the workflows. Next, the first one it produces: the drift audit.

SOURCE: src/reconcile.mjs · schemas/sdlc.schema.json · specs/01-manifest-and-reconciler.md

## [s2-drift-harness] S2 · Upstream Drift & Remote-Only Harness

SHOW: The pipeline diagram, left to right. Hover each stage as you reach it.

S2 audits an upstream repository against the live documentation it depends on. It has four stages, left to right.

DO: Hover the first box.

Before any model runs, deterministic scripts prepare the run. One writes the run context. One looks for open drift pull requests, so the run doesn't open a duplicate. One snapshots the watched sources, which for the administration repository means seven addresses: the changelog, the enterprise changelog, and five documentation sections. The last installs the target repository's dependencies with install scripts disabled.

DO: Hover the dashed box.

Then the model runs, inside the firewall sandbox, with read-only permissions on the repository. It runs a three-role harness, and the roles go in strict order. A source verifier checks each candidate change against primary documentation. A curriculum updater edits the labs, docs, deck and script together. A regression tester steps through every modified exercise and runs the validators.

The first row underneath is about the folder. The harness lives in a folder called sdlc, not the usual agents folder, because Copilot CLI and VS Code load the agents folder automatically. Put the harness there and every developer who opened the repository locally would silently inherit a drift-bot persona. One level over, nothing loads it by accident, and only the remote workflow reads it.

DO: Hover the third box.

After the agent come the project's seven verification commands from sdlc.yaml, in order, outside the agent's control: a clean dependency install, rebuilding the deck, a clean-tree check, unit tests, freshness rules, the deck validator, and the remaining test suites. The first failure ends the job.

DO: Hover the last box.

If everything passes, and only then, safe outputs opens one pull request. Auto-merge is off, edits to protected files are blocked, and an older drift pull request for the same project is closed in favor of the new one.

> The audit opens a pull request upstream. When a person merges it, how does the portfolio find out?

SOURCE: .github/workflows/drift-gh-admin-msft.md · src/snapshot-watch-sources.mjs · specs/02-upstream-drift-automation.md · https://github.com/johnhain-msft/gh-admin-msft/blob/main/.github/sdlc/AGENTS.md

## [s3-event-router] S3 · Hybrid Push + ETag Event Router

SHOW: Four numbered rows. The last one has a dashed border and a circular arrow. That is the safety net.

I'll trace one merge through S3. Rows one to three are the fast path, and row four is the safety net.

Row one is the push. This repository carries a small workflow called the merge bridge. When a pull request merges to its main branch, it mints a short-lived token for the App and sends a repository dispatch to its own router. The event is named upstream underscore pr underscore merged, and its payload has six fields, including the merged commit, the pull request number and a correlation id. The other upstreams don't get the bridge, because it would need the App's private key, and that key can reach every installation of the App. We don't copy it anywhere.

Row two is the check. The router wakes up and reads that edge's state variable. Then it asks GitHub for the upstream's latest commit, sending the stored ETag in an If-None-Match header. If nothing changed, GitHub answers 304, and a 304 doesn't count against the primary rate limit. If something changed, the router compares the new head with the recorded state and runs the edge's cheap preflight checks, so a commit that changes nothing material, like a refreshed timestamp, doesn't start a cascade.

Row three is the dispatch. Otherwise the router starts the cascade workflow for that edge and passes the correlation id along, so the dispatch, the run and any failure issue share one id you can search for.

Row four is the safety net, and for every other upstream it's the main path. Four times a day, at 17 minutes past the hour, the same router runs on a schedule. Not on the hour, because that's when GitHub delays scheduled runs the most, and sometimes drops them. If a developer pushes straight to main, or an upstream has no bridge, or a dispatch gets dropped, the poll still sees the new head. That's the hybrid: the push is fast where we have it, and the poll catches everything else.

The router has two safeguards. Runs are serialized per edge, in a concurrency group that never cancels a run in progress, so two runs can't corrupt the state. And if a revision fails twice, the router stops and waits for a person instead of retrying forever.

> The router has decided a cascade is needed. Now, which kind?

SOURCE: src/route-upstream.mjs · src/update-poll-state.mjs · .github/workflows/cascade-router.yml · specs/03-event-routing-and-mechanical-cascade.md · .github/workflows/sdlc-bridge-dispatch.yml

## [s4-cascade-modes] S4 · Mechanical vs AI-Adaptation Cascade

SHOW: The question card on the left and two outcome cards on the right.

Every edge in sdlc.yaml has a mode, and the mode sets how much freedom the agent gets. I'll walk the tree on screen.

CLICK: Answer Yes to the first question.

The first question asks whether a deterministic import script rebuilds this edge's bundle. If yes, the edge is mechanical. When you run sdlc-onboard with mode set to auto, it picks mechanical automatically if the downstream repository has a single import-colon-star script; on our portfolio repository, which hosts multiple import scripts, we pass dash-dash-mode mechanical explicitly so each edge runs its own import script, commits what changed under a fixed allow-list, and opens a pull request. For the administration workshop going into the portfolio, that script is npm run import:ghec-admin.

Mechanical still involves an agent: gh-aw runs one agent turn. The prompt tells it to do three things, in order, and nothing else, and its network allowlist is empty. It's mechanical because the agent exercises no judgment, and the pull request footer shows what that turn cost. The decision belongs to the gate: a clean worktree, only allowed paths touched, the provenance file recording the new revision, and a seven-leg portfolio check. The legs are build, catalog build, typecheck, lint, tests, studio tests and a browser suite.

CLICK: Press Start over. Answer No, then Yes.

With no single import script, the answer is usually AI-adaptation, because the upstream change needs editing across files: workshop pages, lab pages, and tests that pin a revision. The agent may edit only the files on that edge's allowed list. Afterward the immutable-gates script checks that locked files show zero diff and that protected blocks in the companion tests are byte for byte identical.

The Copilot lab, the pipeline showcase and the intermediate template are AI-adaptation edges. The administration workshop and this orchestrator repository are mechanical.

CLICK: Press Start over. Answer No, then No.

The third result: two noes, and you probably don't need an edge at all, because there's nothing to cascade.

ASK: Think of one repository in your own organization. Which mode would it be? Say it in chat.

> Now the same pipeline, running in production.

SOURCE: bin/lib/synthesize.mjs · .github/workflows/cascade-mechanical-ghec-admin.md · .github/workflows/cascade-ai-pipeline-showcase.md · src/verify-immutable-gates.mjs · specs/04-ai-downstream-adaptation.md
