// AC12, AC13, AC16 (compiler diagnostics) and AC18: the ReconcileResult contract and its error handling.
import assert from "node:assert/strict";
import test from "node:test";
import { clone, fixture, readJson, readText, referenceRequest, withRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const okRecording = readJson(fixture("compile-output.ok.json"));
const errorRecording = readJson(fixture("compile-output.error.json"));
const RULE_ID = /^[a-z0-9-]+: .+/;

const PRESET_PAIRS = [
  "cascade-ai-copilot-lab",
  "cascade-ai-github-intermediate",
  "cascade-ai-pipeline-showcase",
  "cascade-mechanical-ghec-admin",
  "drift-copilot-lab",
  "drift-gh-admin-msft",
  "drift-self-improving-agents",
  "sdlc-onboard",
].map((id) => ({ sourceMd: `.github/workflows/${id}.md`, lockYml: `.github/workflows/${id}.lock.yml` }));

async function withWorkspace(options, body) {
  const workspace = createWorkspace(options);
  try {
    return await body(workspace);
  } finally {
    workspace.cleanup();
  }
}

function assertResultShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ["generatedWorkflows", "repoConfigPath", "status", "validationResults"]);
  assert.ok(result.status === "ok" || result.status === "error");
  assert.ok(Array.isArray(result.generatedWorkflows));
  for (const pair of result.generatedWorkflows) {
    assert.deepEqual(Object.keys(pair).sort(), ["lockYml", "sourceMd"]);
    assert.equal(typeof pair.sourceMd, "string");
    assert.equal(typeof pair.lockYml, "string");
  }
  assert.equal(typeof result.repoConfigPath, "string");
  assert.ok(Array.isArray(result.validationResults));
  for (const entry of result.validationResults) {
    assert.deepEqual(Object.keys(entry).sort(), ["errors", "file", "valid"]);
    assert.equal(typeof entry.file, "string");
    assert.equal(typeof entry.valid, "boolean");
    assert.ok(Array.isArray(entry.errors) && entry.errors.every((error) => typeof error === "string"));
  }
}

test("AC12: an ok result has exactly the four keys of ReconcileResult, with the specified types", async () => {
  await withWorkspace({}, async (workspace) => {
    const result = await workspace.reconcile(referenceRequest());
    assertResultShape(result);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
  });
});

test("AC12: an error result has the same four keys", async () => {
  await withWorkspace({}, async (workspace) => {
    const result = await workspace.reconcile(withRequest({ appSlug: "bad slug]" }));
    assertResultShape(result);
    assert.equal(result.status, "error");
  });
});

test("AC13: generatedWorkflows holds the eight pairs sorted by path and not the router; repoConfigPath is aw.json", async () => {
  await withWorkspace({}, async (workspace) => {
    const result = await workspace.reconcile(referenceRequest());
    assert.deepEqual(result.generatedWorkflows, PRESET_PAIRS);
    assert.equal(result.repoConfigPath, ".github/workflows/aw.json");
    const paths = result.generatedWorkflows.map((pair) => pair.sourceMd);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(paths.some((path) => path.endsWith("cascade-router.yml")), false);
    for (const pair of result.generatedWorkflows) {
      assert.ok(workspace.exists(pair.sourceMd), pair.sourceMd);
      assert.ok(workspace.exists(pair.lockYml), pair.lockYml);
    }
    assert.ok(workspace.exists(".github/workflows/cascade-router.yml"));
  });
});

test("AC13: the compile step is exactly `gh aw compile --strict --purge --json`; a dry run uses --no-emit instead of --purge", async () => {
  await withWorkspace({}, async (workspace) => {
    await workspace.reconcile(referenceRequest());
    const calls = workspace.shims.compileCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["aw", "compile", "--strict", "--purge", "--json"]);
    workspace.shims.reset();
    await workspace.reconcile(withRequest({ dryRun: true }));
    const dry = workspace.shims.compileCalls();
    assert.equal(dry.length, 1);
    assert.deepEqual(dry[0].args, ["aw", "compile", "--strict", "--no-emit", "--json"]);
  });
});

test("AC13: every element of the recorded compiler output is mapped to one validationResults entry (file, valid, errors)", async () => {
  await withWorkspace({ compile: { mode: "ok-recorded", outputFile: fixture("compile-output.ok.json") } }, async (workspace) => {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.validationResults.length, okRecording.length);
    okRecording.forEach((element, index) => {
      assert.deepEqual(result.validationResults[index], { file: element.workflow, valid: element.valid, errors: [] });
    });
  });
});

test("AC13: status is ok if and only if every validationResults entry is valid", async () => {
  const flipped = clone(okRecording);
  flipped[3].valid = false;
  flipped[3].errors = [{ type: "parse_error", message: "synthetic failure of one workflow" }];
  const scratch = createWorkspace();
  const recordingPath = scratch.path("../flipped.json");
  scratch.write("../flipped.json", JSON.stringify(flipped));
  try {
    scratch.shims.compile({ mode: "ok-recorded", outputFile: recordingPath });
    const before = scratch.hash();
    const result = await scratch.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    assert.equal(result.validationResults.filter((entry) => entry.valid).length, okRecording.length - 1);
    const bad = result.validationResults.find((entry) => !entry.valid);
    assert.equal(bad.file, flipped[3].workflow);
    assert.deepEqual(bad.errors, ["compile-error: synthetic failure of one workflow"]);
    assert.deepEqual(result.generatedWorkflows, []);
    assert.equal(scratch.hash(), before, "the failed run is rolled back");
  } finally {
    scratch.cleanup();
  }
});

