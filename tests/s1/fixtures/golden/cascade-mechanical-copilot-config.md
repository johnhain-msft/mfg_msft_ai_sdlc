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
    - mfg-msft-ai-sdlc[bot]
concurrency:
  group: sdlc-state-copilot-config
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
  - repository: johnhain-msft/ai_asset_management
    path: ai_asset_management
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - ai_asset_management
  - repository: johnhain-msft/copilot-config
    path: upstream/copilot-config
    ref: ${{ inputs.upstream_sha }}
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - copilot-config
steps:
  - name: Set up Python 3.12
    uses: actions/setup-python@v5
    with:
      python-version: "3.12"
  - name: Install dependencies (root)
    run: python -m pip install -e ".[dev]"
    working-directory: ai_asset_management
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
      BASE_SHA="$(git -C "$GITHUB_WORKSPACE/ai_asset_management" rev-parse HEAD)"
      mkdir -p /tmp/gh-aw
      echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt
      { echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-copilot-config"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/copilot-config"; } >> "$GITHUB_ENV"
post-steps:
  - name: Record the base and head revisions
    run: |-
      set -euo pipefail
      BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"
      if ! [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then echo "base-sha.txt must hold 40 lowercase hexadecimal characters" >&2; exit 1; fi
      AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/ai_asset_management" rev-parse HEAD)"
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
      status="$(git -C "$GITHUB_WORKSPACE/ai_asset_management" status --porcelain)"
      if [ -n "$status" ]; then
        echo "worktree is not clean:" >&2
        echo "$status" >&2
        exit 1
      fi
  - name: Verify changed paths are covered by the allowed files
    run: |-
      set -euo pipefail
      changed="$(git -C "$GITHUB_WORKSPACE/ai_asset_management" diff --name-only --no-renames "$BASE_SHA" HEAD)"
      allowed='^(assets/.*|governance/upstream-provenance\.json|governance/cowork-preferences-source\.md|\.github/CODEOWNERS)$'
      bad=0
      while IFS= read -r file; do
        [ -n "$file" ] || continue
        [[ "$file" =~ $allowed ]] || { echo "path outside the allowed files: $file" >&2; bad=1; }
      done <<< "$changed"
      exit "$bad"
  - name: Verify the import recorded the upstream revision
    env:
      PROVENANCE_FILE: governance/upstream-provenance.json
      PROVENANCE_POINTER: /commit
    run: |-
      set -euo pipefail
      node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const file = process.env.GITHUB_WORKSPACE + "/ai_asset_management/" + process.env.PROVENANCE_FILE;
      let value;
      try { value = JSON.parse(readFileSync(file, "utf8")); }
      catch { console.error("the import left no readable " + process.env.PROVENANCE_FILE); process.exit(1); }
      for (const key of process.env.PROVENANCE_POINTER.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) value = value?.[key];
      if (value !== process.env.UPSTREAM_SHA) {
        console.error("the import did not record " + process.env.UPSTREAM_SHA + " in " + process.env.PROVENANCE_FILE + " (it records " + JSON.stringify(value) + ")");
        process.exit(1);
      }
      '
  - name: aiam validate
    run: aiam validate
    working-directory: ai_asset_management
  - name: python -m pytest -q
    run: python -m pytest -q
    working-directory: ai_asset_management
  - name: aiam release build --out /tmp/aiam-verify-dist
    run: aiam release build --out /tmp/aiam-verify-dist
    working-directory: ai_asset_management
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    repositories:
      - ${{ github.event.repository.name }}
      - ai_asset_management
  report-failure-as-issue: false
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: johnhain-msft/ai_asset_management
    title-prefix: "chore(cascade): "
    labels:
      - automated
      - sdlc-cascade
      - needs-review
    reviewers:
      - johnhain-msft
    draft: false
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-cascade-copilot-config
    if-no-changes: ignore
    auto-merge: false
    fallback-as-issue: false
    allowed-files:
      - assets/**
      - governance/upstream-provenance.json
      - governance/cowork-preferences-source.md
      - .github/CODEOWNERS
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude:
        - /.github/CODEOWNERS
        - README.md
    max: 1
    max-patch-size: 10240
    max-patch-files: 1000
tools:
  bash:
    - aiam
    - cat
    - cd
    - date
    - echo
    - find
    - git
    - grep
    - head
    - ls
    - node
    - tail
    - wc
jobs:
  detection:
    if: needs.agent.result == 'success'
  safe_outputs:
    if: needs.agent.result == 'success'
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
          repositories: ${{ github.event.repository.name }},ai_asset_management
          permission-contents: read
          permission-pull-requests: read
          permission-actions-variables: write
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
          CORRELATION_ID: ${{ inputs.correlation_id }}
          UPSTREAM_ETAG: ${{ inputs.upstream_etag }}
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug COPILOT_CONFIG --branch sdlc/cascade-copilot-config --provenance-file governance/upstream-provenance.json --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"
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
          repositories: ${{ github.event.repository.name }},ai_asset_management
          permission-contents: read
          permission-pull-requests: read
          permission-actions-variables: write
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
          CORRELATION_ID: ${{ inputs.correlation_id }}
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug COPILOT_CONFIG --target-sha "$UPSTREAM_SHA" --workflow-id cascade-mechanical-copilot-config
---

# Mechanical cascade: copilot-config

Import the upstream revision `$UPSTREAM_SHA` of `johnhain-msft/copilot-config` into the downstream checkout `ai_asset_management/` and open one pull request on `johnhain-msft/ai_asset_management`. Do exactly the three actions below, in this order, and nothing else.

1. Run the import from the downstream checkout:

```bash
cd "$GITHUB_WORKSPACE/ai_asset_management"
aiam sync-upstream --from "$UPSTREAM_DIR"
```

2. Commit everything the import changed under the allowed paths:

```bash
git add .github/CODEOWNERS assets governance/cowork-preferences-source.md governance/upstream-provenance.json
git commit -m "chore(cascade): import copilot-config $UPSTREAM_SHA"
```

3. Call `create_pull_request` with exactly the branch `sdlc/cascade-copilot-config`.

The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The verification commands run after you finish. Do not edit the upstream checkout, and do not publish branches yourself: the pull request is created only by the safe output.
