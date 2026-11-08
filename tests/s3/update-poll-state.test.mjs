// The poll-state script, run in process against the local stub (SPEC-03 AC46-AC51, AC59, AC60, AC68): the seven-flag success path, the failure path
// and the verification that sits between them. Every case asserts what was persisted (the variable, the requests that were made, the issues) and
// what was refused afterwards, not only the exit code.
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../src/update-poll-state.mjs";
import { createGitHubStub, pullRequest } from "./helpers/github-stub.mjs";
import { CENTRAL, createWorkspace, edge, mechanicalEdge, NOW_ISO, sha, state, TOKENS } from "./helpers/fixtures.mjs";
import { BASE, ETAG, flagsFor, HEAD, invoke, PR_HEAD, TARGET, world } from "./helpers/poll-state-world.mjs";
import { createClock } from "../s2/helpers/stub-server.mjs";

const writes = (stub) => stub.calls("PATCH");
const stateOf = (w) => w.stub.variable(w.edgeValue.stateVariable);
const unchangedExceptUpdatedAt = (before, after, allowed) => {
  for (const key of Object.keys(before)) {
    if (key === "updatedAt" || allowed.includes(key)) continue;
    assert.deepEqual(after[key], before[key], `${key} must not change`);
  }
};

test("AC46 all-seven-flags-accepted: a verified pull request is recorded and the exit code is 0", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 0, result.stderr);
  const after = stateOf(w);
  assert.equal(after.openPrNumber, 7);
  assert.equal(after.openPrTargetSha, TARGET);
  assert.equal(after.etag, ETAG);
});

test("AC46 each-missing-flag-exits-2-without-request: every one of the seven flags is required", async (t) => {
  for (const name of ["--slug", "--branch", "--provenance-file", "--base-sha", "--head-sha", "--target-sha", "--etag"]) {
    const w = world();
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, flagsFor(w.edgeValue, { [name]: undefined }));
    assert.equal(result.code, 2, `${name}: ${result.stderr}`);
    assert.equal(w.stub.requests.length, 0, `${name}: no request is made`);
    assert.match(result.stderr, new RegExp(name.slice(2)));
    assert.deepEqual(stateOf(w), state(), `${name}: the variable is untouched`);
  }
});

test("AC46 unknown-slug-exits-2: a slug that no dependencyEdges entry names makes no request", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue, { "--slug": "NOT_AN_EDGE" }));
  assert.equal(result.code, 2);
  assert.equal(w.stub.requests.length, 0);
  assert.match(result.stderr, /NOT_AN_EDGE/);
});

test("AC46 a slug that names two entries is ambiguous and makes no request", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const twin = createWorkspace({ edges: [w.edgeValue, { ...w.edgeValue, edgeId: "twin", upstreamKey: "twin" }] });
  t.after(() => twin.cleanup());
  const result = await invoke({ ...w, workspace: twin }, flagsFor(w.edgeValue));
  assert.equal(result.code, 2);
  assert.equal(w.stub.requests.length, 0);
});

test("AC46 a flag that is not one of the specified flags, or a malformed value, exits 2 without a request", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  for (const argv of [
    [...flagsFor(w.edgeValue), "--manifest", "other.yaml"],
    flagsFor(w.edgeValue, { "--head-sha": "ABC" }),
    flagsFor(w.edgeValue, { "--target-sha": TARGET.slice(1) }),
    flagsFor(w.edgeValue, { "--base-sha": `${BASE.slice(0, 39)}g` }),
    flagsFor(w.edgeValue, { "--slug": "lower" }),
    flagsFor(w.edgeValue, { "--branch": "a b" }),
    flagsFor(w.edgeValue, { "--provenance-file": "../escape.json" }),
    ["--record-failure", "--slug", w.edgeValue.upstreamSlug, "--target-sha", "nope", "--workflow-id", "wf"],
  ]) {
    const result = await invoke(w, argv);
    assert.equal(result.code, 2, `${argv.join(" ")}: ${result.stderr}`);
  }
  assert.equal(w.stub.requests.length, 0);
});

test("AC46 the environment is checked before any request: no installation token, a user token and no repository exit 2", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  for (const env of [{ GH_TOKEN: "" }, { GH_TOKEN: "ghu_usertokenfixture" }, { GH_TOKEN: "ghp_personaltoken" }, { GITHUB_REPOSITORY: "" }, { GITHUB_REPOSITORY: "no-slash" }]) {
    const result = await invoke(w, flagsFor(w.edgeValue), { env });
    assert.equal(result.code, 2, JSON.stringify(env));
  }
  assert.equal(w.stub.requests.length, 0);
});

