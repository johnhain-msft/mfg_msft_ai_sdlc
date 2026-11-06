// AC24: the lab test gate runs `npm ci` and `npm test` inside a subshell whose GH_DATA_DIR is a fresh temporary directory, after
// `gh extension install github/gh-aw --pin v0.86.2` has installed the pinned extension into it, so that the orchestrator's own gh-aw
// and its lockfiles are never downgraded; it covers the three test files that the registry names, and exits 1 if one is absent.
// The command is the one the preset ships (sdlc.yaml, rendered into post-steps), run under bash with recording gh and npm shims.
//
// Known limit, recorded in the spec (§4, implementation findings, item 1): the real `gh` documents no GH_DATA_DIR and finds its extensions
// through XDG_DATA_HOME, so this criterion, as written, isolates the variable that it names and not the extension directory of a real runner.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DRIFT_KEYS, driftPreset, driftWorkflow } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";

const REQUIRED_TESTS = ["tests/content-currency/registry-consumed.test.ts", "tests/lab-structure/lab10-contract.test.ts", "tests/workshop/time-budget.test.ts"];
const PARENT_DATA_DIR = path.join(os.tmpdir(), "sdlc-s2-parent-gh-data");
const defaultDataDirs = [path.join(os.homedir(), ".local", "share", "gh"), path.join(process.env.APPDATA ?? "", "GitHub CLI")];

const isolatedCommand = (key) => driftPreset(key).driftAudit.verifyCommands[1];
const afterwards = (command) => `${command}\necho "PARENT_AFTER=\${GH_DATA_DIR-unset}"`;

