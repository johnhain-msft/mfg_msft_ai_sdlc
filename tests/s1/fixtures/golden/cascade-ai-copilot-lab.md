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
  group: sdlc-state-copilot-lab
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
  - repository: ms-mfg-community/day-in-the-life-copilot-lab
    path: upstream/day-in-the-life-copilot-lab
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
      case "$SYNC_SCOPE" in both|workshop-only|studio-only) ;; *) fail "sync_scope is not accepted by this workflow: $SYNC_SCOPE" ;; esac
      case "$ON_COMMIT_ONLY_ADVANCE" in noop|bump-provenance) ;; *) fail "on_commit_only_advance must be noop or bump-provenance" ;; esac
      [ "$DOWNSTREAM_REPO_INPUT" = "johnhain-msft/portfolio" ] || fail "downstream_repo must be johnhain-msft/portfolio"
      [ "$UPSTREAM_REPO_INPUT" = "ms-mfg-community/day-in-the-life-copilot-lab" ] || fail "upstream_repo must be ms-mfg-community/day-in-the-life-copilot-lab"
      case "$DRY_RUN" in ""|true|false) ;; *) fail "dry_run must be empty, true or false" ;; esac
      [ "$(git -C "$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab" rev-parse HEAD)" = "$UPSTREAM_SHA" ] || fail "the upstream checkout is not at upstream_sha"
      git -C "$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab" cat-file -e "$PREVIOUS_SHA^{commit}" || fail "the upstream checkout does not contain previous_sha"
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
      { echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-copilot-lab"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab"; } >> "$GITHUB_ENV"
      git -C "$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab" diff --name-status "$PREVIOUS_SHA" "$UPSTREAM_SHA" > /tmp/gh-aw/agent/upstream-diff.txt
      node --input-type=module -e 'import { writeFileSync } from "node:fs"; const e = process.env; writeFileSync("/tmp/gh-aw/agent/dispatch-inputs.json", JSON.stringify({ correlation_id: e.CORRELATION_ID, upstream_repo: e.UPSTREAM_REPO_INPUT, previous_sha: e.PREVIOUS_SHA, upstream_sha: e.UPSTREAM_SHA, upstream_etag: e.UPSTREAM_ETAG, upstream_pr_number: e.UPSTREAM_PR_NUMBER, downstream_repo: e.DOWNSTREAM_REPO_INPUT, sync_scope: e.SYNC_SCOPE, on_commit_only_advance: e.ON_COMMIT_ONLY_ADVANCE, dry_run: e.DRY_RUN }, null, 2) + "\n");'
      if pulls="$(gh api "repos/johnhain-msft/portfolio/pulls?state=open&head=johnhain-msft:sdlc/cascade-copilot-lab" --jq '.[0] // null' 2>/dev/null)"; then
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
      ( npm run sync:workshop-source -- "$UPSTREAM_DIR" ) > /tmp/gh-aw/agent/preflight-1.txt 2>&1
      rc1=$?
      ( node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$TARGET_SHA" ) > /tmp/gh-aw/agent/preflight-2.txt 2>&1
      rc2=$?
      set -e
      cp /tmp/gh-aw/agent/preflight-1.txt /tmp/gh-aw/agent/workshop-drift.txt
      cp /tmp/gh-aw/agent/preflight-2.txt /tmp/gh-aw/agent/lab-studio-drift.txt
      printf 'preflight exit codes: %s %s\n' "$rc1" "$rc2" > /tmp/gh-aw/agent/preflight-exit-codes.txt
      for rc in "$rc1" "$rc2"; do
        if [ "$rc" -ge 2 ]; then echo "a preflight command failed with exit code $rc" >&2; exit 2; fi
      done
      if grep -Eq '^[[:space:]]+at[[:space:]]+[^[:space:]]' /tmp/gh-aw/agent/preflight-1.txt /tmp/gh-aw/agent/preflight-2.txt; then echo "a preflight report holds an uncaught-exception stack trace" >&2; exit 2; fi
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
  - name: node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow cascade-ai-copilot-lab
    run: node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow cascade-ai-copilot-lab
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
  - name: "post-run check: committed provenance records upstream_sha"
    run: |-
      # post-run check: committed provenance records upstream_sha
      if [ "$AGENT_HEAD_SHA" != "$BASE_SHA" ]; then
        node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const root = process.env.GITHUB_WORKSPACE + "/portfolio/";
        const want = process.env.UPSTREAM_SHA;
        const read = (file) => {
          try { return JSON.parse(readFileSync(root + file, "utf8")); }
          catch { console.error("provenance file is missing or unparseable: " + file); process.exit(1); }
        };
        const revision = read("experiences/copilot-workshop/provenance.json");
        const inputs = read("experiences/copilot-workshop/source-inputs.json");
        const studio = read("apps/lab-studio/lab-sources.json");
        const stale = [];
        if (revision.commit !== want) stale.push("provenance.json commit");
        if (revision.documentCommit !== want) stale.push("provenance.json documentCommit");
        if (inputs.commit !== want) stale.push("source-inputs.json commit");
        if (!studio._provenance || studio._provenance.commit !== want) stale.push("lab-sources.json _provenance.commit");
        if (stale.length > 0) { console.error("stale provenance: " + stale.join(", ")); process.exit(1); }
        '
        node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$UPSTREAM_SHA"
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
    close-older-key: sdlc-cascade-copilot-lab
    if-no-changes: ignore
    auto-merge: false
    fallback-as-issue: false
    allowed-files:
      - README.md
      - public/copilot-project.html
      - experiences/copilot-workshop/content/index.ts
      - experiences/copilot-workshop/content/interludes.ts
      - experiences/copilot-workshop/content/lab-pace.ts
      - experiences/copilot-workshop/content/m*.ts
      - experiences/copilot-workshop/provenance.json
      - experiences/copilot-workshop/source-inputs.json
      - experiences/copilot-workshop/public/LICENSE
      - experiences/copilot-workshop/public/NOTICE.txt
      - public/workshop/**
      - tests/copilot-workshop.test.ts
      - apps/lab-studio/lab-sources.json
      - apps/lab-studio/README.md
      - apps/lab-studio/client/src/labs/source.ts
      - apps/lab-studio/client/src/labs/lab*.tsx
      - apps/lab-studio/server/src/verify.ts
      - apps/lab-studio/server/tests/source.test.ts
      - apps/lab-studio/server/tests/lab-drift.test.ts
      - apps/lab-studio/server/tests/lesson-content.test.ts
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude:
        - /README.md
        - /apps/lab-studio/README.md
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
          CORRELATION_ID: ${{ inputs.correlation_id }}
          UPSTREAM_ETAG: ${{ inputs.upstream_etag }}
          REPO_SLUG: COPILOT_LAB
          BRANCH_NAME: sdlc/cascade-copilot-lab
          PROVENANCE_FILE: experiences/copilot-workshop/source-inputs.json
        run: |-
          node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug "$REPO_SLUG" --branch "$BRANCH_NAME" --provenance-file "$PROVENANCE_FILE" --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG" > "${RUNNER_TEMP:-/tmp}/poll-state-result.json"
          cat "${RUNNER_TEMP:-/tmp}/poll-state-result.json"
          if [ -s "${RUNNER_TEMP:-/tmp}/poll-state-result.json" ]; then
            node "$GITHUB_WORKSPACE/src/ai-pull-request-result.mjs" --slug "$REPO_SLUG" --poll-state-result "${RUNNER_TEMP:-/tmp}/poll-state-result.json"
          fi
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
          CORRELATION_ID: ${{ inputs.correlation_id }}
          REPO_SLUG: COPILOT_LAB
          BRANCH_NAME: sdlc/cascade-copilot-lab
        run: node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug "$REPO_SLUG" --target-sha "$UPSTREAM_SHA" --workflow-id cascade-ai-copilot-lab
---

# AI adaptation: copilot-lab

Adapt the downstream checkout `portfolio/` of `johnhain-msft/portfolio` to the upstream changes in `ms-mfg-community/day-in-the-life-copilot-lab`. The cumulative range you adapt against is `previous_sha..upstream_sha`; the exact revisions are in `/tmp/gh-aw/agent/dispatch-inputs.json`. Work in this order: read the evidence, decide whether anything must change, make the edits, run the deterministic commands, commit, and only then open the pull request.

## Adaptation instructions

Adapt the Copilot workshop pages and the hosted Lab Studio labs to the cumulative upstream change. Read the drift reports under /tmp/gh-aw/agent/ first (workshop-drift.txt, lab-studio-drift.txt and upstream-diff.txt) and change only what the evidence supports. Treat the workshop report as opaque text and never assume that its exit code distinguishes drift from a crash. Changes are required when the workshop report lists changed, new or gone inputs or PROBLEM lines, or when lab-studio-drift.txt lists a lab in changedLabs. Update the workshop pages (experiences/copilot-workshop/content/index.ts, interludes.ts, lab-pace.ts and the m*.ts modules), experiences/copilot-workshop/public/LICENSE, experiences/copilot-workshop/public/NOTICE.txt, README.md, public/copilot-project.html and tests/copilot-workshop.test.ts. Keep every page inside the content rules of the locked rules module: speech counted at 140 words a minute (SPEAKING_WPM) plus the live cues (LIVE_SECONDS), the audience-word limits, no hollow cards, cue discipline, source links pinned to the new revision and the 227 of 240 minute budget. The workshop sync command writes none of content/*.ts, lab-pace.ts or public/LICENSE, so update lab-pace.ts, public/LICENSE and the page content yourself, and keep every source-lab link pointing at the pinned revision. In tests/copilot-workshop.test.ts keep the lines before the first describe(, every describe( header and the five locked it(...) blocks byte for byte. Update the Studio labs (apps/lab-studio/client/src/labs/labNN.tsx), apps/lab-studio/README.md, apps/lab-studio/server/src/verify.ts and the Studio tests source.test.ts, lab-drift.test.ts and lesson-content.test.ts, and never edit sandbox.test.ts. Hosted authentication and sandbox isolation must be preserved: the authentication and runtime tests and the gateway, bridge, sandbox, terminal and skills sources of the Studio server stay zero-diff. Never touch the locked rule, runtime, authentication and sandbox files.

## Evidence

Read the artifacts under `/tmp/gh-aw/agent/` first. They were captured before you started and are what you know about the upstream change:

- `dispatch-inputs.json`: the ten dispatch inputs verbatim, among them `correlation_id`, `previous_sha`, `upstream_sha` and `on_commit_only_advance`.
- `upstream-diff.txt`: the changed upstream files of `previous_sha..upstream_sha`, with their status.
- `existing-pr.json`: the open pull request for the branch of this workflow, or `null`.
- `workshop-drift.txt` (also `preflight-1.txt`): the output of `npm run sync:workshop-source -- "$UPSTREAM_DIR"`.
- `lab-studio-drift.txt` (also `preflight-2.txt`): the output of `node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$TARGET_SHA"`.
- `preflight-exit-codes.txt`: the exit codes of those commands. An exit code of 1 is a drift report for you to act on, not a failure.

The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The upstream checkout `$UPSTREAM_DIR` is read-only: never write to it.

## What to do

1. Decide from the evidence which case applies. When nothing has to be adapted, read `on_commit_only_advance` in `dispatch-inputs.json`: `noop` means that you leave the worktree exactly as it is, with no edit and no commit, so that the run ends without a pull request; `bump-provenance` means that you make no content edit and go to step 3, which records the new revision. Otherwise adapt the downstream as the adaptation instructions say.
2. Make the edits, changing only the files you may change and never the files you must not change (both lists are below).
3. Run the deterministic commands below, in their order.
4. Commit what they and you changed, with the commands that close that block.
5. Open the pull request (the last section).

## Files you may change

Only these paths (the pull request is refused for any other file):

- `README.md`
- `public/copilot-project.html`
- `experiences/copilot-workshop/content/index.ts`
- `experiences/copilot-workshop/content/interludes.ts`
- `experiences/copilot-workshop/content/lab-pace.ts`
- `experiences/copilot-workshop/content/m*.ts`
- `experiences/copilot-workshop/provenance.json`
- `experiences/copilot-workshop/source-inputs.json`
- `experiences/copilot-workshop/public/LICENSE`
- `experiences/copilot-workshop/public/NOTICE.txt`
- `public/workshop/**`
- `tests/copilot-workshop.test.ts`
- `apps/lab-studio/lab-sources.json`
- `apps/lab-studio/README.md`
- `apps/lab-studio/client/src/labs/source.ts`
- `apps/lab-studio/client/src/labs/lab*.tsx`
- `apps/lab-studio/server/src/verify.ts`
- `apps/lab-studio/server/tests/source.test.ts`
- `apps/lab-studio/server/tests/lab-drift.test.ts`
- `apps/lab-studio/server/tests/lesson-content.test.ts`

## Files you must not change

A difference in any of them fails the verification that runs after you finish, and no pull request is opened:

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

The companion test files of the other adaptation workflows are theirs alone:

- `tests/pipeline-showcase.test.ts`
- `tests/github-intermediate-labs.test.ts`
- `tests/github-intermediate-workshop.test.ts`

## Test blocks that stay byte for byte

After you finish, these parts of the test files below are compared with the base revision, and any difference fails the run. Every other test in those files may be edited.

- `tests/copilot-workshop.test.ts`: the lines before the first `describe(`, every `describe(` header line, and these blocks:
  - `it("passes every content rule: no errors and no warnings")`
  - `it("gives every teaching page a literal script, not notes")`
  - `it("can be delivered in the minutes the plan gives it: speech at the app's own rate plus the live cues, on every page and in every module")`
  - `it("plans with one speaking rate: the pace band tops out at it, and the speaker view reads it from the rules instead of typing its own")`
  - `it("keeps audience pages sparse")`

## Deterministic commands

Run these from `$GITHUB_WORKSPACE/portfolio`, in this order, after your edits. A non-zero exit of any command is a failed run: stop, do not commit, and do not open the pull request. The last two lines commit the result.

```bash
cd "$GITHUB_WORKSPACE/portfolio"
node "$GITHUB_WORKSPACE/src/bump-studio-revision-pins.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --new-sha "$UPSTREAM_SHA"
npm run sync:workshop-source -- "$UPSTREAM_DIR" --accept
node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$UPSTREAM_SHA" --accept
npm run build:workshop
git add -- README.md apps/lab-studio/README.md apps/lab-studio/client/src/labs apps/lab-studio/client/src/labs/source.ts apps/lab-studio/lab-sources.json apps/lab-studio/server/src/verify.ts apps/lab-studio/server/tests/lab-drift.test.ts apps/lab-studio/server/tests/lesson-content.test.ts apps/lab-studio/server/tests/source.test.ts experiences/copilot-workshop/content experiences/copilot-workshop/content/index.ts experiences/copilot-workshop/content/interludes.ts experiences/copilot-workshop/content/lab-pace.ts experiences/copilot-workshop/provenance.json experiences/copilot-workshop/public/LICENSE experiences/copilot-workshop/public/NOTICE.txt experiences/copilot-workshop/source-inputs.json public/copilot-project.html public/workshop tests/copilot-workshop.test.ts
git commit -m "feat(cascade): adapt copilot-lab to $UPSTREAM_SHA"
```

## Pull request

Only after that commit, call `create_pull_request` with exactly the branch `sdlc/cascade-copilot-lab`. Its body lists `previous_sha..upstream_sha`, the `correlation_id` of `dispatch-inputs.json`, the adapted modules and Studio labs, and anything a reviewer must check by hand.

## Rules

- When no adaptation is required, leave the worktree clean and make no commit, so the run ends without a pull request.
- When the dispatch input `dry_run` is `true`, do not run `git commit` and do not call `create_pull_request`.
- Do not edit anything under `upstream/`. The pull request is created only through the safe output; do not publish branches yourself.
