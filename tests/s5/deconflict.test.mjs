// AC30, AC31 and AC32: schedule deconfliction is opt-in at two levels (the project option "disable-workflow-schedules" and the
// --deconflict-upstream-schedules flag); it disables only the workflow IDs that sdlc.yaml lists, through `gh workflow disable`
// with the operator's own credentials; an upstream where the operator lacks Actions: write is skipped with a warning.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { deconflictTargets, deconflictUpstreamSchedules } from "../../bin/lib/deconflict.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { Capture, REPO_ROOT, createScenario } from "./helpers/harness.mjs";

const WEEKLY = "weekly-content-audit.lock.yml";
const SELF_IMPROVING = "self-improving-agents.lock.yml";
const NEVER = ["generate-prd.lock.yml", "code-review.lock.yml"];
const OPERATOR_TOKEN = "operator-token-fixture";

const upstream = (projectKey, repo, option, workflowIds) => ({
  projectKey,
  repo,
  defaultBranch: "main",
  deconflictInRepoSchedules: option,
  deconflictWorkflowIds: workflowIds,
  driftAudit: {
    enabled: false,
    schedule: "0 6 * * 1",
    upkeepStrategy: "custom",
    instructions: "",
    instructionsFile: null,
    knowledgeSources: { watchUrls: [], packageManifests: [], mcpServers: {} },
    buildCommands: [],
    verifyCommands: [],
    draft: false,
    reviewers: [],
  },
});

/** The standard manifest with its third-party project (gamma-lib) configured, and optionally more upstream projects. */
function configure(scenario, { gamma = ["none", []], more = [] } = {}) {
  scenario.workspace.editManifest((data) => {
    const project = data.projects.find((entry) => entry.projectKey === "gamma-lib");
    [project.deconflictInRepoSchedules, project.deconflictWorkflowIds] = gamma;
    data.projects.push(...more);
  });
}

const run = (scenario, flag, extra = {}) => scenario.bootstrap(["--non-interactive", ...(flag ? ["--deconflict-upstream-schedules"] : [])], { env: scenario.env(scenario.appCredentials()), ...extra });
const nonGetTo = (scenario, owner) => scenario.fake.log.filter((entry) => entry.method !== "GET" && entry.path.startsWith(`/repos/${owner}/`));
const disables = (scenario) => scenario.gh.calls("workflow", "disable");

// --- AC30 ------------------------------------------------------------------------------------------------------------------

for (const [label, option, flag] of [
  ["(a) the option none plus the flag", "none", true],
  ["(b) the option disable-workflow-schedules without the flag", "disable-workflow-schedules", false],
  ["(c) a default invocation", "none", false],
]) {
  test(`AC30: ${label}: no request other than GET reaches an upstream repository, no workflow is disabled`, async () => {
    const scenario = await createScenario();
    try {
      configure(scenario, { gamma: [option, [WEEKLY, SELF_IMPROVING]] });
      const result = await run(scenario, flag);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(nonGetTo(scenario, "third-party"), []);
      assert.deepEqual(disables(scenario), []);
      assert.deepEqual(scenario.gh.calls("workflow"), []);
      assert.deepEqual(scenario.fake.state.disabledWorkflows, []);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.deconflictedTargetWorkflows, []);
      assert.deepEqual(report.skippedReadOnlyUpstreams, []);
      if (flag) assert.match(result.stderr, /no project sets deconflictInRepoSchedules to disable-workflow-schedules; no upstream is touched/);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC30: the option decides per upstream: with the flag, only the upstream that opted in is acted on", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, {
      gamma: ["none", [WEEKLY]],
      more: [upstream("opted-in", "third-party/opted-in", "disable-workflow-schedules", [WEEKLY]), upstream("not-opted-in", "third-party/not-opted-in", "none", [WEEKLY])],
    });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(scenario.fake.state.disabledWorkflows, [`third-party/opted-in:${WEEKLY}`]);
    assert.deepEqual(nonGetTo(scenario, "third-party").map((entry) => entry.path), [`/repos/third-party/opted-in/actions/workflows/${WEEKLY}/disable`]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC30: the targets are read from the manifest: only a project with the option and a valid repository slug", () => {
  const manifest = {
    projects: [
      upstream("a", "o/a", "disable-workflow-schedules", ["x.lock.yml"]),
      upstream("b", "o/b", "none", ["y.lock.yml"]),
      upstream("c", "not-a-slug", "disable-workflow-schedules", ["z.lock.yml"]),
      upstream("a-again", "O/A", "disable-workflow-schedules", ["x.lock.yml", "w.lock.yml"]),
    ],
  };
  assert.deepEqual(deconflictTargets(manifest), [{ repo: "o/a", workflowIds: ["x.lock.yml", "w.lock.yml"] }]);
  assert.deepEqual(deconflictTargets({}), []);
});

