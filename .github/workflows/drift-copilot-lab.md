---
on:
  schedule:
    - cron: 30 5 * * 0
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
  group: sdlc-drift-copilot-lab
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
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project copilot-lab --checkout day-in-the-life-copilot-lab
post-steps:
  - name: node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"
    run: node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"
    working-directory: day-in-the-life-copilot-lab
  - name: ( set -euo pipefail; for f in tests/content-currency/registry-consumed.test.ts tests/lab-structure/lab10-contract.test.ts tests/workshop/time-budget.test.ts; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; GH_DATA_DIR="$(mktemp -d)"; export GH_DATA_DIR; gh extension install github/gh-aw --pin v0.86.2; npm ci; npm test )
    run: ( set -euo pipefail; for f in tests/content-currency/registry-consumed.test.ts tests/lab-structure/lab10-contract.test.ts tests/workshop/time-budget.test.ts; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; GH_DATA_DIR="$(mktemp -d)"; export GH_DATA_DIR; gh extension install github/gh-aw --pin v0.86.2; npm ci; npm test )
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
    draft: false
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-drift-copilot-lab
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
  escalate_failure:
    needs:
      - agent
      - detection
      - safe_outputs
    if: failure() && inputs.dry_run != true
    detection-gate: status-only
    permissions:
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
- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before calling `create_pull_request`. If it lists a matching open pull request, skip the upkeep or let your own earlier pull request be superseded; never open a duplicate.
- Name the working branch `weekly-audit-YYYY-MM-DD` with the current UTC date.
- The report must keep its four required sections: `## Summary`, `## Checks`, `## Suggestions for Additions` and `## Metadata`.
- When nothing needs to change, record that outcome and do not open a pull request.

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub Copilot documentation (docs): https://docs.github.com/en/copilot
- GitHub Agentic Workflows releases (release-notes): https://github.com/github/gh-aw/releases
- GitHub Copilot CLI releases (release-notes): https://github.com/github/copilot-cli/releases

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`
- `node/package.json`
- `**/*.csproj`

## Build commands

This project has no build commands.

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the upkeep when it lists a matching open pull request.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
