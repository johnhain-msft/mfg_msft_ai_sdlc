// Delta-only QA for the AC14/AC22 fixes. REST runs use the existing in-process
// fake.fetch; capture checks use real throwaway git repositories and bash.
// workflow_id, not name/path, is the parent identity in the 2022-11-28 OpenAPI:
// descriptions/api.github.com/api.github.com.2022-11-28.json, read 2026-11-08,
// SHA-256 3c7150c62d87e34863d3e709bd4616524b59f88ec38c5a9068e24d282d6a5637.
import assert from "node:assert/strict";
import test from "node:test";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { fixture, mechanicalEdge, NOW_ISO, readText, sha } from "./helpers/fixtures.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import {
  actionsRun,
  createShowcaseWorld,
  NEWEST_RECORDED_RUN,
  RECORDED_RUNS,
  SHOWCASE_SCRIPT,
} from "./helpers/preflight-world.mjs";

const captured = (key) => RECORDED_RUNS.find((entry) => entry.key === key);
const runReads = (world) => world.w.stub.calls("GET", /\/actions\/runs\/\d+$/);
const listings = (world) => world.w.stub.calls("GET", /\/actions\/runs\?/);

function scriptWithRuns(entries) {
  const original = readText(fixture("showcase", "fetch-run-data.fixture.mjs"));
  const block = `const RUNS = [\n${entries.map(({ key, id }) => `  { key: ${JSON.stringify(key)}, id: ${id}, story: "Selected by the operator." },`).join("\n")}\n];`;
  const script = original.replace(/const RUNS = \[[\s\S]*?\n\];/, block);
  assert.notEqual(script, original);
  assert.equal(entries.length, RECORDED_RUNS.length, "still the eleven capture entries");
  return script;
}

function assertNoopSnapshot(world, result) {
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  const state = world.w.state();
  assert.equal(state.lastNoopHeadSha, world.upstreamHead);
  assert.equal(state.lastObservedHeadSha, world.upstreamHead);
  assert.equal(state.lastMergedUpstreamSha, world.edge.initialBaselineSha);
  assert.equal(state.inFlightRunId, null);
  assert.equal(state.inFlightTargetSha, null);
  assert.equal(world.w.patches().length, 1);
  assert.equal(world.w.decisions()[0].action, "noop-unchanged-snapshot");
  assert.equal(world.git.git(world.portfolioDir, ["status", "--porcelain"]), "");
  assert.deepEqual(world.leftoverClones(), []);
}

test("QA3 historical provenance refusal is side-effect-free on retry and recovers when the configured file is restored", async (t) => {
  const edge = mechanicalEdge({ initialBaselineSha: sha("qa3-bootstrap"), preflightCommands: [] });
  const first = sha("qa3-merged");
  const second = sha("qa3-next-target");
  const world = routerWorld({
    edge,
    state: initialSyncState(edge.initialBaselineSha, NOW_ISO),
    upstream: { head: first },
    downstream: { files: { [edge.provenanceFile]: JSON.stringify({ commit: first }) } },
  });
  t.after(() => world.cleanup());

  // Main's authoritative provenance can advance the seeded cursor without a
  // recorded open PR. That also ends the bootstrap fallback.
  const observed = await world.go();
  assert.equal(observed.code, 0, observed.stderr);
  assert.equal(world.state().lastMergedUpstreamSha, first);
  assert.notEqual(first, edge.initialBaselineSha);
  assert.equal(world.stub.world.dispatches.length, 0);
  const before = world.stub.variables.get(edge.stateVariable);
  const patches = world.patches().length;
  const decisions = world.decisions().length;

  world.stub.repo(edge.downstreamRepo, { head: sha("qa3-main-deleted"), files: {} });
  world.stub.repo(edge.upstreamRepo, { head: second, etag: 'W/"qa3-next"' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refused = await world.go();
    assert.equal(refused.code, 1, `${refused.stderr}\n${refused.stdout}`);
    assert.match(refused.stderr, /has moved off the seed/);
    assert.equal(world.stub.variables.get(edge.stateVariable), before);
    assert.equal(world.patches().length, patches);
    assert.equal(world.decisions().length, decisions);
    assert.equal(world.stub.world.dispatches.length, 0);
  }
  assert.equal(world.stub.issues.length, 1, "retry comments instead of duplicating the diagnostic issue");
  assert.equal(world.stub.world.comments.length, 1);

  world.stub.repo(edge.downstreamRepo, {
    head: sha("qa3-main-restored"),
    files: { [edge.provenanceFile]: JSON.stringify({ commit: first }) },
  });
  const repaired = await world.go();
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(world.stub.world.dispatches.length, 1);
  const inputs = world.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.previous_sha, first, "resume the cumulative merged cursor, never the seed or a failed observation");
  assert.equal(inputs.upstream_sha, second);
  assert.equal(world.state().inFlightTargetSha, second);
  assert.equal(world.state().lastMergedUpstreamSha, first);
  assert.equal(world.state().etag, JSON.parse(before).etag, "the dispatch still holds fresh poll observations in memory");
  assert.equal(world.state().lastObservedHeadSha, first);
  assert.equal(world.patches().length, patches + 1);
  assert.equal(world.decisions().length, decisions + 1);
});

