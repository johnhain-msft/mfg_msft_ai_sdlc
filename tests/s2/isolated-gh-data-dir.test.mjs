// AC24: the lab test gate runs `npm ci` and `npm test` inside a subshell whose GH_DATA_DIR is a fresh temporary directory, after
// `gh extension install github/gh-aw --pin v0.86.2` has installed the pinned extension into it, so that the orchestrator's own gh-aw
// and its lockfiles are never downgraded; it covers the three test files that the registry names, and exits 1 if one is absent.
// The command is the one the preset ships (sdlc.yaml, rendered into post-steps), run under bash with recording gh and npm shims.
//
// gh has no GH_DATA_DIR: it finds its extensions through XDG_DATA_HOME (else LocalAppData on Windows, else ~/.local/share/gh), so the
// command also exports XDG_DATA_HOME="$GH_DATA_DIR". A test that only compared the GH_DATA_DIR value that a shim reported would pass on
// a command that installs into the runner's own extension directory, so these tests check the effect: the gh shim resolves its
// extension directory by the rule of the real CLI (tests/s2/helpers/shims/shim-runner.mjs) and keeps what was installed where.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DRIFT_KEYS, driftPreset, driftWorkflow, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";

const REQUIRED_TESTS = ["tests/content-currency/registry-consumed.test.ts", "tests/lab-structure/lab10-contract.test.ts", "tests/workshop/time-budget.test.ts"];
const PIN = ["extension", "install", "github/gh-aw", "--pin", "v0.86.2"];
const forward = (value) => value.replace(/\\/g, "/");

const isolatedCommand = (key) => driftPreset(key).driftAudit.verifyCommands[1];
const afterwards = (command) => `${command}\necho "PARENT_AFTER=\${GH_DATA_DIR-unset} \${XDG_DATA_HOME-unset}"`;
const ghCalls = (gate) => gate.shims.calls("gh").filter((call) => call.args[0] === "extension");

/**
 * The environment of the job before the gate: a home directory of its own, so that the default extension directory of the shim is inside
 * the scratch directory, and, when `dataHome` is given, the XDG_DATA_HOME under which the orchestrator's own gh-aw is installed.
 */
function runnerEnv(home, dataHome) {
  const env = { HOME: forward(home), USERPROFILE: forward(home), LOCALAPPDATA: forward(path.join(home, "AppData", "Local")), GH_TOKEN: "ghs_fixturetoken" };
  if (dataHome !== undefined) env.XDG_DATA_HOME = forward(dataHome);
  return env;
}

/** Installs the orchestrator's own gh-aw the way the runner has it, and returns the extension directory that the gh shim chose for it. */
async function installOrchestratorExtension(gate, env) {
  const outcome = await gate.runScript("gh extension install github/gh-aw --pin v1.0.1", { env });
  assert.equal(outcome.code, 0, outcome.stderr);
  return ghCalls(gate).at(-1).dataDir;
}

const listedAs = async (gate, env) => (await gate.runScript("gh extension list", { env })).stdout.trim();

