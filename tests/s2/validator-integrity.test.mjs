// AC22, the validator's own files (the instance half): the post-step of drift-copilot-lab and drift-self-improving-agents runs
// `node "$GITHUB_WORKSPACE/scripts/validate-copilot-lab-audit.mjs"`, and $GITHUB_WORKSPACE is the working directory that the agent step can write (the compiled
// `awf` command has --container-workdir "${GITHUB_WORKSPACE}"), so an agent that rewrites that file, or a module of the engine that it imports, would be the code
// that judges it. prepare-run, which runs before the agent starts, therefore stages a copy of the declared script (`driftAudit.stagedScripts`) and of the engine's
// src/drift/lib/ under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, read-only (the agent step mounts ${RUNNER_TEMP}/gh-aw read-only), and the first verifyCommands entry of each
// lab project compares the workspace files with that copy before it runs them: a difference or a missing copy is exit 1.
//
// The engine's own tests (the package's tests/s2/validator-integrity) prove the staging and the comparison with a neutral validator. What only this repository can say is
// here: that the manifest declares the real validator as staged, that the committed steps pass the arguments that stage it, that the committed command compares the right
// files, and that the real validator, in a workspace laid out as a job lays it out (scripts/ and node_modules/ai-sdlc-factory), cannot be replaced by the agent. The tests
// below run the committed steps in the order of a job, with copies of their own in the workspace that the "agent" rewrites, and show that the gate exits 1; with the
// comparison taken out the same rewrite passes, which is what makes the tests tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { VALIDATOR_STAGE_DIRECTORY } from "ai-sdlc-factory/drift-lib";
import { engineFile, importEngine, installFactory } from "../helpers/instance.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, FACTORY_DIR, forceRemove, listTree, renderedVerifyCommands, stepWith, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

const { run: prepare } = await importEngine("src/drift/prepare-run.mjs");

const TARGET = "example-owner/example-target";
const LAB_KEYS = ["copilot-lab", "self-improving-agents"];
const CHECKOUT = "day-in-the-life-copilot-lab";
const VALIDATOR = "scripts/validate-copilot-lab-audit.mjs";
const posixOnly = process.platform === "win32" ? "directory modes are not enforced on Windows" : false;

/** The stage mirrors the workspace: the declared script at its path, and the engine's support files under the factory directory. */
const expectedStaged = () => [VALIDATOR, `${FACTORY_DIR}/package.json`, ...listTree(engineFile("src", "drift", "lib")).map((file) => `${FACTORY_DIR}/src/drift/lib/${file}`)].sort();
/** The file that a staged path is a copy of: the script of this repository, or a file of the installed engine package. */
const stageSource = (relative) => (relative.startsWith(`${FACTORY_DIR}/`) ? engineFile(...relative.slice(FACTORY_DIR.length + 1).split("/")) : abs(...relative.split("/")));

/** The arguments that the committed prepare-run step of a project passes, as they are written in the workflow. */
function stagingArguments(key) {
  const step = stepWith(driftWorkflow(key).frontmatter["pre-agent-steps"], "drift/prepare-run.mjs");
  const [, factoryDir, scripts] = / --factory-dir (\S+) --stage-scripts (\S+)$/.exec(step.run) ?? [];
  return { step, factoryDir, scripts };
}

/** A job's workspace with a target checkout, a RUNNER_TEMP and the environment that the runner gives the first step. */
function job() {
  const root = tempDir("sdlc-s2-stage-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const checkout = createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") });
  installFactory(workspace);
  fs.mkdirSync(path.join(workspace, "scripts"));
  fs.copyFileSync(abs(...VALIDATOR.split("/")), path.join(workspace, ...VALIDATOR.split("/")));
  const stage = path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY);
  const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: TARGET, RUNNER_TEMP: runnerTemp, ...extra });
  return { root, workspace, runnerTemp, stage, env, checkout, out: (name = "agent") => path.join(root, name), cleanup: () => forceRemove(root) };
}

test("the manifest declares the lab validator as the one staged script of the two projects that run it, and of no other project", () => {
  const staged = Object.fromEntries(DRIFT_KEYS.map((key) => [key, driftPreset(key).driftAudit.stagedScripts ?? []]));
  assert.deepEqual(staged, { "gh-admin-msft": [], "copilot-lab": [VALIDATOR], "self-improving-agents": [VALIDATOR] });
  assert.ok(fs.statSync(abs(...VALIDATOR.split("/"))).isFile(), `${VALIDATOR} is a file of this repository`);
});

