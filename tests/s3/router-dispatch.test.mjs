// The asynchronous dispatch of the cascade workflows (SPEC-03 AC34-AC38, AC52, AC65; contract C7): the request that is sent, the ten and the eight string inputs,
// previous_sha, the recorded in-flight pair, the five-second gap, a response without a run id, and the correlation id.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateShape } from "../../src/routing/schema.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, edge as edgeFixture, mechanicalEdge, routerMatrixEntries, seedState, sha, state, TOKENS } from "./helpers/fixtures.mjs";

const E = edgeFixture();
const HEAD = sha("head-1");
const SHA0 = sha("sha0");

function world({ edge = E, head = HEAD, stateOverrides = {}, ...rest } = {}) {
  return routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, ...stateOverrides }, edge), upstream: { head }, ...rest });
}

const dispatchOf = (w) => w.stub.world.dispatches[0];

test("AC34 the request: POST to the workflow file of the central repository, API version 2022-11-28, return_run_details true, the default branch as ref, the App token", async (t) => {
  const w = world({ stubOptions: {} });
  t.after(() => w.cleanup());
  w.stub.repo("acme/orchestrator").defaultBranch = "production";
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  const [request] = w.stub.calls("POST", "/dispatches");
  assert.equal(request.path, "/repos/acme/orchestrator/actions/workflows/cascade-ai-widgets-to-portal.lock.yml/dispatches");
  assert.equal(request.headers["x-github-api-version"], "2022-11-28");
  const body = JSON.parse(request.body);
  assert.equal(body.return_run_details, true);
  assert.equal(body.ref, "production", "the branch that holds the workflow files is the default branch of the orchestrator, read and not assumed");
  assert.deepEqual(Object.keys(body).sort(), ["inputs", "ref", "return_run_details"]);
  const minted = w.stub.world.minted;
  assert.ok(minted.some((entry) => `Bearer ${entry.token}` === request.headers.authorization), "authenticated with a token of the App installation");
  assert.notEqual(request.headers.authorization, `Bearer ${TOKENS.issues}`, "never the token of the job");
  const write = minted.find((entry) => entry.permissions.variables === "write");
  assert.equal(request.headers.authorization, `Bearer ${write.token}`);
  assert.deepEqual(write.repositories, ["orchestrator"], "the write token is limited to the orchestrator repository");
});

test("AC34 the three AI workflows of the preset are dispatched by the lock files that the contract names, and they exist on disk", async (t) => {
  const names = { "copilot-lab": "cascade-ai-copilot-lab.lock.yml", "pipeline-showcase": "cascade-ai-pipeline-showcase.lock.yml", "github-intermediate": "cascade-ai-github-intermediate.lock.yml" };
  for (const entry of routerMatrixEntries().filter((candidate) => candidate.mode === "ai-adaptation")) {
    const edge = edgeFixture({ ...entry, upstreamRepo: "initech/up", downstreamRepo: "acme/portal", preflightCommands: [] });
    const w = routerWorld({ edge, state: seedState(edge), upstream: { head: HEAD } });
    t.after(() => w.cleanup());
    assert.equal((await w.go()).code, 0);
    const [request] = w.stub.calls("POST", "/dispatches");
    assert.equal(request.path, `/repos/acme/orchestrator/actions/workflows/${names[entry.upstreamKey]}/dispatches`, entry.upstreamKey);
    assert.ok(fs.existsSync(abs(".github", "workflows", names[entry.upstreamKey])), `${names[entry.upstreamKey]} is a committed workflow`);
    assert.equal(w.decisions()[0].dispatchedWorkflowId, names[entry.upstreamKey]);
  }
});

test("AC35 the inputs are exactly the ten of the contract, all strings, and validate against AiCascadeDispatchInputs", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  await w.go();
  const { inputs } = dispatchOf(w).body;
  assert.deepEqual(Object.keys(inputs), ["correlation_id", "upstream_repo", "previous_sha", "upstream_sha", "upstream_etag", "upstream_pr_number", "downstream_repo", "sync_scope", "on_commit_only_advance", "dry_run"]);
  for (const [key, value] of Object.entries(inputs)) assert.equal(typeof value, "string", key);
  assert.deepEqual(validateShape("AiCascadeDispatchInputs", inputs).errors, []);
  assert.equal(inputs.upstream_repo, "initech/widgets");
  assert.equal(inputs.downstream_repo, "acme/portal", "the edge's downstreamRepo");
});

