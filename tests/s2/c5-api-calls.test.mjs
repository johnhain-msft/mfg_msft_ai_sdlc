// AC26: contract C5 request, API calls. The create-pull-request step of safe-outputs makes the calls that open a pull request on an upstream
// repository: the refs, the pull request and its labels. No S2 script issues any of them, nor any other write request to an upstream
// repository, so a pull request is created only in that step. S2's own read call is the GET of AC10.
//
// The handler documentation describes the branch push as a GraphQL call (F47); the safe-outputs handler is not an S2 script, and what S2
// asserts is the other side of the contract: its scripts send no write to an upstream repository, over REST or GraphQL.
// Every script is run in-process against a recording fake `fetch` (no socket is opened); the dedupe command is also run once as a process
// against a recording stub server on 127.0.0.1.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as checkResponse } from "../../src/drift/check-pr-response.mjs";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { run as escalate } from "../../src/drift/escalate-gate-failure.mjs";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { run as snapshot } from "../../src/snapshot-watch-sources.mjs";
import { run as validate } from "../../src/validate-copilot-lab-audit.mjs";
import { abs, DRIFT_KEYS, driftPreset, fixture, listTree, readText, script, tempDir, WORKFLOWS } from "./helpers/fixtures.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { createSnapshotWorkspace, invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json, runNode, startStubServer } from "./helpers/stub-server.mjs";

const OWNER = "example-owner";
const REPO = "example-target";
const TARGET = `${OWNER}/${REPO}`;
const CENTRAL = "example-owner/example-central";
const PULLS = `/repos/${TARGET}/pulls?state=open&per_page=30`;
const CASE_INSENSITIVE_TARGET = new RegExp(`^/repos/${TARGET}(?:/|$)`, "i");
const rsa = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const label = (request) => `${request.method} ${request.pathAndSearch}`;

/** One fake that stands for GitHub and for the watched pages: it answers every endpoint that an S2 script may legitimately call. */
function githubAndPages() {
  const issues = [];
  return createFakeFetch((entry) => {
    if (entry.host === "api.github.com") {
      if (entry.pathAndSearch === "/app/installations?per_page=100") return json(200, [{ id: 77, account: { login: OWNER } }]);
      if (entry.method === "POST" && entry.path === "/app/installations/77/access_tokens") return json(201, { token: "ghs_minted", expires_at: "2026-11-06T13:00:00Z" });
      if (entry.pathAndSearch === PULLS) return json(200, [{ number: 3, html_url: `https://github.example/${TARGET}/pull/3`, head: { ref: "sdlc/weekly-audit-2026-11-01" }, labels: [], draft: false }]);
      if (entry.method === "GET" && entry.path === `/repos/${CENTRAL}/issues`) return json(200, issues);
      if (entry.method === "POST" && entry.path === `/repos/${CENTRAL}/issues`) {
        const issue = { number: issues.length + 1, state: "open", ...JSON.parse(entry.body), labels: [{ name: "sdlc-gate-failure" }] };
        issues.push(issue);
        return json(201, issue);
      }
      if (entry.method === "PATCH" && entry.path === `/repos/${CENTRAL}/issues/1`) return json(200, Object.assign(issues[0], JSON.parse(entry.body)));
      return json(404, { message: "Not Found" });
    }
    return { status: 200, headers: { "content-type": "text/html" }, body: `<html>${entry.url}</html>` };
  });
}

