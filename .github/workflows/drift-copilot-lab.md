---
on:
  schedule:
    - cron: 41 5 * * 0
  workflow_dispatch:
    inputs:
      target_repo:
        description: "Optional guard: must be empty or equal the configured target repository"
        type: string
      correlation_id:
        description: Correlation id recorded in run context and failure issues
        type: string
      extra_instructions:
        description: Extra instructions appended after the registration instructions
        type: string
      dry_run:
        description: When true, create no branch, pull request or issue
        type: boolean
        default: false
  bots:
    - mfg-msft-ai-sdlc[bot]
concurrency:
  group: sdlc-drift-copilot-lab
  cancel-in-progress: false
permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read
network:
  allowed:
    - docs.github.com
    - github.blog
    - github.com
checkout:
  - repository: ms-mfg-community/day-in-the-life-copilot-lab
    path: day-in-the-life-copilot-lab
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - day-in-the-life-copilot-lab
mcp-servers:
  context7:
    args:
      - -y
      - "@upstash/context7-mcp@latest"
    command: npx
  microsoft-learn:
    type: http
    url: https://learn.microsoft.com/api/mcp
pre-agent-steps:
  - name: Prepare run context
    env:
      CONFIGURED_TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
      TARGET_REPO_INPUT: ${{ inputs.target_repo }}
      CORRELATION_ID: ${{ inputs.correlation_id }}
      EXTRA_INSTRUCTIONS: ${{ inputs.extra_instructions }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"
  - name: Deduplicate open pull requests
    env:
      CONFIGURED_TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
      APP_CLIENT_ID: ${{ vars.APP_CLIENT_ID }}
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-copilot-lab --upkeep-strategy content-and-docs-sync
  - name: Find the watch index of the previous run
    env:
      GH_TOKEN: ${{ github.token }}
    run: node "$GITHUB_WORKSPACE/src/drift/previous-watch-index.mjs" --out /tmp/gh-aw/agent --workflow drift-copilot-lab.lock.yml --artifact sdlc-watch-index-copilot-lab
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project copilot-lab --checkout day-in-the-life-copilot-lab --previous /tmp/gh-aw/agent/previous
  - name: Upload the watch index
    if: inputs.dry_run != true
    uses: actions/upload-artifact@v4
    with:
      name: sdlc-watch-index-copilot-lab
      path: /tmp/gh-aw/agent/sources/watch-index.json
      if-no-files-found: error
post-steps:
  - name: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/validate-copilot-lab-audit.mjs" "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" || { echo "src/validate-copilot-lab-audit.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/drift/lib" "$GITHUB_WORKSPACE/src/drift/lib" >&2 || { echo "src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" )
    run: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/validate-copilot-lab-audit.mjs" "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" || { echo "src/validate-copilot-lab-audit.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/drift/lib" "$GITHUB_WORKSPACE/src/drift/lib" >&2 || { echo "src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" )
    working-directory: day-in-the-life-copilot-lab
  - name: ( set -euo pipefail; for f in tests/content-currency/registry-consumed.test.ts tests/lab-structure/lab10-contract.test.ts tests/workshop/time-budget.test.ts; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; GH_DATA_DIR="$(mktemp -d)"; export GH_DATA_DIR; XDG_DATA_HOME="$GH_DATA_DIR"; export XDG_DATA_HOME; gh extension install github/gh-aw --pin v0.86.2; npm ci; npm test )
    run: ( set -euo pipefail; for f in tests/content-currency/registry-consumed.test.ts tests/lab-structure/lab10-contract.test.ts tests/workshop/time-budget.test.ts; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; GH_DATA_DIR="$(mktemp -d)"; export GH_DATA_DIR; XDG_DATA_HOME="$GH_DATA_DIR"; export XDG_DATA_HOME; gh extension install github/gh-aw --pin v0.86.2; npm ci; npm test )
    env:
      GH_TOKEN: ${{ github.token }}
    working-directory: day-in-the-life-copilot-lab
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    repositories:
      - ${{ github.event.repository.name }}
      - day-in-the-life-copilot-lab
  report-failure-as-issue: false
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: ms-mfg-community/day-in-the-life-copilot-lab
    title-prefix: "chore(sdlc-drift): "
    labels:
      - automated
      - sdlc-drift
      - needs-review
    reviewers: []
    draft: false
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: false
    close-older-key: sdlc-drift-copilot-lab
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude: []
    auto-merge: false
    fallback-as-issue: true
    max: 1
    max-patch-size: 10240
  create-issue:
    target-repo: ms-mfg-community/day-in-the-life-copilot-lab
    title-prefix: "[sdlc-drift] "
    labels:
      - automated
      - sdlc-drift
      - drift-report
    close-older-issues: false
    max: 1
engine:
  id: copilot
  copilot-sdk: true
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
  args:
    - --allow-url
    - docs.github.com
    - --allow-url
    - github.blog
    - --allow-url
    - github.com
tools:
  web-fetch: {}
  bash:
    - cat
    - cd
    - curl
    - date
    - find
    - git
    - grep
    - head
    - ls
    - node
    - tail
    - wc
  edit: {}
jobs:
  detection:
    if: needs.agent.result == 'success'
  safe_outputs:
    if: needs.agent.result == 'success' && inputs.dry_run != true
  conclusion:
    if: inputs.dry_run != true
  escalate_failure:
    needs:
      - agent
      - detection
      - safe_outputs
    if: failure() && inputs.dry_run != true
    detection-gate: status-only
    permissions:
      actions: read
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |-
            src
            schemas
          persist-credentials: false
      - run: npm ci --ignore-scripts
      - name: Escalate gate failure
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          WORKFLOW_ID: drift-copilot-lab
          TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
          CORRELATION_ID: ${{ inputs.correlation_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
  implement_report:
    needs:
      - safe_outputs
    if: needs.safe_outputs.result == 'success' && needs.safe_outputs.outputs.created_issue_number != '' && inputs.dry_run != true
    permissions:
      actions: write
    steps:
      - name: Start the implementation of the drift report
        env:
          GH_TOKEN: ${{ github.token }}
          WORKFLOW_FILE: implement-copilot-lab.lock.yml
          REPORT_ISSUE: ${{ needs.safe_outputs.outputs.created_issue_number }}
          CORRELATION_ID: ${{ inputs.correlation_id || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
        run: gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"
---

# Upkeep: copilot-lab

You maintain the repository `ms-mfg-community/day-in-the-life-copilot-lab`, checked out at `day-in-the-life-copilot-lab/` in the workspace. Work only inside that checkout and follow the registration instructions below.

## Registration instructions

Audit the lab content registry and the lab content against the watched sources and propose only safe, mechanical updates.

You audit the content registry of the Day-in-the-Life Copilot Lab and the lab content that depends on it. The registry lives at `docs/_meta/registry.yaml`; treat it as the source of truth for what the labs claim is current. The report is `docs/_meta/audit-report.md`, generated fresh from `docs/_meta/audit-report.template.md` on every run.

## Read at run time, never assume

Before you propose anything, read `docs/_meta/registry.yaml` and work out from its own contents, and not from this text:

1. whether a freshness threshold is stated, and what it is;
2. where verification dates are recorded, and which of them is the latest;
3. whether a structured mapping from a claim to the files that consume it exists;
4. which consumers its comments name.

Do not hard-code a threshold, a date location or a claim-to-file mapping. Record in the `## Checks` section of the report each of these four points that you could not determine.

## What to check

Compare the registry and the labs with the snapshots under `/tmp/gh-aw/agent/sources/`: the Copilot CLI version floor, the `gh-aw` release notes, MCP servers and their catalogue, referenced documentation URLs, package versions from the manifests that were snapshotted, model names and lab pacing. Corroborate through the Microsoft Learn and Context7 MCP servers and by fetching the cited pages.

## Report-only and limits

- Treat `gh_aw_schema_version` as report-only. Report new `github/gh-aw` releases in `docs/_meta/audit-report.md`, and never change that value.
- Never edit, recompile or delete anything under `.github/workflows/`: the lab's compiled workflow files were built with a pinned compiler and are not yours to touch.
- Registry edits are for safe updates only: patch or minor SDK bumps, fixed redirected URLs and added in-scope MCP servers. Record major version changes and model-catalogue churn in the report only.
- Edit lab files mechanically only (for example a moved URL or a renamed product). Never rewrite prose.
- The pull requests that this upkeep must not duplicate are the ones that the lab's own scheduled audit opens (`automation/weekly-audit-*`, labelled `content-audit`). The operating rules at the end say what to do with each match that `/tmp/gh-aw/agent/open-pr-dedup.json` lists: your own earlier pull request stays open and is no reason to skip, and a pull request of the lab's self-improvement run is another upkeep.
- Name the working branch `weekly-audit-YYYY-MM-DD` with the current UTC date. The `sdlc/` prefix is added when the pull request is created; do not write it yourself.
- The report must keep its four required sections: `## Summary`, `## Checks`, `## Suggestions for Additions` and `## Metadata`.
- Read `/tmp/gh-aw/agent/sources/manifest.json`. A watched source that it lists as failed, and a package manifest pattern that matched no file, are limitations: record each in the `## Checks` section of the report and never guess what the source said.
- Write a copy of `docs/_meta/audit-report.md` to `/tmp/gh-aw/agent/audit-report.md` before you call `create_pull_request`.
- When nothing needs to change, record that outcome and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run.

- When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place.
- When `dry_run` is `true`, do not call `create_pull_request`. Do the same evaluation and write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) into `/tmp/gh-aw/agent/dry-run-proposal.json`.

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub changelog feed (feed): https://github.blog/changelog/feed/
- GitHub Agentic Workflows releases (release-notes): https://github.com/github/gh-aw/releases
- GitHub Copilot CLI releases (release-notes): https://github.com/github/copilot-cli/releases

The snapshot step also saved the text of the pages that this repository cites most: up to 60 pages on `docs.github.com` that files matching `README.md`, `labs/**/*.md`, `docs/**/*.md`, `solutions/**/*.md` and `workshop/**/*.md` link to, under `/tmp/gh-aw/agent/sources/cited/`. `manifest.json` lists each of them with the files that cite it.

## What changed since the last run

Start with `/tmp/gh-aw/agent/sources/changes.md`. It compares this run's snapshots with the watch index of the last successful run (its first line names that run, or says that there is none and why) and lists the changelog, feed and release entries that are new since then, each once with the sources that list it, the pages and cited pages whose text changed, with the files of this repository that cite them, and the sources that could not be fetched.

When a source's first page lists none of the entries that the baseline knew, the snapshot step has read its older pages until one does, up to a limit; a source that still does not reach the baseline is listed under `## Possible gaps` with the period that neither run saw. Open the older pages of that source for that period yourself, decide those entries as well, and name the gap under `## Limitations` when you cannot.

That list is your work list, and every item of it gets a decision. Triage each item first from its title and excerpt: search this repository for the feature, setting or product that it names. Open, read and corroborate the items that touch something this repository covers or should cover, and read an entry or a page with `curl --fail --silent --show-error --location <url>` whenever its excerpt is not enough to decide, piped into `grep` or `head` when the page is long: `curl` reaches the hosts of the watched URLs and of the cited pages and no other, there is no `web_fetch` tool, and the shell has no `wget` or `gh` and refuses a redirection or a heredoc. An item that does not concern this repository is not relevant: count it, but do not list it in the report. A long list is no reason to skip items: decide each one.

## Drift report

File a drift report when at least one item of the work list is recommended or could not be confirmed, or when this run has a limitation that a human has to know about: a source that could not be fetched, or a possible gap that you could not close. File it with exactly one `create_issue` call; a human reads it, and filing it starts its implementation: a run of the workflow `implement-copilot-lab` researches every item under `## Recommended` and `## Could not confirm` again and opens one pull request that closes the report, starting from the report alone. Title it `Drift report: copilot-lab YYYY-MM-DD` with the current UTC date (the `[sdlc-drift] ` prefix is added for you). When there is nothing of that kind (every item is not relevant or applied by your pull request, every source was fetched and every gap closed), file no report: call `noop` with one line that says how many items you triaged and which baseline you compared with. Your pull request lists the items that it applies; the report does not list them again.

When the registration instructions above define a report of their own (such as `docs/_meta/audit-report.md` or `self-improvement-report.md`), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it; the body of the issue is that report followed by the sections below other than `## Summary`. Otherwise the body has these sections, in this order, and leaves out `## Recommended` and `## Could not confirm` when they would be empty:

- `## Summary`: the baseline run, what changed upstream since then and what this run did, including the pull request that it opened, if any, and one line that counts the items that you triaged as not relevant (never list them).
- `## Recommended`: a task list (`- [ ] `) of what this run did not change and should be changed: content that the sources announce and this repository does not cover yet (a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note), corrections and judgement calls. Each item says what to change, names the files that it concerns and links its source.
- `## Could not confirm`: a task list (`- [ ] `) of the claims that you could not corroborate, each with its source, what stopped you and the files that it would concern.
- `## Limitations`: the sources that could not be fetched, the possible gaps that you could not close and the checks that could not run.

Call `create_pull_request` before `create_issue` and name the pull request in the report. In a dry run call neither: `/tmp/gh-aw/agent/dry-run-proposal.json` exists already with `null` under `proposal` and `report`; replace the `null` of `report` with the report that you would have filed, `{ "title": ..., "body": ... }`, using the edit tool: the shell of this workflow refuses a redirection or a heredoc. Leave it `null` when you would have filed none.

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`
- `node/package.json`
- `**/*.csproj`

## Build commands

This project has no build commands.

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the pull request when it lists a matching open pull request that you must not duplicate (`duplicate` is `true`: a match whose `decision` is `skip`), and list what you would have changed under `## Recommended` of the drift report instead. A match whose `decision` is `ignore` is an earlier pull request of this same workflow, which stays open and carries other items, the pull request of another upkeep or the implementation of an earlier report: none is a reason to skip. Never open a duplicate.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: pull requests and issues are created only through the `create_pull_request` and `create_issue` safe outputs.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
