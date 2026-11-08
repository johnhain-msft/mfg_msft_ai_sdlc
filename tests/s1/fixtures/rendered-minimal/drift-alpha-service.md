---
on:
  schedule:
    - cron: 15 4 * * 2
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
  group: sdlc-drift-alpha-service
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
network:
  allowed:
    - example.org
checkout:
  - repository: acme-labs/alpha-service
    path: alpha-service
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
mcp-servers: {}
pre-agent-steps:
  - name: Prepare run context
    env:
      CONFIGURED_TARGET_REPO: acme-labs/alpha-service
      TARGET_REPO_INPUT: ${{ inputs.target_repo }}
      CORRELATION_ID: ${{ inputs.correlation_id }}
      EXTRA_INSTRUCTIONS: ${{ inputs.extra_instructions }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"
  - name: Deduplicate open pull requests
    env:
      CONFIGURED_TARGET_REPO: acme-labs/alpha-service
      APP_CLIENT_ID: ${{ vars.APP_CLIENT_ID }}
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO"
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: acme-labs/alpha-service
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project alpha-service --checkout alpha-service
post-steps:
  - name: npm ci
    run: npm ci
    working-directory: alpha-service
  - name: npm test
    run: npm test
    working-directory: alpha-service
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: acme-labs/alpha-service
    title-prefix: "chore(sdlc-drift): "
    labels:
      - automated
      - sdlc-drift
      - needs-review
    reviewers:
      - acme-reviewer
    draft: true
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-drift-alpha-service
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
    - npm
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
          WORKFLOW_ID: drift-alpha-service
          TARGET_REPO: acme-labs/alpha-service
          CORRELATION_ID: ${{ inputs.correlation_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
---

# Upkeep: alpha-service

You maintain the repository `acme-labs/alpha-service`, checked out at `alpha-service/` in the workspace. Work only inside that checkout and follow the registration instructions below.

## Registration instructions

Keep the service documentation and its dependency pins current.

## Upkeep strategy: dependency-and-pattern-modernization

Evaluate the package manifest snapshots for library and framework upgrades and pattern migrations (for example 17 -> 18) using the Context7 documentation server.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- Example releases (release-notes): https://example.org/releases

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`

## Build commands

Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:

```bash
npm run build
```

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the upkeep when it lists a matching open pull request.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
