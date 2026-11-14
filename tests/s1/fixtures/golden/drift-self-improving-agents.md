---
on:
  schedule:
    - cron: 11 6 1 * *
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
  group: sdlc-drift-self-improving-agents
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
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-self-improving-agents --upkeep-strategy code-quality-and-improvement-scan
  - name: Find the watch index of the previous run
    env:
      GH_TOKEN: ${{ github.token }}
    run: node "$GITHUB_WORKSPACE/src/drift/previous-watch-index.mjs" --out /tmp/gh-aw/agent --workflow drift-self-improving-agents.lock.yml --artifact sdlc-watch-index-self-improving-agents
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project self-improving-agents --checkout day-in-the-life-copilot-lab --previous /tmp/gh-aw/agent/previous
  - name: Upload the watch index
    if: inputs.dry_run != true
    uses: actions/upload-artifact@v4
    with:
      name: sdlc-watch-index-self-improving-agents
      path: /tmp/gh-aw/agent/sources/watch-index.json
      if-no-files-found: error
post-steps:
  - name: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/validate-copilot-lab-audit.mjs" "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" || { echo "src/validate-copilot-lab-audit.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/drift/lib" "$GITHUB_WORKSPACE/src/drift/lib" >&2 || { echo "src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve )
    run: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/validate-copilot-lab-audit.mjs" "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" || { echo "src/validate-copilot-lab-audit.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/drift/lib" "$GITHUB_WORKSPACE/src/drift/lib" >&2 || { echo "src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve )
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
    draft: true
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-drift-self-improving-agents
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
tools:
  web-fetch: {}
  bash:
    - cat
    - cd
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
          WORKFLOW_ID: drift-self-improving-agents
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
          WORKFLOW_FILE: implement-self-improving-agents.lock.yml
          REPORT_ISSUE: ${{ needs.safe_outputs.outputs.created_issue_number }}
          CORRELATION_ID: ${{ inputs.correlation_id || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
        run: gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"
---

# Upkeep: self-improving-agents

You maintain the repository `ms-mfg-community/day-in-the-life-copilot-lab`, checked out at `day-in-the-life-copilot-lab/` in the workspace. Work only inside that checkout and follow the registration instructions below.

## Registration instructions

Evaluate the lab's agents, skills and prompts for drift and propose only mechanical fixes with a self-improvement report.

You evaluate the lab's own AI building blocks (custom agents, skills and prompt files) for drift and propose only mechanical fixes. This follows the same detect, propose and let-a-human-merge shape as the registry audit, applied to the agent files. The run produces `self-improvement-report.md`, written to `docs/_meta/self-improvement-report.md` and attached in the pull request body.

## The five drift signals

Scan every agent, skill and prompt for these five signals, taken from the lab's own self-improvement workflow:

1. **Stale references**: a file path, command or convention that no longer exists or has moved. Check with `grep` and `find` against the current tree.
2. **Contradicted by recent human corrections**: recent merged review comments and commit messages that contradict an agent's stated instructions.
3. **Underused**: a skill or prompt that no recent session or pull request invoked; a candidate for consolidation, never silent neglect.
4. **Contradicts eval-harness conventions**: when an eval-harness directory exists, cross-check each agent or skill against its rubric.
5. **Duplicated responsibility**: two agents or skills that now cover materially the same scope; name the pair and do not merge them.

## What you may change

- Mechanical, low-risk fixes only: a stale file path, a command that no longer exists, a broken internal link inside an agent, skill or prompt file.
- Never rewrite an agent's core instructions, tone or scope, and never delete an agent, skill or prompt. Flag those for human review in the report.
- Never edit the lab's `.github/workflows/self-improving-agents.md` or its compiled `.lock.yml`.
- A check you cannot run is a limitation to record, not something to skip silently or to invent findings for.
- A watched source that `/tmp/gh-aw/agent/sources/manifest.json` lists as failed is a limitation too: record it in the `## Summary` section of the report and never guess what the source said.

## The report

`self-improvement-report.md` has these sections, in this order:

- `## Summary`: counts of agents, skills and prompts scanned, drift signals found per category, mechanical fixes applied and non-mechanical concerns flagged.
- `## Findings`: one subsection per drift signal, listing the file and what was found.
- `## Consolidation Candidates`: duplicated-responsibility pairs, named but not merged.
- `## Metadata`: run date, branch name and, if present, the content registry `schema_version`.

## Pull request

- The pull requests that this upkeep must not duplicate are the ones that the lab's own scheduled self-improvement run opens (`automation/self-improve-*`, labelled `self-improving-agents`). The operating rules at the end say what to do with each match that `/tmp/gh-aw/agent/open-pr-dedup.json` lists: your own earlier pull request is superseded when the new one is created, and a pull request of the lab's content audit is another upkeep.
- Name the working branch `self-improve-YYYY-MM-DD` with the current UTC date. The `sdlc/` prefix is added when the pull request is created; do not write it yourself. The pull request is a draft for a human to review.
- Write a copy of the report to `/tmp/gh-aw/agent/self-improvement-report.md` before you call `create_pull_request`.
- When nothing needs to change, record that outcome and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run.

- When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place.
- When `dry_run` is `true`, do not call `create_pull_request`. Do the same evaluation and write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) into `/tmp/gh-aw/agent/dry-run-proposal.json`.

## Upkeep strategy: code-quality-and-improvement-scan

Scan the target's code for quality improvements and produce suggestions; a project may open them as draft pull requests.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub changelog feed (feed): https://github.blog/changelog/feed/
- GitHub Copilot documentation (docs): https://docs.github.com/en/copilot
- GitHub Agentic Workflows releases (release-notes): https://github.com/github/gh-aw/releases

## What changed since the last run

Start with `/tmp/gh-aw/agent/sources/changes.md`. It compares this run's snapshots with the watch index of the last successful run (its first line names that run, or says that there is none and why) and lists the changelog, feed and release entries that are new since then, each once with the sources that list it, the pages and cited pages whose text changed, with the files of this repository that cite them, and the sources that could not be fetched.

When a source's first page lists none of the entries that the baseline knew, the snapshot step has read its older pages until one does, up to a limit; a source that still does not reach the baseline is listed under `## Possible gaps` with the period that neither run saw. Open the older pages of that source for that period yourself, decide those entries as well, and name the gap under `## Limitations` when you cannot.

That list is your work list, and every item of it gets a decision. Triage each item first from its title and excerpt: search this repository for the feature, setting or product that it names. Open, read and corroborate the items that touch something this repository covers or should cover, and fetch an entry or a page with the `web_fetch` tool whenever its excerpt is not enough to decide (the shell has no `curl`, `wget` or `gh`, and refuses a redirection or a heredoc; the hosts of the watched URLs and of the cited pages are reachable). An item that does not concern this repository is not relevant: count it, but do not list it in the report. A long list is no reason to skip items: decide each one.

## Drift report

File a drift report when at least one item of the work list is applied, recommended or could not be confirmed: exactly one `create_issue` call, which a human reads and which starts the implementation of the report as soon as it is filed: a run of the workflow `implement-self-improving-agents` researches every item under `## Recommended` and `## Could not confirm` again and opens one pull request that closes the report, starting from the report alone. Title it `Drift report: self-improving-agents YYYY-MM-DD` with the current UTC date (the `[sdlc-drift] ` prefix is added for you). When every item is not relevant, or the work list is empty, file no report: call `noop` with one line that says how many items you triaged and which baseline you compared with.

When the registration instructions above define a report of their own (such as `docs/_meta/audit-report.md` or `self-improvement-report.md`), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it; the body of the issue is that report followed by the sections below other than `## Summary`. Otherwise the body has these sections, in this order, and leaves out `## Applied`, `## Recommended` and `## Could not confirm` when they would be empty:

- `## Summary`: the baseline run, what changed upstream since then and what this run did, including the pull request that it opened, if any, and one line that counts the items that you triaged as not relevant (never list them).
- `## Applied`: the items that your pull request changes, each linked, with the files that it changes.
- `## Recommended`: a task list (`- [ ] `) of what this run did not change and should be changed: content that the sources announce and this repository does not cover yet (a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note), corrections and judgement calls. Each item says what to change, names the files that it concerns and links its source.
- `## Could not confirm`: a task list (`- [ ] `) of the claims that you could not corroborate, each with its source, what stopped you and the files that it would concern.
- `## Limitations`: the sources that could not be fetched, the possible gaps that you could not close and the checks that could not run.

Call `create_pull_request` before `create_issue` and name the pull request in the report. In a dry run call neither: `/tmp/gh-aw/agent/dry-run-proposal.json` exists already with `null` under `proposal` and `report`; replace the `null` of `report` with the report that you would have filed, `{ "title": ..., "body": ... }`, using the edit tool: the shell of this workflow refuses a redirection or a heredoc. Leave it `null` when you would have filed none.

## Package manifests

No package manifests are tracked for this project.

## Build commands

This project has no build commands.

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the pull request when it lists a matching open pull request that you must not duplicate (`duplicate` is `true`: a match whose `decision` is `skip`), and list what you would have changed under `## Recommended` of the drift report instead. A match whose `decision` is `supersede` is an earlier pull request of this same workflow, which your new pull request replaces (`close-older-pull-requests: true`), and a match whose `decision` is `ignore` is the pull request of another upkeep or of the implementation of an earlier report: neither is a reason to skip. Never open a duplicate.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: pull requests and issues are created only through the `create_pull_request` and `create_issue` safe outputs.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
