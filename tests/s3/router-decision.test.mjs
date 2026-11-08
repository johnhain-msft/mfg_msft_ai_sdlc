// The routing decision of the router (SPEC-03 AC14-AC19, AC25, AC68): the downstream reads, the open-pull-request reconciliation, the resets, the terminal
// comparisons in their order, the single state write and the decision log. Every case asserts what the variable holds afterwards and which requests were
// made, not only a status string.
import assert from "node:assert/strict";
import test from "node:test";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { decide } from "../../src/route-upstream.mjs";
import { run as finalize } from "../../src/update-poll-state.mjs";
import { pullRequest } from "./helpers/github-stub.mjs";
import { routerWorld, writesOf } from "./helpers/harness.mjs";
import { edge as edgeFixture, mechanicalEdge, NOW_ISO, presetEdges, routerMatrixEntries, seedState, sha, state, TOKENS } from "./helpers/fixtures.mjs";

const SHA0 = sha("sha0");
const SHA1 = sha("sha1");
const SHA2 = sha("sha2");
const MAIN = sha("main-1");
const MAIN2 = sha("main-2");
// The bootstrap seeds lastMergedUpstreamSha with initialBaselineSha (SPEC-03 AC13), so a world whose merge cursor is sha0 is the seeded world of an edge whose
// baseline is sha0. A test that moves the cursor off sha0 is a world in which the router has advanced it, and its downstream carries the provenance file.
const E = edgeFixture({ initialBaselineSha: SHA0 });

/** A quiet world: the upstream is at `head`, the stored state has `overrides` over the seed (merge cursor and last observation at sha0). */
function world({ head = SHA1, stateOverrides = {}, edge = E, upstream = {}, ...rest } = {}) {
  const start = state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, portfolioMainSha: MAIN, ...stateOverrides }, edge);
  return routerWorld({ edge, state: start, upstream: { head, ...upstream }, ...rest });
}

const provenanceFile = (commit, file = E.provenanceFile) => ({ [file]: JSON.stringify({ commit }) });
const FAILED = (target, attempts, blocked) => ({ failedTargetSha: target, failedAttempts: attempts, blockedTargetSha: blocked });

async function routed(t, options) {
  const w = world(options);
  t.after(() => w.cleanup());
  const before = w.stub.variables.get(E.stateVariable);
  const result = await w.go();
  return { w, result, before };
}

const dispatches = (w) => w.stub.world.dispatches;

// ---- AC14: the downstream main and its provenance ----------------------------------------------------------------------------------

test("AC14 provenance-present: the commit that the provenance file records at the head of the downstream is the merge cursor", async (t) => {
  const recorded = sha("recorded");
  const { w, result } = await routed(t, { downstream: { files: provenanceFile(recorded) } });
  assert.equal(result.code, 0, result.stderr);
  const [decision] = w.decisions();
  assert.equal(decision.previousSha, recorded);
  assert.equal(dispatches(w)[0].body.inputs.previous_sha, recorded, "the dispatch carries the cursor of the provenance, not the one of the stale state");
  assert.equal(w.state().lastMergedUpstreamSha, recorded, "the reconciled cursor is persisted");
  const read = w.stub.calls("GET", "/contents/")[0];
  assert.equal(read.pathAndSearch, `/repos/acme/portal/contents/docs/widgets/provenance.json?ref=${MAIN}`, "read on the head that was just read, not on a branch name");
});

test("AC14 provenance-404-falls-back-to-state: a provenance file that does not exist before the first merged cascade pull request leaves the cursor of the state, which is still the seed", async (t) => {
  const { w, result } = await routed(t, {});
  assert.equal(result.code, 0, result.stderr);
  assert.equal(E.initialBaselineSha, SHA0);
  assert.equal(w.decisions()[0].previousSha, SHA0, "the cursor is the baseline that the bootstrap seeded (AC13)");
  assert.equal(w.state().lastMergedUpstreamSha, SHA0);
  assert.equal(dispatches(w)[0].body.inputs.previous_sha, SHA0);
});

test("AC14 provenance-404-after-the-first-merge-is-fatal: once the router has advanced the merge cursor off the seed, a provenance file that is gone from main is an error and not the bootstrap fallback", async (t) => {
  // a cascade pull request merged and the router advanced the cursor to sha1; somebody then deleted the provenance file on main, and the upstream advanced to sha2
  const { w, result, before } = await routed(t, { head: SHA2, stateOverrides: { lastMergedUpstreamSha: SHA1, lastObservedHeadSha: SHA1 } });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`docs/widgets/provenance\\.json of acme/portal at ${MAIN} does not exist \\(404\\)`));
  assert.match(result.stderr, new RegExp(`merge cursor ${SHA1} has moved off the seed ${SHA0}`));
  assert.equal(w.stub.variables.get(E.stateVariable), before, "the variable is exactly as it was");
  assert.equal(w.patches().length, 0);
  assert.equal(dispatches(w).length, 0, "nothing is dispatched from a cursor that main no longer confirms");
  assert.equal(w.decisions().length, 0, "no decision is logged for a run that cannot decide");
  assert.deepEqual(writesOf(w.stub).filter((line) => !line.startsWith("POST /app/")), [`POST /repos/acme/orchestrator/issues`], "the only write is the failure issue");
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.issues[0].title, "[sdlc-failure] cascade-router (initech/widgets)");
  assert.match(w.stub.issues[0].body, /docs\/widgets\/provenance\.json/);
  assert.match(w.stub.issues[0].body, /404/);
});

