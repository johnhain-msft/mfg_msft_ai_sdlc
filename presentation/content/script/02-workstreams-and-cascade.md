# Script · Workstreams and cascade

## [s1-reconciler] S1 · Manifest & Deterministic Reconciler

SHOW: The tile on the left. Two lists on the right, instance and engine, then the guardrail note.

S1 is where the split between instance and engine becomes concrete.

DO: Point at the left list.

On the left is the instance, this repository. It holds the manifest, the instructions for each project's agent, a few helper scripts, and the workflows generated from them. All of it is data or glue.

DO: Point at the right list.

On the right is the engine, a public package called ai-sdlc-factory. This repository pins it at version zero point two point zero by tag, and the lockfile records the exact commit. It installs three commands: reconcile renders and compiles the workflows, bootstrap sets the fleet up, and onboard adds a repository. It also exports a small public API, a script kit and a drift library, and that is the only surface this repository's helper scripts may import.

Because the engine is public, a job that installs it uses a plain npm ci that ignores install scripts, and no token is minted for it. I'll show the one manifest block that controls that when we reach S5.

The reconcile command is deterministic: the same inputs produce the same bytes. A schema gate runs first, then a second pass for the rules a schema can't express, such as no dependency cycles, unique state variables, and reviewers and allowed files on every edge. Then it renders a markdown workflow for each drift-audited project and each edge and calls the gh-aw compiler in strict mode with purge.

The note underneath is the guardrail set. Each cascade token is scoped to the repositories of one edge, and each drift token to one project. An audit of the rendered output rejects disallowed settings: auto-merge turned on, the option that lets a workflow push workflow files, and strict mode switched off. If the output violates policy, the run fails before anything is written.

DO: If you want to open the spec, click the path on the tile.

> S1 produces the workflows. The first one is the drift audit.

SOURCE: sdlc.yaml · specs/01-manifest-and-reconciler.md · README.md · https://github.com/johnhain-msft/ai-sdlc-factory/blob/main/README.md

## [s2-drift-harness] S2 · Report-Driven Upkeep & Change Policy

SHOW: Four stages left to right, then a row of three policy buttons. Start on corrections-only.

S2 keeps each upstream repository current against the documentation it depends on. It works in two stages joined by a report, and a policy in the manifest decides how much the agents may change on their own.

DO: Point at the first box.

Stage one is the drift workflow, one per project, on a schedule. Before any model runs, deterministic steps snapshot the sources. A project declares three kinds of watched knowledge. Watch URLs are changelogs, feeds and release pages. Cited pages are the documentation pages that the repository's own files link to most. Package manifests are the third. The run compares today's snapshot with the watch index from the last successful run that still has one, and hands the agent a work list: what is new, and which cited pages changed, with the files that cite each one.

Then the agent runs inside the firewall sandbox with read-only permissions. For the administration project, it works as a three-role harness: a source verifier, a curriculum updater and a regression tester, in that order. The harness lives in a folder called sdlc, not the agents folder, so that a developer's local Copilot session doesn't pick up a drift-bot persona by default. After the agent, the project's own verification commands run outside the agent's turn.

DO: Point at the report card.

What comes out of stage one is a pull request when it makes direct edits, and a report, an issue titled Drift report in the target repository, when it finds something to track. Two headings in that report matter. Recommended is what the next stage will apply. For a human is what the project's policy leaves to a reviewer.

DO: Point at the second box.

Filing the report starts stage two, the implement workflow for the same project. It opens the source of every item before it decides anything. If a page can't be fetched, it quotes the error and leaves that item undecided. Then it changes what the sources support, runs the project's build and checks, and, when something survives, opens a single pull request that closes the report when a person merges it.

CLICK: Press corrections-and-additions, then judgement-and-flag, and watch the cards.

The policy is set per project. Corrections only is the default, and self-improving-agents runs it: the agents fix only what a corroborated source contradicts, and every addition and judgment call waits for a person. Corrections and additions also lets them add what the sources announce and the repository doesn't cover yet, such as a new setting or MCP server. The administration and Copilot lab projects run that one today, and the Intermediate and Pipeline Showcase entries declare it for when their drift audits are enabled. Judgement and flag goes furthest: the agent makes judgment calls too, and the pull request carries a heading, Judgement calls, review these, listing each call with the files, the source and the alternatives it weighed. The orchestrator's own entry declares that policy, inactive while its drift audit is off.

The last line is the model. A project, and each cascade edge, can name its own, and the renderer writes it into the workflow's engine object. Leave it out and that engine chooses.

ASK: Which of your repositories would you trust with corrections only, and which with more?

> Stage two ends in a pull request. When a person merges it, how does the portfolio find out?

SOURCE: .github/workflows/drift-gh-admin-msft.md · .github/workflows/implement-gh-admin-msft.md · sdlc.yaml · specs/02-upstream-drift-automation.md · specs/06-actionable-upkeep.md · README.md · https://github.com/johnhain-msft/ai-sdlc-factory/blob/main/CHANGELOG.md

## [s3-event-router] S3 · Hybrid Push + ETag Event Router