test("AC30: a workflow ID that is not a plain workflow file name or ID is refused, so no argument can be smuggled into gh", () => {
  for (const id of ["--repo", "a b", "../x.yml", "x;y", "-x.yml", ""]) {
    assert.throws(() => deconflictTargets({ projects: [upstream("a", "o/a", "disable-workflow-schedules", [id])] }), /is not a workflow file name or ID/, JSON.stringify(id));
  }
});

// --- AC31 ------------------------------------------------------------------------------------------------------------------

test("AC31: with both opt-ins exactly the two listed workflows are disabled, with the operator's own credentials and no other request to the upstream", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY, SELF_IMPROVING]] });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    const calls = disables(scenario);
    assert.deepEqual(
      calls.map((entry) => entry.args),
      [
        ["workflow", "disable", WEEKLY, "--repo", "third-party/gamma-lib"],
        ["workflow", "disable", SELF_IMPROVING, "--repo", "third-party/gamma-lib"],
      ],
      "exactly two disable calls",
    );
    for (const call of calls) {
      assert.equal(call.ghToken, OPERATOR_TOKEN, "the operator's own credential");
      assert.equal(/^(eyJ|ghs_)/.test(call.ghToken), false, "never the App's JSON Web Token or installation token");
    }
    assert.deepEqual(scenario.fake.state.disabledWorkflows, [`third-party/gamma-lib:${WEEKLY}`, `third-party/gamma-lib:${SELF_IMPROVING}`]);
    for (const id of NEVER) assert.equal(JSON.stringify(scenario.gh.log()).includes(id) || JSON.stringify(scenario.fake.log).includes(id), false, `${id} is never touched`);
    // no file, branch, commit or pull request, no Git-data or contents request: the only request to the upstream is the disable route
    assert.deepEqual(
      scenario.fake.log.filter((entry) => entry.path.startsWith("/repos/third-party/")).map((entry) => `${entry.method} ${entry.path}`),
      [`PUT /repos/third-party/gamma-lib/actions/workflows/${WEEKLY}/disable`, `PUT /repos/third-party/gamma-lib/actions/workflows/${SELF_IMPROVING}/disable`],
    );
    assert.equal(JSON.stringify(scenario.fake.log).includes("GH_AW_POLICY_"), false);
    assert.deepEqual(JSON.parse(result.stdout).deconflictedTargetWorkflows, [`third-party/gamma-lib:${SELF_IMPROVING}`, `third-party/gamma-lib:${WEEKLY}`]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC31: the workflows of the upstream that sdlc.yaml does not list (generate-prd and code-review) are never disabled, even though the upstream has them", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY, SELF_IMPROVING]] });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    const disabled = scenario.fake.state.disabledWorkflows.map((entry) => entry.split(":")[1]);
    assert.deepEqual(disabled.sort(), [SELF_IMPROVING, WEEKLY]);
    for (const id of NEVER) assert.equal(disabled.includes(id), false);
  } finally {
    await scenario.cleanup();
  }
});

test("AC31: the preset sdlc.yaml lists neither generate-prd.lock.yml nor code-review.lock.yml as a target", () => {
  const preset = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "sdlc.yaml"), "utf8"));
  const listed = preset.projects.flatMap((project) => project.deconflictWorkflowIds ?? []);
  for (const id of NEVER) assert.equal(listed.includes(id), false, `${id} is a target in the preset`);
  for (const project of preset.projects) assert.equal(project.deconflictInRepoSchedules, "none", `the preset keeps ${project.projectKey} untouched by default`);
});

