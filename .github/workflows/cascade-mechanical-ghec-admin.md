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
  group: sdlc-state-gh-admin-msft
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
  - repository: johnhain-msft/portfolio
    path: portfolio
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - portfolio
  - repository: johnhain-msft/gh-admin-msft
    path: upstream/gh-admin-msft
    ref: ${{ inputs.upstream_sha }}
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - gh-admin-msft
steps:
  - name: Set up Node.js 24
    uses: actions/setup-node@v4
    with:
      node-version: "24"
  - name: Install dependencies (root)
    run: npm ci --include=dev
    working-directory: portfolio
  - name: Install dependencies (apps/lab-studio)
    run: npm ci --include=dev
    working-directory: portfolio/apps/lab-studio
  - name: Install Microsoft Edge
    run: npx playwright install --with-deps msedge
    working-directory: portfolio
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
      BASE_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"
      mkdir -p /tmp/gh-aw
      echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt
      { echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-ghec-admin"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/gh-admin-msft"; } >> "$GITHUB_ENV"
post-steps:
  - name: Record the base and head revisions
    run: |-
      set -euo pipefail
      BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"
      if ! [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then echo "base-sha.txt must hold 40 lowercase hexadecimal characters" >&2; exit 1; fi
      AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"
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
      status="$(git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain)"
      if [ -n "$status" ]; then
        echo "worktree is not clean:" >&2
        echo "$status" >&2
        exit 1
      fi
  - name: Verify changed paths are covered by the allowed files
    run: |-
      set -euo pipefail
      changed="$(git -C "$GITHUB_WORKSPACE/portfolio" diff --name-only --no-renames "$BASE_SHA" HEAD)"
      allowed='^(public/ghec-admin/.*)$'
      bad=0
      while IFS= read -r file; do
        [ -n "$file" ] || continue
        [[ "$file" =~ $allowed ]] || { echo "path outside the allowed files: $file" >&2; bad=1; }
      done <<< "$changed"
      exit "$bad"
  - name: Verify the import recorded the upstream revision
    env:
      PROVENANCE_FILE: public/ghec-admin/source.json
      PROVENANCE_POINTER: /commit
    run: |-
      set -euo pipefail
      node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const file = process.env.GITHUB_WORKSPACE + "/portfolio/" + process.env.PROVENANCE_FILE;
      let value;
      try { value = JSON.parse(readFileSync(file, "utf8")); }
      catch { console.error("the import left no readable " + process.env.PROVENANCE_FILE); process.exit(1); }
      for (const key of process.env.PROVENANCE_POINTER.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) value = value?.[key];
      if (value !== process.env.UPSTREAM_SHA) {
        console.error("the import did not record " + process.env.UPSTREAM_SHA + " in " + process.env.PROVENANCE_FILE + " (it records " + JSON.stringify(value) + ")");
        process.exit(1);
      }
      '
  - name: npm run build
    run: npm run build
    working-directory: portfolio
  - name: STUDIO_ORIGIN=https://studio.example.com npm run build:catalog
    run: STUDIO_ORIGIN=https://studio.example.com npm run build:catalog
    working-directory: portfolio
  - name: npm run typecheck
    run: npm run typecheck
    working-directory: portfolio
  - name: npm run lint
    run: npm run lint
    working-directory: portfolio
  - name: npm test
    run: npm test
    working-directory: portfolio
  - name: npm run test:studio
    run: npm run test:studio
    working-directory: portfolio
  - name: npm run test:browser
    run: npx playwright test tests/browser/sites.spec.ts
    working-directory: portfolio
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    repositories:
      - ${{ github.event.repository.name }}
      - portfolio
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: johnhain-msft/portfolio
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
    close-older-key: sdlc-cascade-ghec-admin
    if-no-changes: ignore
    auto-merge: false
    fallback-as-issue: false
    allowed-files:
      - public/ghec-admin/**
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude: []
    max: 1
tools:
  bash:
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
    - npm
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
          repositories: ${{ github.event.repository.name }},portfolio
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
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug GH_ADMIN_MSFT --branch sdlc/cascade-ghec-admin --provenance-file public/ghec-admin/source.json --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"
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
          repositories: ${{ github.event.repository.name }},portfolio
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
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug GH_ADMIN_MSFT --target-sha "$UPSTREAM_SHA" --workflow-id cascade-mechanical-ghec-admin
---

# Mechanical cascade: ghec-admin

Import the upstream revision `$UPSTREAM_SHA` of `johnhain-msft/gh-admin-msft` into the downstream checkout `portfolio/` and open one pull request on `johnhain-msft/portfolio`. Do exactly the three actions below, in this order, and nothing else.

1. Run the import from the downstream checkout:

```bash
cd "$GITHUB_WORKSPACE/portfolio"
npm run import:ghec-admin -- "$UPSTREAM_DIR"
```

2. Commit everything the import changed under the allowed paths:

```bash
git add public/ghec-admin
git commit -m "chore(cascade): import gh-admin-msft $UPSTREAM_SHA"
```

3. Call `create_pull_request` with exactly the branch `sdlc/cascade-ghec-admin`.

The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The verification commands run after you finish. Do not edit the upstream checkout, and do not publish branches yourself: the pull request is created only by the safe output.