for (const [key, dataHome] of [["copilot-lab", true], ["self-improving-agents", undefined]]) {
  test(`AC24: the gate of ${key} installs the pinned gh-aw into an extension directory of its own, and the orchestrator's gh-aw is still there afterwards`, { skip: BASH_SKIP }, async () => {
    const command = isolatedCommand(key);
    assert.ok(command.includes("gh extension install github/gh-aw --pin v0.86.2"), "the pin of the registry");
    assert.equal(driftWorkflow(key).frontmatter["post-steps"][1].run, command, "and it is the rendered post-step");
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    const home = tempDir("sdlc-s2-gh-home-");
    try {
      const env = runnerEnv(home, dataHome ? path.join(home, "orchestrator-data") : undefined);
      const orchestratorDir = await installOrchestratorExtension(gate, env);
      assert.deepEqual(gate.shims.extensions(), { [orchestratorDir]: { aw: { repository: "github/gh-aw", tag: "v1.0.1" } } }, "the runner starts with the orchestrator's gh-aw v1.0.1");
      const before = gate.shims.log().length;

      const outcome = await gate.runScript(afterwards(command), { env, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(outcome.code, 0, outcome.stderr);
      const calls = gate.shims.log().slice(before);
      assert.deepEqual(calls.map((call) => [call.tool, ...call.args]), [["gh", ...PIN], ["npm", "ci"], ["npm", "test"]], "in this order, and nothing else");
      for (const call of calls) assert.equal(call.cwd.replace(/\\/g, "/").endsWith("day-in-the-life-copilot-lab"), true, "inside the target checkout");

      // the effect: the install went to a directory that is not the runner's own, and npm ci and npm test ran with that directory
      const [install, ...npm] = calls;
      assert.notEqual(install.dataDir, orchestratorDir, "the pinned extension was not installed where the orchestrator's gh finds its own");
      assert.deepEqual(gate.shims.extensions(), { [orchestratorDir]: { aw: { repository: "github/gh-aw", tag: "v1.0.1" } }, [install.dataDir]: { aw: { repository: "github/gh-aw", tag: "v0.86.2" } } }, "one extension directory per gh-aw version");
      assert.deepEqual(npm.map((call) => call.dataDir), [install.dataDir, install.dataDir], "npm ci and npm test resolve the same directory");
      assert.deepEqual(npm.map((call) => call.ghAwVersion), ["v0.86.2", "v0.86.2"], "so the gh aw that the lab's tests call is the pinned one");
      const fresh = new Set(calls.map((call) => call.XDG_DATA_HOME));
      assert.equal(fresh.size, 1, "all three ran under the same XDG_DATA_HOME");
      assert.ok(calls.every((call) => call.GH_DATA_DIR === call.XDG_DATA_HOME), "which is the GH_DATA_DIR of the gate");
      assert.notEqual([...fresh][0], env.XDG_DATA_HOME ?? null, "and is not the one that the parent had");
      assert.equal(calls.every((call) => /sdlc-s2/.test(call.GH_DATA_DIR) === false && call.GH_DATA_DIR !== ""), true, "a fresh mktemp -d directory, not a name this suite chose");

      // the parent is untouched: its variables, and the gh-aw that its gh runs
      assert.equal(outcome.stdout.trim().split("\n").pop().replace(/\\/g, "/"), `PARENT_AFTER=unset ${dataHome ? forward(path.join(home, "orchestrator-data")) : "unset"}`, "the parent's environment is unchanged afterwards");
      assert.equal(await listedAs(gate, env), "gh aw\tgithub/gh-aw\tv1.0.1", "the orchestrator's gh-aw is not downgraded");
    } finally {
      gate.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`AC24: without the XDG_DATA_HOME export the same gate of ${key} reaches the orchestrator's extension directory: it fails on its gh-aw, or replaces it on a clean runner`, { skip: BASH_SKIP }, async () => {
    const command = isolatedCommand(key);
    const defect = command.replace(' XDG_DATA_HOME="$GH_DATA_DIR"; export XDG_DATA_HOME;', "");
    assert.notEqual(defect, command, "the command exports XDG_DATA_HOME");
    assert.equal(defect.includes("XDG_DATA_HOME"), false);
    const home = tempDir("sdlc-s2-gh-home-");
    const env = runnerEnv(home, dataHome ? path.join(home, "orchestrator-data") : undefined);
    const withOrchestrator = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    const clean = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    try {
      await installOrchestratorExtension(withOrchestrator, env);
      const refused = await withOrchestrator.runScript(defect, { env, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(refused.code, 1, "GH_DATA_DIR alone does not move gh's extension directory: the install meets the orchestrator's own gh-aw");
      assert.match(refused.stderr, /there is already an installed extension that provides the "aw" command/);
      const replaced = await clean.runScript(defect, { env, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(replaced.code, 0, replaced.stderr);
      assert.equal(await listedAs(clean, env), "gh aw\tgithub/gh-aw\tv0.86.2", "on a runner without gh-aw the gate puts the old version where the orchestrator's gh finds it");
    } finally {
      withOrchestrator.cleanup();
      clean.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("AC24: with no GH_DATA_DIR or XDG_DATA_HOME in the parent the subshell still gets both, and the parent has neither afterwards", { skip: BASH_SKIP }, async () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
    try {
      const outcome = await gate.runScript(afterwards(isolatedCommand(key)), { env: { GH_TOKEN: "ghs_fixturetoken" }, workingDirectory: "day-in-the-life-copilot-lab" });
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.stdout, /PARENT_AFTER=unset unset/);
      assert.ok(gate.shims.log().every((call) => typeof call.GH_DATA_DIR === "string" && call.GH_DATA_DIR !== "" && call.XDG_DATA_HOME === call.GH_DATA_DIR));
      assert.equal(process.env.GH_DATA_DIR, undefined, "and this process was not touched");
    } finally {
      gate.cleanup();
    }
  }
});

for (const key of ["copilot-lab", "self-improving-agents"]) {
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

test("AC24: the orchestrator's own gh-aw is not downgraded: the command points both GH_DATA_DIR and gh's own XDG_DATA_HOME at a fresh directory, in a subshell, before it installs", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    const command = isolatedCommand(key);
    const install = command.indexOf("gh extension install");
    const isolate = command.indexOf('GH_DATA_DIR="$(mktemp -d)"');
    const redirect = command.indexOf('XDG_DATA_HOME="$GH_DATA_DIR"');
    assert.ok(isolate > -1 && install > isolate, "GH_DATA_DIR is set before the extension is installed");
    assert.ok(redirect > isolate && install > redirect, "and so is XDG_DATA_HOME, the variable through which gh finds its extensions");
    assert.ok(command.indexOf("export XDG_DATA_HOME") > redirect && command.indexOf("export XDG_DATA_HOME") < install, "and exported, because gh is a child process");
    assert.ok(command.startsWith("(") && command.endsWith(")"), "inside a subshell, so that the export does not reach the parent");
    assert.ok(command.includes("set -euo pipefail"), "and with errors fatal");
    for (const file of REQUIRED_TESTS) assert.ok(command.includes(file), file);
    assert.ok(command.indexOf("npm ci") > install && command.indexOf("npm test") > command.indexOf("npm ci"), "npm ci, then npm test, after the install");
    assert.equal(/--upgrade|extension upgrade|extension remove/.test(command), false);
  }
  assert.ok(DRIFT_KEYS.includes("copilot-lab"));
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
