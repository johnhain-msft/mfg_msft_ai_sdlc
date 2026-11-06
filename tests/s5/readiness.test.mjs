// AC42: after a successful ReconcileResult S5 runs `gh aw validate` and `gh aw doctor`; doctorStatus is "pass" only when both exit
// with status 0, the report is printed either way and a failing check makes the exit code non-zero; neither command runs after
// a failed ReconcileResult.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { READINESS_COMMANDS, runReadinessChecks } from "../../bin/lib/readiness.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { Capture, createScenario, errorResult, fixtureRepos } from "./helpers/harness.mjs";

const REPOS = fixtureRepos({ "example-owner/node-app": "node-app" });
const real = (file) => fs.realpathSync.native(file);
const aw = (scenario) => scenario.gh.log().map((entry) => entry.args.join(" ")).filter((line) => line.startsWith("aw "));

const ENTRY_POINTS = [
  ["bootstrap", (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) })],
  ["onboard", (scenario) => scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) })],
];

const CASES = [
  { label: "both succeed", gh: { validateExit: 0, doctorExit: 0 }, status: "pass", code: 0 },
  { label: "gh aw validate exits 1", gh: { validateExit: 1, doctorExit: 0 }, status: "fail", code: 1 },
  { label: "gh aw doctor exits 1", gh: { validateExit: 0, doctorExit: 1 }, status: "fail", code: 1 },
  { label: "both exit 1", gh: { validateExit: 1, doctorExit: 1 }, status: "fail", code: 1 },
  { label: "gh aw validate exits 2", gh: { validateExit: 2, doctorExit: 0 }, status: "fail", code: 1 },
];

for (const [entryPoint, run] of ENTRY_POINTS) {
  for (const { label, gh, status, code } of CASES) {
    test(`AC42: ${entryPoint}: ${label}: doctorStatus ${status}, exit ${code === 0 ? "0" : "non-zero"}, the report is printed, both commands were run in order after S1`, async () => {
      const scenario = await createScenario({ fake: { repos: REPOS }, gh });
      try {
        const result = await run(scenario);
        assert.equal(result.code, code, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.doctorStatus, status);
        assert.deepEqual(aw(scenario), ["aw version", "aw validate", "aw doctor"], "both commands run, validate first, even when the first fails");
        assert.equal(scenario.reconcile.calls.length, 1);
        for (const call of [...scenario.gh.calls("aw", "validate"), ...scenario.gh.calls("aw", "doctor")]) {
          assert.equal(real(call.cwd), real(scenario.workspace.dir), "run in the working copy");
        }
        if (status === "fail") assert.match(result.stderr, /gh aw (validate|doctor) did not succeed \(exit \d\)/);
      } finally {
        await scenario.cleanup();
      }
    });
  }

  test(`AC42: ${entryPoint}: neither command runs after a failed ReconcileResult`, async () => {
    const scenario = await createScenario({ fake: { repos: REPOS }, reconcile: () => errorResult(["fixture error"]) });
    try {
      const result = await run(scenario);
      assert.notEqual(result.code, 0);
      assert.deepEqual(aw(scenario), ["aw version"]);
      assert.equal(result.stdout, "");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC42: the readiness commands are gh aw validate and gh aw doctor, in that order", () => {
  assert.deepEqual(READINESS_COMMANDS.map((args) => [...args]), [["aw", "validate"], ["aw", "doctor"]]);
});

test("AC42: runReadinessChecks reports pass only when both exit 0, and a command that could not be run counts as a failure", async () => {
  const run = async (codes, error) => {
    const calls = [];
    const logs = new Capture();
    const outcome = await runReadinessChecks({
      runGh: async (args) => {
        calls.push(args.join(" "));
        const code = codes[calls.length - 1];
        return code === null ? { code: null, stdout: "", stderr: "", error } : { code, stdout: `out ${calls.length}`, stderr: "" };
      },
      cwd: "/work",
      logger: createLogger(logs),
    });
    return { outcome, calls, logs: logs.text };
  };
  assert.equal((await run([0, 0])).outcome.doctorStatus, "pass");
  assert.equal((await run([0, 1])).outcome.doctorStatus, "fail");
  assert.equal((await run([1, 0])).outcome.doctorStatus, "fail");
  const missing = await run([null, 0], "spawn gh ENOENT");
  assert.equal(missing.outcome.doctorStatus, "fail");
  assert.deepEqual(missing.calls, ["aw validate", "aw doctor"]);
  assert.match(missing.logs, /gh aw validate could not be run: spawn gh ENOENT/);
});

test("AC42: the output of the readiness commands goes to stderr, never to stdout", async () => {
  const scenario = await createScenario();
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /fake gh aw validate/);
    assert.match(result.stderr, /fake gh aw doctor/);
    assert.equal(/fake gh aw/.test(result.stdout), false);
  } finally {
    await scenario.cleanup();
  }
});
