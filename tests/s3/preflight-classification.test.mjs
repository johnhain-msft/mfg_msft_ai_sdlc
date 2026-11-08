// The classification of the preflight reports (SPEC-03 AC20, AC21, AC28, AC40), case by case, with the shell and the checkouts replaced by a fake that answers from a
// list (tests/s3/helpers/fake-preflight.mjs). tests/s3/router-preflight.test.mjs runs the same preflights with real git and a real bash.
import assert from "node:assert/strict";
import test from "node:test";
import { chooseSyncScope, fillCheckout, parseRunIds, parseStudioResult, parseWorkshopReport, planPreflight, PreflightError } from "../../src/routing/preflight.mjs";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { CHANGED_REPORT, CLEAN_REPORT, DRIFT, IN_SYNC, LAB_COMMANDS, PROBLEM_REPORT, preflightEdge } from "./helpers/preflight-world.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { sha, state } from "./helpers/fixtures.mjs";

const SHA0 = sha("sha0");
const SHA1 = sha("sha1");
const json = (value) => `${JSON.stringify(value)}\n`;

function world(edgeOverrides = {}, { head = SHA1, stateOverrides = {} } = {}) {
  const edge = preflightEdge(edgeOverrides);
  return routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, ...stateOverrides }, edge), upstream: { head }, downstream: { head: sha("main-1") } });
}

const workshop = (code, stdout) => ({ match: /sync:workshop-source/, code, stdout });
const studio = (code, stdout, stderr = "") => ({ match: /lab-studio-drift\.mjs/, code, stdout: typeof stdout === "string" ? stdout : json(stdout), stderr });

async function run(t, responses, edgeOverrides, options) {
  const w = world(edgeOverrides, options);
  t.after(() => w.cleanup());
  const fake = fakePreflight(responses);
  const result = await w.go({ preflightDeps: fake.deps });
  return { w, fake, result };
}

// ---- the readers --------------------------------------------------------------------------------------------------------------------------

test("AC20 parseWorkshopReport reads the summary line and the PROBLEM lines of the printed report, and refuses a report without the summary", () => {
  assert.deepEqual(parseWorkshopReport(CLEAN_REPORT), { checked: 25, changed: 0, added: 0, removed: 0, problems: [] });
  assert.deepEqual(parseWorkshopReport(CHANGED_REPORT), { checked: 25, changed: 2, added: 0, removed: 1, problems: [] });
  assert.deepEqual(parseWorkshopReport(PROBLEM_REPORT).problems, ["anchor: lab07 cites a heading that is gone"]);
  assert.deepEqual(parseWorkshopReport("Inputs checked: 3; changed 1, new 2, gone 3\r\n PROBLEM missing: a\r\n PROBLEM licence: b\r\n"), { checked: 3, changed: 1, added: 2, removed: 3, problems: ["missing: a", "licence: b"] });
  for (const text of ["", "Source revision: abc\n", "Inputs checked: 5; changed 0, new 0\n", "inputs checked: 5; changed 0, new 0, gone 0\n", "  Inputs checked: 5; changed 0, new 0, gone 0\n", `${CLEAN_REPORT}${CLEAN_REPORT}`]) {
    assert.throws(() => parseWorkshopReport(text), PreflightError, JSON.stringify(text));
  }
});

test("AC40 parseStudioResult accepts the JSON of the contract, alone or after other output, and nothing else", () => {
  assert.deepEqual(parseStudioResult(json(IN_SYNC)), IN_SYNC);
  assert.deepEqual(parseStudioResult(`checking\n${JSON.stringify(DRIFT, null, 2)}\n`), DRIFT);
  assert.deepEqual(parseStudioResult(`{"progress":1}\n${json(DRIFT)}`), DRIFT);
  for (const text of ["", "ok", "[]", "{}", json({ ...IN_SYNC, status: "fine" }), json({ status: "in-sync" }), json({ ...IN_SYNC, changedLabs: "lab01" }), json({ ...IN_SYNC, changedLabs: [1] }), json({ ...IN_SYNC, previousCommit: 1 })]) {
    assert.throws(() => parseStudioResult(text), PreflightError, JSON.stringify(text));
  }
});