test("AC36 previous-sha-is-last-merged: previous_sha is the merge cursor, never the observed head or the open pull request's target", async (t) => {
  const w = world({ stateOverrides: { lastMergedUpstreamSha: sha("merged"), lastObservedHeadSha: sha("observed"), openPrNumber: 4, openPrTargetSha: sha("open-target") } });
  t.after(() => w.cleanup());
  w.stub.repo("acme/portal").pulls = { 4: { number: 4, state: "open", merged: false, head: { sha: sha("x") }, html_url: "https://github.com/acme/portal/pull/4" } };
  await w.go();
  const { inputs } = dispatchOf(w).body;
  assert.equal(inputs.previous_sha, sha("merged"));
  assert.notEqual(inputs.previous_sha, sha("observed"));
  assert.notEqual(inputs.previous_sha, sha("open-target"));
  assert.equal(inputs.upstream_sha, HEAD);
});

test("AC36 on-commit-only-advance-from-edge: the input is populated from the edge for both values", async (t) => {
  for (const value of ["noop", "bump-provenance"]) {
    const edge = edgeFixture({ onCommitOnlyAdvance: value });
    const w = world({ edge });
    t.after(() => w.cleanup());
    await w.go();
    assert.equal(dispatchOf(w).body.inputs.on_commit_only_advance, value);
  }
});

test("AC36 dry-run-is-string-false: dry_run is the literal string false, and every value is a string", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  await w.go();
  assert.strictEqual(dispatchOf(w).body.inputs.dry_run, "false");
});

test("AC36 upstream_etag is the held etag and upstream_pr_number the decimal string of the merged pull request or empty", async (t) => {
  const w = world({ upstream: { etag: 'W/"held"' } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(dispatchOf(w).body.inputs.upstream_etag, 'W/"held"');
  assert.equal(dispatchOf(w).body.inputs.upstream_pr_number, "");
});

test("AC36 the sync scope of an edge that declares no preflight is a scope that its manifest entry accepts", async (t) => {
  const edge = edgeFixture({ upstreamKey: "widgets" });
  const manifest = [{ ...edge, syncScopes: ["github-intermediate"] }];
  const w = world({ edge, manifestEdges: manifest });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(dispatchOf(w).body.inputs.sync_scope, "github-intermediate");
  const open = world({ edge });
  t.after(() => open.cleanup());
  await open.go();
  assert.equal(dispatchOf(open).body.inputs.sync_scope, "both");
});

test("AC37 records-in-flight-pair: the run id of the response and the target are recorded, and nothing waits for the run", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  await w.go();
  const stored = w.state();
  assert.equal(stored.inFlightRunId, dispatchOf(w).runId);
  assert.equal(Number.isInteger(stored.inFlightRunId), true);
  assert.equal(stored.inFlightTargetSha, HEAD);
  assert.equal(w.patches().length, 1);
});

test("AC37 exits-without-polling-the-run: after the dispatch the router asks about no run", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.stub.calls("GET", "/actions/runs").length, 0);
  const afterDispatch = w.stub.requests.slice(w.stub.requests.findIndex((request) => request.method === "POST" && request.path.endsWith("/dispatches")) + 1);
  assert.deepEqual(afterDispatch.map((request) => request.method), ["PATCH"], "the only request after the dispatch is the state write");
});

test("AC37 five-second-gap-between-dispatches: the router waits five seconds after each dispatch, after the state is written, and not before", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  const before = w.clock.time;
  await w.go();
  assert.deepEqual(w.clock.waits, [5000]);
  assert.equal(w.clock.time - before, 5000);
  const noop = world({ head: SHA0, stateOverrides: {} });
  t.after(() => noop.cleanup());
  await noop.go();
  assert.deepEqual(noop.clock.waits, [], "a no-op dispatches nothing and waits for nothing");
});

