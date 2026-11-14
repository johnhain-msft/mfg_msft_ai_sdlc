// AC14: S1 owns the workflow files, aw.json and the schema; S5 owns aw.yml and every GitHub-side write.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { abs, readText, referenceRequest, REPO_ROOT, sha256, withRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();

test("AC14: a full reconcile run calls the gh shim only for `aw compile` — no GET and no write of any kind is needed", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    const calls = workspace.shims.calls("gh");
    assert.ok(calls.length > 0, "the compiler was invoked");
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 2), ["aw", "compile"], call.args.join(" "));
      assert.equal(call.args.includes("api") || call.args.includes("variable") || call.args.includes("secret") || call.args.includes("workflow"), false);
    }
    assert.equal(workspace.shims.calls("git").length, 0, "a real run needs no git at all");
  } finally {
    workspace.cleanup();
  }
});

test("AC14: a dry run adds only `git init` in its staging directory to the compiler call", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(withRequest({ dryRun: true }));
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const call of workspace.shims.log()) {
      if (call.tool === "gh") assert.deepEqual(call.args.slice(0, 2), ["aw", "compile"]);
      else assert.deepEqual([call.tool, call.args[0]], ["git", "init"]);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC14: aw.yml (S5's file) is neither created, modified nor deleted, wherever it lives", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write("aw.yml", "name: bootstrap-owned\n");
    workspace.write(".github/workflows/aw.yml", "name: bootstrap-owned workflow\non: workflow_dispatch\n");
    const before = [workspace.read("aw.yml"), workspace.read(".github/workflows/aw.yml")];
    const ok = await workspace.reconcile(request);
    assert.equal(ok.status, "ok");
    assert.deepEqual([workspace.read("aw.yml"), workspace.read(".github/workflows/aw.yml")], before);
    workspace.shims.compile({ mode: "crash" });
    workspace.write("sdlc.yaml", `${workspace.read("sdlc.yaml")}\n# touched\n`);
    const failed = await workspace.reconcile(request);
    assert.equal(failed.status, "error");
    assert.deepEqual([workspace.read("aw.yml"), workspace.read(".github/workflows/aw.yml")], before);
    assert.equal(ok.generatedWorkflows.some((pair) => pair.sourceMd.endsWith("/aw.yml") || pair.lockYml.endsWith("/aw.yml")), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC14: git diff --exit-code -- aw.yml exits 0 in the repository", () => {
  const outcome = spawnSync("git", ["diff", "--exit-code", "--", "aw.yml"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stdout);
});

test("AC14: the reconciler writes only the workflow tree and the compiler's two by-products — never the schema, the manifest or the sources", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write("schemas/sdlc.schema.json", readText(abs("schemas", "sdlc.schema.json")));
    workspace.write("src/untouched-sentinel.mjs", "// sentinel\n");
    const outside = ["sdlc.yaml", "schemas", "instructions", "src"];
    const before = workspace.hash(outside);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok");
    assert.equal(workspace.hash(outside), before);
    const top = new Set(workspace.list(".").map((file) => file.split("/")[0]).filter((name) => name !== ".git"));
    assert.deepEqual([...top].sort(), [".github", "instructions", "schemas", "sdlc.yaml", "src"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC14: the engine source contains no GitHub-side write: no variable, secret or workflow command and no non-GET API call", () => {
  const text = readText(abs("src", "reconcile.mjs"));
  // the one workflow command in the source is the step with which a drift run starts the implementation of its report (SPEC-02 AC46): the
  // reconciler writes it into the workflow file and never runs it
  const rendered = `run: 'gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"',`;
  assert.equal(text.split(rendered).length - 1, 1, "the rendered dispatch step is in the source once");
  const source = text.replace(rendered, "");
  assert.equal(/gh\s+(variable|secret|workflow)\b/.test(source), false);
  assert.equal(/-X\s+(PATCH|POST|PUT|DELETE)|--method/.test(source), false);
  assert.equal(/app-manifests/.test(source), false);
  assert.equal(/["'`]api["'`]\s*,/.test(source), false, "no spawn of the API command");
});

test("AC14: running the reconciler twice yields the same digest of the owned files (S1 is their only writer)", async () => {
  const workspace = createWorkspace();
  try {
    await workspace.reconcile(request);
    const first = sha256(workspace.hash());
    await workspace.reconcile(request);
    assert.equal(sha256(workspace.hash()), first);
  } finally {
    workspace.cleanup();
  }
});