/** Runs each script once (the escalation twice, so that it both creates and updates), against one shared recording fetch. */
async function runEveryScript() {
  const fetch = githubAndPages();
  const clock = createClock();
  const workspace = createSnapshotWorkspace();
  const lab = createRepo(labFiles());
  const validateOut = tempDir("sdlc-s2-api-validate-");
  const { privateKey } = rsa();
  const calls = {};
  try {
    const record = async (name, task) => {
      const before = fetch.requests.length;
      const result = await task();
      calls[name] = { result, requests: fetch.requests.slice(before) };
    };
    const common = { fetch, now: clock.now, sleep: clock.sleep };
    const workspaceEnv = { CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: workspace.workspace };
    await record("prepare-run", () => invoke(prepare, ["--out", workspace.out, "--target-repo", TARGET, "--dry-run", "true", "--checkout", "checkout"], { ...common, env: cleanEnv(workspaceEnv) }));
    await record("dedupe (installation token)", () => invoke(dedupe, ["--out", path.join(workspace.out, "a"), "--target-repo", TARGET], { ...common, env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GH_APP_INSTALLATION_TOKEN: "ghs_token" }) }));
    await record("dedupe (App credential)", () => invoke(dedupe, ["--out", path.join(workspace.out, "b"), "--target-repo", TARGET], { ...common, env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, APP_CLIENT_ID: "Iv1.fixture", APP_PRIVATE_KEY: privateKey }) }));
    await record("snapshot (fixture manifest)", () => invoke(snapshot, ["--out", path.join(workspace.out, "c"), "--project", "snapshot-fixture", "--manifest", workspace.manifest, "--checkout", workspace.checkout, "--timeout-ms", "150"], { ...common, env: cleanEnv() }));
    for (const key of DRIFT_KEYS) {
      await record(`snapshot (preset ${key})`, () => invoke(snapshot, ["--out", path.join(workspace.out, `preset-${key}`), "--project", key, "--manifest", abs("sdlc.yaml"), "--checkout", lab.dir, "--timeout-ms", "150"], { ...common, env: cleanEnv() }));
    }
    const escalateEnv = cleanEnv({ GH_TOKEN: "ghs_jobtoken", GITHUB_REPOSITORY: CENTRAL });
    const escalateArgs = (suffix) => ["--workflow-id", "drift-example", "--target-repo", TARGET, "--correlation-id", `corr-${suffix}`, "--run-url", `https://github.com/${CENTRAL}/actions/runs/9`, "--failing-command", "npm test"];
    await record("escalate-gate-failure (create)", () => invoke(escalate, escalateArgs(1), { ...common, env: escalateEnv }));
    await record("escalate-gate-failure (update)", () => invoke(escalate, escalateArgs(2), { ...common, env: escalateEnv }));
    await record("check-pr-response", () => invoke(checkResponse, [fixture("pr-response", "valid.json"), "--workflow", abs(WORKFLOWS, "drift-copilot-lab.md")], common));
    await record("validate-copilot-lab-audit", () => invoke(validate, ["--checkout", lab.dir, "--out", validateOut, "--base-sha", lab.head()], { ...common, cwd: validateOut, env: cleanEnv() }));
    return { calls, requests: fetch.requests };
  } finally {
    workspace.cleanup();
    lab.cleanup();
    fs.rmSync(validateOut, { recursive: true, force: true });
  }
}

test("AC26: every script of src/drift/ is covered by this suite: the list below is the directory", () => {
  const scripts = fs.readdirSync(abs("src", "drift")).filter((entry) => entry.endsWith(".mjs")).sort();
  assert.deepEqual(scripts, ["check-pr-response.mjs", "dedupe-open-prs.mjs", "escalate-gate-failure.mjs", "prepare-run.mjs"], "a new script needs a case in runEveryScript");
});

let everyScript;
/** One run of every script is shared by the tests below: they only read what it recorded. */
const recorded = () => (everyScript ??= runEveryScript());

