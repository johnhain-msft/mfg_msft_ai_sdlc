// The four preset edges of sdlc.yaml, routed as the committed router hands them to the script (the entries of its matrix) against fixtures (SPEC-03 AC66, AC18, AC24, AC34):
// gh-admin-msft dispatches the mechanical workflow, the other three dispatch their AI workflow with previous_sha at the merge cursor, and every terminal comparison of
// AC18 ends in the noop that it names, for each edge, with nothing dispatched and nothing but the specified fields written.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, presetEdges, readJson, routerMatrixEntries, sha, state } from "./helpers/fixtures.mjs";
import { actionsRun, CHANGED_REPORT, IN_SYNC, NEWEST_RECORDED_RUN, SHOWCASE_SCRIPT, showcaseUpstream } from "./helpers/preflight-world.mjs";
import { fixture, readText } from "./helpers/fixtures.mjs";

const matrix = routerMatrixEntries();
const manifest = presetEdges();
const byKey = Object.fromEntries(matrix.map((entry) => [entry.upstreamKey, entry]));
const WORKFLOW_FILE = {
  "gh-admin-msft": "cascade-mechanical-ghec-admin.lock.yml",
  "copilot-lab": "cascade-ai-copilot-lab.lock.yml",
  "pipeline-showcase": "cascade-ai-pipeline-showcase.lock.yml",
  "github-intermediate": "cascade-ai-github-intermediate.lock.yml",
};
const MAIN = sha("downstream-main");
const headOf = (key) => sha(`head-of-${key}`);
const workshop = { match: /sync:workshop-source/, code: 1, stdout: CHANGED_REPORT };
const studio = { match: /lab-studio-drift\.mjs/, code: 0, stdout: `${JSON.stringify(IN_SYNC)}\n` };

/** What the preflight of an edge answers when something changed, in the terms of the fake processes (a runs listing is read through the REST stub). */
const drifting = (key) => ({
  "gh-admin-msft": fakePreflight([]),
  "copilot-lab": fakePreflight([workshop, studio]),
  "pipeline-showcase": fakePreflight([]),
  "github-intermediate": fakePreflight([{ match: /diff --quiet/, code: 1 }]),
})[key];

const CENTRAL_OF_PRESET = "johnhain-msft/mfg_msft_ai_sdlc";

function world(key, { stored, upstream = {}, downstream = {} } = {}) {
  const entry = byKey[key];
  const script = readText(fixture("showcase", "fetch-run-data.fixture.mjs"));
  return routerWorld({
    central: CENTRAL_OF_PRESET,
    edge: entry,
    manifestEdges: manifest,
    state: stored ?? state({ portfolioMainSha: MAIN }, entry),
    upstream: { head: headOf(key), ...(key === "pipeline-showcase" ? showcaseUpstream([actionsRun(NEWEST_RECORDED_RUN + 1)]) : {}), ...upstream },
    downstream: { head: MAIN, ...downstream, files: { ...(key === "pipeline-showcase" ? { [SHOWCASE_SCRIPT]: script } : {}), ...(downstream.files ?? {}) } },
  });
}

test("AC66 the committed router has the four preset edges, and the workflow file of each dispatch exists on disk", () => {
  assert.deepEqual(matrix.map((entry) => entry.upstreamKey), ["gh-admin-msft", "copilot-lab", "pipeline-showcase", "github-intermediate"]);
  assert.deepEqual(matrix.map((entry) => entry.upstreamKey), manifest.map((entry) => entry.upstreamKey));
  for (const [key, file] of Object.entries(WORKFLOW_FILE)) assert.equal(fs.existsSync(abs(".github", "workflows", file)), true, `${key}: ${file}`);
});

