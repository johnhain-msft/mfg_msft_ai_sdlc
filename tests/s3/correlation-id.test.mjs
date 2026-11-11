// The correlation id of a routed event in the failure issue of the cascade that the event started (SPEC-03 AC52).
//
// The router generates one id per routed event (the bridge's, when it sent one, otherwise one derived from its own run) and writes it into the
// MergeRoutingDecision, into the dispatch inputs and into its own [sdlc-failure] issue (tests/s3/router-dispatch.test.mjs, tests/s3/upstream-signal.test.mjs).
// The cascade that it dispatches is another run with another run id, so the id can reach the issue that src/update-poll-state.mjs opens from
// finalize_poll_state or escalate_failure only through the dispatch input `correlation_id`: the rendered step binds CORRELATION_ID to it, and the script
// writes what it is given. The first half drives the script with that variable on each of its three paths to an issue; the second half runs every link of the
// chain for each of the five committed cascade workflows: the real router and the inputs it dispatched, the committed step's env and command line (real bash),
// and the real script against the stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { BashSandbox } from "../s1/helpers/bash-runtime.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, edge as edgeFixture, presetEdges, readText, routerMatrixEntries, seedState, sha, state, TOKENS } from "./helpers/fixtures.mjs";
import { BASE, flagsFor, HEAD, invoke, TARGET, world } from "./helpers/poll-state-world.mjs";

const ROW = (id) => `| Correlation id | \`${id}\` |`;
const ID = "corr-from-router";
const stateOf = (w) => w.stub.variable(w.edgeValue.stateVariable);
const recordFailure = (w) => ["--record-failure", "--slug", w.edgeValue.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "cascade-ai-widgets-to-portal"];

// ---- the script: every path that ends in an issue ----------------------------------------------------------------------------------------------------

test("AC52 --record-failure writes the correlation id that the cascade was dispatched with into the issue, and not the id of the cascade's own run", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, recordFailure(w), { env: { CORRELATION_ID: ID } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.issues.length, 1);
  assert.ok(w.stub.issues[0].body.includes(ROW(ID)), w.stub.issues[0].body);
  assert.equal(w.stub.issues[0].body.includes("run-77-1"), false, "the run id of this job (77) is not the id of the event");
  assert.equal(stateOf(w).failedAttempts, 1, "the failure is recorded as before");
  assert.equal(stateOf(w).failedTargetSha, TARGET);
});

test("AC52 a verification failure of the success path (no open pull request records the target) carries the id too", async (t) => {
  const w = world({ pulls: [] });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue), { env: { CORRELATION_ID: ID } });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(w.stub.issues.length, 1);
  assert.ok(w.stub.issues[0].body.includes(ROW(ID)), w.stub.issues[0].body);
  assert.equal(w.stub.issues[0].body.includes("run-77-1"), false);
  assert.equal(stateOf(w).failedAttempts, 1, "the failure transition is applied once, as before");
  assert.equal(w.stub.calls("PATCH").length, 1);
});

test("AC52 a request that fails on the success path (the issue says that the state could not be updated) names the id as well, and the counters stay as they were", async (t) => {
  const start = state({ failedTargetSha: TARGET, failedAttempts: 1 });
  const w = world({ start });
  t.after(() => w.workspace.cleanup());
  w.stub.inject("GET", "/pulls", () => ({ status: 500, body: { message: "boom" } }));
  const result = await invoke(w, flagsFor(w.edgeValue), { env: { CORRELATION_ID: ID } });
  assert.equal(result.code, 1);
  assert.equal(w.stub.issues.length, 1);
  assert.match(w.stub.issues[0].body, /could not be updated/);
  assert.ok(w.stub.issues[0].body.includes(ROW(ID)), w.stub.issues[0].body);
  assert.deepEqual(stateOf(w), start, "the variable is unchanged");
  assert.equal(w.stub.calls("PATCH").length, 0);
});

test("AC52 a later failure of the same cascade comments with the id of its own event, and the issue keeps the id of the first", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  assert.equal((await invoke(w, recordFailure(w), { env: { CORRELATION_ID: "event-1" } })).code, 0);
  assert.equal((await invoke(w, recordFailure(w), { env: { CORRELATION_ID: "event-2" } })).code, 0);
  assert.equal(w.stub.issues.length, 1, "never duplicated");
  assert.ok(w.stub.issues[0].body.includes(ROW("event-1")));
  assert.equal(w.stub.world.comments.length, 1);
  assert.ok(w.stub.world.comments[0].body.includes(ROW("event-2")), w.stub.world.comments[0].body);
  assert.equal(w.stub.world.comments[0].body.includes("event-1"), false);
});