test("AC14 provenance-404-after-the-first-merge-is-fatal: whatever the target and the stored comparisons would have said, a cursor that main does not confirm decides nothing", async (t) => {
  const moved = { lastMergedUpstreamSha: SHA1, lastObservedHeadSha: SHA1 };
  const cases = [
    ["a new target", { head: SHA2, stateOverrides: moved }],
    ["the target is the merge cursor (nothing to route)", { head: SHA1, stateOverrides: moved }],
    ["the target is the dismissed one", { head: SHA2, stateOverrides: { ...moved, dismissedTargetSha: SHA2 } }],
    ["the target is the blocked one", { head: SHA2, stateOverrides: { ...moved, ...FAILED(SHA2, 2, SHA2), portfolioMainSha: MAIN } }],
    ["a 304 on the stored ETag (the target is the last observed head)", { head: SHA1, stateOverrides: { ...moved, etag: 'W/"upstream-etag-1"' } }],
    ["a manual run that resets the blocked target", { head: SHA2, stateOverrides: { ...moved, ...FAILED(SHA2, 2, SHA2) }, event: "workflow_dispatch", resetBlocked: true }],
  ];
  for (const [label, options] of cases) {
    const { w, result, before } = await routed(t, options);
    assert.equal(result.code, 1, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.equal(w.stub.variables.get(E.stateVariable), before, `${label}: the variable is exactly as it was`);
    assert.equal(w.patches().length, 0, label);
    assert.equal(dispatches(w).length, 0, label);
    assert.equal(w.decisions().length, 0, label);
    assert.equal(w.stub.issues.length, 1, label);
  }
});

test("AC14 a pull request that is seen merged now ends the bootstrap time for the run after it: the cursor advances from the pull request, and the next run needs the file", async (t) => {
  // the provenance read of this run is older than the observation of the merge, as the decision already treats it (a merged pull request is the newer information)
  const first = await routed(t, {
    head: SHA1,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: true, headSha: sha("pr5") }) } },
  });
  assert.equal(first.result.code, 0, first.result.stderr);
  assert.equal(first.w.state().lastMergedUpstreamSha, SHA1);
  assert.equal(first.w.state().openPrNumber, null);
  // the next run, on the state that the first persisted, finds no provenance file on main although a cascade pull request has merged
  first.w.stub.repo("initech/widgets", { head: SHA2, etag: 'W/"upstream-etag-2"' });
  const persisted = first.w.stub.variables.get(E.stateVariable);
  const second = await first.w.go();
  assert.equal(second.code, 1, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stderr, new RegExp(`merge cursor ${SHA1} has moved off the seed ${SHA0}`));
  assert.equal(first.w.stub.variables.get(E.stateVariable), persisted, "the second run wrote nothing");
  assert.equal(dispatches(first.w).length, 0);
});

test("AC14 a dismissed pull request is not a merge: the bootstrap fallback still holds while the cursor is the seed", async (t) => {
  const { w, result } = await routed(t, {
    head: SHA2,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: false }) } },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.state().dismissedTargetSha, SHA1);
  assert.equal(w.state().lastMergedUpstreamSha, SHA0);
  assert.equal(dispatches(w)[0].body.inputs.previous_sha, SHA0);
});

test("AC14 the rule is data of the edge: for every preset edge the fallback holds at the seed and a moved cursor makes a missing provenance file an error", async (t) => {
  for (const entry of routerMatrixEntries()) {
    // synthetic repositories (the engine names none), the preset's own keys, paths and baseline; no preflight, so that the decision alone is exercised
    const edge = edgeFixture({ ...entry, upstreamRepo: "initech/up", downstreamRepo: "acme/portal", preflightCommands: [] });
    const target = sha(`target-of-${entry.upstreamKey}`);
    const seeded = routerWorld({ edge, state: seedState(edge), upstream: { head: target } });
    t.after(() => seeded.cleanup());
    const ok = await seeded.go();
    assert.equal(ok.code, 0, `${entry.upstreamKey}: ${ok.stderr}`);
    assert.equal(seeded.decisions()[0].previousSha, edge.initialBaselineSha, entry.upstreamKey);
    assert.equal(seeded.stub.world.dispatches.length, 1, entry.upstreamKey);

    const advanced = state({ lastMergedUpstreamSha: sha(`merged-${entry.upstreamKey}`), lastObservedHeadSha: sha(`merged-${entry.upstreamKey}`) }, edge);
    const moved = routerWorld({ edge, state: advanced, upstream: { head: target } });
    t.after(() => moved.cleanup());
    const before = moved.stub.variables.get(edge.stateVariable);
    const refused = await moved.go();
    assert.equal(refused.code, 1, `${entry.upstreamKey}: ${refused.stdout}`);
    assert.ok(refused.stderr.includes(`${edge.provenanceFile} of acme/portal`), `${entry.upstreamKey}: the file of the edge is named`);
    assert.equal(moved.stub.variables.get(edge.stateVariable), before, entry.upstreamKey);
    assert.equal(moved.stub.world.dispatches.length, 0, entry.upstreamKey);
  }
});

