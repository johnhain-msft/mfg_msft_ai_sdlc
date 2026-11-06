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
- Name the working branch `weekly-audit-YYYY-MM-DD` with the current UTC date. The `sdlc/` prefix is added when the pull request is created; do not write it yourself.
- The report must keep its four required sections: `## Summary`, `## Checks`, `## Suggestions for Additions` and `## Metadata`.
- Read `/tmp/gh-aw/agent/sources/manifest.json`. A watched source that it lists as failed, and a package manifest pattern that matched no file, are limitations: record each in the `## Checks` section of the report and never guess what the source said.
- Write a copy of `docs/_meta/audit-report.md` to `/tmp/gh-aw/agent/audit-report.md` before you call `create_pull_request`.
- When nothing needs to change, record that outcome and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run.

- When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place.
- When `dry_run` is `true`, do not call `create_pull_request`. Do the same evaluation and write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) into `/tmp/gh-aw/agent/dry-run-proposal.json`.
