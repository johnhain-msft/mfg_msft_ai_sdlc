---
on:
  schedule:
    - cron: 0 6 1 * *
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
    - fixture-app[bot]
concurrency:
  group: sdlc-drift-self-improving-agents
  cancel-in-progress: false
permissions:
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
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO"
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: ms-mfg-community/day-in-the-life-copilot-lab
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project self-improving-agents --checkout day-in-the-life-copilot-lab
post-steps:
  - name: node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve
    run: node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve
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
engine:
  id: copilot
  copilot-sdk: true
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
tools:
  web-fetch: {}
  bash:
    - cat
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

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before calling `create_pull_request`; skip when it lists a matching open pull request.
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
- GitHub Copilot documentation (docs): https://docs.github.com/en/copilot
- GitHub Agentic Workflows releases (release-notes): https://github.com/github/gh-aw/releases

## Package manifests

No package manifests are tracked for this project.

## Build commands

This project has no build commands.

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the upkeep when it lists a matching open pull request.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