test("AC52 the id is written unchanged: every character that a correlation id may hold survives, and the run of the cascade need not have an id at all", async (t) => {
  const given = "bridge:deploy-42/a+b=c.d_e";
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, recordFailure(w), { env: { CORRELATION_ID: given }, omitEnv: ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"] });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(w.stub.issues[0].body.includes(ROW(given)), w.stub.issues[0].body);
});

test("AC52 a dispatch that carried no correlation id (a manual run) leaves the variable empty, and the issue names the id that the cascade's own run implies", async (t) => {
  for (const given of [undefined, "", "  \t "]) {
    const w = world();
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, recordFailure(w), { env: { CORRELATION_ID: given } });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(w.stub.issues[0].body.includes(ROW("run-77-1")), `${JSON.stringify(given)}: ${w.stub.issues[0].body}`);
    assert.equal(result.stderr.includes("CORRELATION_ID"), false, "an empty input is not a complaint");
  }
});

test("AC52 an id that is not shaped like a correlation id is never written into the issue: the id of the run is used, and the log says why without echoing the value", async (t) => {
  for (const given of ["has space", "-leading-dash", "a".repeat(129), "pipe|breaks|the|table", "back`tick", "new\nline", "::error::injected"]) {
    const w = world();
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, recordFailure(w), { env: { CORRELATION_ID: given } });
    assert.equal(result.code, 0, `${JSON.stringify(given)}: ${result.stderr}`);
    assert.equal(w.stub.issues.length, 1, "the failure is still recorded and reported");
    assert.ok(w.stub.issues[0].body.includes(ROW("run-77-1")), `${JSON.stringify(given)}: ${w.stub.issues[0].body}`);
    assert.equal(w.stub.issues[0].body.includes(given), false, `${JSON.stringify(given)} is not in the issue`);
    assert.match(result.stderr, /CORRELATION_ID is not a correlation id/);
    assert.equal(result.stderr.includes(given), false, `${JSON.stringify(given)} is not echoed`);
    assert.equal(stateOf(w).failedAttempts, 1, "a malformed id does not stop the failure from being recorded");
  }
});

// ---- the chain: router -> dispatch inputs -> the committed workflow's step -> the script -------------------------------------------------------------------

const authoredOf = (workflowId) => YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readText(abs(".github", "workflows", `${workflowId}.md`)))[1]);
const lockOf = (workflowId) => YAML.parse(readText(abs(".github", "workflows", `${workflowId}.lock.yml`)));
const cascadeId = (entry) => (entry.mode === "mechanical" ? `cascade-mechanical-${entry.edgeId}` : `cascade-ai-${entry.edgeId}`);
const pollStep = (job) => job.steps.find((step) => typeof step.run === "string" && step.run.includes("update-poll-state.mjs"));
const JOBS = ["finalize_poll_state", "escalate_failure"];
const edges = presetEdges();

test("AC52 every cascade workflow binds CORRELATION_ID to the dispatch input in the step that runs update-poll-state.mjs: both custom jobs, source and compiled lock", () => {
  assert.equal(edges.length, 6, "the preset has six edges");
  for (const entry of edges) {
    const workflowId = cascadeId(entry);
    for (const [label, workflow] of [["source", authoredOf(workflowId)], ["lock", lockOf(workflowId)]]) {
      assert.equal(workflow.on.workflow_dispatch.inputs.correlation_id.type, "string", `${workflowId} (${label}) declares the input correlation_id`);
      for (const name of JOBS) {
        const step = pollStep(workflow.jobs[name]);
        assert.ok(step, `${workflowId}.${name} (${label}) runs the script`);
        assert.equal(step.env.CORRELATION_ID, "${{ inputs.correlation_id }}", `${workflowId}.${name} (${label})`);
      }
    }
  }
});

/** The env of a step as the runner gives it to the command, with the expressions of the workflow resolved against the dispatch inputs and the job's tokens. */
function resolvedEnv(env, inputs) {
  const resolved = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    resolved[name] = String(value).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression) => {
      if (expression.startsWith("inputs.")) {
        const key = expression.slice("inputs.".length);
        assert.ok(Object.hasOwn(inputs, key), `${name}: the dispatch carries no input ${key}`);
        return inputs[key];
      }
      if (expression === "steps.app_token.outputs.token") return TOKENS.gh;
      if (expression === "secrets.GITHUB_TOKEN") return TOKENS.issues;
      return assert.fail(`${name}: this test cannot resolve \${{ ${expression} }}`);
    });
  }
  return resolved;
}

