// AC17 and AC18: transactional emission with byte-exact rollback.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, mutate, presetManifest, readText, referenceRequest, toYaml, withRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const ERROR_RECORDING = fixture("compile-output.error.json");

/** A workspace that already holds a successful render, so that a failing run has something to destroy. */
async function seeded(options = {}) {
  const workspace = createWorkspace(options);
  const first = await workspace.reconcile(request);
  assert.equal(first.status, "ok", JSON.stringify(first.validationResults));
  return workspace;
}

const state = (workspace) => ({ hash: workspace.hash(), status: workspace.status(), all: workspace.hash(["."]) });
function assertRestored(workspace, before, label) {
  const after = state(workspace);
  assert.equal(after.hash, before.hash, `${label}: the recursive SHA-256 listing of .github and .gitattributes is identical`);
  assert.equal(after.status, before.status, `${label}: git status --porcelain is identical`);
  assert.equal(after.all, before.all, `${label}: the whole working tree is identical`);
}

test("AC17 case 1: a schema failure leaves the generated files and the operator's edits untouched", async () => {
  const workspace = await seeded();
  try {
    workspace.write(`${W}/drift-gh-admin-msft.md`, `${workspace.read(`${W}/drift-gh-admin-msft.md`)}\n<!-- operator note -->\n`);
    workspace.write("sdlc.yaml", readText(fixture("manifest.invalid-schema.yaml")));
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("schema-validation: ")));
    assertRestored(workspace, before, "schema failure");
    assert.ok(workspace.read(`${W}/drift-gh-admin-msft.md`).endsWith("<!-- operator note -->\n"));
  } finally {
    workspace.cleanup();
  }
});

test("AC17 case 2: a compiler that writes a partial lock file and then fails leaves the tree as it was", async () => {
  const workspace = await seeded();
  try {
    const manifest = mutate(presetManifest(), (copy) => (copy.projects[0].driftAudit.instructions = "Instructions that change the rendered workflow."));
    workspace.write("sdlc.yaml", toYaml(manifest));
    workspace.shims.compile({ mode: "partial-error", outputFile: ERROR_RECORDING });
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.some((entry) => !entry.valid && entry.errors.some((error) => error.startsWith("compile-error: "))));
    assertRestored(workspace, before, "partial lock then error");
    assert.notEqual(workspace.read(`${W}/drift-gh-admin-msft.lock.yml`).startsWith("# partial"), true);
  } finally {
    workspace.cleanup();
  }
});

test("AC17 case 3: an uncommitted operator edit to a generated file and an orphan removed by --purge both survive a failed run byte for byte", async () => {
  const workspace = await seeded();
  try {
    const edited = `${workspace.read(`${W}/cascade-router.yml`)}# operator-only comment that the reconciler would overwrite\n`;
    workspace.write(`${W}/cascade-router.yml`, edited);
    const bytesOfEdit = Buffer.from(edited);
    workspace.write(`${W}/old-workflow.lock.yml`, "# an orphan lock that --purge deletes\n");
    workspace.write(`${W}/drift-gh-admin-msft.md`, `${workspace.read(`${W}/drift-gh-admin-msft.md`)}\n<!-- edit -->\n`);
    workspace.shims.compile({ mode: "partial-error", outputFile: ERROR_RECORDING });
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assertRestored(workspace, before, "operator edit and purged orphan");
    assert.ok(Buffer.from(workspace.read(`${W}/cascade-router.yml`)).equals(bytesOfEdit), "the operator's bytes are back");
    assert.equal(workspace.read(`${W}/old-workflow.lock.yml`), "# an orphan lock that --purge deletes\n", "the purged orphan is re-created");
  } finally {
    workspace.cleanup();
  }
});

test("AC17: a failure with nothing pre-existing deletes every file the run created, directories included", async () => {
  const workspace = createWorkspace({ compile: { mode: "error-recorded", outputFile: ERROR_RECORDING } });
  try {
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assertRestored(workspace, before, "fresh tree");
    assert.equal(workspace.exists(".github"), false, "the empty directories the run made are gone too");
  } finally {
    workspace.cleanup();
  }
});

test("AC17: a managed source that is no longer rendered is restored when the run fails after removing it", async () => {
  const workspace = await seeded();
  try {
    const manifest = mutate(presetManifest(), (copy) => (copy.projects = copy.projects.map((project) => (project.projectKey === "self-improving-agents" ? { ...project, driftAudit: { ...project.driftAudit, enabled: false } } : project))));
    workspace.write("sdlc.yaml", toYaml(manifest));
    workspace.shims.compile({ mode: "error-recorded", outputFile: ERROR_RECORDING });
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assertRestored(workspace, before, "removed managed source");
    assert.ok(workspace.exists(`${W}/drift-self-improving-agents.md`));
    assert.ok(workspace.exists(`${W}/drift-self-improving-agents.lock.yml`));
  } finally {
    workspace.cleanup();
  }
});