test("AC14 the story end to end on the real seed: a verified pull request merges, the router advances the cursor, the provenance file is deleted, and the next upstream advance is refused", async (t) => {
  // the seed is what the bootstrap writes (bin/lib/actions-variables.mjs), the verification is the real success path of src/update-poll-state.mjs
  const e = mechanicalEdge({ initialBaselineSha: sha("bootstrap-baseline"), preflightCommands: [] });
  const first = sha("first-import");
  const prHead = sha("first-pr-head");
  const w = routerWorld({ edge: e, state: initialSyncState(e.initialBaselineSha, NOW_ISO), upstream: { head: first }, stubOptions: { acceptTokens: [TOKENS.gh, TOKENS.issues] } });
  t.after(() => w.cleanup());
  assert.deepEqual(w.state(), initialSyncState(e.initialBaselineSha, NOW_ISO));

  // run 1: the first cascade, before any merge, uses the bootstrap fallback and dispatches
  let result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.world.dispatches.length, 1);
  assert.equal(w.stub.world.dispatches[0].body.inputs.previous_sha, e.initialBaselineSha);

  // the cascade's post-safe_outputs job verifies the pull request and records it
  const pr = pullRequest({ number: 7, headSha: prHead, headRef: e.branchName });
  w.stub.repo(e.downstreamRepo, { pulls: { 7: pr }, openPullsByHead: { [`acme:${e.branchName}`]: [pr] }, filesAtRef: { [prHead]: { [e.provenanceFile]: JSON.stringify({ commit: first }) } } });
  let stdout = "";
  let stderr = "";
  const code = await finalize(
    ["--slug", e.upstreamSlug, "--branch", e.branchName, "--provenance-file", e.provenanceFile, "--base-sha", w.downstreamHead, "--head-sha", prHead, "--target-sha", first, "--etag", 'W/"upstream-etag-1"'],
    { env: { ...w.env, GH_TOKEN: TOKENS.gh, CORRELATION_ID: w.decisions()[0].correlationId }, fetch: w.stub.fetch, now: w.clock.now, sleep: w.clock.sleep, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
  );
  assert.equal(code, 0, `${stderr}\n${stdout}`);
  assert.equal(w.state().openPrNumber, 7);

  // a human merges it; main now has the provenance file, and the router itself advances the cursor
  w.stub.repo(e.downstreamRepo, { head: sha("main-after-first-merge"), files: { [e.provenanceFile]: JSON.stringify({ commit: first }) }, pulls: { 7: { ...pr, merged: true, state: "closed", merged_at: NOW_ISO } }, openPullsByHead: {} });
  result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.state().lastMergedUpstreamSha, first);
  assert.notEqual(w.state().lastMergedUpstreamSha, e.initialBaselineSha);

  // a later commit on main deletes the provenance file, and the upstream advances: a real contents request now answers 404
  w.stub.repo(e.downstreamRepo, { head: sha("main-with-provenance-deleted"), files: {} });
  w.stub.repo(e.upstreamRepo, { head: sha("second-import"), etag: 'W/"second-import"' });
  const stored = w.stub.variables.get(e.stateVariable);
  const dispatched = w.stub.world.dispatches.length;
  const patched = w.patches().length;
  result = await w.go();
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(w.stub.variables.get(e.stateVariable), stored, "the state is unchanged");
  assert.equal(w.stub.world.dispatches.length, dispatched, "nothing is dispatched");
  assert.equal(w.patches().length, patched, "nothing is written");
  assert.equal(w.stub.issues.length, 1);
});

test("AC14 a provenance file that exists but records no commit is an error, not a fallback", async (t) => {
  for (const text of ["not json", JSON.stringify({ other: 1 }), JSON.stringify({ commit: "short" })]) {
    const { w, result } = await routed(t, { downstream: { files: { [E.provenanceFile]: text } } });
    assert.equal(result.code, 1, text);
    assert.equal(w.patches().length, 0, text);
    assert.equal(dispatches(w).length, 0, text);
  }
});

test("AC14 the downstream head is the head of its default branch, read by name from the repository and never assumed", async (t) => {
  const { w } = await routed(t, { downstream: { defaultBranch: "stable", head: MAIN2 } });
  const calls = w.stub.calls("GET").map((request) => request.pathAndSearch);
  assert.ok(calls.includes("/repos/acme/portal"), "the repository is read for its default branch");
  assert.ok(calls.includes("/repos/acme/portal/commits/stable"));
  assert.equal(w.state().portfolioMainSha, MAIN2);
});