test("QA3 parent workflow_id survives renamed and ref-qualified display metadata and rejects a lookalike workflow", async (t) => {
  // name can change and path can include a ref. Neither identifies the parent.
  const renamed = {
    ...actionsRun(captured("ci").id + 5, "completed", "ci"),
    name: "CI after an operator renamed the workflow",
    path: "initech/showcase/.github/workflows/renamed-ci.yml@trunk",
  };
  const newer = createShowcaseWorld({ runList: [renamed] });
  t.after(() => newer.cleanup());
  const dispatched = await newer.go();
  assert.equal(dispatched.code, 0, dispatched.stderr);
  assert.equal(newer.w.stub.world.dispatches.length, 1);
  assert.equal(newer.w.state().inFlightTargetSha, newer.upstreamHead);
  assert.equal(newer.w.state().lastNoopHeadSha, null);
  assert.equal(newer.w.stub.world.dispatches[0].body.inputs.sync_scope, "showcase-runs");

  const lookalike = {
    ...actionsRun(NEWEST_RECORDED_RUN + 20, "completed", "lint"),
    name: "ci",
    path: ".github/workflows/ci.yml",
  };
  const other = createShowcaseWorld({ runList: [lookalike] });
  t.after(() => other.cleanup());
  assertNoopSnapshot(other, await other.go());
});

test("QA3 workflow bars are independent of captured-entry order with the newest CD entry first", async (t) => {
  // An operator can reorder the story entries. The newest of the five CD
  // captures is still the bar even when an older CD entry is visited last.
  const entries = [...RECORDED_RUNS].sort((a, b) => b.id - a.id);
  const between = actionsRun(39600000000, "completed", "cd");
  assert.ok(between.id > captured("cd").id && between.id < captured("cd-queued").id);
  const world = createShowcaseWorld({ script: scriptWithRuns(entries), runList: [between] });
  t.after(() => world.cleanup());
  assertNoopSnapshot(world, await world.go());
  assert.deepEqual(runReads(world).map((request) => Number(request.path.split("/").at(-1))), entries.map(({ id }) => id));
});

