---
on:
  workflow_dispatch:
    inputs:
      correlation_id:
        description: Correlation id that links the dispatch, the run and any failure issue
        type: string
      upstream_repo:
        description: Upstream repository (owner/name) whose revision is cascaded
        type: string
      previous_sha:
        description: Previously merged upstream revision (40 lowercase hexadecimal characters)
        type: string
      upstream_sha:
        description: Upstream revision to cascade (40 lowercase hexadecimal characters)
        type: string
      upstream_etag:
        description: ETag of the upstream poll that observed upstream_sha
        type: string
      upstream_pr_number:
        description: Number of the merged upstream pull request, or empty
        type: string
      downstream_repo:
        description: Downstream repository (owner/name) that receives the pull request
        type: string
      dry_run:
        description: Empty, true or false; true forbids commits and pull requests
        type: string
  bots:
    - fixture-app[bot]
concurrency:
  group: sdlc-state-alpha-service
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
engine:
  id: copilot
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
network:
  allowed: []
checkout:
  - repository: globex-corp/beta-docs
    path: beta-docs
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
  - repository: acme-labs/alpha-service
    path: upstream/alpha-service
    ref: ${{ inputs.upstream_sha }}
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
steps:
  - name: Set up Node.js 24
    uses: actions/setup-node@v4
    with:
      node-version: "24"
  - name: Install dependencies (root)
    run: npm ci --include=dev
    working-directory: beta-docs
  - name: Install Microsoft Edge
    run: npx playwright install --with-deps msedge
    working-directory: beta-docs
pre-agent-steps:
  - name: Validate revisions and record the base revision
    env:
      UPSTREAM_SHA: ${{ inputs.upstream_sha }}
      PREVIOUS_SHA: ${{ inputs.previous_sha }}
    run: |-
      set -euo pipefail
      hex40='^[0-9a-f]{40}$'
      if ! [[ "$UPSTREAM_SHA" =~ $hex40 ]]; then echo "upstream_sha must be 40 lowercase hexadecimal characters" >&2; exit 2; fi
      if ! [[ "$PREVIOUS_SHA" =~ $hex40 ]]; then echo "previous_sha must be 40 lowercase hexadecimal characters" >&2; exit 2; fi
      BASE_SHA="$(git -C "$GITHUB_WORKSPACE/beta-docs" rev-parse HEAD)"
      mkdir -p /tmp/gh-aw
      echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt
      { echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-alpha-to-beta"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/alpha-service"; } >> "$GITHUB_ENV"