test("AC31: a workflow that is disabled is reported once per workflow and the disable is not repeated for a repeated ID", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY, WEEKLY]] });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(disables(scenario).length, 1);
    assert.deepEqual(JSON.parse(result.stdout).deconflictedTargetWorkflows, [`third-party/gamma-lib:${WEEKLY}`]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC31: the deconfliction runs after the secrets and before S1, so a failure of it leaves S1 uncalled", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY]] });
    scenario.fake.override("PUT", `/repos/third-party/gamma-lib/actions/workflows/${WEEKLY}/disable`, { status: 500, body: { message: "boom" } });
    const result = await run(scenario, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`gh workflow disable ${WEEKLY} --repo third-party/gamma-lib failed \\(HTTP 500\\)`));
    assert.equal(result.stdout, "");
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC31: unit: deconflictUpstreamSchedules does nothing when it is not enabled, even with targets", async () => {
  const calls = [];
  const outcome = await deconflictUpstreamSchedules({
    manifest: { projects: [upstream("a", "o/a", "disable-workflow-schedules", ["x.lock.yml"])] },
    enabled: false,
    runGh: async (args) => calls.push(args),
    logger: createLogger(new Capture()),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(outcome, { deconflicted: [], skippedReadOnly: [] });
});

// --- AC32 ------------------------------------------------------------------------------------------------------------------

test("AC32: 403 for upstream A, 404 for upstream B and a success for upstream C: A and B are skipped with a warning naming C5, C is disabled, exit 0", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, {
      more: [
        upstream("upstream-b", "third-party/upstream-b", "disable-workflow-schedules", [WEEKLY]),
        upstream("upstream-c", "third-party/upstream-c", "disable-workflow-schedules", [WEEKLY, SELF_IMPROVING]),
        upstream("upstream-a", "third-party/upstream-a", "disable-workflow-schedules", [WEEKLY, SELF_IMPROVING]),
      ],
    });
    scenario.fake.override("PUT", "/repos/third-party/upstream-a/actions/workflows/:id/disable", { status: 403, body: { message: "Must have admin rights to Repository." } });
    scenario.fake.override("PUT", "/repos/third-party/upstream-b/actions/workflows/:id/disable", { status: 404, body: { message: "Not Found" } });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.skippedReadOnlyUpstreams, ["third-party/upstream-a", "third-party/upstream-b"]);
    assert.deepEqual(report.deconflictedTargetWorkflows, [`third-party/upstream-c:${SELF_IMPROVING}`, `third-party/upstream-c:${WEEKLY}`]);
    assert.match(result.stderr, /warning: could not disable .* on third-party\/upstream-a \(HTTP 403\)/);
    assert.match(result.stderr, /warning: could not disable .* on third-party\/upstream-b \(HTTP 404\)/);
    assert.match(result.stderr, /duplicate in-repo schedules remain active/);
    assert.match(result.stderr, /\(C5\)/);
    assert.match(result.stderr, /open-pull-request deduplication of S2/);
    assert.equal(scenario.reconcile.calls.length, 1, "the run continued to S1");
  } finally {
    await scenario.cleanup();
  }
});

test("AC32: after a 403 the remaining workflows of that upstream are not attempted, and the repository is listed once", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY, SELF_IMPROVING]] });
    scenario.fake.override("PUT", "/repos/third-party/gamma-lib/actions/workflows/:id/disable", { status: 403, body: { message: "Must have admin rights to Repository." } });
    const result = await run(scenario, true);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(disables(scenario).length, 1);
    assert.deepEqual(JSON.parse(result.stdout).skippedReadOnlyUpstreams, ["third-party/gamma-lib"]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC32: any other failure of gh workflow disable aborts the run, naming the workflow and the repository", async () => {
  const scenario = await createScenario();
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY]] });
    scenario.fake.override("PUT", "/repos/third-party/gamma-lib/actions/workflows/:id/disable", { status: 422, body: { message: "Validation Failed" } });
    const result = await run(scenario, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /gh workflow disable weekly-content-audit\.lock\.yml --repo third-party\/gamma-lib failed \(HTTP 422\)/);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC32: a skipped upstream does not hide a failure elsewhere: the exit code is zero only when nothing else failed", async () => {
  const scenario = await createScenario({ gh: { doctorExit: 1 } });
  try {
    configure(scenario, { gamma: ["disable-workflow-schedules", [WEEKLY]] });
    scenario.fake.override("PUT", "/repos/third-party/gamma-lib/actions/workflows/:id/disable", { status: 403, body: { message: "Must have admin rights to Repository." } });
    const result = await run(scenario, true);
    assert.equal(result.code, 1, "the readiness failure still decides the exit code");
    assert.equal(JSON.parse(result.stdout).doctorStatus, "fail");
    assert.deepEqual(JSON.parse(result.stdout).skippedReadOnlyUpstreams, ["third-party/gamma-lib"]);
  } finally {
    await scenario.cleanup();
  }
});
