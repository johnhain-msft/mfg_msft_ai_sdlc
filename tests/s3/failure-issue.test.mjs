// The deduplicated [sdlc-failure] issue (SPEC-03 AC51, AC7, AC39): one issue per exact title among the open issues of the orchestrator, read across all
// result pages, updated by comment when it exists, labelled sdlc-gate-failure, and only ever authenticated with the job's own token (ISSUES_TOKEN).
// The module is exercised directly, then through the two scripts that use it (the poll-state failure path and a router failure).
import assert from "node:assert/strict";
import test from "node:test";
import { closeFailureIssue, composeFailureBody, composeFailureComment, composeResolutionComment, failureTitle, FAILURE_LABEL, MAX_ISSUE_PAGES, upsertFailureIssue } from "../../src/routing/failure-issue.mjs";
import { createRestClient } from "../../src/routing/rest.mjs";
import { createClock } from "../s2/helpers/stub-server.mjs";
import { createGitHubStub, pullRequest } from "./helpers/github-stub.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { CENTRAL, edge, mechanicalEdge, NOW, state, TOKENS } from "./helpers/fixtures.mjs";
import { ETAG, flagsFor, invoke, PR_HEAD, TARGET, world } from "./helpers/poll-state-world.mjs";

const MECHANICAL_TITLE = "[sdlc-failure] cascade-mechanical-ghec-admin (johnhain-msft/portfolio)";

function direct({ pageSize = 100, open = [] } = {}) {
  const stub = createGitHubStub({ central: CENTRAL, acceptTokens: [TOKENS.issues], repos: {} });
  stub.world.issuePageSize = pageSize;
  open.forEach((issue, index) => stub.issues.push({ number: 500 + index, state: "open", body: "", labels: [], html_url: `https://github.com/${CENTRAL}/issues/${500 + index}`, ...issue }));
  const clock = createClock(NOW);
  const client = createRestClient({ baseUrl: "https://api.github.com", token: TOKENS.issues, fetch: stub.fetch, sleep: clock.sleep, now: clock.now });
  const upsert = (title, extra = {}) => upsertFailureIssue({ client, central: CENTRAL, title, body: composeFailureBody({ workflowId: "wf", subject: "s", correlationId: "c-1", reason: "because", nowIso: "2026-11-07T12:00:00.000Z" }), comment: composeFailureComment({ workflowId: "wf", subject: "s", correlationId: "c-1", reason: "again", nowIso: "2026-11-07T12:00:00.000Z" }), ...extra });
  return { stub, client, upsert };
}

const openFailure = (title, number = 41) => ({ title, number, state: "open", html_url: `https://github.com/${CENTRAL}/issues/${number}` });

