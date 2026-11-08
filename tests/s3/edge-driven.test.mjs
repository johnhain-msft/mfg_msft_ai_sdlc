// The scripts are driven by the edge, not by names that they know (SPEC-03 AC5): every repository, key, slug, branch, variable and workflow that a request names is
// one of the edge's own, whatever the edge is. The edges here are synthetic (none of the fleet's names appears in them), the scripts run against a manifest of them, and
// every request, body and header is searched for a name of the fleet.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { routerWorld } from "./helpers/harness.mjs";
import { flagsFor, invoke, PR_HEAD, TARGET, world as pollWorld } from "./helpers/poll-state-world.mjs";
import { abs, edge, mechanicalEdge, REPO_ROOT, sha, state } from "./helpers/fixtures.mjs";

const FLEET = /johnhain-msft|ms-mfg-community|githubschool|gh-admin-msft|day-in-the-life|copilot-lab|pipeline-showcase|github-intermediate|\bportfolio\b|ghec-admin|COPILOT_LAB|GH_ADMIN|PIPELINE_SHOWCASE|GITHUB_INTERMEDIATE/i;

const aiEdge = () =>
  edge({
    edgeId: "zeta-sync",
    upstreamRepo: "zeta-labs/zeta-upstream",
    upstreamKey: "zeta-up",
    upstreamSlug: "ZETA_UP",
    upstreamDefaultBranch: "release/2",
    downstreamRepo: "acme/zeta-site",
    stateVariable: "SDLC_SYNC_STATE_ZETA_UP",
    provenanceFile: "zeta/provenance.json",
    provenanceJsonPointer: "/source/revision",
    branchName: "bots/zeta-cascade",
    closeOlderKey: "bots-zeta-cascade",
    reviewers: ["zeta-reviewer"],
  });
const mechanical = () =>
  mechanicalEdge({
    edgeId: "omega-import",
    upstreamRepo: "omega-labs/omega-source",
    upstreamKey: "omega-up",
    upstreamSlug: "OMEGA_UP",
    upstreamDefaultBranch: "stable",
    downstreamRepo: "acme/omega-site",
    stateVariable: "SDLC_SYNC_STATE_OMEGA_UP",
    provenanceFile: "omega/source.json",
    branchName: "bots/omega-cascade",
    closeOlderKey: "bots-omega-cascade",
  });

const everything = (w) => w.stub.requests.map((request) => `${request.method} ${request.url} ${JSON.stringify(request.headers)} ${request.body ?? ""}`).join("\n");

test("AC5 the router names only the edge's own repositories, branch, variable and workflow, for an ai-adaptation edge and a mechanical edge that are not the fleet's", async (t) => {
  for (const [e, workflow, upstreamHead] of [
    [aiEdge(), "cascade-ai-zeta-sync.lock.yml", sha("zeta-head")],
    [mechanical(), "cascade-mechanical-omega-import.lock.yml", sha("omega-head")],
  ]) {
    const w = routerWorld({
      central: "acme/orchestrator",
      edge: e,
      state: state({}, e),
      upstream: { head: upstreamHead },
      downstream: { files: { [e.provenanceFile]: JSON.stringify({ commit: e.initialBaselineSha, source: { revision: e.initialBaselineSha } }) } },
    });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 0, `${e.upstreamKey}: ${result.stderr}`);
    const text = everything(w);
    assert.equal(FLEET.test(text), false, `${e.upstreamKey}: a name of the fleet reached a request: ${FLEET.exec(text)?.[0]}`);
    const paths = w.stub.requests.map((request) => request.path);
    assert.ok(paths.includes(`/repos/${e.upstreamRepo}/commits/${e.upstreamDefaultBranch}`), "the upstream is polled on the edge's default branch");
    assert.ok(paths.some((entry) => entry.startsWith(`/repos/${e.downstreamRepo}/contents/${e.provenanceFile}`)), "the provenance file of the edge is read in the edge's downstream");
    assert.ok(paths.includes(`/repos/acme/orchestrator/actions/variables/${e.stateVariable}`));
    assert.deepEqual(w.stub.world.dispatches.map((dispatch) => dispatch.file), [workflow]);
    assert.equal(w.stub.world.dispatches[0].body.inputs.upstream_repo, e.upstreamRepo);
    assert.equal(w.stub.world.dispatches[0].body.inputs.downstream_repo, e.downstreamRepo);
    assert.equal(w.stub.world.dispatches[0].body.inputs.previous_sha, e.initialBaselineSha, "the merge cursor came from the provenance file of the edge");
    assert.deepEqual(w.decisions()[0].dispatchedWorkflowId, workflow);
    assert.equal(w.decisions()[0].upstreamRepo, e.upstreamRepo);
  }
});

