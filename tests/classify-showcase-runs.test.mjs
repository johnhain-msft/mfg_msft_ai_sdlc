// The classifier of the showcase runs (design E2; SPEC-03 AC22): the snapshot check that the router used to run itself, now run by this script right after
// `gh api "repos/<upstream>/actions/runs?per_page=100"`. A completed run is new when it is newer than the newest recorded run of its OWN workflow, and when none is
// the capture script runs in an isolated clone and what it wrote is compared with the committed run-data.json, snapshotAt aside. Every case of the old table of
// tests/s3/router-preflight (the AC22 ones) is here as an input and an exit code, against the real edge of the manifest, a real git checkout and a real bash.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { execute as realExecute } from "ai-sdlc-factory/script-kit";
import { abs, INSTANCE_ROOT, readText } from "./helpers/instance.mjs";
import { createGitWorld, createStubBin, findBash, hostEnvironment } from "./s3/helpers/git-world.mjs";
import { newerRuns, parseRunIds, planSnapshot, run } from "../scripts/classify-showcase-runs.mjs";

const SCRIPT = abs("scripts", "classify-showcase-runs.mjs");
const FIXTURES = abs("tests", "s3", "fixtures", "showcase");
const UPSTREAM = "ms-mfg-community/github-pipeline-showcase";
const DOWNSTREAM = "johnhain-msft/portfolio";
const COMMAND = `gh api "repos/${UPSTREAM}/actions/runs?per_page=100"`;
const CAPTURE_SCRIPT = "experiences/pipeline-showcase/capture/fetch-run-data.mjs";
const ANSWER = "experiences/pipeline-showcase/capture/answer.json";
const DATA = "experiences/pipeline-showcase/content/run-data.json";
const TOKEN = "ghs_readTokenOfTheRouter000000000000000000";

// ---- the world: the eleven runs of the capture script and the workflows that they are runs of ------------------------------------------------------

const WORKFLOW_IDS = { ci: 7101, codeql: 7102, "dependency-review": 7103, "container-scan": 7104, scorecard: 7105, dependabot: 7106, cd: 7107, lint: 7199 };
const RECORDED_RUNS = [
  { key: "ci", id: 39781079785, workflow: "ci" },
  { key: "codeql", id: 39781079636, workflow: "codeql" },
  { key: "dependency-review", id: 39780778851, workflow: "dependency-review" },
  { key: "container-scan", id: 39780778886, workflow: "container-scan" },
  { key: "scorecard", id: 40446543496, workflow: "scorecard" },
  { key: "dependabot", id: 40573274820, workflow: "dependabot" },
  { key: "cd", id: 39443641702, workflow: "cd" },
  { key: "cd-initial", id: 39440423127, workflow: "cd" },
  { key: "rollback", id: 39445050929, workflow: "cd" },
  { key: "cd-waiting", id: 39449984245, workflow: "cd" },
  { key: "cd-queued", id: 39781079595, workflow: "cd" },
];
const NEWEST_RECORDED_RUN = Math.max(...RECORDED_RUNS.map((entry) => entry.id));
const recorded = (key) => RECORDED_RUNS.find((entry) => entry.key === key);
const actionsRun = (id, status = "completed", workflow = "ci") => ({ id, status, conclusion: status === "completed" ? "success" : null, name: workflow, workflow_id: WORKFLOW_IDS[workflow] });
const recordedRuns = () => RECORDED_RUNS.map((entry) => actionsRun(entry.id, "completed", entry.workflow));

const asJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The REST side: every run by id (the recorded ones always exist, whatever the listing), and the requests that were made. */
function restOf({ extra = [], missing = [], noWorkflow = [] } = {}) {
  const byId = new Map([...recordedRuns(), ...extra].map((entry) => [String(entry.id), entry]));
  const calls = [];
  const fetch = async (url, init) => {
    const target = new URL(url);
    calls.push({ method: init.method, path: target.pathname, authorization: init.headers.Authorization });
    const match = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/.exec(target.pathname);
    if (match === null) return json(404, { message: "Not Found" });
    const { 3: id } = match;
    if (missing.includes(Number(id)) || !byId.has(id)) return json(404, { message: "Not Found" });
    const found = byId.get(id);
    return json(200, noWorkflow.includes(Number(id)) ? { ...found, workflow_id: undefined } : found);
  };
  return { fetch, calls };
}