test("AC38 empty-204-is-a-failed-dispatch: a response without run details records nothing, writes nothing and fails the job", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.world.dispatchReplies.push({ status: 204, headers: {}, body: "" });
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /204/);
  assert.equal(w.patches().length, 0);
  assert.equal(w.state().inFlightRunId, null);
  assert.equal(w.state().inFlightTargetSha, null);
  assert.equal(w.stub.world.dispatches.length, 1, "a response that may hide a started run is not dispatched again");
  assert.equal(w.stub.issues.length, 1);
  assert.deepEqual(w.summaryLines(), []);
  assert.deepEqual(w.clock.waits, [], "no pacing wait after a dispatch that failed");
});

test("AC38 a 200 whose workflow_run_id is not a number is a failed dispatch too", async (t) => {
  for (const body of [{ run_url: "u", html_url: "h" }, { workflow_run_id: "123", run_url: "u", html_url: "h" }, { workflow_run_id: 0, run_url: "u", html_url: "h" }, {}, []]) {
    const w = world();
    t.after(() => w.cleanup());
    w.stub.world.dispatchReplies.push({ status: 200, headers: {}, body });
    const result = await w.go();
    assert.equal(result.code, 1, JSON.stringify(body));
    assert.equal(w.patches().length, 0);
    assert.equal(w.state().inFlightRunId, null);
  }
});

test("AC52 correlation-id-carried-unchanged: one id per routed event, the same in the decision, the dispatch inputs and the failure issue body", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  await w.go();
  const id = w.decisions()[0].correlationId;
  assert.match(id, /^run-5001-1$/);
  assert.equal(dispatchOf(w).body.inputs.correlation_id, id);

  const failing = world();
  t.after(() => failing.cleanup());
  failing.stub.world.dispatchReplies.push({ status: 500, headers: {}, body: { message: "boom" } });
  await failing.go();
  assert.ok(failing.stub.issues[0].body.includes(id), "the failure issue names the same id");
});

test("AC52 without a run id the router generates a unique id and still carries it unchanged", async (t) => {
  const w = world({ env: { GITHUB_RUN_ID: undefined } });
  t.after(() => w.cleanup());
  await w.go();
  const id = w.decisions()[0].correlationId;
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,127}$/);
  assert.equal(dispatchOf(w).body.inputs.correlation_id, id);
});

test("AC65 dispatch-mechanical-inputs: the mechanical workflow gets the eight inputs of AC35 without sync_scope and on_commit_only_advance", async (t) => {
  const edge = mechanicalEdge();
  const w = world({ edge });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  const [request] = w.stub.calls("POST", "/dispatches");
  assert.equal(request.path, "/repos/acme/orchestrator/actions/workflows/cascade-mechanical-gadgets-to-portal.lock.yml/dispatches");
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body.inputs), ["correlation_id", "upstream_repo", "previous_sha", "upstream_sha", "upstream_etag", "upstream_pr_number", "downstream_repo", "dry_run"]);
  assert.deepEqual(validateShape("MechanicalDispatchInputs", body.inputs).errors, []);
  assert.equal(body.return_run_details, true);
  assert.equal(request.headers["x-github-api-version"], "2022-11-28");
  assert.deepEqual(w.decisions()[0], { correlationId: "run-5001-1", upstreamRepo: "acme/gadgets", previousSha: SHA0, targetSha: HEAD, action: "dispatch-mechanical", dispatchedWorkflowId: "cascade-mechanical-gadgets-to-portal.lock.yml" });
});

test("AC65 the preset's mechanical edge is dispatched by cascade-mechanical-ghec-admin.lock.yml, which exists, with the inputs that its workflow exposes", async (t) => {
  const entry = routerMatrixEntries().find((candidate) => candidate.mode === "mechanical");
  const edge = edgeFixture({ ...entry, upstreamRepo: "acme/gh-admin", downstreamRepo: "acme/portal", preflightCommands: [] });
  const w = routerWorld({ edge, state: seedState(edge), upstream: { head: HEAD } });
  t.after(() => w.cleanup());
  await w.go();
  const [request] = w.stub.calls("POST", "/dispatches");
  assert.ok(request.path.endsWith("/cascade-mechanical-ghec-admin.lock.yml/dispatches"));
  const workflow = fs.readFileSync(abs(".github", "workflows", "cascade-mechanical-ghec-admin.md"), "utf8");
  for (const key of Object.keys(JSON.parse(request.body).inputs)) assert.ok(new RegExp(`^ {6}${key}:`, "m").test(workflow), `${key} is a workflow_dispatch input of the mechanical workflow`);
});
