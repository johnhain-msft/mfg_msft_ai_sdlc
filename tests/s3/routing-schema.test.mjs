// schemas/sdlc-routing.schema.json (SPEC-03 AC9, AC13, AC24, AC35, AC38, AC60, AC65): every shape that the S3 scripts exchange, validated against the
// fixtures under tests/s3/fixtures/ and against the data that S1 and S5 actually produce (the seed of the bootstrap, the matrix of the committed router).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { validateShape } from "../../src/routing/schema.mjs";
import { SYNC_STATE_FIELDS, parseSyncState, validateSyncState } from "../../src/routing/sync-state.mjs";
import { abs, edge, fixture, mechanicalEdge, presetEdges, readJson, readText, routerMatrixEntries, seedState, sha } from "./helpers/fixtures.mjs";

const valid = (name, value) => {
  const result = validateShape(name, value);
  assert.deepEqual(result.errors, [], `${name} should accept ${JSON.stringify(value).slice(0, 120)}`);
};
const invalid = (name, value, expected) => {
  const result = validateShape(name, value);
  assert.equal(result.valid, false, `${name} should reject ${JSON.stringify(value).slice(0, 160)}`);
  if (expected) assert.match(result.errors.join("\n"), expected);
};
const listJson = (directory, prefix) => fs.readdirSync(fixture(directory)).filter((name) => name.startsWith(prefix)).sort();

test("the schema file defines every shape of the contracts under $defs", () => {
  const schema = readJson(abs("schemas", "sdlc-routing.schema.json"));
  for (const name of ["SyncState", "UpstreamMergeClientPayload", "MergeRoutingDecision", "AiCascadeDispatchInputs", "MechanicalDispatchInputs", "WorkflowDispatchRunDetails", "PortfolioMechanicalCascadeResult", "RouterEdge", "ManifestEdge"]) {
    assert.ok(schema.$defs[name], name);
  }
  assert.equal(schema.$defs.SyncState.additionalProperties, false);
  assert.equal(schema.$defs.SyncState.required.length, 14);
  assert.deepEqual([...schema.$defs.SyncState.required].sort(), [...SYNC_STATE_FIELDS].sort());
});

// ---- AC13: SyncState ----------------------------------------------------------------------------------------------------------------------

test("AC13 every fixtures/state/valid-*.json validates, including valid-seed.json, the seed that the bootstrap writes", () => {
  const files = listJson("state", "valid-");
  assert.ok(files.includes("valid-seed.json") && files.length >= 2);
  for (const name of files) {
    const value = readJson(fixture("state", name));
    valid("SyncState", value);
    assert.deepEqual(Object.keys(value).sort(), [...SYNC_STATE_FIELDS].sort(), name);
    assert.doesNotThrow(() => validateSyncState(value), name);
  }
});

test("AC13 valid-seed.json is exactly the seed that the bootstrap (S5) writes for the baseline, with etag empty and everything else null or zero", () => {
  const seed = readJson(fixture("state", "valid-seed.json"));
  const written = initialSyncState(seed.lastMergedUpstreamSha, seed.updatedAt);
  assert.deepEqual(seed, written);
  assert.equal(seed.etag, "");
  assert.equal(seed.lastObservedHeadSha, seed.lastMergedUpstreamSha);
  for (const field of ["portfolioMainSha", "lastNoopHeadSha", "dismissedTargetSha", "failedTargetSha", "blockedTargetSha", "inFlightRunId", "inFlightTargetSha", "openPrTargetSha", "openPrNumber"]) assert.equal(seed[field], null, field);
  assert.equal(seed.failedAttempts, 0);
  assert.deepEqual(seedState(edge(), seed.updatedAt), initialSyncState(edge().initialBaselineSha, seed.updatedAt), "the fixture helper agrees with the bootstrap");
});

test("AC13 every fixtures/state/invalid-*.json is rejected: 13 fields, 15 fields, a string run id, a negative counter, a non-UTC timestamp", () => {
  const files = listJson("state", "invalid-");
  assert.deepEqual(files, ["invalid-13-fields.json", "invalid-15-fields.json", "invalid-negative-failed-attempts.json", "invalid-non-utc-updated-at.json", "invalid-string-run-id.json"]);
  for (const name of files) {
    invalid("SyncState", readJson(fixture("state", name)));
    assert.throws(() => parseSyncState(readText(fixture("state", name)), name), /not a valid SyncState/, name);
  }
});

