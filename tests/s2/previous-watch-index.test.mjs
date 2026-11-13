// AC41: the watch index of the previous successful run, fetched before the snapshot so that the snapshot can say what changed since then.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../../src/drift/previous-watch-index.mjs";
import { tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./helpers/stub-server.mjs";
import { zipOf } from "./helpers/zip-fixture.mjs";

const REPO = "example-owner/orchestrator";
const WORKFLOW = "drift-alpha.lock.yml";
const ARTIFACT = "sdlc-watch-index-alpha";
const INDEX = { version: 1, project: "alpha", sources: [{ url: "https://e.test/feed", kind: "feed", state: "ok", textSha256: "a".repeat(64), entries: ["https://e.test/1"] }], citedPages: [] };
const BLOB = "https://blob.example.test/artifact-78.zip?sig=secret-signature";
const env = (extra = {}) => cleanEnv({ GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "500", GH_TOKEN: "ghs_jobtoken", GITHUB_API_URL: "https://api.github.com", ...extra });
const args = (out) => ["--out", out, "--workflow", WORKFLOW, "--artifact", ARTIFACT];
const runOf = (id) => ({ id, html_url: `https://github.com/${REPO}/actions/runs/${id}`, created_at: `2026-11-0${id % 10}T13:23:00Z`, head_branch: "main" });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The API of a repository whose newest successful runs are the current run (500), a dry run without the artifact (499) and a run with it (498). */
function api({ index = INDEX, runs = [runOf(500), runOf(499), runOf(498)], artifacts = {} } = {}) {
  const archive = zipOf({ "watch-index.json": JSON.stringify(index) });
  const byRun = { 499: [], 498: [{ id: 77, name: ARTIFACT, expired: true }, { id: 78, name: ARTIFACT, expired: false }], ...artifacts };
  return createFakeFetch((entry) => {
    if (entry.host === "blob.example.test") return { status: 200, headers: { "content-type": "application/zip" }, body: archive };
    if (entry.pathAndSearch === `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=20`) return json(200, { total_count: runs.length, workflow_runs: runs });
    const listing = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts$/.exec(entry.path);
    if (listing && entry.search === `?name=${ARTIFACT}&per_page=10`) return json(200, { total_count: (byRun[listing[1]] ?? []).length, artifacts: byRun[listing[1]] ?? [] });
    if (entry.path === `/repos/${REPO}/actions/artifacts/78/zip`) return { status: 302, headers: { location: BLOB }, body: "" };
    return json(404, { message: "Not Found" });
  });
}

test("AC41: the newest successful run that kept the artifact is the baseline: its index is unpacked and named, and the download carries no credential", async () => {
  const out = tempDir("sdlc-s2-previous-");
  try {
    const fetch = api();
    const result = await invoke(run, args(out), { env: env(), fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readJson(path.join(out, "previous", "watch-index.json")), INDEX);
    assert.deepEqual(readJson(path.join(out, "previous", "baseline.json")), {
      found: true,
      runId: 498,
      runUrl: `https://github.com/${REPO}/actions/runs/498`,
      createdAt: "2026-11-08T13:23:00Z",
      artifactId: 78,
      workflow: WORKFLOW,
      artifact: ARTIFACT,
    });
    assert.deepEqual(
      fetch.requests.map((request) => `${request.method} ${request.host}${request.pathAndSearch.replace(/\?sig=.*$/, "?sig=…")}`),
      [
        `GET api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=20`,
        `GET api.github.com/repos/${REPO}/actions/runs/499/artifacts?name=${ARTIFACT}&per_page=10`,
        `GET api.github.com/repos/${REPO}/actions/runs/498/artifacts?name=${ARTIFACT}&per_page=10`,
        `GET api.github.com/repos/${REPO}/actions/artifacts/78/zip`,
        "GET blob.example.test/artifact-78.zip?sig=…",
      ],
      "the current run is skipped, a run without the artifact is passed over and an expired artifact is not downloaded",
    );
    assert.equal(fetch.requests.at(-1).headers.authorization, undefined, "the token never goes to the storage host");
    assert.equal(fetch.requests[0].headers.authorization, "Bearer ghs_jobtoken");
    assert.equal(result.stdout.includes("secret-signature"), false, "the signed download URL is not printed");
    assert.match(result.stdout, /previous-watch-index: baseline is run 498/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC41: when no successful run kept the artifact the step says so, removes a stale index and still succeeds", async () => {
  const out = tempDir("sdlc-s2-previous-");
  try {
    fs.mkdirSync(path.join(out, "previous"), { recursive: true });
    fs.writeFileSync(path.join(out, "previous", "watch-index.json"), JSON.stringify(INDEX));
    const result = await invoke(run, args(out), { env: env(), fetch: api({ artifacts: { 498: [] } }) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(out, "previous", "watch-index.json")), false);
    assert.deepEqual(readJson(path.join(out, "previous", "baseline.json")), {
      found: false,
      reason: `no successful run of ${WORKFLOW} among the last 20 has an unexpired artifact named ${ARTIFACT}`,
      workflow: WORKFLOW,
      artifact: ARTIFACT,
    });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC41: an API failure or an index of another version is a missing baseline with its reason and a warning, never a failed job", async () => {
  for (const [label, fetch, reason] of [
    ["403", createFakeFetch(() => json(403, { message: "Resource not accessible by integration" })), /returned HTTP 403: Resource not accessible by integration/],
    ["version", api({ index: { ...INDEX, version: 2 } }), /run 498 holds a watch index that this version cannot compare with/],
  ]) {
    const out = tempDir("sdlc-s2-previous-");
    try {
      const result = await invoke(run, args(out), { env: env(), fetch });
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      const baseline = readJson(path.join(out, "previous", "baseline.json"));
      assert.equal(baseline.found, false, label);
      assert.match(baseline.reason, reason, label);
      assert.match(result.stdout, /^::warning::/m, label);
      assert.equal(fs.existsSync(path.join(out, "previous", "watch-index.json")), false, label);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
});

test("AC9, AC41: a personal access token is refused before any request is sent, and the run goes on without a baseline", async () => {
  const out = tempDir("sdlc-s2-previous-");
  try {
    const fetch = api();
    const result = await invoke(run, args(out), { env: env({ GH_TOKEN: "ghp_personal" }), fetch });
    assert.equal(result.code, 0);
    assert.equal(fetch.requests.length, 0);
    assert.match(readJson(path.join(out, "previous", "baseline.json")).reason, /not a GitHub App installation token \(personal access token\)/);
    assert.equal(result.stdout.includes("ghp_personal"), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC41: a missing option or repository is a usage error of the workflow, not a missing baseline", async () => {
  const out = tempDir("sdlc-s2-previous-");
  try {
    assert.equal((await invoke(run, ["--out", out, "--artifact", ARTIFACT], { env: env(), fetch: api() })).code, 2);
    assert.equal((await invoke(run, args(out), { env: env({ GITHUB_REPOSITORY: "" }), fetch: api() })).code, 2);
    assert.equal((await invoke(run, ["--out", out, "--workflow", "../x.yml", "--artifact", ARTIFACT], { env: env(), fetch: api() })).code, 2);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
