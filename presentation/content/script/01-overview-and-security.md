# Script · Overview and security

## [cover] AI SDLC Orchestrator

SHOW: The cover. Let the room read the title and the three chips before you speak.

Thanks for joining. Over the next thirty minutes I'll show you how a fleet of repositories can keep itself current, with the whole control plane running inside GitHub.

I look after a handful of technical repositories: workshops, labs, a reference architecture. They lean on vendor documentation that changes every week, and a portfolio site embeds their compiled output. Two things go wrong. The upstream content goes stale, and then the portfolio falls behind the upstream.

The project is called mfg_msft_ai_sdlc. It's built from three pieces: a GitHub App, GitHub Actions, and GitHub Agentic Workflows, or gh-aw.

The chips along the bottom are the three promises. One App identity does all the work. There's no server to patch and no database to back up. And a person merges every pull request; the machine never does.

PAUSE: Two seconds. Let the third promise land.

By the end I want you to be able to do three things. Explain why one declarative control plane beats a cron job in every repository. Trace why an agent inside the pipeline can't approve its own work. And choose the right cascade mode when you bring a new repository on board.

> First, why does a fleet drift at all?

SOURCE: README.md · plan.md

## [fleet-problem] Why Multi-Repo Fleets Drift

SHOW: Two columns of text, then three number tiles underneath.

Picture four upstream repositories: a GitHub Enterprise administration workshop, a Copilot lab, a pipeline showcase and an intermediate GitHub template, plus this orchestrator repository itself. They span three different GitHub accounts and organizations.

Suppose each one ran its own cron job against vendor docs. You'd end up with four slightly different schedules, four sets of secrets, and four places for a failure to hide, and nobody would be watching the gaps between them. That's the left column.

The right column is the downstream half. Somebody merges a fix upstream, and the site that embeds the compiled output never hears about it. It stays pinned to an old commit until someone happens to remember.

The tiles underneath: six repositories, five of them feeding one, including this orchestrator repository itself. A single manifest, sdlc.yaml, describes every one of them and every dependency between them. The last tile is a zero because there are no webhook servers anywhere. Everything is a GitHub Actions workflow that the manifest generates.

Changing a watch URL or adding a dependency is a pull request against one file. A reviewer reads the diff, the reconciler regenerates the workflows from it, and nobody edits a generated workflow by hand.

ASK: Show of hands. Who has a repository that is really a copy of another repository's output?

> So what does that machinery look like? Five workstreams.

SOURCE: sdlc.yaml · specs/01-manifest-and-reconciler.md · README.md

## [architecture] Five Workstreams, One Control Plane

SHOW: The topology diagram. Hover each node as you name it; the others dim.

This is the whole system on one page. Read it top to bottom, then left to right.

DO: Hover the S1 band at the top.

S1 is the manifest and its reconciler. You edit sdlc.yaml, and a script called reconcile.mjs validates it, renders every workflow file below, and compiles them into lockfiles. In effect it's the compiler for the rest of the fleet.

Left to right is the life of a change.

DO: Hover S2.

S2 watches the upstream repositories on the left that have a drift audit enabled. On a schedule it checks each one against the live documentation it depends on, and where it finds drift it opens a pull request on that same repository. A person reviews and merges.

DO: Hover S3.

When one of those pull requests merges, S3 learns about it two ways. The upstream sends a push signal at the moment of the merge, and S3 also polls every six hours as a safety net, so a direct push or a dropped signal still gets caught.

DO: Hover S4.

S4 is the cascade. It carries the new upstream revision into the portfolio, either by running an import script or with a bounded agent that adapts files. Either way it ends by opening a pull request on the portfolio, and a person merges that too.

DO: Hover S5.

Along the bottom is S5: the commands that bootstrap the fleet and onboard new repositories. The purple dashed arrow is this repository cascading itself into the portfolio. We'll come back to it near the end.

The callout covers where state lives: in repository Actions variables, one per upstream. Each holds a single small object with fourteen fields, including the last revision seen, the ETag, and a failure count. Every write goes through one script. There's no database, so there's nothing else to back up.

> Everything on this diagram runs with credentials. What can it actually do?

SOURCE: plan.md · .github/workflows/cascade-router.yml · specs/03-event-routing-and-mechanical-cascade.md

## [security-boundary] Six Permissions, Zero Autonomous Merges

SHOW: Three cards, left to right: a key, a dashed box, a padlock.

The security design has three layers, in the order the agent meets them. Each one is meant to hold if the one before it fails.

First, identity. The orchestrator acts as a single GitHub App, and its permission list is short and fixed: write access to contents, pull requests, issues, actions and variables, plus read access to metadata. That list is one data file, bin/lib/app-permissions.json. The bootstrap code compares whatever the App actually holds against that file. If the App has an extra permission or a higher level than listed, such as the right to change workflows or administer repositories, the command aborts and tells you nothing was written.

Second, the sandbox. The agent runs inside the GitHub Agentic Workflows Firewall, a container behind a network allowlist. For the drift audit that allowlist is two domains, docs.github.com and github.blog. For the mechanical cascade it's empty. The job also runs in gh-aw strict mode, and dependencies are installed before the agent starts, with install scripts switched off, so the agent never needs the network to run tests.

Third, the gates. After the agent finishes, deterministic steps run outside the agent's prompt. For drift, those are the project's own test commands, in order, and the first non-zero exit fails the job. For the AI cascade, an immutable-gates script also checks that locked files show zero diff. Only if all of that passes does the safe-outputs job run. It's the only place a pull request is opened, and auto-merge is off.

That's the title: six permissions, and a person is the last step every time.

ASK: Which of these three layers does your current automation have?

PAUSE: Let the room answer in chat. Ten seconds.

> With the boundary set, let me walk the workstreams one at a time, starting with the compiler.

SOURCE: bin/lib/app-permissions.json · bin/lib/github-app.mjs · .github/workflows/drift-gh-admin-msft.md · src/verify-immutable-gates.mjs · specs/02-upstream-drift-automation.md
