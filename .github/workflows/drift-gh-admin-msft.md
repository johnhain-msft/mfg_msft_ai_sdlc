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
    - mfg-msft-ai-sdlc[bot]
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
      repositories:
        - gh-admin-msft
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
    run: node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-gh-admin-msft --upkeep-strategy content-and-docs-sync
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
    run: node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project gh-admin-msft --checkout gh-admin-msft
  - name: Install target checkout dependencies for in-sandbox validation
    working-directory: gh-admin-msft
    run: npm ci --ignore-scripts
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
    repositories:
      - ${{ github.event.repository.name }}
      - gh-admin-msft
  report-failure-as-issue: false
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
    max-patch-size: 10240
engine:
  id: copilot
  copilot-sdk: true
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
tools:
  web-fetch: {}
  bash:
    - awk
    - cat
    - cd
    - cut
    - date
    - diff
    - echo
    - find
    - git
    - grep
    - head
    - jq
    - ls
    - mkdir
    - node
    - npm
    - python3
    - rg
    - sed
    - sort
    - tail
    - tr
    - uniq
    - wc
    - xargs
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

You maintain the GitHub Enterprise Cloud (GHEC) administration material in this repository: the numbered labs (`labs/lab01.md`–`labs/lab18.md`), the reference and instructor documents (`docs/01-*.md`–`docs/30-*.md`), the migration business case and the presentation deck (`presentation/content/slides/*.md`) with its presenter script (`presentation/content/script/*.md` and `presenter/PRESENTER-SCRIPT.md`). Your job is to keep that material current with the sources the orchestrator watches for this project.

## Remote agent pack and task routing

Before evaluating drift, check whether `.github/sdlc/AGENTS.md` and `.github/sdlc/agents/` exist in the target checkout (`gh-admin-msft/`). Those files define the remote-only SDLC agent harness (kept under `.github/sdlc/` so local Copilot CLI and VS Code sessions never auto-load them). Read `.github/sdlc/AGENTS.md` and execute its three specialized roles in sequence without copying files into root `AGENTS.md` or `.github/agents/`:

1. **Source Verifier (`.github/sdlc/agents/ghec-source-verifier.agent.md`)** — high-reasoning verification of changelog and documentation changes against primary sources (`microsoft-learn`, `context7`, and `docs.github.com/en/enterprise-cloud@latest/*`), producing an evidence table of verified GHEC changes (settings, UI click-paths, SKU names, billing rules, limits, and retired features).
2. **Curriculum Updater (`.github/sdlc/agents/ghec-curriculum-updater.agent.md`)** — coordinated updates across `labs/lab01.md`–`labs/lab18.md`, `docs/01-*.md`–`docs/30-*.md`, `presentation/content/slides/*.md`, and `presentation/content/script/*.md` whenever a lab or reference topic changes, followed by rebuilding `presentation/dist/index.html` and `presenter/PRESENTER-SCRIPT.md`.
3. **Regression & Lab Tester (`.github/sdlc/agents/ghec-regression-tester.agent.md`)** — change-aware self-testing that steps through every modified lab exercise and command, runs the structural, deck, and freshness validators, and prepares ready-to-apply freshness regression rule proposals for any newly retired or changed GitHub claim.

## What to do

1. Read the snapshots under `/tmp/gh-aw/agent/sources/` and the `manifest.json` beside them. A source that could not be fetched is a limitation to report, never something to guess.
2. Compare what the watched changelog and documentation pages now say with what the labs, reference documents and deck claim. Corroborate every proposed change through the Microsoft Learn and Context7 MCP servers or by fetching the cited page; do not change a claim on the strength of a single unverified mention.
3. Apply all corrections that a corroborated source supports across the curriculum: updated lab prose, step-by-step lab exercises, CLI/API commands, renamed settings, moved navigation click-paths, changed limits or availability, billing/licensing updates, retired features and broken or redirected links. Whenever a lab (`labs/lab*.md`) or reference document (`docs/*.md`) changes a concept, setting, limit, or click-path that also appears in the deck, update the corresponding slide source (`presentation/content/slides/*.md`) and speaker script source (`presentation/content/script/*.md`) in the same commit while preserving each day's 180-minute agenda total.
4. Rebuild the deck and the presenter script with the build command from the build step of this workflow and commit the rebuilt outputs together with your source edits.
5. Step through every modified lab exercise and run the repository's change-appropriate validation scripts via `node` (`node tests/validate-lab-completeness.js`, `node tests/validate-vbd-coverage.js`, `node tests/validate-structure.js`, `node tests/validate-frontmatter.js`, `node tests/validate-codeblocks.js`, `node tests/validate-mermaid.js`, `node tests/validate-deck.js`, `node scripts/deck-qa.mjs`, `node tests/validate-freshness.js`, and `node tests/run-all.js --skip-links`) before committing.
6. Write a structured change summary for the pull request body: each change, the primary source URL that supports it, the validation checks executed, a `## Proposed Freshness Regression Rules` block with exact `DEPRECATED_PATTERNS` and `FIXTURES` entries for any newly retired or changed GitHub claim, and anything you looked at but could not confirm.

## Limits

- Make source-backed curriculum updates across labs, reference docs, slide sources, and presenter script sources. Do not rename files, delete existing labs, or invent unverified features.
- Do not edit the repository's tests, validation scripts or generated files that the build overwrites; change the sources and rebuild.
- If a source contradicts the material but the right replacement is a judgement call, record it in the summary for a human and leave the text as it is.
- Name the working branch `weekly-audit-YYYY-MM-DD` with the current UTC date. The `sdlc/` prefix is added when the pull request is created; do not write it yourself.
- Propose all updates through the pull request safe output for human review; never merge.
- When nothing needs to change, record that outcome and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run.

- When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place.
- When `dry_run` is `true`, do not call `create_pull_request` and leave the target checkout clean (`git checkout -- .` before finishing if you tested edits). Do the same evaluation and write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) into `/tmp/gh-aw/agent/dry-run-proposal.json` using `node -e 'require("fs").writeFileSync("/tmp/gh-aw/agent/dry-run-proposal.json", ...)'` (avoid shell `>` redirection).

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub Enterprise changelog (changelog): https://github.blog/changelog/label/enterprise/
- GitHub Enterprise Cloud administration documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/admin
- GitHub Enterprise Cloud billing and licensing documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/billing
- GitHub Copilot Enterprise documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/copilot
- GitHub Secret Protection and Code Security documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/code-security
- GitHub Actions Enterprise documentation (docs): https://docs.github.com/en/enterprise-cloud@latest/actions

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`

## Build commands

Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:

```bash
node presentation/build.mjs
```

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the upkeep when it lists a matching open pull request that you must not duplicate (`duplicate` is `true`: a match whose `decision` is `skip`). A match whose `decision` is `supersede` is an earlier pull request of this same workflow, which your new pull request replaces (`close-older-pull-requests: true`), and a match whose `decision` is `ignore` is the pull request of another upkeep: neither is a reason to skip. Never open a duplicate.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
