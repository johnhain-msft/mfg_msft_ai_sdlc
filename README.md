# mfg_msft_ai_sdlc

A self-hostable, repository-agnostic AI SDLC orchestrator that runs entirely on GitHub: a GitHub App, GitHub Actions and
[`gh-aw`](https://github.com/github/gh-aw) (GitHub Agentic Workflows). No webhook server, no database and no
non-GitHub compute are involved.

The fleet is declared as data in `sdlc.yaml` (projects and the dependency edges between them). `src/reconcile.mjs`
turns that manifest into the generated workflows under `.github/workflows/`, and this package adds the two commands that
set the orchestrator up and point it at new repositories:

| Command | What it does |
|---|---|
| `node bin/sdlc-bootstrap.mjs` | Registers (or reuses) the GitHub App, verifies its installations, writes the Actions variables and secrets, hands `sdlc.yaml` to the reconciler and checks readiness. |
| `node bin/sdlc-onboard.mjs --repo <owner/repo-or-path>` | Inspects a repository and writes its `projects[]` and `dependencyEdges[]` entries and `instructions/<projectKey>.md`. |

## Prerequisite: gh-aw >= v1.0.1

Both commands refuse to run unless the local CLI reports **`gh-aw >= v1.0.1`**. Older releases are affected by
`GHSA-8h78-hpm7-29gg` (gh-aw `>= 0.83.3` and `< 0.85.4` wrote raw process output into the safe-outputs artifact, which can
expose CI trigger tokens). To upgrade:

```
gh extension install github/gh-aw        # or: gh extension upgrade gh-aw
gh aw upgrade                            # regenerates the .lock.yml files
```

Commit the regenerated `.lock.yml` files: upgrading the CLI alone does not replace the SHA-pinned action references in
existing lock files.

## Install as a gh-aw package

The repository is a `gh-aw` package (`aw.yml`). Consumers install the onboarding workflow with either form:

```
gh aw add owner/repo
gh aw add owner/repo/path/to/package
```

## Quick start

Fork or copy this repository, clone it, run `npm ci`, and then:

```
node bin/sdlc-bootstrap.mjs
node bin/sdlc-onboard.mjs --repo <owner/repo-or-path>
```

The bootstrap opens one browser confirmation (the GitHub App registration) and one installation page per target account.
Nothing is ever placed in a file, a command-line flag or a log: secrets come from the environment or a prompt that does
not echo.

## Bootstrap

```
node bin/sdlc-bootstrap.mjs [--manifest sdlc.yaml] [--owner <user-or-org>] [--app-name <up to 34 characters>]
  [--engine copilot|claude|codex|gemini|pi] [--deconflict-upstream-schedules] [--non-interactive]
```

* The central orchestrator repository is `<owner>/<repo>` of the `origin` remote of the working copy that holds
  `--manifest`; no repository name is hard-coded.
* **Existing App:** with both `APP_CLIENT_ID` and `APP_PRIVATE_KEY` in the environment no App is registered; `appId` and
  `appSlug` come from `GET /app`, authenticated with a JSON Web Token signed by the key. `--non-interactive` requires this
  (it never starts a listener or opens a browser).
* **New App:** a short-lived listener on `127.0.0.1` (an operating-system assigned port) serves `/register` and
  `/callback`, the browser posts the manifest to GitHub, and the temporary code is exchanged once for the App. The App's
  permissions are exactly `bin/lib/app-permissions.json`; an App or installation that holds a key or a level above that
  map is rejected. `SDLC_BOOTSTRAP_NO_OPEN_BROWSER` keeps the browser closed (the URL is printed).
* **Installations:** every required repository (the central repository, every drift-enabled project and every downstream
  repository) must be covered by an installation that holds the permission map. Every `downstreamRepo` must share the
  owner of the central repository, because one installation token is scoped to one owner.
* **Variables:** `APP_CLIENT_ID` is upserted; `SDLC_SYNC_STATE_<SLUG>` is created for each edge only when it does not
  exist (`404`) and is seeded from the edge's `initialBaselineSha`.
* **Secrets:** `APP_PRIVATE_KEY` and the engine credential (`COPILOT_GITHUB_TOKEN` for a PAT, or the engine's API key from
  `bin/lib/engine-secrets.json`) are encrypted locally as libsodium sealed boxes before upload. A value that contains
  `gho_` (the OAuth token of `gh auth login`) is rejected.
* **Deconfliction (opt-in):** only with `--deconflict-upstream-schedules` and only for upstreams whose
  `deconflictInRepoSchedules` is `disable-workflow-schedules`, the workflow IDs listed in `sdlc.yaml` are disabled with
  `gh workflow disable` under your own credentials. Nothing else is sent to an upstream repository.
* Afterwards `src/reconcile.mjs` validates the manifest and compiles the workflows (`gh aw compile --strict --purge
  --json`), then `gh aw validate` and `gh aw doctor` run.

Progress goes to stderr. A run that reaches the readiness checks prints exactly one `BootstrapSummaryReport` JSON
document (`schemas/bootstrap-summary-report.schema.json`) on stdout and exits non-zero when `doctorStatus` is `fail`.

### Environment

| Variable | Used for |
|---|---|
| `APP_CLIENT_ID`, `APP_PRIVATE_KEY` | An existing GitHub App (both, or neither). |
| `COPILOT_GITHUB_TOKEN` | A fine-grained PAT owned by a user account; without it `--engine copilot` uses the Actions token (`copilot-requests`). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY` | The API key of the selected engine. |
| `GH_TOKEN` / `GITHUB_TOKEN` | The REST credential for variables and secrets (default: `gh auth token`). It needs the `Variables` and `Secrets` repository permissions (write). |
| `GITHUB_API_URL` | API base URL (default `https://api.github.com`; plain `http` only for loopback addresses). |
| `SDLC_BOOTSTRAP_NO_OPEN_BROWSER` | Do not open a browser; print the URLs. |

## Onboard

```
node bin/sdlc-onboard.mjs --repo <owner/repo-or-path> [--downstream <owner/repo>]
  [--strategy auto|content-and-docs-sync|dependency-and-pattern-modernization|code-quality-and-improvement-scan|custom]
  [--watch-url <url>]... [--schedule <cron>] [--mode auto|mechanical|ai-adaptation]
  [--instructions <text-or-path>] [--manifest sdlc.yaml]
```

The repository may also be given as one positional `<owner/repo>`. Without `--schedule` the project's upkeep runs on
Mondays at 06:23 UTC (`23 6 * * 1`), off the top of the hour (see "Change detection: the router polls"). The command inspects the target read-only
(`package.json` and other language manifests, `.github/workflows/`, test and build scripts, provenance files and
`.github/CODEOWNERS`), then writes the project entry, an optional dependency edge and `instructions/<projectKey>.md`. It never
invents a command: a command is only written when it is a script of the target's manifest. Existing entries are preserved
byte for byte; re-onboarding changes only the fields whose flags you pass. `sdlc.yaml` is then validated and the
workflows are recompiled through `src/reconcile.mjs`, and the new edge's `SDLC_SYNC_STATE_<SLUG>` variable is created
if missing. `.github/workflows/sdlc-onboard.md`, a workflow with one `workflow_dispatch` input per flag, tells its agent to run the same
command and to open a pull request that a human must review and merge: `auto-merge` is never enabled. As SPEC-01 renders it
today that workflow installs neither the `gh aw` CLI nor the npm dependencies and passes `APP_CLIENT_ID` and
`APP_PRIVATE_KEY` only to its token-minting steps, so its agent cannot run the command yet (open question OQ51 in
`specs/05-packaging-bootstrap-and-governance.md`); run the command from a working copy of this repository, as above.

A `--downstream` repository must be under the same owner as this repository; the check is repeated on the name that GitHub
resolves it to, so a transferred or renamed repository under another owner is refused. `--instructions` is read as a file
only when the value is an existing file inside this working copy; a file outside it, a file that is a secret by name
(`.env*`, `*.pem`, `id_rsa`, `credentials`, ...) and any text that holds a credential are refused before anything is written.
An update that cannot be made in place, such as a field that a YAML alias supplies, is refused as well, with the file left
as it was, instead of rewriting the file.

The onboarding command needs `APP_CLIENT_ID` and `APP_PRIVATE_KEY` (to resolve the App slug for the reconciler) and the
same engine credential environment as the bootstrap, because the engine authentication mode is part of what the
reconciler renders.

A target without a `test` script gets an empty `verifyCommands` and a warning. A drift-enabled project needs at least one
verify command, so the reconciler then rejects the entry (`drift-verify-commands-missing`) and the command puts
`sdlc.yaml` and `instructions/<projectKey>.md` back as they were. Add a `test` script to the target, or write the project's
entry in `sdlc.yaml` yourself with its `verifyCommands`; a later run keeps what you wrote.

## Sync state and resets

`SDLC_SYNC_STATE_<SLUG>` variables are owned by `cascade-router.yml`; the bootstrap and onboarding commands only create
a missing one. A blocked sync state is reset only by dispatching `cascade-router.yml` with `reset_blocked: true`, never
by editing a `SDLC_SYNC_STATE_<SLUG>` variable.

## Change detection: the router polls

`cascade-router.yml` polls every upstream of `sdlc.yaml` on the schedules of its edges (`17 */6 * * *` in the preset:
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

## Drift upkeep: what the agent sees and what it reports

Each `drift-<projectKey>` workflow, on its schedule or dispatched by hand:

* snapshots the project's `watchUrls` (changelog indexes and feeds, the Atom feeds of release pages, documentation pages)
  and, with `knowledgeSources.citedPages` (`include` patterns, `hosts`, `maxPages`), the documentation pages that the
  target's own files cite most;
* compares those snapshots with the watch index of the last successful run that was not a dry run (the run artifact
  `sdlc-watch-index-<projectKey>`, kept as long as the repository keeps artifacts) and gives the agent a work list,
  `changes.md`: the entries that are new since then and the pages that changed, with the files that cite them;
* files one issue in the target repository on every run that is not a dry run, `[sdlc-drift] Drift report: <projectKey>
  <date>`, with a decision on every item of the work list and a `## Recommendations` section for what the sources announce
  and the target does not cover yet, and opens a pull request only for the changes that a source corroborates. Each report
  closes the previous report of the same workflow.

A first run, or a run whose baseline artifact has expired, has no previous index: its work list holds the most recent
entries of each changelog, feed and release source, and pages are compared from the next run on. Dispatch a drift workflow
with `dry_run: true` to rehearse it without creating a branch, pull request or issue.

## Tests

```
npm test                       # tests/s1 and tests/s5, offline
node --test tests/s5/*.test.mjs
```

The S5 suites are hermetic: a no-network guard, an in-memory fake GitHub API, a fake `gh` and a recording reconciler stand
in for everything outside the process. `SDLC_REAL_GH_AW=1 npm test` also runs the checks that need the real gh-aw CLI
(v1.0.1 or newer): the real compiler on `aw.yml` and on the onboarding workflow. One test is reported as `todo` on purpose:
`AC53 (gated by OQ51)` asserts what the onboarding workflow needs in order to run its own instruction and fails until
SPEC-01 renders it (see Onboard above).

## Layout

| Path | Owner |
|---|---|
| `sdlc.yaml`, `schemas/sdlc.schema.json`, `src/reconcile.mjs`, `.github/workflows/**` | The manifest and reconciler (S1). |
| `aw.yml`, `README.md`, `bin/`, `schemas/bootstrap-summary-report.schema.json`, `tests/s5/` | Packaging and bootstrap (S5). |
