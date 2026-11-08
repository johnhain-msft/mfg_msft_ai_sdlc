// The conditional poll of the upstream (SPEC-03 AC11, AC16, AC26): If-None-Match with the stored ETag on both requests, serial requests, the ETag of the
// commit response, a direct commit routed like a merged pull request, 200 and 304 handling, and a 304 that is never read as "nothing to do" by itself.
import assert from "node:assert/strict";
import test from "node:test";
import { pullRequest } from "./helpers/github-stub.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { state, sha, edge as edgeFixture } from "./helpers/fixtures.mjs";

const E = edgeFixture();
const SHA0 = sha("sha0");
const SHA1 = sha("sha1");
const ETAG = 'W/"upstream-etag-1"';
const MAIN = sha("main-1");

function world({ head = SHA1, stateOverrides = {}, upstream = {}, downstream = {}, ...rest } = {}) {
  const start = state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, portfolioMainSha: MAIN, ...stateOverrides });
  return routerWorld({ state: start, upstream: { head, ...upstream }, downstream, ...rest });
}

const COMMITS = "/repos/initech/widgets/commits/trunk";
const PULLS = "/repos/initech/widgets/pulls?state=closed&base=trunk&per_page=30";

test("AC11 both poll requests carry If-None-Match equal to the stored etag, and neither does when the stored etag is empty", async (t) => {
  const stored = world({ stateOverrides: { etag: 'W/"stored-etag"' } });
  const fresh = world({ stateOverrides: { etag: "" } });
  t.after(() => {
    stored.cleanup();
    fresh.cleanup();
  });
  await stored.go();
  await fresh.go();
  for (const request of [stored.stub.calls("GET", COMMITS)[0], stored.stub.calls("GET", PULLS)[0]]) assert.equal(request.headers["if-none-match"], 'W/"stored-etag"', request.pathAndSearch);
  for (const request of [fresh.stub.calls("GET", COMMITS)[0], fresh.stub.calls("GET", PULLS)[0]]) {
    assert.ok(request, "the request is made");
    assert.equal("if-none-match" in request.headers, false, `${request.pathAndSearch} carries no If-None-Match on the first poll`);
  }
});

test("AC11 the requests are the commit of the default branch and the closed pull requests against it, 30 at a time", async (t) => {
  const w = world({});
  t.after(() => w.cleanup());
  await w.go();
  const polls = w.stub.requests.filter((request) => request.path.startsWith("/repos/initech/widgets")).map((request) => `${request.method} ${request.pathAndSearch}`);
  assert.deepEqual(polls, [`GET ${COMMITS}`, `GET ${PULLS}`], "serial: the commit first, then the pull requests");
});

