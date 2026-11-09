// Which credential authorizes which request (SPEC-03 AC30). The router has the App's key and signs for installation tokens: the dispatch, the state variable
// and the run status use the write token, every read of the upstream and the downstream uses a read token, the App endpoints use the signed JWT, and the
// token of the job (ISSUES_TOKEN) authorizes the failure issue and nothing else. The poll-state script has the installation token in GH_TOKEN and the same
// split. The token that a workflow calls GITHUB_TOKEN is never used for anything but that issue, and is never read under that name.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createGitHubStub, pullRequest } from "./helpers/github-stub.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, edge, sha, state, TOKENS } from "./helpers/fixtures.mjs";
import { flagsFor, invoke, TARGET, world as pollWorld } from "./helpers/poll-state-world.mjs";

const ROUTER = abs("src", "route-upstream.mjs");
const POLL = abs("src", "update-poll-state.mjs");
const WORKFLOW_TOKEN = `ghs_workflowtoken${"w".repeat(24)}`;
const bearerOf = (request) => (request.headers.authorization ?? "").replace(/^Bearer /, "");
const isIssueRequest = (request) => /\/repos\/[^/]+\/[^/]+\/issues(\/|$|\?)/.test(request.path);
const isAppRequest = (request) => request.path.startsWith("/app/");
const minted = (w) => w.stub.world.minted;
const writeTokens = (w) => minted(w).filter((entry) => entry.permissions?.variables === "write").map((entry) => entry.token);
const readTokens = (w) => minted(w).filter((entry) => entry.permissions && entry.permissions.variables === undefined).map((entry) => entry.token);

function routerWithOpenPullRequest() {
  const e = edge();
  const openPrTargetSha = sha("open-target");
  const w = routerWorld({
    edge: e,
    state: state({ openPrNumber: 4, openPrTargetSha }, e),
    downstream: { pulls: { 4: pullRequest({ number: 4, headSha: sha("pr-head"), headRef: e.branchName }) } },
    env: { GITHUB_TOKEN: WORKFLOW_TOKEN },
  });
  return w;
}

test("AC30 every request of the router carries the credential that its kind needs: the JWT for the App, the write token for the orchestrator, a read token for the upstream and the downstream", async (t) => {
  const w = routerWithOpenPullRequest();
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(w.stub.world.dispatches.length, 1, "the run reached the dispatch");
  const writes = writeTokens(w);
  const reads = readTokens(w);
  assert.equal(writes.length, 1);
  assert.ok(reads.length >= 1);
  const central = "/repos/acme/orchestrator/";
  for (const request of w.stub.requests) {
    const bearer = bearerOf(request);
    const label = `${request.method} ${request.path}`;
    assert.notEqual(bearer, WORKFLOW_TOKEN, `${label}: GITHUB_TOKEN is never read`);
    if (isIssueRequest(request)) {
      assert.equal(bearer, TOKENS.issues, `${label}: the token of the job authorizes the issue`);
      continue;
    }
    assert.notEqual(bearer, TOKENS.issues, `${label}: the token of the job authorizes nothing but the issue`);
    if (isAppRequest(request)) {
      assert.equal(bearer.split(".").length, 3, `${label}: the App endpoints take the signed JWT`);
    } else if (request.path === "/repos/acme/orchestrator" || request.path.startsWith(central)) {
      assert.ok(writes.includes(bearer), `${label}: the orchestrator is written and read with the write token`);
    } else {
      assert.ok(reads.includes(bearer), `${label}: the repositories of others are read with a read token`);
      assert.equal(writes.includes(bearer), false, `${label}: the write token never leaves the orchestrator`);
    }
  }
  // the three kinds that the spec names are all among the requests
  const dispatch = w.stub.calls("POST", "/dispatches")[0];
  assert.ok(writes.includes(bearerOf(dispatch)), "the dispatch");
  assert.ok(writes.includes(bearerOf(w.stub.calls("GET", "/actions/variables/")[0])), "the variable GET");
  assert.ok(writes.includes(bearerOf(w.stub.calls("PATCH", "/actions/variables/")[0])), "the variable PATCH");
  const pull = w.stub.calls("GET", "/pulls/4")[0];
  assert.ok(pull, "the open pull request was read");
  assert.ok(reads.includes(bearerOf(pull)), "the pull request read");
});

test("AC30 the issue upsert alone carries the token of the job, in the router", async (t) => {
  const w = routerWorld({ env: { GITHUB_TOKEN: WORKFLOW_TOKEN } });
  t.after(() => w.cleanup());
  w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
  const result = await w.go();
  assert.equal(result.code, 1);
  const issueRequests = w.stub.requests.filter(isIssueRequest);
  assert.ok(issueRequests.length >= 2, "the issues were listed and one was opened");
  for (const request of issueRequests) assert.equal(bearerOf(request), TOKENS.issues, `${request.method} ${request.path}`);
  for (const request of w.stub.requests.filter((entry) => !isIssueRequest(entry))) {
    assert.notEqual(bearerOf(request), TOKENS.issues, `${request.method} ${request.path}`);
    assert.notEqual(bearerOf(request), WORKFLOW_TOKEN, `${request.method} ${request.path}`);
  }
});