/**
 * The checkout of the downstream: the capture script, what it captures, and the committed snapshot. A checkout is built once for each set of options and shared
 * by the tests: the classifier never writes in it, which each test asserts, and a git repository costs several seconds on a Windows host.
 */
const worlds = new Map();
after(() => {
  for (const world of worlds.values()) world.git.cleanup();
});
function downstream(_t, { answer, committed, script } = {}) {
  const key = JSON.stringify({ answer, committed, script });
  if (worlds.has(key)) return worlds.get(key);
  const git = createGitWorld();
  const files = {
    [CAPTURE_SCRIPT]: script ?? readText(path.join(FIXTURES, "fetch-run-data.fixture.mjs")),
    [ANSWER]: typeof answer === "string" ? answer : asJson(answer ?? JSON.parse(readText(path.join(FIXTURES, "answer.json")))),
    "experiences/pipeline-showcase/content/README.md": "the content of the showcase\n",
  };
  if (committed !== null) files[DATA] = typeof committed === "string" ? committed : readText(path.join(FIXTURES, "run-data.json"));
  git.commit(DOWNSTREAM, files, "downstream main");
  const dir = git.remote(DOWNSTREAM).work;
  const world = { dir, git, porcelain: () => git.git(dir, ["status", "--porcelain"]).trim() };
  worlds.set(key, world);
  return world;
}

const BASH = findBash();

/** Runs the classifier in process from the downstream checkout, the way the router starts it, and returns what it exited with, printed and did. */
async function classify(t, { rest = restOf(), list = recordedRuns(), world = downstream(t), listing, exitCode = 0, command = COMMAND, env = {}, workspace = INSTANCE_ROOT } = {}) {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-classify-showcase-"));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));
  const bin = createStubBin({});
  t.after(() => bin.cleanup());
  const stdoutFile = path.join(runnerTemp, "check-0.stdout");
  fs.writeFileSync(stdoutFile, listing ?? asJson({ total_count: list.length, workflow_runs: list }));
  fs.writeFileSync(path.join(runnerTemp, "check-0.stderr"), "");
  const environment = {
    ...hostEnvironment(),
    ...world.git.environment(),
    PATH: bin.path(),
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: workspace,
    GH_TOKEN: TOKEN,
    TARGET_SHA: "b".repeat(40),
    LAST_MERGED_SHA: "a".repeat(40),
    SDLC_PREFLIGHT_INDEX: "0",
    SDLC_PREFLIGHT_COMMAND: command,
    SDLC_PREFLIGHT_EXIT_CODE: String(exitCode),
    SDLC_PREFLIGHT_STDOUT_FILE: stdoutFile,
    SDLC_PREFLIGHT_STDERR_FILE: path.join(runnerTemp, "check-0.stderr"),
    ...env,
  };
  const captures = [];
  // the processes that the classifier starts run for real; the spy records where the capture was started (it must never be in the checkout of the router)
  const deps = {
    async execute(command, args, options) {
      if (String(args.at(-1)).includes("fetch-run-data.mjs")) captures.push(options.cwd);
      return realExecute(command, args, options);
    },
  };
  let out = "";
  let err = "";
  const code = await run([], {
    env: environment,
    cwd: world.dir,
    fetch: rest.fetch,
    bash: BASH,
    deps,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
  });
  return { code, out, err, world, rest, captures, runnerTemp, leftovers: () => fs.readdirSync(runnerTemp).filter((name) => name.startsWith("sdlc-showcase-")) };
}

// ---- the readers ----------------------------------------------------------------------------------------------------------------------------------

test("parseRunIds reads the ids of the RUNS array of a capture script", () => {
  const source = 'const OWNER_REPO = "x/y";\nconst RUNS = [\n  { key: "ci", id: 39781079785, story: "a" },\n  { key: "codeql", id: 39781079636, story: "b" },\n];\nconst other = { id: 5 };\n';
  assert.deepEqual(parseRunIds(source), [39781079785, 39781079636]);
  assert.deepEqual(parseRunIds("no runs here"), []);
});