test("AC13 each nullable field takes its type or null, and nothing else; failedAttempts is a non-negative integer; etag may be empty", () => {
  const base = readJson(fixture("state", "valid-seed.json"));
  const nullable = { portfolioMainSha: sha("a"), lastNoopHeadSha: sha("b"), dismissedTargetSha: sha("c"), failedTargetSha: sha("d"), blockedTargetSha: sha("e"), inFlightTargetSha: sha("f"), openPrTargetSha: sha("g") };
  for (const [field, value] of Object.entries(nullable)) {
    valid("SyncState", { ...base, [field]: value, ...(field === "inFlightTargetSha" ? { inFlightRunId: 1 } : {}), ...(field === "openPrTargetSha" ? { openPrNumber: 1 } : {}) });
    invalid("SyncState", { ...base, [field]: 7 });
    invalid("SyncState", { ...base, [field]: "abc" }, undefined);
    invalid("SyncState", { ...base, [field]: undefined });
  }
  valid("SyncState", { ...base, inFlightRunId: 12, inFlightTargetSha: sha("x") });
  invalid("SyncState", { ...base, inFlightRunId: 0, inFlightTargetSha: sha("x") });
  invalid("SyncState", { ...base, inFlightRunId: 1.5, inFlightTargetSha: sha("x") });
  invalid("SyncState", { ...base, openPrNumber: "7", openPrTargetSha: sha("x") });
  for (const attempts of [0, 1, 2, 9]) valid("SyncState", { ...base, failedAttempts: attempts });
  for (const attempts of [-1, 1.5, "1", null]) invalid("SyncState", { ...base, failedAttempts: attempts });
  valid("SyncState", { ...base, etag: "" });
  valid("SyncState", { ...base, etag: 'W/"abc"' });
  invalid("SyncState", { ...base, etag: null });
});

test("AC13 updatedAt is an ISO-8601 UTC timestamp that names a real date: an offset, a date without time and 30 February are rejected", () => {
  const base = readJson(fixture("state", "valid-seed.json"));
  for (const stamp of ["2026-11-05T12:00:00Z", "2026-11-05T12:00:00.123Z", "2024-02-29T23:59:59Z"]) {
    valid("SyncState", { ...base, updatedAt: stamp });
    assert.doesNotThrow(() => validateSyncState({ ...base, updatedAt: stamp }));
  }
  for (const stamp of ["2026-11-05T12:00:00+00:00", "2026-11-05T12:00:00-05:00", "2026-11-05", "2026-11-05T12:00:00", "yesterday", 1730808000]) invalid("SyncState", { ...base, updatedAt: stamp });
  for (const stamp of ["2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T10:00:00Z"]) assert.throws(() => validateSyncState({ ...base, updatedAt: stamp }), /not a real UTC timestamp/, stamp);
});

test("AC13 a state whose pairs disagree (a run id without its sha, a pull request number without its sha) was written by no script and is rejected", () => {
  const base = readJson(fixture("state", "valid-seed.json"));
  assert.throws(() => validateSyncState({ ...base, inFlightRunId: 5 }), /inFlightRunId without inFlightTargetSha/);
  assert.throws(() => validateSyncState({ ...base, inFlightTargetSha: sha("x") }), /inFlightRunId without inFlightTargetSha/);
  assert.throws(() => validateSyncState({ ...base, openPrNumber: 5 }), /openPrNumber without openPrTargetSha/);
  assert.throws(() => validateSyncState({ ...base, openPrTargetSha: sha("x") }), /openPrNumber without openPrTargetSha/);
});

test("AC13 parseSyncState refuses text that is not JSON and returns the fields in serialisation order", () => {
  assert.throws(() => parseSyncState("{nope"), /is not JSON/);
  assert.throws(() => parseSyncState(""), /is not JSON/);
  const shuffled = Object.fromEntries(Object.entries(readJson(fixture("state", "valid-seed.json"))).reverse());
  assert.deepEqual(Object.keys(parseSyncState(JSON.stringify(shuffled))), [...SYNC_STATE_FIELDS]);
});

// ---- AC9: the client payload of the bridge signal -----------------------------------------------------------------------------------------

test("AC9 fixtures/signal/valid.json is accepted; a missing, an extra and a mistyped property are rejected", () => {
  const good = readJson(fixture("signal", "valid.json"));
  valid("UpstreamMergeClientPayload", good);
  assert.deepEqual(Object.keys(good).sort(), ["correlation_id", "default_branch", "merged_at", "merged_sha", "pr_number", "upstream_repo"], "exactly six properties");
  invalid("UpstreamMergeClientPayload", readJson(fixture("signal", "invalid-missing-merged-at.json")), /merged_at/);
  invalid("UpstreamMergeClientPayload", readJson(fixture("signal", "invalid-extra-property.json")), /title/);
  invalid("UpstreamMergeClientPayload", readJson(fixture("signal", "invalid-pr-number-string.json")), /pr_number/);
  invalid("UpstreamMergeClientPayload", readJson(fixture("signal", "invalid-short-merged-sha.json")), /merged_sha/);
});

