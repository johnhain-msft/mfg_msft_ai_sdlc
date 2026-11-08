// Failures of the router (SPEC-03 AC7, AC27, AC28, AC32, AC39): every one fails the job, writes nothing to the state and opens or updates the one deduplicated
// issue, and the waits for a rate limit follow the order of AC27 (the primary limit first) within the budget of the job. The clock is fake: a wait of a minute
// takes no time and shows in `clock.waits`.
import assert from "node:assert/strict";
import test from "node:test";
import { routerWorld } from "./helpers/harness.mjs";
import { edge as edgeFixture, seedState, sha, state, TOKENS } from "./helpers/fixtures.mjs";

const E = edgeFixture();
const HEAD = sha("head-1");
const SHA0 = sha("sha0");
const COMMITS = "/repos/initech/widgets/commits/trunk";

function world({ head = HEAD, stateOverrides = {}, ...rest } = {}) {
  return routerWorld({ state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, ...stateOverrides }), upstream: { head }, ...rest });
}

const epoch = (w, secondsFromNow) => String(Math.floor(w.clock.time / 1000) + secondsFromNow);
const limited = (status, headers) => () => ({ status, headers, body: { message: "API rate limit exceeded" } });

function assertFailedWithoutWrite(w, result, { issue = true } = {}) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(w.patches().length, 0, "zero PATCH requests to the state");
  assert.equal(w.stub.requests.filter((request) => request.path.includes("/actions/variables") && request.method !== "GET").length, 0);
  assert.equal(w.stub.calls("POST", "/actions/variables").length, 0);
  assert.deepEqual(w.state(), state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }), "the variable is as it was");
  assert.deepEqual(w.summaryLines(), [], "no decision is logged for a job that failed");
  if (issue) {
    assert.equal(w.stub.issues.length, 1, "one issue upsert");
    assert.match(w.stub.issues[0].title, /^\[sdlc-failure\] /);
  }
}

// ---- AC7 ---------------------------------------------------------------------------------------------------------------------------------

test("AC7 a 500 on the commits request fails the job, writes nothing and upserts one [sdlc-failure] issue", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 500, body: { message: "Server Error" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.equal(w.stub.issues[0].title, "[sdlc-failure] cascade-router (initech/widgets)");
  assert.deepEqual(w.stub.issues[0].labels, ["sdlc-gate-failure"]);
  assert.equal(w.stub.issues[0].authorization, `Bearer ${TOKENS.issues}`, "the issue is written with the token of the job");
  assert.match(w.stub.issues[0].body, /HTTP 500/);
  assert.match(w.stub.issues[0].body, /run-5001-1/);
  assert.equal(w.stub.world.dispatches.length, 0);
  assert.equal(w.stub.requests.filter((request) => request.path.includes("/commits/")).length, 1, "a 500 is not retried");
});

test("AC7 the same failure twice updates the one issue by comment instead of opening another", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 500, body: { message: "Server Error" } }));
  await w.go();
  await w.go();
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.world.comments.length, 1);
  assert.equal(w.stub.world.comments[0].issue, w.stub.issues[0].number);
  assert.equal(w.stub.world.comments[0].authorization, `Bearer ${TOKENS.issues}`);
});

test("AC7 a failing run never reaches the dispatch or the state, wherever it fails", async (t) => {
  for (const [needle, label] of [["/commits/", "poll"], ["/repos/acme/portal", "downstream"], [/\/pulls\?state=closed/, "closed pull requests"], ["/app/installations", "token"]]) {
    const w = world();
    t.after(() => w.cleanup());
    w.stub.inject("GET", needle, () => ({ status: 500, body: { message: "Server Error" } }));
    const result = await w.go();
    assertFailedWithoutWrite(w, result, { issue: true });
    assert.equal(w.stub.world.dispatches.length, 0, label);
  }
});

// ---- AC28 --------------------------------------------------------------------------------------------------------------------------------

