// AC61: no GitHub-side write, no git add/commit/push, and every test runs offline against the stubs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { abs, listFiles, readText, referenceRequest, REPO_ROOT, withRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();

/** The AC61 scan of the engine source, exactly as the criterion words it. */
const ENGINE_SCAN = new RegExp("git (add|commit|push)|gh (pr|issue|release|label)");
const SPAWN = "(?:spawn|spawnSync|execFile|execFileSync)";
/** A process spawn whose command is git with a write subcommand, or gh with anything but the compiler. */
const GIT_WRITE_CALL = new RegExp(`${SPAWN}\\(\\s*["'\`]git["'\`]\\s*,\\s*\\[\\s*["'\`](?:add|commit|push)["'\`]`);
const GH_WRITE_CALL = new RegExp(`${SPAWN}\\(\\s*["'\`]gh["'\`]\\s*,\\s*\\[\\s*["'\`](?:pr|issue|release|label|variable|secret|api)["'\`]`);
const SHELL_WRITE_CALL = /(?:exec|execSync)\(\s*["'`](?:git\s+(?:add|commit|push)|gh\s+(?:pr|issue|release|label|variable|secret|api))/;

test("AC61: the shim's argument log for a full reconcile contains only aw subcommands and no write", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    const log = workspace.shims.log();
    assert.ok(log.length > 0);
    for (const call of log) {
      assert.equal(call.tool, "gh", "a real run spawns only the compiler");
      assert.equal(call.args[0], "aw");
      assert.equal(call.args.some((arg) => /^(pr|issue|release|label|variable|secret|api|repo)$/.test(arg)), false);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC61: the git shim logs no add, commit or push across a real run, a dry run and a failed run", async () => {
  const workspace = createWorkspace();
  try {
    await workspace.reconcile(request);
    await workspace.reconcile(withRequest({ dryRun: true }));
    workspace.shims.compile({ mode: "crash" });
    workspace.write("sdlc.yaml", `${workspace.read("sdlc.yaml")}\n# changed\n`);
    await workspace.reconcile(request);
    const gitCalls = workspace.shims.calls("git");
    assert.ok(gitCalls.length >= 1, "the dry run staged with git init");
    for (const call of gitCalls) assert.equal(["add", "commit", "push"].includes(call.args[0]), false, call.args.join(" "));
    for (const call of workspace.shims.calls("gh")) assert.deepEqual(call.args.slice(0, 2), ["aw", "compile"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC61: the engine source contains no commit, staging or push command and no pull-request, issue, release or label command", () => {
  assert.equal(ENGINE_SCAN.test(readText(abs("src", "reconcile.mjs"))), false);
});

test("AC61: no test of tests/s1 spawns a write subcommand of git or gh", () => {
  const files = listFiles(REPO_ROOT, "tests/s1").filter((file) => file.endsWith(".mjs"));
  assert.ok(files.length >= 20);
  for (const file of files) {
    const text = readText(abs(file));
    assert.equal(GIT_WRITE_CALL.test(text), false, `${file}: a git write call`);
    assert.equal(GH_WRITE_CALL.test(text), false, `${file}: a gh call other than the compiler`);
    assert.equal(SHELL_WRITE_CALL.test(text), false, `${file}: a shell command with a write subcommand`);
  }
});

test("AC61: no test and no engine module reaches the network", () => {
  const files = [...listFiles(REPO_ROOT, "tests/s1").filter((file) => file.endsWith(".mjs")), "src/reconcile.mjs"];
  for (const file of files) {
    const text = readText(abs(file));
    assert.equal(/\bfetch\s*\(|from\s+["']node:https?["']|from\s+["']node:net["']|from\s+["']node:dns["']|require\(["']https?["']\)/.test(text), false, file);
  }
});

test("AC61: the only test that spawns gh itself is the opt-in real-compiler test", () => {
  const spawners = listFiles(REPO_ROOT, "tests/s1").filter((file) => file.endsWith(".mjs") && /spawn(Sync)?\(\s*["']gh["']/.test(readText(abs(file))));
  assert.deepEqual(spawners.filter((file) => file !== "tests/s1/compile.test.mjs"), []);
});

test("AC61: the reconciler writes files only in the working tree: the workspace's git index is never touched", async () => {
  const workspace = createWorkspace();
  try {
    const indexPath = path.join(workspace.dir, ".git", "index");
    const before = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : null;
    await workspace.reconcile(request);
    const after = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : null;
    assert.equal(after, before);
    assert.match(workspace.status(), /^\?\? /m, "everything the run wrote is still untracked");
  } finally {
    workspace.cleanup();
  }
});