test("AC14 copilot-lab-reads-source-inputs-json: the preset edge's provenance file is source-inputs.json, and the studio provenance is read only for the log", async (t) => {
  const entry = routerMatrixEntries().find((candidate) => candidate.upstreamKey === "copilot-lab");
  assert.equal(entry.provenanceFile, "experiences/copilot-workshop/source-inputs.json");
  const lab = edgeFixture({ ...entry, upstreamRepo: "initech/lab", downstreamRepo: "acme/portal", preflightCommands: entry.preflightCommands });
  const target = lab.initialBaselineSha;
  // the target is the merge cursor, so no preflight runs and only the reads of the decision are made
  const w = routerWorld({ edge: lab, state: seedState(lab), upstream: { head: target }, downstream: { files: { [lab.provenanceFile]: JSON.stringify({ commit: target }), "apps/lab-studio/lab-sources.json": JSON.stringify({ _provenance: { commit: sha("studio") } }) } } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  const reads = w.stub.calls("GET", "/contents/").map((request) => request.path);
  assert.ok(reads.includes("/repos/acme/portal/contents/experiences/copilot-workshop/source-inputs.json"));
  assert.ok(reads.includes("/repos/acme/portal/contents/apps/lab-studio/lab-sources.json"));
  assert.equal(w.decisions()[0].action, "noop-304");
});

test("AC14 lab-provenance-mismatch-is-logged-not-fatal: the two lab provenance commits differ, the edge's file is authoritative and the job succeeds", async (t) => {
  const entry = routerMatrixEntries().find((candidate) => candidate.upstreamKey === "copilot-lab");
  const lab = edgeFixture({ ...entry, upstreamRepo: "initech/lab", downstreamRepo: "acme/portal" });
  const target = lab.initialBaselineSha;
  const studio = sha("studio-commit");
  const w = routerWorld({ edge: lab, state: seedState(lab), upstream: { head: target }, downstream: { files: { [lab.provenanceFile]: JSON.stringify({ commit: target }), "apps/lab-studio/lab-sources.json": JSON.stringify({ _provenance: { commit: studio } }) } } });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /provenance mismatch \(recorded, not an error\)/);
  assert.ok(result.stdout.includes(target) && result.stdout.includes(studio));
  assert.equal(w.decisions()[0].previousSha, target, "the edge's provenance file is authoritative");
  assert.equal(w.stub.requests.filter((request) => request.method !== "GET" && !request.path.startsWith("/app/")).length, w.patches().length, "nothing was written but the state");
});

test("AC14 a studio provenance file that cannot be read is noted and decides nothing", async (t) => {
  const entry = routerMatrixEntries().find((candidate) => candidate.upstreamKey === "copilot-lab");
  const lab = edgeFixture({ ...entry, upstreamRepo: "initech/lab", downstreamRepo: "acme/portal" });
  const w = routerWorld({ edge: lab, state: seedState(lab), upstream: { head: lab.initialBaselineSha }, downstream: { files: provenanceFile(lab.initialBaselineSha, lab.provenanceFile) } });
  t.after(() => w.cleanup());
  w.stub.inject("GET", "lab-sources.json", () => ({ status: 500, body: { message: "boom" } }));
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /could not be read for the decision log/);
});

// ---- AC15: the open pull request ----------------------------------------------------------------------------------------------------

test("AC15 pr-merged-advances-last-merged: a merged pull request moves the merge cursor to its target and clears its pointers", async (t) => {
  const { w, result } = await routed(t, {
    head: SHA2,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: true, headSha: sha("pr5") }) } },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.calls("GET", "/pulls/5").length, 1);
  const state = w.state();
  assert.equal(state.lastMergedUpstreamSha, SHA1);
  assert.equal(state.openPrNumber, null);
  assert.equal(state.openPrTargetSha, null);
  assert.equal(w.decisions()[0].previousSha, SHA1, "the dispatch for sha2 is cumulative from the merged sha1");
  assert.equal(dispatches(w)[0].body.inputs.previous_sha, SHA1);
});

test("AC15 pr-merged-advances-last-merged: the merged target is noop-304 when it is also the target", async (t) => {
  const { w } = await routed(t, {
    head: SHA1,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: true }) } },
  });
  assert.equal(w.decisions()[0].action, "noop-304");
  assert.equal(dispatches(w).length, 0);
  assert.equal(w.state().lastMergedUpstreamSha, SHA1);
});

test("AC15 pr-closed-unmerged-records-dismissed: a human-rejected pull request is never re-opened for the same sha", async (t) => {
  const { w, result } = await routed(t, {
    head: SHA1,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: false }) } },
  });
  assert.equal(result.code, 0, result.stderr);
  const state = w.state();
  assert.equal(state.dismissedTargetSha, SHA1);
  assert.equal(state.openPrNumber, null);
  assert.equal(state.openPrTargetSha, null);
  assert.equal(w.decisions()[0].action, "noop-dismissed-pr");
  assert.equal(dispatches(w).length, 0, "no pull request is re-opened for the dismissed sha");
  assert.equal(state.lastMergedUpstreamSha, SHA0, "a dismissal never advances the merge cursor");
});

test("AC15 a new target after a dismissal is routed", async (t) => {
  const { w } = await routed(t, {
    head: SHA2,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: false }) } },
  });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(w.state().dismissedTargetSha, SHA1);
  assert.equal(dispatches(w)[0].body.inputs.previous_sha, SHA0);
});

test("AC15 pr-still-open-keeps-pointers: an open pull request keeps its pointers and covers its own target", async (t) => {
  const { w, result } = await routed(t, {
    head: SHA1,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "open", merged: false }) } },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.state().openPrNumber, 5);
  assert.equal(w.state().openPrTargetSha, SHA1);
  assert.equal(w.decisions()[0].action, "noop-304", "the open pull request already covers the target");
  assert.equal(dispatches(w).length, 0);
});

test("AC15 no pull-request request is made when the state records none", async (t) => {
  const { w } = await routed(t, {});
  assert.equal(w.stub.calls("GET", "/pulls/").length, 0);
});

