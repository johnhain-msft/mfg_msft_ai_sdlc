// AC55: .github/workflows/aw.json, the repository-level gh-aw configuration.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, mutate, presetManifest, readJson, readText, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { stubLockContent } from "./helpers/shims.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const AW = ".github/workflows/aw.json";
const request = referenceRequest();
const preset = presetManifest();
const withList = (list) => toYaml(mutate(preset, (copy) => (copy.protectedFilesExclude = list)));

test("AC55: the committed aw.json has strict: true, no key outside the repository config schema and the literal text", () => {
  const text = readText(abs(AW));
  assert.ok(text.includes('"strict": true'));
  const config = readJson(abs(AW));
  assert.equal(config.strict, true);
  for (const key of Object.keys(config)) assert.ok(["strict", "protected_files"].includes(key), `unexpected key ${key}`);
  if ("protected_files" in config) assert.deepEqual(Object.keys(config.protected_files), ["exclude"]);
  const expected = [...new Set(preset.protectedFilesExclude ?? [])].sort();
  if (expected.length > 0) assert.deepEqual(config.protected_files.exclude, expected);
  else assert.ok(!("protected_files" in config) || config.protected_files.exclude.length === 0, "an empty exclude list may be omitted for compilers that predate the key");
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
  const workspace = createWorkspace({ compile: { mode: "unsupported-protected-files" } });
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

test("AC55: with a non-empty list the compiler's rejection of protected_files is passed through and everything is rolled back", async () => {
  const workspace = createWorkspace({ manifestText: withList(["keep.md"]), instructions: true, compile: { mode: "unsupported-protected-files" } });
  try {
    const before = workspace.hash();
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => error.startsWith("compile-failed: ") && error.includes("protected_files")), errors.join("\n"));
    assert.equal(workspace.shims.compileCalls().length, 1, "no retry that would drop the requested exclusions");
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
