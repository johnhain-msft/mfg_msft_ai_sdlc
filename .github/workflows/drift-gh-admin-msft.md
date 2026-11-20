---
on:
  schedule:
    - cron: 23 13 * * 1
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
  actions: read
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
  - run: npm ci --ignore-scripts
  - name: Prepare run context
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
      TARGET_REPO_INPUT: ${{ inputs.target_repo }}
      CORRELATION_ID: ${{ inputs.correlation_id }}
      EXTRA_INSTRUCTIONS: ${{ inputs.extra_instructions }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"
  - name: Deduplicate open pull requests
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
      APP_CLIENT_ID: ${{ vars.APP_CLIENT_ID }}
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-gh-admin-msft --upkeep-strategy content-and-docs-sync --project gh-admin-msft
  - name: Find the watch index of the previous run
    env:
      GH_TOKEN: ${{ github.token }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/previous-watch-index.mjs" --out /tmp/gh-aw/agent --workflow drift-gh-admin-msft.lock.yml --artifact sdlc-watch-index-gh-admin-msft
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: johnhain-msft/gh-admin-msft
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project gh-admin-msft --checkout gh-admin-msft --previous /tmp/gh-aw/agent/previous
  - name: Upload the watch index
    if: inputs.dry_run != true
    uses: actions/upload-artifact@v4
    with:
      name: sdlc-watch-index-gh-admin-msft
      path: /tmp/gh-aw/agent/sources/watch-index.json
      if-no-files-found: error
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
    recreate-ref: false
    close-older-pull-requests: false
    close-older-key: sdlc-drift-gh-admin-msft
    if-no-changes: error
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude: []
    auto-merge: false
    fallback-as-issue: true
    max: 1
    max-patch-size: 10240
  create-issue:
    target-repo: johnhain-msft/gh-admin-msft
    title-prefix: "[sdlc-drift] "
    labels:
      - automated
      - sdlc-drift
      - drift-report
    close-older-issues: false
    max: 1
engine:
  id: copilot
  copilot-sdk: true
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
  args:
    - --allow-url
    - docs.github.com
    - --allow-url
    - github.blog
tools:
  web-fetch: {}
  bash:
    - awk
    - cat
    - cd
    - curl
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
            /package.json
            /package-lock.json
            /sdlc.yaml
          sparse-checkout-cone-mode: false
          persist-credentials: false
      - run: npm ci --ignore-scripts
      - name: Escalate gate failure
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          WORKFLOW_ID: drift-gh-admin-msft
          TARGET_REPO: johnhain-msft/gh-admin-msft
          CORRELATION_ID: ${{ inputs.correlation_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
  implement_report:
    needs:
      - safe_outputs
    if: needs.safe_outputs.result == 'success' && needs.safe_outputs.outputs.created_issue_number != '' && inputs.dry_run != true
    permissions:
      actions: write
    steps:
      - name: Start the implementation of the drift report
        env:
          GH_TOKEN: ${{ github.token }}
          WORKFLOW_FILE: implement-gh-admin-msft.lock.yml
          REPORT_ISSUE: ${{ needs.safe_outputs.outputs.created_issue_number }}
          CORRELATION_ID: ${{ inputs.correlation_id || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
        run: gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"
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
- When `dry_run` is `true`, do not call `create_pull_request` and leave the target checkout clean (`git checkout -- .` before finishing if you tested edits). Do the same evaluation and write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) under the key `proposal` of `/tmp/gh-aw/agent/dry-run-proposal.json`, which exists already: change it with the edit tool (the workflow refuses shell `>` redirection and heredocs).

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- GitHub changelog (changelog): https://github.blog/changelog/
- GitHub changelog feed (feed): https://github.blog/changelog/feed/
- GitHub changelog, enterprise management tools (changelog): https://github.blog/changelog/?label=enterprise-management-tools

The snapshot step also saved the text of the pages that this repository cites most: up to 60 pages on `docs.github.com` that files matching `labs/**/*.md`, `docs/**/*.md` and `presentation/content/**/*.md` link to, under `/tmp/gh-aw/agent/sources/cited/`. `manifest.json` lists each of them with the files that cite it.

## What changed since the last run

Start with `/tmp/gh-aw/agent/sources/changes.md`. It compares this run's snapshots with the watch index of the last successful run (its first line names that run, or says that there is none and why) and lists the changelog, feed and release entries that are new since then, each once with the sources that list it, the pages and cited pages whose text changed, with the files of this repository that cite them, and the sources that could not be fetched.

When a source's first page lists none of the entries that the baseline knew, the snapshot step has read its older pages until one does, up to a limit; a source that still does not reach the baseline is listed under `## Possible gaps` with the period that neither run saw. Open the older pages of that source for that period yourself, decide those entries as well, and name the gap under `## Limitations` when you cannot.

That list is your work list, and every item of it gets a decision. Triage each item first from its title and excerpt: search this repository for the feature, setting or product that it names. Open, read and corroborate the items that touch something this repository covers or should cover, and read an entry or a page with `curl --fail --silent --show-error --location <url>` whenever its excerpt is not enough to decide, piped into `grep` or `head` when the page is long: `curl` reaches the hosts of the watched URLs and of the cited pages and no other, there is no `web_fetch` tool, and the shell has no `wget` or `gh` and refuses a redirection or a heredoc. An item that does not concern this repository is not relevant: count it, but do not list it in the report. A long list is no reason to skip items: decide each one.

## Drift report

File a drift report when at least one item of the work list is recommended or could not be confirmed, or when this run has a limitation that a human has to know about: a source that could not be fetched, or a possible gap that you could not close. File it with exactly one `create_issue` call; a human reads it, and filing it starts its implementation: a run of the workflow `implement-gh-admin-msft` researches every item under `## Recommended` and `## Could not confirm` again and opens one pull request that closes the report, starting from the report alone. Title it `Drift report: gh-admin-msft YYYY-MM-DD` with the current UTC date (the `[sdlc-drift] ` prefix is added for you). When there is nothing of that kind (every item is not relevant or applied by your pull request, every source was fetched and every gap closed), file no report: call `noop` with one line that says how many items you triaged and which baseline you compared with. Your pull request lists the items that it applies; the report does not list them again.

When the registration instructions above define a report of their own (such as `docs/_meta/audit-report.md` or `self-improvement-report.md`), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it; the body of the issue is that report followed by the sections below other than `## Summary`. Otherwise the body has these sections, in this order, and leaves out `## Recommended` and `## Could not confirm` when they would be empty:

- `## Summary`: the baseline run, what changed upstream since then and what this run did, including the pull request that it opened, if any, and one line that counts the items that you triaged as not relevant (never list them).
- `## Recommended`: a task list (`- [ ] `) of what this run did not change and should be changed: content that the sources announce and this repository does not cover yet (a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note), corrections and judgement calls. Each item says what to change, names the files that it concerns and links its source.
- `## Could not confirm`: a task list (`- [ ] `) of the claims that you could not corroborate, each with its source, what stopped you and the files that it would concern.
- `## Limitations`: the sources that could not be fetched, the possible gaps that you could not close and the checks that could not run.

Call `create_pull_request` before `create_issue` and name the pull request in the report. In a dry run call neither: `/tmp/gh-aw/agent/dry-run-proposal.json` exists already with `null` under `proposal` and `report`; replace the `null` of `report` with the report that you would have filed, `{ "title": ..., "body": ... }`, using the edit tool: the shell of this workflow refuses a redirection or a heredoc. Leave it `null` when you would have filed none.

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`

## Build commands

Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:

```bash
node presentation/build.mjs
```

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the pull request when it lists a matching open pull request that you must not duplicate (`duplicate` is `true`: a match whose `decision` is `skip`), and list what you would have changed under `## Recommended` of the drift report instead. A match whose `decision` is `ignore` is an earlier pull request of this same workflow, which stays open and carries other items, the pull request of another upkeep or the implementation of an earlier report: none is a reason to skip. Never open a duplicate.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: pull requests and issues are created only through the `create_pull_request` and `create_issue` safe outputs.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