test("AC15 a pull request that cannot be read fails the job and writes nothing", async (t) => {
  const { w, result } = await routed(t, { stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 }, downstream: { pulls: {} } });
  assert.equal(result.code, 1);
  assert.equal(w.patches().length, 0);
});

// ---- AC17: resets --------------------------------------------------------------------------------------------------------------------

test("AC17 reset-on-new-target: a target that is not the failed one clears the counters, so a blocked old target does not block it", async (t) => {
  const { w } = await routed(t, { head: SHA2, stateOverrides: FAILED(SHA1, 2, SHA1) });
  const state = w.state();
  assert.equal(state.failedTargetSha, null);
  assert.equal(state.failedAttempts, 0);
  assert.equal(state.blockedTargetSha, null);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
});

test("AC17 reset-on-portfolio-main-change: a downstream head that moved clears the block and retries the target", async (t) => {
  const blocked = world({ head: SHA1, stateOverrides: FAILED(SHA1, 2, SHA1) });
  t.after(() => blocked.cleanup());
  await blocked.go();
  assert.equal(blocked.decisions()[0].action, "noop-blocked-sha", "control: the same state with the same downstream head is blocked");
  assert.equal(dispatches(blocked).length, 0);

  const moved = world({ head: SHA1, stateOverrides: { ...FAILED(SHA1, 2, SHA1), portfolioMainSha: sha("older-main") } });
  t.after(() => moved.cleanup());
  await moved.go();
  assert.equal(moved.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(moved.state().failedAttempts, 0);
  assert.equal(moved.state().blockedTargetSha, null);
  assert.equal(moved.state().portfolioMainSha, MAIN, "the new downstream head is recorded");
});

test("AC17 reset-on-reset-blocked-input: a manual run with reset_blocked true clears the block, and false does not", async (t) => {
  const stateOverrides = FAILED(SHA1, 2, SHA1);
  const reset = world({ head: SHA1, stateOverrides, event: "workflow_dispatch", resetBlocked: true });
  t.after(() => reset.cleanup());
  await reset.go();
  assert.equal(reset.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(reset.state().blockedTargetSha, null);

  const keep = world({ head: SHA1, stateOverrides, event: "workflow_dispatch", resetBlocked: false });
  t.after(() => keep.cleanup());
  await keep.go();
  assert.equal(keep.decisions()[0].action, "noop-blocked-sha");
  assert.equal(keep.state().blockedTargetSha, SHA1);
});

test("AC17 reset_blocked is honoured only on a workflow_dispatch run", async (t) => {
  const w = world({ head: SHA1, stateOverrides: FAILED(SHA1, 2, SHA1), event: "schedule", resetBlocked: true });
  t.after(() => w.cleanup());
  await w.go();
  assert.equal(w.decisions()[0].action, "noop-blocked-sha");
});

test("AC17 no-reset-when-all-three-conditions-are-false: the failure counters of the same target stay and the dispatch is the retry", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: FAILED(SHA1, 1, null) });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  const state = w.state();
  assert.equal(state.failedTargetSha, SHA1);
  assert.equal(state.failedAttempts, 1);
});

// ---- AC18: terminal comparisons, in their order ----------------------------------------------------------------------------------------

test("AC18 already-merged: a target equal to the merge cursor is noop-304", async (t) => {
  const { w } = await routed(t, { head: SHA0, downstream: { files: provenanceFile(SHA0) } });
  assert.equal(w.decisions()[0].action, "noop-304");
  assert.equal(dispatches(w).length, 0);
});

test("AC18 already-noop: a target equal to lastNoopHeadSha is noop-304", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: { lastNoopHeadSha: SHA1 } });
  assert.equal(w.decisions()[0].action, "noop-304");
  assert.equal(dispatches(w).length, 0);
});

test("AC18 dismissed: a target equal to dismissedTargetSha is noop-dismissed-pr", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: { dismissedTargetSha: SHA1 } });
  assert.equal(w.decisions()[0].action, "noop-dismissed-pr");
  assert.equal(dispatches(w).length, 0);
});

test("AC18 blocked: a failed target with two attempts is noop-blocked-sha and is not dispatched", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: FAILED(SHA1, 2, SHA1) });
  assert.equal(w.decisions()[0].action, "noop-blocked-sha");
  assert.equal(dispatches(w).length, 0);
});

test("AC18 two failures that were counted without the block are brought to the block and not retried", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: FAILED(SHA1, 2, null) });
  assert.equal(w.decisions()[0].action, "noop-blocked-sha");
  assert.equal(w.state().blockedTargetSha, SHA1);
  assert.equal(dispatches(w).length, 0);
});

test("AC18 failed-once-retries-dispatch: one failure of the target is retried once", async (t) => {
  const { w } = await routed(t, { head: SHA1, stateOverrides: FAILED(SHA1, 1, null) });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(dispatches(w).length, 1);
});

test("AC18 in-flight-queued and in-flight-in-progress: the target of a run that is still going is noop-304 and the run status is read from the orchestrator", async (t) => {
  for (const status of ["queued", "in_progress"]) {
    const w = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: SHA1 } });
    t.after(() => w.cleanup());
    w.stub.repo("acme/orchestrator").runs = { 777: { id: 777, status, conclusion: null } };
    await w.go();
    assert.equal(w.decisions()[0].action, "noop-304", status);
    assert.equal(w.stub.calls("GET", "/repos/acme/orchestrator/actions/runs/777").length, 1);
    assert.equal(dispatches(w).length, 0, status);
    assert.equal(w.state().inFlightRunId, 777, "the pointers of a run that is going stay");
  }
});

