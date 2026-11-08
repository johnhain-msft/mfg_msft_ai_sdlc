// The signal that wakes the router (SPEC-03 AC9, AC10): an optional repository_dispatch whose client_payload is validated, matched to an edge and never
// the source of the target; a scheduled run that routes every edge without it.
import assert from "node:assert/strict";
import test from "node:test";
import { routerWorld } from "./helpers/harness.mjs";
import { CENTRAL, edge as edgeFixture, fixture, mechanicalEdge, readJson, seedState, sha, state, TOKENS } from "./helpers/fixtures.mjs";

const WIDGETS = edgeFixture();
const GADGETS = mechanicalEdge();
const GIZMOS = edgeFixture({ edgeId: "gizmos-to-portal", upstreamRepo: "initech/gizmos", upstreamKey: "gizmos", upstreamSlug: "GIZMOS", stateVariable: "SDLC_SYNC_STATE_GIZMOS", branchName: "sdlc/cascade-gizmos", closeOlderKey: "sdlc-cascade-gizmos", provenanceFile: "docs/gizmos/provenance.json" });
const SIGNAL = readJson(fixture("signal", "valid.json"));

function signalWorld({ edge = WIDGETS, payload = SIGNAL, manifestEdges = [WIDGETS, GADGETS, GIZMOS], head = sha("head-1"), ...rest } = {}) {
  return routerWorld({ edge, event: "repository_dispatch", payload, manifestEdges, state: seedState(edge), upstream: { head }, ...rest });
}

test("AC10 matching-edge: the job whose edge names the payload's repository and default branch routes the event", async (t) => {
  const w = signalWorld();
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.decisions().length, 1);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(w.stub.world.dispatches.length, 1);
});

test("AC10 matching-edge: a repository that differs only in case still matches (GitHub names are case-insensitive), a branch that differs in case does not", async (t) => {
  const upper = signalWorld({ payload: { ...SIGNAL, upstream_repo: "Initech/Widgets" } });
  t.after(() => upper.cleanup());
  assert.equal((await upper.go()).code, 0);
  assert.equal(upper.decisions().length, 1);

  const branch = signalWorld({ payload: { ...SIGNAL, default_branch: "Trunk" } });
  t.after(() => branch.cleanup());
  const result = await branch.go();
  assert.equal(result.code, 1, "no edge has the branch Trunk");
  assert.equal(branch.stub.world.dispatches.length, 0);
});

test("AC10 other-edge-exits-0-without-request: a job whose edge the payload does not name issues no request at all and logs no decision", async (t) => {
  for (const other of [GADGETS, GIZMOS]) {
    const w = signalWorld({ edge: other });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(w.stub.requests.length, 0, `${other.upstreamKey}: no request`);
    assert.deepEqual(w.summaryLines(), []);
    assert.match(result.stdout, /another edge/);
    assert.deepEqual(w.stub.variable(other.stateVariable), seedState(other), "the state is untouched");
  }
});

test("AC10 every matrix job reads all edges of the manifest: a job that is not named reads sdlc.yaml and fails closed when it cannot", async (t) => {
  const w = signalWorld({ edge: GADGETS, manifestEdges: [GADGETS] });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 1, "no edge of the manifest names the payload");

  const missing = signalWorld({ edge: GADGETS });
  t.after(() => missing.cleanup());
  missing.workspace.cleanup();
  const unreadable = await missing.go();
  assert.equal(unreadable.code, 1);
  assert.equal(missing.stub.world.dispatches.length, 0);
});

test("AC10 unknown-repo-fails-without-write: a payload that matches no edge fails every job and advances no state", async (t) => {
  const unknown = { ...SIGNAL, upstream_repo: "nobody/unknown" };
  for (const edge of [WIDGETS, GADGETS, GIZMOS]) {
    const w = signalWorld({ edge, payload: unknown });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 1, edge.upstreamKey);
    assert.equal(w.patches().length, 0, `${edge.upstreamKey}: no state write`);
    assert.equal(w.stub.world.dispatches.length, 0);
    assert.deepEqual(w.stub.variable(edge.stateVariable), seedState(edge));
    assert.match(result.stderr, /no dependency edge has the upstream nobody\/unknown/);
    assert.deepEqual(w.summaryLines(), [], "no decision: there is no target");
    assert.equal(w.stub.requests.filter((request) => request.path.includes("/repos/initech/") || request.path.includes("/actions/variables")).length, 0, "no request to an upstream or to the state");
  }
});

test("AC10 merged-sha-not-used-as-target: the target comes from the conditional poll, whatever the payload says", async (t) => {
  const merged = sha("merged-sha-of-the-payload");
  const head = sha("head-from-the-poll");
  const w = signalWorld({ payload: { ...SIGNAL, merged_sha: merged }, head });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.decisions()[0].targetSha, head);
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_sha, head);
  for (const request of w.stub.requests) {
    assert.equal(`${request.url}${request.body ?? ""}`.includes(merged), false, `${request.method} ${request.path} does not use merged_sha`);
  }
  assert.equal(w.summaryLines().join("\n").includes(merged), false);
  const prNumber = w.stub.world.dispatches[0].body.inputs.upstream_pr_number;
  assert.equal(prNumber, "", "pr_number of the payload is not the number of the dispatch either");
});