test("AC9 every property of the payload is required and typed", () => {
  const good = readJson(fixture("signal", "valid.json"));
  for (const key of Object.keys(good)) {
    const { [key]: removed, ...rest } = good;
    invalid("UpstreamMergeClientPayload", rest, new RegExp(key));
  }
  for (const [key, value] of [["pr_number", 0], ["pr_number", -3], ["pr_number", 1.5], ["pr_number", null], ["correlation_id", 12], ["correlation_id", ""], ["correlation_id", "has space"], ["upstream_repo", "no-slash"], ["upstream_repo", 5], ["default_branch", ""], ["merged_at", "2026-11-05"], ["merged_at", 12345], ["merged_sha", sha("x").toUpperCase()]]) {
    invalid("UpstreamMergeClientPayload", { ...good, [key]: value });
  }
  valid("UpstreamMergeClientPayload", { ...good, merged_at: "2026-11-05T12:00:00+01:00", default_branch: "release/1.0" });
});

// ---- AC24: the routing decision ---------------------------------------------------------------------------------------------------------------

const decision = (overrides = {}) => ({ correlationId: "run-1-1", upstreamRepo: "initech/widgets", previousSha: sha("a"), targetSha: sha("b"), action: "noop-304", dispatchedWorkflowId: null, ...overrides });

test("AC24 all eight actions are accepted, a ninth string is rejected, and a non-null dispatchedWorkflowId on a noop is rejected", () => {
  const noops = ["noop-304", "noop-already-synced", "noop-no-material-drift", "noop-unchanged-snapshot", "noop-dismissed-pr", "noop-blocked-sha"];
  for (const action of noops) {
    valid("MergeRoutingDecision", decision({ action }));
    invalid("MergeRoutingDecision", decision({ action, dispatchedWorkflowId: "cascade-ai-x.lock.yml" }));
  }
  valid("MergeRoutingDecision", decision({ action: "dispatch-mechanical", dispatchedWorkflowId: "cascade-mechanical-ghec-admin.lock.yml" }));
  valid("MergeRoutingDecision", decision({ action: "dispatch-ai-adaptation", dispatchedWorkflowId: "cascade-ai-copilot-lab.lock.yml" }));
  invalid("MergeRoutingDecision", decision({ action: "dispatch-mechanical", dispatchedWorkflowId: null }));
  invalid("MergeRoutingDecision", decision({ action: "noop-skipped" }));
  invalid("MergeRoutingDecision", decision({ action: "dispatch" }));
});

test("AC24 the decision has exactly six properties, with full shas and a slug", () => {
  invalid("MergeRoutingDecision", { ...decision(), extra: 1 });
  for (const key of Object.keys(decision())) {
    const { [key]: removed, ...rest } = decision();
    invalid("MergeRoutingDecision", rest);
  }
  invalid("MergeRoutingDecision", decision({ previousSha: "abc" }));
  invalid("MergeRoutingDecision", decision({ targetSha: null }));
  invalid("MergeRoutingDecision", decision({ upstreamRepo: "nope" }));
});

// ---- AC35, AC65: the dispatch inputs -----------------------------------------------------------------------------------------------------------

const aiInputs = (overrides = {}) => ({
  correlation_id: "run-1-1",
  upstream_repo: "initech/widgets",
  previous_sha: sha("p"),
  upstream_sha: sha("u"),
  upstream_etag: 'W/"x"',
  upstream_pr_number: "42",
  downstream_repo: "acme/portal",
  sync_scope: "both",
  on_commit_only_advance: "noop",
  dry_run: "false",
  ...overrides,
});

test("AC35 the ten inputs: exactly ten keys, all strings, both enums closed", () => {
  valid("AiCascadeDispatchInputs", aiInputs());
  assert.equal(Object.keys(aiInputs()).length, 10);
  for (const scope of ["both", "workshop-only", "studio-only", "showcase-runs", "github-intermediate"]) valid("AiCascadeDispatchInputs", aiInputs({ sync_scope: scope }));
  for (const advance of ["noop", "bump-provenance"]) valid("AiCascadeDispatchInputs", aiInputs({ on_commit_only_advance: advance }));
  invalid("AiCascadeDispatchInputs", aiInputs({ sync_scope: "everything" }));
  invalid("AiCascadeDispatchInputs", aiInputs({ on_commit_only_advance: "bump" }));
  invalid("AiCascadeDispatchInputs", { ...aiInputs(), extra: "x" });
  for (const key of Object.keys(aiInputs())) {
    const { [key]: removed, ...rest } = aiInputs();
    invalid("AiCascadeDispatchInputs", rest);
    invalid("AiCascadeDispatchInputs", aiInputs({ [key]: 7 }));
    invalid("AiCascadeDispatchInputs", aiInputs({ [key]: null }));
    invalid("AiCascadeDispatchInputs", aiInputs({ [key]: false }));
  }
  valid("AiCascadeDispatchInputs", aiInputs({ upstream_pr_number: "" }));
  invalid("AiCascadeDispatchInputs", aiInputs({ upstream_pr_number: "0" }));
  invalid("AiCascadeDispatchInputs", aiInputs({ upstream_pr_number: "12a" }));
  invalid("AiCascadeDispatchInputs", aiInputs({ previous_sha: "abc" }));
});