for (const key of Object.keys(WORKFLOW_FILE)) {
  test(`AC66 ${key}: the dispatch decision names the workflow of the edge, previous_sha is the merge cursor and the dispatch is recorded as in flight`, async (t) => {
    const w = world(key);
    t.after(() => w.cleanup());
    const entry = byKey[key];
    const fake = drifting(key);
    const result = await w.go({ preflightDeps: fake.deps });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const mechanical = entry.mode === "mechanical";
    assert.deepEqual(w.decisions(), [
      {
        correlationId: "run-5001-1",
        upstreamRepo: entry.upstreamRepo,
        previousSha: entry.initialBaselineSha,
        targetSha: headOf(key),
        action: mechanical ? "dispatch-mechanical" : "dispatch-ai-adaptation",
        dispatchedWorkflowId: WORKFLOW_FILE[key],
      },
    ]);
    const [dispatch] = w.stub.world.dispatches;
    assert.equal(w.stub.world.dispatches.length, 1);
    assert.equal(dispatch.file, WORKFLOW_FILE[key]);
    assert.equal(dispatch.body.inputs.previous_sha, entry.initialBaselineSha, "the merge cursor of the state, which the seed took from initialBaselineSha");
    assert.equal(dispatch.body.inputs.upstream_sha, headOf(key));
    assert.equal(dispatch.body.inputs.upstream_repo, entry.upstreamRepo);
    assert.equal(dispatch.body.inputs.downstream_repo, entry.downstreamRepo);
    assert.equal(Object.keys(dispatch.body.inputs).length, mechanical ? 8 : 10, mechanical ? "the eight inputs of C7" : "the ten inputs of C7");
    for (const value of Object.values(dispatch.body.inputs)) assert.equal(typeof value, "string");
    const after = w.state();
    assert.equal(after.inFlightTargetSha, headOf(key));
    assert.equal(after.inFlightRunId, dispatch.runId);
    assert.equal(after.lastMergedUpstreamSha, entry.initialBaselineSha, "a dispatch never advances the merge cursor");
    assert.equal(w.stub.variable(entry.stateVariable).lastNoopHeadSha, null);
    // the variable that was written is the variable of the edge, and nothing else was
    assert.deepEqual([...new Set(w.patches().map((patch) => patch.path))], [`/repos/${CENTRAL_OF_PRESET}/actions/variables/${entry.stateVariable}`]);
  });
}

const TERMINAL = [
  ["already-merged", "noop-304", (head) => ({ lastMergedUpstreamSha: head })],
  ["already-noop", "noop-304", (head) => ({ lastNoopHeadSha: head })],
  ["dismissed", "noop-dismissed-pr", (head) => ({ dismissedTargetSha: head })],
  ["blocked", "noop-blocked-sha", (head) => ({ failedTargetSha: head, failedAttempts: 2, blockedTargetSha: head })],
  ["in-flight", "noop-304", (head) => ({ inFlightRunId: 4242, inFlightTargetSha: head })],
  ["open-pr-covers", "noop-304", (head) => ({ openPrNumber: 7, openPrTargetSha: head })],
];

for (const key of Object.keys(WORKFLOW_FILE)) {
  test(`AC66 AC18 ${key}: every terminal comparison reaches its noop, with no dispatch and no preflight`, async (t) => {
    const entry = byKey[key];
    for (const [label, action, overrides] of TERMINAL) {
      const head = headOf(key);
      const stored = state({ portfolioMainSha: MAIN, ...overrides(head) }, entry);
      const downstream = {
        // a cursor that moved off the seed is a world in which a cascade pull request has merged: the downstream's main has the provenance file that records it (AC14)
        ...(label === "already-merged" ? { files: { [entry.provenanceFile]: JSON.stringify({ commit: head }) } } : {}),
        ...(label === "open-pr-covers" ? { pulls: { 7: { number: 7, state: "open", merged: false, html_url: "https://github.com/x/y/pull/7", head: { ref: entry.branchName, sha: sha("pr-head") } } } } : {}),
      };
      const w = world(key, { stored, downstream });
      t.after(() => w.cleanup());
      w.stub.repo(CENTRAL_OF_PRESET, { runs: { 4242: { id: 4242, status: "queued", conclusion: null } } });
      const fake = drifting(key);
      const result = await w.go({ preflightDeps: fake.deps });
      assert.equal(result.code, 0, `${key}/${label}: ${result.stderr}`);
      const [decision] = w.decisions();
      assert.equal(decision.action, action, `${key}/${label}`);
      assert.equal(decision.dispatchedWorkflowId, null, `${key}/${label}`);
      assert.equal(decision.upstreamRepo, entry.upstreamRepo);
      assert.equal(decision.targetSha, head);
      assert.equal(w.stub.world.dispatches.length, 0, `${key}/${label}: nothing is dispatched`);
      assert.equal(fake.calls.length, 0, `${key}/${label}: no preflight runs for a target that a terminal comparison decided`);
      assert.deepEqual(w.stub.calls("POST").filter((request) => !request.path.startsWith("/app/")), [], `${key}/${label}: no write other than the token exchange`);
    }
  });
}

test("AC66 the state fixtures are the states that these scenarios start from: the seed of an edge is the fixture seed, with its own baseline", () => {
  const seed = readJson(fixture("state", "valid-seed.json"));
  for (const entry of matrix) {
    const derived = state({}, entry);
    assert.deepEqual(Object.keys(derived), Object.keys(seed), "the same fourteen fields, in the same order");
    assert.equal(derived.lastMergedUpstreamSha, entry.initialBaselineSha);
    assert.equal(derived.lastObservedHeadSha, entry.initialBaselineSha);
    assert.equal(derived.etag, seed.etag);
    assert.equal(derived.failedAttempts, seed.failedAttempts);
  }
});
