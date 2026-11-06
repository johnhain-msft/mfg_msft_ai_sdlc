// AC16: lab registry audit (gated by OQ22, OQ23, OQ24, OQ25). The drift-copilot-lab agent audits docs/_meta/registry.yaml and generates
// docs/_meta/audit-report.md fresh from docs/_meta/audit-report.template.md. It derives from the registry's own contents, at run time, whether a
// freshness threshold is stated, where verification dates are recorded and which is latest, whether a structured mapping from a claim to the
// files that consume it exists, and which consumers its comments name; nothing here hard-codes a threshold, a date location or a mapping, and
// each of the four points that cannot be determined is recorded in `## Checks`.
//   The four open questions are CONTRADICTED observations about the lab's registry: there is no age-based threshold (OQ22), dates are also
//   recorded in comments and in structured last_verified fields (OQ23), there is no structured claim-to-file mapping (OQ24) and consumers are
//   named in comments and in at least one structured note (OQ25). This test therefore asserts that the prompt asks for the derivation, and
//   that the implementation encodes none of the four answers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { abs, driftWorkflow, readText, REPO_ROOT } from "./helpers/fixtures.mjs";

const instructions = () => readText(abs("instructions", "copilot-lab.md"));
const body = () => driftWorkflow("copilot-lab").body;

test("AC16: the rendered prompt carries the four derive-at-run-time instructions, in order, and says not to take them from this text", () => {
  const text = body();
  assert.ok(text.includes(instructions().replace(/\s+$/, "")), "instructions/copilot-lab.md is rendered into the prompt, unmodified");
  assert.match(text, /read `docs\/_meta\/registry\.yaml` and work out from its own contents, and not from this text:/);
  const points = [
    "1. whether a freshness threshold is stated, and what it is;",
    "2. where verification dates are recorded, and which of them is the latest;",
    "3. whether a structured mapping from a claim to the files that consume it exists;",
    "4. which consumers its comments name.",
  ];
  let from = text.indexOf("## Read at run time, never assume");
  assert.ok(from > -1);
  for (const point of points) {
    const at = text.indexOf(point, from);
    assert.ok(at > from, point);
    from = at;
  }
});

test("AC16: the prompt tells the agent to record each undetermined point in ## Checks and not to hard-code a threshold, a date location or a mapping", () => {
  const text = body();
  assert.match(text, /Do not hard-code a threshold, a date location or a claim-to-file mapping\./);
  assert.match(text, /Record in the `## Checks` section of the report each of these four points that you could not determine\./);
});

test("AC16: the prompt tells the agent to generate docs/_meta/audit-report.md fresh from docs/_meta/audit-report.template.md", () => {
  const text = body();
  assert.match(text, /The report is `docs\/_meta\/audit-report\.md`, generated fresh from `docs\/_meta\/audit-report\.template\.md` on every run\./);
  assert.match(text, /`## Summary`, `## Checks`, `## Suggestions for Additions` and `## Metadata`/);
});

test("AC16: the instructions state no threshold, date or file mapping of their own", () => {
  const text = instructions();
  const withoutPlaceholders = text.replace(/YYYY-MM-DD/g, "");
  assert.equal(/\b\d{4}-\d{2}-\d{2}\b/.test(withoutPlaceholders), false, "no concrete date");
  assert.equal(/\b\d+\s*(?:days?|weeks?|months?|years?)\b/i.test(text), false, "no age threshold");
  assert.equal(/draft_pr_if_changes_exceed|last_verified|supported_keys|consumers:|used_in|referenced_by/.test(text), false, "no key of the registry that holds a threshold, a date or a mapping");
  assert.equal(/tests\/content-currency|tests\/lab-structure|tests\/workshop|labs\/lab\d+/.test(text), false, "no consumer file named as a fact");
});

test("AC16: the validator and the other S2 scripts encode no freshness threshold, no verification-date location and no claim-to-file mapping", () => {
  const files = [abs("src", "validate-copilot-lab-audit.mjs"), abs("src", "snapshot-watch-sources.mjs"), ...fs.readdirSync(abs("src", "drift"), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => abs("src", "drift", entry.name))];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of [/last_verified/, /draft_pr_if_changes_exceed/, /freshness_threshold|max_age|stale_after|review_by/, /consumers?\s*[:=]/, /registry-consumed|lab10-contract|time-budget/]) {
      assert.equal(pattern.test(text), false, `${path.relative(REPO_ROOT, file)} matches ${pattern}`);
    }
  }
});

test("AC16: the open questions OQ22 to OQ25 are still open in the spec: this implementation resolves none of them", () => {
  const spec = readText(abs("specs", "02-upstream-drift-automation.md"));
  for (const id of ["OQ22", "OQ23", "OQ24", "OQ25"]) {
    const row = spec.split("\n").find((line) => line.startsWith(`| ${id} |`));
    assert.ok(row, `${id} is in §4`);
    assert.match(row, /CONTRADICTED/, `${id} stays CONTRADICTED`);
    assert.match(row, /\| AC16 \|$/, `${id} still blocks AC16`);
  }
});

test("AC16: the registry audit is not given any of the lab's scheduled workflows to edit: the prompt forbids .github/workflows/ and the lab's own audit stays in place", () => {
  assert.match(body(), /Never edit, recompile or delete anything under `\.github\/workflows\/`/);
  assert.equal(fs.existsSync(abs(".github", "workflows", "weekly-content-audit.md")), false);
});
