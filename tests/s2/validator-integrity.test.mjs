// AC22, the validator's own files: the post-step runs `node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"`, and $GITHUB_WORKSPACE is the
// working directory that the agent step can write (the compiled `awf` command has --container-workdir "${GITHUB_WORKSPACE}"), so an agent that
// rewrites that file, or a module that it imports, would be the code that judges it. prepare-run, which runs before the agent starts, therefore stages
// a copy of the validator and of src/drift/lib/ under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, read-only (the agent step mounts ${RUNNER_TEMP}/gh-aw
// read-only), and the first verifyCommands entry of each lab project compares the workspace files with that copy before it runs them: a difference
// or a missing copy is exit 1. The tests below run the rendered steps in the order of a job, with a copy of src/ of its own in the workspace that the
// "agent" rewrites, and show that the gate exits 1; with the comparison taken out the same rewrite passes, which is what makes the tests tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { VALIDATOR_STAGE_DIRECTORY } from "../../src/drift/lib/cli.mjs";
import { abs, driftPreset, driftWorkflow, forceRemove, listTree, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { invoke, isUnder, recordingFs } from "./helpers/run-script.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

const TARGET = "example-owner/example-target";
const LAB_KEYS = ["copilot-lab", "self-improving-agents"];
const CHECKOUT = "day-in-the-life-copilot-lab";
const posixOnly = process.platform === "win32" ? "directory modes are not enforced on Windows" : false;

/** The files that prepare-run is to stage: the validator and everything below drift/lib/, as paths relative to src/. */
const expectedStaged = () => ["validate-copilot-lab-audit.mjs", ...listTree(abs("src", "drift", "lib")).map((file) => `drift/lib/${file}`)].sort();

/** A job's workspace with a target checkout, a RUNNER_TEMP and the environment that the runner gives the first step. */
function job() {
  const root = tempDir("sdlc-s2-stage-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const checkout = createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") });
  const stage = path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY);
  const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: TARGET, RUNNER_TEMP: runnerTemp, ...extra });
  return { root, workspace, runnerTemp, stage, env, checkout, out: (name = "agent") => path.join(root, name), cleanup: () => forceRemove(root) };
}

test("AC22: prepare-run stages the validator and the modules that it imports under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, byte for byte, and says so", async () => {
  const run = job();
  try {
    const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET], { env: run.env(), cwd: run.root });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listTree(run.stage), expectedStaged());
    assert.ok(expectedStaged().length >= 4, "the validator and the modules of drift/lib/");
    for (const relative of expectedStaged()) {
      assert.ok(fs.readFileSync(path.join(run.stage, ...relative.split("/"))).equals(fs.readFileSync(abs("src", ...relative.split("/")))), `${relative} is a copy of src/${relative}`);
    }
    assert.match(result.stdout, new RegExp(`${expectedStaged().length} validator files staged read-only under `));
    assert.equal(listTree(run.stage).some((file) => /reconcile|prepare-run|dedupe|escalate|snapshot/.test(file)), false, "and nothing else of src/ is copied");
  } finally {
    run.cleanup();
  }
});

test("AC22: the staged files are read-only (0444) and so are the directories (0555), so that nothing that runs as the agent's user can rewrite the copy it is compared with", { skip: posixOnly }, async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET], { env: run.env(), cwd: run.root })).code, 0);
    for (const relative of expectedStaged()) assert.equal(fs.statSync(path.join(run.stage, ...relative.split("/"))).mode & 0o777, 0o444, relative);
    for (const directory of ["", "drift", "drift/lib"]) assert.equal(fs.statSync(path.join(run.stage, ...directory.split("/"))).mode & 0o777, 0o555, directory || "(the stage)");
    if (process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(path.join(run.stage, "validate-copilot-lab-audit.mjs"), "process.exit(0);\n"), /EACCES|EPERM/);
  } finally {
    run.cleanup();
  }
});

test("AC22: a read-only file is read-only on every platform: the copy cannot be opened for writing", async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET], { env: run.env(), cwd: run.root })).code, 0);
    if (process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(path.join(run.stage, "drift", "lib", "args.mjs"), "export {};\n"), /EACCES|EPERM/);
  } finally {
    run.cleanup();
  }
});

test("AC22: a second run in the same RUNNER_TEMP replaces the stage, although its files and directories are read-only, and leaves no stale file", async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, ["--out", run.out("one"), "--target-repo", TARGET], { env: run.env(), cwd: run.root })).code, 0);
    const stale = path.join(run.stage, "drift", "lib", "stale.mjs");
    fs.chmodSync(path.dirname(stale), 0o755);
    fs.writeFileSync(stale, "export {};\n");
    const again = await invoke(prepare, ["--out", run.out("two"), "--target-repo", TARGET], { env: run.env(), cwd: run.root });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(listTree(run.stage), expectedStaged(), "the stale file is gone");
  } finally {
    run.cleanup();
  }
});

