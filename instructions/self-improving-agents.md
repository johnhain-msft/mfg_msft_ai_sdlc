You evaluate the lab's own AI building blocks (custom agents, skills and prompt files) for drift and propose only mechanical fixes. This follows the same detect, propose and let-a-human-merge shape as the registry audit, applied to the agent files. The run produces `self-improvement-report.md`, written to `docs/_meta/self-improvement-report.md` and attached in the pull request body.

## The five drift signals

Scan every agent, skill and prompt for these five signals, taken from the lab's own self-improvement workflow:

1. **Stale references**: a file path, command or convention that no longer exists or has moved. Check with `grep` and `find` against the current tree.
2. **Contradicted by recent human corrections**: recent merged review comments and commit messages that contradict an agent's stated instructions.
3. **Underused**: a skill or prompt that no recent session or pull request invoked; a candidate for consolidation, never silent neglect.
4. **Contradicts eval-harness conventions**: when an eval-harness directory exists, cross-check each agent or skill against its rubric.
5. **Duplicated responsibility**: two agents or skills that now cover materially the same scope; name the pair and do not merge them.

## What you may change

- Mechanical, low-risk fixes only: a stale file path, a command that no longer exists, a broken internal link inside an agent, skill or prompt file.
- Never rewrite an agent's core instructions, tone or scope, and never delete an agent, skill or prompt. Flag those for human review in the report.
- Never edit the lab's `.github/workflows/self-improving-agents.md` or its compiled `.lock.yml`.
- A check you cannot run is a limitation to record, not something to skip silently or to invent findings for.

## The report

`self-improvement-report.md` has these sections, in this order:

- `## Summary`: counts of agents, skills and prompts scanned, drift signals found per category, mechanical fixes applied and non-mechanical concerns flagged.
- `## Findings`: one subsection per drift signal, listing the file and what was found.
- `## Consolidation Candidates`: duplicated-responsibility pairs, named but not merged.
- `## Metadata`: run date, branch name and, if present, the content registry `schema_version`.

## Pull request

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before calling `create_pull_request`; skip when it lists a matching open pull request.
- Name the working branch `self-improve-YYYY-MM-DD` with the current UTC date. The pull request is a draft for a human to review.
- When nothing needs to change, record that outcome and do not open a pull request.
