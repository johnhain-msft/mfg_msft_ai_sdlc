// AC55: .github/workflows/aw.json, the repository-level gh-aw configuration.
import assert from "node:assert/strict";
import test from "node:test";
import { reconcile, renderFleet } from "../../src/reconcile.mjs";
import { abs, mutate, parseWorkflow, presetManifest, readJson, readText, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { stubLockContent } from "./helpers/shims.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const AW = ".github/workflows/aw.json";
const request = referenceRequest();
const preset = presetManifest();
const withList = (list) => toYaml(mutate(preset, (copy) => (copy.protectedFilesExclude = list)));
const REJECTING = { mode: "unsupported-protected-files" };

test("AC55: the committed aw.json is strict-only: the compiler that produced the committed locks, gh-aw v1.0.1, rejects protected_files", () => {
  // The repository config schema of v1.0.1 has additionalProperties: false and no protected_files key (the v1.2.0
  // pre-release has it), so the strict-only file is what that compiler accepts. A re-pin to a compiler that accepts the
  // key changes this expectation together with AC55 and section 4 of the spec.
  const header = readText(abs(".github", "workflows", "drift-gh-admin-msft.lock.yml")).split("\n")[0];
  assert.ok(header.includes('"compiler_version":"v1.0.1"'), header);
  assert.equal(readText(abs(AW)), '{\n  "strict": true\n}\n');
  assert.deepEqual(readJson(abs(AW)), { strict: true });
});

test("AC55: a fresh render writes strict: true and protected_files.exclude as the sorted, de-duplicated manifest list", async () => {
  const workspace = createWorkspace({ manifestText: withList(["b.md", "docs/", "a.md", "b.md", "/z/exact.md"]), instructions: true });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.repoConfigPath, AW);
    const config = JSON.parse(workspace.read(AW));
    assert.deepEqual(Object.keys(config).sort(), ["protected_files", "strict"]);
    assert.equal(config.strict, true);
    assert.deepEqual(Object.keys(config.protected_files), ["exclude"]);
    assert.deepEqual(config.protected_files.exclude, ["/z/exact.md", "a.md", "b.md", "docs/"]);
    assert.ok(workspace.read(AW).includes('"strict": true'));
    assert.equal(workspace.read(AW).endsWith("\n"), true);
  } finally {
    workspace.cleanup();
  }
});

test("AC55: an empty manifest list renders protected_files.exclude as an empty array", () => {
  const files = renderFleet(request).files;
  assert.deepEqual(JSON.parse(files.get(AW)), { strict: true, protected_files: { exclude: [] } });
});

test("AC55: changing the manifest list changes the file and triggers the compile stub, which recompiles every workflow in the same run", async () => {
  const workspace = createWorkspace({ manifestText: withList(["a.md"]), instructions: true });
  try {
    const first = await workspace.reconcile(request);
    assert.equal(first.status, "ok");
    const awBefore = workspace.read(AW);
    const driftBefore = workspace.read(".github/workflows/drift-gh-admin-msft.md");
    assert.equal(workspace.shims.compileCalls().length, 1);
    workspace.write("sdlc.yaml", withList(["a.md", "c.md"]));
    const second = await workspace.reconcile(request);
    assert.equal(second.status, "ok");
    assert.notEqual(workspace.read(AW), awBefore);
    assert.deepEqual(JSON.parse(workspace.read(AW)).protected_files.exclude, ["a.md", "c.md"]);
    assert.notEqual(workspace.read(".github/workflows/drift-gh-admin-msft.md"), driftBefore, "the handlers that depend on the list change too");
    const compiles = workspace.shims.compileCalls();
    assert.equal(compiles.length, 2, "one compile per run");
    assert.deepEqual(compiles[1].args, ["aw", "compile", "--strict", "--purge", "--json"], "no file list: every workflow is recompiled");
    for (const pair of second.generatedWorkflows) {
      const source = workspace.read(pair.sourceMd);
      assert.equal(workspace.read(pair.lockYml), stubLockContent(pair.sourceMd.split("/").pop(), Buffer.from(source)), `${pair.lockYml} was recompiled`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC55: a compiler that predates protected_files gets the strict-only config when the manifest list is empty", async () => {
  const workspace = createWorkspace({ compile: REJECTING });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.deepEqual(JSON.parse(workspace.read(AW)), { strict: true });
    assert.equal(workspace.shims.compileCalls().length, 2, "the first compile was rejected and the second one succeeded");
    assert.equal(result.repoConfigPath, AW);
  } finally {
    workspace.cleanup();
  }
});

test("AC55: with a non-empty list a compiler that rejects protected_files still reconciles: strict-only config, same run, whole fleet compiled", async () => {
  const list = ["keep.md", "/docs/changelog.md"];
  const workspace = createWorkspace({ manifestText: withList(list), instructions: true, compile: REJECTING });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.generatedWorkflows.length, 13);
    assert.equal(result.repoConfigPath, AW);
    assert.equal(workspace.read(AW), '{\n  "strict": true\n}\n', "the key the compiler rejects is not written");
    const compiles = workspace.shims.compileCalls();
    assert.equal(compiles.length, 2, "the rejected attempt and the retry");
    for (const call of compiles) assert.deepEqual(call.args, ["aw", "compile", "--strict", "--purge", "--json"], "both attempts compile every workflow");
    for (const pair of result.generatedWorkflows) {
      const source = workspace.read(pair.sourceMd);
      assert.equal(workspace.read(pair.lockYml), stubLockContent(pair.sourceMd.split("/").pop(), Buffer.from(source)), `${pair.lockYml} was compiled`);
    }
    // The manifest list is not lost: every drift and onboarding handler carries it as its own protected-files.exclude (AC64).
    for (const name of ["drift-gh-admin-msft.md", "drift-copilot-lab.md", "drift-self-improving-agents.md", "sdlc-onboard.md"]) {
      const handler = parseWorkflow(workspace.read(`.github/workflows/${name}`)).frontmatter["safe-outputs"]["create-pull-request"];
      assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: ["/docs/changelog.md", "keep.md"] }, name);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC55: after the fallback a second run changes nothing, and a dry run reports the same outcome without writing", async () => {
  const workspace = createWorkspace({ manifestText: withList(["keep.md"]), instructions: true, compile: REJECTING });
  try {
    assert.equal((await workspace.reconcile(request)).status, "ok");
    const settled = workspace.hash();
    assert.equal((await workspace.reconcile(request)).status, "ok");
    assert.equal(workspace.hash(), settled, "the strict-only file and every lock are byte-identical after the second run");
    const dry = await workspace.reconcile({ ...request, dryRun: true });
    assert.equal(dry.status, "ok", JSON.stringify(dry.validationResults));
    assert.equal(workspace.hash(), settled);
  } finally {
    workspace.cleanup();
  }
});