test("AC5 the provenance pointer of the edge selects the merge cursor, whatever its shape", async (t) => {
  const e = aiEdge();
  const recorded = sha("recorded-by-the-downstream");
  const w = routerWorld({
    edge: e,
    state: state({}, e),
    upstream: { head: sha("zeta-head") },
    downstream: { files: { [e.provenanceFile]: JSON.stringify({ commit: sha("wrong"), source: { revision: recorded } }) } },
  });
  t.after(() => w.cleanup());
  assert.equal((await w.go()).code, 0);
  assert.equal(w.stub.world.dispatches[0].body.inputs.previous_sha, recorded, "/source/revision, not /commit");
});

test("AC5 the poll-state script, given another slug, reads and writes the variable, branch and repository of that edge only", async (t) => {
  for (const e of [aiEdge(), mechanical()]) {
    // the provenance file of the pull request has the shape that the edge's own pointer names
    const pointerParts = e.provenanceJsonPointer.split("/").slice(1);
    const recorded = pointerParts.reduceRight((inner, key) => ({ [key]: inner }), TARGET);
    const w = pollWorld({ edgeValue: e, files: { [PR_HEAD]: { [e.provenanceFile]: JSON.stringify(recorded) } } });
    t.after(() => w.workspace.cleanup());
    const result = await invoke(w, flagsFor(e));
    assert.equal(result.code, 0, `${e.upstreamSlug}: ${result.stderr}`);
    assert.equal(FLEET.test(everything(w)), false, `${e.upstreamSlug}: ${FLEET.exec(everything(w))?.[0]}`);
    assert.deepEqual(w.stub.calls("PATCH").map((request) => request.path), [`/repos/acme/orchestrator/actions/variables/${e.stateVariable}`]);
    assert.ok(w.stub.requests.some((request) => request.path === `/repos/${e.downstreamRepo}/pulls` && decodeURIComponent(request.url).includes(`head=${e.downstreamRepo.split("/")[0]}:${e.branchName}`)), "the pull request of the edge's branch");
  }
});

test("AC5 rg for the fleet's repository names finds nothing in the two scripts or in the modules that they use", () => {
  const files = [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
  const names = /johnhain-msft|ms-mfg-community|githubschool/;
  for (const file of files) assert.equal(names.test(fs.readFileSync(file, "utf8")), false, path.relative(REPO_ROOT, file));
  // nor a branch name, an upstream key or a SHA of the preset
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/sdlc\/cascade-|"gh-admin-msft"|"copilot-lab"|[0-9a-f]{40}/.test(text), false, path.relative(REPO_ROOT, file));
  }
});

test("AC5 an edge that the router is not given is not routed: a wrong UPSTREAM_KEY and a missing field fail before any dispatch or write", async (t) => {
  const e = aiEdge();
  const wrongKey = routerWorld({ edge: e, env: { UPSTREAM_KEY: "elsewhere" } });
  const { initialBaselineSha: _removed, ...incomplete } = e;
  const missing = routerWorld({ edge: e, env: { EDGE_JSON: JSON.stringify(incomplete) } });
  t.after(() => {
    wrongKey.cleanup();
    missing.cleanup();
  });
  for (const w of [wrongKey, missing]) {
    const result = await w.go();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(w.stub.world.dispatches.length, 0);
    assert.equal(w.patches().length, 0);
  }
});