SHOW: Four numbered rows. The last one has a dashed border and a circular arrow. That is the safety net.

I'll trace one merge through S3. Rows one to three are the fast path, and row four is the safety net.

Row one is the push. This repository carries a small workflow called the merge bridge. When a pull request merges to its main branch, it mints a short-lived token for the App and sends a repository dispatch to its own router. The event is named upstream underscore pr underscore merged, and its payload has six fields, including the merged commit, the pull request number and a correlation id. The other upstreams don't get the bridge, because it would need the App's private key, and that key can reach every installation of the App.

Row two is the check. The router wakes up and reads that edge's state variable. Then it asks GitHub for the upstream's latest commit, sending the stored ETag in an If-None-Match header. If nothing changed, GitHub answers 304, and a 304 doesn't count against the primary rate limit. If something changed, the router compares the new head with the recorded state and, for the edges that declare them, runs cheap preflight checks, so a commit that changes nothing material, like a refreshed timestamp, doesn't start a cascade.

Row three is the dispatch. Otherwise the router starts the cascade workflow for that edge and passes the correlation id along, so the dispatch, the run and any failure issue share one id you can search for.

Row four is the safety net, and for every other upstream it's the main path. Four times a day, at 17 minutes past the hour, the same router runs on a schedule. Not on the hour, because the start of the hour is a high-load time, when GitHub can delay scheduled runs and sometimes drop them. If a developer pushes straight to main, or an upstream has no bridge, or a dispatch gets dropped, the poll still sees the new head. That's the hybrid: the push is fast where we have it, and the poll catches everything else.

The router has two safeguards. Runs are serialized per edge, in a concurrency group that never cancels a run in progress, so two runs can't corrupt the state. And if a revision fails twice, the router stops retrying it instead of looping forever.

> The router has decided a cascade is needed. Now, which kind?

SOURCE: .github/workflows/cascade-router.yml · .github/workflows/sdlc-bridge-dispatch.yml · specs/03-event-routing-and-mechanical-cascade.md · README.md

## [s4-cascade-modes] S4 · Mechanical vs AI-Adaptation Cascade

SHOW: The question card on the left and two outcome cards on the right, each listing the fleet's edges as buttons.

Every edge in sdlc.yaml has a mode, and the mode sets how much freedom the agent gets. The manifest declares five edges today: three mechanical and two AI-adaptation. I'll walk the tree on screen, then check it against the fleet.

CLICK: Answer Yes to the first question.

The first question asks whether a deterministic import script rebuilds this edge's bundle. If yes, the edge is mechanical. With mode set to auto, sdlc-onboard picks mechanical when the downstream repository has a single import-colon-star script. Our portfolio has several, so we pass dash-dash-mode mechanical, and each edge runs its own import script, commits what changed under a fixed allow-list, and opens a pull request. For the administration workshop, that script is npm run import:ghec-admin.

Mechanical still involves an agent: gh-aw runs one agent session. The prompt tells it to do three things, in order, and nothing else, and its network allowlist is empty. It's mechanical because the agent exercises no judgment. The decision belongs to the gate: a clean worktree, only allowed paths touched, the provenance file recording the new revision, and a seven-leg portfolio check of build, catalog build, typecheck, lint, tests, studio tests and a browser suite.

CLICK: Press Start over. Answer No, then Yes.

With no single import script, the answer is usually AI-adaptation, because the upstream change needs editing across files: workshop pages, lab pages, and tests that pin a revision. The agent may edit only the files on that edge's allowed list. Afterward the immutable-gates script checks that locked files show zero diff and that protected blocks in the companion tests are byte for byte identical.

Version zero point two point zero adjusted that agent's sandbox in two ways. It may now run cd, which its prompt tells it to start its commands with, and an edge can list extra executables in agent sandbox bash commands. Even there, curl, gh and wget remain refused, and the shell still refuses redirections, so files are written with the edit tool. As with drift, an edge can also name its own model.

CLICK: Press copilot-lab, then pipeline-showcase.

Those two are the AI-adaptation edges. In the Copilot lab, a change has to land in the workshop pages and the Studio labs together. In the pipeline showcase, it's the captured runs and the test expectations that go with them. No single script fits either.

CLICK: Press github-intermediate.

This one started as an AI-adaptation edge, because nobody had written an importer. Once a script could rebuild its bundle, we converted it: the agent's edits were replaced by npm run import:github-intermediate, and the edge moved into the mechanical group. The administration workshop and this orchestrator repository are the other two. If a script can do the job, let the script do it.

CLICK: Press Start over. Answer No, then No.

The third result: two noes, and you probably don't need an edge at all, because there's nothing to cascade.

ASK: Think of one repository in your own organization. Which mode would it be? Say it in chat.

> Now the same pipeline, running in production.

SOURCE: sdlc.yaml · .github/workflows/cascade-mechanical-ghec-admin.md · .github/workflows/cascade-ai-pipeline-showcase.md · specs/04-ai-downstream-adaptation.md · specs/05-packaging-bootstrap-and-governance.md · specs/06-actionable-upkeep.md · https://github.com/johnhain-msft/ai-sdlc-factory/blob/main/CHANGELOG.md
