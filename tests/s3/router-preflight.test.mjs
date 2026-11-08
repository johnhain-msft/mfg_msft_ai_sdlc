// The edge-declared preflights (SPEC-03 AC20-AC23, AC28, AC40), run for real: git remotes on disk, a bash, the stub npm and the stub studio helper in the workspace
// of the router. Every case asserts the command that the shell ran (its arguments, its working directory, the variables that were bound, the absence of
// --accept), what was classified, what was persisted and which operations were refused afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execute as realExecute } from "../../src/routing/git.mjs";
import {
  actionsRun,
  CHANGED_REPORT,
  CLEAN_REPORT,
  createIntermediateWorld,
  createPreflightWorld,
  createShowcaseWorld,
  DRIFT,
  IN_SYNC,
  labFiles,
  NEWEST_RECORDED_RUN,
  preflightEdge,
  RECORDED_RUN_IDS,
  RECORDED_RUNS,
  recordedRuns,
  samePath,
  SHOWCASE_ANSWER,
  SHOWCASE_DATA,
} from "./helpers/preflight-world.mjs";
import { fixture, readText, TOKENS } from "./helpers/fixtures.mjs";

/** The recorded run of the capture script that has this key. */
const recorded = (key) => RECORDED_RUNS.find((entry) => entry.key === key);

const labWorld = (overrides = {}) =>
  createPreflightWorld({
    edge: preflightEdge(overrides.edge ?? {}),
    upstreamCommits: [labFiles(1), labFiles(2)],
    drift: IN_SYNC,
    ...overrides.spec,
  });

const npmRun = (world) => world.bin.calls("npm").filter((call) => call.args[0] === "run");

// ---- AC20: the command, its environment and its classification -------------------------------------------------------------------------

test("AC20 the preflight runs the edge's commands without --accept: sync:workshop-source with the absolute upstream checkout, then the studio helper, from the downstream checkout", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const [run] = npmRun(world);
  assert.deepEqual(run.args.slice(0, 3), ["run", "sync:workshop-source", "--"]);
  assert.equal(run.args.length, 4);
  assert.ok(path.isAbsolute(run.args[3].replace(/^\/([A-Za-z])\//, "$1:/")) || path.isAbsolute(run.args[3]), `UPSTREAM_DIR is absolute: ${run.args[3]}`);
  assert.ok(samePath(run.args[3], world.upstreamDir), `${run.args[3]} is ${world.upstreamDir}`);
  assert.ok(samePath(run.cwd, world.portfolioDir), "the working directory is the downstream checkout");
  const [drift] = world.driftCalls();
  assert.deepEqual(drift.args.slice(0, 1), ["--portfolio"]);
  assert.ok(samePath(drift.args[1], world.portfolioDir));
  assert.equal(drift.args[2], "--upstream");
  assert.ok(samePath(drift.args[3], world.upstreamDir));
  assert.deepEqual(drift.args.slice(4), ["--commit", world.upstreamShas[1]]);
  assert.equal([...run.args, ...drift.args].some((argument) => /--accept/.test(argument)), false, "no --accept");
  assert.ok(samePath(drift.cwd, world.portfolioDir));
});

test("AC20 UPSTREAM_DIR, TARGET_SHA and LAST_MERGED_SHA are bound for the command, and the upstream checkout is at the target", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  await world.go();
  const [run] = npmRun(world);
  assert.ok(samePath(run.bound.UPSTREAM_DIR, world.upstreamDir));
  assert.equal(run.bound.TARGET_SHA, world.upstreamShas[1]);
  assert.equal(run.bound.LAST_MERGED_SHA, world.upstreamShas[0]);
  assert.ok(samePath(run.bound.GITHUB_WORKSPACE, world.w.workspace.dir));
  assert.equal(world.git.git(world.upstreamDir, ["rev-parse", "HEAD"]).trim(), world.upstreamShas[1], "the upstream checkout is at TARGET_SHA");
  assert.equal(world.git.git(world.portfolioDir, ["rev-parse", "HEAD"]).trim(), world.downstreamSha, "the downstream checkout is at the head that was read");
});

test("AC20 a command that is run by the router never sees the App's key, the write token or the token of the job; it sees one read-only token", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  await world.go();
  const [run] = npmRun(world);
  for (const name of ["APP_PRIVATE_KEY", "APP_CLIENT_ID", "ISSUES_TOKEN", "EDGE_JSON", "CLIENT_PAYLOAD", "GITHUB_STEP_SUMMARY"]) assert.equal(run.envNames.includes(name), false, `${name} is not in the environment of a preflight command`);
  const read = world.w.stub.world.minted.filter((entry) => !entry.permissions.variables);
  assert.ok(read.some((entry) => entry.token === run.bound.GH_TOKEN), "GH_TOKEN is a read token of the App");
  assert.notEqual(run.bound.GH_TOKEN, TOKENS.issues);
  const write = world.w.stub.world.minted.find((entry) => entry.permissions.variables === "write");
  assert.notEqual(run.bound.GH_TOKEN, write.token, "not the write token");
  assert.deepEqual(read[0].permissions, { contents: "read", pull_requests: "read", actions: "read" });
});