test("AC16: with the compiler returning the recorded error output the result is status error and the diagnostics pass through verbatim", async () => {
  await withWorkspace({ compile: { mode: "error-recorded", outputFile: fixture("compile-output.error.json") } }, async (workspace) => {
    const before = workspace.hash();
    const result = await workspace.reconcile(referenceRequest());
    assertResultShape(result);
    assert.equal(result.status, "error");
    assert.equal(result.validationResults.length, errorRecording.length);
    const failing = errorRecording.filter((element) => !element.valid);
    assert.equal(failing.length, 1);
    const entry = result.validationResults.find((candidate) => candidate.file === failing[0].workflow);
    assert.equal(entry.valid, false);
    assert.equal(entry.errors.length, failing[0].errors.length);
    failing[0].errors.forEach((error, index) => {
      assert.equal(entry.errors[index], `compile-error: ${error.message}`, "the compiler message is carried unchanged after the rule id");
    });
    for (const other of result.validationResults.filter((candidate) => candidate !== entry)) assert.equal(other.valid, true, other.file);
    assert.equal(workspace.hash(), before, "every written file is rolled back");
  });
});

test("AC18: every error fixture resolves without rejecting or exiting, and every error string starts with a kebab-case rule id", async () => {
  const exitSpy = process.exit;
  process.exit = () => {
    throw new Error("reconcile() must never call process.exit");
  };
  try {
    const scenarios = [
      ["bad request", {}, withRequest({ appSlug: "bad slug]" })],
      ["request field missing", {}, withRequest({ dryRun: undefined })],
      ["request that is not an object", {}, 7],
      ["schema failure", { manifestText: readText(fixture("manifest.invalid-schema.yaml")) }, referenceRequest()],
      ["auto-merge true", { manifestText: readText(fixture("manifest.auto-merge-true.yaml")) }, referenceRequest()],
      ["unreadable manifest", {}, withRequest({ manifestPath: "does-not-exist.yaml" })],
      ["unparseable manifest", { manifestText: "projects: [unterminated\n  - : :\n" }, referenceRequest()],
      ["manifest that is not an object", { manifestText: "- just\n- a list\n" }, referenceRequest()],
      ["recorded compiler errors", { compile: { mode: "error-recorded", outputFile: fixture("compile-output.error.json") } }, referenceRequest()],
      ["compiler crash", { compile: { mode: "crash" } }, referenceRequest()],
      ["compiler prints no JSON", { compile: { mode: "not-json" } }, referenceRequest()],
      ["compiler writes no lock files", { compile: { mode: "no-locks" } }, referenceRequest()],
      ["compiler missing from PATH", { gh: false }, referenceRequest()],
    ];
    for (const [label, options, request] of scenarios) {
      await withWorkspace(options, async (workspace) => {
        const before = workspace.hash();
        const result = await workspace.reconcile(request);
        assertResultShape(result);
        assert.equal(result.status, "error", label);
        const errors = result.validationResults.flatMap((entry) => entry.errors);
        assert.ok(errors.length > 0, `${label}: at least one error`);
        for (const error of errors) assert.match(error, RULE_ID, `${label}: ${error}`);
        assert.ok(result.validationResults.some((entry) => !entry.valid), label);
        assert.equal(workspace.hash(), before, `${label}: nothing is left behind`);
      });
    }
  } finally {
    process.exit = exitSpy;
  }
});

test("AC18: each failure names the offending value in its message", async () => {
  await withWorkspace({}, async (workspace) => {
    const request = await workspace.reconcile(withRequest({ appSlug: "bad slug]" }));
    assert.ok(request.validationResults[0].errors.some((error) => error.includes("bad slug]")));
    const unreadable = await workspace.reconcile(withRequest({ manifestPath: "nowhere.yaml" }));
    assert.ok(unreadable.validationResults.flatMap((entry) => entry.errors).some((error) => error.includes("nowhere.yaml")));
  });
  await withWorkspace({ manifestText: readText(fixture("manifest.invalid-schema.yaml")) }, async (workspace) => {
    const result = await workspace.reconcile(referenceRequest());
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^schema-validation: sdlc\.yaml#\/projects\/0\/colour: /.test(error)), errors.join("\n"));
  });
});

test("AC12: `node src/reconcile.mjs --request <file>` prints the result as JSON and exits 0 for ok", async () => {
  await withWorkspace({}, async (workspace) => {
    const outcome = workspace.cli(fixture("request.dry-run.json"));
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.json?.status, "ok");
    assertResultShape(outcome.json);
    assert.equal(outcome.json.generatedWorkflows.length, 8);
    assert.equal(outcome.stdout.trim().startsWith("{"), true, "stdout holds only the JSON object");
  });
});

test("AC12: the same command with request.invalid.json exits 1 with status error", async () => {
  await withWorkspace({}, async (workspace) => {
    const outcome = workspace.cli(fixture("request.invalid.json"));
    assert.equal(outcome.code, 1);
    assert.equal(outcome.json?.status, "error");
    assert.equal(outcome.json.validationResults[0].file, "BootstrapReconcileRequest");
  });
});

test("AC12: the wrapper reports a missing or unreadable request file as status error with exit 1", async () => {
  await withWorkspace({}, async (workspace) => {
    const missing = workspace.cli(fixture("no-such-request.json"));
    assert.equal(missing.code, 1);
    assert.equal(missing.json?.status, "error");
    assert.match(missing.json.validationResults[0].errors[0], RULE_ID);
  });
});