test("AC28 missing-state-variable: a variable that does not exist fails the job; nothing is created, and the issue says so", async (t) => {
  const w = routerWorld({ state: null, upstream: { head: HEAD } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.equal(w.stub.calls("POST", "/actions/variables").length, 0);
  assert.equal(w.stub.calls("PATCH").length, 0);
  assert.equal(w.stub.variables.size, 0);
  assert.equal(w.stub.issues.length, 1);
  assert.match(w.stub.issues[0].body, /does not exist/);
  assert.equal(w.stub.world.dispatches.length, 0);
});

test("AC28 invalid-client-payload: an invalid payload fails the job without a write and upserts one issue", async (t) => {
  const w = routerWorld({ event: "repository_dispatch", payload: { upstream_repo: "initech/widgets" }, state: seedState(E), upstream: { head: HEAD } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.equal(w.patches().length, 0);
  assert.equal(w.stub.issues.length, 1);
});

test("AC28 a malformed state variable fails the job: every field that is not as specified, and nothing is written", async (t) => {
  for (const value of ["{broken", JSON.stringify({ etag: "" }), JSON.stringify({ ...seedState(E), failedAttempts: "0" })]) {
    const w = routerWorld({ state: value, upstream: { head: HEAD } });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 1, value);
    assert.equal(w.patches().length, 0);
    assert.equal(w.stub.world.dispatches.length, 0);
    assert.equal(w.stub.variables.get(E.stateVariable), value, "the malformed variable is left as it was");
    assert.equal(w.stub.issues.length, 1);
  }
});

// ---- AC27: the waits ---------------------------------------------------------------------------------------------------------------------

test("AC27 remaining-0-waits-until-reset: a primary rate limit waits until x-ratelimit-reset and the decision is logged with its headers", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(w, 90) }), { times: 1 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 1), [91000], "until the reset instant, plus the second of margin");
  assert.match(result.stdout, /rate limit: GET \/repos\/initech\/widgets\/commits\/trunk answered HTTP 403; x-ratelimit-remaining=0, x-ratelimit-reset=\d+, retry-after=-; waiting 91 s \(x-ratelimit-reset\)/);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(w.stub.calls("GET", COMMITS).length, 2);
});

test("AC27 the primary limit comes first: with both x-ratelimit-remaining 0 and retry-after, the router waits until the reset, not for retry-after", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(w, 30), "retry-after": "5" }), { times: 1 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 1), [31000]);
  assert.match(result.stdout, /retry-after=5; waiting 31 s \(x-ratelimit-reset\)/);
});

test("AC27 both bounds are kept: when retry-after is later than the reset, the router waits for retry-after, because the documentation forbids a retry before either", async (t) => {
  // REST API rate limits, 'Exceeding the rate limit': do not retry before x-ratelimit-reset when x-ratelimit-remaining is 0, and, if retry-after is present, not before that many seconds
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(w, 5), "retry-after": "120" }), { times: 1 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 1), [120000]);
  assert.match(result.stdout, /retry-after=120; waiting 120 s \(retry-after\)/);
});

test("AC32 a redirect is not followed, and the failure says where it points: the manifest names a repository that has moved", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 301, headers: { location: "https://api.github.com/repositories/4242/commits/trunk" }, body: { message: "Moved Permanently" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.match(result.stderr, /HTTP 301/);
  assert.match(result.stderr, /redirects to https:\/\/api\.github\.com\/repositories\/4242\/commits\/trunk/);
  assert.match(result.stderr, /not followed/);
  assert.equal(w.stub.calls("GET", COMMITS).length, 1, "the redirect was not requested");
  assert.match(w.stub.issues[0].body, /redirects to/);
});

