// AC22, AC23 and AC27: the contract between SPEC-03's router (the sender) and the three AI workflows (the receivers): the file names that are dispatched, workflow_dispatch and the
// bot allowlist in each compiled lock, the ten string inputs, and the job set that a dispatched run reports. The router is run for real against its local GitHub stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { routerWorld } from "../s3/helpers/harness.mjs";
import { edge as edgeFixture, presetEdges, routerMatrixEntries, seedState, sha } from "../s3/helpers/fixtures.mjs";
import { abs } from "./helpers/fixtures.mjs";
import { AI, WORKFLOW_DIR, lockOf, lockTextOf, workflowOf } from "./helpers/workflows.mjs";

const FILES = ["cascade-ai-copilot-lab.lock.yml", "cascade-ai-pipeline-showcase.lock.yml", "cascade-ai-github-intermediate.lock.yml"];
const TEN = ["correlation_id", "upstream_repo", "previous_sha", "upstream_sha", "upstream_etag", "upstream_pr_number", "downstream_repo", "sync_scope", "on_commit_only_advance", "dry_run"];

/** One routed event for a preset edge, as the router dispatches it. */
async function dispatched(spec, t) {
  const entry = presetEdges().find((candidate) => candidate.edgeId === spec.edgeId);
  const matrix = routerMatrixEntries().find((candidate) => candidate.upstreamKey === entry.upstreamKey);
  const edge = edgeFixture({ ...matrix, upstreamRepo: "initech/up", downstreamRepo: "acme/portal", preflightCommands: [] });
  const router = routerWorld({ edge, event: "schedule", payload: undefined, manifestEdges: [edge], state: seedState(edge), upstream: { head: sha(`head-of-${spec.upstreamKey}`) } });
  t.after(() => router.cleanup());
  const result = await router.go();
  assert.equal(result.code, 0, result.stderr);
  const [dispatch] = router.stub.world.dispatches;
  assert.ok(dispatch, `${spec.id}: the router dispatched`);
  return dispatch;
}

test("AC22: the three compiled workflows exist under exactly the names that the router dispatches, each dispatchable and holding the bot allowlist of the App", () => {
  for (const [index, spec] of AI.entries()) {
    assert.equal(`${spec.id}.lock.yml`, FILES[index]);
    assert.ok(fs.existsSync(abs(WORKFLOW_DIR, FILES[index])), FILES[index]);
    const lock = lockOf(spec);
    assert.ok("workflow_dispatch" in lock.on, `${spec.id}: workflow_dispatch`);
    const text = lockTextOf(spec);
    assert.ok(text.includes('GH_AW_ALLOWED_BOTS: "fixture-app[bot]"'), `${spec.id}: the activation job checks the bots`);
    assert.deepEqual(workflowOf(spec).frontmatter.on.bots, ["fixture-app[bot]"], `${spec.id}: on.bots in the source`);
  }
});

for (const spec of AI) {
  test(`AC22 ${spec.id}: the router dispatches this workflow file with ref main, return_run_details true, the API version header and the body of ten string inputs`, async (t) => {
    const dispatch = await dispatched(spec, t);
    assert.equal(dispatch.file, `${spec.id}.lock.yml`);
    assert.ok(FILES.includes(dispatch.file));
    assert.equal(dispatch.body.ref, "main");
    assert.equal(dispatch.body.return_run_details, true);
    assert.equal(dispatch.headers["x-github-api-version"], "2022-11-28");
    assert.match(dispatch.headers.authorization, /^Bearer ghs_/, "the App installation token");
    assert.deepEqual(Object.keys(dispatch.body.inputs).sort(), [...TEN].sort(), "no eleventh input is sent");
    for (const [name, value] of Object.entries(dispatch.body.inputs)) assert.equal(typeof value, "string", `${name} is a string at the dispatch boundary`);
    // every input that the router sends is declared by the workflow, and the other way round
    const declared = Object.keys(workflowOf(spec).frontmatter.on.workflow_dispatch.inputs).sort();
    assert.deepEqual(declared, Object.keys(dispatch.body.inputs).sort(), "what is sent is what is declared");
  });
}

test("AC23: each workflow declares exactly the ten string inputs; the compiled lock adds only the compiler's reserved aw_context", () => {
  for (const spec of AI) {
    const authored = workflowOf(spec).frontmatter.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(authored).sort(), [...TEN].sort(), `${spec.id}: the source`);
    for (const name of TEN) assert.equal(authored[name].type, "string", `${spec.id}.${name}`);
    const compiled = lockOf(spec).on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(compiled).filter((name) => name !== "aw_context").sort(), [...TEN].sort(), `${spec.id}: the lock`);
    assert.deepEqual(Object.keys(compiled).filter((name) => !TEN.includes(name)), ["aw_context"], `${spec.id}: the one input that gh-aw reserves for itself`);
    for (const name of TEN) assert.equal(compiled[name].type, "string", `${spec.id}.${name} (lock)`);
    assert.equal(compiled.aw_context.required, false, "the reserved input is optional, so the router need not send it");
  }
});

test("AC27: the job set that a dispatched run reports is the generated jobs and the two custom ones, for every workflow", () => {
  for (const spec of AI) {
    const names = Object.keys(lockOf(spec).jobs).sort();
    for (const name of ["activation", "agent", "detection", "safe_outputs", "finalize_poll_state", "escalate_failure"]) assert.ok(names.includes(name), `${spec.id} has ${name}`);
    assert.ok(names.includes("conclusion"), `${spec.id}: the conclusion job reports the outcome`);
  }
});
