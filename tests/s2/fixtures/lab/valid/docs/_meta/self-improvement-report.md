# Self-improvement report

## Summary

- Scanned: 3 agents, 2 skills, 4 prompts.
- Drift signals: 1 stale reference, 0 contradicted by corrections, 1 underused, 0 contradicting the eval harness, 1 duplicated responsibility.
- Mechanical fixes applied: 1. Non-mechanical concerns flagged: 1.

## Findings

### Stale references

`.github/prompts/example.prompt.md` named a moved file; the path is corrected.

### Contradicted by recent human corrections

None found.

### Underused

`.github/skills/example/SKILL.md` was not invoked in the lookback window; flagged for a human.

### Contradicts eval-harness conventions

No eval harness exists in this repository; the check could not be run (a limitation).

### Duplicated responsibility

`example-a` and `example-b` cover materially the same scope.

## Consolidation Candidates

- `example-a` and `example-b`: named, not merged.

## Metadata

- run_date_utc: `2026-11-02`
- branch: `self-improve-2026-11-02`
- registry_schema_version: `1`