test("AC22: the committed prepare-run step of each lab project passes the arguments that stage the declared validator, and the one of gh-admin-msft stages nothing", () => {
  for (const key of LAB_KEYS) {
    const { factoryDir, scripts } = stagingArguments(key);
    assert.equal(factoryDir, FACTORY_DIR, `${key}: the directory of the engine in the workspace`);
    assert.equal(scripts, driftPreset(key).driftAudit.stagedScripts.join(","), `${key}: the scripts of the manifest`);
  }
  const admin = stepWith(driftWorkflow("gh-admin-msft").frontmatter["pre-agent-steps"], "drift/prepare-run.mjs");
  assert.doesNotMatch(admin.run, /--factory-dir|--stage-scripts/, "gh-admin-msft runs no validator that is compared, so its prepare-run stages none");
});

test("AC22: prepare-run, given the arguments of the committed step, stages the declared validator and the modules of the engine that it imports under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, byte for byte", async () => {
  const run = job();
  try {
    const { factoryDir, scripts } = stagingArguments("copilot-lab");
    const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET, "--factory-dir", factoryDir, "--stage-scripts", scripts], { env: run.env(), cwd: run.root });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listTree(run.stage), expectedStaged());
    assert.ok(expectedStaged().length >= 4, "the validator and the modules of drift/lib/");
    for (const relative of expectedStaged()) {
      assert.ok(fs.readFileSync(path.join(run.stage, ...relative.split("/"))).equals(fs.readFileSync(stageSource(relative))), `${relative} is a copy of its source`);
    }
    assert.match(result.stdout, new RegExp(`${expectedStaged().length} validator files staged read-only under `));
    assert.equal(listTree(run.stage).some((file) => /reconcile|prepare-run|dedupe|escalate|snapshot/.test(file)), false, "and nothing else of the engine is copied");
  } finally {
    run.cleanup();
  }
});

test("AC22: the staged files are read-only (0444) and so are the directories (0555), so that nothing that runs as the agent's user can rewrite the copy it is compared with", { skip: posixOnly }, async () => {
  const run = job();
  try {
    const { factoryDir, scripts } = stagingArguments("copilot-lab");
    assert.equal((await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET, "--factory-dir", factoryDir, "--stage-scripts", scripts], { env: run.env(), cwd: run.root })).code, 0);
    for (const relative of expectedStaged()) assert.equal(fs.statSync(path.join(run.stage, ...relative.split("/"))).mode & 0o777, 0o444, relative);
    if (process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(path.join(run.stage, ...VALIDATOR.split("/")), "process.exit(0);\n"), /EACCES|EPERM/);
  } finally {
    run.cleanup();
  }
});

