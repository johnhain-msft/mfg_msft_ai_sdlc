// Explicit, offline reproductions of product defects, deliberately outside the
// *.test.mjs gate until the product is fixed:
// node --test --test-concurrency=4 tests/s3/fixtures/qa-round2-regressions.repro.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { initialSyncState } from "../../../bin/lib/actions-variables.mjs";
import { run as finalize } from "../../../src/update-poll-state.mjs";
import { mechanicalEdge, NOW_ISO, sha, TOKENS } from "../helpers/fixtures.mjs";
import { pullRequest } from "../helpers/github-stub.mjs";
import { routerWorld } from "../helpers/harness.mjs";
import { seededShowcaseWorld } from "../helpers/qa-round2-worlds.mjs";
import { actionsRun, RECORDED_RUN_IDS } from "../helpers/preflight-world.mjs";

test("QA2 regression: deleting provenance after a recorded merge must not reuse the bootstrap 404 fallback", async (t) => {
  const e = mechanicalEdge({ initialBaselineSha: sha("bootstrap-baseline"), preflightCommands: [] });
  const first = sha("first-import");
  const prHead = sha("first-pr-head");
  const w = routerWorld({
    edge: e,
    state: initialSyncState(e.initialBaselineSha, NOW_ISO),
    upstream: { head: first },
    stubOptions: { acceptTokens: [TOKENS.gh, TOKENS.issues] },
  });
  t.after(() => w.cleanup());

  // The first run legitimately uses the bootstrap fallback and dispatches.
  let result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.stub.world.dispatches.length, 1);
  const pr = pullRequest({ number: 7, headSha: prHead, headRef: e.branchName });
  w.stub.repo(e.downstreamRepo, {
    pulls: { 7: pr },
    openPullsByHead: { [`acme:${e.branchName}`]: [pr] },
    filesAtRef: { [prHead]: { [e.provenanceFile]: JSON.stringify({ commit: first }) } },
  });
  let stdout = "";
  let stderr = "";
  const code = await finalize([
    "--slug", e.upstreamSlug, "--branch", e.branchName, "--provenance-file", e.provenanceFile,
    "--base-sha", w.downstreamHead, "--head-sha", prHead, "--target-sha", first, "--etag", 'W/"upstream-etag-1"',
  ], {
    env: { ...w.env, GH_TOKEN: TOKENS.gh, CORRELATION_ID: w.decisions()[0].correlationId },
    fetch: w.stub.fetch, now: w.clock.now, sleep: w.clock.sleep,
    stdout: (text) => (stdout += text), stderr: (text) => (stderr += text),
  });
  assert.equal(code, 0, `${stderr}\n${stdout}`);
  assert.equal(w.state().openPrNumber, 7);

  // A human merges the verified PR; the router itself advances the merge cursor.
  w.stub.repo(e.downstreamRepo, {
    head: sha("main-after-first-merge"),
    files: { [e.provenanceFile]: JSON.stringify({ commit: first }) },
    pulls: { 7: { ...pr, merged: true, state: "closed", merged_at: NOW_ISO } },
    openPullsByHead: {},
  });
  result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.state().lastMergedUpstreamSha, first);
  assert.notEqual(w.state().lastMergedUpstreamSha, e.initialBaselineSha);
  assert.equal(w.state().openPrNumber, null);

  // Production trigger: a later downstream main commit deletes that provenance,
  // and upstream advances. A real contents GET at this new main SHA returns 404.
  w.stub.repo(e.downstreamRepo, { head: sha("main-with-provenance-deleted"), files: {} });
  w.stub.repo(e.upstreamRepo, { head: sha("second-import"), etag: 'W/"second-import"' });
  const before = w.stub.variables.get(e.stateVariable);
  const dispatchesBefore = w.stub.world.dispatches.length;
  const patchesBefore = w.patches().length;
  result = await w.go();
  assert.equal(
    result.code, 1,
    `expected fatal historical provenance 404; actual exit ${result.code}, new dispatches ${w.stub.world.dispatches.length - dispatchesBefore}, new PATCHes ${w.patches().length - patchesBefore}\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(w.stub.variables.get(e.stateVariable), before);
  assert.equal(w.stub.world.dispatches.length, dispatchesBefore);
  assert.equal(w.patches().length, patchesBefore);
  assert.equal(w.stub.issues.length, 1);
});

test("QA2 regression: a newer CI run below another workflow's recorded run id still requires a showcase dispatch", async (t) => {
  // The eleven ids are the capture script's real recorded ids (SPEC-03 F24).
  // A CI run can occur after recorded CI 39781079785 but before the unrelated
  // Dependabot capture 40573274820. It is new for CI, not older CI history.
  const newerCi = {
    ...actionsRun(40100000000),
    name: "ci",
    path: ".github/workflows/ci.yml",
    workflow_id: 42,
    created_at: "2026-11-02T12:00:00Z",
  };
  assert.ok(newerCi.id > RECORDED_RUN_IDS[0]);
  assert.ok(newerCi.id < Math.max(...RECORDED_RUN_IDS));
  const keys = ["ci", "codeql", "dependency-review", "container-scan", "scorecard", "dependabot", "cd", "cd-initial", "rollback", "cd-waiting", "cd-queued"];
  const recordedRuns = RECORDED_RUN_IDS.map((id, index) => {
    const key = keys[index].startsWith("cd") ? "cd" : keys[index];
    return {
      ...actionsRun(id),
      name: key,
      path: `.github/workflows/${key}.yml`,
      workflow_id: 42 + keys.indexOf(key),
      created_at: index === 5 ? "2026-11-03T12:00:00Z" : "2026-11-01T12:00:00Z",
    };
  });
  const runList = [...recordedRuns, newerCi].sort((a, b) => b.id - a.id);
  const w = seededShowcaseWorld({
    runList,
    extra: { rest: { runList, runs: Object.fromEntries(runList.map((run) => [run.id, run])) } },
  });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(
    w.w.stub.world.dispatches.length, 1,
    `the newer completed CI run was missed; persisted lastNoopHeadSha=${w.w.state().lastNoopHeadSha}\n${result.stdout}`,
  );
  assert.equal(w.w.state().inFlightTargetSha, w.upstreamHead);
  assert.equal(w.w.state().lastNoopHeadSha, null);
  assert.equal(w.w.stub.world.dispatches[0].body.inputs.sync_scope, "showcase-runs");
});
