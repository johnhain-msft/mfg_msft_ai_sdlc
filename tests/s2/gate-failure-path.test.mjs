// AC29: contract C5 error handoff, single-path gate failure. If any post-steps verification command exits non-zero, post-steps exit 1,
// failing the agent job, so that safe_outputs does not execute and no unverified pull request is opened: this is the only path by which a
// gate failure is handled. The test runs the extracted post-steps of the preset workflows, once with every command passing and then with a
// failing stub for each of the named commands in turn, and parses the compiled lock files for the job graph.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { abs, DRIFT_KEYS, driftLock, driftPreset, driftWorkflow, listTree } from "./helpers/fixtures.mjs";
import { adminFiles, BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { labFiles, withoutTopLevelKey } from "./helpers/lab-fixture.mjs";

/** How to make exactly the command at an index fail, per project; the checkout and the shims make the other commands pass. */
const PLANS = {
  "gh-admin-msft": {
    files: adminFiles,
    failures: [
      { command: "npm ci", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["ci"]) } },
      { command: "node presentation/build.mjs", env: { SDLC_S2_BUILD_EXIT: "1" } },
      { command: 'test -z "$(git status --porcelain)"', prepare: (gate) => gate.write("rebuilt-output.html", "an output the agent did not commit\n") },
      { command: "npm run test:unit", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["run test:unit"]) } },
      { command: "npm run test:freshness", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["run test:freshness"]) } },
      { command: "npm run test:deck", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["run test:deck"]) } },
      { command: "npm test -- --skip-links", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["test"]) } },
    ],
  },
  "copilot-lab": {
    files: labFiles,
    failures: [
      { command: 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"', prepare: (gate) => gate.write("docs/_meta/registry.yaml", withoutTopLevelKey(labFiles()["docs/_meta/registry.yaml"], "audit")) },
      { command: "the isolated GH_DATA_DIR gate", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["test"]) } },
    ],
  },
  "self-improving-agents": {
    files: labFiles,
    failures: [
      { command: 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve', prepare: (gate) => gate.remove("docs/_meta/self-improvement-report.md") },
      { command: "the isolated GH_DATA_DIR gate", env: { SDLC_S2_NPM_FAIL: JSON.stringify(["test"]) } },
    ],
  },
};

const artifactsOf = (gate) => listTree(gate.artifacts).filter((file) => !["agent/run-context.json"].includes(file));

for (const key of DRIFT_KEYS) {
  const steps = driftWorkflow(key).frontmatter["post-steps"];
  const plan = PLANS[key];

  test(`AC29: with every command passing, the post-steps of drift-${key} exit 0 (so that a failure below is the injected one)`, { skip: BASH_SKIP }, async () => {
    const gate = createGateWorkspace({ checkoutName: driftWorkflow(key).frontmatter.checkout[0].path, files: plan.files() });
    try {
      const outcome = await gate.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken" } });
      assert.equal(outcome.code, 0, outcome.log);
      assert.equal(outcome.ran.length, steps.length);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC29: a failing stub for each gate command of drift-${key} fails that step with exit 1, no later step runs and no pull request artifact is written`, { skip: BASH_SKIP }, async () => {
    assert.equal(steps.length, driftPreset(key).driftAudit.verifyCommands.length);
    await Promise.all(
      plan.failures.map(async (failure, index) => {
        const gate = createGateWorkspace({ checkoutName: driftWorkflow(key).frontmatter.checkout[0].path, files: plan.files() });
        try {
          failure.prepare?.(gate);
          const outcome = await gate.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken", ...failure.env } });
          assert.equal(outcome.code, 1, `${failure.command}: ${outcome.log}`);
          assert.equal(outcome.failed, steps[index].name, `${failure.command}: the failing step is the one that was made to fail`);
          assert.deepEqual(outcome.ran, steps.slice(0, index + 1).map((step) => step.name), `${failure.command}: no step after the failing one ran`);
          assert.deepEqual(artifactsOf(gate), [], `${failure.command}: no pull request artifact (or any other artifact) was written`);
          const tools = gate.shims.log().map((call) => call.tool);
          assert.equal(tools.includes("git") && gate.shims.writes().length > 0, false, "and no write call was made");
        } finally {
          gate.cleanup();
        }
      }),
    );
  });
}

test("AC29: the post-steps of the three workflows carry nothing that could turn a failure into a warning, a retry or a pull request", () => {
  for (const key of DRIFT_KEYS) {
    for (const step of driftWorkflow(key).frontmatter["post-steps"]) {
      assert.equal(/\|\|\s*(?:true|:)\b|;\s*exit\s+0\b|--retry|create_pull_request|gh pr /.test(step.run.replace(/\{ echo "missing required test file \$f" >&2; exit 1; \}/, "")), false, step.name);
      assert.equal("continue-on-error" in step, false);
    }
  }
});

for (const key of DRIFT_KEYS) {
  test(`AC29: in the compiled drift-${key}.lock.yml safe_outputs depends, directly or through detection, on the agent job, and detection on agent`, () => {
    const { jobs } = driftLock(key).workflow;
    assert.ok(jobs.agent, "an agent job exists");
    const needs = (name) => [].concat(jobs[name].needs ?? []);
    assert.ok(needs("detection").includes("agent"), "detection needs agent");
    assert.ok(needs("safe_outputs").includes("agent"), "safe_outputs needs agent");
    assert.ok(needs("safe_outputs").includes("detection"), "and detection");
    assert.match(String(jobs.safe_outputs.if), /needs\.agent\.result == 'success'/, "and runs only when the agent job succeeded");
    assert.match(String(jobs.detection.if), /needs\.agent\.result == 'success'/);
    assert.equal(fs.existsSync(abs(".github", "workflows", `drift-${key}.lock.yml`)), true);
  });
}