post-steps:
  - name: Record the base and head revisions
    run: |-
      set -euo pipefail
      BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"
      if ! [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then echo "base-sha.txt must hold 40 lowercase hexadecimal characters" >&2; exit 1; fi
      AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/beta-docs" rev-parse HEAD)"
      cat > /tmp/gh-aw/cascade-shas.json <<EOF
      {"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}
      EOF
      { echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"
  - name: Upload the cascade revisions
    uses: actions/upload-artifact@v4
    with:
      name: sdlc-cascade-shas-${{ github.run_id }}
      path: /tmp/gh-aw/cascade-shas.json
      if-no-files-found: error
  - name: Verify the downstream worktree is clean
    run: |-
      set -euo pipefail
      status="$(git -C "$GITHUB_WORKSPACE/beta-docs" status --porcelain)"
      if [ -n "$status" ]; then
        echo "worktree is not clean:" >&2
        echo "$status" >&2
        exit 1
      fi
  - name: Verify changed paths are covered by the allowed files
    run: |-
      set -euo pipefail
      changed="$(git -C "$GITHUB_WORKSPACE/beta-docs" diff --name-only "$BASE_SHA" HEAD)"
      allowed='^(docs/imported/.*)$'
      bad=0
      while IFS= read -r file; do
        [ -n "$file" ] || continue
        [[ "$file" =~ $allowed ]] || { echo "path outside the allowed files: $file" >&2; bad=1; }
      done <<< "$changed"
      exit "$bad"
  - name: npm run build
    run: npm run build
    working-directory: beta-docs
  - name: npm test
    run: npm test
    working-directory: beta-docs
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: globex-corp/beta-docs
    title-prefix: "chore(cascade): "
    labels:
      - automated
      - sdlc-cascade
      - needs-review
    reviewers:
      - globex-reviewer
    draft: false
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-cascade-alpha-to-beta
    if-no-changes: ignore
    auto-merge: false
    fallback-as-issue: false
    allowed-files:
      - docs/imported/**
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude: []
    max: 1
tools:
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
jobs:
  finalize_poll_state:
    needs:
      - agent
      - detection
      - safe_outputs
    if: success() && inputs.dry_run != 'true'
    permissions:
      issues: write
    steps:
      - id: app_token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }},beta-docs
          permission-contents: read
          permission-pull-requests: read
          permission-variables: write
      - uses: actions/checkout@v4
        with:
          token: ${{ steps.app_token.outputs.token }}
          sparse-checkout: |-
            src
            schemas
          persist-credentials: false
      - run: npm ci --ignore-scripts
      - uses: actions/download-artifact@v4
        with:
          name: sdlc-cascade-shas-${{ github.run_id }}
          path: /tmp/gh-aw
      - name: Export the base and head revisions
        run: |-
          set -euo pipefail
          BASE_SHA="$(jq -r .baseSha /tmp/gh-aw/cascade-shas.json)"
          AGENT_HEAD_SHA="$(jq -r .headSha /tmp/gh-aw/cascade-shas.json)"
          for value in "$BASE_SHA" "$AGENT_HEAD_SHA"; do
            [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { echo "cascade-shas.json holds a malformed revision" >&2; exit 1; }
          done
          { echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"
      - name: Update the poll state
        if: inputs.dry_run != 'true'
        env:
          GH_TOKEN: ${{ steps.app_token.outputs.token }}
          ISSUES_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          UPSTREAM_SHA: ${{ inputs.upstream_sha }}
          UPSTREAM_ETAG: ${{ inputs.upstream_etag }}
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug ALPHA_SERVICE --branch sdlc/cascade-alpha-to-beta --provenance-file docs/source.json --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"
  escalate_failure:
    needs:
      - agent
      - detection
      - safe_outputs
    if: failure() && inputs.dry_run != 'true'
    detection-gate: status-only
    permissions:
      issues: write
    steps:
      - id: app_token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }},beta-docs
          permission-contents: read
          permission-pull-requests: read
          permission-variables: write
      - uses: actions/checkout@v4
        with:
          token: ${{ steps.app_token.outputs.token }}
          sparse-checkout: |-
            src
            schemas
          persist-credentials: false
      - run: npm ci --ignore-scripts
      - name: Record the failure
        if: inputs.dry_run != 'true'
        env:
          GH_TOKEN: ${{ steps.app_token.outputs.token }}
          ISSUES_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          UPSTREAM_SHA: ${{ inputs.upstream_sha }}
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug ALPHA_SERVICE --target-sha "$UPSTREAM_SHA" --workflow-id cascade-mechanical-alpha-to-beta
---

# Mechanical cascade: alpha-to-beta

Import the upstream revision `$UPSTREAM_SHA` of `acme-labs/alpha-service` into the downstream checkout `beta-docs/` and open one pull request on `globex-corp/beta-docs`. Do exactly the three actions below, in this order, and nothing else.

1. Run the import from the downstream checkout:

```bash
cd "$GITHUB_WORKSPACE/beta-docs"
node scripts/import.mjs "$UPSTREAM_DIR"
```

2. Commit everything the import changed under the allowed paths:

```bash
git add docs/imported
git commit -m "chore(cascade): import alpha-service $UPSTREAM_SHA"
```

3. Call `create_pull_request` with exactly the branch `sdlc/cascade-alpha-to-beta`.

The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The verification commands run after you finish. Do not edit the upstream checkout, and do not publish branches yourself: the pull request is created only by the safe output.
