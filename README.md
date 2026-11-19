# mfg_msft_ai_sdlc

The live AI SDLC orchestrator of `johnhain-msft`: a GitHub App, GitHub Actions and [`gh-aw`](https://github.com/github/gh-aw) (GitHub Agentic Workflows)
that keep a fleet of repositories current. No webhook server, no database and no non-GitHub compute are involved.

This repository is an **instance** of the AI SDLC factory package. The factory is the engine: it turns a fleet manifest into generated workflows, compiles
them in strict mode, and ships the commands and the scripts that those workflows run. It is an npm dependency of this repository (`package.json`,
locked by `package-lock.json`), not a copy in it. What is in this repository is what only this fleet has: the manifest
([`sdlc.yaml`](sdlc.yaml)), the workflows generated from it, the instructions of the agents, the helper scripts of the fleet, the specifications and
the briefing deck.

## What is here

| Path | What it is | Written by |
|---|---|---|
| `sdlc.yaml` | The fleet as data: the projects with their drift upkeep, the dependency edges between them, and the data of the fleet's own scripts. The `factory` block says where the engine is installed from. | you |
| `.github/workflows/` | The generated workflows (`*.md` sources, their compiled `*.lock.yml`, `cascade-router.yml`, `aw.json`), and two that are written by hand: `sdlc-bridge-dispatch.yml` and `instance-ci.yml`. | `sdlc-reconcile`, and you |
| `.github/aw/actions-lock.json` | The commit that each action of the generated workflows is pinned to. | `gh aw` |
| `instructions/` | One file per drift project: what the agent is told about that repository. | you, or `sdlc-onboard` |
| `scripts/` | The helper scripts of this fleet, which `sdlc.yaml` names: the classifiers of the preflight checks, the Studio drift and revision-pin helpers, and the validator of the lab audit. They import the engine only through its public API. | you |
| `tests/` | The tests of the instance: its own data and scripts, and `parity.test.mjs`. | you |
| `plan.md`, `specs/` | The plan and the five workstream specifications. | you |
| `presentation/`, `presenter/`, `docs/media/` | The briefing deck and its generator, the presenter script and the media of the walkthrough. | you |
| `package.json`, `package-lock.json` | The dependency on the engine, and the commands of this repository. | you |

Nothing generated is edited by hand. A workflow under `.github/workflows/` that is not one of the two written by hand is the output of the engine, and
`tests/parity.test.mjs` fails when what the pinned engine renders from `sdlc.yaml` is not what is committed.

## Prerequisites

* **Node.js 22 or newer** and **git**. The generated workflows run Node.js 24, and so does CI.
* **gh-aw >= v1.0.1.** Older releases are affected by `GHSA-8h78-hpm7-29gg` (gh-aw `>= 0.83.3` and `< 0.85.4` wrote raw process output into the
  safe-outputs artifact, which can expose CI trigger tokens), and the engine's commands refuse to run with one. To upgrade:

  ```
  gh extension install github/gh-aw        # or: gh extension upgrade gh-aw
  gh aw upgrade                            # regenerates the .lock.yml files
  ```

  Commit the regenerated `.lock.yml` files: upgrading the CLI alone does not replace the SHA-pinned action references in existing lock files. On a
  machine whose global `gh aw` is older and cannot be replaced, install a newer one into a directory of its own and set `SDLC_GH_AW_DATA_HOME` to it
  (see Environment).
* **Read access to the engine's repository.** It is private. The generated workflows and `instance-ci.yml` mint a read token for that one repository
  from the GitHub App; on a workstation, npm needs the same rewrite while it installs (see Bump the engine).

## Everyday commands

```
npm ci --ignore-scripts                      # install the dependencies, the engine among them
npm test                                     # the tests of the instance
npx sdlc-reconcile --request tests/fixtures/request.reference.json
node presentation/build.mjs                  # build the briefing deck
```

**Test.** `npm test` runs every `*.test.mjs` under `tests/`, in `--test-concurrency=4`. The tests start real `bash` and `git`, so they take a while:
run the one that you are working on with `node --test tests/s2/open-pr-dedup.test.mjs`. `SDLC_REAL_GH_AW=1 npm test` also compiles the committed
workflow sources with the real gh-aw (v1.0.1 or newer) and compares the hashes of the committed locks (`tests/parity.test.mjs`).

**Regenerate the workflows.** After you change `sdlc.yaml`, `instructions/` or the engine, run `npx sdlc-reconcile --request
tests/fixtures/request.reference.json` from the root of the repository (`npm run reconcile -- --request tests/fixtures/request.reference.json` is the
same). The request is the one that the bootstrap sends: the App's slug, the engine authentication, the security baseline. The command renders the
workflows, compiles them with `gh aw compile --strict --purge --json`, prints the result as JSON, and puts every file back as it was if anything fails. Review
`git diff`, and commit `sdlc.yaml`, `instructions/` and `.github/workflows/` together.

**Build the briefing.** `node presentation/build.mjs` writes `presentation/dist/index.html`, the self-contained
[briefing](presentation/dist/index.html). It is committed, and `tests/s5/validate-deck.test.mjs` fails when it is not what the sources in
`presentation/` build.

### Bump the engine

An update of the engine is one pull request: the tag in `package.json` is readable, and the lock pins the commit that it pointed at. The registry flag keeps
every `resolved` URL of the lock on the public registry, whatever registry your npm is configured to use; `tests/parity.test.mjs` fails on any other.

```powershell
$repo = '<owner>/<factory-repo>'
$token = gh auth token
$env:GIT_CONFIG_COUNT = '3'
0..2 | ForEach-Object { Set-Item "env:GIT_CONFIG_KEY_$_" "url.https://x-access-token:$token@github.com/$repo.insteadOf" }
$env:GIT_CONFIG_VALUE_0 = "ssh://git@github.com/$repo"; $env:GIT_CONFIG_VALUE_1 = "git@github.com:$repo"; $env:GIT_CONFIG_VALUE_2 = "https://github.com/$repo"
npm install "github:$repo#vX.Y.Z" --ignore-scripts --registry=https://registry.npmjs.org/
Remove-Item env:GIT_CONFIG_COUNT, env:GIT_CONFIG_KEY_*, env:GIT_CONFIG_VALUE_*
npx sdlc-reconcile --request tests/fixtures/request.reference.json
npm test
```

The rewrite lives in the environment of that shell only; nothing is written to `~/.gitconfig`. Read the Breaking and Migration notes of every release between
the old tag and the new one in the installed factory package's `CHANGELOG.md`, review `git diff --stat`, and commit `package.json`, `package-lock.json` and
`.github/workflows/` together: `parity` fails the pull request if they do not agree. Do not update `.github/workflows/sdlc-onboard.md` with `gh aw update`:
the reconciler renders it, with the App's slug in it.

### Environment

| Variable | Used for |
|---|---|
| `SDLC_GH_AW_DATA_HOME` | Directory used as `XDG_DATA_HOME` for `gh` when `XDG_DATA_HOME` is unset and the directory exists: an isolated gh-aw install, for a machine whose global `gh aw` is older than the required version. An explicit `XDG_DATA_HOME` wins. Set it in the shell that runs `sdlc-reconcile` or the tests; never write it into a file. |
| `SDLC_REAL_GH_AW` | `1` makes the tests that need the real gh-aw CLI run: the compile of the committed sources in `tests/parity.test.mjs`. |
| `APP_CLIENT_ID`, `APP_PRIVATE_KEY` | The GitHub App: the variable and the secret of this repository's Actions, and the environment of `sdlc-bootstrap` and `sdlc-onboard` when the App exists. |
| `COPILOT_GITHUB_TOKEN` | The fine-grained personal access token of the Copilot engine (secret `COPILOT_GITHUB_TOKEN`). |
| `GH_TOKEN` / `GITHUB_TOKEN` | The REST credential for the variables and secrets that the bootstrap writes (default: `gh auth token`). |

## Set up and onboard

The two commands that set the orchestrator up and point it at new repositories are the engine's, and they are installed with it:

```
npx sdlc-bootstrap
npx sdlc-onboard --repo <owner/repo-or-path>
```

The bootstrap registers (or reuses) the GitHub App, verifies its installations, writes the Actions variables and secrets, hands `sdlc.yaml` to the
reconciler and checks readiness. The onboarding command inspects a repository and writes its `projects[]` and `dependencyEdges[]` entries and
`instructions/<projectKey>.md`. Their flags, the environment that they read and the exit codes are in the installed factory package's `README.md` and
`docs/`. Nothing is ever placed in a file, a command-line flag or a log: secrets come from the environment or a prompt that
does not echo.

`.github/workflows/sdlc-onboard.md` is a workflow with one `workflow_dispatch` input per flag, whose agent is told to run the same command and to open a
pull request that a human must review and merge: `auto-merge` is never enabled. As the reconciler renders it today that workflow installs neither the
`gh aw` CLI nor the npm dependencies and passes `APP_CLIENT_ID` and `APP_PRIVATE_KEY` only to its token-minting steps, so its agent cannot run the command
yet (open question OQ51 in `specs/05-packaging-bootstrap-and-governance.md`); run the command from a working copy of this repository.

## Sync state and resets

`SDLC_SYNC_STATE_<SLUG>` variables are owned by `cascade-router.yml`; the bootstrap and onboarding commands only create
a missing one. A blocked sync state is reset only by dispatching `cascade-router.yml` with `reset_blocked: true`, never
by editing a `SDLC_SYNC_STATE_<SLUG>` variable.

## Change detection: the router polls

`cascade-router.yml` polls every upstream of `sdlc.yaml` on the schedules of its edges (`17 */6 * * *` in this fleet:
four times a day, at 17 minutes past the hour), with one matrix job per edge. GitHub delays scheduled runs when Actions is
busy, most at the start of every hour, and may drop some of them, so no schedule of the fleet starts on the hour; even so a
scheduled run can start hours late. To route at once instead of waiting for the next poll:

```
gh workflow run cascade-router.yml
```

`.github/workflows/sdlc-bridge-dispatch.yml` wakes the router when a pull request merges in this repository (the
self-cascade of the `ai-sdlc` edge), where the App's credentials already are. Do not copy that workflow, or the App's
private key, into an upstream repository: the key can mint a token for every installation of the App, so each copy would
hand the whole fleet to everyone who can run a workflow in that repository, and a personal access token in its place would
need `Contents: write` on this repository. Upstream repositories need no credential of the orchestrator; they are polled.

What a drift of an upstream means is declared by the edge in `sdlc.yaml`: its `preflightCommands`, and next to them its `preflightChecks`, the scope that a
drift of each command asks the dispatch for and the classifier (a script of `scripts/`) that judges a command whose output is a report. The router runs the
commands and the classifiers, and knows no kind of command of its own.

## Drift upkeep: what the agent sees and what it reports

Each `drift-<projectKey>` workflow, on its schedule or dispatched by hand:

* snapshots the project's `watchUrls` (changelog indexes and feeds, release pages, documentation pages) and, with
  `knowledgeSources.citedPages` (`include` patterns, `hosts`, `maxPages`), the documentation pages that the target's own
  files cite most;
* compares those snapshots with the watch index of the last successful run that was not a dry run (the run artifact
  `sdlc-watch-index-<projectKey>`) and gives the agent a work list, `changes.md`: the entries that are new since then
  and the pages that changed, with the files that cite them. A source whose first page no longer reaches that run is read
  back through its older pages (up to ten); one that still does not is listed under `## Possible gaps` with the period
  that neither run saw, so nothing published between two runs is dropped in silence;
* reads a source page that the snapshot does not hold with `curl`, which reaches the hosts of the watched URLs and of
  the cited pages and nothing else: Copilot gets one `--allow-url` engine argument for each host of `network.allowed`,
  and the firewall refuses every other host. (`gh-aw` v1.0.1 runs Copilot offline behind its API proxy, where the
  native `web_fetch` tool does not exist.)
* opens a pull request only for the changes that a source corroborates. An earlier drift pull request stays open: the
  next run no longer lists its items, so closing it would drop them. A second run on the same day does not replace the
  first run's branch; its changes are filed as an issue instead. A run whose pull request has nothing committed fails,
  so it is not a baseline and its items come back in the next run. Whether an open pull request is a duplicate is decided
  by the `dedupe` block of `sdlc.yaml`: the branch prefixes and the labels of the target's own scheduled workflows, and the
  upkeep that each strategy does;
* files one issue in the target repository, `[sdlc-drift] Drift report: <projectKey> <date>`, when at least one item of
  the work list is recommended or could not be confirmed, or when a source could not be fetched or a possible gap could
  not be closed; otherwise it files none (the agent calls `noop` and says how many items it triaged). The report lists
  what is left to do, `## Recommended` and `## Could not confirm`, as task lists whose items name the change, the files
  and the source. Items that the pull request applies are listed there, not in the report, and the items that are not
  relevant are counted on one line of `## Summary` and never listed. No report closes an earlier one.

Filing a report starts its implementation. The drift workflow's `implement_report` job dispatches
`implement-<projectKey>` with the number of the report, using the job's `GITHUB_TOKEN`. That workflow reads the report
(the engine's `drift/read-report.mjs` checks that it is an open report of this project that the App filed and that no
implementation of it is open), researches every item under `## Recommended` and `## Could not confirm` again with
`curl` and the Microsoft Learn and Context7 servers, changes what the sources support, runs the project's build and
verification commands, and opens one pull request on `sdlc/implement-report-<number>` whose body ends with `Closes
#<number>`: merging it closes the report. When nothing survives the research, or a pull request of the target's own
schedule already covers the upkeep, it comments on the report instead, and on nothing else. Every dispatched run waits
its turn (`queue: max`). To implement a report by hand, or again after its pull request was closed, dispatch
`implement-<projectKey>` with `report_issue` set to the issue number (`dry_run: true` rehearses it). A dispatch finds the
workflow only on the default branch, so a new implementation workflow can be dispatched once it is merged. Do not
re-run a drift run that succeeded: a run is never its own baseline, so the re-run files the same items in a second
report, and they get a second implementation. Dispatch a new run instead.

A first run, or a run whose baseline artifact has expired, has no previous index: its work list holds the most recent
entries of each changelog, feed and release source, and pages are compared from the next run on. The artifact expires
after the `retention-days` that the compiler gives the upload step, `vars.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS` or, when
that variable is unset, the repository's artifact retention (90 days by default); keep it longer than the longest drift
schedule, a month for `drift-self-improving-agents`, or every run of that workflow starts without a baseline.
Dispatch a drift workflow
with `dry_run: true` to rehearse it without creating a branch, pull request or issue. A dry run is not a baseline, and it
keeps what it would have filed (the pull request under `proposal`, the drift report under `report`) in
`/tmp/gh-aw/agent/dry-run-proposal.json` on the runner, which no artifact includes: download the run's `agent` artifact
and read the agent's edit of that file in its session log, `sandbox/agent/logs/copilot-session-state/*/events.jsonl`.

## License

MIT. See the `LICENSE` file.