test("AC11 requests inside one job are issued serially: no two overlap in time", async (t) => {
  const w = world({ stubOptions: { delayMs: 3 } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.fetch.state.maxInflight, 1);
  assert.ok(w.stub.requests.length > 8, "a full routed run");
});

test("AC11 the persisted etag is the ETag header of the commits request, not of the pull-request list", async (t) => {
  const w = world({ head: SHA1, stateOverrides: { dismissedTargetSha: SHA1 }, upstream: { etag: 'W/"from-commits"', pullsEtag: 'W/"from-pulls"' } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.decisions()[0].action, "noop-dismissed-pr");
  assert.equal(w.state().etag, 'W/"from-commits"');
});

test("AC11 direct-commit-routes-like-merged-pr: a head without any merged pull request is dispatched like one, with an empty upstream_pr_number", async (t) => {
  const direct = world({ head: SHA1, upstream: { closedPulls: [] } });
  const merged = world({ head: SHA1, upstream: { closedPulls: [pullRequest({ number: 31, state: "closed", merged: true, mergeCommitSha: SHA1 }), pullRequest({ number: 30, state: "closed", merged: true, mergeCommitSha: sha("older") })] } });
  t.after(() => {
    direct.cleanup();
    merged.cleanup();
  });
  await direct.go();
  await merged.go();
  assert.equal(direct.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(merged.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(direct.stub.world.dispatches[0].body.inputs.upstream_pr_number, "");
  assert.equal(merged.stub.world.dispatches[0].body.inputs.upstream_pr_number, "31", "the merged pull request whose merge commit is the target");
  assert.deepEqual({ ...direct.stub.world.dispatches[0].body.inputs, upstream_pr_number: "", correlation_id: "x" }, { ...merged.stub.world.dispatches[0].body.inputs, upstream_pr_number: "", correlation_id: "x" }, "otherwise identical");
});

test("AC11 a closed pull request that was not merged, or that merged another commit, does not give the number", async (t) => {
  const w = world({ head: SHA1, upstream: { closedPulls: [pullRequest({ number: 8, state: "closed", merged: false, mergeCommitSha: SHA1 }), pullRequest({ number: 9, state: "closed", merged: true, mergeCommitSha: sha("else") })] } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_pr_number, "");
});

test("AC16 200-new-head: the target is the sha of the response, and the response etag is held in memory", async (t) => {
  const w = world({ head: SHA1 });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.decisions()[0].targetSha, SHA1);
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_sha, SHA1);
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_etag, ETAG);
  assert.equal(w.state().etag, "", "held in memory, not persisted, until the cascade run finalizes");
});

test("AC16 304-uses-last-observed-head: the target of a 304 is lastObservedHeadSha", async (t) => {
  const w = world({ head: sha("moved-on-after"), stateOverrides: { etag: ETAG, lastObservedHeadSha: SHA1 }, upstream: { etag: ETAG } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.stub.calls("GET", COMMITS)[0].headers["if-none-match"], ETAG);
  assert.equal(w.decisions()[0].targetSha, SHA1, "the stub answered 304, so the head in its body is not read");
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_etag, ETAG, "the stored etag is the held one");
});

test("AC16 304-still-compares-terminal-states: a 304 is never nothing to do by itself: the open pull request is reconciled and the failure state is compared", async (t) => {
  const merged = world({
    head: sha("ignored"),
    stateOverrides: { etag: ETAG, lastObservedHeadSha: SHA1, openPrNumber: 5, openPrTargetSha: SHA1 },
    upstream: { etag: ETAG },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: true }) } },
  });
  t.after(() => merged.cleanup());
  await merged.go();
  assert.equal(merged.decisions()[0].action, "noop-304");
  assert.equal(merged.state().lastMergedUpstreamSha, SHA1, "the merge was reconciled although the poll answered 304");
  assert.equal(merged.state().openPrNumber, null);
  assert.equal(merged.patches().length, 1);

  const blocked = world({
    head: sha("ignored"),
    stateOverrides: { etag: ETAG, lastObservedHeadSha: SHA1, failedTargetSha: SHA1, failedAttempts: 2, blockedTargetSha: SHA1 },
    upstream: { etag: ETAG },
  });
  t.after(() => blocked.cleanup());
  await blocked.go();
  assert.equal(blocked.decisions()[0].action, "noop-blocked-sha");

  const retry = world({ head: sha("ignored"), stateOverrides: { etag: ETAG, lastObservedHeadSha: SHA1 }, upstream: { etag: ETAG } });
  t.after(() => retry.cleanup());
  await retry.go();
  assert.equal(retry.decisions()[0].action, "dispatch-ai-adaptation", "a 304 whose observed head was never routed is routed now");
});

test("AC16 a 304 on the pull-request list leaves the pull-request number unknown, and a 304 on a request that carried no If-None-Match is an error", async (t) => {
  const w = world({ head: SHA1, stateOverrides: { etag: 'W/"x"' }, upstream: { etag: 'W/"new"', pullsEtag: 'W/"x"' } });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_pr_number, "");

  const bad = world({ head: SHA1 });
  t.after(() => bad.cleanup());
  bad.stub.inject("GET", COMMITS, () => ({ status: 304, body: "" }));
  const result = await bad.go();
  assert.equal(result.code, 1);
  assert.equal(bad.patches().length, 0);
});

test("AC26 confirmed-noop-304: exit 0, no write request at all, and the conditional request carries an Authorization header", async (t) => {
  const w = world({ head: SHA0, stateOverrides: { etag: ETAG, lastObservedHeadSha: SHA0 }, upstream: { etag: ETAG } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.decisions()[0].action, "noop-304");
  assert.equal(w.patches().length, 0);
  const writes = w.stub.requests.filter((request) => request.method !== "GET" && !request.path.startsWith("/app/"));
  assert.deepEqual(writes, [], "no write request");
  const conditional = w.stub.calls("GET", COMMITS)[0];
  assert.equal(conditional.headers["if-none-match"], ETAG);
  assert.match(conditional.headers.authorization, /^Bearer ghs_/);
});

test("the poll names no branch that the edge does not: the default branch comes from the edge and a name with a slash keeps it", async (t) => {
  const slashed = edgeFixture({ upstreamDefaultBranch: "release/2.x" });
  const w = routerWorld({ edge: slashed, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, slashed), upstream: { head: SHA1, defaultBranch: "release/2.x" } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(w.stub.calls("GET", "/repos/initech/widgets/commits/release/2.x").length === 1);
  assert.ok(w.stub.calls("GET", "/repos/initech/widgets/pulls?state=closed&base=release/2.x&per_page=30").length === 1);
});
