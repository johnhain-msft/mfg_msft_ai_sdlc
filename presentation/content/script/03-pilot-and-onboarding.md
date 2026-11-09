# Script · Pilot and onboarding

## [live-pilot] Live Production Run: gh-admin-msft → portfolio

SHOW: The ledger of six identifiers on the left and the interactive six-step telemetry viewer on the right, starting on Step 1.

The viewer on the right steps through six production milestones from the administration pilot, and the link below opens the full eight-frame animated SVG. Because these repositories are private, collaborators with repository access can inspect each run and pull request directly by the identifiers on the left.

Step one, already on screen, is the dry run ending in nine-oh-eight-seven. The dry-run flag is true, so it snapshots all seven sources, runs the agent and the seven post-steps, and skips safe outputs with zero writes to the remote. Do this first when you wire up a new repository.

CLICK: Click Live drift #42531290378 in the ledger (or press Next in the viewer) to show Step 2.

Step two is the live run, ending in oh-three-seven-eight. Because dependencies were installed before the agent started, it ran the repository's validators inside the sandbox: ninety-nine unit tests, sixty freshness checks with no warnings, seven deck checks, and eleven validation suites, all passing.

CLICK: Click Drift PR gh-admin-msft#19 in the ledger to show Step 3.

Step three is pull request number nineteen on the administration repository. It changes one line: a heading in the licenses and billing document now names Secret Protection and Code Security beside the old Advanced Security title. The product was split, and a freshness rule flagged the old wording.

The agent also wrote down what it hadn't done. Its report has a Not confirmed section noting that it did not do a full drift review of the other snapshots. That pull request superseded an older drift pull request, number sixteen, which the close-older key closed. I merged number nineteen.

CLICK: Click Router #42532934615 in the ledger to show Step 4.

Step four is the router run ending in four-six-one-five. It sees the administration repository advance from a2f9a3bb to 49569501 and dispatches the mechanical cascade for that edge. If a collaborator opens that run, the overall run shows red because the pipeline-showcase job in the same matrix failed, while fail-fast false let the green administration job dispatch the cascade.

CLICK: Click Cascade #42532946999 in the ledger to show Step 5.

Step five is the cascade run ending in six-nine-nine-nine. It imports that exact revision into the portfolio, passes all seven legs of the portfolio verification gate, and updates the poll state variable.

CLICK: Click Cascade PR portfolio#1 in the ledger to show Step 6.

Step six is portfolio pull request number one, opened by the bot. It imported sixty-one documents and nine lab tiles, with provenance pinned to the same revision, and I merged that one as well.

So a wording fix upstream became a merged pull request downstream, with no server in the path and nobody copying files by hand.

ASK: What would you want to see on a screen like this before you let it touch your own repositories?

> This deck is itself a repository in the fleet. Here's the wiring.

SOURCE: docs/media/gh-admin-sdlc-pipeline-demo.svg · https://github.com/johnhain-msft/gh-admin-msft/pull/19 · https://github.com/johnhain-msft/portfolio/pull/1 · https://github.com/johnhain-msft/mfg_msft_ai_sdlc/actions/runs/42531290378 · https://github.com/johnhain-msft/mfg_msft_ai_sdlc/actions/runs/42532946999

## [self-cascade-onboard] S5 · Self-Cascade & Two-Command Onboarding

SHOW: Two commands on the left. A small block of YAML on the right.

Two commands make up the operator experience.

The first is sdlc-bootstrap. It registers the GitHub App, or reuses one, under the permission ceiling we saw earlier. It checks the installations on every target account, writes the repository variables and secrets, hands the manifest to the reconciler, and runs readiness checks. You get one browser confirmation for the App and one installation page per account. Secrets never land in a file, a flag, or a log.

The second is sdlc-onboard, pointed at any repository. It inspects the repository, works out the upstream and downstream sides, and writes the project and edge entries for the manifest, plus an instructions file for the drift agent. Both commands refuse to run on a gh-aw older than one point zero point one, because of a security advisory on how earlier releases wrote safe-output artifacts.

The YAML on the right is the self-cascade edge, ai-sdlc, and it's registered in sdlc.yaml. The deck you're looking at lives in this repository, under the presentation folder, and that edge wires it into the portfolio in the same mechanical mode as the administration workshop. When a pull request merges here, the router sees the new head and starts the cascade. The portfolio runs its import script against this checkout, passes the seven gates, and opens a pull request, and a person merges that one too.

> Let us see whether the security story stuck.

SOURCE: README.md · bin/sdlc-bootstrap.mjs · bin/sdlc-onboard.mjs · bin/lib/ghaw-version.mjs · specs/05-packaging-bootstrap-and-governance.md

## [knowledge-check] Architecture Check: Who Grades the Agent?

SHOW: One question and three answers. Do not click yet.

ASK: Read the question. Vote in chat: A, B, or C. You have twenty seconds.

PAUSE: Twenty seconds of silence. Resist the urge to hint.

CLICK: Click option B.

The answer is B. I'll start with why the other two fail.

A has the pull request opening with a warning. That would make the gate advisory, and the design doesn't allow advisory gates. A failing post-step fails the agent job, and safe outputs depends on that job, so no pull request exists at all.

C has the router resetting the state variable. The router isn't in this path. A failed gate is recorded as one failure against that revision, and after two failures the router stops and waits for a person.

B is right because the check that decides isn't the agent's. The prompt can ask the agent to be careful, but it can't change which files the gate treats as locked. That list is data in sdlc.yaml, under the edge's immutable gates, and the script that enforces it runs after the agent has finished.

Locked covers three things. First, paths that must show zero diff. Second, the companion test files of the sibling workflows, which also must not move. Third, named blocks inside the edge's own tests, which must stay byte for byte what they were before the agent started. Change any of those and the script fails the job.

> Three rules to take with you.

SOURCE: src/verify-immutable-gates.mjs · src/update-poll-state.mjs · specs/02-upstream-drift-automation.md · specs/04-ai-downstream-adaptation.md

## [takeaways] Declarative, Sandboxed, Self-Cascading

SHOW: Three cards. Each one names the specification that owns its rule.

Three rules, one per card.

Declare the fleet as data. Watch addresses, verification commands and dependency edges all live in one manifest, so a reviewer can read the intent in a diff.

Never let an agent grade its own homework, and never hand it the write token. Bound the turn, sandbox the network, and run the checks where the agent can't edit them.

And match the cascade mode to the job. If a script can do the import, let the script do it, and spend the agent only where judgment is needed.

Each card names the specification that owns that rule; in the hosted portfolio reader those links open the specification pages directly, and in the standalone deck they open the files on GitHub for collaborators. The plan file holds the whole plan, with every claim traced to a source.

ASK: Open the floor. What would you want to put under this kind of control first?

SOURCE: plan.md · specs/01-manifest-and-reconciler.md · specs/02-upstream-drift-automation.md · specs/03-event-routing-and-mechanical-cascade.md · specs/04-ai-downstream-adaptation.md · specs/05-packaging-bootstrap-and-governance.md