test("AC47 no-changes: head equals base records the target as a no-op, makes no pull-request request and prints noop-no-changes", async (t) => {
  const start = state({ inFlightRunId: 55, inFlightTargetSha: TARGET, failedTargetSha: TARGET, failedAttempts: 1, portfolioMainSha: sha("main"), openPrNumber: 3, openPrTargetSha: sha("older") });
  const w = world({ start });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue, { "--head-sha": BASE }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { outcome: "noop-no-changes" });
  assert.equal(w.stub.calls("GET", "/pulls").length, 0, "no pull-request request");
  assert.equal(w.stub.calls("GET", "/contents/").length, 0);
  const after = stateOf(w);
  assert.deepEqual(after, {
    ...start,
    etag: ETAG,
    lastObservedHeadSha: TARGET,
    lastNoopHeadSha: TARGET,
    inFlightRunId: null,
    inFlightTargetSha: null,
    failedTargetSha: null,
    failedAttempts: 0,
    updatedAt: NOW_ISO,
  });
  unchangedExceptUpdatedAt(start, after, ["etag", "lastObservedHeadSha", "lastNoopHeadSha", "inFlightRunId", "inFlightTargetSha", "failedTargetSha", "failedAttempts"]);
  assert.equal(after.lastMergedUpstreamSha, start.lastMergedUpstreamSha, "lastMergedUpstreamSha is never advanced by a no-op");
  assert.equal(after.openPrNumber, 3, "the open pull request pointers are left as they were");
  assert.equal(writes(w.stub).length, 1);
});

test("AC48 matching-open-pr-writes-open-pr-pointers: the pull request of the branch whose provenance records the target is recorded", async (t) => {
  const start = state({ inFlightRunId: 55, inFlightTargetSha: TARGET, failedTargetSha: TARGET, failedAttempts: 1 });
  const w = world({ start });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 0, result.stderr);
  const list = w.stub.calls("GET", "/pulls");
  assert.equal(list.length, 1);
  assert.equal(list[0].pathAndSearch, "/repos/acme/portal/pulls?state=open&head=acme:sdlc/cascade-widgets");
  const contents = w.stub.calls("GET", "/contents/");
  assert.equal(contents.length, 1);
  assert.equal(contents[0].pathAndSearch, `/repos/acme/portal/contents/docs/widgets/provenance.json?ref=${PR_HEAD}`);
  const after = stateOf(w);
  assert.deepEqual(after, {
    ...start,
    etag: ETAG,
    lastObservedHeadSha: TARGET,
    openPrTargetSha: TARGET,
    openPrNumber: 7,
    inFlightRunId: null,
    inFlightTargetSha: null,
    failedTargetSha: null,
    failedAttempts: 0,
    updatedAt: NOW_ISO,
  });
  assert.equal(after.lastMergedUpstreamSha, start.lastMergedUpstreamSha, "the merge cursor only moves when the pull request is merged");
  assert.equal(after.lastNoopHeadSha, start.lastNoopHeadSha);
});

async function assertVerificationFailure(w, label, { before = state() } = {}) {
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 1, `${label}: ${result.stderr}`);
  const after = stateOf(w);
  for (const cursor of ["etag", "lastObservedHeadSha", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha", "openPrNumber"]) {
    assert.deepEqual(after[cursor], before[cursor], `${label}: ${cursor} is not advanced`);
  }
  assert.equal(after.failedTargetSha, TARGET, label);
  assert.equal(after.failedAttempts, before.failedTargetSha === TARGET ? before.failedAttempts + 1 : 1, `${label}: the failure transition is applied exactly once`);
  assert.equal(after.inFlightRunId, null);
  assert.equal(after.inFlightTargetSha, null);
  assert.equal(writes(w.stub).length, 1, `${label}: one PATCH`);
  assert.equal(w.stub.issues.length, 1, `${label}: one issue is opened`);
  assert.equal(w.stub.issues[0].title, "[sdlc-failure] cascade-ai-widgets-to-portal (acme/portal)");
  assert.equal(w.stub.issues[0].authorization, `Bearer ${TOKENS.issues}`);
  return { result, after };
}

test("AC48 stale-provenance-commit-exits-1: an open pull request whose provenance records another commit is a verification failure", async (t) => {
  const w = world({ files: { [PR_HEAD]: { "docs/widgets/provenance.json": JSON.stringify({ commit: sha("stale") }) } } });
  t.after(() => w.workspace.cleanup());
  const { result } = await assertVerificationFailure(w, "stale");
  assert.match(result.stderr, /not [0-9a-f]{40}/);
});

