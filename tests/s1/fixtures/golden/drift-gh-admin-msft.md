---
on:
  schedule:
    - cron: 0 13 * * 1
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
  group: sdlc-drift-gh-admin-msft
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
network:
  allowed:
    - docs.github.com
    - github.blog
checkout:
  - repository: johnhain-msft/gh-admin-msft
    path: gh-admin-msft
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
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
      TARGET_REPO_INPUT: ${{ inputs.target_repo }}
      CORRELATION_ID: ${{ inputs.correlation_id }}
      EXTRA_INSTRUCTIONS: ${{ inputs.extra_instructions }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"
  - name: Deduplicate open pull requests
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
      APP_CLIENT_ID: ${{ vars.APP_CLIENT_ID }}
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO"
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project gh-admin-msft --checkout gh-admin-msft
post-steps:
  - name: npm ci
    run: npm ci
    working-directory: gh-admin-msft
  - name: node presentation/build.mjs
    run: node presentation/build.mjs
    working-directory: gh-admin-msft
  - name: test -z "$(git status --porcelain)"
    run: test -z "$(git status --porcelain)"
    working-directory: gh-admin-msft
  - name: npm run test:unit
    run: npm run test:unit
    working-directory: gh-admin-msft
  - name: npm run test:freshness
    run: npm run test:freshness
    working-directory: gh-admin-msft
  - name: npm run test:deck
    run: npm run test:deck
    working-directory: gh-admin-msft
  - name: npm test -- --skip-links
    run: npm test -- --skip-links
    working-directory: gh-admin-msft
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: johnhain-msft/gh-admin-msft
    title-prefix: "chore(sdlc-drift): "
    labels:
      - automated
      - sdlc-drift
      - needs-review
    reviewers:
      - johnhain-msft
    draft: false
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-drift-gh-admin-msft
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
    if: needs.agent.result == 'success'
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
          WORKFLOW_ID: drift-gh-admin-msft
          TARGET_REPO: johnhain-msft/gh-admin-msft
          CORRELATION_ID: ${{ inputs.correlation_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
---

# Upkeep: gh-admin-msft

You maintain the repository `johnhain-msft/gh-admin-msft`, checked out at `gh-admin-msft/` in the workspace. Work only inside that checkout and follow the registration instructions below.

## Registration instructions

Keep the GitHub Enterprise Cloud administration labs, reference documents and presenter material current against the watched changelogs and documentation.

You maintain the GitHub Enterprise Cloud (GHEC) administration material in this repository: the numbered labs, the reference and instructor documents, the migration business case and the presentation deck with its presenter script. Your job is to keep that material current with the sources the orchestrator watches for this project.

## What to do

1. Read the snapshots under `/tmp/gh-aw/agent/sources/` and the `manifest.json` beside them. A source that could not be fetched is a limitation to report, never something to guess.
2. Compare what the watched changelog and documentation pages now say with what the labs, reference documents and deck claim. Corroborate every proposed change through the Microsoft Learn and Context7 MCP servers or by fetching the cited page; do not change a claim on the strength of a single unverified mention.
3. Apply only the corrections that a corroborated source supports: renamed settings, moved navigation paths, changed limits or availability, retired features and broken or redirected links.
4. Rebuild the deck and the presenter script with the build command from the build step of this workflow and commit the rebuilt outputs together with your source edits.
5. Write a short change summary for the pull request body: each change, the source that supports it and anything you looked at but could not confirm.

## Limits

- Make mechanical, source-backed edits. Do not restructure labs, rename files, rewrite teaching prose for style or add new labs.
- Do not edit the repository's tests, validation scripts or generated files that the build overwrites; change the sources and rebuild.
- If a source contradicts the material but the right replacement is a judgement call, record it in the summary for a human and leave the text as it is.
- Name the working branch `weekly-audit-YYYY-MM-DD` with the current UTC date.
- When nothing needs to change, record that outcome and do not open a pull request.

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub Enterprise Cloud administration documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/admin

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`

## Build commands

Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:

```bash
node presentation/build.mjs
```

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the upkeep when it lists a matching open pull request.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
