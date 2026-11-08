// AC17: remediation limits (the `remediationPolicy` that plan.md §2 names for S2, which is not a field of the C2 driftAudit shape). The preset
// bounds what the agent may change directly through the project's instructions and the draft and reviewers fields, with no new driftAudit
// field. For the lab audit: registry edits only for safe updates (patch or minor SDK bumps, fixed redirected URLs, added in-scope MCP servers),
// with majors and model-catalogue churn recorded in the report only, and only mechanical edits to lab files, never rewriting prose. For the
// self-improving-agents workflow: mechanical fixes only, with non-mechanical concerns flagged and duplicated-responsibility pairs named but not merged.
import assert from "node:assert/strict";
import test from "node:test";
import { abs, DRIFT_KEYS, driftWorkflow, presetManifest, readText } from "./helpers/fixtures.mjs";

const AUDIT_KEYS = ["buildCommands", "draft", "enabled", "instructions", "instructionsFile", "knowledgeSources", "reviewers", "schedule", "upkeepStrategy", "verifyCommands"];

/** The sentences of a Markdown text: bullets and lines are split, then each line at a full stop that ends a sentence. */
function sentences(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/(?<=\.)\s+(?=[A-Z`])/));
}

const lab = () => sentences(readText(abs("instructions", "copilot-lab.md")));
const improving = () => sentences(readText(abs("instructions", "self-improving-agents.md")));

test("AC17: copilot-lab.md bounds registry edits to safe updates, as a sentence of its own", () => {
  assert.ok(lab().includes("Registry edits are for safe updates only: patch or minor SDK bumps, fixed redirected URLs and added in-scope MCP servers."));
});

test("AC17: copilot-lab.md records majors and model-catalogue churn in the report only, as a sentence of its own", () => {
  assert.ok(lab().includes("Record major version changes and model-catalogue churn in the report only."));
});

test("AC17: copilot-lab.md allows only mechanical edits to lab files and never rewriting prose, as separate sentences", () => {
  assert.ok(lab().includes("Edit lab files mechanically only (for example a moved URL or a renamed product)."));
  assert.ok(lab().includes("Never rewrite prose."));
});

test("AC17: self-improving-agents.md allows mechanical fixes only, flags non-mechanical concerns and names duplicated-responsibility pairs without merging them, as separate sentences", () => {
  const all = improving();
  assert.ok(all.some((sentence) => /^Mechanical, low-risk fixes only:/.test(sentence)), "mechanical fixes only");
  assert.ok(all.includes("Never rewrite an agent's core instructions, tone or scope, and never delete an agent, skill or prompt."));
  assert.ok(all.includes("Flag those for human review in the report."), "non-mechanical concerns are flagged");
  assert.ok(all.some((sentence) => /^`## Consolidation Candidates`: duplicated-responsibility pairs, named but not merged\.$/.test(sentence)), "pairs are named but not merged");
  assert.ok(all.includes("Never edit the lab's `.github/workflows/self-improving-agents.md` or its compiled `.lock.yml`."));
});

test("AC17: the bounds reach the rendered prompts of the two lab workflows, and the draft and reviewers fields carry the rest of the policy", () => {
  assert.ok(driftWorkflow("copilot-lab").body.includes("Registry edits are for safe updates only"));
  assert.ok(driftWorkflow("self-improving-agents").body.includes("Mechanical, low-risk fixes only"));
  assert.equal(driftWorkflow("self-improving-agents").frontmatter["safe-outputs"]["create-pull-request"].draft, true);
  assert.deepEqual(driftWorkflow("copilot-lab").frontmatter["safe-outputs"]["create-pull-request"].reviewers, []);
});

test("AC17: every preset driftAudit block has exactly the keys of AC1 and no remediationPolicy key", () => {
  for (const project of presetManifest().projects) {
    assert.deepEqual(Object.keys(project.driftAudit).sort(), AUDIT_KEYS, project.projectKey);
    assert.equal("remediationPolicy" in project.driftAudit, false, project.projectKey);
    assert.equal("remediationPolicy" in project, false, project.projectKey);
  }
  assert.equal(readText(abs("sdlc.yaml")).includes("remediationPolicy"), false);
  for (const key of DRIFT_KEYS) assert.equal(JSON.stringify(driftWorkflow(key).frontmatter).includes("remediationPolicy"), false, key);
});

test("AC17: the schema gains no field: remediationPolicy is not a property of any definition", () => {
  const schema = readText(abs("schemas", "sdlc.schema.json"));
  assert.equal(schema.includes("remediationPolicy"), false);
  assert.equal(schema.includes("workflowKey"), false, "and neither is <workflowKey>");
});
