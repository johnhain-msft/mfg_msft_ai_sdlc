# Script · Overview and security

## [cover] AI SDLC Orchestrator

SHOW: The cover. Let the room read the title and the three chips before you speak.

Thanks for joining. Over the next thirty minutes I'll show you how a fleet of repositories can keep itself current, with the whole control plane running inside GitHub.

I look after a handful of technical repositories: workshops, labs, a reference architecture. They lean on vendor documentation that changes often, and a portfolio site embeds their compiled output. Two things go wrong. The upstream content goes stale, and then the portfolio falls behind the upstream.

The project is called mfg_msft_ai_sdlc, and it's deliberately two things. This repository is the live instance, and it holds only what is particular to this fleet. The machinery that turns that data into workflows is a separate, public package called ai-sdlc-factory, at version zero point two point zero, and this repository installs it like any other dependency. Underneath both sit a GitHub App, GitHub Actions, and GitHub Agentic Workflows, or gh-aw.

The chips along the bottom are the three promises. The first names the engine and its version, so you always know which code is rendering your workflows. The second is that there's no server to patch and no database to back up. The third is that a person merges every pull request.

PAUSE: Two seconds. Let the third promise land.

By the end I want you to be able to do three things. Explain why one declarative control plane beats a cron job in every repository. Trace why an agent inside the pipeline can't approve its own work. And choose the right cascade mode when you bring a new repository on board.

> First, why does a fleet drift at all?

SOURCE: README.md · plan.md

## [fleet-problem] Why Multi-Repo Fleets Drift

SHOW: Two columns of text, then three number tiles underneath.

Picture five upstream repositories: a GitHub Enterprise administration workshop, a Copilot lab, a pipeline showcase, a GitHub Intermediate workshop, and this orchestrator repository itself. They span a personal GitHub account and a community organization.

Suppose each one ran its own cron job against vendor docs. You'd end up with five slightly different schedules, five sets of secrets, and five places for a failure to hide, and nobody would be watching the gaps between them. That's the left column.

The right column is the downstream half. Somebody merges a fix upstream, and the site that embeds the compiled output never hears about it. It stays pinned to an old commit until someone happens to remember.

The tiles underneath: six repositories, five upstreams feeding one downstream, the portfolio. One of the five is this orchestrator repository itself. A single manifest, sdlc.yaml, describes every one of them and every dependency between them. The last tile is a zero because there are no webhook servers anywhere. Everything runs as a GitHub Actions workflow, and the manifest generates all of them except the merge bridge and this repository's own CI.

Changing a watch URL or adding a dependency is one pull request: the manifest edit and the workflows the reconciler regenerates from it. A reviewer reads the diff, and nobody edits a generated workflow by hand.

ASK: Show of hands. Who has a repository that is really a copy of another repository's output?

> So what does that machinery look like? Five workstreams.

SOURCE: sdlc.yaml · specs/01-manifest-and-reconciler.md · README.md

## [architecture] Five Workstreams, One Control Plane

SHOW: The topology diagram. Hover each node as you name it; the others dim.

This is the whole system on one page. Read it top to bottom, then left to right.

DO: Hover the S1 band at the top.

S1 is the manifest and its reconciler. You edit sdlc.yaml in this repository, and the sdlc-reconcile command from the ai-sdlc-factory engine validates it, renders the workflow files below, and compiles them into lockfiles. In effect it's the compiler for the rest of the fleet. Notice that the band names the engine version: the code that renders is pinned, and the manifest is only data.

Left to right is the life of a change.

DO: Hover S2.

S2 watches the upstream repositories on the left that have a drift audit enabled. On a schedule it checks each one against the live documentation it depends on and files a drift report when it finds something, and a second workflow turns that report into one pull request on the same repository when something survives the research. A person reviews and merges.

DO: Hover S3.

When one of those pull requests merges, S3 learns about it two ways. A merge in this orchestrator repository sends a push signal at once, and S3 polls every upstream four times a day, so a merge anywhere else, a direct push or a dropped signal still gets caught.

DO: Hover S4.

S4 is the cascade. It carries the new upstream revision into the downstream repository, either by running an import script or with a bounded agent that adapts files. All five upstreams feed the portfolio. Either way it ends by opening a pull request on that downstream when there is something to change, and a person merges that too.

DO: Hover S5.

Along the bottom is S5: the commands that bootstrap the fleet and onboard new repositories. The purple dashed arrow is this repository, the fifth upstream, cascading itself into the portfolio. We'll come back to it near the end.

The callout covers where state lives: in repository Actions variables, one per upstream. Each holds a single small object with fourteen fields, including the last revision seen, the ETag, and a failure count. Every update goes through one script. There's no database, so there's nothing else to back up.

CLICK: Select S2 in the diagram. The callout becomes an inspector with that workstream's role, inputs and outputs, plus a link to its slide. Select it again to go back.

> Everything on this diagram runs with credentials. What can it actually do?

SOURCE: sdlc.yaml · plan.md · .github/workflows/cascade-router.yml · specs/03-event-routing-and-mechanical-cascade.md

## [security-boundary] Six Permissions, Zero Autonomous Merges

SHOW: Three cards, left to right: a key, a dashed box, a padlock.

The security design has three layers, in the order the agent meets them. Each one is meant to hold if the one before it fails.

First, identity. The orchestrator acts as a single GitHub App, and its permission list is short and fixed: write access to contents, pull requests, issues, actions and variables, plus read access to metadata. That list is one data file that ships with the engine package, app-permissions.json. The bootstrap code compares whatever the App actually holds against that file. If the App has an extra permission or a higher level than listed, such as the right to change workflows or administer repositories, the command aborts and tells you nothing was written. Both the instance and the engine are public, so that file is there for anyone to read. The engine's repository also runs a leak guard over every tracked file and its whole history, looking for identifiers that must not be published.

Second, the sandbox. The agent runs inside the GitHub Agentic Workflows Firewall, a container behind a network allowlist. For the drift audit that allowlist is two domains, docs.github.com and github.blog, plus the Microsoft Learn server the agent queries. For the mechanical cascade it's empty. The job also runs in gh-aw strict mode. In the administration drift job, dependencies are installed before the agent starts, with install scripts switched off, so the agent doesn't need the network to run tests.

Third, the gates. After the agent finishes, deterministic steps run outside the agent's prompt. For drift, those are the project's own test commands, in order, and the first non-zero exit fails the job. For the AI cascade, an immutable-gates script also checks that locked files show zero diff. Only if all of that passes does the safe-outputs job run. It's the only place a pull request is opened, and auto-merge is off.

That's six permissions, and a person is the last step every time.

ASK: Which of these three layers does your current automation have?

PAUSE: Let the room answer in chat. Ten seconds.

> With the boundary set, let me walk the workstreams one at a time, starting with the compiler.

SOURCE: specs/01-manifest-and-reconciler.md · specs/02-upstream-drift-automation.md · specs/05-packaging-bootstrap-and-governance.md · .github/workflows/drift-gh-admin-msft.md · sdlc.yaml · https://github.com/johnhain-msft/ai-sdlc-factory/blob/main/CHANGELOG.md
