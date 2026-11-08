// AC40-AC42: src/verify-immutable-gates.mjs, the JSON it prints and the exit codes it ends with, check (i) (zero diff on the locked paths) and check (ii) (zero
// diff on the test files that another workflow owns). Every run is the real command under `node --frozen-intrinsics` against a git fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT, commitAll, git, runNode, tempDir, writeFiles, HELPERS } from "./helpers/fixtures.mjs";
import { WORKFLOWS, edgeOf, policyOf, read, runGates, scenario, shown } from "./helpers/gates.mjs";

const LOCKED = edgeOf("copilot-lab").immutableGates.zeroDiffPaths;
const SIBLINGS = {
  "cascade-ai-copilot-lab": ["tests/pipeline-showcase.test.ts", "tests/github-intermediate-labs.test.ts", "tests/github-intermediate-workshop.test.ts"],
  "cascade-ai-pipeline-showcase": ["tests/copilot-workshop.test.ts", "tests/github-intermediate-labs.test.ts", "tests/github-intermediate-workshop.test.ts"],
  "cascade-ai-github-intermediate": ["tests/copilot-workshop.test.ts", "tests/pipeline-showcase.test.ts"],
};
/** The file that a test changes for a zero-diff entry: the entry itself, or a file inside a directory entry. */
const FILE_OF = { src: "src/server.ts", scripts: "scripts/build.mjs", "experiences/copilot-workshop/src": "experiences/copilot-workshop/src/app.ts" };
const fileFor = (entry) => FILE_OF[entry] ?? entry;
const append = (dir, relative) => ({ [relative]: `${read(dir, relative)}\n// changed\n` });

test("AC40: an unmodified tree is ok: one JSON object { status: ok, violatingFiles: [] } on standard output and exit 0", () => {
  for (const workflow of WORKFLOWS) {
    const result = scenario({ workflow }).run();
    assert.equal(result.code, 0, `${workflow}: ${shown(result)}`);
    assert.deepEqual(result.json, { status: "ok", violatingFiles: [] }, workflow);
    assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one line of JSON");
  }
});

test("AC41: the preset locks exactly the seventeen paths of contract C7, in order, for every AI edge", () => {
  assert.equal(LOCKED.length, 17);
  for (const edge of ["copilot-lab", "pipeline-showcase", "github-intermediate"]) assert.deepEqual(edgeOf(edge).immutableGates.zeroDiffPaths, LOCKED, edge);
});

for (const entry of LOCKED) {
  test(`AC41: a change to ${entry} makes the command exit 1 and names exactly that file`, () => {
    const file = fileFor(entry);
    const result = scenario({ mutate: (dir) => append(dir, file) }).run();
    assert.equal(result.code, 1, shown(result));
    assert.deepEqual(result.json, { status: "violation", violatingFiles: [file] });
  });
}

test("AC41: a locked path that is deleted, added, renamed, changed only in the work tree or in the index, or left untracked is a violation, and so is a new file in a locked directory", () => {
  const deleted = scenario({ mutate: () => ({ "tests/auth.test.ts": null }) }).run();
  assert.deepEqual(deleted.json, { status: "violation", violatingFiles: ["tests/auth.test.ts"] }, shown(deleted));
  const added = scenario({ mutate: () => ({ "src/evil.ts": "export const x = 1;\n" }) }).run();
  assert.deepEqual(added.json, { status: "violation", violatingFiles: ["src/evil.ts"] });
  const renamed = scenario({ mutate: (dir) => ({ "scripts/build-renamed.mjs": read(dir, "scripts/build.mjs"), "scripts/build.mjs": null }) }).run();
  assert.deepEqual(renamed.json.violatingFiles, ["scripts/build-renamed.mjs", "scripts/build.mjs"], "a rename lists both paths");
  const dirty = scenario({ mutate: (dir) => append(dir, "tests/runtime.test.ts"), commit: false }).run();
  assert.deepEqual(dirty.json, { status: "violation", violatingFiles: ["tests/runtime.test.ts"] }, "an uncommitted edit is the agent's edit too");
  const untracked = scenario({ mutate: () => ({ "scripts/scratch.mjs": "export {};\n" }), commit: false }).run();
  assert.deepEqual(untracked.json.violatingFiles, ["scripts/scratch.mjs"], "an untracked file in a locked directory");
  const staged = scenario();
  writeFiles(staged.dir, append(staged.dir, "tests/catalog.test.ts"));
  git(staged.dir, ["add", "-A"]);
  assert.deepEqual(staged.run().json.violatingFiles, ["tests/catalog.test.ts"], "a staged edit");
});

