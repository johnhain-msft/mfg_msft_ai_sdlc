// S3 is the sole writer of the poll state, and writes nothing else outside the orchestrator repository (SPEC-03 AC8, AC29): only GET requests reach an upstream or a
// downstream repository; the only other requests are the dispatch, the PATCH of the state variable and the issue upsert, all in the orchestrator repository, and the
// exchange of the App's JWT for an installation token, which changes no repository; src/update-poll-state.mjs is the only file that names the variables endpoint; and no
// script of S3 edits sdlc.yaml, the manifest schema or a workflow.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { flagsFor, invoke, TARGET, world as pollWorld } from "./helpers/poll-state-world.mjs";
import { abs, edge, mechanicalEdge, presetEdges, REPO_ROOT, routerMatrixEntries, sha, state } from "./helpers/fixtures.mjs";
import { CHANGED_REPORT, IN_SYNC, preflightEdge } from "./helpers/preflight-world.mjs";

const isNonGet = (request) => request.method !== "GET";
const inRepo = (request, slug) => request.path === `/repos/${slug}` || request.path.startsWith(`/repos/${slug}/`);

/** Every kind of route that the router can take, each against its own stub, with the requests that it made. */
async function routerScenarios() {
  const runs = [];
  const add = async (label, build, go = (w) => w.go()) => {
    const w = build();
    const result = await go(w);
    runs.push({ label, w, result });
  };
  const e = edge();
  await add("dispatch (ai)", () => routerWorld());
  await add("dispatch (mechanical)", () => routerWorld({ edge: mechanicalEdge(), upstream: { head: sha("h") } }));
  await add("noop 304", () => routerWorld({ state: state({ etag: 'W/"upstream-etag-1"', lastObservedHeadSha: sha("head-1"), lastNoopHeadSha: sha("head-1") }, e) }));
  await add("merged pull request reconciled", () =>
    routerWorld({
      state: state({ openPrNumber: 4, openPrTargetSha: sha("open") }, e),
      downstream: { pulls: { 4: { number: 4, state: "closed", merged: true, html_url: "https://github.com/x/y/pull/4", head: { ref: e.branchName, sha: sha("pr") } } } },
    }));
  await add("failure (500 on the poll)", () => {
    const w = routerWorld();
    w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
    return w;
  });
  await add("failure comments on an existing issue", () => {
    const w = routerWorld();
    w.stub.issues.push({ number: 9, title: `[sdlc-failure] cascade-router (${e.upstreamRepo})`, state: "open", body: "", labels: [] });
    w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
    return w;
  });
  const lab = preflightEdge();
  await add(
    "preflight noop",
    () => routerWorld({ edge: lab, state: state({}, lab), upstream: { head: sha("h2") } }),
    (w) => w.go({ preflightDeps: fakePreflight([{ match: /sync:workshop-source/, code: 1, stdout: "Inputs checked: 3; changed 0, new 0, gone 0\n" }, { match: /lab-studio-drift/, code: 0, stdout: `${JSON.stringify(IN_SYNC)}\n` }]).deps }),
  );
  await add(
    "preflight dispatch",
    () => routerWorld({ edge: lab, state: state({}, lab), upstream: { head: sha("h3") } }),
    (w) => w.go({ preflightDeps: fakePreflight([{ match: /sync:workshop-source/, code: 1, stdout: CHANGED_REPORT }, { match: /lab-studio-drift/, code: 0, stdout: `${JSON.stringify(IN_SYNC)}\n` }]).deps }),
  );
  return runs;
}

test("AC29 only GET requests reach an upstream or a downstream repository, in every route of the router", async (t) => {
  const runs = await routerScenarios();
  t.after(() => runs.forEach(({ w }) => w.cleanup()));
  assert.ok(runs.length >= 8);
  for (const { label, w } of runs) {
    for (const slug of [w.edge.upstreamRepo, w.edge.downstreamRepo]) {
      const writes = w.stub.requests.filter((request) => isNonGet(request) && inRepo(request, slug));
      assert.deepEqual(writes.map((request) => `${request.method} ${request.path}`), [], `${label}: ${slug}`);
    }
  }
});

test("AC29 the only other requests are the dispatch, the PATCH of the variable of the edge, the issue upsert, and the token exchange", async (t) => {
  const runs = await routerScenarios();
  t.after(() => runs.forEach(({ w }) => w.cleanup()));
  const seen = new Set();
  for (const { label, w } of runs) {
    const central = w.central.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const allowed = [
      [/^POST$/, new RegExp(`^/repos/${central}/actions/workflows/[^/]+/dispatches$`), "dispatch"],
      [/^PATCH$/, new RegExp(`^/repos/${central}/actions/variables/${w.edge.stateVariable}$`), "state"],
      [/^POST$/, new RegExp(`^/repos/${central}/issues$`), "issue"],
      [/^POST$/, new RegExp(`^/repos/${central}/issues/\\d+/comments$`), "comment"],
      [/^POST$/, /^\/app\/installations\/\d+\/access_tokens$/, "token exchange"],
    ];
    for (const request of w.stub.requests.filter(isNonGet)) {
      const kind = allowed.find(([method, pathPattern]) => method.test(request.method) && pathPattern.test(request.path));
      assert.ok(kind, `${label}: ${request.method} ${request.path}`);
      seen.add(kind[2]);
    }
  }
  assert.deepEqual([...seen].sort(), ["comment", "dispatch", "issue", "state", "token exchange"], "every kind of write was exercised");
});