test("AC51 creates-when-absent: no open issue has the title, so one is opened with the title, the label and the token of the job", async () => {
  const { stub, upsert } = direct({ open: [{ title: "[sdlc-failure] something else (acme/other)" }] });
  const result = await upsert(MECHANICAL_TITLE, { label: FAILURE_LABEL });
  assert.equal(result.action, "created");
  const posts = stub.calls("POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/repos/${CENTRAL}/issues`);
  const body = JSON.parse(posts[0].body);
  assert.equal(body.title, MECHANICAL_TITLE);
  assert.deepEqual(body.labels, ["sdlc-gate-failure"]);
  assert.match(body.body, /Correlation id \| `c-1`/);
  assert.equal(posts[0].headers.authorization, `Bearer ${TOKENS.issues}`);
});

test("AC51 updates-when-present: an open issue with the exact title is updated by a comment and no second issue is opened", async () => {
  const { stub, upsert } = direct({ open: [{ title: MECHANICAL_TITLE, number: 41 }] });
  const result = await upsert(MECHANICAL_TITLE);
  assert.equal(result.action, "commented");
  assert.equal(result.number, 41);
  assert.equal(stub.calls("POST").length, 1);
  assert.equal(stub.calls("POST")[0].path, `/repos/${CENTRAL}/issues/41/comments`);
  assert.equal(stub.world.comments.length, 1);
  assert.equal(stub.issues.length, 1, "no second issue");
  assert.match(stub.world.comments[0].body, /Another failure was recorded/);
});

test("AC51 only an exact title of an open issue is a duplicate: a prefix, a different suffix, a closed issue and a pull request with that title are not", async () => {
  const { stub, upsert } = direct({
    open: [
      { title: `${MECHANICAL_TITLE} ` },
      { title: MECHANICAL_TITLE.replace("portfolio", "portfolio2") },
      { title: MECHANICAL_TITLE.toUpperCase() },
      { title: MECHANICAL_TITLE, state: "closed", number: 90 },
      { title: MECHANICAL_TITLE, pull_request: { url: "https://api.github.com/repos/acme/orchestrator/pulls/9" }, number: 91 },
    ],
  });
  const result = await upsert(MECHANICAL_TITLE);
  assert.equal(result.action, "created", "none of them is the issue");
  assert.equal(stub.world.comments.length, 0);
});

test("AC51 pages-through-open-issues: the issue on the last page is found, and the listing is read to its end", async () => {
  const open = Array.from({ length: 7 }, (_, index) => ({ title: index === 6 ? MECHANICAL_TITLE : `[sdlc-failure] other ${index} (acme/x)`, number: 100 + index }));
  const { stub, upsert } = direct({ pageSize: 2, open });
  const result = await upsert(MECHANICAL_TITLE);
  assert.equal(result.action, "commented");
  assert.equal(result.number, 106);
  assert.equal(stub.calls("GET", "/issues?").length, 4, "ceil(7 / 2) pages were read");
  assert.equal(stub.calls("POST").length, 1);
  assert.equal(stub.world.comments.length, 1);
});

test("AC51 an incomplete listing fails closed: with more open issues than are read and no match among them, no issue is opened", async () => {
  const open = Array.from({ length: MAX_ISSUE_PAGES + 5 }, (_, index) => ({ title: `[sdlc-failure] other ${index} (acme/x)`, number: 1000 + index }));
  const { stub, upsert } = direct({ pageSize: 1, open });
  await assert.rejects(upsert(MECHANICAL_TITLE), /no issue is opened/);
  assert.equal(stub.calls("POST").length, 0, "nothing was opened that could duplicate an issue further down the list");
  assert.equal(stub.calls("GET", "/issues?").length, MAX_ISSUE_PAGES);
});

test("AC51 an error of the API while listing is an error, never an empty list: no issue is opened", async () => {
  const { stub, upsert } = direct();
  stub.inject("GET", "/issues", () => ({ status: 500, body: { message: "Server Error" } }));
  await assert.rejects(upsert(MECHANICAL_TITLE), /500/);
  assert.equal(stub.calls("POST").length, 0);
});

test("AC51 the title is [sdlc-failure] <workflow-id> (<subject>), and the label is sdlc-gate-failure", () => {
  assert.equal(failureTitle("cascade-mechanical-ghec-admin", "johnhain-msft/portfolio"), MECHANICAL_TITLE);
  assert.equal(failureTitle("cascade-router", "ms-mfg-community/day-in-the-life-copilot-lab"), "[sdlc-failure] cascade-router (ms-mfg-community/day-in-the-life-copilot-lab)");
  assert.equal(FAILURE_LABEL, "sdlc-gate-failure");
});

test("AC51 an untrusted reason cannot break out of the body: backticks and control characters are neutralised", () => {
  const body = composeFailureBody({ workflowId: "wf", subject: "s", correlationId: "c", reason: "```\n@everyone\u0007 <script>", nowIso: "2026-11-07T12:00:00.000Z" });
  assert.equal(body.includes("```"), false);
  assert.equal(body.includes("\u0007"), false);
  const row = body.split("\n").find((line) => line.startsWith("| Reason |"));
  assert.ok(row.endsWith("` |"), row);
  assert.equal(row.slice("| Reason | `".length, -"` |".length).includes("`"), false, "the reason holds no backtick that could close the code span");
});

test("AC51 mechanical-title-and-label: the failure path of the poll-state script opens the issue that the spec names, labelled sdlc-gate-failure, with the token of the job", async (t) => {
  const edgeValue = mechanicalEdge({ downstreamRepo: "johnhain-msft/portfolio", upstreamSlug: "GH_ADMIN_MSFT", stateVariable: "SDLC_SYNC_STATE_GH_ADMIN_MSFT" });
  const w = world({ edgeValue });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, ["--record-failure", "--slug", "GH_ADMIN_MSFT", "--target-sha", TARGET, "--workflow-id", "cascade-mechanical-ghec-admin"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].title, MECHANICAL_TITLE);
  assert.deepEqual(w.stub.issues[0].labels, ["sdlc-gate-failure"]);
  assert.equal(w.stub.issues[0].authorization, `Bearer ${TOKENS.issues}`);
  // a second failure of the same cascade updates that issue instead of opening another
  const again = await invoke(w, ["--record-failure", "--slug", "GH_ADMIN_MSFT", "--target-sha", TARGET, "--workflow-id", "cascade-mechanical-ghec-admin"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(w.stub.issues.length, 1, "never duplicated");
  assert.equal(w.stub.world.comments.length, 1);
});

test("AC51 router-title: a router failure opens [sdlc-failure] cascade-router (<upstreamRepo>) with the token of the job and nothing else", async (t) => {
  const w = routerWorld();
  t.after(() => w.cleanup());
  w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
  const result = await w.go();
  assert.equal(result.code, 1);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].title, `[sdlc-failure] cascade-router (${w.edge.upstreamRepo})`);
  assert.deepEqual(w.stub.issues[0].labels, ["sdlc-gate-failure"]);
  assert.equal(w.stub.issues[0].authorization, `Bearer ${TOKENS.issues}`);
  const second = await w.go();
  assert.equal(second.code, 1);
  assert.equal(w.stub.issues.length, 1, "the second failure comments on the first issue");
  assert.equal(w.stub.world.comments.length, 1);
  assert.equal(w.stub.world.comments[0].authorization, `Bearer ${TOKENS.issues}`);
});