test("AC41: a locked path that the diff touches in several ways is listed once, with every locked file sorted", () => {
  const result = scenario({ mutate: (dir) => ({ ...append(dir, "src/server.ts"), ...append(dir, "tests/auth.test.ts"), "src/extra.ts": "export {};\n" }) }).run();
  assert.deepEqual(result.json.violatingFiles, ["src/extra.ts", "src/server.ts", "tests/auth.test.ts"]);
  assert.equal(result.code, 1);
});

for (const workflow of WORKFLOWS) {
  test(`AC42: for ${workflow}, editing a sibling test file exits 1 with that file listed; editing the workflow's own test file does not trigger check (ii)`, () => {
    for (const sibling of SIBLINGS[workflow]) {
      const result = scenario({ workflow, mutate: (dir) => append(dir, sibling) }).run();
      assert.equal(result.code, 1, `${sibling}: ${shown(result)}`);
      assert.deepEqual(result.json.violatingFiles, [sibling]);
      assert.match(result.stderr, /check \(ii\)/);
    }
    const own = policyOf(workflow).lockedTestBlocks[0].file;
    const harmless = scenario({
      workflow,
      mutate: (dir) => ({ [own]: `${read(dir, own).replace(/\s*$/, "")}\n\n// a note for the next editor\n` }),
    }).run();
    assert.equal(harmless.code, 0, `${own}: ${shown(harmless)}`);
  });
}

test("AC40: the exit code is 2, with no JSON, for an unknown workflow, a --base that is not 40 lowercase hex, a --base that is no commit of --portfolio and a missing flag", () => {
  const { dir, base } = scenario();
  const cases = [
    ["unknown workflow", ["--portfolio", dir, "--base", base, "--workflow", "cascade-ai-nope"]],
    ["a mechanical workflow is not an AI workflow", ["--portfolio", dir, "--base", base, "--workflow", "cascade-mechanical-ghec-admin"]],
    ["short base", ["--portfolio", dir, "--base", base.slice(0, 7), "--workflow", WORKFLOWS[0]]],
    ["uppercase base", ["--portfolio", dir, "--base", base.toUpperCase(), "--workflow", WORKFLOWS[0]]],
    ["a base that is no commit", ["--portfolio", dir, "--base", "d".repeat(40), "--workflow", WORKFLOWS[0]]],
    ["no --workflow", ["--portfolio", dir, "--base", base]],
    ["no --portfolio", ["--base", base, "--workflow", WORKFLOWS[0]]],
    ["a portfolio that is no git checkout", ["--portfolio", tempDir("sdlc-s4-plain-"), "--base", base, "--workflow", WORKFLOWS[0]]],
    ["an unknown option", ["--portfolio", dir, "--base", base, "--workflow", WORKFLOWS[0], "--fast"]],
  ];
  for (const [label, args] of cases) {
    const result = runGates(dir, base, WORKFLOWS[0], { args });
    assert.equal(result.code, 2, `${label}: ${shown(result)}`);
    assert.equal(result.json, null, `${label}: no JSON on a fatal error`);
    assert.match(result.stderr, /verify-immutable-gates:/);
  }
});