test("AC48 no-open-pr-exits-1: an absent pull request is a verification failure and never an issue fallback of the workflow", async (t) => {
  const w = world({ pulls: [] });
  t.after(() => w.workspace.cleanup());
  await assertVerificationFailure(w, "no pull request");
  assert.equal(w.stub.calls("GET", "/contents/").length, 0);
});

test("AC48 contents-404-exits-1: a provenance file that does not exist at the head of the pull request is a verification failure", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  w.stub.repo("acme/portal").filesAtRef = {};
  await assertVerificationFailure(w, "contents 404");
});

test("AC48 a provenance file that is not JSON, or whose pointer holds no commit, is a verification failure", async (t) => {
  for (const text of ["not json {", JSON.stringify({ other: 1 }), JSON.stringify({ commit: "abc" }), JSON.stringify({ commit: 12 })]) {
    const w = world({ files: { [PR_HEAD]: { "docs/widgets/provenance.json": text } } });
    t.after(() => w.workspace.cleanup());
    await assertVerificationFailure(w, text);
  }
});

test("AC48 the JSON pointer of the edge selects the commit, including a nested and an escaped key", async (t) => {
  for (const [pointer, text] of [
    ["/_provenance/commit", JSON.stringify({ _provenance: { commit: TARGET } })],
    ["/a~1b/c~0d", JSON.stringify({ "a/b": { "c~d": TARGET } })],
  ]) {
    const e = edge({ provenanceJsonPointer: pointer });
    const w = world({ edgeValue: e, files: { [PR_HEAD]: { [e.provenanceFile]: text } } });
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, flagsFor(e));
    assert.equal(result.code, 0, `${pointer}: ${result.stderr}`);
  }
});

test("AC48 the pull request that matches is found among several: the first one that records the target, and a second one that does not is not recorded", async (t) => {
  const other = sha("other-head");
  const w = world({
    pulls: [pullRequest({ number: 4, headSha: other }), pullRequest({ number: 9, headSha: PR_HEAD })],
    files: { [other]: { "docs/widgets/provenance.json": JSON.stringify({ commit: sha("old") }) } },
  });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stateOf(w).openPrNumber, 9);
});

test("AC49 no-matching-pr-increments-failed-attempts-exactly-once: one success-path run without a matching pull request moves the counter once, opens one issue and exits 1", async (t) => {
  const w = world({ pulls: [] });
  t.after(() => w.workspace.cleanup());
  const first = await assertVerificationFailure(w, "first");
  assert.equal(first.after.failedAttempts, 1);
  assert.equal(first.after.blockedTargetSha, null);
  assert.equal(w.stub.calls("PATCH").length, 1);
  assert.equal(w.stub.requests.filter((request) => /--record-failure/.test(request.body ?? "")).length, 0, "the success path records no --record-failure invocation");
});

test("AC49 table record-failure-transitions: (null, 0) becomes (X, 1) unblocked, (X, 1) becomes (X, 2) blocked at X, (Y, 1) with target X becomes (X, 1)", async (t) => {
  const X = TARGET;
  const Y = sha("other-target");
  const rows = [
    { name: "first failure", before: state(), after: { failedTargetSha: X, failedAttempts: 1, blockedTargetSha: null } },
    { name: "second failure on the same target blocks it", before: state({ failedTargetSha: X, failedAttempts: 1 }), after: { failedTargetSha: X, failedAttempts: 2, blockedTargetSha: X } },
    { name: "a failure on another target starts again", before: state({ failedTargetSha: Y, failedAttempts: 1 }), after: { failedTargetSha: X, failedAttempts: 1, blockedTargetSha: null } },
    { name: "a failure on another target after a block starts again", before: state({ failedTargetSha: Y, failedAttempts: 2, blockedTargetSha: Y }), after: { failedTargetSha: X, failedAttempts: 1, blockedTargetSha: Y } },
    { name: "a third failure keeps the block", before: state({ failedTargetSha: X, failedAttempts: 2, blockedTargetSha: X }), after: { failedTargetSha: X, failedAttempts: 3, blockedTargetSha: X } },
  ];
  for (const row of rows) {
    const before = { ...row.before, inFlightRunId: 31, inFlightTargetSha: X, etag: 'W/"keep"', lastObservedHeadSha: sha("seen"), lastMergedUpstreamSha: sha("merged"), lastNoopHeadSha: sha("noop"), openPrTargetSha: sha("open"), openPrNumber: 12 };
    const w = world({ start: before });
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, ["--record-failure", "--slug", w.edgeValue.upstreamSlug, "--target-sha", X, "--workflow-id", "cascade-ai-widgets-to-portal"]);
    assert.equal(result.code, 0, `${row.name}: ${result.stderr}`);
    const after = stateOf(w);
    assert.equal(after.failedTargetSha, row.after.failedTargetSha, row.name);
    assert.equal(after.failedAttempts, row.after.failedAttempts, row.name);
    assert.equal(after.blockedTargetSha, row.after.blockedTargetSha, row.name);
    assert.equal(after.inFlightRunId, null, `${row.name}: the in-flight pair is cleared`);
    assert.equal(after.inFlightTargetSha, null);
    for (const cursor of ["etag", "lastObservedHeadSha", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha", "openPrNumber"]) {
      assert.deepEqual(after[cursor], before[cursor], `${row.name}: ${cursor} is untouched`);
    }
    assert.equal(w.stub.calls("GET", "/pulls").length, 0, "the failure path looks at no pull request");
    assert.equal(w.stub.issues.length, 1, `${row.name}: one issue`);
  }
});