test("AC17: .github/aw/actions-lock.json and .gitattributes, which the compiler maintains, are restored as well", async () => {
  const workspace = createWorkspace({ compile: { mode: "partial-error", outputFile: ERROR_RECORDING, sideFiles: true } });
  try {
    workspace.write(".gitattributes", "* text=auto eol=lf\n.github/workflows/*.lock.yml linguist-generated=true\n");
    workspace.write(".github/aw/actions-lock.json", '{"entries":{"operator/pin@v1":"1111111111111111111111111111111111111111"}}\n');
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assertRestored(workspace, before, "compiler side files");
    assert.equal(workspace.read(".gitattributes"), "* text=auto eol=lf\n.github/workflows/*.lock.yml linguist-generated=true\n");
    assert.ok(workspace.read(".github/aw/actions-lock.json").includes("operator/pin@v1"));
  } finally {
    workspace.cleanup();
  }
  const empty = createWorkspace({ compile: { mode: "partial-error", outputFile: ERROR_RECORDING, sideFiles: true } });
  try {
    const result = await empty.reconcile(request);
    assert.equal(result.status, "error");
    assert.equal(empty.exists(".gitattributes"), false);
    assert.equal(empty.exists(".github"), false);
  } finally {
    empty.cleanup();
  }
});

test("AC17: a compiler that reports success but leaves a lock file missing fails the run and rolls it back", async () => {
  const workspace = createWorkspace({ compile: { mode: "no-locks" } });
  try {
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^lock-missing: .*\.lock\.yml/.test(error)), errors.join("\n"));
    assertRestored(workspace, before, "missing locks");
  } finally {
    workspace.cleanup();
  }
});

test("AC17: a compiler crash with no JSON output fails the run and rolls it back", async () => {
  const workspace = await seeded();
  try {
    workspace.write("sdlc.yaml", toYaml(mutate(presetManifest(), (copy) => (copy.projects[0].driftAudit.instructions = "changed again"))));
    workspace.shims.compile({ mode: "crash" });
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^compile-failed: .*code 2/.test(error)));
    assertRestored(workspace, before, "compiler crash");
  } finally {
    workspace.cleanup();
  }
});

test("AC17/AC18: when the compiler is not on PATH the run fails with compile-unavailable and nothing is left behind", async () => {
  const workspace = createWorkspace({ gh: false });
  try {
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^compile-unavailable: /.test(error)));
    assertRestored(workspace, before, "no compiler");
  } finally {
    workspace.cleanup();
  }
});

test("AC18: an unexpected I/O failure is returned as status error with a rule id, never thrown, and leaves the tree as it was", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write(".github", "this path is a file, so no workflow can be written below it\n");
    const before = state(workspace);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.every((error) => /^[a-z0-9-]+: .+/.test(error)), errors.join("\n"));
    assertRestored(workspace, before, "I/O failure");
    assert.equal(workspace.read(".github"), "this path is a file, so no workflow can be written below it\n");
  } finally {
    workspace.cleanup();
  }
});

test("AC17: a successful run after a failed one produces the same tree as a clean run (no residue)", async () => {
  const clean = await seeded();
  const retried = createWorkspace({ compile: { mode: "error-recorded", outputFile: ERROR_RECORDING } });
  try {
    assert.equal((await retried.reconcile(request)).status, "error");
    retried.shims.compile({ mode: "ok" });
    assert.equal((await retried.reconcile(request)).status, "ok");
    assert.equal(retried.hash(), clean.hash());
  } finally {
    clean.cleanup();
    retried.cleanup();
  }
});

test("AC17: a failed dry run leaves nothing behind either", async () => {
  const workspace = createWorkspace({ compile: { mode: "error-recorded", outputFile: ERROR_RECORDING } });
  try {
    const before = state(workspace);
    const result = await workspace.reconcile(withRequest({ dryRun: true }));
    assert.equal(result.status, "error");
    assertRestored(workspace, before, "dry run failure");
  } finally {
    workspace.cleanup();
  }
});

test("AC17: compiler-emitted maintenance workflows are removed after the run, and a pre-existing one is restored byte for byte", async () => {
  const workspace = createWorkspace({ compile: { mode: "maintenance" } });
  try {
    workspace.write(`${W}/agentics-maintenance-example-owner-example-repo.yml`, "name: operator edited maintenance workflow\n");
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(workspace.read(`${W}/agentics-maintenance-example-owner-example-repo.yml`), "name: operator edited maintenance workflow\n");
  } finally {
    workspace.cleanup();
  }
  const fresh = createWorkspace({ compile: { mode: "maintenance" } });
  try {
    assert.equal((await fresh.reconcile(request)).status, "ok");
    assert.equal(fresh.list(W).some((file) => file.includes("agentics-maintenance")), false);
  } finally {
    fresh.cleanup();
  }
});
