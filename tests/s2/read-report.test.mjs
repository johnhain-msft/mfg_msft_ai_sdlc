// AC45: the report step of an implementation workflow. read-report.mjs reads one drift report of the target repository with an App
// installation token, checks that it is a report of this project that the App filed, records the open implementation pull request of that
// report if there is one, and hands the agent report.md and report.json. Anything that is not such a report stops the run before the agent.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../../src/drift/read-report.mjs";
import { listTree, tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./helpers/stub-server.mjs";

const OWNER = "example-owner";
const TARGET = `${OWNER}/example-target`;
const KEY = "alpha-docs";
const AUTHOR = "example-app[bot]";
const ISSUE = `/repos/${TARGET}/issues/32`;
const PULLS = `/repos/${TARGET}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:sdlc/implement-report-32`)}&per_page=10`;
const BODY = "## Summary\n\nBaseline: run 7.\n\n## Recommended\n\n- [ ] Say GA in docs/20.md (https://github.blog/changelog/x)\n\n## Limitations\n\nNone.\n";
const args = (out, extra = []) => ["--out", out, "--target-repo", TARGET, "--report-issue", "32", "--project-key", KEY, "--author", AUTHOR, ...extra];
const env = (extra = {}) => cleanEnv({ GH_APP_INSTALLATION_TOKEN: "ghs_installationtoken", ...extra });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const rsa = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

function issueOf(overrides = {}) {
  return {
    number: 32,
    html_url: `https://github.com/${TARGET}/issues/32`,
    title: `[sdlc-drift] Drift report: ${KEY} 2026-11-14`,
    state: "open",
    user: { login: AUTHOR, type: "Bot" },
    labels: [{ name: "sdlc-drift" }, { name: "drift-report" }, { name: "automated" }],
    created_at: "2026-11-14T04:58:00Z",
    body: BODY,
    ...overrides,
  };
}

/** The target repository: the report, the open pull requests of its implementation branch and, for the App credential, the token exchange. */
function api({ issue = issueOf(), pulls = [], issueStatus = 200 } = {}) {
  return createFakeFetch((entry) => {
    if (entry.pathAndSearch === "/app/installations?per_page=100") return json(200, [{ id: 77, account: { login: OWNER } }]);
    if (entry.method === "POST" && entry.path === "/app/installations/77/access_tokens") return json(201, { token: "ghs_minted", expires_at: "2026-11-14T13:00:00Z" });
    if (entry.method === "GET" && entry.pathAndSearch === ISSUE) return issueStatus === 200 ? json(200, issue) : json(issueStatus, { message: "Not Found" });
    if (entry.method === "GET" && entry.pathAndSearch === PULLS) return json(200, pulls);
    return json(404, { message: "Not Found" });
  });
}