test("planSnapshot finds the edge of the command in the manifest, its upstream and its capture command", async () => {
  const found = await planSnapshot({ command: COMMAND, workspace: INSTANCE_ROOT, env: {}, avoid: [] });
  assert.equal(found.upstream, UPSTREAM);
  assert.deepEqual(found.listing, { owner: "ms-mfg-community", name: "github-pipeline-showcase", apiPath: `repos/${UPSTREAM}/actions/runs?per_page=100` });
  assert.deepEqual(found.capture, { command: `node ${CAPTURE_SCRIPT}`, script: CAPTURE_SCRIPT, dataFile: DATA });
});

test("planSnapshot refuses what it cannot tie to an edge: a command that is not a runs listing, one that no edge declares, one that names another repository", async () => {
  const refuse = (command, pattern) => assert.rejects(planSnapshot({ command, workspace: INSTANCE_ROOT, env: {}, avoid: [] }), pattern, command);
  await refuse("git -C <checkout> diff --quiet", /not a listing of the workflow runs/);
  await refuse('gh api "repos/someone/else/actions/runs?per_page=100"', /no AI edge of the manifest declares/);
  await refuse("gh api repos/x/y/pulls", /not a listing of the workflow runs/);
});

test("planSnapshot: an edge that lists runs and has no capture command cannot tell newer runs from older ones", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-classify-ws-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const edge = { edgeId: "x", mode: "ai-adaptation", upstreamRepo: "o/r", preflightCommands: ['gh api "repos/o/r/actions/runs?per_page=100"'], buildCommands: ["npm run build"] };
  fs.writeFileSync(path.join(workspace, "sdlc.yaml"), `dependencyEdges:\n  - ${JSON.stringify(edge)}\n`);
  await assert.rejects(planSnapshot({ command: edge.preflightCommands[0], workspace, env: {}, avoid: [] }), /lists a runs listing but no capture command/);
  // an edge whose upstream is another repository than the one its command lists is refused as well
  const other = { ...edge, upstreamRepo: "elsewhere/r" };
  fs.writeFileSync(path.join(workspace, "sdlc.yaml"), `dependencyEdges:\n  - ${JSON.stringify(other)}\n`);
  await assert.rejects(planSnapshot({ command: edge.preflightCommands[0], workspace, env: {}, avoid: [] }), /names o\/r, not the upstream elsewhere\/r/);
});

test("newerRuns: only a completed run counts, and only one newer than the newest recorded run of its own workflow", () => {
  const bars = new Map([[7101, 100], [7107, 50]]);
  const listing = [
    { id: 101, status: "completed", workflow_id: 7101 },
    { id: 100, status: "completed", workflow_id: 7101 },
    { id: 99, status: "completed", workflow_id: 7101 },
    { id: 500, status: "in_progress", workflow_id: 7101 },
    { id: 600, status: "queued", workflow_id: 7107 },
    { id: 51, status: "completed", workflow_id: 7107 },
    { id: 9999, status: "completed", workflow_id: 7199 },
  ];
  assert.deepEqual(newerRuns(listing, bars), [{ id: 101, workflow: 7101, bar: 100 }, { id: 51, workflow: 7107, bar: 50 }]);
  assert.throws(() => newerRuns([{ id: 1, status: "completed" }], bars), /has no workflow_id/);
  assert.throws(() => newerRuns([{ id: "1", status: "completed", workflow_id: 7101 }], bars), /has no integer id/);
});

// ---- the verdicts: 0 the snapshot is unchanged, 1 drift, 2 it cannot be judged ----------------------------------------------------------------------

test("AC22 showcase-only-snapshotAt-differs-is-noop: no newer completed run and a capture that differs from the committed run-data.json only in snapshotAt is no drift", async (t) => {
  const result = await classify(t);
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  assert.match(result.out, /no completed run is newer than the newest recorded run of its workflow/);
  // the capture really ran, once, in a temporary clone of the downstream, and never in the checkout of the router
  assert.equal(result.captures.length, 1);
  assert.equal(path.dirname(result.captures[0]).toLowerCase(), result.runnerTemp.toLowerCase(), "in a directory of RUNNER_TEMP");
  assert.match(path.basename(result.captures[0]), /^sdlc-showcase-/);
  assert.notEqual(path.resolve(result.captures[0]).toLowerCase(), path.resolve(result.world.dir).toLowerCase());
  assert.deepEqual(result.leftovers(), [], "the clone is removed");
  assert.equal(result.world.porcelain(), "", "and the checkout of the router is still clean");
});