test("AC27 retry-after-honoured: without a primary limit the wait is retry-after, in seconds or as an HTTP date", async (t) => {
  const seconds = world();
  const date = world();
  t.after(() => {
    seconds.cleanup();
    date.cleanup();
  });
  seconds.stub.inject("GET", COMMITS, limited(429, { "retry-after": "7" }), { times: 1 });
  await seconds.go();
  assert.deepEqual(seconds.clock.waits.slice(0, 1), [7000]);
  date.stub.inject("GET", COMMITS, limited(429, { "retry-after": new Date(date.clock.time + 12000).toUTCString() }), { times: 1 });
  await date.go();
  assert.deepEqual(date.clock.waits.slice(0, 1), [12000]);
  assert.match(seconds.clock.waits.length > 0 ? "ok" : "no wait", /ok/);
});

test("AC27 neither-header-waits-60s-then-backs-off: at least 60 seconds, doubled for every further attempt", async (t) => {
  const w = world({ stubOptions: { rateLimitHeaders: {} } });
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(429, {}), { times: 3 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 3), [60000, 120000, 240000]);
  assert.match(result.stdout, /x-ratelimit-remaining=-, x-ratelimit-reset=-, retry-after=-; waiting 60 s \(back-off\)/);
});

test("AC27 a secondary limit that still reports remaining points (and no retry-after) backs off from 60 seconds", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(403, { "x-ratelimit-remaining": "1200" }), { times: 1 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 1), [60000]);
  assert.match(result.stdout, /x-ratelimit-remaining=1200, x-ratelimit-reset=\d+, retry-after=-; waiting 60 s \(back-off\)/);
});

test("AC27 a 403 whose message names a rate limit is one, even without headers; a 403 that does not is a refusal and is not waited out", async (t) => {
  const secondary = world();
  const refusal = world();
  t.after(() => {
    secondary.cleanup();
    refusal.cleanup();
  });
  secondary.stub.inject("GET", COMMITS, () => ({ status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } }), { times: 1 });
  assert.equal((await secondary.go()).code, 0);
  assert.deepEqual(secondary.clock.waits.slice(0, 1), [60000]);
  refusal.stub.inject("GET", COMMITS, () => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
  assert.equal((await refusal.go()).code, 1);
  assert.deepEqual(refusal.clock.waits, []);
});

test("AC27 wait-beyond-timeout-fails-without-write: a wait that passes the budget of the job is not taken, the job fails, and nothing is written", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(w, 2 * 3600) }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.deepEqual(w.clock.waits, [], "the two hours are not slept");
  assert.match(result.stderr, /passes the budget of this run/);
  assert.match(result.stdout, /so it is not taken/);
  assert.match(w.stub.issues[0].body, /x-ratelimit-remaining=0, x-ratelimit-reset=\d+, retry-after=-/, "the issue records the evidence that was acted on");
});

test("AC27 the waits of a run never add up to more than the timeout of the router job (30 minutes, less the minutes kept for the issue)", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(429, { "retry-after": "400" }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  const total = w.clock.waits.reduce((sum, wait) => sum + wait, 0);
  assert.ok(total > 0 && total <= 27 * 60 * 1000, `waited ${total} ms`);
  assert.ok(w.clock.waits.length >= 2 && w.clock.waits.every((wait) => wait === 400000));
});

test("AC27 the retries of one request are bounded: a limit that never lifts ends in a failure, not a loop", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, limited(429, { "retry-after": "1" }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.equal(w.stub.calls("GET", COMMITS).length, 6, "the first attempt and five retries");
});

test("AC27 a transient 503 on a GET is repeated, a 500 and a failed POST are not", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 503, body: { message: "unavailable" } }), { times: 2 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(w.clock.waits.slice(0, 2), [1000, 2000]);
  const stuck = world();
  t.after(() => stuck.cleanup());
  stuck.stub.inject("GET", COMMITS, () => ({ status: 503, body: { message: "unavailable" } }));
  assertFailedWithoutWrite(stuck, await stuck.go());
  assert.equal(stuck.stub.calls("GET", COMMITS).length, 3, "the request and two repetitions");
});