test("AC30 the poll-state script authorizes the pull-request, provenance and variable requests with GH_TOKEN and the issue with ISSUES_TOKEN, never the other way round", async (t) => {
  const w = pollWorld();
  t.after(() => w.workspace.cleanup());
  const ok = await invoke(w, flagsFor(w.edgeValue), { env: { GITHUB_TOKEN: WORKFLOW_TOKEN } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(w.stub.calls("GET", "/pulls").length >= 1 && w.stub.calls("GET", "/contents/").length >= 1 && w.stub.calls("PATCH", "/actions/variables/").length === 1);
  for (const request of w.stub.requests) {
    const issue = isIssueRequest(request);
    assert.equal(bearerOf(request), issue ? TOKENS.issues : TOKENS.gh, `${request.method} ${request.path}`);
  }

  // a verification that fails opens the issue: only that request carries the token of the job
  const failing = pollWorld({ pulls: [] });
  t.after(() => failing.workspace.cleanup());
  const bad = await invoke(failing, flagsFor(failing.edgeValue), { env: { GITHUB_TOKEN: WORKFLOW_TOKEN } });
  assert.equal(bad.code, 1);
  assert.ok(failing.stub.issues.length === 1);
  for (const request of failing.stub.requests) {
    const issue = isIssueRequest(request);
    assert.equal(bearerOf(request), issue ? TOKENS.issues : TOKENS.gh, `${request.method} ${request.path}`);
    assert.notEqual(bearerOf(request), WORKFLOW_TOKEN);
  }
});

test("AC30 the token of the job is never read under the name GITHUB_TOKEN, and the issues token is not used when it is missing: the failure is reported, no other token takes its place", async (t) => {
  const w = pollWorld({ pulls: [] });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue), { env: { GITHUB_TOKEN: WORKFLOW_TOKEN }, omitEnv: ["ISSUES_TOKEN"] });
  assert.equal(result.code, 1);
  assert.equal(w.stub.issues.length, 0, "no issue without ISSUES_TOKEN");
  assert.match(result.stderr, /no \[sdlc-failure\] issue was opened|is not set/);
  for (const request of w.stub.requests) assert.notEqual(bearerOf(request), WORKFLOW_TOKEN);

  const router = routerWorld({ env: { ISSUES_TOKEN: undefined, GITHUB_TOKEN: WORKFLOW_TOKEN } });
  t.after(() => router.cleanup());
  router.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
  const failed = await router.go();
  assert.equal(failed.code, 1);
  assert.equal(router.stub.requests.filter(isIssueRequest).length, 0, "no issue request is made without ISSUES_TOKEN");
  assert.match(failed.stderr, /no \[sdlc-failure\] issue was opened/);
  for (const request of router.stub.requests) assert.notEqual(bearerOf(request), WORKFLOW_TOKEN);
});

test("AC30 rg GITHUB_TOKEN finds nothing in the two scripts, and ISSUES_TOKEN is on exactly one line of each, at the issue upsert", () => {
  for (const file of [ROUTER, POLL]) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    assert.deepEqual(lines.filter((line) => line.includes("GITHUB_TOKEN")), [], `${file} never names the workflow's token`);
    const hits = lines.map((line, index) => [line, index]).filter(([line]) => line.includes("ISSUES_TOKEN"));
    assert.equal(hits.length, 1, `${file}: ${hits.map(([line]) => line.trim()).join(" | ")}`);
    const [, at] = hits[0];
    const around = lines.slice(Math.max(0, at - 6), at + 40).join("\n");
    assert.match(around, /upsertFailureIssue|reportFailureIssue/, `${file}: the one use of ISSUES_TOKEN is the issue upsert`);
  }
});

test("AC30 a dispatch is confirmed by a numeric workflow_run_id in the response, and nothing is recorded as in flight without one", async (t) => {
  const w = routerWorld();
  t.after(() => w.cleanup());
  w.stub.world.dispatchReplies.push({ status: 204, headers: {}, body: "" });
  w.stub.world.dispatchReplies.push({ status: 204, headers: {}, body: "" });
  w.stub.world.dispatchReplies.push({ status: 204, headers: {}, body: "" });
  const result = await w.go();
  assert.equal(result.code, 1, "a 204 does not say that a run started");
  assert.equal(w.state().inFlightRunId, null);
  assert.equal(w.patches().length, 0);
  void createGitHubStub;
});
