// The six preset edges of sdlc.yaml, routed as the committed router hands them to the script (the entries of its matrix) against fixtures (SPEC-03 AC66, AC18, AC24, AC34):
// gh-admin-msft and the repository itself (ai-sdlc) dispatch a mechanical workflow, the other three dispatch their AI workflow with previous_sha at the merge cursor, and every terminal comparison of
// AC18 ends in the noop that it names, for each edge, with nothing dispatched and nothing but the specified fields written.
//
// The router is the engine's, and it knows no kind of command: what each edge checks, which scope a drift of each check asks for, and which classifier judges a report is
// DATA of sdlc.yaml (preflightCommands and preflightChecks), so the tests below route the edges as the manifest declares them. The processes are fakes that answer for exactly those
// commands (tests/s3/helpers/fake-preflight.mjs); what the classifiers themselves decide is tested in tests/classify-*.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { presetManifest } from "../helpers/instance.mjs";
import { declaredPreflight, expanded, nativePath } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, fixture, presetEdges, readJson, routerMatrixEntries, sha, state } from "./helpers/fixtures.mjs";

const matrix = routerMatrixEntries();
const manifest = presetEdges();
const byKey = Object.fromEntries(matrix.map((entry) => [entry.upstreamKey, entry]));
const declaredOf = (entry) => manifest.find((edge) => edge.upstreamKey === entry.upstreamKey);
const WORKFLOW_FILE = {
  "gh-admin-msft": "cascade-mechanical-ghec-admin.lock.yml",
  "copilot-lab": "cascade-ai-copilot-lab.lock.yml",
  "pipeline-showcase": "cascade-ai-pipeline-showcase.lock.yml",
  "github-intermediate": "cascade-ai-github-intermediate.lock.yml",
  "ai-sdlc": "cascade-mechanical-ai-sdlc.lock.yml",
};
const MAIN = sha("downstream-main");
const headOf = (key) => sha(`head-of-${key}`);
const CENTRAL_OF_PRESET = "johnhain-msft/mfg_msft_ai_sdlc";