test("AC26: the only request to an upstream-repository path is the GET of AC10, and no S2 script sends a git ref, pull request, merge or review write", async () => {
  const { calls, requests } = await recorded();
  for (const [name, { result }] of Object.entries(calls)) assert.equal(result.code, 0, `${name}: ${result.stderr}`);
  const upstream = requests.filter((request) => CASE_INSENSITIVE_TARGET.test(request.path));
  assert.deepEqual(upstream.map(label), [`GET ${PULLS}`, `GET ${PULLS}`], "the dedupe reads, once with each kind of credential, and nothing else touches the target repository");
  assert.deepEqual(
    calls["dedupe (installation token)"].requests.map(label),
    [`GET ${PULLS}`],
    "with an installation token it is the one request",
  );
  assert.deepEqual(calls["dedupe (App credential)"].requests.map(label), ["GET /app/installations?per_page=100", "POST /app/installations/77/access_tokens", `GET ${PULLS}`]);
  for (const request of requests) {
    const where = label(request);
    assert.equal(request.path.endsWith("/git/refs") || /\/git\/refs\//.test(request.path), false, where);
    assert.equal(/\/pulls(\/\d+)?$/.test(request.path) && request.method !== "GET", false, `${where}: a pull request write`);
    assert.equal(request.path.endsWith("/merge"), false, where);
    assert.equal(request.path.endsWith("/reviews"), false, where);
    assert.equal(request.path.endsWith("/graphql") || request.path.includes("/graphql"), false, `${where}: no GraphQL call, so no branch push`);
    assert.equal(/\/(statuses|check-runs|check-suites|dispatches|labels|comments)(\/|$)/.test(request.path) && CASE_INSENSITIVE_TARGET.test(request.path), false, where);
  }
});

test("AC26: every write request of the scripts is the installation-token exchange or an issue of the central repository", async () => {
  const { requests } = await recorded();
  const writes = requests.filter((request) => request.method !== "GET");
  assert.deepEqual(writes.map(label), ["POST /app/installations/77/access_tokens", `POST /repos/${CENTRAL}/issues`, `PATCH /repos/${CENTRAL}/issues/1`]);
  const nonGithub = requests.filter((request) => request.host !== "api.github.com");
  assert.ok(nonGithub.length > 0, "the snapshots fetched pages");
  assert.ok(nonGithub.every((request) => request.method === "GET"), "and only read them");
  assert.equal(nonGithub.some((request) => CASE_INSENSITIVE_TARGET.test(request.path) && request.host === "api.github.com"), false);
});

test("AC26: the scripts that do not read from GitHub send no request at all", async () => {
  const { calls } = await recorded();
  for (const name of ["prepare-run", "check-pr-response", "validate-copilot-lab-audit"]) assert.deepEqual(calls[name].requests, [], `${name} sends no request`);
  for (const key of DRIFT_KEYS) {
    const urls = calls[`snapshot (preset ${key})`].requests.map((request) => request.url);
    assert.deepEqual([...urls].sort(), driftPreset(key).driftAudit.knowledgeSources.watchUrls.map((entry) => entry.url).sort(), `${key}: the snapshot fetches exactly the configured watchUrls`);
  }
});

test("AC26: the escalation writes only to the central repository: its requests never name the upstream repository", async () => {
  const { calls } = await recorded();
  for (const name of ["escalate-gate-failure (create)", "escalate-gate-failure (update)"]) {
    for (const request of calls[name].requests) {
      assert.ok(request.path.startsWith(`/repos/${CENTRAL}/`), `${name}: ${label(request)}`);
      assert.equal(request.path.toLowerCase().includes(TARGET.toLowerCase()), false, `${name}: the upstream repository is named only in the issue text`);
    }
  }
});

test("AC26: run as a command against a stub server on 127.0.0.1, dedupe-open-prs sends the one GET and nothing more", async () => {
  const server = await startStubServer((entry) => (entry.pathAndSearch === PULLS ? json(200, []) : json(404, { message: "Not Found" })));
  const directory = tempDir("sdlc-s2-api-command-");
  try {
    const result = await runNode(script("drift", "dedupe-open-prs.mjs"), ["--out", directory, "--target-repo", TARGET], {
      env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GH_APP_INSTALLATION_TOKEN: "ghs_token", GITHUB_API_URL: server.url }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.requests.map((request) => `${request.method} ${request.pathAndSearch}`), [`GET ${PULLS}`]);
    assert.deepEqual(listTree(directory), ["open-pr-dedup.json", "open-prs.json"]);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC26: no script names a git ref, review, merge, status or GraphQL endpoint, and none calls a PUT or DELETE", () => {
  const files = [abs("src", "snapshot-watch-sources.mjs"), abs("src", "validate-copilot-lab-audit.mjs"), ...listTree(abs("src", "drift")).filter((file) => file.endsWith(".mjs")).map((file) => abs("src", "drift", file))];
  for (const file of files) {
    const code = readText(file).split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    assert.equal(/git\/refs|\/reviews|\/merge|graphql|\/statuses|check-runs|\/dispatches/i.test(code), false, `${path.basename(file)} names a forbidden endpoint`);
    assert.equal(/\b(requestJson|request)\(\s*["'`](PUT|DELETE)["'`]/.test(code), false, `${path.basename(file)} calls PUT or DELETE`);
    assert.equal(/\/pulls[^"'`\n]*["'`]\s*,\s*\{[^}]*method:\s*["'`](POST|PATCH|PUT|DELETE)/.test(code), false, `${path.basename(file)} writes a pull request`);
  }
});