test("AC51 closeFailureIssue: closes an open issue with the exact title after posting a resolution comment, and does nothing when none is open", async () => {
  const { stub } = direct({
    open: [
      { title: MECHANICAL_TITLE, number: 41 },
      { title: "[sdlc-failure] other (acme/other)", number: 42 },
    ],
  });
  const clock = createClock(NOW);
  const client = createRestClient({ baseUrl: "https://api.github.com", token: TOKENS.issues, fetch: stub.fetch, sleep: clock.sleep, now: clock.now });
  const comment = composeResolutionComment({
    workflowId: "cascade-mechanical-ghec-admin",
    subject: "johnhain-msft/portfolio",
    correlationId: "c-2",
    targetSha: TARGET,
    reason: "resolved: pr-opened",
    nowIso: "2026-11-07T13:00:00.000Z",
  });
  const closed = await closeFailureIssue({ client, central: CENTRAL, title: MECHANICAL_TITLE, comment });
  assert.equal(closed.action, "closed");
  assert.equal(closed.number, 41);
  assert.equal(stub.issues[0].state, "closed");
  assert.equal(stub.issues[0].state_reason, "completed");
  assert.equal(stub.issues[0].closedAuthorization, `Bearer ${TOKENS.issues}`);
  assert.equal(stub.issues[1].state, "open", "other open issues are untouched");
  assert.equal(stub.world.comments.length, 1);
  assert.match(stub.world.comments[0].body, /closed automatically because a subsequent run succeeded/);
  assert.equal(stub.world.comments[0].authorization, `Bearer ${TOKENS.issues}`);
  for (const value of ["cascade-mechanical-ghec-admin", "johnhain-msft/portfolio", "c-2", TARGET, "resolved: pr-opened", "2026-11-07T13:00:00.000Z"]) {
    assert.ok(stub.world.comments[0].body.includes(value), `${value} remains in the resolution evidence`);
  }

  const again = await closeFailureIssue({ client, central: CENTRAL, title: MECHANICAL_TITLE, comment });
  assert.equal(again.action, "none");
  assert.equal(stub.world.comments.length, 1, "an already-closed issue is not commented on again");
});

test("AC51 poll-state recovery: a successful finalize_poll_state run automatically comments on and closes an open [sdlc-failure] issue for that workflow and downstream", async (t) => {
  const edgeValue = mechanicalEdge({ edgeId: "ghec-admin", downstreamRepo: "johnhain-msft/portfolio", upstreamSlug: "GH_ADMIN_MSFT", stateVariable: "SDLC_SYNC_STATE_GH_ADMIN_MSFT" });
  const w = world({
    edgeValue,
    pulls: [pullRequest({ number: 12, headSha: PR_HEAD, headRef: edgeValue.branchName })],
    files: { [PR_HEAD]: { [edgeValue.provenanceFile]: JSON.stringify({ commit: TARGET }) } },
  });
  t.after(() => w.workspace.cleanup());
  const failed = await invoke(w, ["--record-failure", "--slug", "GH_ADMIN_MSFT", "--target-sha", TARGET, "--workflow-id", "cascade-mechanical-ghec-admin"]);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].state, "open");

  const recovered = await invoke(w, flagsFor(edgeValue));
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(w.stub.issues[0].state, "closed");
  assert.equal(w.stub.issues[0].state_reason, "completed");
  assert.equal(w.stub.issues[0].closedAuthorization, `Bearer ${TOKENS.issues}`);
  assert.equal(w.stub.world.comments.length, 1);
  assert.match(w.stub.world.comments[0].body, /closed automatically because a subsequent run succeeded/);
});