for (const key of LAB_KEYS) {
  test(`AC22: the validator entry of drift-${key} compares the declared script, the factory's package.json and drift/lib with the staged copy, refuses scripts/node_modules, fails closed, and then runs the staged validator`, () => {
    const command = renderedVerifyCommands(key)[0];
    assert.equal(driftWorkflow(key).frontmatter["post-steps"][0].run, command, "the rendered step is the manifest entry, with the engine placeholders expanded and nothing else");
    const pieces = [
      'copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"',
      `cmp -s "$copy/${VALIDATOR}" "$GITHUB_WORKSPACE/${VALIDATOR}"`,
      `cmp -s "$copy/${FACTORY_DIR}/package.json" "$GITHUB_WORKSPACE/${FACTORY_DIR}"/package.json`,
      `diff -rq "$copy/${FACTORY_DIR}/src/drift/lib" "$GITHUB_WORKSPACE/${FACTORY_DIR}"/src/drift/lib`,
      '! test -e "$GITHUB_WORKSPACE/scripts/node_modules"',
    ];
    let from = -1;
    for (const piece of pieces) {
      const at = command.indexOf(piece, from + 1);
      assert.ok(at > from, `${piece} comes in this order`);
      from = at;
    }
    assert.ok(command.indexOf(`node "$copy/${VALIDATOR}"`) > from, "and the staged validator runs after the comparisons");
    assert.equal(command.includes('node "$GITHUB_WORKSPACE/'), false, "the workspace copy is compared, never run: what the agent can write does not decide what imports resolve to");
    assert.equal(command.match(/\|\| \{ echo "[^"]+" >&2; exit 1; \}/g).length, 4, "each comparison that fails, and the refusal, ends the command with exit 1");
    assert.match(command, /^\( set -euo pipefail; /);
    assert.equal(/staged/.test(command), false, "SPEC-01's staging-key scans read the whole rendered file for the word, so the command does not use it");
    assert.equal(/\|\|\s*(?:true|:)\b|;\s*exit\s+0\b|--retry/.test(command), false, "nothing turns a failure into a pass");
    assert.equal(driftPreset(key).driftAudit.verifyCommands.filter((candidate) => candidate.includes("validate-copilot-lab-audit.mjs")).length, 1, "one entry runs the validator");
  });
}

/** The agent's way of rewriting a file of the orchestrator checkout, which is the working directory of its step. */
const agentWrites = (gate, relative, text) => fs.writeFileSync(path.join(gate.workspace, ...relative.split("/")), text);
/** The agent also changes the pinned version and commits it, which is what it would want to get past the rule. */
function bumpAndCommit(gate) {
  gate.write("docs/_meta/registry.yaml", labFiles()["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"'));
  gate.git("add", "-A");
  gate.git("commit", "-q", "-m", "bump the pinned version");
}
const ALWAYS_PASSES = "process.exit(0);\n";
const NEUTRALISED = "validator neutralised by the agent";
const neutralisedModule = (realIndex) => `export * from ${JSON.stringify(pathToFileURL(realIndex).href)};\nexport async function runAsMain() { await new Promise((resolve) => process.stdout.write(${JSON.stringify(`${NEUTRALISED}\n`)}, resolve)); process.exit(0); }\n`;
const installedFactory = (gate) => path.join(gate.workspace, ...FACTORY_DIR.split("/"));
const installedIndex = (gate) => path.join(installedFactory(gate), "src", "drift", "lib", "index.mjs");
const selfReferencing = () => `${JSON.stringify({ name: "ai-sdlc-factory", type: "module", exports: { "./drift-lib": "./neutralised.mjs" } })}\n`;
const RESOLUTION_TAMPERS = {
  "rewrites exports['./drift-lib'] of the installed factory's package.json to a module of its own": {
    refused: `${FACTORY_DIR}/package.json`,
    tamper(gate) {
      const factory = installedFactory(gate);
      const manifest = JSON.parse(fs.readFileSync(path.join(factory, "package.json"), "utf8"));
      fs.writeFileSync(path.join(factory, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
      manifest.exports["./drift-lib"] = "./neutralised.mjs";
      fs.writeFileSync(path.join(factory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  },
  "adds scripts/node_modules/ai-sdlc-factory, which Node finds before the installed factory": {
    refused: "scripts/node_modules",
    tamper(gate) {
      const shadow = path.join(gate.workspace, "scripts", "node_modules", "ai-sdlc-factory");
      fs.mkdirSync(shadow, { recursive: true });
      fs.writeFileSync(path.join(shadow, "package.json"), selfReferencing());
      fs.writeFileSync(path.join(shadow, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
  "adds scripts/package.json that names itself ai-sdlc-factory, so that the package finds itself before any node_modules": {
    refused: null,
    tamper(gate) {
      fs.writeFileSync(path.join(gate.workspace, "scripts", "package.json"), selfReferencing());
      fs.writeFileSync(path.join(gate.workspace, "scripts", "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
  "renames the package.json of the workspace to ai-sdlc-factory, so that the package finds itself before any node_modules": {
    refused: null,
    tamper(gate) {
      const file = path.join(gate.workspace, "package.json");
      const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { name: "mfg_msft_ai_sdlc", private: true };
      fs.writeFileSync(file, `${JSON.stringify({ ...own, ...JSON.parse(selfReferencing()) }, null, 2)}\n`);
      fs.writeFileSync(path.join(gate.workspace, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
};

for (const key of LAB_KEYS) {
  const { frontmatter } = driftWorkflow(key);
  const prepareStep = stepWith(frontmatter["pre-agent-steps"], "drift/prepare-run.mjs");
  const [validator] = frontmatter["post-steps"];
  const labGate = () => createGateWorkspace({ checkoutName: CHECKOUT, files: labFiles() });
  const FAILURE = /scripts\/validate-copilot-lab-audit\.mjs is not the copy that prepare-run made before the agent started|src\/drift\/lib is not the copy that prepare-run made before the agent started/;

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

  test(`AC22: drift-${key}: an agent that rewrites $GITHUB_WORKSPACE/${VALIDATOR} so that it always passes, and bumps the pinned version, fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const gate = labGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      // the agent step
      agentWrites(gate, VALIDATOR, ALWAYS_PASSES);
      bumpAndCommit(gate);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, finished.log);
      assert.ok(finished.output.includes(`${VALIDATOR} is not the copy that prepare-run made before the agent started`), finished.log);
      assert.equal(finished.output.includes("gh_aw_schema_version"), false, "the rewritten validator did not run: the bump is not what stopped the gate");
      // the control: the command as it was before the comparison, `node "$GITHUB_WORKSPACE/scripts/validate-copilot-lab-audit.mjs"` alone, lets the same rewrite through
      const bare = { name: "the validator alone", run: key === "copilot-lab" ? `node "$GITHUB_WORKSPACE/${VALIDATOR}"` : `node "$GITHUB_WORKSPACE/${VALIDATOR}" --self-improve`, "working-directory": CHECKOUT };
      const passes = await gate.runSteps([bare]);
      assert.equal(passes.code, 0, `without the comparison the rewritten validator passes a bumped version: ${passes.log}`);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC22: drift-${key}: an agent that changes, adds or deletes a module of the engine's src/drift/lib/ that the validator imports fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const lib = (name) => `${FACTORY_DIR}/src/drift/lib/${name}`;
    const tampers = {
      "changes cli.mjs": (gate) => agentWrites(gate, lib("cli.mjs"), `${fs.readFileSync(path.join(gate.workspace, ...lib("cli.mjs").split("/")), "utf8")}\n// changed by the agent\n`),
      "replaces args.mjs": (gate) => agentWrites(gate, lib("args.mjs"), "export class UsageError extends Error {}\nexport const parseFlags = () => ({ 'base-sha': 'none' });\n"),
      "deletes args.mjs": (gate) => fs.rmSync(path.join(gate.workspace, ...lib("args.mjs").split("/"))),
      "adds a module": (gate) => agentWrites(gate, lib("added-by-the-agent.mjs"), "export {};\n"),
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

  for (const [name, { refused, tamper }] of Object.entries(RESOLUTION_TAMPERS)) {
    test(`AC22: drift-${key}: an agent that ${name} fails the gate with exit 1, and the validator of the workspace alone would have let a bumped version pass`, { skip: BASH_SKIP }, async () => {
    const gate = labGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      tamper(gate);
      if (refused === null) {
        const valid = await gate.runSteps([validator]);
        assert.equal(valid.code, 0, valid.log);
        assert.match(valid.output, /validate-copilot-lab-audit: ok \(11 registry keys/, "the validator that ran is the real staged one");
        assert.equal(valid.output.includes(NEUTRALISED), false, "the agent's module did not run");
      }
      bumpAndCommit(gate);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, finished.log);
      if (refused === null) assert.ok(finished.output.includes("gh_aw_schema_version"), `the staged validator ran, and its own verdict stopped the gate: ${finished.log}`);
      else assert.ok(finished.output.includes(`${refused} is not the copy that prepare-run made before the agent started`), finished.log);
      assert.equal(finished.output.includes(NEUTRALISED), false, "the agent's module did not run");
      const bare = { name: "the validator alone", run: key === "copilot-lab" ? `node "$GITHUB_WORKSPACE/${VALIDATOR}"` : `node "$GITHUB_WORKSPACE/${VALIDATOR}" --self-improve`, "working-directory": CHECKOUT };
      const passes = await gate.runSteps([bare]);
      assert.equal(passes.code, 0, `without the gate the agent's module judges the checkout: ${passes.log}`);
      assert.ok(passes.output.includes(NEUTRALISED), passes.log);
    } finally {
      gate.cleanup();
    }
    });
  }

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
  const gate = createGateWorkspace({ checkoutName: CHECKOUT, files: labFiles() });
  try {
    gate.exported = {};
    assert.equal((await gate.runSteps([stepWith(frontmatter["pre-agent-steps"], "drift/prepare-run.mjs")])).code, 0);
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
