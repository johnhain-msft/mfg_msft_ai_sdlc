// AC19: contract C5 request, gate steps. post-steps are the project's verifyCommands, rendered in declared order as separate run steps, each
// named by its command and run as a shell command inside the target checkout, with no wrapper script and with no continue-on-error: true
// and no if: on any step, so that every command is named in the log, the first non-zero exit fails that step and the agent job, no
// later command runs, and the job passes only when every command exited 0. For the lab project these steps include the validator and the
// isolated-GH_DATA_DIR test command, both entries of that project's verifyCommands in sdlc.yaml.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { DRIFT_KEYS, driftPreset, driftWorkflow, minimalManifest, mutate, parseWorkflow, projectOf, renderIn, tempDir, toYaml } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";

for (const key of DRIFT_KEYS) {
  test(`AC19: post-steps of drift-${key}.md equal the project's verifyCommands in order, each named by its command, with no wrapper, continue-on-error or if`, () => {
    const { frontmatter } = driftWorkflow(key);
    const commands = driftPreset(key).driftAudit.verifyCommands;
    const steps = frontmatter["post-steps"];
    assert.deepEqual(steps.map((step) => step.run), commands, "the run bodies are the commands, in order");
    assert.deepEqual(steps.map((step) => step.name), commands, "each step is named by its command");
    const checkout = frontmatter.checkout[0].path;
    for (const step of steps) {
      assert.equal("continue-on-error" in step, false, step.name);
      assert.equal("if" in step, false, step.name);
      assert.equal(step["working-directory"], checkout, `${step.name} runs inside the target checkout`);
      assert.equal("shell" in step, false, "the default bash -e shell: no wrapper that could swallow a failing exit");
    }
    assert.deepEqual(Object.keys(frontmatter).filter((name) => name.includes("steps")).sort(), ["post-steps", "pre-agent-steps"], "no other step hook that could run the gate differently");
  });
}

test("AC19: the lab's post-steps include the validator and the isolated-GH_DATA_DIR test command, both entries of its verifyCommands", () => {
  const lab = driftWorkflow("copilot-lab").frontmatter["post-steps"].map((step) => step.run);
  const commands = driftPreset("copilot-lab").driftAudit.verifyCommands;
  assert.ok(lab.includes('node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"'));
  assert.ok(lab.some((command) => command.includes("GH_DATA_DIR") && command.includes("gh extension install github/gh-aw --pin v0.86.2") && command.includes("npm ci") && command.includes("npm test")));
  for (const command of lab) assert.ok(commands.includes(command));
  assert.ok(fs.readFileSync(path.resolve("sdlc.yaml"), "utf8").includes('node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"'), "and sdlc.yaml has them");
});

/** The post-steps that the reconciler renders for a project that runs these commands. */
async function stepsFor(commands) {
  const directory = tempDir("sdlc-s2-poststeps-");
  try {
    const manifest = mutate(minimalManifest(), (copy) => {
      projectOf(copy, "alpha-service").driftAudit.verifyCommands = commands;
    });
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), toYaml(manifest));
    const rendered = await renderIn(directory);
    return parseWorkflow(rendered.files.get(".github/workflows/drift-alpha-service.md")).frontmatter["post-steps"];
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const marked = (name) => `echo "${name}" >> "$MARKERS"`;
const MARKERS = (gate) => path.join(gate.root, "markers.txt");
const markersOf = (gate) => (fs.existsSync(MARKERS(gate)) ? fs.readFileSync(MARKERS(gate), "utf8").trim().split("\n").filter(Boolean) : []);

const SCENARIOS = [
  { name: "all passing", commands: [marked("one"), marked("two"), marked("three")], code: 0, ran: 3, markers: ["one", "two", "three"] },
  { name: "first failing", commands: ["false", marked("two"), marked("three")], code: 1, ran: 1, markers: [] },
  { name: "last failing", commands: [marked("one"), marked("two"), `${marked("three")} && false`], code: 1, ran: 3, markers: ["one", "two", "three"] },
  { name: "a middle command failing", commands: [marked("one"), "exit 7", marked("three")], code: 1, ran: 2, markers: ["one"] },
  { name: "a failure inside a pipeline", commands: [marked("one"), "false | cat", marked("three")], code: 1, ran: 2, markers: ["one"] },
];

for (const scenario of SCENARIOS) {
  test(`AC19: the extracted run bodies, one by one under bash -e, with the fixture commands '${scenario.name}', exit ${scenario.code}`, { skip: BASH_SKIP }, async () => {
    const steps = await stepsFor(scenario.commands);
    assert.deepEqual(steps.map((step) => step.run), scenario.commands);
    const gate = createGateWorkspace({ checkoutName: "alpha-service", files: { "README.md": "x\n" } });
    try {
      const outcome = await gate.runSteps(steps, { env: { MARKERS: MARKERS(gate).replace(/\\/g, "/") } });
      assert.equal(outcome.code, scenario.code, outcome.log);
      assert.deepEqual(outcome.ran, scenario.commands.slice(0, scenario.ran), "no command runs after a failing one");
      assert.deepEqual(markersOf(gate), scenario.markers, "and the commands that did not run left no trace");
      for (const command of scenario.commands.slice(0, scenario.ran)) assert.ok(outcome.log.includes(`Run ${command}`), `the log names ${command}`);
      for (const command of scenario.commands.slice(scenario.ran)) assert.equal(outcome.log.includes(`Run ${command}`), false, `the log does not name ${command}, which never ran`);
      assert.equal(outcome.failed, scenario.code === 0 ? null : scenario.commands[scenario.ran - 1], "the failing step is the one that fails the job");
    } finally {
      gate.cleanup();
    }
  });
}

test("AC19: every command is named by itself in the rendered step, so the log of the runner names it", async () => {
  const commands = ["npm ci", 'test -z "$(git status --porcelain)"', "node scripts/check.mjs --strict"];
  const steps = await stepsFor(commands);
  assert.deepEqual(steps.map((step) => step.name), commands);
  const text = YAML.stringify(steps);
  for (const command of commands) assert.ok(text.includes(command));
});