test("AC49 --record-failure ignores the success flags when they are also passed, and needs only slug, target and workflow id", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, ["--record-failure", ...flagsFor(w.edgeValue), "--workflow-id", "cascade-ai-widgets-to-portal"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stateOf(w).failedAttempts, 1);
  for (const missing of ["--slug", "--target-sha", "--workflow-id"]) {
    const base = { "--slug": w.edgeValue.upstreamSlug, "--target-sha": TARGET, "--workflow-id": "wf" };
    delete base[missing];
    const bad = await invoke(w, ["--record-failure", ...Object.entries(base).flat()]);
    assert.equal(bad.code, 2, missing);
  }
});

test("AC49 the issue of the failure path names the workflow and the downstream repository, carries the correlation id of the run when the dispatch gave none (tests/s3/correlation-id.test.mjs: the id of the dispatch when it did) and is opened once", async (t) => {
  const w = world({ edgeValue: mechanicalEdge() });
  t.after(() => w.workspace.cleanup());
  const argv = ["--record-failure", "--slug", "GADGETS", "--target-sha", TARGET, "--workflow-id", "cascade-mechanical-gadgets-to-portal"];
  assert.equal((await invoke(w, argv)).code, 0);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].title, "[sdlc-failure] cascade-mechanical-gadgets-to-portal (acme/portal)");
  assert.deepEqual(w.stub.issues[0].labels, ["sdlc-gate-failure"]);
  assert.match(w.stub.issues[0].body, /run-77-1/);
  assert.equal((await invoke(w, argv)).code, 0);
  assert.equal(w.stub.issues.length, 1, "the second failure updates the issue by comment");
  assert.equal(w.stub.world.comments.length, 1);
  assert.equal(stateOf(w).failedAttempts, 2);
  assert.equal(stateOf(w).blockedTargetSha, TARGET);
});

test("AC50 a request that fails is not a verification failure: a 500 on the pull-request list leaves the counters alone, fails the run and says why in the issue", async (t) => {
  const start = state({ failedTargetSha: TARGET, failedAttempts: 1 });
  const w = world({ start });
  t.after(() => w.workspace.cleanup());
  w.stub.inject("GET", "/pulls", () => ({ status: 500, body: { message: "boom" } }));
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 1);
  assert.deepEqual(stateOf(w), start, "the variable is unchanged");
  assert.equal(writes(w.stub).length, 0);
  assert.equal(w.stub.issues.length, 1);
  assert.match(w.stub.issues[0].body, /could not be updated/);
});

test("AC50 a 403 on the provenance file, and a 403 on the pull-request list, fail the run without a failure transition", async (t) => {
  for (const [needle, status] of [["/contents/", 403], ["/pulls", 403]]) {
    const start = state();
    const w = world({ start });
    t.after(() => w.workspace.cleanup());
    w.stub.inject("GET", needle, () => ({ status, headers: { "x-accepted-github-permissions": "contents=read" }, body: { message: "Resource not accessible by integration" } }));
    const result = await invoke(w, flagsFor(w.edgeValue));
    assert.equal(result.code, 1, needle);
    assert.deepEqual(stateOf(w), start, needle);
    assert.match(result.stderr, /HTTP 403/);
    assert.match(result.stderr, /X-Accepted-GitHub-Permissions: contents=read/);
  }
});