test("AC51 poll-state noop-no-changes and router noop-blocked-sha do not close an open [sdlc-failure] issue", async (t) => {
  const edgeValue = mechanicalEdge({ edgeId: "ghec-admin", downstreamRepo: "johnhain-msft/portfolio", upstreamSlug: "GH_ADMIN_MSFT", stateVariable: "SDLC_SYNC_STATE_GH_ADMIN_MSFT" });
  const w = world({ edgeValue });
  t.after(() => w.workspace.cleanup());
  assert.equal((await invoke(w, ["--record-failure", "--slug", "GH_ADMIN_MSFT", "--target-sha", TARGET, "--workflow-id", "cascade-mechanical-ghec-admin"])).code, 0);
  assert.equal(w.stub.issues[0].state, "open");

  const noopFlags = flagsFor(edgeValue, { "--head-sha": flagsFor(edgeValue)[flagsFor(edgeValue).indexOf("--base-sha") + 1] });
  assert.equal((await invoke(w, noopFlags)).code, 0);
  assert.equal(w.stub.issues[0].state, "open", "noop-no-changes does not close an open cascade failure issue");

  const rw = routerWorld();
  t.after(() => rw.cleanup());
  rw.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }), { times: 1 });
  assert.equal((await rw.go()).code, 1);
  assert.equal(rw.stub.issues[0].state, "open");
  const current = rw.state();
  rw.stub.setVariable(rw.edge.stateVariable, {
    ...current,
    failedTargetSha: rw.upstreamHead,
    failedAttempts: 2,
    blockedTargetSha: rw.upstreamHead,
    portfolioMainSha: rw.downstreamHead,
  });
  assert.equal((await rw.go()).code, 0);
  assert.equal(rw.decisions().at(-1).action, "noop-blocked-sha");
  assert.equal(rw.stub.issues[0].state, "open", "noop-blocked-sha does not close an open router failure issue");
});

test("AC51 router recovery: a successful router run automatically comments on and closes an open [sdlc-failure] cascade-router (<upstreamRepo>) issue", async (t) => {
  const w = routerWorld();
  t.after(() => w.cleanup());
  w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }), { times: 1 });
  const failed = await w.go();
  assert.equal(failed.code, 1);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].state, "open");

  const recovered = await w.go();
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(w.stub.issues[0].state, "closed");
  assert.equal(w.stub.issues[0].state_reason, "completed");
  assert.equal(w.stub.issues[0].closedAuthorization, `Bearer ${TOKENS.issues}`);
  assert.equal(w.stub.world.comments.length, 1);
  assert.match(w.stub.world.comments[0].body, /closed automatically because a subsequent run succeeded/);
});

