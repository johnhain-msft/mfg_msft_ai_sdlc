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
      sync_scope:
        description: Which part of the downstream surface to adapt
        type: string
      on_commit_only_advance:
        description: "Behaviour when only the upstream commit advanced: noop or bump-provenance"
        type: string
      dry_run:
        description: Empty, true or false; true forbids commits and pull requests
        type: string
  bots:
    - fixture-app[bot]
concurrency:
  group: sdlc-state-pipeline-showcase
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
  allowed:
    - api.github.com
checkout:
  - repository: johnhain-msft/portfolio
    path: portfolio
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
  - repository: ms-mfg-community/github-pipeline-showcase
    path: upstream/github-pipeline-showcase
    ref: ${{ inputs.upstream_sha }}
    fetch-depth: 0
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
    working-directory: portfolio
  - name: Install dependencies (apps/lab-studio)
    run: npm ci --include=dev
    working-directory: portfolio/apps/lab-studio
  - name: Install Microsoft Edge
    run: npx playwright install --with-deps msedge
    working-directory: portfolio
pre-agent-steps:
  - name: Validate dispatch inputs and checkouts
    env:
      CORRELATION_ID: ${{ inputs.correlation_id }}
      UPSTREAM_REPO_INPUT: ${{ inputs.upstream_repo }}
      PREVIOUS_SHA: ${{ inputs.previous_sha }}
      UPSTREAM_SHA: ${{ inputs.upstream_sha }}
      UPSTREAM_ETAG: ${{ inputs.upstream_etag }}
      UPSTREAM_PR_NUMBER: ${{ inputs.upstream_pr_number }}
      DOWNSTREAM_REPO_INPUT: ${{ inputs.downstream_repo }}
      SYNC_SCOPE: ${{ inputs.sync_scope }}
      ON_COMMIT_ONLY_ADVANCE: ${{ inputs.on_commit_only_advance }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: |-
      set -euo pipefail
      fail() { echo "$1" >&2; exit 2; }
      hex40='^[0-9a-f]{40}$'
      [[ "$UPSTREAM_SHA" =~ $hex40 ]] || fail "upstream_sha must be 40 lowercase hexadecimal characters"
      [[ "$PREVIOUS_SHA" =~ $hex40 ]] || fail "previous_sha must be 40 lowercase hexadecimal characters"
      case "$SYNC_SCOPE" in showcase-runs) ;; *) fail "sync_scope is not accepted by this workflow: $SYNC_SCOPE" ;; esac
      case "$ON_COMMIT_ONLY_ADVANCE" in noop|bump-provenance) ;; *) fail "on_commit_only_advance must be noop or bump-provenance" ;; esac
      [ "$DOWNSTREAM_REPO_INPUT" = "johnhain-msft/portfolio" ] || fail "downstream_repo must be johnhain-msft/portfolio"
      [ "$UPSTREAM_REPO_INPUT" = "ms-mfg-community/github-pipeline-showcase" ] || fail "upstream_repo must be ms-mfg-community/github-pipeline-showcase"
      case "$DRY_RUN" in ""|true|false) ;; *) fail "dry_run must be empty, true or false" ;; esac
      [ "$(git -C "$GITHUB_WORKSPACE/upstream/github-pipeline-showcase" rev-parse HEAD)" = "$UPSTREAM_SHA" ] || fail "the upstream checkout is not at upstream_sha"
      git -C "$GITHUB_WORKSPACE/upstream/github-pipeline-showcase" cat-file -e "$PREVIOUS_SHA^{commit}" || fail "the upstream checkout does not contain previous_sha"
      echo "DRY_RUN=$DRY_RUN" >> "$GITHUB_ENV"
  - name: Record the base revision and the dispatch evidence
    env:
      CORRELATION_ID: ${{ inputs.correlation_id }}
      UPSTREAM_REPO_INPUT: ${{ inputs.upstream_repo }}
      PREVIOUS_SHA: ${{ inputs.previous_sha }}
      UPSTREAM_SHA: ${{ inputs.upstream_sha }}
      UPSTREAM_ETAG: ${{ inputs.upstream_etag }}
      UPSTREAM_PR_NUMBER: ${{ inputs.upstream_pr_number }}
      DOWNSTREAM_REPO_INPUT: ${{ inputs.downstream_repo }}
      SYNC_SCOPE: ${{ inputs.sync_scope }}
      ON_COMMIT_ONLY_ADVANCE: ${{ inputs.on_commit_only_advance }}
      DRY_RUN: ${{ inputs.dry_run }}
      GH_TOKEN: ${{ github.token }}
    run: |-
      set -euo pipefail
      BASE_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"
      mkdir -p /tmp/gh-aw /tmp/gh-aw/agent
      echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt
      { echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-pipeline-showcase"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/github-pipeline-showcase"; } >> "$GITHUB_ENV"
      git -C "$GITHUB_WORKSPACE/upstream/github-pipeline-showcase" diff --name-status "$PREVIOUS_SHA" "$UPSTREAM_SHA" > /tmp/gh-aw/agent/upstream-diff.txt
      node --input-type=module -e 'import { writeFileSync } from "node:fs"; const e = process.env; writeFileSync("/tmp/gh-aw/agent/dispatch-inputs.json", JSON.stringify({ correlation_id: e.CORRELATION_ID, upstream_repo: e.UPSTREAM_REPO_INPUT, previous_sha: e.PREVIOUS_SHA, upstream_sha: e.UPSTREAM_SHA, upstream_etag: e.UPSTREAM_ETAG, upstream_pr_number: e.UPSTREAM_PR_NUMBER, downstream_repo: e.DOWNSTREAM_REPO_INPUT, sync_scope: e.SYNC_SCOPE, on_commit_only_advance: e.ON_COMMIT_ONLY_ADVANCE, dry_run: e.DRY_RUN }, null, 2) + "\n");'
      if pulls="$(gh api "repos/johnhain-msft/portfolio/pulls?state=open&head=johnhain-msft:sdlc/cascade-pipeline-showcase" --jq '.[0] // null' 2>/dev/null)"; then
        printf '%s\n' "$pulls" > /tmp/gh-aw/agent/existing-pr.json
      else
        echo null > /tmp/gh-aw/agent/existing-pr.json
      fi
  - name: Capture the drift reports
    working-directory: portfolio
    run: |-
      set -uo pipefail
      mkdir -p /tmp/gh-aw/agent
      TARGET_SHA="$UPSTREAM_SHA"
      LAST_MERGED_SHA="$PREVIOUS_SHA"
      export TARGET_SHA LAST_MERGED_SHA
      set +e
      ( gh api "repos/ms-mfg-community/github-pipeline-showcase/actions/runs?per_page=100" ) > /tmp/gh-aw/agent/preflight-1.txt 2>&1
      rc1=$?
      set -e
      printf 'preflight exit codes: %s\n' "$rc1" > /tmp/gh-aw/agent/preflight-exit-codes.txt
      for rc in "$rc1"; do
        if [ "$rc" -ge 2 ]; then echo "a preflight command failed with exit code $rc" >&2; exit 2; fi
      done
    env:
      GH_TOKEN: ${{ github.token }}
  - name: Verify the downstream worktree is read-only so far
    run: |-
      set -euo pipefail
      status="$(git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain)"
      if [ -n "$status" ]; then echo "the downstream worktree is not clean:" >&2; echo "$status" >&2; exit 1; fi
      [ "$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)" = "$BASE_SHA" ] || { echo "the downstream HEAD moved" >&2; exit 1; }
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
  - name: node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow cascade-ai-pipeline-showcase
    run: node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow cascade-ai-pipeline-showcase
  - name: npm run build:workshop
    run: npm run build:workshop
    working-directory: portfolio
  - name: npm run build:experiences
    run: npm run build:experiences
    working-directory: portfolio
  - name: git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain
    run: |-
      set -euo pipefail
      status="$(git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain)"
      if [ -n "$status" ]; then
        echo "worktree is not clean:" >&2
        echo "$status" >&2
        exit 1
      fi
    working-directory: portfolio
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
    run: npm run test:browser
    working-directory: portfolio
  - name: "post-run check: a dry run must not leave a commit"
    run: |-
      # post-run check: a dry run must not leave a commit
      if [ "${DRY_RUN:-}" = "true" ] && [ "$AGENT_HEAD_SHA" != "$BASE_SHA" ]; then
        echo "dry_run is true but the agent committed $BASE_SHA..$AGENT_HEAD_SHA" >&2
        exit 1
      fi
    working-directory: portfolio
  - name: "post-run check: a changed RUNS list needs a re-captured run-data.json"
    run: |-
      # post-run check: a changed RUNS list needs a re-captured run-data.json
      node --input-type=module -e '
      import { execFileSync } from "node:child_process";
      const root = process.env.GITHUB_WORKSPACE + "/portfolio";
      const script = "experiences/pipeline-showcase/capture/fetch-run-data.mjs";
      const data = "experiences/pipeline-showcase/content/run-data.json";
      const show = (rev, file) => {
        try { return execFileSync("git", ["-C", root, "show", rev + ":" + file], { encoding: "utf8" }); }
        catch { return ""; }
      };
      const ids = (source) => {
        const block = source.match(/const RUNS = \[([\s\S]*?)\n\];/);
        return block ? [...block[1].matchAll(/\bid:\s*(\d+)/g)].map((match) => match[1]).join(",") : "";
      };
      const base = process.env.BASE_SHA;
      const head = process.env.AGENT_HEAD_SHA;
      if (ids(show(base, script)) !== ids(show(head, script)) && show(base, data) === show(head, data)) {
        console.error("RUNS ids changed but run-data.json was not re-captured");
        process.exit(1);
      }
      '
    working-directory: portfolio
  - name: "post-run check: committed provenance records upstream_sha"
    run: |-
      # post-run check: committed provenance records upstream_sha
      if [ "$AGENT_HEAD_SHA" != "$BASE_SHA" ]; then
        node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const file = process.env.GITHUB_WORKSPACE + "/portfolio/experiences/pipeline-showcase/content/provenance.json";
        let doc;
        try { doc = JSON.parse(readFileSync(file, "utf8")); }
        catch { console.error("provenance.json is missing or unparseable"); process.exit(1); }
        const keys = Object.keys(doc).sort().join(",");
        if (keys !== "commit,repository" || doc.repository !== "ms-mfg-community/github-pipeline-showcase" || doc.commit !== process.env.UPSTREAM_SHA) {
          console.error("provenance.json does not record the upstream sha");
          process.exit(1);
        }
        '
      fi
    working-directory: portfolio
  - name: "post-run check: the upstream checkout stays read-only"
    run: |-
      # post-run check: the upstream checkout stays read-only
      test -z "$(git -C "$UPSTREAM_DIR" status --porcelain)"
    working-directory: portfolio
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: johnhain-msft/portfolio
    title-prefix: "feat(cascade): "
    labels:
      - automated
      - sdlc-cascade
      - ai-adapted
      - needs-review
    reviewers:
      - johnhain-msft
    draft: false
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-cascade-pipeline-showcase
    if-no-changes: ignore
    auto-merge: false
    fallback-as-issue: false
    allowed-files:
      - experiences/pipeline-showcase/content/provenance.json
      - experiences/pipeline-showcase/capture/fetch-run-data.mjs
      - experiences/pipeline-showcase/content/run-data.json
      - public/pipeline-showcase/**
      - tests/pipeline-showcase.test.ts
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
  edit: {}
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
          REPO_SLUG: PIPELINE_SHOWCASE
          BRANCH_NAME: sdlc/cascade-pipeline-showcase
          PROVENANCE_FILE: experiences/pipeline-showcase/content/provenance.json
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug "$REPO_SLUG" --branch "$BRANCH_NAME" --provenance-file "$PROVENANCE_FILE" --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"
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
          REPO_SLUG: PIPELINE_SHOWCASE
          BRANCH_NAME: sdlc/cascade-pipeline-showcase
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug "$REPO_SLUG" --target-sha "$UPSTREAM_SHA" --workflow-id cascade-ai-pipeline-showcase
---

# AI adaptation: pipeline-showcase

Adapt the downstream checkout `portfolio/` of `johnhain-msft/portfolio` to the upstream changes in `ms-mfg-community/github-pipeline-showcase`. The cumulative range you adapt against is `previous_sha..upstream_sha`; the exact revisions are in `/tmp/gh-aw/agent/dispatch-inputs.json`.

## Adaptation instructions

Compare the upstream Actions runs saved under /tmp/gh-aw/agent/ with the RUNS list in the capture script. When upstream runs advanced, update the RUNS ids and stories and the matching expectations in the showcase test, then re-capture the run data and rebuild the experiences. Note any RUNS id change in the pull request body so the animated demo can be re-stitched by hand.

## Branch

Pass exactly the branch `sdlc/cascade-pipeline-showcase` to `create_pull_request`.

## Files you may change

Only these paths (the pull request is refused for any other file):

- `experiences/pipeline-showcase/content/provenance.json`
- `experiences/pipeline-showcase/capture/fetch-run-data.mjs`
- `experiences/pipeline-showcase/content/run-data.json`
- `public/pipeline-showcase/**`
- `tests/pipeline-showcase.test.ts`

## Files you must not change

- `experiences/copilot-workshop/content/rules.ts`
- `experiences/copilot-workshop/content/source.ts`
- `experiences/copilot-workshop/content/types.ts`
- `experiences/copilot-workshop/src`
- `src`
- `scripts`
- `tests/auth.test.ts`
- `tests/runtime.test.ts`
- `tests/catalog.test.ts`
- `tests/copilot-workshop-geometry.test.ts`
- `tests/copilot-workshop-runtime.test.ts`
- `apps/lab-studio/server/src/index.ts`
- `apps/lab-studio/server/src/copilot-bridge.ts`
- `apps/lab-studio/server/src/sandbox.ts`
- `apps/lab-studio/server/src/sim-terminal.ts`
- `apps/lab-studio/server/src/skills.ts`
- `apps/lab-studio/server/tests/sandbox.test.ts`

## Evidence

Read the artifacts under `/tmp/gh-aw/agent/` first: `upstream-diff.txt`, `dispatch-inputs.json`, `existing-pr.json` and the preflight reports.

## Deterministic commands

Run these from `$GITHUB_WORKSPACE/portfolio`, in this order, and commit their outputs before you call `create_pull_request`:

```bash
cd "$GITHUB_WORKSPACE/portfolio"
node --input-type=module -e 'import { writeFileSync } from "node:fs"; writeFileSync("experiences/pipeline-showcase/content/provenance.json", JSON.stringify({ repository: "ms-mfg-community/github-pipeline-showcase", commit: process.env.UPSTREAM_SHA }, null, 2) + "\n");'
node experiences/pipeline-showcase/capture/fetch-run-data.mjs
npm run build:experiences
```

## Rules

- When no adaptation is required, leave the worktree clean and make no commit, so the run ends without a pull request.
- When the dispatch input `dry_run` is `true`, do not run `git commit` and do not call `create_pull_request`.
- The pull request body lists `previous_sha..upstream_sha`, the `correlation_id`, the adapted modules and Studio labs, and anything a reviewer must check by hand.
- Do not edit anything under `upstream/`. The pull request is created only through the safe output; do not publish branches yourself.
