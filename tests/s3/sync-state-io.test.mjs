// The state I/O of the poll-state script (SPEC-03 AC12): the variable is read and written only through GET and PATCH of
// /repos/{central}/actions/variables/{stateVariable} with the installation token, sends the name and value fields, refuses a value above 48 KB before any
// request, and is never created: a 404 is fatal, never a POST. Every case asserts the requests that were made and the value that is stored afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import { createRestClient } from "../../src/routing/rest.mjs";
import { writeSyncState } from "../../src/update-poll-state.mjs";
import { CENTRAL, state, TOKENS } from "./helpers/fixtures.mjs";
import { flagsFor, invoke, PR_HEAD, TARGET, world } from "./helpers/poll-state-world.mjs";

const writes = (stub) => stub.calls("PATCH");

test("AC12 a state variable that does not exist is a fatal error: no POST, no PATCH, nothing created", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  w.stub.variables.clear();
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not exist/);
  assert.equal(w.stub.calls("POST", "/actions/variables").length, 0);
  assert.equal(writes(w.stub).length, 0);
  assert.equal(w.stub.variables.size, 0, "the variable was not created");
});

test("AC12 the failure path does not create the variable either, and still reports the issue", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  w.stub.variables.clear();
  const result = await invoke(w, ["--record-failure", "--slug", w.edgeValue.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "wf"]);
  assert.equal(result.code, 1);
  assert.equal(w.stub.calls("POST", "/actions/variables").length, 0);
  assert.equal(w.stub.variables.size, 0);
  assert.equal(w.stub.issues.length, 1, "the operator still hears about the failure");
});

test("AC12 a PATCH that answers 404 is an error: the script never falls back to a POST", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  w.stub.inject("PATCH", "/actions/variables/", () => ({ status: 404, body: { message: "Not Found" } }));
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 1);
  assert.equal(w.stub.calls("POST", "/actions/variables").length, 0);
});

test("AC12 a malformed state is rejected before anything is written", async (t) => {
  const good = state();
  for (const [label, value] of [
    ["not JSON", "{broken"],
    ["thirteen fields", (() => { const { updatedAt, ...rest } = good; return rest; })()],
    ["fifteen fields", { ...good, extra: 1 }],
    ["a string run id", { ...good, inFlightRunId: "55", inFlightTargetSha: TARGET }],
    ["a negative counter", { ...good, failedAttempts: -1 }],
    ["a non-UTC timestamp", { ...good, updatedAt: "2026-11-07T12:00:00+02:00" }],
    ["a run id without its sha", { ...good, inFlightRunId: 5 }],
    ["a short sha", { ...good, lastMergedUpstreamSha: "abc" }],
  ]) {
    const w = world({ start: value });
    t.after(() => w.workspace.cleanup());
    const before = w.stub.variables.get(w.edgeValue.stateVariable);
    const result = await invoke(w, flagsFor(w.edgeValue));
    assert.equal(result.code, 1, `${label}: ${result.stderr}`);
    assert.equal(writes(w.stub).length, 0, label);
    assert.equal(w.stub.variables.get(w.edgeValue.stateVariable), before, label);
  }
});

test("AC12 a value above 48 KB is refused before any request: an oversized etag flag exits 2, and writeSyncState refuses an oversized state at the byte, with no PATCH sent", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const huge = await invoke(w, flagsFor(w.edgeValue, { "--etag": "x".repeat(49 * 1024) }));
  assert.equal(huge.code, 2);
  assert.equal(w.stub.requests.length, 0);

  const client = createRestClient({ baseUrl: "https://api.github.com", token: TOKENS.gh, fetch: w.stub.fetch, sleep: w.clock.sleep, now: w.clock.now });
  const overhead = Buffer.byteLength(JSON.stringify(state({ etag: "" })), "utf8");
  const exactly = state({ etag: "e".repeat(48 * 1024 - overhead) });
  assert.equal(Buffer.byteLength(JSON.stringify(exactly), "utf8"), 48 * 1024);
  await writeSyncState({ client, central: CENTRAL, name: w.edgeValue.stateVariable, state: exactly });
  assert.equal(writes(w.stub).length, 1, "a value of exactly 48 KB is within the limit");

  const before = w.stub.requests.length;
  await assert.rejects(writeSyncState({ client, central: CENTRAL, name: w.edgeValue.stateVariable, state: state({ etag: "e".repeat(48 * 1024 - overhead + 1) }) }), /48 KB/);
  assert.equal(w.stub.requests.length, before, "no request is sent for a value one byte above the limit");
});

test("AC12 the PATCH carries the name and value fields and is authenticated with GH_TOKEN, never the issues token", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  assert.equal((await invoke(w, flagsFor(w.edgeValue))).code, 0);
  const patch = w.stub.calls("PATCH")[0];
  assert.equal(patch.path, "/repos/acme/orchestrator/actions/variables/SDLC_SYNC_STATE_WIDGETS");
  const body = JSON.parse(patch.body);
  assert.deepEqual(Object.keys(body).sort(), ["name", "value"]);
  assert.equal(body.name, "SDLC_SYNC_STATE_WIDGETS");
  assert.equal(JSON.parse(body.value).openPrNumber, 7);
  assert.equal(patch.headers["x-github-api-version"], "2022-11-28");
  for (const request of w.stub.requests.filter((entry) => !entry.path.includes("/issues"))) {
    assert.equal(request.headers.authorization, `Bearer ${TOKENS.gh}`, `${request.method} ${request.path}`);
  }
});

test("AC12 only GET and PATCH ever touch the variable, in the success path and in the failure path, and the variable is only ever named by the edge", async (t) => {
  const success = world();
  const failure = world();
  t.after(() => {
    success.workspace.cleanup();
    failure.workspace.cleanup();
  });
  await invoke(success, flagsFor(success.edgeValue));
  await invoke(failure, ["--record-failure", "--slug", failure.edgeValue.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "wf"]);
  for (const w of [success, failure]) {
    const touching = w.stub.requests.filter((request) => request.path.includes("/actions/variables"));
    assert.ok(touching.length >= 2, "the variable is read and written");
    for (const request of touching) {
      assert.ok(["GET", "PATCH"].includes(request.method), `${request.method} ${request.path}`);
      assert.equal(request.path, `/repos/acme/orchestrator/actions/variables/${w.edgeValue.stateVariable}`);
    }
  }
  void PR_HEAD;
});