test("AC60 result-pr-opened: the result names the verified pull request, its head and the target, and validates against the schema", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { outcome: "pr-opened", prNumber: 7, prUrl: "https://github.com/acme/portal/pull/7", headSha: PR_HEAD, openPrTargetSha: TARGET });
  assert.equal(result.stdout.trim().split("\n").length, 1, "standard output is exactly one JSON line");
});

test("AC60 result-pr-updated: the stored openPrNumber equals the verified number", async (t) => {
  const w = world({ start: state({ openPrNumber: 7, openPrTargetSha: sha("older-target") }) });
  t.after(() => w.workspace.cleanup());
  const result = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(JSON.parse(result.stdout).outcome, "pr-updated");
  assert.equal(stateOf(w).openPrTargetSha, TARGET);
  const other = world({ start: state({ openPrNumber: 5, openPrTargetSha: sha("older-target") }) });
  t.after(() => other.workspace.cleanup());
  assert.equal(JSON.parse((await invoke(other, flagsFor(other.edgeValue))).stdout).outcome, "pr-opened");
});

test("AC68 rerun-success-is-idempotent: a second identical run writes nothing and the value is identical", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  assert.equal((await invoke(w, flagsFor(w.edgeValue))).code, 0);
  const first = stateOf(w);
  w.clock.time += 60000;
  const again = await invoke(w, flagsFor(w.edgeValue));
  assert.equal(again.code, 0);
  assert.equal(writes(w.stub).length, 1, "an identical state is not written again (updatedAt alone is not a change)");
  assert.deepEqual(stateOf(w), first);
  assert.deepEqual(JSON.parse(again.stdout).outcome, "pr-updated");
});

test("AC68 updatedAt comes from the injected clock", async (t) => {
  const w = world();
  t.after(() => w.workspace.cleanup());
  w.clock.time = Date.UTC(2031, 0, 2, 3, 4, 5);
  await invoke(w, flagsFor(w.edgeValue));
  assert.equal(stateOf(w).updatedAt, "2031-01-02T03:04:05.000Z");
});

test("AC59 gh-admin-preset-slug: the preset slug resolves against the committed manifest and a PATCH goes to SDLC_SYNC_STATE_GH_ADMIN_MSFT", async (t) => {
  const { default: YAML } = await import("yaml");
  const fs = await import("node:fs");
  const { abs } = await import("./helpers/fixtures.mjs");
  const preset = YAML.parse(fs.readFileSync(abs("sdlc.yaml"), "utf8")).dependencyEdges.find((entry) => entry.upstreamSlug === "GH_ADMIN_MSFT");
  const [owner, repo] = preset.downstreamRepo.split("/");
  const start = state({}, preset);
  const stub = createGitHubStub({
    central: CENTRAL,
    variables: { [preset.stateVariable]: start },
    repos: {
      [preset.downstreamRepo]: {
        openPullsByHead: { [`${owner}:${preset.branchName}`]: [pullRequest({ number: 21, headSha: PR_HEAD, headRef: preset.branchName })] },
        filesAtRef: { [PR_HEAD]: { [preset.provenanceFile]: JSON.stringify({ commit: TARGET }) } },
      },
    },
  });
  const clock = createClock(Date.parse(NOW_ISO));
  let stdout = "";
  const code = await run(
    ["--slug", "GH_ADMIN_MSFT", "--branch", "sdlc/cascade-ghec-admin", "--provenance-file", "public/ghec-admin/source.json", "--base-sha", BASE, "--head-sha", HEAD, "--target-sha", TARGET, "--etag", ETAG],
    { env: { GITHUB_WORKSPACE: abs("."), GITHUB_REPOSITORY: CENTRAL, GH_TOKEN: TOKENS.gh, ISSUES_TOKEN: TOKENS.issues }, fetch: stub.fetch, now: clock.now, sleep: clock.sleep, stdout: (text) => (stdout += text), stderr: () => {} },
  );
  assert.equal(code, 0);
  assert.equal(stub.calls("PATCH")[0].path, `/repos/${CENTRAL}/actions/variables/SDLC_SYNC_STATE_GH_ADMIN_MSFT`);
  assert.equal(stub.calls("GET", "/pulls")[0].pathAndSearch, `/repos/${preset.downstreamRepo}/pulls?state=open&head=${owner}:sdlc/cascade-ghec-admin`);
  assert.equal(JSON.parse(stdout).prNumber, 21);
});