// The scripts that the commands and the classifiers of the edges name: the router refuses a node script that is not in the workspace, so the workspace of a test has them.
const scriptOf = (command) => /\$GITHUB_WORKSPACE\/([^"]+\.mjs)/.exec(command)?.[1];
const scriptPaths = [...new Set(manifest.flatMap((edge) => [...edge.preflightCommands, ...(edge.preflightChecks ?? []).map((check) => check.classifier ?? "")]).map(scriptOf).filter(Boolean))];
const scripts = Object.fromEntries(scriptPaths.map((file) => [file, fs.readFileSync(abs(file), "utf8")]));

function world(key, { stored, upstream = {}, downstream = {} } = {}) {
  const entry = byKey[key];
  return routerWorld({
    central: CENTRAL_OF_PRESET,
    edge: entry,
    manifestEdges: manifest,
    manifestExtra: { factory: presetManifest().factory },
    state: stored ?? state({ portfolioMainSha: MAIN }, entry),
    upstream: { head: headOf(key), ...upstream },
    downstream: { head: MAIN, ...downstream },
    workspaceFiles: scripts,
  });
}

test("AC66 the committed router has the five preset edges, and the workflow file of each dispatch exists on disk", () => {
  assert.deepEqual(matrix.map((entry) => entry.upstreamKey), ["gh-admin-msft", "copilot-lab", "pipeline-showcase", "github-intermediate", "ai-sdlc"]);
  assert.deepEqual(matrix.map((entry) => entry.upstreamKey), manifest.map((entry) => entry.upstreamKey));
  for (const [key, file] of Object.entries(WORKFLOW_FILE)) assert.equal(fs.existsSync(abs(".github", "workflows", file)), true, `${key}: ${file}`);
});

test("AC66 the scripts that the preflight of the edges names are the three of this repository, each a file of scripts/", () => {
  assert.deepEqual(scriptPaths.sort(), ["scripts/classify-showcase-runs.mjs", "scripts/classify-workshop-report.mjs", "scripts/lab-studio-drift.mjs"]);
});

for (const key of Object.keys(WORKFLOW_FILE)) {
  test(`AC66 ${key}: the dispatch decision names the workflow of the edge, previous_sha is the merge cursor and the dispatch is recorded as in flight`, async (t) => {
    const w = world(key);
    t.after(() => w.cleanup());
    const entry = byKey[key];
    const fake = declaredPreflight(declaredOf(entry));
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
      const fake = declaredPreflight(declaredOf(entry));
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

// ---- what each edge's declared checks ask of the router (SPEC-03 AC24, AC34): the scope of a drift, and the noop of a quiet poll ----------------------------------------------
//
// These expectations are written here and not computed from the manifest: they are the behaviour that the engine used to hard-code for these three edges (the
// workshop report and the studio helper, the runs of the showcase, the plain git diff of the intermediate template), now carried by `preflightChecks`.
const PREFLIGHT = {
  "copilot-lab": [
    { changes: [false, false], noop: "noop-no-material-drift" },
    { changes: [true, false], scope: "workshop-only" },
    { changes: [false, true], scope: "studio-only" },
    { changes: [true, true], scope: "both" },
  ],
  "pipeline-showcase": [
    { changes: [false], noop: "noop-unchanged-snapshot" },
    { changes: [true], scope: "showcase-runs" },
  ],
  "github-intermediate": [
    { changes: [false], noop: "noop-no-material-drift" },
    { changes: [true], scope: "github-intermediate" },
  ],
};

for (const [key, cases] of Object.entries(PREFLIGHT)) {
  test(`AC24 AC34 ${key}: the declared checks decide between a dispatch with the scope of the check that drifted and the noop of the edge`, async (t) => {
    const entry = byKey[key];
    const declared = declaredOf(entry);
    for (const { changes, scope, noop } of cases) {
      const w = world(key);
      t.after(() => w.cleanup());
      const fake = declaredPreflight(declared, changes);
      const result = await w.go({ preflightDeps: fake.deps });
      assert.equal(result.code, 0, `${changes}: ${result.stderr}`);
      const classifiers = (declared.preflightChecks ?? []).flatMap((check) => (check.classifier ? [check.classifier] : []));
      assert.deepEqual(
        fake.scripts().filter((script) => !script.startsWith("npm ci")),
        [...declared.preflightCommands.map(expanded), ...classifiers.map(expanded)],
        `${changes}: the router runs the commands of the edge, and then the classifier of each check that declares one`,
      );
      if (scope !== undefined) {
        const [decision] = w.decisions();
        assert.equal(decision.action, "dispatch-ai-adaptation", `${changes}`);
        assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, scope, `${changes}: the scope of the check that drifted`);
        assert.ok(declared.syncScopes.includes(scope), `${scope} is a scope that the edge declares`);
      } else {
        const [decision] = w.decisions();
        assert.equal(decision.action, noop, `${changes}: the noop that the edge declares`);
        assert.equal(decision.dispatchedWorkflowId, null);
        assert.equal(w.stub.world.dispatches.length, 0);
        assert.equal(w.state().lastNoopHeadSha, headOf(key), "the quiet head is recorded");
        assert.equal(w.state().lastMergedUpstreamSha, entry.initialBaselineSha, "and the merge cursor does not move");
      }
      for (const call of fake.calls.filter((candidate) => candidate.env.SDLC_PREFLIGHT_STDOUT_FILE)) {
        assert.equal(fs.existsSync(nativePath(call.env.SDLC_PREFLIGHT_STDOUT_FILE)), false, "the classifier's report file is removed");
        assert.equal(fs.existsSync(nativePath(call.env.SDLC_PREFLIGHT_STDERR_FILE)), false);
      }
    }
  });
}

test("AC34 the edges that declare no preflight run nothing: the two mechanical edges", async (t) => {
  for (const key of ["gh-admin-msft", "ai-sdlc"]) {
    const entry = byKey[key];
    assert.deepEqual([declaredOf(entry).preflightCommands, declaredOf(entry).preflightChecks ?? []], [[], []], key);
    const w = world(key);
    t.after(() => w.cleanup());
    const fake = declaredPreflight(declaredOf(entry));
    assert.equal((await w.go({ preflightDeps: fake.deps })).code, 0);
    assert.deepEqual(fake.calls, [], `${key}: no process is started`);
  }
});