test("AC22: outside Actions (no RUNNER_TEMP) nothing is staged, and a RUNNER_TEMP that cannot hold the stage stops the step before the agent starts, with nothing written under --out", async () => {
  const run = job();
  try {
    const outside = await invoke(prepare, ["--out", run.out("none"), "--target-repo", TARGET], { env: run.env({ RUNNER_TEMP: "" }), cwd: run.root });
    assert.equal(outside.code, 0, outside.stderr);
    assert.doesNotMatch(outside.stdout, /staged/);
    assert.equal(fs.existsSync(run.stage), false);
    fs.writeFileSync(path.join(run.runnerTemp, "gh-aw"), "a file where the directory has to be\n");
    const refused = await invoke(prepare, ["--out", run.out("refused"), "--target-repo", TARGET], { env: run.env(), cwd: run.root });
    assert.equal(refused.code, 1, "the validator that the gate would compare with cannot be staged");
    assert.match(refused.stderr, /prepare-run: the validator cannot be staged under /);
    assert.equal(fs.existsSync(run.out("refused")), false, "and nothing is left under --out");
  } finally {
    run.cleanup();
  }
});

test("AC5 and AC22: with RUNNER_TEMP set, prepare-run still writes under --out, the file that GITHUB_ENV names and the staged validator, and nowhere else", async () => {
  const run = job();
  const recorder = recordingFs();
  const envFile = path.join(run.root, "github-env");
  fs.writeFileSync(envFile, "");
  try {
    const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET], { env: run.env({ GITHUB_ENV: envFile }), cwd: run.root, fs: recorder.fs });
    assert.equal(result.code, 0, result.stderr);
    const elsewhere = recorder.writes.filter((written) => !isUnder(written, run.out()) && !isUnder(written, run.stage) && path.resolve(written) !== path.resolve(envFile) && !isUnder(written, abs("src")));
    assert.deepEqual(elsewhere, [], "no other path is written (the recorder lists the source of a copy beside its destination: those are the files below src/, which are read)");
    assert.ok(recorder.writes.some((written) => isUnder(written, run.stage)), "the stage is written");
    assert.equal(fs.readFileSync(envFile, "utf8"), `SDLC_BASE_SHA=${run.checkout.head()}\n`, "and GITHUB_ENV still gets its one line");
    assert.equal(run.checkout.status(), "", "the target checkout is as it was");
    assert.deepEqual(listTree(run.out()), ["run-context.json"], "the staged copy is not an artifact: --out holds the run context alone");
  } finally {
    run.cleanup();
  }
});