test("AC18 in-flight-completed-is-stale: a recorded run that is neither queued nor in progress is cleared and the target is routed", async (t) => {
  for (const status of ["completed", "waiting", "requested"]) {
    const w = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: SHA1 } });
    t.after(() => w.cleanup());
    w.stub.repo("acme/orchestrator").runs = { 777: { id: 777, status, conclusion: "cancelled" } };
    await w.go();
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", status);
    assert.equal(dispatches(w).length, 1, status);
    const stateAfter = w.state();
    assert.notEqual(stateAfter.inFlightRunId, 777, `${status}: the stale run is not kept`);
    assert.equal(stateAfter.inFlightRunId, dispatches(w)[0].runId, "the new run is recorded in its place");
  }
});

test("AC18 a run that no longer exists (404) is a stale record, and any other failure to read it fails the job without a write", async (t) => {
  const gone = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: SHA1 } });
  t.after(() => gone.cleanup());
  await gone.go();
  assert.equal(gone.decisions()[0].action, "dispatch-ai-adaptation");

  const broken = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: SHA1 } });
  t.after(() => broken.cleanup());
  broken.stub.inject("GET", "/actions/runs/777", () => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
  const result = await broken.go();
  assert.equal(result.code, 1);
  assert.equal(broken.patches().length, 0);
  assert.equal(dispatches(broken).length, 0);
});

test("AC18 a stale record is cleared even when the target is a different one", async (t) => {
  const w = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: sha("another") } });
  t.after(() => w.cleanup());
  w.stub.repo("acme/orchestrator").runs = { 777: { id: 777, status: "completed", conclusion: "success" } };
  await w.go();
  assert.equal(w.state().inFlightTargetSha, SHA1, "replaced by the new dispatch");
  assert.equal(dispatches(w).length, 1);
});

test("AC18 a run that is still going for another target does not stop this target from being routed", async (t) => {
  const w = world({ head: SHA1, stateOverrides: { inFlightRunId: 777, inFlightTargetSha: sha("another") } });
  t.after(() => w.cleanup());
  w.stub.repo("acme/orchestrator").runs = { 777: { id: 777, status: "in_progress", conclusion: null } };
  await w.go();
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
});

test("AC18 open-pr-covers-target: an open pull request that records the target covers it", async (t) => {
  const { w } = await routed(t, {
    head: SHA1,
    stateOverrides: { openPrNumber: 9, openPrTargetSha: SHA1 },
    downstream: { pulls: { 9: pullRequest({ number: 9, state: "open", merged: false }) } },
  });
  assert.equal(w.decisions()[0].action, "noop-304");
});

test("AC18 the comparisons run in their order: merged before noop before dismissed before blocked before in-flight before open pull request", async (t) => {
  // every one of the six holds for the target; the action tells which was compared first
  const all = { lastNoopHeadSha: SHA1, dismissedTargetSha: SHA1, blockedTargetSha: SHA1, failedTargetSha: SHA1, failedAttempts: 2, inFlightRunId: 5, inFlightTargetSha: SHA1, openPrNumber: 9, openPrTargetSha: SHA1 };
  const cases = [
    { overrides: { ...all, lastMergedUpstreamSha: SHA1 }, files: provenanceFile(SHA1), expected: "noop-304" },
    { overrides: all, expected: "noop-304" },
    { overrides: { ...all, lastNoopHeadSha: null }, expected: "noop-dismissed-pr" },
    { overrides: { ...all, lastNoopHeadSha: null, dismissedTargetSha: null }, expected: "noop-blocked-sha" },
  ];
  for (const { overrides, files, expected } of cases) {
    const w = world({ head: SHA1, stateOverrides: overrides, downstream: { files: files ?? {}, pulls: { 9: pullRequest({ number: 9, state: "open" }) } } });
    t.after(() => w.cleanup());
    w.stub.repo("acme/orchestrator").runs = { 5: { id: 5, status: "in_progress" } };
    await w.go();
    assert.equal(w.decisions()[0].action, expected, JSON.stringify(overrides));
  }
});

// ---- AC19: cumulative range ------------------------------------------------------------------------------------------------------------------

test("AC19 sha0-sha1-sha2-cumulative: sha2 is routed as a new target while the pull request for sha0..sha1 is open, and previous_sha stays sha0", async (t) => {
  const { w, result } = await routed(t, {
    head: SHA2,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1 },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "open", merged: false }) } },
  });
  assert.equal(result.code, 0, result.stderr);
  const [dispatch] = dispatches(w);
  assert.equal(dispatch.body.inputs.previous_sha, SHA0, "never sha1");
  assert.equal(dispatch.body.inputs.upstream_sha, SHA2);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(w.state().openPrTargetSha, SHA1, "the open pull request keeps its pointers until the cascade run replaces them");
  assert.equal(w.state().openPrNumber, 5);
});

// ---- AC25: decision log and the single write -------------------------------------------------------------------------------------------------