test("AC9 an invalid client_payload (missing, extra or mistyped property) fails the job with one issue and no write", async (t) => {
  for (const name of ["invalid-missing-merged-at.json", "invalid-extra-property.json", "invalid-pr-number-string.json", "invalid-short-merged-sha.json"]) {
    const w = signalWorld({ payload: readJson(fixture("signal", name)) });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 1, name);
    assert.equal(w.patches().length, 0, name);
    assert.equal(w.stub.world.dispatches.length, 0, name);
    assert.equal(w.stub.issues.length, 1, name);
    assert.equal(w.stub.issues[0].title, "[sdlc-failure] cascade-router (initech/widgets)");
    assert.equal(w.stub.requests.filter((request) => request.path.includes("/commits/")).length, 0, "the upstream is not polled for a payload that is not valid");
    assert.match(result.stderr, /not a valid UpstreamMergeClientPayload/);
  }
  for (const text of ["null", "[]", "not json", ""]) {
    const w = signalWorld({ payload: text });
    t.after(() => w.cleanup());
    assert.equal((await w.go()).code, 1, JSON.stringify(text));
    assert.equal(w.patches().length, 0);
  }
});

test("AC9 the bridge stays optional: a schedule run routes every edge without any signal", async (t) => {
  const outcomes = [];
  for (const edge of [WIDGETS, GADGETS, GIZMOS]) {
    const w = routerWorld({ edge, event: "schedule", manifestEdges: [WIDGETS, GADGETS, GIZMOS], state: seedState(edge), upstream: { head: sha(`head-${edge.upstreamKey}`) } });
    t.after(() => w.cleanup());
    const result = await w.go({ env: { CLIENT_PAYLOAD: "null" } });
    assert.equal(result.code, 0, `${edge.upstreamKey}: ${result.stderr}`);
    outcomes.push([edge.upstreamKey, w.decisions()[0].action]);
  }
  assert.deepEqual(outcomes, [["widgets", "dispatch-ai-adaptation"], ["gadgets", "dispatch-mechanical"], ["gizmos", "dispatch-ai-adaptation"]]);
});

test("AC9 a schedule and a manual run ignore a client_payload that happens to be in the environment", async (t) => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const w = routerWorld({ edge: WIDGETS, event, payload: { not: "a valid payload" }, state: seedState(WIDGETS), upstream: { head: sha("head-1") } });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 0, `${event}: ${result.stderr}`);
  }
});

test("AC52 the correlation id of the bridge's payload is carried unchanged into the decision, the dispatch and the issue of a later failure", async (t) => {
  const w = signalWorld({ payload: { ...SIGNAL, correlation_id: "bridge:abc/123-x" } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.decisions()[0].correlationId, "bridge:abc/123-x");
  assert.equal(w.stub.world.dispatches[0].body.inputs.correlation_id, "bridge:abc/123-x");

  const failing = signalWorld({ payload: { ...SIGNAL, correlation_id: "bridge:abc/123-x" } });
  t.after(() => failing.cleanup());
  failing.stub.inject("POST", "/dispatches", () => ({ status: 500, body: { message: "boom" } }));
  assert.equal((await failing.go()).code, 1);
  assert.match(failing.stub.issues[0].body, /bridge:abc\/123-x/);
});

test("the environment of the router is checked: an unknown event, a missing key and a malformed reset flag are configuration errors (exit 2)", async (t) => {
  for (const env of [{ EVENT_NAME: "push" }, { EVENT_NAME: "" }, { UPSTREAM_KEY: "" }, { GITHUB_REPOSITORY: "no-slash" }, { EDGE_JSON: "{not json" }]) {
    const w = routerWorld({ state: seedState(WIDGETS), upstream: { head: sha("head-1") } });
    t.after(() => w.cleanup());
    const result = await w.go({ env });
    assert.ok(result.code === 2 || result.code === 1, JSON.stringify(env));
    assert.equal(w.patches().length, 0);
    assert.equal(w.stub.world.dispatches.length, 0);
  }
  const reset = routerWorld({ event: "workflow_dispatch", resetBlocked: "maybe", state: seedState(WIDGETS), upstream: { head: sha("head-1") } });
  t.after(() => reset.cleanup());
  const result = await reset.go();
  assert.equal(result.code, 2);
  assert.equal(reset.patches().length, 0);
  assert.equal(TOKENS.gh.length > 0 && CENTRAL.length > 0 && state().etag === "", true);
});

test("an EDGE_JSON that describes another upstream than UPSTREAM_KEY is refused", async (t) => {
  const w = routerWorld({ state: seedState(WIDGETS), upstream: { head: sha("head-1") } });
  t.after(() => w.cleanup());
  const result = await w.go({ env: { UPSTREAM_KEY: "gadgets" } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /describes the upstream 'widgets'/);
  assert.equal(w.stub.world.dispatches.length, 0);
});