/** The arguments that the command of a step hands to the script, from real bash with the step's environment and a recorder in place of the script. */
function argvOf(step, env) {
  const sandbox = new BashSandbox();
  try {
    const recorder = path.join(sandbox.work, "src", "update-poll-state.mjs");
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    fs.writeFileSync(recorder, 'import fs from "node:fs";\nfs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\n');
    const argvFile = path.join(sandbox.root, "argv.json");
    const result = sandbox.run(step.run, { ...env, ARGV_FILE: argvFile.replace(/\\/g, "/") });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(argvFile, "utf8"));
  } finally {
    sandbox.cleanup();
  }
}

/** The router, run once for a routed event on a synthetic copy of the preset edge; returns what it dispatched and decided. */
async function routed(entry, event, t) {
  const matrix = routerMatrixEntries().find((candidate) => candidate.upstreamKey === entry.upstreamKey);
  const edge = edgeFixture({ ...matrix, upstreamRepo: "initech/up", downstreamRepo: "acme/portal", preflightCommands: [] });
  const payload = event === "repository_dispatch" ? { correlation_id: "bridge:deploy-42/a+b=c", upstream_repo: edge.upstreamRepo, merged_sha: sha("merged"), pr_number: 5, merged_at: "2026-11-07T11:00:00Z", default_branch: edge.upstreamDefaultBranch } : undefined;
  const router = routerWorld({ edge, event, payload, manifestEdges: [edge], state: seedState(edge), upstream: { head: sha(`head-of-${entry.upstreamKey}`) } });
  t.after(() => router.cleanup());
  const result = await router.go();
  assert.equal(result.code, 0, result.stderr);
  const [decision] = router.decisions();
  const [dispatch] = router.stub.world.dispatches;
  return { decision, inputs: dispatch.body.inputs };
}

for (const entry of edges) {
  const workflowId = cascadeId(entry);
  test(`AC52 ${workflowId}: the id of the routed event, as the router dispatched it, is the id in the failure issue of finalize_poll_state and of escalate_failure`, async (t) => {
    const authored = authoredOf(workflowId);
    const events = {};
    for (const event of ["repository_dispatch", "schedule"]) events[event] = await routed(entry, event, t);
    assert.equal(events.repository_dispatch.decision.correlationId, "bridge:deploy-42/a+b=c", "the bridge's id, carried by the router");
    assert.equal(events.schedule.decision.correlationId, "run-5001-1", "no bridge: the id of the router's run");

    for (const name of JOBS) {
      const step = pollStep(authored.jobs[name]);
      const lockStep = pollStep(lockOf(workflowId).jobs[name]);
      assert.deepEqual({ env: lockStep.env, run: lockStep.run }, { env: step.env, run: step.run }, `${name}: the compiled step is the authored one`);
      // the revisions that finalize_poll_state exports to $GITHUB_ENV before the step: a head that differs from the base, so that the pull request is looked for
      const exported = { BASE_SHA: BASE, AGENT_HEAD_SHA: HEAD };
      for (const [event, { decision, inputs }] of Object.entries(events)) {
        const env = resolvedEnv(step.env, inputs);
        const argv = argvOf(step, { ...env, ...exported });
        const w = world({ edgeValue: entry, start: seedState(entry), pulls: [] });
        t.after(() => w.workspace.cleanup());
        const result = await invoke(w, argv, { env: { ...env, GITHUB_WORKSPACE: abs(".") } });
        const label = `${name} after the ${event} event`;
        assert.equal(result.code, name === "finalize_poll_state" ? 1 : 0, `${label}: ${result.stderr}`);
        assert.equal(w.stub.issues.length, 1, label);
        assert.equal(w.stub.issues[0].title, `[sdlc-failure] ${workflowId} (${entry.downstreamRepo})`, label);
        assert.ok(w.stub.issues[0].body.includes(ROW(decision.correlationId)), `${label}: ${w.stub.issues[0].body}`);
        assert.equal(inputs.correlation_id, decision.correlationId, `${label}: the dispatch input is the id of the decision`);
        assert.equal(w.stub.issues[0].body.includes("run-77-1"), false, `${label}: not the id of the cascade's own run`);
        assert.equal(stateOf(w).failedTargetSha, inputs.upstream_sha, `${label}: the target of the dispatch reached the script through the same step`);
        assert.equal(stateOf(w).failedAttempts, 1, label);
      }
    }
  });
}
