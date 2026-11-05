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