test("AC20 the downstream's own dependencies are installed before an npm preflight runs, without lifecycle scripts, and never when no preflight needs them", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  await world.go();
  const calls = world.bin.calls("npm").map((call) => call.args.join(" "));
  assert.deepEqual(calls, ["ci --include=dev --ignore-scripts", `run sync:workshop-source -- ${world.bin.calls("npm")[1].args[3]}`]);
  assert.ok(samePath(world.bin.calls("npm")[0].cwd, world.portfolioDir));
});

test("AC20 rc1-1-with-no-change-is-no-drift: sync:workshop-source exits 1 whenever the commit differs, and a report of changed 0, new 0, gone 0 is no drift", async (t) => {
  const world = labWorld({ spec: { npm: [{ match: "^ci", code: 0 }, { match: "^run sync:workshop-source", code: 1, stdout: CLEAN_REPORT }] } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(world.w.stub.world.dispatches.length, 0);
});

test("AC20 a report that names changed inputs is drift although the exit status is the one of a run that found nothing (every other report is classified in preflight-classification.test.mjs)", async (t) => {
  const world = labWorld({ spec: { npm: [{ match: "^ci", code: 0 }, { match: "^run sync:workshop-source", code: 1, stdout: CHANGED_REPORT }] } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(world.w.stub.world.dispatches[0].body.inputs.sync_scope, "workshop-only", "the studio helper found nothing, the workshop did");
  assert.equal(world.w.state().inFlightTargetSha, world.upstreamShas[1]);
});

test("AC20 the preflight fails the job, without advancing state, when the summary line is absent, ambiguous or the command could not run", async (t) => {
  const cases = [
    ["no summary line", [{ match: "^ci", code: 0 }, { match: "^run sync:workshop-source", code: 1, stdout: "Source revision: abc\nsomething else\n" }]],
    ["exit 127 with a clean report", [{ match: "^ci", code: 0 }, { match: "^run sync:workshop-source", code: 127, stdout: CLEAN_REPORT }]],
    ["npm ci fails", [{ match: "^ci", code: 1, stderr: "ERESOLVE" }, { match: "^run sync:workshop-source", code: 0, stdout: CLEAN_REPORT }]],
  ];
  for (const [label, npm] of cases) {
    const world = labWorld({ spec: { npm } });
    t.after(() => world.cleanup());
    const before = world.w.stub.variables.get("SDLC_SYNC_STATE_LAB");
    const result = await world.go();
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.equal(world.w.patches().length, 0, label);
    assert.equal(world.w.stub.world.dispatches.length, 0, label);
    assert.equal(world.w.stub.variables.get("SDLC_SYNC_STATE_LAB"), before, label);
    assert.equal(world.w.stub.issues.length, 1, label);
    assert.deepEqual(world.w.summaryLines(), [], label);
  }
});

test("AC20 the commands run in a workspace whose path holds a space", async (t) => {
  const world = labWorld({ spec: { workspacePrefix: "sdlc s3 spaced " } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(world.w.workspace.dir.includes(" "));
  assert.equal(world.driftCalls().length, 1);
});

// ---- AC21: the noop and the bump ---------------------------------------------------------------------------------------------------------

test("AC21 lab-clean-noop: a clean report and no changed lab persist the noop cursors, leave the merge cursor alone and dispatch nothing", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  const before = world.w.state();
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  const [target] = [world.upstreamShas[1]];
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: "initech/lab",
    previousSha: world.upstreamShas[0],
    targetSha: target,
    action: "noop-no-material-drift",
    dispatchedWorkflowId: null,
  });
  assert.equal(world.w.patches().length, 1);
  const patched = JSON.parse(JSON.parse(world.w.patches()[0].body).value);
  assert.equal(patched.lastNoopHeadSha, target);
  assert.equal(patched.lastObservedHeadSha, target);
  assert.equal(patched.etag, 'W/"upstream-etag-1"');
  assert.equal(patched.portfolioMainSha, world.downstreamSha);
  assert.equal(patched.lastMergedUpstreamSha, before.lastMergedUpstreamSha, "lastMergedUpstreamSha is untouched");
  assert.equal(patched.lastMergedUpstreamSha, world.upstreamShas[0]);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.deepEqual(world.w.clock.waits, [], "nothing was dispatched, so there is no pacing wait");
});

test("AC21 a second run after a noop is noop-304 and writes nothing", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  await world.go();
  assert.equal(world.w.patches().length, 1, "the first run persisted the noop");
  const persisted = world.w.stub.variables.get("SDLC_SYNC_STATE_LAB");
  world.w.stub.requests.length = 0;
  const again = await world.go();
  assert.equal(again.code, 0, again.stderr);
  assert.equal(world.w.decisions().at(-1).action, "noop-304");
  assert.equal(world.w.patches().length, 0, "the second run sent no PATCH");
  assert.equal(world.w.stub.variables.get("SDLC_SYNC_STATE_LAB"), persisted, "and the variable is byte for byte what the first run wrote");
  assert.equal(world.bin.calls("npm").length, 2, "the preflight is not run again for a head that was already found to change nothing");
});

test("AC21 lab-clean-bump-provenance-dispatches: a clean report with onCommitOnlyAdvance bump-provenance is not a noop and is dispatched with the input populated", async (t) => {
  const world = labWorld({ edge: { onCommitOnlyAdvance: "bump-provenance" } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  const decision = world.w.decisions()[0];
  assert.equal(decision.action, "dispatch-ai-adaptation");
  assert.notEqual(decision.action, "noop-no-material-drift");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.on_commit_only_advance, "bump-provenance");
  assert.equal(inputs.sync_scope, "both");
  assert.equal(world.w.state().lastNoopHeadSha, null, "nothing was recorded as a noop");
});

test("AC21 lab-changed-dispatches: a drifted lab that the real helper process reports with exit 1 is dispatched with the scope studio-only, and the dispatch is what is recorded", async (t) => {
  const world = labWorld({ spec: { drift: { code: 1, stdout: DRIFT } } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.sync_scope, "studio-only");
  assert.equal(inputs.on_commit_only_advance, "noop");
  assert.equal(world.w.state().lastNoopHeadSha, null, "a dispatch is never recorded as a noop");
  assert.equal(world.w.state().lastMergedUpstreamSha, world.upstreamShas[0], "and it does not advance the merge cursor");
});

// ---- AC40: the studio helper, as a consumer --------------------------------------------------------------------------------------------

test("AC40 exit 2 of the studio helper is a failure of the preflight with the helper's message, and the other outcomes are classified in preflight-classification.test.mjs", async (t) => {
  const fatal = labWorld({ spec: { drift: { code: 2, stdout: "", stderr: "fatal: cannot read lab-sources.json\n" } } });
  t.after(() => fatal.cleanup());
  const result = await fatal.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with 2, a fatal error of the studio drift helper/);
  assert.equal(fatal.w.patches().length, 0);
  assert.equal(fatal.w.stub.world.dispatches.length, 0);
});

test("AC28 preflight-rc-2: a studio helper that exits 2 fails the job without advancing etag, merge cursor, noop cursor or pull-request pointers, and upserts one issue", async (t) => {
  const world = labWorld({ spec: { drift: { code: 2, stdout: "", stderr: "boom\n" } } });
  t.after(() => world.cleanup());
  const before = world.w.state();
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0, "zero PATCH requests");
  assert.deepEqual(world.w.state(), before);
  assert.equal(world.w.stub.issues.length, 1);
  assert.equal(world.w.stub.issues[0].title, "[sdlc-failure] cascade-router (initech/lab)");
  for (const cursor of ["etag", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha"]) assert.equal(world.w.state()[cursor], before[cursor], cursor);
});

test("AC40 a helper that prints something else than the contract's JSON, a status that disagrees with its exit code, or no JSON at all is a failure, never a drift or a clean result", async (t) => {
  const cases = [
    ["not JSON", { code: 0, stdout: "all good\n" }],
    ["exit 1 with status in-sync", { code: 1, stdout: IN_SYNC }],
  ];
  for (const [label, drift] of cases) {
    const world = labWorld({ spec: { drift } });
    t.after(() => world.cleanup());
    const result = await world.go();
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.equal(world.w.patches().length, 0, label);
    assert.equal(world.w.stub.world.dispatches.length, 0, label);
  }
});

test("AC40 a missing helper is a failure, not a drift and not a clean result: node exits 1 for a file that is not there", async (t) => {
  const world = labWorld({ spec: { drift: null } });
  t.after(() => world.cleanup());
  assert.equal(fs.existsSync(path.join(world.w.workspace.dir, "src", "lab-studio-drift.mjs")), false);
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.match(result.stderr, /did not print the JSON/);
});

test("AC20 the preflight is not run, and nothing is checked out, when the target needs no preflight: the merge cursor and the blocked target decide first", async (t) => {
  const world = labWorld({ spec: { stateOverrides: (shas) => ({ dismissedTargetSha: shas[1] }) } });
  t.after(() => world.cleanup());
  await world.go();
  assert.equal(world.w.decisions()[0].action, "noop-dismissed-pr");
  assert.equal(world.bin.calls("npm").length, 0);
  assert.equal(fs.existsSync(world.upstreamDir), false);
  assert.equal(fs.existsSync(world.portfolioDir), false);
});

test("a checkout directory that already holds somebody's files is never overwritten: a dirty downstream checkout fails the job and its files are as they were", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  fs.mkdirSync(world.portfolioDir, { recursive: true });
  world.git.git(world.portfolioDir, ["init", "--quiet"]);
  fs.writeFileSync(path.join(world.portfolioDir, "mine.txt"), "uncommitted work of somebody else\n");
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists and is not a clean checkout/);
  assert.equal(fs.readFileSync(path.join(world.portfolioDir, "mine.txt"), "utf8"), "uncommitted work of somebody else\n");
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.bin.calls("npm").length, 0, "nothing ran in the foreign tree");
});

test("a clean checkout that is already at the wanted commit is used as it is", async (t) => {
  const world = labWorld();
  t.after(() => world.cleanup());
  world.git.git(path.dirname(world.portfolioDir), ["clone", "--quiet", path.join(world.git.root, "servers", "acme", "portfolio.git"), world.portfolioDir]);
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(world.git.git(world.portfolioDir, ["status", "--porcelain"]).trim(), "", "and it is still clean");
});

// ---- AC22: the showcase snapshot -------------------------------------------------------------------------------------------------------

/** Runs the real processes, and records what the shell was asked to run and where (the capture must run in a temporary clone, never in the router's checkout). */
const spy = () => {
  const calls = [];
  return {
    calls,
    deps: {
      async execute(command, args, options) {
        calls.push({ script: args.at(-1), cwd: options.cwd });
        return realExecute(command, args, options);
      },
    },
    captures: () => calls.filter((call) => call.script.includes("fetch-run-data.mjs")),
  };
};
const porcelain = (world) => world.git.git(world.portfolioDir, ["status", "--porcelain"]).trim();
const committedSnapshot = readText(fixture("showcase", "run-data.json"));
const showcaseAnswer = (changes) => ({ ...JSON.parse(readText(fixture("showcase", "answer.json"))), ...changes });
const patchedState = (world) => JSON.parse(JSON.parse(world.w.patches().at(-1).body).value);

test("AC22 showcase-only-snapshotAt-differs-is-noop: no newer completed run and a capture that differs from the committed run-data.json only in snapshotAt persist the noop cursors and dispatch nothing", async (t) => {
  const world = createShowcaseWorld();
  t.after(() => world.cleanup());
  const spied = spy();
  const result = await world.go({ preflightDeps: spied.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const target = world.upstreamShas[1];
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: "initech/showcase",
    previousSha: world.upstreamShas[0],
    targetSha: target,
    action: "noop-unchanged-snapshot",
    dispatchedWorkflowId: null,
  });
  assert.equal(world.w.patches().length, 1);
  const after = patchedState(world);
  assert.equal(after.lastNoopHeadSha, target);
  assert.equal(after.lastObservedHeadSha, target);
  assert.equal(after.etag, 'W/"upstream-etag-1"');
  assert.equal(after.portfolioMainSha, world.downstreamSha);
  assert.equal(after.lastMergedUpstreamSha, world.upstreamShas[0], "the noop does not advance the merge cursor");
  assert.equal(world.w.stub.world.dispatches.length, 0);
  // the capture really ran, once, in a temporary clone of the downstream, and wrote a snapshotAt that differs from the committed one
  assert.equal(spied.captures().length, 1);
  const capture = spied.captures()[0];
  assert.ok(samePath(path.dirname(capture.cwd), world.runnerTemp), `the capture ran in a directory of RUNNER_TEMP: ${capture.cwd}`);
  assert.match(path.basename(capture.cwd), /^sdlc-showcase-/);
  assert.equal(samePath(capture.cwd, world.portfolioDir), false, "not in the checkout of the router");
});

test("AC22 showcase-newer-run-dispatches: a completed run that is newer than every recorded one is a change, and the capture is not needed to say so", async (t) => {
  const world = createShowcaseWorld({ runList: [...recordedRuns(), actionsRun(NEWEST_RECORDED_RUN + 1)] });
  t.after(() => world.cleanup());
  const spied = spy();
  const result = await world.go({ preflightDeps: spied.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const [dispatch] = world.w.stub.world.dispatches;
  assert.equal(dispatch.body.inputs.sync_scope, "showcase-runs");
  assert.equal(dispatch.body.inputs.upstream_sha, world.upstreamShas[1]);
  assert.equal(spied.captures().length, 0, "a newer run already decides");
  assert.equal(world.w.state().inFlightTargetSha, world.upstreamShas[1]);
  assert.equal(world.w.state().lastNoopHeadSha, null);
});

test("AC22 showcase-newer-run-dispatches: a run is compared with the recorded runs of its own workflow, so a CI run newer than the recorded CI run is new although another workflow's recorded run is newer still", async (t) => {
  // the finding: recorded CI is 39781079785 and recorded Dependabot 40573274820; a CI run that completes in between is new for CI
  const newerCi = actionsRun(40100000000, "completed", "ci");
  assert.ok(newerCi.id > recorded("ci").id && newerCi.id < NEWEST_RECORDED_RUN);
  const world = createShowcaseWorld({ runList: [...recordedRuns(), newerCi] });
  t.after(() => world.cleanup());
  const spied = spy();
  const result = await world.go({ preflightDeps: spied.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(world.w.stub.world.dispatches.length, 1);
  assert.equal(world.w.stub.world.dispatches[0].body.inputs.sync_scope, "showcase-runs");
  assert.equal(spied.captures().length, 0, "the newer run decides; the capture is not run");
  const after = world.w.state();
  assert.equal(after.inFlightTargetSha, world.upstreamShas[1]);
  assert.equal(after.lastNoopHeadSha, null, "a change is never recorded as a no-op");
  assert.equal(after.lastMergedUpstreamSha, world.upstreamShas[0]);
  assert.match(result.stdout, /preflight: material change \(snapshot: 1 completed run\(s\) of initech\/showcase are newer than the newest recorded run of their workflow/);
  assert.match(result.stdout, /run 40100000000 of workflow 7101 is newer than 39781079785/);
});

test("AC22 showcase-newer-run-dispatches: only a completed run counts, and only one that is newer than the newest recorded run of its own workflow", async (t) => {
  const quiet = [
    ...recordedRuns(),
    actionsRun(NEWEST_RECORDED_RUN + 5, "in_progress", "ci"),
    actionsRun(NEWEST_RECORDED_RUN + 6, "queued", "cd"),
    actionsRun(NEWEST_RECORDED_RUN + 7, "waiting", "dependabot"),
    actionsRun(recorded("ci").id - 1, "completed", "ci"),
    actionsRun(1, "completed", "dependabot"),
  ];
  const world = createShowcaseWorld({ runList: quiet });
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-unchanged-snapshot", "a running run, a queued run, a waiting run and older runs change nothing");
});

test("AC22 a run is compared with the recorded runs of its own workflow only: older than its own bar it is not new, whatever the other workflows recorded", async (t) => {
  // each of these is newer than some recorded run of another workflow and older than the newest recorded run of its own
  const older = [
    actionsRun(recorded("ci").id - 1, "completed", "ci"),
    actionsRun(recorded("codeql").id - 1, "completed", "codeql"),
    actionsRun(recorded("dependabot").id - 1, "completed", "dependabot"),
    actionsRun(recorded("scorecard").id - 1, "completed", "scorecard"),
  ];
  for (const run of older) assert.ok(run.id > recorded("cd-initial").id && run.id < NEWEST_RECORDED_RUN + 1);
  const world = createShowcaseWorld({ runList: [...recordedRuns(), ...older] });
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-unchanged-snapshot");
  assert.equal(world.w.stub.world.dispatches.length, 0);
});

test("AC22 the five cd entries are one workflow: a cd run between the recorded ones is not new, one newer than the newest of them is", async (t) => {
  const between = actionsRun(39600000000, "completed", "cd");
  assert.ok(between.id > recorded("cd-waiting").id && between.id < recorded("cd-queued").id);
  const quiet = createShowcaseWorld({ runList: [...recordedRuns(), between] });
  t.after(() => quiet.cleanup());
  assert.equal((await quiet.go({ preflightDeps: spy().deps })).code, 0);
  assert.equal(quiet.w.decisions()[0].action, "noop-unchanged-snapshot", "newer than cd, rollback and cd-waiting, older than cd-queued: not new");

  // newer than the newest cd entry, and older than the recorded CI and CodeQL runs
  const newer = actionsRun(recorded("cd-queued").id + 1, "completed", "cd");
  assert.ok(newer.id < recorded("codeql").id);
  const loud = createShowcaseWorld({ runList: [...recordedRuns(), between, newer] });
  t.after(() => loud.cleanup());
  assert.equal((await loud.go({ preflightDeps: spy().deps })).code, 0);
  assert.equal(loud.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(loud.w.stub.world.dispatches[0].body.inputs.sync_scope, "showcase-runs");
});

test("AC22 a run of a workflow that no recorded run belongs to is not one of the runs of the eleven keys: it changes nothing, and the capture still decides", async (t) => {
  const stranger = actionsRun(NEWEST_RECORDED_RUN + 10, "completed", "lint");
  const world = createShowcaseWorld({ runList: [...recordedRuns(), stranger] });
  t.after(() => world.cleanup());
  const spied = spy();
  const result = await world.go({ preflightDeps: spied.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-unchanged-snapshot");
  assert.equal(spied.captures().length, 1, "no newer run of a recorded workflow, so the capture is what decides");
});

test("AC22 the workflow of each recorded run is read from the run itself: one read per recorded run, in order, with the read token of the upstream, and nothing is written but the state", async (t) => {
  const world = createShowcaseWorld();
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const reads = world.w.stub.calls("GET", /\/repos\/initech\/showcase\/actions\/runs\/\d+$/);
  assert.deepEqual(reads.map((request) => request.path), RECORDED_RUN_IDS.map((id) => `/repos/initech/showcase/actions/runs/${id}`), "each recorded run once, in the order of the capture script");
  const minted = world.w.stub.world.minted;
  const read = minted.find((entry) => entry.installation === "initech" && entry.permissions.actions === "read");
  const write = minted.find((entry) => entry.permissions.variables === "write");
  assert.ok(read && write, "the router minted a read token for the upstream's owner and the write token");
  for (const request of reads) {
    assert.equal(request.headers.authorization, `Bearer ${read.token}`, request.path);
    assert.notEqual(request.headers.authorization, `Bearer ${write.token}`, request.path);
    assert.notEqual(request.headers.authorization, `Bearer ${TOKENS.issues}`, request.path);
  }
  assert.equal(world.w.stub.fetch.state.maxInflight, 1, "serial");
  assert.deepEqual(world.w.stub.calls().filter((request) => request.method !== "GET" && !request.path.startsWith("/app/")).map((request) => `${request.method} ${request.path}`), [`PATCH /repos/acme/orchestrator/actions/variables/${world.edge.stateVariable}`], "the one state write of the run");
});

test("AC22 a recorded run that cannot be read, or that names no workflow, fails the job: an error is never read as no newer run", async (t) => {
  const bar = recorded("dependabot").id;
  const cases = [
    ["the run no longer exists (404: deleted, or not visible to the token)", { status: 404, body: { message: "Not Found" } }, /the run 40573274820 that the capture script records does not exist in initech\/showcase \(404\)/],
    ["the read is refused (403)", { status: 403, body: { message: "Resource not accessible by integration" } }, /403/],
    ["the server fails (500)", { status: 500, body: { message: "Server Error" } }, /500/],
    ["the run has no workflow_id", { status: 200, body: { id: bar, status: "completed" } }, /the run 40573274820 of initech\/showcase has no workflow_id/],
    ["the run answers as another run", { status: 200, body: { ...actionsRun(bar + 1) } }, /the run 40573274820 of initech\/showcase answered as another run/],
  ];
  for (const [label, answer, message] of cases) {
    const world = createShowcaseWorld();
    t.after(() => world.cleanup());
    world.w.stub.inject("GET", (requestPath) => requestPath.endsWith(`/actions/runs/${bar}`), answer);
    const spied = spy();
    const result = await world.go({ preflightDeps: spied.deps });
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.equal(world.w.patches().length, 0, label);
    assert.equal(world.w.stub.world.dispatches.length, 0, label);
    assert.equal(spied.captures().length, 0, `${label}: the capture is not run`);
    assert.deepEqual(world.leftoverClones(), [], label);
    assert.equal(world.w.stub.issues.length, 1, label);
  }
});

test("AC22 a completed run in the listing that names no workflow cannot be compared, so the job fails", async (t) => {
  const nameless = { id: NEWEST_RECORDED_RUN + 1, status: "completed", conclusion: "success", name: "ci" };
  const world = createShowcaseWorld({ runList: [...recordedRuns(), nameless] });
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /completed run \d+ of initech\/showcase .*workflow_id/);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.w.stub.issues.length, 1);
});

test("AC22 showcase-run-data-diff-dispatches: a capture that differs from the committed run-data.json in more than snapshotAt is a change", async (t) => {
  const world = createShowcaseWorld({ answer: showcaseAnswer({ scorecard: { score: 8.1 } }) });
  t.after(() => world.cleanup());
  const spied = spy();
  const result = await world.go({ preflightDeps: spied.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(world.w.stub.world.dispatches[0].body.inputs.sync_scope, "showcase-runs");
  assert.equal(spied.captures().length, 1);
  assert.equal(world.w.state().lastNoopHeadSha, null);
  assert.equal(world.w.state().lastMergedUpstreamSha, world.upstreamShas[0]);
});

test("AC22 showcase-run-data-diff-dispatches: a downstream that has no run-data.json yet is a change, once the capture has written one", async (t) => {
  const world = createShowcaseWorld({ committed: null });
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
});

test("AC22 showcase-worktree-restored: whatever is decided, git status of the router's checkout is empty, run-data.json is as committed and no temporary clone is left behind", async (t) => {
  for (const [label, options, action] of [
    ["noop", {}, "noop-unchanged-snapshot"],
    ["a captured difference", { answer: showcaseAnswer({ gate: { legs: ["lint"] } }) }, "dispatch-ai-adaptation"],
    ["a newer run", { runList: [actionsRun(NEWEST_RECORDED_RUN + 1)] }, "dispatch-ai-adaptation"],
  ]) {
    const world = createShowcaseWorld(options);
    t.after(() => world.cleanup());
    const result = await world.go({ preflightDeps: spy().deps });
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(world.w.decisions()[0].action, action, label);
    if (fs.existsSync(world.portfolioDir)) {
      assert.equal(porcelain(world), "", `${label}: git -C portfolio status --porcelain is empty`);
      assert.equal(fs.readFileSync(path.join(world.portfolioDir, SHOWCASE_DATA), "utf8"), committedSnapshot, `${label}: run-data.json is the committed file`);
    }
    assert.deepEqual(world.leftoverClones(), [], `${label}: the temporary clone is removed`);
  }
});

test("AC22 showcase-worktree-restored: a failing capture leaves nothing behind either, writes no state and fails the job", async (t) => {
  const world = createShowcaseWorld({ answer: { fixtureBehaviour: "exit", code: 3, message: "gh: HTTP 403" } });
  t.after(() => world.cleanup());
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the capture 'node experiences\/pipeline-showcase\/capture\/fetch-run-data\.mjs' failed \(exit 3\)/);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(porcelain(world), "");
  assert.deepEqual(world.leftoverClones(), []);
  assert.equal(world.w.stub.issues.length, 1);
});

test("AC22 somebody's uncommitted run-data.json in the router's checkout is never overwritten: the job fails and the file is as it was", async (t) => {
  const world = createShowcaseWorld({ answer: showcaseAnswer({ scorecard: { score: 1 } }) });
  t.after(() => world.cleanup());
  world.git.git(path.dirname(world.portfolioDir), ["clone", "--quiet", path.join(world.git.root, "servers", "acme", "portfolio.git"), world.portfolioDir]);
  const mine = '{ "snapshotAt": "mine", "note": "an edit that is not committed" }\n';
  fs.writeFileSync(path.join(world.portfolioDir, SHOWCASE_DATA), mine);
  const result = await world.go({ preflightDeps: spy().deps });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists and is not a clean checkout/);
  assert.equal(fs.readFileSync(path.join(world.portfolioDir, SHOWCASE_DATA), "utf8"), mine);
  assert.equal(world.w.patches().length, 0);
  assert.deepEqual(world.leftoverClones(), []);
});

test("AC22 a capture that writes no run-data.json, a listing that fails and a script that is not there fail the job: an error is never read as no change", async (t) => {
  const cases = [
    ["the capture writes nothing and there is no committed file", () => createShowcaseWorld({ answer: { fixtureBehaviour: "write-nothing" }, committed: null }), /the capture wrote no experiences\/pipeline-showcase\/content\/run-data\.json/],
    [
      "the listing of the upstream's runs answers 500",
      () => {
        const world = createShowcaseWorld();
        world.w.stub.inject("GET", (requestPath) => requestPath.endsWith("/actions/runs"), () => ({ status: 500, body: { message: "Server Error" } }));
        return world;
      },
      /GET \/repos\/initech\/showcase\/actions\/runs\?per_page=100 returned HTTP 500/,
    ],
    [
      "the listing is refused (403)",
      () => {
        const world = createShowcaseWorld();
        world.w.stub.inject("GET", (requestPath) => requestPath.endsWith("/actions/runs"), () => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
        return world;
      },
      /GET \/repos\/initech\/showcase\/actions\/runs\?per_page=100 returned HTTP 403/,
    ],
    [
      "the listing is not a list of runs",
      () => {
        const world = createShowcaseWorld();
        world.w.stub.inject("GET", (requestPath) => requestPath.endsWith("/actions/runs"), () => ({ status: 200, body: { total_count: 0 } }));
        return world;
      },
      /are not a list/,
    ],
    [
      "the capture script is not in the downstream",
      () => {
        const world = createShowcaseWorld();
        world.w.stub.world.repos.get("acme/portfolio").files = {};
        return world;
      },
      /does not exist in acme\/portfolio/,
    ],
    ["the capture script records no runs", () => createShowcaseWorld({ script: "// no RUNS array here\n" }), /records no runs/],
  ];
  for (const [label, build, message] of cases) {
    const world = build();
    t.after(() => world.cleanup());
    const result = await world.go({ preflightDeps: spy().deps });
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.equal(world.w.patches().length, 0, label);
    assert.equal(world.w.stub.world.dispatches.length, 0, label);
    assert.deepEqual(world.leftoverClones(), [], label);
    assert.equal(world.w.stub.issues.length, 1, label);
  }
});

// ---- AC23: the intermediate edge's curriculum diff -----------------------------------------------------------------------------------------------

const upstreamContains = (world, name) => world.git.gitMaybe(world.upstreamDir, ["cat-file", "-e", `${name}^{commit}`]).status === 0;

test("AC23 intermediate-no-diff-noop: a change outside the curriculum paths is no material drift, the noop cursors are persisted and the upstream checkout holds both commits", async (t) => {
  const world = createIntermediateWorld({ lastMerged: "curriculum-change", target: "outside-change" });
  t.after(() => world.cleanup());
  const [, change, outside] = world.upstreamShas;
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: "initech/template",
    previousSha: change,
    targetSha: outside,
    action: "noop-no-material-drift",
    dispatchedWorkflowId: null,
  });
  const after = patchedState(world);
  assert.equal(after.lastNoopHeadSha, outside);
  assert.equal(after.lastObservedHeadSha, outside);
  assert.equal(after.etag, 'W/"upstream-etag-1"');
  assert.equal(after.portfolioMainSha, world.downstreamSha);
  assert.equal(after.lastMergedUpstreamSha, change, "the merge cursor is untouched by a noop");
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.ok(upstreamContains(world, change) && upstreamContains(world, outside), "the upstream checkout holds both SHAs");
});

test("AC23 intermediate-no-diff-noop: the diff is cumulative from the merge cursor to the target, so a curriculum change that a later commit put back is no difference", async (t) => {
  // baseline -> (lab changed) -> (docs and workflow changed) -> (lab put back): every commit in between is irrelevant, only baseline..target counts
  const world = createIntermediateWorld({ lastMerged: "baseline", target: "curriculum-revert" });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift", "the lab is as it was in the baseline, and docs and .github are not curriculum");
  assert.equal(patchedState(world).lastNoopHeadSha, world.upstreamShas[3]);
  assert.equal(world.w.stub.world.dispatches.length, 0);
});

test("AC23 intermediate-diff-dispatches: a curriculum change anywhere between the merge cursor and the target is a difference, even when the head commit changed nothing that matters", async (t) => {
  const world = createIntermediateWorld({ lastMerged: "baseline", target: "outside-change" });
  t.after(() => world.cleanup());
  const [baseline, change, outside] = world.upstreamShas;
  // the guard of the test: the head commit alone changes no curriculum path, so a diff of the last commit would have been quiet
  assert.equal(world.git.gitMaybe(world.git.remote("initech/template").work, ["diff", "--quiet", change, outside, "--", "labs", "solutions", "src", "style", "index.html", "README.md"]).status, 0);
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.sync_scope, "github-intermediate");
  assert.equal(inputs.previous_sha, baseline);
  assert.equal(inputs.upstream_sha, outside);
  assert.equal(world.w.state().lastNoopHeadSha, null);
  assert.ok(upstreamContains(world, baseline) && upstreamContains(world, outside), "the upstream checkout holds both SHAs");
});

test("AC23 intermediate-git-error-fails: a merge cursor that the upstream does not have is a fatal error, not a difference and not a quiet one", async (t) => {
  const world = createIntermediateWorld({ lastMerged: "baseline", target: "curriculum-change", extra: { stateOverrides: () => ({ lastMergedUpstreamSha: "f".repeat(40), lastObservedHeadSha: "f".repeat(40) }) } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.w.stub.issues.length, 1);
  assert.deepEqual(world.w.summaryLines(), []);
  assert.deepEqual(world.w.state(), JSON.parse(world.w.stub.variables.get("SDLC_SYNC_STATE_GITHUB_INTERMEDIATE")), "the variable is as it was");
});