test("AC22 showcase-newer-run-dispatches: a completed run that is newer than every recorded one is a change, and the capture is not needed to say so", async (t) => {
  const result = await classify(t, { list: [...recordedRuns(), actionsRun(NEWEST_RECORDED_RUN + 1)] });
  assert.equal(result.code, 1, result.err);
  assert.equal(result.captures.length, 0, "a newer run already decides");
  assert.match(result.out, /snapshot: 1 completed run\(s\) of ms-mfg-community\/github-pipeline-showcase are newer than the newest recorded run of their workflow/);
});

test("AC22 a run is compared with the recorded runs of its own workflow, so a CI run newer than the recorded CI run is new although another workflow's recorded run is newer still", async (t) => {
  const newerCi = actionsRun(40100000000, "completed", "ci");
  assert.ok(newerCi.id > recorded("ci").id && newerCi.id < NEWEST_RECORDED_RUN);
  const result = await classify(t, { list: [...recordedRuns(), newerCi] });
  assert.equal(result.code, 1, result.err);
  assert.equal(result.captures.length, 0);
  assert.match(result.out, /run 40100000000 of workflow 7101 is newer than 39781079785/);
});

test("AC22 only a completed run counts, and only one that is newer than the newest recorded run of its own workflow", async (t) => {
  const quiet = [
    ...recordedRuns(),
    actionsRun(NEWEST_RECORDED_RUN + 5, "in_progress", "ci"),
    actionsRun(NEWEST_RECORDED_RUN + 6, "queued", "cd"),
    actionsRun(NEWEST_RECORDED_RUN + 7, "waiting", "dependabot"),
    actionsRun(recorded("ci").id - 1, "completed", "ci"),
    actionsRun(1, "completed", "dependabot"),
  ];
  const result = await classify(t, { list: quiet });
  assert.equal(result.code, 0, `${result.err}${result.out}`);
});

test("AC22 a run is compared with the recorded runs of its own workflow only: older than its own bar it is not new, whatever the other workflows recorded", async (t) => {
  const older = [
    actionsRun(recorded("ci").id - 1, "completed", "ci"),
    actionsRun(recorded("codeql").id - 1, "completed", "codeql"),
    actionsRun(recorded("dependabot").id - 1, "completed", "dependabot"),
    actionsRun(recorded("scorecard").id - 1, "completed", "scorecard"),
  ];
  for (const entry of older) assert.ok(entry.id > recorded("cd-initial").id && entry.id < NEWEST_RECORDED_RUN + 1);
  const result = await classify(t, { list: [...recordedRuns(), ...older] });
  assert.equal(result.code, 0, `${result.err}${result.out}`);
});

test("AC22 the five cd entries are one workflow: a cd run between the recorded ones is not new, one newer than the newest of them is", async (t) => {
  const between = actionsRun(39600000000, "completed", "cd");
  assert.ok(between.id > recorded("cd-waiting").id && between.id < recorded("cd-queued").id);
  assert.equal((await classify(t, { list: [...recordedRuns(), between] })).code, 0, "newer than cd, rollback and cd-waiting, older than cd-queued: not new");
  const newer = actionsRun(recorded("cd-queued").id + 1, "completed", "cd");
  assert.ok(newer.id < recorded("codeql").id);
  assert.equal((await classify(t, { list: [...recordedRuns(), between, newer] })).code, 1);
});

test("AC22 a run of a workflow that no recorded run belongs to is not one of the runs of the eleven keys: it changes nothing, and the capture still decides", async (t) => {
  const stranger = actionsRun(NEWEST_RECORDED_RUN + 10, "completed", "lint");
  const result = await classify(t, { list: [...recordedRuns(), stranger] });
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  assert.equal(result.captures.length, 1, "no newer run of a recorded workflow, so the capture is what decides");
});