for (const key of ["copilot-lab", "self-improving-agents"]) {
  test(`AC24: the gate of ${key} installs the pinned gh-aw into a fresh GH_DATA_DIR, and runs npm ci and npm test under that same directory`, { skip: BASH_SKIP }, async () => {
    const command = isolatedCommand(key);
    assert.ok(command.includes("gh extension install github/gh-aw --pin v0.86.2"), "the pin of the registry");
    assert.equal(driftWorkflow(key).frontmatter["post-steps"][1].run, command, "and it is the rendered post-step");
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    try {
      const outcome = await gate.runScript(afterwards(command), { env: { GH_DATA_DIR: PARENT_DATA_DIR, GH_TOKEN: "ghs_fixturetoken" }, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(outcome.code, 0, outcome.stderr);
      const calls = gate.shims.log();
      assert.deepEqual(calls.map((call) => [call.tool, ...call.args]), [["gh", "extension", "install", "github/gh-aw", "--pin", "v0.86.2"], ["npm", "ci"], ["npm", "test"]], "in this order, and nothing else");
      const dirs = new Set(calls.map((call) => call.GH_DATA_DIR));
      assert.equal(dirs.size, 1, "all three ran under the same GH_DATA_DIR");
      const [dataDir] = dirs;
      assert.ok(dataDir && dataDir !== PARENT_DATA_DIR, "which differs from the parent's");
      for (const standard of defaultDataDirs) assert.notEqual(path.resolve(dataDir.replace(/^\/([a-z])\//, "$1:/")), path.resolve(standard), "and from the default");
      assert.equal(dataDir.includes("gh-aw") || dataDir.includes("sdlc-s2"), false, "a fresh mktemp -d directory, not a name this suite chose");
      const lastLine = outcome.stdout.trim().split("\n").pop().replace(/\\/g, "/");
      assert.equal(lastLine, `PARENT_AFTER=${PARENT_DATA_DIR.replace(/\\/g, "/")}`, "the parent environment is unchanged afterwards");
      assert.equal(calls.every((call) => call.cwd.replace(/\\/g, "/").endsWith("day-in-the-life-copilot-lab") || /[/\\]day-in-the-life-copilot-lab$/i.test(call.cwd)), true, "inside the target checkout");
    } finally {
      gate.cleanup();
    }
  });

  test(`AC24: with no GH_DATA_DIR in the parent the subshell still gets one, and the parent has none afterwards (${key})`, { skip: BASH_SKIP }, async () => {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    try {
      const outcome = await gate.runScript(afterwards(isolatedCommand(key)), { env: { GH_TOKEN: "ghs_fixturetoken" }, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.stdout, /PARENT_AFTER=unset/);
      assert.ok(gate.shims.log().every((call) => typeof call.GH_DATA_DIR === "string" && call.GH_DATA_DIR !== ""));
      assert.equal(process.env.GH_DATA_DIR, undefined, "and this process was not touched");
    } finally {
      gate.cleanup();
    }
  });

  for (const file of REQUIRED_TESTS) {
    test(`AC24: the gate of ${key} exits 1 when ${file} is absent from the target checkout, before it installs or runs anything`, { skip: BASH_SKIP }, async () => {
      const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
      try {
        gate.remove(file);
        const outcome = await gate.runScript(isolatedCommand(key), { env: { GH_TOKEN: "ghs_fixturetoken" }, workingDirectory: "day-in-the-life-copilot-lab" });
        assert.equal(outcome.code, 1);
        assert.ok(outcome.stderr.includes(`missing required test file ${file}`), outcome.stderr);
        assert.deepEqual(gate.shims.log(), [], "neither gh nor npm was called");
      } finally {
        gate.cleanup();
      }
    });
  }
}

test("AC24: a failing gh extension install, npm ci or npm test makes the gate exit 1, and nothing after the failure runs", { skip: BASH_SKIP }, async () => {
  const cases = [
    { env: { SDLC_S2_GH_FAIL: JSON.stringify(["extension install"]) }, ran: [["gh", "extension", "install", "github/gh-aw", "--pin", "v0.86.2"]] },
    { env: { SDLC_S2_NPM_FAIL: JSON.stringify(["ci"]) }, ran: [["gh", "extension", "install", "github/gh-aw", "--pin", "v0.86.2"], ["npm", "ci"]] },
    { env: { SDLC_S2_NPM_FAIL: JSON.stringify(["test"]) }, ran: [["gh", "extension", "install", "github/gh-aw", "--pin", "v0.86.2"], ["npm", "ci"], ["npm", "test"]] },
  ];
  for (const { env, ran } of cases) {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    try {
      const outcome = await gate.runScript(isolatedCommand("copilot-lab"), { env: { GH_TOKEN: "ghs_fixturetoken", ...env }, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(outcome.code, 1, JSON.stringify(env));
      assert.deepEqual(gate.shims.log().map((call) => [call.tool, ...call.args]), ran);
    } finally {
      gate.cleanup();
    }
  }
});

test("AC24: the orchestrator's own gh-aw is not downgraded: the command never installs into the default data directory or changes the parent's", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    const command = isolatedCommand(key);
    const install = command.indexOf("gh extension install");
    const isolate = command.indexOf('GH_DATA_DIR="$(mktemp -d)"');
    assert.ok(isolate > -1 && install > isolate, "GH_DATA_DIR is set before the extension is installed");
    assert.ok(command.startsWith("(") && command.endsWith(")"), "inside a subshell, so that the export does not reach the parent");
    assert.ok(command.includes("set -euo pipefail"), "and with errors fatal");
    for (const file of REQUIRED_TESTS) assert.ok(command.includes(file), file);
    assert.ok(command.indexOf("npm ci") > install && command.indexOf("npm test") > command.indexOf("npm ci"), "npm ci, then npm test, after the install");
    assert.equal(/--upgrade|extension upgrade|extension remove/.test(command), false);
  }
  assert.ok(DRIFT_KEYS.includes("copilot-lab"));
  assert.equal(fs.existsSync(PARENT_DATA_DIR), false, "this test created nothing in the parent data directory");
});

test("AC24: the gate step passes GH_TOKEN to gh, because the compiler requires it in the environment of any step that invokes the gh CLI", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    const step = driftWorkflow(key).frontmatter["post-steps"][1];
    assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
    assert.equal(step["working-directory"], "day-in-the-life-copilot-lab");
    assert.equal("continue-on-error" in step, false);
    assert.equal("if" in step, false);
  }
});