test("AC29 the poll-state script sends only GET to the downstream repository, and its writes are the PATCH of the variable and the issue upsert", async (t) => {
  const success = pollWorld();
  const noChange = pollWorld();
  const failed = pollWorld({ pulls: [] });
  const recordFailure = pollWorld();
  t.after(() => [success, noChange, failed, recordFailure].forEach((w) => w.workspace.cleanup()));
  await invoke(success, flagsFor(success.edgeValue));
  await invoke(noChange, flagsFor(noChange.edgeValue, { "--head-sha": sha("base") }));
  await invoke(failed, flagsFor(failed.edgeValue));
  await invoke(recordFailure, ["--record-failure", "--slug", recordFailure.edgeValue.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "wf"]);
  for (const w of [success, noChange, failed, recordFailure]) {
    const e = w.edgeValue;
    assert.deepEqual(w.stub.requests.filter((request) => isNonGet(request) && inRepo(request, e.downstreamRepo)), []);
    for (const request of w.stub.requests.filter(isNonGet)) {
      const label = `${request.method} ${request.path}`;
      assert.ok(
        (request.method === "PATCH" && request.path === `/repos/acme/orchestrator/actions/variables/${e.stateVariable}`) ||
          (request.method === "POST" && /^\/repos\/acme\/orchestrator\/issues(\/\d+\/comments)?$/.test(request.path)),
        label,
      );
    }
  }
  assert.equal(success.stub.calls("PATCH").length, 1);
  assert.equal(failed.stub.issues.length, 1);
});

function filesUnder(directory, extensions) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

test("AC33 the router and the poll-state script use REST only: no GraphQL in their source or in the modules that they use, and no request to a GraphQL endpoint in any route", async (t) => {
  const files = [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
  for (const file of files) assert.equal(/graphql/i.test(fs.readFileSync(file, "utf8")), false, path.relative(REPO_ROOT, file));
  const runs = await routerScenarios();
  t.after(() => runs.forEach(({ w }) => w.cleanup()));
  for (const { label, w } of runs) {
    for (const request of w.stub.requests) assert.equal(/graphql/i.test(`${request.path} ${request.body ?? ""}`), false, `${label}: ${request.method} ${request.path}`);
  }
});

test("AC29 rg actions/variables finds only src/update-poll-state.mjs under src and .github/workflows", () => {
  const candidates = [...filesUnder(abs("src"), [".mjs", ".js", ".json"]), ...filesUnder(abs(".github", "workflows"), [".yml", ".md", ".json"])];
  const holders = candidates.filter((file) => fs.readFileSync(file, "utf8").includes("actions/variables")).map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, "/"));
  assert.deepEqual(holders, ["src/update-poll-state.mjs"]);
});

// ---- AC8: the scripts change none of the files that S1 owns -------------------------------------------------------------------------------------------------

function snapshot() {
  const files = [abs("sdlc.yaml"), abs("schemas", "sdlc.schema.json"), ...filesUnder(abs(".github", "workflows"), [""])];
  return Object.fromEntries(files.sort().map((file) => [path.relative(REPO_ROOT, file).replace(/\\/g, "/"), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
}

test("AC8 the scripts, run against the real manifest of the repository, change none of sdlc.yaml, schemas/sdlc.schema.json and .github/workflows", async (t) => {
  const before = snapshot();
  assert.ok(Object.keys(before).length > 10, "the workflows are in the snapshot");
  for (const entry of routerMatrixEntries()) {
    const manifestEdge = presetEdges().find((candidate) => candidate.upstreamKey === entry.upstreamKey);
    const w = routerWorld({ central: "johnhain-msft/mfg_msft_ai_sdlc", edge: entry, manifestEdges: [manifestEdge], state: state({}, entry), env: { GITHUB_WORKSPACE: REPO_ROOT } });
    t.after(() => w.cleanup());
    const result = await w.go({ preflightDeps: fakePreflight([{ match: /.*/, code: 1, stdout: "" }]).deps });
    assert.ok(result.code === 0 || result.code === 1, entry.upstreamKey);
  }
  const poll = pollWorld({ edgeValue: presetEdges().find((entry) => entry.mode === "mechanical") });
  t.after(() => poll.workspace.cleanup());
  await invoke(poll, flagsFor(poll.edgeValue), { env: { GITHUB_WORKSPACE: REPO_ROOT } });
  await invoke(poll, ["--record-failure", "--slug", poll.edgeValue.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "wf"], { env: { GITHUB_WORKSPACE: REPO_ROOT } });
  assert.deepEqual(snapshot(), before, "git diff --exit-code sdlc.yaml schemas/sdlc.schema.json .github/workflows stays clean");
});

test("AC8 the scripts write no file but the step summary: the only file writes of the two scripts and of the router's modules are the decision log and the checkouts' own directories", () => {
  const writing = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rmSync|renameSync|copyFileSync|mkdirSync|mkdtempSync|unlinkSync|symlinkSync|chmodSync|createWriteStream)\b/;
  const files = [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
  const found = [];
  for (const file of files) {
    for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      if (!line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && writing.test(line)) found.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, "/")}: ${line.trim()}`);
      void index;
    }
  }
  assert.deepEqual(found.map((entry) => entry.split(":")[0]).sort(), ["src/route-upstream.mjs", "src/routing/git.mjs", "src/routing/git.mjs", "src/routing/git.mjs", "src/routing/git.mjs"], found.join("\n"));
  assert.ok(found.find((entry) => entry.startsWith("src/route-upstream.mjs")).includes("appendFileSync(summary"), "the router's one write is the decision log");
});
