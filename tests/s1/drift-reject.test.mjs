// AC28: reconciliation rejects an invalid drift configuration before any file is written.
import assert from "node:assert/strict";
import test from "node:test";
import { checkRendered } from "../../src/reconcile.mjs";
import { fixture, minimalManifest, readText, referenceRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const CASES = [
  { file: "wildcard-url.yaml", projectKey: "wildcard-docs", rule: "drift-watch-url-invalid", detail: "https://*.github.com/" },
  { file: "no-instructions.yaml", projectKey: "no-instructions", rule: "drift-instructions-missing", detail: "instructions" },
  { file: "blank-verify-commands.yaml", projectKey: "no-verify", rule: "drift-verify-commands-missing", detail: "verifyCommands" },
  { file: "duplicate-close-older-key.yaml", projectKey: "clash", rule: "close-older-key-duplicate", detail: "sdlc-drift-clash" },
];

for (const { file, projectKey, rule, detail } of CASES) {
  test(`AC28: ${file} returns status error naming project '${projectKey}' and leaves .github/workflows unchanged`, async () => {
    const workspace = createWorkspace({ manifestText: readText(fixture("drift-invalid", file)) });
    try {
      workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
      const before = workspace.hash();
      const result = await workspace.reconcile(referenceRequest());
      assert.equal(result.status, "error");
      assert.deepEqual(result.generatedWorkflows, []);
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => error.startsWith(`${rule}: `)), `${rule} in ${errors.join(" | ")}`);
      assert.ok(errors.some((error) => error.includes(`'${projectKey}'`)), `the projectKey is named: ${errors.join(" | ")}`);
      assert.ok(errors.some((error) => error.includes(detail)), `the offending value is named: ${errors.join(" | ")}`);
      assert.equal(workspace.hash(), before, ".github/workflows is unchanged");
      assert.equal(workspace.shims.compileCalls().length, 0, "the compiler is never reached");
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC28: a drift workflow whose checkout has no entry for its target-repo is rejected by checkRendered, naming the project", () => {
  const files = new Map([[".github/workflows/drift-alpha-service.md", readText(fixture("drift-invalid", "missing-checkout-mapping.md"))]]);
  const [entry] = checkRendered(files, referenceRequest(), minimalManifest());
  assert.equal(entry.valid, false);
  assert.ok(entry.errors.some((error) => /^drift-checkout-mapping-missing: project 'alpha-service': /.test(error) && error.includes("acme-labs/alpha-service")), entry.errors.join("\n"));
});

test("AC28: a drift workflow whose close-older-key is empty is rejected by checkRendered", () => {
  const text = readText(fixture("rendered-minimal", "drift-alpha-service.md")).replace("close-older-key: sdlc-drift-alpha-service", 'close-older-key: ""');
  const files = new Map([[".github/workflows/drift-alpha-service.md", text]]);
  const [entry] = checkRendered(files, referenceRequest(), minimalManifest());
  assert.equal(entry.valid, false);
  assert.ok(entry.errors.some((error) => /^drift-close-older-key-missing: project 'alpha-service'/.test(error)), entry.errors.join("\n"));
});

test("AC28: a disabled project is not checked, so its empty drift configuration is accepted", async () => {
  const text = readText(fixture("drift-invalid", "no-instructions.yaml")).replace("enabled: true", "enabled: false");
  const workspace = createWorkspace({ manifestText: text });
  try {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(workspace.list(".github/workflows").some((file) => file.includes("/drift-")), false, "no drift workflow is rendered");
  } finally {
    workspace.cleanup();
  }
});

test("AC21: a file that exists only beside a manifest in a subdirectory is not found, because the path is repository-relative", async () => {
  const text = readText(fixture("drift-invalid", "no-instructions.yaml")).replace("instructionsFile: null", "instructionsFile: instructions/beside.md");
  const workspace = createWorkspace({ manifestText: text, files: { "config/fleet.yaml": text, "config/instructions/beside.md": "beside the manifest\n" } });
  try {
    const before = workspace.hash();
    const result = await workspace.reconcile({ ...referenceRequest(), manifestPath: "config/fleet.yaml" });
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(
      errors.some((error) => error.startsWith("drift-instructions-file: ") && error.includes("'instructions/beside.md' does not exist") && error.includes("config/fleet.yaml")),
      errors.join("\n"),
    );
    assert.equal(workspace.hash(), before, ".github/workflows is unchanged");
    assert.equal(workspace.shims.compileCalls().length, 0, "the compiler is never reached");
  } finally {
    workspace.cleanup();
  }
});

test("AC28: an instructionsFile that does not exist, escapes the repository or is not a file is rejected", async () => {
  for (const [instructionsFile, expected] of [
    ["instructions/missing.md", "does not exist"],
    ["instructions", "is not a file"],
  ]) {
    const text = readText(fixture("drift-invalid", "no-instructions.yaml")).replace("instructionsFile: null", `instructionsFile: ${instructionsFile}`);
    const workspace = createWorkspace({ manifestText: text, files: { "instructions/.keep": "" } });
    try {
      const result = await workspace.reconcile(referenceRequest());
      assert.equal(result.status, "error", instructionsFile);
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => error.startsWith("drift-instructions-file: ") && error.includes(expected)), errors.join("\n"));
    } finally {
      workspace.cleanup();
    }
  }
  const text = readText(fixture("drift-invalid", "no-instructions.yaml")).replace("instructionsFile: null", "instructionsFile: ../outside.md");
  const workspace = createWorkspace({ manifestText: text });
  try {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("schema-validation: ")), "the schema rejects '..'");
  } finally {
    workspace.cleanup();
  }
});