test("AC55: the fallback is reported to the operator, not silent: a log note in process and on stderr of the command line", async () => {
  const workspace = createWorkspace({ manifestText: withList(["keep.md"]), instructions: true, compile: REJECTING });
  try {
    const notes = [];
    const result = await reconcile(request, { cwd: workspace.dir, env: workspace.shims.env(), log: (line) => notes.push(line) });
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(notes.length, 1, notes.join("\n"));
    assert.ok(notes[0].includes("protected_files") && notes[0].includes("strict: true only"), notes[0]);
    assert.ok(notes[0].includes("protectedFilesExclude still reaches every drift and onboarding handler"), "a non-empty list is explained");
    workspace.write("request.json", JSON.stringify(request));
    const cli = workspace.cli(workspace.path("request.json"));
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(cli.json.status, "ok");
    assert.ok(cli.stderr.includes("note: the gh-aw compiler rejected protected_files"), cli.stderr);
    assert.equal(cli.stdout.includes("note:"), false, "the JSON result on stdout is untouched");
  } finally {
    workspace.cleanup();
  }
  const accepting = createWorkspace({ manifestText: withList(["keep.md"]), instructions: true });
  try {
    const notes = [];
    const result = await reconcile(request, { cwd: accepting.dir, env: accepting.shims.env(), log: (line) => notes.push(line) });
    assert.equal(result.status, "ok");
    assert.deepEqual(notes, [], "a compiler that accepts the key needs no note");
  } finally {
    accepting.cleanup();
  }
});

test("AC55: a rejection that is not about protected_files is not retried and is rolled back", async () => {
  const workspace = createWorkspace({ manifestText: withList(["keep.md"]), instructions: true, compile: { mode: "crash" } });
  try {
    const before = workspace.hash();
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.equal(workspace.shims.compileCalls().length, 1, "no retry for an unrelated failure");
    assert.equal(workspace.hash(), before);
  } finally {
    workspace.cleanup();
  }
});

test("AC55: protected-files exclude entries of drift and onboarding handlers are the manifest's list", () => {
  const workspace = createWorkspace({ manifestText: withList(["notes.md", "/docs/changelog.md"]), instructions: true });
  try {
    const files = renderFleet(request, { cwd: workspace.dir }).files;
    for (const name of ["drift-gh-admin-msft.md", "drift-copilot-lab.md", "sdlc-onboard.md"]) {
      assert.ok(files.get(`.github/workflows/${name}`).includes("- /docs/changelog.md\n"), name);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC55: aw.json is byte-identical for the same manifest (LF, UTF-8, no byte order mark)", () => {
  const first = renderFleet(request).files.get(AW);
  const second = renderFleet(request).files.get(AW);
  assert.equal(first, second);
  assert.equal(first.charCodeAt(0), "{".charCodeAt(0));
  assert.equal(first.includes("\r"), false);
});