for (const key of LAB_KEYS) {
  test(`AC22: the validator entry of drift-${key} compares src/validate-copilot-lab-audit.mjs and src/drift/lib with the staged copy, fails closed, and then runs the validator`, () => {
    const command = driftPreset(key).driftAudit.verifyCommands[0];
    assert.equal(driftWorkflow(key).frontmatter["post-steps"][0].run, command, "the rendered step is the manifest entry, verbatim");
    const pieces = [
      'copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"',
      'cmp -s "$copy/validate-copilot-lab-audit.mjs" "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"',
      'diff -rq "$copy/drift/lib" "$GITHUB_WORKSPACE/src/drift/lib"',
    ];
    let from = -1;
    for (const piece of pieces) {
      const at = command.indexOf(piece, from + 1);
      assert.ok(at > from, `${piece} comes in this order`);
      from = at;
    }
    assert.ok(command.indexOf('node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"') > from, "and the validator runs after the comparisons");
    assert.equal(command.match(/\|\| \{ echo "[^"]+" >&2; exit 1; \}/g).length, 2, "each comparison that fails ends the command with exit 1");
    assert.match(command, /^\( set -euo pipefail; /);
    assert.equal(/staged/.test(command), false, "SPEC-01's staging-key scans read the whole rendered file for the word, so the command does not use it");
    assert.equal(/\|\|\s*(?:true|:)\b|;\s*exit\s+0\b|--retry/.test(command), false, "nothing turns a failure into a pass");
    assert.equal(driftPreset(key).driftAudit.verifyCommands.filter((candidate) => candidate.includes("validate-copilot-lab-audit.mjs")).length, 1, "one entry runs the validator");
  });
}

/** The agent's way of rewriting a file of the orchestrator checkout, which is the working directory of its step. */
const agentWrites = (gate, relative, text) => fs.writeFileSync(path.join(gate.workspace, "src", ...relative.split("/")), text);
/** The agent also changes the pinned version and commits it, which is what it would want to get past the rule. */
function bumpAndCommit(gate) {
  gate.write("docs/_meta/registry.yaml", labFiles()["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"'));
  gate.git("add", "-A");
  gate.git("commit", "-q", "-m", "bump the pinned version");
}
const ALWAYS_PASSES = "process.exit(0);\n";

for (const key of LAB_KEYS) {
  const { frontmatter } = driftWorkflow(key);
  const [prepareStep] = frontmatter["pre-agent-steps"];
  const [validator] = frontmatter["post-steps"];
  const labGate = () => createGateWorkspace({ checkoutName: CHECKOUT, files: labFiles(), ownSource: true });
  const FAILURE = /src\/validate-copilot-lab-audit\.mjs is not the copy that prepare-run made before the agent started|src\/drift\/lib is not the copy that prepare-run made before the agent started/;

  test(`AC22: drift-${key}: with the steps of a job in order and an agent that changes nothing of the validator, the gate runs it and passes`, { skip: BASH_SKIP }, async () => {
    const gate = labGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 0, finished.log);
      assert.match(finished.output, /validate-copilot-lab-audit: ok \(11 registry keys/, "the validator ran, after a comparison that said nothing");
      assert.equal(FAILURE_TEXT.test(finished.output), false);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC22: drift-${key}: an agent that rewrites $GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs so that it always passes, and bumps the pinned version, fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const gate = labGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      // the agent step
      agentWrites(gate, "validate-copilot-lab-audit.mjs", ALWAYS_PASSES);
      bumpAndCommit(gate);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, finished.log);
      assert.ok(finished.output.includes("src/validate-copilot-lab-audit.mjs is not the copy that prepare-run made before the agent started"), finished.log);
      assert.equal(finished.output.includes("gh_aw_schema_version"), false, "the rewritten validator did not run: the bump is not what stopped the gate");
      // the control: the command as it was before the comparison, `node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"` alone, lets the same rewrite through
      const bare = { name: "the validator alone", run: key === "copilot-lab" ? 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"' : 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve', "working-directory": CHECKOUT };
      const passes = await gate.runSteps([bare]);
      assert.equal(passes.code, 0, `without the comparison the rewritten validator passes a bumped version: ${passes.log}`);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC22: drift-${key}: an agent that changes, adds or deletes a module of src/drift/lib/ that the validator imports fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const tampers = {
      "changes cli.mjs": (gate) => agentWrites(gate, "drift/lib/cli.mjs", `${fs.readFileSync(path.join(gate.workspace, "src", "drift", "lib", "cli.mjs"), "utf8")}\n// changed by the agent\n`),
      "replaces args.mjs": (gate) => agentWrites(gate, "drift/lib/args.mjs", "export class UsageError extends Error {}\nexport const parseFlags = () => ({ 'base-sha': 'none' });\n"),
      "deletes args.mjs": (gate) => fs.rmSync(path.join(gate.workspace, "src", "drift", "lib", "args.mjs")),
      "adds a module": (gate) => agentWrites(gate, "drift/lib/added-by-the-agent.mjs", "export {};\n"),
    };
    for (const [name, tamper] of Object.entries(tampers)) {
      const gate = labGate();
      try {
        gate.exported = {};
        assert.equal((await gate.runSteps([prepareStep])).code, 0);
        tamper(gate);
        const finished = await gate.runSteps([validator]);
        assert.equal(finished.code, 1, `${name}\n${finished.log}`);
        assert.ok(finished.output.includes("src/drift/lib is not the copy that prepare-run made before the agent started"), `${name}\n${finished.log}`);
      } finally {
        gate.cleanup();
      }
    }
  });

  test(`AC22: drift-${key}: a missing staged copy, or no RUNNER_TEMP, is a failed gate and not a skipped one`, { skip: BASH_SKIP }, async () => {
    const gate = labGate();
    try {
      forceRemove(path.join(gate.runnerTemp, "gh-aw"));
      const missing = await gate.runSteps([validator]);
      assert.equal(missing.code, 1, missing.log);
      assert.match(missing.output, FAILURE);
      const unset = await gate.runSteps([validator], { env: { RUNNER_TEMP: "" } });
      assert.equal(unset.code, 1, unset.log);
      assert.match(unset.output, /RUNNER_TEMP is not set/);
    } finally {
      gate.cleanup();
    }
  });
}

test("AC22: the validator still reports what it finds once the comparison has passed: a bumped version fails the lab gate with the validator's own message", { skip: BASH_SKIP }, async () => {
  const { frontmatter } = driftWorkflow("copilot-lab");
  const gate = createGateWorkspace({ checkoutName: CHECKOUT, files: labFiles(), ownSource: true });
  try {
    gate.exported = {};
    assert.equal((await gate.runSteps([frontmatter["pre-agent-steps"][0]])).code, 0);
    bumpAndCommit(gate);
    const finished = await gate.runSteps([frontmatter["post-steps"][0]]);
    assert.equal(finished.code, 1, finished.log);
    assert.ok(finished.output.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), finished.log);
    assert.equal(FAILURE_TEXT.test(finished.output), false, "the comparison passed: the validator it ran is the staged one");
  } finally {
    gate.cleanup();
  }
});

const FAILURE_TEXT = /is not the copy that prepare-run made/;
