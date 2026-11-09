// AC1: contract C2 request. The SPEC-01 reconciler renders .github/workflows/drift-<projectKey>.md and its .lock.yml
// from each project's driftAudit configuration when `enabled` is true, and neither when it is false.
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { DRIFT_KEYS, fixture, presetManifest, readText, readYaml, referenceRequest, WORKFLOWS } from "./helpers/fixtures.mjs";

const STRATEGIES = ["content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan", "custom"];
const KINDS = ["changelog", "blog", "docs", "release-notes", "feed"];
const DRIFT_AUDIT_KEYS = [
  "enabled",
  "schedule",
  "upkeepStrategy",
  "instructions",
  "instructionsFile",
  "knowledgeSources",
  "buildCommands",
  "verifyCommands",
  "draft",
  "reviewers",
];
const request = referenceRequest();

const driftFiles = (workspace) => workspace.list(WORKFLOWS).filter((file) => /\/drift-[^/]+\.(?:md|lock\.yml)$/.test(file));

test("AC1: the reconciler renders the three default drift workflows, each with a .lock.yml beside it", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const key of DRIFT_KEYS) {
      assert.ok(workspace.exists(`${WORKFLOWS}/drift-${key}.md`), `drift-${key}.md exists`);
      assert.ok(workspace.exists(`${WORKFLOWS}/drift-${key}.lock.yml`), `drift-${key}.lock.yml exists beside it`);
    }
    assert.deepEqual(driftFiles(workspace), DRIFT_KEYS.flatMap((key) => [`${WORKFLOWS}/drift-${key}.lock.yml`, `${WORKFLOWS}/drift-${key}.md`]).sort(), "no other drift file");
  } finally {
    workspace.cleanup();
  }
});

test("AC1: a manifest whose projects have driftAudit.enabled false yields no drift-*.md and no .lock.yml", async () => {
  const manifest = readYaml(fixture("c2", "disabled", "sdlc.yaml"));
  assert.ok(manifest.projects.length > 0 && manifest.projects.every((project) => project.driftAudit.enabled === false));
  const workspace = createWorkspace({ manifestText: readText(fixture("c2", "disabled", "sdlc.yaml")) });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.deepEqual(driftFiles(workspace), [], "no drift workflow is rendered for a disabled project");
    assert.equal(result.generatedWorkflows.some((pair) => /drift-/.test(pair.sourceMd)), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC1: disabling one project of the preset removes its workflow and its lock, and keeps the other two", async () => {
  const manifest = presetManifest();
  manifest.projects.find((project) => project.projectKey === "self-improving-agents").driftAudit.enabled = false;
  const { default: YAML } = await import("yaml");
  const workspace = createWorkspace({ manifestText: YAML.stringify(manifest, { lineWidth: 0 }), instructions: true });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.deepEqual(
      driftFiles(workspace),
      ["gh-admin-msft", "copilot-lab"].flatMap((key) => [`${WORKFLOWS}/drift-${key}.lock.yml`, `${WORKFLOWS}/drift-${key}.md`]).sort(),
    );
  } finally {
    workspace.cleanup();
  }
});

test("AC1: every driftAudit block of the preset has exactly the keys of the C2 configuration, and its enums hold", () => {
  for (const project of presetManifest().projects) {
    const audit = project.driftAudit;
    assert.deepEqual(Object.keys(audit).filter((key) => key !== "agentSandbox").sort(), [...DRIFT_AUDIT_KEYS].sort(), `${project.projectKey}: the driftAudit keys`);
    assert.equal("agentSandbox" in audit, project.projectKey === "gh-admin-msft", `${project.projectKey}: the one optional key, agentSandbox, is the one of the project that asks for it`);
    assert.deepEqual(Object.keys(audit.knowledgeSources).sort(), ["mcpServers", "packageManifests", "watchUrls"], `${project.projectKey}: the knowledgeSources keys`);
    assert.ok(STRATEGIES.includes(audit.upkeepStrategy), `${project.projectKey}: upkeepStrategy ${audit.upkeepStrategy}`);
    assert.equal(typeof audit.enabled, "boolean");
    assert.equal(typeof audit.draft, "boolean");
    assert.equal(typeof audit.schedule, "string");
    assert.ok(Array.isArray(audit.buildCommands) && Array.isArray(audit.verifyCommands) && Array.isArray(audit.reviewers));
    assert.ok(audit.instructionsFile === null || typeof audit.instructionsFile === "string");
    for (const entry of audit.knowledgeSources.watchUrls) {
      assert.deepEqual(Object.keys(entry).sort(), ["kind", "label", "url"], `${project.projectKey}: a watchUrls entry has url, label and kind`);
      assert.ok(KINDS.includes(entry.kind), `${project.projectKey}: kind ${entry.kind}`);
    }
  }
});

test("AC1: the two manifests of the fixtures use only members of the four upkeepStrategy values and the five kinds", () => {
  const manifest = readYaml(fixture("c2", "disabled", "sdlc.yaml"));
  for (const project of manifest.projects) {
    assert.ok(STRATEGIES.includes(project.driftAudit.upkeepStrategy), project.projectKey);
    for (const entry of project.driftAudit.knowledgeSources.watchUrls) assert.ok(KINDS.includes(entry.kind), entry.url);
  }
});