test("the commands of an edge are read by their shape, and <checkout> is the absolute upstream directory", () => {
  const plan = planPreflight(preflightEdge());
  assert.deepEqual(plan.commands.map((entry) => entry.kind), ["workshop-report", "studio-drift"]);
  assert.equal(plan.lab, true);
  assert.equal(plan.runs, false);
  assert.equal(fillCheckout(LAB_COMMANDS[0]), 'npm run sync:workshop-source -- "$UPSTREAM_DIR"');
  assert.equal(fillCheckout(LAB_COMMANDS[1]).includes("<checkout>"), false);
  const showcase = planPreflight(preflightEdge({ preflightCommands: ['gh api "repos/initech/lab/actions/runs?per_page=100"'], buildCommands: ["node experiences/pipeline-showcase/capture/fetch-run-data.mjs", "npm run build:experiences"] }));
  assert.deepEqual(showcase.commands.map((entry) => entry.kind), ["runs-list"]);
  assert.equal(showcase.runs, true);
  assert.deepEqual(showcase.capture, { command: "node experiences/pipeline-showcase/capture/fetch-run-data.mjs", script: "experiences/pipeline-showcase/capture/fetch-run-data.mjs", dataFile: "experiences/pipeline-showcase/content/run-data.json" });
  const plain = planPreflight(preflightEdge({ preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- labs'] }));
  assert.deepEqual(plain.commands.map((entry) => entry.kind), ["plain"]);
  const other = planPreflight(preflightEdge({ preflightCommands: ["gh api repos/x/y/pulls", "gh api graph/x"] }));
  assert.deepEqual(other.commands.map((entry) => entry.kind), ["plain", "plain"], "only an actions/runs listing is the first half of the snapshot check");
});

test("parseRunIds reads the ids of the RUNS array of a capture script", () => {
  const source = 'const OWNER_REPO = "x/y";\nconst RUNS = [\n  { key: "ci", id: 39781079785, story: "a" },\n  { key: "codeql", id: 39781079636, story: "b" },\n];\nconst other = { id: 5 };\n';
  assert.deepEqual(parseRunIds(source), [39781079785, 39781079636]);
  assert.deepEqual(parseRunIds("no runs here"), []);
});

test("chooseSyncScope keeps a scope that the edge accepts and otherwise names one that it does", () => {
  assert.equal(chooseSyncScope("studio-only", undefined), "studio-only");
  assert.equal(chooseSyncScope("studio-only", []), "studio-only");
  assert.equal(chooseSyncScope("studio-only", ["both", "workshop-only", "studio-only"]), "studio-only");
  assert.equal(chooseSyncScope("studio-only", ["both"]), "both");
  assert.equal(chooseSyncScope("showcase-runs", ["github-intermediate"]), "github-intermediate");
  assert.equal(chooseSyncScope(null, undefined), "both");
});

// ---- the verdicts -------------------------------------------------------------------------------------------------------------------------

test("AC20 the commands are the edge's, run in order from the downstream checkout, the install first, without --accept", async (t) => {
  const { fake, w, result } = await run(t, [workshop(1, CLEAN_REPORT), studio(0, IN_SYNC)]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.scripts(), ["npm ci --include=dev --ignore-scripts", 'npm run sync:workshop-source -- "$UPSTREAM_DIR"', 'node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$TARGET_SHA"']);
  assert.equal(fake.scripts().some((script) => script.includes("--accept")), false);
  assert.equal(fake.checkouts.length, 2);
  assert.deepEqual(fake.checkouts.map((entry) => [entry.slug, entry.sha, entry.history ?? "shallow"]), [["initech/lab", SHA1, "shallow"], ["acme/portfolio", sha("main-1"), "shallow"]]);
  assert.equal(w.decisions()[0].action, "noop-no-material-drift");
  const env = fake.calls[1].env;
  assert.equal(env.TARGET_SHA, SHA1);
  assert.equal(env.LAST_MERGED_SHA, SHA0);
  assert.ok(env.UPSTREAM_DIR.replace(/\\/g, "/").endsWith("/upstream/lab"));
});

test("AC20 rc1 equal to 1 with changed 0, new 0, gone 0 is no drift, and the studio helper alone can still make it drift", async (t) => {
  const quiet = await run(t, [workshop(1, CLEAN_REPORT), studio(0, IN_SYNC)]);
  assert.equal(quiet.w.decisions()[0].action, "noop-no-material-drift");
  const studioOnly = await run(t, [workshop(1, CLEAN_REPORT), studio(1, DRIFT)]);
  assert.equal(studioOnly.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(studioOnly.w.stub.world.dispatches[0].body.inputs.sync_scope, "studio-only");
});

test("AC20 a report that names changed, new or gone inputs, or a PROBLEM, is drift whatever the exit status says", async (t) => {
  for (const [report, code] of [[CHANGED_REPORT, 1], [CHANGED_REPORT, 0], [PROBLEM_REPORT, 1], [PROBLEM_REPORT, 0], ["Inputs checked: 5; changed 0, new 1, gone 0\n", 1], ["Inputs checked: 5; changed 0, new 0, gone 2\n", 1]]) {
    const { w } = await run(t, [workshop(code, report), studio(0, IN_SYNC)]);
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", report);
    assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, "workshop-only");
  }
});

test("AC20 the preflight fails the job, without advancing state, when the summary line is absent, ambiguous, or the command exited abnormally", async (t) => {
  const cases = [
    ["no summary line", workshop(1, "Source revision: abc\nsomething else\n")],
    ["no output", workshop(0, "")],
    ["two summaries", workshop(1, `${CLEAN_REPORT}${CLEAN_REPORT}`)],
    ["garbled summary", workshop(1, "Inputs checked: many; changed none\n")],
    ["exit 127", workshop(127, CLEAN_REPORT)],
    ["exit 2", workshop(2, CLEAN_REPORT)],
    ["could not start", { match: /sync:workshop-source/, code: null, error: "spawn ENOENT" }],
    ["timed out", { match: /sync:workshop-source/, code: null, timedOut: true }],
  ];
  for (const [label, response] of cases) {
    const { w, result } = await run(t, [response, studio(0, IN_SYNC)]);
    assert.equal(result.code, 1, label);
    assert.equal(w.patches().length, 0, label);
    assert.equal(w.stub.world.dispatches.length, 0, label);
    assert.deepEqual(w.state(), state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }), `${label}: the variable is as it was`);
    assert.equal(w.stub.issues.length, 1, label);
    assert.match(w.stub.issues[0].title, /^\[sdlc-failure\] cascade-router \(initech\/lab\)$/);
    assert.deepEqual(w.summaryLines(), []);
  }
});

test("AC20 a PROBLEM line is a line of its own: text that merely contains the word is not one", async (t) => {
  const { w } = await run(t, [workshop(1, "Inputs checked: 3; changed 0, new 0, gone 0\nNo PROBLEM found, nothing to re-read\n  a PROBLEM mentioned in prose\n"), studio(0, IN_SYNC)]);
  assert.equal(w.decisions()[0].action, "noop-no-material-drift");
});

test("AC20 the dependencies of the downstream are installed once and only for a command that uses npm, and a failing install fails the job", async (t) => {
  const failing = await run(t, [{ match: /npm ci/, code: 1, stderr: "ERESOLVE" }, workshop(0, CLEAN_REPORT)]);
  assert.equal(failing.result.code, 1);
  assert.match(failing.result.stderr, /installing the dependencies of acme\/portfolio failed/);
  assert.equal(failing.fake.scripts().filter((script) => script.includes("sync:workshop-source")).length, 0, "no preflight runs without its dependencies");
  const plain = await run(t, [studio(0, IN_SYNC)], { preflightCommands: [LAB_COMMANDS[1]] });
  assert.equal(plain.fake.scripts().some((script) => script.includes("npm ci")), false, "a node command needs no install");
});

test("AC21 a clean report with onCommitOnlyAdvance bump-provenance is dispatched with scope both, for any edge that also answers noop", async (t) => {
  const { w } = await run(t, [workshop(1, CLEAN_REPORT), studio(0, IN_SYNC)], { onCommitOnlyAdvance: "bump-provenance" });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.notEqual(w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "bump-provenance");
  assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, "both");
  assert.equal(w.state().lastNoopHeadSha, null, "nothing was recorded as a noop");
});