test("AC40: the command is not run from a directory that has no sdlc.yaml unless GITHUB_WORKSPACE names the orchestrator checkout, and a downstream sdlc.yaml is never the policy", () => {
  const { dir, base } = scenario({ mutate: (d) => append(d, "src/server.ts") });
  const elsewhere = tempDir("sdlc-s4-cwd-");
  assert.equal(runGates(dir, base, WORKFLOWS[0], { cwd: elsewhere }).code, 2, "no policy at all is fatal, never a pass");
  const viaWorkspace = runGates(dir, base, WORKFLOWS[0], { cwd: elsewhere, env: { GITHUB_WORKSPACE: REPO_ROOT } });
  assert.deepEqual(viaWorkspace.json, { status: "violation", violatingFiles: ["src/server.ts"] }, shown(viaWorkspace));
  // an agent that adds a manifest with no locked paths to the downstream checkout gains nothing
  writeFiles(dir, { "sdlc.yaml": "projects: []\ndependencyEdges: []\n" });
  commitAll(dir, "an agent's manifest");
  const shadow = runGates(dir, base, WORKFLOWS[0], { cwd: dir, env: { GITHUB_WORKSPACE: REPO_ROOT } });
  assert.equal(shadow.json.status, "violation", shown(shadow));
  assert.ok(shadow.json.violatingFiles.includes("src/server.ts"));
});

test("AC40: a command run by a person without the frozen-intrinsics flag still decides check (i)-(iii), but refuses to run check (iv)", () => {
  const clean = scenario();
  const unfrozen = runGates(clean.dir, clean.base, WORKFLOWS[0], { frozen: false });
  assert.equal(unfrozen.code, 2, shown(unfrozen));
  assert.match(unfrozen.stderr, /frozen-intrinsics/);
  const violated = scenario({ mutate: (dir) => append(dir, "src/server.ts") });
  assert.equal(runGates(violated.dir, violated.base, WORKFLOWS[0], { frozen: false }).code, 1, "a violation found before check (iv) needs no frozen process");
});

test("AC1: the helper names no repository, and completes against the synthetic fleet whose names, paths and titles differ from the portfolio's", () => {
  const fleet = path.join(REPO_ROOT, "tests", "s4", "fixtures", "synthetic-fleet");
  const checkout = path.join(tempDir("sdlc-s4-fleet-"), "checkout");
  fs.cpSync(path.join(fleet, "portfolio"), checkout, { recursive: true });
  git(checkout, ["init", "-q"]);
  const base = commitAll(checkout, "base");
  writeFiles(checkout, { "web/pages/p1.ts": "export const p1 = { lines: ['a calm first page', 'and a second line'] };\n" });
  commitAll(checkout, "an editable change");
  const stub = path.join(checkout, "node_modules", "vitest");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ name: "vitest", type: "module", bin: { vitest: "vitest.mjs" } }));
  const report = { success: true, testResults: [{ name: "/w/checks/site.test.ts", status: "passed", assertionResults: [
    { ancestorTitles: ["site guard rails"], title: "keeps the kernel limits", status: "passed" },
  ] }] };
  fs.writeFileSync(path.join(stub, "report.json"), JSON.stringify(report));
  fs.writeFileSync(path.join(stub, "vitest.mjs"), "import fs from 'node:fs';\nconst r = fs.readFileSync(new URL('./report.json', import.meta.url), 'utf8');\nconst o = process.argv.find((a) => a.startsWith('--outputFile='));\nfs.writeFileSync(o.slice(13), r);\n");
  const result = runNode(HELPERS.gates, ["--portfolio", checkout, "--base", base, "--workflow", "cascade-ai-gadget-lessons"], { cwd: fleet, frozen: true });
  assert.equal(result.code, 0, shown(result));
  assert.deepEqual(JSON.parse(result.stdout), { status: "ok", violatingFiles: [] });
  fs.writeFileSync(path.join(checkout, "kernel", "boot.ts"), "export const boot = 2;\n");
  commitAll(checkout, "a locked change");
  const locked = runNode(HELPERS.gates, ["--portfolio", checkout, "--base", base, "--workflow", "cascade-ai-gadget-lessons"], { cwd: fleet, frozen: true });
  assert.equal(locked.code, 1, shown(locked));
  assert.deepEqual(JSON.parse(locked.stdout), { status: "violation", violatingFiles: ["kernel/boot.ts"] });
});