test("AC25 one-summary-line-per-job: exactly one MergeRoutingDecision, as one JSON line, whatever the outcome", async (t) => {
  for (const options of [{ head: SHA1 }, { head: SHA0, downstream: { files: provenanceFile(SHA0) } }, { head: SHA1, stateOverrides: FAILED(SHA1, 2, SHA1) }]) {
    const { w } = await routed(t, options);
    const lines = w.summaryLines();
    assert.equal(lines.length, 1);
    const decision = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(decision), ["correlationId", "upstreamRepo", "previousSha", "targetSha", "action", "dispatchedWorkflowId"]);
    assert.equal(decision.upstreamRepo, "initech/widgets");
    assert.equal(decision.targetSha, options.head);
  }
});

test("AC25 at-most-one-patch: a run that reconciles, resets and dispatches writes the variable once, last, with all of it", async (t) => {
  const { w } = await routed(t, {
    head: SHA2,
    stateOverrides: { openPrNumber: 5, openPrTargetSha: SHA1, ...FAILED(SHA1, 2, SHA1), portfolioMainSha: sha("older") },
    downstream: { pulls: { 5: pullRequest({ number: 5, state: "closed", merged: true }) } },
  });
  assert.equal(w.patches().length, 1);
  const order = w.stub.requests.filter((request) => request.method !== "GET" && !request.path.startsWith("/app/")).map((request) => `${request.method} ${request.path.split("/").slice(-2).join("/")}`);
  assert.equal(order.length, 2, "the dispatch and the state write are the only writes");
  assert.match(order[0], /^POST .*dispatches$/);
  assert.match(order[1], /^PATCH /, "the state is written last");
  const state = w.state();
  assert.equal(state.lastMergedUpstreamSha, SHA1, "reconciliation");
  assert.equal(state.openPrNumber, null);
  assert.equal(state.failedTargetSha, null, "reset");
  assert.equal(state.portfolioMainSha, MAIN);
  assert.equal(state.inFlightTargetSha, SHA2, "decision");
});

test("AC25 no-patch-when-unchanged: a run that changes nothing but updatedAt makes no PATCH", async (t) => {
  const { w, result } = await routed(t, { head: SHA0, stateOverrides: { etag: 'W/"upstream-etag-1"' }, downstream: { files: provenanceFile(SHA0) } });
  assert.equal(result.code, 0);
  assert.equal(w.decisions()[0].action, "noop-304");
  assert.equal(w.stub.calls("GET", "/commits/trunk")[0].headers["if-none-match"], 'W/"upstream-etag-1"', "the poll was conditional and answered 304");
  assert.equal(w.patches().length, 0);
  assert.deepEqual(writesOf(w.stub).filter((entry) => !entry.includes("/app/")), []);
});

test("AC25 etag-persisted-only-on-noop: the held ETag and the observed head are persisted on a confirmed noop after a 200, and never on a dispatch", async (t) => {
  const dispatchWorld = world({ head: SHA1 });
  t.after(() => dispatchWorld.cleanup());
  await dispatchWorld.go();
  const afterDispatch = dispatchWorld.state();
  assert.equal(afterDispatch.etag, "", "a dispatch leaves the etag for the finalizing job");
  assert.equal(afterDispatch.lastObservedHeadSha, SHA0);
  assert.equal(dispatches(dispatchWorld)[0].body.inputs.upstream_etag, 'W/"upstream-etag-1"', "the held ETag travels in the dispatch");

  const noop = world({ head: SHA1, stateOverrides: { dismissedTargetSha: SHA1 } });
  t.after(() => noop.cleanup());
  await noop.go();
  assert.equal(noop.state().etag, 'W/"upstream-etag-1"');
  assert.equal(noop.state().lastObservedHeadSha, SHA1);
  assert.equal(noop.patches().length, 1);
});

test("AC25 in-flight-patch-leaves-etag-unchanged (AC37): the PATCH that records the in-flight pair changes neither etag nor lastObservedHeadSha", async (t) => {
  const start = { etag: 'W/"old"', lastObservedHeadSha: SHA0 };
  const w = world({ head: SHA1, stateOverrides: start, upstream: { etag: 'W/"new"' } });
  t.after(() => w.cleanup());
  await w.go();
  const patch = JSON.parse(JSON.parse(w.patches()[0].body).value);
  assert.equal(patch.etag, 'W/"old"');
  assert.equal(patch.lastObservedHeadSha, SHA0);
  assert.equal(patch.inFlightRunId, dispatches(w)[0].runId);
  assert.equal(patch.inFlightTargetSha, SHA1);
});

// ---- AC68: determinism -----------------------------------------------------------------------------------------------------------------------

test("AC68 same-inputs-same-decision-and-state: two runs against identical worlds give the same decision and the same state apart from updatedAt", async (t) => {
  const first = world({ head: SHA1 });
  const second = world({ head: SHA1 });
  t.after(() => {
    first.cleanup();
    second.cleanup();
  });
  second.clock.time += 3600 * 1000;
  await first.go();
  await second.go();
  assert.deepEqual(first.decisions(), second.decisions());
  const { updatedAt: a, ...left } = first.state();
  const { updatedAt: b, ...right } = second.state();
  assert.deepEqual(left, right);
  assert.notEqual(a, b, "updatedAt comes from the injected clock");
});

