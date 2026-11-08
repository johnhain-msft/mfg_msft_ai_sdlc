// The deduplicated [sdlc-failure] issue (SPEC-03 AC51, AC7, AC39): one issue per exact title among the open issues of the orchestrator, read across all
// result pages, updated by comment when it exists, labelled sdlc-gate-failure, and only ever authenticated with the job's own token (ISSUES_TOKEN).
// The module is exercised directly, then through the two scripts that use it (the poll-state failure path and a router failure).
import assert from "node:assert/strict";
import test from "node:test";
import { composeFailureBody, composeFailureComment, failureTitle, FAILURE_LABEL, MAX_ISSUE_PAGES, upsertFailureIssue } from "../../src/routing/failure-issue.mjs";
import { createRestClient } from "../../src/routing/rest.mjs";
import { createClock } from "../s2/helpers/stub-server.mjs";
import { createGitHubStub } from "./helpers/github-stub.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { CENTRAL, mechanicalEdge, NOW, TOKENS } from "./helpers/fixtures.mjs";
import { invoke, TARGET, world } from "./helpers/poll-state-world.mjs";

const MECHANICAL_TITLE = "[sdlc-failure] cascade-mechanical-ghec-admin (johnhain-msft/portfolio)";

function direct({ pageSize = 100, open = [] } = {}) {
  const stub = createGitHubStub({ central: CENTRAL, acceptTokens: [TOKENS.issues], repos: {} });
  stub.world.issuePageSize = pageSize;
  open.forEach((issue, index) => stub.issues.push({ number: 500 + index, state: "open", body: "", labels: [], html_url: `https://github.com/${CENTRAL}/issues/${500 + index}`, ...issue }));
  const clock = createClock(NOW);
  const client = createRestClient({ baseUrl: "https://api.github.com", token: TOKENS.issues, fetch: stub.fetch, sleep: clock.sleep, now: clock.now });
  const upsert = (title, extra = {}) => upsertFailureIssue({ client, central: CENTRAL, title, body: composeFailureBody({ workflowId: "wf", subject: "s", correlationId: "c-1", reason: "because", nowIso: "2026-11-07T12:00:00.000Z" }), comment: composeFailureComment({ workflowId: "wf", subject: "s", correlationId: "c-1", reason: "again", nowIso: "2026-11-07T12:00:00.000Z" }), ...extra });
  return { stub, upsert };
}

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