test("AC21 changed inputs, a drifted lab or both are dispatched with the scope that names what changed", async (t) => {
  const cases = [
    [CHANGED_REPORT, IN_SYNC, 0, "workshop-only"],
    [CLEAN_REPORT, DRIFT, 1, "studio-only"],
    [CHANGED_REPORT, DRIFT, 1, "both"],
  ];
  for (const [report, helper, helperCode, scope] of cases) {
    const { w } = await run(t, [workshop(1, report), studio(helperCode, helper)]);
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", scope);
    assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, scope);
    assert.equal(w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "noop");
  }
});

test("AC21 a sync scope that the edge's workflow does not accept is replaced by one that it does", async (t) => {
  const edge = preflightEdge();
  const w = routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge), upstream: { head: SHA1 }, downstream: { head: sha("main-1") }, manifestEdges: [{ ...edge, syncScopes: ["both"] }] });
  t.after(() => w.cleanup());
  const fake = fakePreflight([workshop(1, CLEAN_REPORT), studio(1, DRIFT)]);
  await w.go({ preflightDeps: fake.deps });
  assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, "both", "studio-only is not accepted, both is");
});

test("AC40 exit 2 of the studio helper fails the job, and so does every output that is not the helper's contract", async (t) => {
  const cases = [
    ["exit 2", studio(2, "", "fatal: cannot read lab-sources.json\n")],
    ["exit 3", studio(3, IN_SYNC)],
    ["not JSON", studio(0, "all good\n")],
    ["empty output", studio(0, "")],
    ["exit 1 and no JSON", studio(1, "")],
    ["exit 0 with changed labs", studio(0, { ...IN_SYNC, changedLabs: ["lab01"] })],
    ["exit 0 with status drift", studio(0, { ...DRIFT, changedLabs: [] })],
    ["exit 1 with status in-sync", studio(1, IN_SYNC)],
    ["accepted although --accept was not passed", studio(0, { ...IN_SYNC, status: "accepted" })],
    ["a missing helper: node exits 1 with a message and no JSON", studio(1, "", "Error: Cannot find module '/work/src/lab-studio-drift.mjs'\n")],
  ];
  for (const [label, response] of cases) {
    const { w, result } = await run(t, [workshop(1, CLEAN_REPORT), response]);
    assert.equal(result.code, 1, label);
    assert.equal(w.patches().length, 0, label);
    assert.equal(w.stub.world.dispatches.length, 0, label);
    assert.deepEqual(w.summaryLines(), [], label);
  }
});