test("AC45: an open drift report of this project that the App filed is read with two GET requests and handed to the agent as report.md and report.json", async () => {
  const out = tempDir("sdlc-s2-report-");
  try {
    const fetch = api();
    const result = await invoke(run, args(out), { env: env(), fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fetch.requests.map((request) => `${request.method} ${request.pathAndSearch}`), [`GET ${ISSUE}`, `GET ${PULLS}`]);
    assert.ok(fetch.requests.every((request) => request.headers.authorization === "Bearer ghs_installationtoken"));
    assert.deepEqual(listTree(out), ["report.json", "report.md"]);
    const markdown = fs.readFileSync(path.join(out, "report.md"), "utf8");
    assert.ok(markdown.startsWith(`# [sdlc-drift] Drift report: ${KEY} 2026-11-14\n`), markdown.slice(0, 80));
    assert.ok(markdown.includes(`https://github.com/${TARGET}/issues/32`));
    assert.ok(markdown.endsWith(BODY), "the body follows verbatim");
    assert.deepEqual(readJson(path.join(out, "report.json")), {
      version: 1,
      repository: TARGET,
      number: 32,
      url: `https://github.com/${TARGET}/issues/32`,
      title: `[sdlc-drift] Drift report: ${KEY} 2026-11-14`,
      createdAt: "2026-11-14T04:58:00Z",
      author: AUTHOR,
      labels: ["automated", "drift-report", "sdlc-drift"],
      branch: "implement-report-32",
      openPullRequests: [],
      body: BODY,
    });
    assert.match(result.stdout, /read-report: report #32 of example-owner\/example-target/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC45: an open implementation pull request of the report is recorded, so that the agent does not open a second one", async () => {
  const out = tempDir("sdlc-s2-report-open-");
  try {
    const pulls = [{ number: 40, html_url: `https://github.com/${TARGET}/pull/40`, head: { ref: "sdlc/implement-report-32" }, draft: false }];
    const result = await invoke(run, args(out), { env: env(), fetch: api({ pulls }) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readJson(path.join(out, "report.json")).openPullRequests, [{ number: 40, url: `https://github.com/${TARGET}/pull/40`, headRef: "sdlc/implement-report-32" }]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC45 and AC9: with the App credential the token is minted for the target repository alone, with issues: read and pull_requests: read", async () => {
  const out = tempDir("sdlc-s2-report-app-");
  try {
    const fetch = api();
    const { privateKey } = rsa();
    const result = await invoke(run, args(out), { env: cleanEnv({ APP_CLIENT_ID: "Iv1.fixture", APP_PRIVATE_KEY: privateKey }), fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fetch.requests.map((request) => `${request.method} ${request.pathAndSearch}`), ["GET /app/installations?per_page=100", "POST /app/installations/77/access_tokens", `GET ${ISSUE}`, `GET ${PULLS}`]);
    assert.deepEqual(JSON.parse(fetch.requests[1].body), { repositories: ["example-target"], permissions: { issues: "read", pull_requests: "read" } });
    assert.ok(fetch.requests.slice(2).every((request) => request.headers.authorization === "Bearer ghs_minted"));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC45: the target repository comes from --target-repo, else CONFIGURED_TARGET_REPO", async () => {
  const out = tempDir("sdlc-s2-report-configured-");
  try {
    const fetch = api();
    const argv = args(out).filter((value, index, all) => value !== "--target-repo" && all[index - 1] !== "--target-repo");
    const result = await invoke(run, argv, { env: env({ CONFIGURED_TARGET_REPO: TARGET }), fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fetch.requests[0].pathAndSearch, ISSUE);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC45: what is not an open drift report of this project that the App filed stops the run before the agent and writes nothing", async () => {
  const cases = [
    ["a closed report", { issue: issueOf({ state: "closed" }) }, /is closed/],
    ["a pull request", { issue: issueOf({ pull_request: { url: "https://api.github.com/x" } }) }, /is a pull request/],
    ["an issue that someone else opened", { issue: issueOf({ user: { login: "someone", type: "User" } }) }, /was opened by someone/],
    ["an issue without the drift-report label", { issue: issueOf({ labels: [{ name: "sdlc-drift" }] }) }, /drift-report/],
    ["the report of another project of the same repository", { issue: issueOf({ title: "[sdlc-drift] Drift report: beta-labs 2026-11-14" }) }, /not a drift report of alpha-docs/],
    ["the report of a project whose key extends this one", { issue: issueOf({ title: `[sdlc-drift] Drift report: ${KEY}-extra 2026-11-14` }) }, /not a drift report of alpha-docs/],
    ["an issue that does not exist", { issueStatus: 404 }, /HTTP 404/],
  ];
  for (const [label, setup, message] of cases) {
    const out = tempDir("sdlc-s2-report-refused-");
    try {
      const result = await invoke(run, args(out), { env: env(), fetch: api(setup) });
      assert.notEqual(result.code, 0, label);
      assert.match(result.stderr, message, label);
      assert.deepEqual(listTree(out), [], `${label}: nothing is written`);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
});

test("AC45: a report_issue that is not a positive whole number is refused before any request", async () => {
  for (const value of ["", "0", "-3", "12a", "1e3", "3.0", " 32", "99999999999"]) {
    const out = tempDir("sdlc-s2-report-number-");
    try {
      const fetch = api();
      const argv = args(out).map((item, index, all) => (all[index - 1] === "--report-issue" ? value : item));
      const result = await invoke(run, argv, { env: env(), fetch });
      assert.notEqual(result.code, 0, JSON.stringify(value));
      assert.match(result.stderr, /report_issue/, JSON.stringify(value));
      assert.equal(fetch.requests.length, 0, `${JSON.stringify(value)}: no request`);
      assert.deepEqual(listTree(out), []);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
});

test("AC45: a missing project key or author is a usage error of the workflow, and no credential at all is refused", async () => {
  const out = tempDir("sdlc-s2-report-usage-");
  try {
    for (const flag of ["--project-key", "--author"]) {
      const argv = args(out).filter((value, index, all) => value !== flag && all[index - 1] !== flag);
      const result = await invoke(run, argv, { env: env(), fetch: api() });
      assert.equal(result.code, 2, flag);
    }
    const fetch = api();
    const bare = await invoke(run, args(out), { env: cleanEnv(), fetch });
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /no GitHub App credential/);
    assert.equal(fetch.requests.length, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