test("AC27 a request that cannot be sent is repeated twice and then fails the job", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  let calls = 0;
  const realFetch = w.stub.fetch;
  const flaky = async (url, init) => {
    if (String(url).includes("/commits/trunk")) {
      calls += 1;
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    }
    return realFetch(url, init);
  };
  let stderr = "";
  const { run } = await import("../../src/route-upstream.mjs");
  const code = await run([], { env: w.env, fetch: flaky, now: w.clock.now, sleep: w.clock.sleep, stdout: () => {}, stderr: (text) => (stderr += text) });
  assert.equal(code, 1);
  assert.equal(calls, 3);
  assert.match(stderr, /could not be sent/);
  assert.equal(w.patches().length, 0);
  assert.equal(w.stub.issues.length, 1);
});

// ---- AC32: permissions -------------------------------------------------------------------------------------------------------------------

test("AC32 403-without-rate-limit-headers-records-permission-header: the status, the path and X-Accepted-GitHub-Permissions are recorded and nothing is assumed", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", "/repos/acme/portal/contents/", () => ({ status: 403, headers: { "x-accepted-github-permissions": "contents=read" }, body: { message: "Resource not accessible by integration" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.match(result.stderr, /GET \/repos\/acme\/portal\/contents\/docs\/widgets\/provenance\.json\?ref=[0-9a-f]{40} returned HTTP 403/);
  assert.match(result.stderr, /X-Accepted-GitHub-Permissions: contents=read/);
  const body = w.stub.issues[0].body;
  assert.match(body, /\| Status \| `403` \|/);
  assert.match(body, /\| Request \| `GET \/repos\/acme\/portal\/contents\//);
  assert.match(body, /\| X-Accepted-GitHub-Permissions \| `contents=read` \|/);
  assert.deepEqual(w.clock.waits, [], "a refusal is not waited out");
});

test("AC32 a 403 without the permission header is still a failure and still says what it saw", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", "/actions/variables/", () => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.match(result.stderr, /HTTP 403/);
  assert.equal(/X-Accepted-GitHub-Permissions/.test(result.stderr), false, "no header, so none is claimed");
});

test("AC32 401-is-also-a-failure: a 401 on a repository read fails the job and writes nothing", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 401, body: { message: "Bad credentials" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.match(result.stderr, /HTTP 401/);
  assert.match(w.stub.issues[0].body, /\| Status \| `401` \|/);
});

test("AC32 an installation that lacks a permission is a failure of the token exchange, with the answer of the API in it", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("POST", "/access_tokens", () => ({ status: 422, body: { message: "The permissions requested are not granted to this installation." } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.match(result.stderr, /permissions requested are not granted/);
});

test("AC32 an App that is not installed on the orchestrator's owner is a failure that names the owner", async (t) => {
  const w = routerWorld({ state: seedState(E), upstream: { head: HEAD }, installations: [{ id: 5, account: { login: "someone-else" } }] });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not installed on 'acme'/);
  assert.equal(w.patches().length, 0);
});

// ---- AC39: the dispatch is retried at most three times ------------------------------------------------------------------------------------------

const dispatchWorld = (options) => world(options);
const postCount = (w) => w.stub.calls("POST", "/dispatches").length;

test("AC39 dispatch-404-retries-then-fails: a 404 is attempted three times, a minute and two minutes apart, and nothing is recorded", async (t) => {
  const w = dispatchWorld();
  t.after(() => w.cleanup());
  w.stub.inject("POST", "/dispatches", () => ({ status: 404, body: { message: "Not Found" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.equal(postCount(w), 3);
  assert.deepEqual(w.clock.waits, [60000, 120000]);
  assert.equal(w.state().inFlightRunId, null);
  assert.match(result.stderr, /3 attempts/);
});

test("AC39 dispatch-422-retries-then-fails: a 422 is attempted three times and fails the job", async (t) => {
  const w = dispatchWorld();
  t.after(() => w.cleanup());
  w.stub.inject("POST", "/dispatches", () => ({ status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.equal(postCount(w), 3);
  assert.match(w.stub.issues[0].body, /workflow_dispatch/);
});

test("AC39 dispatch-429-honours-retry-after: the wait is retry-after, and the retry succeeds", async (t) => {
  const w = dispatchWorld({ stubOptions: { rateLimitHeaders: {} } });
  t.after(() => w.cleanup());
  w.stub.inject("POST", "/dispatches", limited(429, { "retry-after": "9" }), { times: 1 });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(postCount(w), 2);
  assert.deepEqual(w.clock.waits, [9000, 5000], "the retry-after wait, then the pacing wait after the dispatch");
  assert.match(result.stdout, /dispatch: .* answered HTTP 429; x-ratelimit-remaining=-, x-ratelimit-reset=-, retry-after=9; waiting 9 s \(retry-after\), attempt 2 of 3/);
  assert.equal(w.state().inFlightRunId, w.stub.world.dispatches.at(-1).runId);
});

test("AC39 a primary limit on the dispatch waits until the reset first, and a limit that never lifts stops at three attempts", async (t) => {
  const primary = dispatchWorld();
  t.after(() => primary.cleanup());
  primary.stub.inject("POST", "/dispatches", limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(primary, 20), "retry-after": "2" }), { times: 1 });
  assert.equal((await primary.go()).code, 0);
  assert.deepEqual(primary.clock.waits.slice(0, 1), [21000]);

  const stuck = dispatchWorld();
  t.after(() => stuck.cleanup());
  stuck.stub.inject("POST", "/dispatches", limited(429, { "retry-after": "1" }));
  assertFailedWithoutWrite(stuck, await stuck.go());
  assert.equal(postCount(stuck), 3, "at most three attempts per dispatch");
});

test("AC39 a refusal (403 without a limit), a 5xx and a 400 are not retried: one attempt, and a dispatch that may have started a run is never repeated", async (t) => {
  for (const status of [403, 500, 502, 400]) {
    const w = dispatchWorld();
    t.after(() => w.cleanup());
    w.stub.inject("POST", "/dispatches", () => ({ status, body: { message: "no" } }));
    assertFailedWithoutWrite(w, await w.go());
    assert.equal(postCount(w), 1, String(status));
  }
});

test("AC39 the wait before a retry also stays inside the budget of the job", async (t) => {
  const w = dispatchWorld();
  t.after(() => w.cleanup());
  w.stub.inject("POST", "/dispatches", limited(429, { "retry-after": String(40 * 60) }));
  const result = await w.go();
  assertFailedWithoutWrite(w, result);
  assert.equal(postCount(w), 1);
  assert.deepEqual(w.clock.waits, []);
});

test("AC39 a failure after the dispatch (the state write) names the run that was started, and records nothing but the failure", async (t) => {
  const w = dispatchWorld();
  t.after(() => w.cleanup());
  w.stub.inject("PATCH", "/actions/variables/", () => ({ status: 500, body: { message: "boom" } }));
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.equal(w.stub.world.dispatches.length, 1);
  assert.match(w.stub.issues[0].body, /Dispatched run/);
  assert.deepEqual(w.summaryLines(), []);
  assert.deepEqual(w.clock.waits, [], "no pacing wait after a failed run");
});

test("the failure report is written even when the issue list is long and the reporting fails closed when it cannot tell whether the issue exists", async (t) => {
  const w = world();
  t.after(() => w.cleanup());
  w.stub.inject("GET", COMMITS, () => ({ status: 500, body: { message: "Server Error" } }));
  w.stub.inject("GET", "/repos/acme/orchestrator/issues", () => ({ status: 500, body: { message: "boom" } }));
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.equal(w.stub.issues.length, 0, "no issue is opened when the list could not be read");
  assert.match(result.stderr, /the \[sdlc-failure\] issue could not be written/);
});