test("QA3 repeated capture ids are resolved once without changing the snapshot or dispatching", async (t) => {
  // An operator can choose one run for two narrative keys; it is one REST run.
  const entries = RECORDED_RUNS.map((entry) => entry.key === "cd-initial" ? { ...entry, id: captured("cd").id } : entry);
  const world = createShowcaseWorld({ script: scriptWithRuns(entries) });
  t.after(() => world.cleanup());
  assertNoopSnapshot(world, await world.go());
  const expected = [...new Set(entries.map(({ id }) => id))];
  assert.equal(expected.length, 10);
  assert.deepEqual(runReads(world).map((request) => Number(request.path.split("/").at(-1))), expected);
  assert.equal(listings(world).length, 1);
  assert.equal(world.w.stub.fetch.state.maxInflight, 1);
  const readToken = world.w.stub.world.minted.find((entry) => entry.installation === "initech" && entry.permissions.actions === "read");
  assert.ok(readToken);
  for (const request of runReads(world)) assert.equal(request.headers.authorization, `Bearer ${readToken.token}`);
});

test("QA3 multiple new workflow runs produce one dispatch and a bounded three-example summary", async (t) => {
  const runs = ["ci", "codeql", "dependency-review", "cd"].map((key) => {
    const bar = key === "cd" ? captured("cd-queued") : captured(key);
    return actionsRun(bar.id + 5, "completed", key);
  });
  const world = createShowcaseWorld({ runList: runs });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.stub.world.dispatches.length, 1);
  assert.equal(world.w.state().inFlightTargetSha, world.upstreamHead);
  assert.equal(world.w.state().lastNoopHeadSha, null);
  assert.equal(world.w.state().lastMergedUpstreamSha, world.edge.initialBaselineSha);
  assert.equal(world.w.patches().length, 1);
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.sync_scope, "showcase-runs");
  assert.equal(Object.keys(inputs).length, 10);
  assert.ok(Object.values(inputs).every((value) => typeof value === "string"));
  const summary = result.stdout.split("\n").find((line) => line.includes("material change (snapshot:"));
  assert.ok(summary, result.stdout);
  assert.match(summary, /snapshot: 4 completed run\(s\)/);
  for (const run of runs.slice(0, 3)) assert.ok(summary.includes(`run ${run.id} of workflow ${run.workflow_id}`), summary);
  assert.equal(summary.includes(`run ${runs[3].id} of workflow ${runs[3].workflow_id}`), false);
  assert.match(summary, /, \.\.\./);
});

test("QA3 an exhausted rate-limit budget during recorded-run resolution refuses every subsequent routing operation", async (t) => {
  // A real App installation can exhaust its primary budget while the router
  // resolves the newly added per-run GETs, with reset beyond this job's timeout.
  const world = createShowcaseWorld();
  t.after(() => world.cleanup());
  const before = world.w.stub.variables.get(world.edge.stateVariable);
  const id = captured("codeql").id;
  const reset = String(Math.ceil((world.w.clock.now() + 31 * 60 * 1000) / 1000));
  world.w.stub.inject("GET", (requestPath) => requestPath.endsWith(`/actions/runs/${id}`), {
    status: 403,
    body: { message: "API rate limit exceeded" },
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset, "retry-after": "1" },
  });
  const result = await world.go({
    preflightDeps: {
      ensureCheckout: async () => assert.fail("must not prepare a checkout after failed run evidence"),
      isolatedClone: async () => assert.fail("must not capture after failed run evidence"),
    },
  });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /actions\/runs\/39781079636 is rate limited.*passes the budget/);
  assert.deepEqual(runReads(world).map((request) => Number(request.path.split("/").at(-1))), [captured("ci").id, id]);
  assert.equal(listings(world).length, 0);
  assert.equal(world.w.stub.calls("GET", `/contents/${SHOWCASE_SCRIPT}`).length, 1);
  assert.equal(world.w.stub.variables.get(world.edge.stateVariable), before);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.w.decisions().length, 0);
  assert.deepEqual(world.w.clock.waits, [], "no wait or retry earlier than primary reset to fit the shorter Retry-After");
  assert.equal(world.w.stub.issues.length, 1);
  assert.match(world.w.stub.issues[0].body, /actions\/runs\/39781079636/);
  assert.deepEqual(world.leftoverClones(), []);
});