test("AC22 the workflow of each recorded run is read from the run itself: one read per recorded run, in order, with the read token, and nothing is written", async (t) => {
  const result = await classify(t);
  assert.equal(result.code, 0, result.err);
  const ids = RECORDED_RUNS.map((entry) => entry.id);
  assert.deepEqual(result.rest.calls.map((call) => call.path), ids.map((id) => `/repos/${UPSTREAM}/actions/runs/${id}`), "each recorded run once, in the order of the capture script");
  for (const call of result.rest.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
  }
});

test("AC22 a recorded run that cannot be read, or that names no workflow, and a listed run that names none, are failures: an error is never read as no newer run", async (t) => {
  const gone = await classify(t, { rest: restOf({ missing: [recorded("scorecard").id] }) });
  assert.equal(gone.code, 2);
  assert.match(gone.err, /the run 40446543496 that the capture script records does not exist in ms-mfg-community\/github-pipeline-showcase \(404\)/);
  const nameless = await classify(t, { rest: restOf({ noWorkflow: [recorded("ci").id] }) });
  assert.equal(nameless.code, 2);
  assert.match(nameless.err, /has no workflow_id/);
  const listed = await classify(t, { list: [...recordedRuns(), { id: NEWEST_RECORDED_RUN + 2, status: "completed" }] });
  assert.equal(listed.code, 2);
  assert.match(listed.err, /has no workflow_id, so it cannot be compared/);
});

test("AC22 showcase-run-data-diff-dispatches: a capture that differs from the committed run-data.json in more than snapshotAt is a change", async (t) => {
  const answer = { ...JSON.parse(readText(path.join(FIXTURES, "answer.json"))), extraField: "a changed run story" };
  const result = await classify(t, { world: downstream(t, { answer }) });
  assert.equal(result.code, 1, result.err);
  assert.match(result.out, new RegExp(`snapshot: ${DATA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} differs from the committed file \\(snapshotAt aside\\)`));
});

test("AC22 showcase-run-data-diff-dispatches: a downstream that has no run-data.json yet is a change, once the capture has written one", async (t) => {
  const result = await classify(t, { world: downstream(t, { committed: null }) });
  assert.equal(result.code, 1, result.err);
  assert.equal(result.captures.length, 1);
});

test("AC22 showcase-worktree-restored: whatever is decided, git status of the router's checkout is empty, run-data.json is as committed and no temporary clone is left behind", async (t) => {
  for (const options of [{}, { list: [...recordedRuns(), actionsRun(NEWEST_RECORDED_RUN + 1)] }, { world: downstream(t, { answer: { ...JSON.parse(readText(path.join(FIXTURES, "answer.json"))), extraField: "x" } }) }]) {
    const result = await classify(t, options);
    assert.ok([0, 1].includes(result.code), result.err);
    assert.equal(result.world.porcelain(), "");
    assert.equal(readText(path.join(result.world.dir, ...DATA.split("/"))), readText(path.join(FIXTURES, "run-data.json")));
    assert.deepEqual(result.leftovers(), []);
  }
});

test("AC22 a failing capture, a capture that writes no run-data.json, a listing that fails or is not a list, and a script that is not there are failures, and leave nothing behind", async (t) => {
  const failing = await classify(t, { world: downstream(t, { answer: { fixtureBehaviour: "exit", code: 3, message: "the capture broke" } }) });
  assert.equal(failing.code, 2);
  assert.match(failing.err, /the capture 'node experiences\/pipeline-showcase\/capture\/fetch-run-data\.mjs' failed \(exit 3\): the capture broke/);
  assert.deepEqual(failing.leftovers(), []);
  assert.equal(failing.world.porcelain(), "");
  const silent = await classify(t, { world: downstream(t, { answer: { fixtureBehaviour: "write-nothing" }, committed: null }) });
  assert.equal(silent.code, 2);
  assert.match(silent.err, /the capture wrote no experiences\/pipeline-showcase\/content\/run-data\.json/);
  const listing = await classify(t, { exitCode: 1 });
  assert.equal(listing.code, 2);
  assert.match(listing.err, /exited with 1/);
  const notAList = await classify(t, { listing: asJson({ message: "Bad credentials" }) });
  assert.equal(notAList.code, 2);
  assert.match(notAList.err, /are not a list/);
  const notJson = await classify(t, { listing: "<html>rate limited</html>" });
  assert.equal(notJson.code, 2);
  const missing = await classify(t, { world: downstream(t, { script: "// not a capture script\n" }) });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /records no runs/);
});