test("AC51 QA closeFailureIssue: pagination finds only the exact open issue, never a near match, closed issue or pull request, and comments before closing", async () => {
  const { stub, client } = direct({
    pageSize: 2,
    open: [
      { title: `${MECHANICAL_TITLE} `, number: 31 },
      { title: MECHANICAL_TITLE.toUpperCase(), number: 32 },
      { title: MECHANICAL_TITLE.replace("portfolio", "other"), number: 33 },
      { title: MECHANICAL_TITLE, number: 34, state: "closed" },
      { title: MECHANICAL_TITLE, number: 35, pull_request: { url: `https://api.github.com/repos/${CENTRAL}/pulls/35` } },
      { title: MECHANICAL_TITLE, number: 41 },
    ],
  });
  const result = await closeFailureIssue({ client, central: CENTRAL, title: MECHANICAL_TITLE, comment: "Recovered with verified provenance." });
  assert.equal(result.number, 41);
  assert.equal(stub.calls("GET", "/issues?").length, 3, "the exact issue is on the last page");
  assert.deepEqual(stub.issues.filter((issue) => issue.closedAuthorization).map((issue) => issue.number), [41]);
  assert.equal(stub.issues.find((issue) => issue.number === 35).state, "open", "a pull request is never closed through the issues API");
  assert.deepEqual(stub.world.comments.map((comment) => [comment.issue, comment.body]), [[41, "Recovered with verified provenance."]]);
  assert.deepEqual(stub.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`), [
    `POST /repos/${CENTRAL}/issues/41/comments`,
    `PATCH /repos/${CENTRAL}/issues/41`,
  ]);
  assert.ok(stub.requests.every((request) => request.headers.authorization === `Bearer ${TOKENS.issues}`));
});

test("AC51 QA closeFailureIssue: listing, comment and close API failures propagate without falsely closing the issue", async () => {
  for (const [method, requestPath, status, comments] of [
    ["GET", "/issues", 500, 0],
    ["POST", "/issues/41/comments", 403, 0],
    ["PATCH", "/issues/41", 403, 1],
  ]) {
    const { stub, client } = direct({ open: [{ title: MECHANICAL_TITLE, number: 41 }] });
    stub.inject(method, requestPath, { status, body: { message: status === 500 ? "Server Error" : "Resource not accessible by integration" } });
    await assert.rejects(
      closeFailureIssue({ client, central: CENTRAL, title: MECHANICAL_TITLE, comment: "Recovered." }),
      new RegExp(String(status)),
      `${method} ${requestPath}`,
    );
    assert.equal(stub.issues[0].state, "open");
    assert.equal(stub.world.comments.length, comments);
    assert.equal(stub.calls("PATCH", "/issues/41").length, method === "PATCH" ? 1 : 0, "a failed listing or resolution comment must prevent closing");
  }
});

test("AC51 QA poll-state recovery: an AI pr-updated run closes its issue even when sync state is already current, and replay is idempotent", async (t) => {
  const edgeValue = edge();
  const title = failureTitle("cascade-ai-widgets-to-portal", edgeValue.downstreamRepo);
  const start = state({ etag: ETAG, lastObservedHeadSha: TARGET, openPrNumber: 7, openPrTargetSha: TARGET }, edgeValue);
  const w = world({
    edgeValue,
    start,
    stubOptions: { issues: [openFailure(title), openFailure(MECHANICAL_TITLE, 42)] },
  });
  t.after(() => w.workspace.cleanup());
  const recovered = await invoke(w, flagsFor(edgeValue), { env: { CORRELATION_ID: "routed-correlation", GITHUB_SERVER_URL: "https://github.example.com/" } });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).outcome, "pr-updated");
  assert.deepEqual(w.stub.variable(edgeValue.stateVariable), start);
  assert.equal(w.stub.calls("PATCH", "/actions/variables/").length, 0, "closing is independent of whether the sync state needed a write");
  assert.equal(w.stub.issues[0].state, "closed");
  assert.equal(w.stub.issues[0].state_reason, "completed");
  assert.equal(w.stub.issues[1].state, "open", "another workflow's failure is not this workflow's recovery");
  assert.equal(w.stub.world.comments.length, 1);
  for (const value of ["resolved (pr-updated)", "routed-correlation", TARGET, `https://github.example.com/${CENTRAL}/actions/runs/77`]) {
    assert.ok(w.stub.world.comments[0].body.includes(value), value);
  }
  const replay = await invoke(w, flagsFor(edgeValue));
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(w.stub.world.comments.length, 1, "a closed failure never receives duplicate recovery comments");
});