test("AC40 the stub CLI's three exit codes map to no drift, drift and a failed preflight", async (t) => {
  const ok = await run(t, [workshop(0, CLEAN_REPORT), studio(0, IN_SYNC)]);
  const drifted = await run(t, [workshop(0, CLEAN_REPORT), studio(1, DRIFT)]);
  const fatal = await run(t, [workshop(0, CLEAN_REPORT), studio(2, "", "x\n")]);
  assert.equal(ok.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(drifted.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(fatal.result.code, 1);
});

test("AC28 preflight-rc-2 as the router sees it: the studio helper's exit 2 leaves etag, merge cursor, noop cursor and pull-request pointers alone and upserts one issue", async (t) => {
  const { w, result } = await run(t, [workshop(0, CLEAN_REPORT), studio(2, "", "boom\n")], {}, { stateOverrides: { etag: 'W/"keep"', lastNoopHeadSha: sha("old-noop"), openPrNumber: 3, openPrTargetSha: sha("open") } });
  assert.equal(result.code, 1);
  assert.equal(w.patches().length, 0);
  const after = w.state();
  assert.equal(after.etag, 'W/"keep"');
  assert.equal(after.lastMergedUpstreamSha, SHA0);
  assert.equal(after.lastNoopHeadSha, sha("old-noop"));
  assert.equal(after.openPrTargetSha, sha("open"));
  assert.equal(w.stub.issues.length, 1);
});

test("the plain check by exit status: 0 is no difference, 1 a difference, anything else a failure of the job", async (t) => {
  const edge = { preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- labs'] };
  const same = await run(t, [{ match: /diff --quiet/, code: 0 }], edge);
  assert.equal(same.w.decisions()[0].action, "noop-no-material-drift");
  assert.deepEqual(same.fake.checkouts.map((entry) => [entry.slug, entry.history, entry.mustContain]), [["initech/lab", "full", [SHA0]]], "the upstream checkout holds both commits and no downstream checkout is made for a git command");
  const differs = await run(t, [{ match: /diff --quiet/, code: 1 }], edge);
  assert.equal(differs.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(differs.w.stub.world.dispatches[0].body.inputs.sync_scope, "github-intermediate");
  for (const code of [2, 128, 129]) {
    const failed = await run(t, [{ match: /diff --quiet/, code }], edge);
    assert.equal(failed.result.code, 1, String(code));
    assert.equal(failed.w.patches().length, 0);
  }
});