test("the classifier refuses to guess: no read token, a token that is not an App installation token, a command that is not the edge's, and no router variables are each a failure", async (t) => {
  const noToken = await classify(t, { env: { GH_TOKEN: "" } });
  assert.equal(noToken.code, 2);
  assert.match(noToken.err, /GH_TOKEN/);
  const personal = await classify(t, { env: { GH_TOKEN: "ghp_aPersonalAccessToken000000000000000000" } });
  assert.equal(personal.code, 2);
  assert.doesNotMatch(personal.err, /ghp_aPersonal/, "the message names the kind and never the token");
  const stranger = await classify(t, { command: 'gh api "repos/someone/else/actions/runs?per_page=100"' });
  assert.equal(stranger.code, 2);
  let err = "";
  assert.equal(await run([], { env: {}, stdout: () => {}, stderr: (text) => (err += text) }), 2);
  assert.match(err, /SDLC_PREFLIGHT_STDOUT_FILE/);
});

test("a crash of the classifier itself, or a network that is down, is a 2, not node's own exit code 1, which the router would read as a drift", async (t) => {
  const down = { fetch: async () => { throw new TypeError("fetch failed"); }, calls: [] };
  const world = downstream(t);
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-classify-showcase-"));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));
  const stdoutFile = path.join(runnerTemp, "check-0.stdout");
  fs.writeFileSync(stdoutFile, asJson({ workflow_runs: recordedRuns() }));
  const env = { ...hostEnvironment(), RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: INSTANCE_ROOT, GH_TOKEN: TOKEN, SDLC_PREFLIGHT_COMMAND: COMMAND, SDLC_PREFLIGHT_EXIT_CODE: "0", SDLC_PREFLIGHT_STDOUT_FILE: stdoutFile };
  let err = "";
  const code = await run([], { env, cwd: world.dir, fetch: down.fetch, sleep: async () => {}, stdout: () => {}, stderr: (text) => (err += text) });
  assert.equal(code, 2, err);
  assert.match(err, /^classify-showcase-runs: /);
  let crashed = "";
  const newerFile = path.join(runnerTemp, "check-1.stdout");
  fs.writeFileSync(newerFile, asJson({ workflow_runs: [...recordedRuns(), actionsRun(NEWEST_RECORDED_RUN + 1)] }));
  const second = await run([], {
    env: { ...env, SDLC_PREFLIGHT_STDOUT_FILE: newerFile },
    cwd: world.dir,
    fetch: restOf().fetch,
    stdout: () => {
      throw new TypeError("standard output is closed");
    },
    stderr: (text) => (crashed += text),
  });
  assert.equal(second, 2, "a bug of the script is no drift either");
  assert.match(crashed, /TypeError: standard output is closed/);
});

// ---- as the router starts it: a process with the variables in its environment, and a REST server on the loopback ------------------------------------------

test("started as a command, the script reads the runs through the REST API of GITHUB_API_URL and exits with the verdict", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const id = /\/actions\/runs\/(\d+)$/.exec(request.url)?.[1];
    const found = recordedRuns().find((entry) => String(entry.id) === id);
    response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(found ?? { message: "Not Found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const world = downstream(t);
  const bin = createStubBin({});
  t.after(() => bin.cleanup());
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-classify-showcase-"));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));
  const stdoutFile = path.join(runnerTemp, "check-0.stdout");
  fs.writeFileSync(stdoutFile, asJson({ workflow_runs: [...recordedRuns(), actionsRun(NEWEST_RECORDED_RUN + 1)] }));
  const env = {
    ...hostEnvironment(),
    ...world.git.environment(),
    PATH: bin.path(),
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: INSTANCE_ROOT,
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GH_TOKEN: TOKEN,
    SDLC_PREFLIGHT_COMMAND: COMMAND,
    SDLC_PREFLIGHT_EXIT_CODE: "0",
    SDLC_PREFLIGHT_STDOUT_FILE: stdoutFile,
  };
  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: world.dir, env, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(outcome.code, 1, outcome.err);
  assert.match(outcome.out, /snapshot: 1 completed run\(s\)/);
  assert.equal(requests.length, RECORDED_RUNS.length);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
});