test("AC51 QA router recovery: terminal and preflight noops close only this upstream's issue without dispatching", async (t) => {
  for (const kind of ["terminal", "preflight"]) {
    const w = routerWorld({ edge: edge({ preflightCommands: kind === "preflight" ? ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- labs'] : [] }) });
    t.after(() => w.cleanup());
    const title = failureTitle("cascade-router", w.edge.upstreamRepo);
    w.stub.issues.push(openFailure(title), openFailure("[sdlc-failure] cascade-router (other/upstream)", 42));
    if (kind === "terminal") w.stub.setVariable(w.edge.stateVariable, { ...w.state(), lastNoopHeadSha: w.upstreamHead });
    const result = await w.go({
      preflightDeps: {
        ensureCheckout: async () => {},
        execute: async () => ({ code: 0, error: null, timedOut: false, stdout: "", stderr: "" }),
      },
    });
    assert.equal(result.code, 0, result.stderr);
    const action = kind === "terminal" ? "noop-304" : "noop-no-material-drift";
    assert.equal(w.decisions().at(-1).action, action);
    assert.equal(w.state().lastObservedHeadSha, w.upstreamHead);
    assert.equal(w.state().lastNoopHeadSha, w.upstreamHead);
    assert.equal(w.stub.world.dispatches.length, 0);
    assert.equal(w.stub.issues[0].state, "closed", `${kind}: a successful noop resolves the router's failure`);
    assert.equal(w.stub.issues[1].state, "open");
    assert.equal(w.stub.world.comments.length, 1);
    assert.ok(w.stub.world.comments[0].body.includes(`resolved (${action})`));
  }
});

test("AC51 QA recovery: unavailable issue APIs or missing issues credentials never undo successful routing or finalization", async (t) => {
  for (const problem of ["forbidden", "missing-token", "invalid-token"]) {
    const issueEnv = problem === "missing-token" ? { ISSUES_TOKEN: "" } : problem === "invalid-token" ? { ISSUES_TOKEN: "ghp_operatorPATnotAnInstallationToken" } : {};
    const router = routerWorld({ env: issueEnv });
    t.after(() => router.cleanup());
    router.stub.issues.push(openFailure(failureTitle("cascade-router", router.edge.upstreamRepo)));
    if (problem === "forbidden") router.stub.inject("GET", "/issues", { status: 403, body: { message: "Resource not accessible by integration" } });
    const routed = await router.go();
    assert.equal(routed.code, 0, `${problem}: ${routed.stderr}`);
    assert.equal(router.stub.world.dispatches.length, 1);
    assert.equal(router.state().inFlightRunId, router.stub.world.dispatches[0].runId);
    assert.equal(router.state().inFlightTargetSha, router.upstreamHead);
    assert.equal(router.stub.issues[0].state, "open");
    assert.equal(router.stub.calls("PATCH", "/issues/").length, 0);
    assert.equal(router.stub.calls("GET", "/issues").length, problem === "forbidden" ? 1 : 0);

    const poll = world();
    t.after(() => poll.workspace.cleanup());
    poll.stub.issues.push(openFailure(failureTitle("cascade-ai-widgets-to-portal", poll.edgeValue.downstreamRepo)));
    if (problem === "forbidden") poll.stub.inject("GET", "/issues", { status: 403, body: { message: "Resource not accessible by integration" } });
    const finalized = await invoke(poll, flagsFor(poll.edgeValue), { env: issueEnv });
    assert.equal(finalized.code, 0, `${problem}: ${finalized.stderr}`);
    assert.equal(poll.stub.variable(poll.edgeValue.stateVariable).openPrNumber, 7);
    assert.equal(poll.stub.variable(poll.edgeValue.stateVariable).openPrTargetSha, TARGET);
    assert.equal(poll.stub.issues[0].state, "open");
    assert.equal(poll.stub.calls("PATCH", "/issues/").length, 0);
    assert.equal(poll.stub.calls("GET", "/issues").length, problem === "forbidden" ? 1 : 0);
  }
});

test("AC51 QA recovery: a failed sync-state write must not close a failure issue even after dispatch or PR verification", async (t) => {
  const router = routerWorld();
  t.after(() => router.cleanup());
  const beforeRouter = router.state();
  router.stub.issues.push(openFailure(failureTitle("cascade-router", router.edge.upstreamRepo)));
  router.stub.inject("PATCH", "/actions/variables/", { status: 403, body: { message: "Resource not accessible by integration" } });
  const routed = await router.go();
  assert.equal(routed.code, 1, routed.stderr);
  assert.equal(router.stub.world.dispatches.length, 1, "the dispatch happened, but its state write did not");
  assert.deepEqual(router.state(), beforeRouter);
  assert.equal(router.stub.issues[0].state, "open");
  assert.equal(router.stub.calls("PATCH", "/issues/").length, 0);
  assert.equal(router.stub.world.comments.length, 1, "the issue records another failure, not a recovery");

  const poll = world();
  t.after(() => poll.workspace.cleanup());
  const beforePoll = poll.stub.variable(poll.edgeValue.stateVariable);
  poll.stub.issues.push(openFailure(failureTitle("cascade-ai-widgets-to-portal", poll.edgeValue.downstreamRepo)));
  poll.stub.inject("PATCH", "/actions/variables/", { status: 403, body: { message: "Resource not accessible by integration" } });
  const finalized = await invoke(poll, flagsFor(poll.edgeValue));
  assert.equal(finalized.code, 1, finalized.stderr);
  assert.deepEqual(poll.stub.variable(poll.edgeValue.stateVariable), beforePoll);
  assert.equal(poll.stub.issues[0].state, "open");
  assert.equal(poll.stub.calls("PATCH", "/issues/").length, 0);
  assert.equal(poll.stub.world.comments.length, 1);
});