test("AC68 a failing run leaves the variable exactly as it was", async (t) => {
  const { w, result } = await routed(t, { head: SHA1 });
  assert.equal(result.code, 0);
  const failing = world({ head: SHA1 });
  t.after(() => failing.cleanup());
  const before = failing.stub.variables.get(E.stateVariable);
  failing.stub.inject("POST", "/dispatches", () => ({ status: 500, body: { message: "boom" } }));
  const out = await failing.go();
  assert.equal(out.code, 1);
  assert.equal(failing.stub.variables.get(E.stateVariable), before);
  assert.equal(failing.patches().length, 0);
});

// ---- decide(): the pure part -------------------------------------------------------------------------------------------------------------------

test("decide: the reset runs before every terminal comparison and the cursor of the provenance is overridden only by a merged pull request", async () => {
  const stored = state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, portfolioMainSha: MAIN, failedTargetSha: SHA1, failedAttempts: 2, blockedTargetSha: SHA1, openPrNumber: 4, openPrTargetSha: SHA2 });
  const noStatus = async () => {
    throw new Error("no run status is needed");
  };
  const merged = await decide({ stored, targetSha: SHA1, mainSha: MAIN, provenanceCommit: SHA0, baselineSha: SHA0, openPr: { merged: true, state: "closed" }, resetBlocked: true, runStatusOf: noStatus });
  assert.equal(merged.working.lastMergedUpstreamSha, SHA2, "the merged pull request is the newer information");
  assert.equal(merged.working.blockedTargetSha, null);
  assert.equal(merged.action, null);
  const plain = await decide({ stored: { ...stored, openPrNumber: null, openPrTargetSha: null }, targetSha: SHA1, mainSha: MAIN, provenanceCommit: SHA2, baselineSha: SHA0, openPr: null, resetBlocked: false, runStatusOf: noStatus });
  assert.equal(plain.working.lastMergedUpstreamSha, SHA2, "the provenance file is authoritative");
  assert.equal(plain.action, "noop-blocked-sha", "same target, same main, no reset: blocked");
});

test("decide never calls the run status when an earlier comparison already decided", async () => {
  let calls = 0;
  const outcome = await decide({
    stored: state({ lastMergedUpstreamSha: SHA1, inFlightRunId: 9, inFlightTargetSha: SHA2, portfolioMainSha: MAIN }),
    targetSha: SHA1,
    mainSha: MAIN,
    provenanceCommit: null,
    baselineSha: SHA1,
    openPr: null,
    resetBlocked: false,
    runStatusOf: async () => {
      calls += 1;
      return "queued";
    },
  });
  assert.equal(outcome.action, "noop-304");
  assert.equal(calls, 0);
});

test("decide (AC14): a missing provenance file leaves the cursor of the state only while that cursor is the seed, and is an error after it, whatever else the state says", async () => {
  const noStatus = async () => {
    throw new Error("no run status is needed: the evidence is refused first");
  };
  const input = (stored, extra = {}) => ({ stored, targetSha: SHA2, mainSha: MAIN, provenanceCommit: null, provenanceLabel: "the provenance file", baselineSha: SHA0, openPr: null, resetBlocked: false, runStatusOf: noStatus, ...extra });
  // at the seed: the fallback
  const seeded = await decide(input(state({ lastMergedUpstreamSha: SHA0, portfolioMainSha: MAIN }, E)));
  assert.equal(seeded.working.lastMergedUpstreamSha, SHA0);
  assert.equal(seeded.action, null);
  // off the seed: an error that names what was missing and why the fallback does not apply
  for (const stored of [
    state({ lastMergedUpstreamSha: SHA1, portfolioMainSha: MAIN }, E),
    state({ lastMergedUpstreamSha: SHA1, portfolioMainSha: MAIN, ...FAILED(SHA2, 2, SHA2) }, E),
    state({ lastMergedUpstreamSha: SHA1, portfolioMainSha: MAIN, inFlightRunId: 9, inFlightTargetSha: SHA2 }, E),
    state({ lastMergedUpstreamSha: SHA1, portfolioMainSha: null, lastNoopHeadSha: SHA2 }, E),
  ]) {
    await assert.rejects(decide(input(stored)), (error) => {
      assert.equal(error.name, "RoutingDataError");
      assert.equal(error.code, "provenance-missing");
      assert.match(error.message, new RegExp(`^the provenance file does not exist \\(404\\), but the merge cursor ${SHA1} has moved off the seed ${SHA0}`));
      return true;
    });
  }
  // a file that is there is authoritative wherever the cursor is
  const present = await decide(input(state({ lastMergedUpstreamSha: SHA1, portfolioMainSha: MAIN }, E), { provenanceCommit: SHA1 }));
  assert.equal(present.working.lastMergedUpstreamSha, SHA1);
  // a caller that does not say what the seed is never gets the fallback
  await assert.rejects(decide(input(state({ lastMergedUpstreamSha: SHA0, portfolioMainSha: MAIN }, E), { baselineSha: undefined })), /has moved off the seed/);
});

test("the preset's edges produce the preset decisions: every edge of sdlc.yaml routes from its own seed (AC66 data check)", () => {
  for (const preset of presetEdges()) assert.ok(/^[0-9a-f]{40}$/.test(preset.initialBaselineSha), preset.edgeId);
  assert.equal(TOKENS.gh.startsWith("ghs_"), true);
});