test("AC65 the mechanical dispatch has the eight inputs of AC35 without sync_scope and on_commit_only_advance", () => {
  const { sync_scope, on_commit_only_advance, ...mechanical } = aiInputs();
  valid("MechanicalDispatchInputs", mechanical);
  assert.equal(Object.keys(mechanical).length, 8);
  invalid("MechanicalDispatchInputs", aiInputs());
  invalid("MechanicalDispatchInputs", { ...mechanical, sync_scope: "both" });
});

// ---- AC38: the dispatch response ---------------------------------------------------------------------------------------------------------------

test("AC38 WorkflowDispatchRunDetails needs a numeric workflow_run_id, a run_url and an html_url", () => {
  const good = { workflow_run_id: 9001, run_url: "https://api.github.com/repos/o/r/actions/runs/9001", html_url: "https://github.com/o/r/actions/runs/9001" };
  valid("WorkflowDispatchRunDetails", good);
  valid("WorkflowDispatchRunDetails", { ...good, extra_field_added_later: true });
  for (const id of ["9001", 0, -1, 1.5, null, undefined]) invalid("WorkflowDispatchRunDetails", { ...good, workflow_run_id: id });
  invalid("WorkflowDispatchRunDetails", { run_url: good.run_url, html_url: good.html_url });
  invalid("WorkflowDispatchRunDetails", { ...good, run_url: undefined });
  invalid("WorkflowDispatchRunDetails", {});
  invalid("WorkflowDispatchRunDetails", null);
});

// ---- AC60: the result of the mechanical cascade --------------------------------------------------------------------------------------------------

test("AC60 PortfolioMechanicalCascadeResult has the five properties, pr-opened or pr-updated, and no other outcome", () => {
  const good = { outcome: "pr-opened", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: sha("h"), openPrTargetSha: sha("t") };
  valid("PortfolioMechanicalCascadeResult", good);
  valid("PortfolioMechanicalCascadeResult", { ...good, outcome: "pr-updated" });
  invalid("PortfolioMechanicalCascadeResult", { ...good, outcome: "noop-no-changes" });
  invalid("PortfolioMechanicalCascadeResult", { ...good, extra: 1 });
  for (const key of Object.keys(good)) {
    const { [key]: removed, ...rest } = good;
    invalid("PortfolioMechanicalCascadeResult", rest);
  }
  invalid("PortfolioMechanicalCascadeResult", { ...good, prNumber: "7" });
  invalid("PortfolioMechanicalCascadeResult", { ...good, headSha: "abc" });
  valid("NoopNoChangesResult", { outcome: "noop-no-changes" });
  invalid("NoopNoChangesResult", { outcome: "noop-no-changes", prNumber: 1 });
});

// ---- the edges that the scripts receive ------------------------------------------------------------------------------------------------------------

test("the router edge accepts every matrix entry of the committed router and rejects a damaged one", () => {
  const entries = routerMatrixEntries();
  assert.equal(entries.length, presetEdges().length);
  for (const entry of entries) valid("RouterEdge", entry);
  const first = entries[0];
  for (const key of ["edgeId", "upstreamRepo", "stateVariable", "preflightCommands", "initialBaselineSha", "provenanceJsonPointer"]) {
    const { [key]: removed, ...rest } = first;
    invalid("RouterEdge", rest, new RegExp(key));
  }
  invalid("RouterEdge", { ...first, initialBaselineSha: "abc" });
  invalid("RouterEdge", { ...first, mode: "manual" });
  invalid("RouterEdge", { ...first, onCommitOnlyAdvance: "ignore" });
  invalid("RouterEdge", { ...first, stateVariable: "1bad" });
  invalid("RouterEdge", { ...first, provenanceJsonPointer: "commit" });
  valid("RouterEdge", edge());
  valid("RouterEdge", mechanicalEdge());
});

test("the manifest edge accepts every edge of sdlc.yaml and needs the keys that the scripts read", () => {
  for (const entry of presetEdges()) valid("ManifestEdge", entry);
  const first = presetEdges()[0];
  for (const key of ["upstreamSlug", "stateVariable", "downstreamRepo", "provenanceJsonPointer", "upstreamDefaultBranch", "mode"]) {
    const { [key]: removed, ...rest } = first;
    invalid("ManifestEdge", rest, new RegExp(key));
  }
  invalid("ManifestEdge", { ...first, syncScopes: ["everything"] });
});
