// Round-2 delta: installation-only credentials, index-only pinned values, and
// complete/bounded escalation searches. HTTP is socket-free; git uses disposable
// repositories made from the existing lab fixture, never the working repository.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { composeBody, run as escalate, TITLE } from "../../src/drift/escalate-gate-failure.mjs";
import { indexFileText, openScratch } from "../../src/drift/lib/git-artifacts.mjs";
import { assertInstallationToken, GitHubApiError } from "../../src/drift/lib/github-client.mjs";
import { run as validate } from "../../src/validate-copilot-lab-audit.mjs";
import { forceRemove, hashTree, tempDir } from "./helpers/fixtures.mjs";
import { createRepo, git } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json } from "./helpers/stub-server.mjs";

const CENTRAL = "example/central";
const TARGET = "example/target";
const WORKFLOW = "drift-qa-round2";
const REGISTRY = "docs/_meta/registry.yaml";
const INSTALLATION = "ghs_1234567_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl";
const ISSUE_PATH = `/repos/${CENTRAL}/issues`;
const escalationArgs = ["--workflow-id", WORKFLOW, "--target-repo", TARGET, "--failing-command", "npm test"];
const bump = (text) => text.replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"');

const existingIssue = (number = 90000) => ({
  number,
  title: TITLE(WORKFLOW, TARGET),
  body: composeBody({
    workflowId: WORKFLOW, targetRepo: TARGET, failingCommand: "npm ci",
    runUrl: "https://example.test/earlier", correlationId: "earlier",
    nowMs: Date.UTC(2026, 10, 6, 12), earlier: null,
  }),
  state: "open",
  labels: [{ name: "sdlc-gate-failure" }],
});
const others = (count) => Array.from({ length: count }, (_, index) => ({
  number: index + 1, title: `unrelated ${index + 1}`, body: "unchanged",
  state: "open", labels: [{ name: "sdlc-gate-failure" }],
}));

/** Stateful API double: writes really change the list/body, not just a counter. */
function issueApi(listed, override) {
  const pages = [];
  const fetch = createFakeFetch((entry) => {
    if (entry.method === "GET") {
      assert.equal(entry.path, ISSUE_PATH);
      const query = new URLSearchParams(entry.search);
      assert.equal(query.get("state"), "open");
      assert.equal(query.get("labels"), "sdlc-gate-failure");
      assert.equal(query.get("per_page"), "100");
      const page = Number(query.get("page") ?? 1);
      pages.push(page);
      const replacement = override?.(page, entry);
      if (replacement !== undefined) return replacement;
      const start = (page - 1) * 100;
      const headers = start + 100 < listed.length ? {
        link: `<https://api.github.com${ISSUE_PATH}?state=open&labels=sdlc-gate-failure&per_page=100&page=${page + 1}>; rel="next"`,
      } : {};
      return json(200, listed.slice(start, start + 100), headers);
    }
    if (entry.method === "POST") {
      assert.equal(entry.path, ISSUE_PATH);
      const issue = { number: 99999, ...JSON.parse(entry.body) };
      listed.push(issue);
      return json(201, issue);
    }
    assert.equal(entry.method, "PATCH");
    const number = Number(entry.path.slice(`${ISSUE_PATH}/`.length));
    assert.equal(entry.path, `${ISSUE_PATH}/${number}`);
    const issue = listed.find((candidate) => candidate.number === number);
    assert.ok(issue, "a PATCH must address a real issue in the fake's state");
    Object.assign(issue, JSON.parse(entry.body));
    return json(200, issue);
  });
  return { fetch, pages };
}

async function reportFailure(api, extra = []) {
  const clock = createClock();
  const result = await invoke(escalate, [...escalationArgs, ...extra], {
    env: cleanEnv({ GITHUB_REPOSITORY: CENTRAL, GITHUB_TOKEN: INSTALLATION }),
    fetch: api.fetch, now: clock.now, sleep: clock.sleep,
  });
  return { ...result, waits: clock.waits };
}

test("AC9 QA r2: the installation-only token guard rejects unknown and user kinds without leaking the credential", () => {
  const refused = [
    undefined, null, "", "ghp_fixture-secret", "github_pat_fixture-secret",
    "gho_fixture-secret", "ghu_fixture-secret", "ghr_fixture-secret",
    "legacy-fixture-secret", "GHS_fixture-secret", "eyJhbGciOiJSUzI1NiJ9.fixture.signature",
  ];
  for (const token of refused) {
    assert.throws(() => assertInstallationToken(token, "QA credential"), (error) => {
      assert.ok(error instanceof GitHubApiError, "the guard fails with the API error type");
      assert.match(error.message, /QA credential.*installation token.*required/);
      if (typeof token === "string" && token !== "") assert.equal(error.message.includes(token), false);
      return true;
    }, "a non-installation credential must be refused");
  }
  for (const token of ["ghs_fixture", INSTALLATION]) {
    assert.equal(assertInstallationToken(token), token, "installation tokens are returned unchanged, without a length assumption");
  }
});

test("AC9 QA r2: invalid credentials cannot use GITHUB_TOKEN fallback or replace existing deduplication artifacts", async () => {
  const root = tempDir("sdlc-qa-round2-auth-");
  const out = path.join(root, "agent");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "open-pr-dedup.json"), '{"previous":"dedup"}\n');
  fs.writeFileSync(path.join(out, "open-prs.json"), '{"previous":"compatibility"}\n');
  const before = hashTree(out);
  try {
    for (const token of ["ghu_fixture-secret", "ghr_fixture-secret", "unprefixed-fixture-secret"]) {
      const read = createFakeFetch(() => json(200, []));
      const result = await invoke(dedupe, ["--target-repo", TARGET, "--out", out], {
        cwd: root,
        // Supplying App fields must not turn rejection of an explicit bad token
        // into an attempted mint or a fallback to a different credential.
        env: cleanEnv({ GH_APP_INSTALLATION_TOKEN: ` \t${token}\n`, APP_CLIENT_ID: "not-used", APP_PRIVATE_KEY: "not-used" }),
        fetch: read,
      });
      assert.equal(result.code, 1, "dedupe refuses the explicit non-installation credential");
      assert.equal(read.requests.length, 0, "rejection occurs before either minting or listing");
      assert.equal(hashTree(out), before, "both pre-existing artifacts keep their exact bytes");
      assert.equal(result.stderr.includes(token), false);

      const listed = [existingIssue()];
      const untouched = structuredClone(listed);
      const api = issueApi(listed);
      const rejected = await invoke(escalate, escalationArgs, {
        env: cleanEnv({ GITHUB_REPOSITORY: CENTRAL, GITHUB_TOKEN: ` ${token} ` }),
        fetch: api.fetch,
      });
      assert.equal(rejected.code, 1, "GITHUB_TOKEN fallback also refuses the non-installation credential");
      assert.deepEqual(api.fetch.requests, [], "no jobs/issue request carries the user credential");
      assert.deepEqual(listed, untouched, "no issue is created or its persisted body changed");
      assert.equal(rejected.stderr.includes(token), false);
    }
  } finally {
    forceRemove(root);
  }
});

test("AC9 QA r2: trimmed installation tokens still write deduplication artifacts and update a persisted issue through GITHUB_TOKEN", async () => {
  const root = tempDir("sdlc-qa-round2-installation-");
  const out = path.join(root, "agent");
  try {
    const pulls = [{ number: 1, head: { ref: "sdlc/weekly-audit-2026-11-07" }, html_url: "https://example.test/pr/1" }];
    const read = createFakeFetch(() => json(200, pulls));
    const result = await invoke(dedupe, ["--target-repo", TARGET, "--out", out], {
      env: cleanEnv({ GH_APP_INSTALLATION_TOKEN: ` \t${INSTALLATION}\n` }),
      fetch: read,
    });
    assert.equal(result.code, 0, result.stderr);
    const artifact = fs.readFileSync(path.join(out, "open-pr-dedup.json"), "utf8");
    assert.equal(fs.readFileSync(path.join(out, "open-prs.json"), "utf8"), artifact);
    const report = JSON.parse(artifact);
    assert.equal(report.duplicate, true);
    assert.equal(report.matches[0].number, 1);
    assert.equal(report.matches[0].decision, "skip");
    assert.deepEqual(read.requests.map((entry) => entry.headers.authorization), [`Bearer ${INSTALLATION}`]);

    const issue = existingIssue();
    const listed = [issue];
    const api = issueApi(listed);
    const updated = await invoke(escalate, escalationArgs, {
      env: cleanEnv({ GITHUB_REPOSITORY: CENTRAL, GITHUB_TOKEN: ` \t${INSTALLATION}\n` }),
      fetch: api.fetch,
    });
    assert.equal(updated.code, 0, "the installation token supplied through GITHUB_TOKEN must work");
    assert.equal(listed.length, 1);
    assert.match(issue.body, /\| Occurrences \| 2 \|/);
    assert.match(issue.body, /correlation id `earlier` — failing command: `npm ci`/);
    assert.match(issue.body, /\| Failing command \| `npm test` \|/);
    assert.deepEqual(api.fetch.requests.map((entry) => entry.method), ["GET", "PATCH"]);
    assert.ok(api.fetch.requests.every((entry) => entry.headers.authorization === `Bearer ${INSTALLATION}`));
  } finally {
    forceRemove(root);
  }
});

const stageText = (repo, text, original) => {
  repo.write(REGISTRY, text);
  repo.git("add", "--", REGISTRY);
  repo.write(REGISTRY, original);
};
const deleteIndexEntry = (repo) => repo.git("update-index", "--force-remove", "--", REGISTRY);
const unreadableIndexEntry = (repo) => repo.git("update-index", "--add", "--cacheinfo", `100644,${"1".repeat(40)},${REGISTRY}`);
const conflictIndexEntry = (repo) => {
  const blob = repo.git("rev-parse", `HEAD:${REGISTRY}`);
  deleteIndexEntry(repo);
  // Real multi-stage index entries, not an invented index format or byte fixture.
  const input = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\t${REGISTRY}\n`).join("");
  git(repo.dir, ["update-index", "--index-info"], { input });
};

test("AC22 QA r2: indexFileText reads stage-zero bytes rather than HEAD or the working tree, and absent/conflicted/unreadable entries are null", () => {
  const root = tempDir("sdlc-qa-round2-index-reader-");
  const repo = createRepo(labFiles(), { dir: path.join(root, "checkout with spaces") });
  const original = repo.read(REGISTRY);
  let scratch;
  try {
    stageText(repo, bump(original), original);
    const base = repo.head();
    const before = hashTree(path.join(repo.dir, ".git"));
    scratch = openScratch({ checkout: repo.dir, env: cleanEnv(), fs });
    assert.equal(indexFileText(scratch, REGISTRY), bump(original), "the reader must use the checkout's stage-zero index bytes");
    assert.equal(repo.read(REGISTRY), original);
    assert.equal(repo.head(), base);
    assert.equal(hashTree(path.join(repo.dir, ".git")), before, "the index read writes nothing into the checkout's .git");
    assert.equal(indexFileText(scratch, "docs/_meta/not-in-index.yaml"), null, "a missing index entry is null");

    deleteIndexEntry(repo);
    assert.equal(indexFileText(scratch, REGISTRY), null, "an index-only deletion is null even though HEAD and the file still exist");
    unreadableIndexEntry(repo);
    assert.equal(indexFileText(scratch, REGISTRY), null, "a stage-zero entry with a nonexistent blob is null");
    conflictIndexEntry(repo);
    assert.equal(repo.git("ls-files", "--unmerged", "--", REGISTRY).split("\n").length, 3);
    assert.equal(indexFileText(scratch, REGISTRY), null, "unmerged stages do not silently fall back to HEAD");
  } finally {
    const directory = scratch?.directory;
    scratch?.dispose();
    if (directory) assert.equal(fs.existsSync(directory), false, "the reader's scratch repository was removed");
    forceRemove(root);
  }
});

test("AC22 QA r2: deleted, malformed, conflicted and unreadable index-only registries fail closed without changing the checkout", async () => {
  const cases = [
    ["a bump", (repo, original) => stageText(repo, bump(original), original), 1],
    ["a deleted registry entry", deleteIndexEntry, 1],
    ["malformed YAML", (repo, original) => stageText(repo, original.replace('gh_aw_schema_version: "0.86.2"', "gh_aw_schema_version: [broken"), original), 1],
    ["an unreadable blob", unreadableIndexEntry, 1],
    ["an unmerged registry", conflictIndexEntry, 1],
    ["a mechanical registry edit", (repo, original) => stageText(repo, original.replace('copilot_cli_version_floor: "1.0.82"', 'copilot_cli_version_floor: "1.0.99"'), original), 0],
  ];
  for (const [name, change, expected] of cases) {
    const root = tempDir("sdlc-qa-round2-index-gate-");
    const repo = createRepo(labFiles(), { dir: path.join(root, "checkout") });
    const base = repo.head();
    const original = repo.read(REGISTRY);
    const scratches = [];
    const ioFs = new Proxy(fs, {
      get(target, property) {
        if (property === "mkdtempSync") return (...args) => {
          const directory = target.mkdtempSync(...args);
          scratches.push(directory);
          return directory;
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      change(repo, original);
      assert.equal(repo.head(), base, `${name}: HEAD is unchanged`);
      assert.equal(repo.read(REGISTRY), original, `${name}: the working tree is unchanged`);
      assert.equal(repo.git("diff", "--cached", "--name-only", base), REGISTRY, `${name}: the index really differs from HEAD at the registry`);
      const before = hashTree(repo.dir);
      const result = await invoke(validate, ["--checkout", repo.dir, "--out", path.join(root, "artifacts", "agent")], {
        cwd: root, env: cleanEnv({ SDLC_BASE_SHA: base }), fs: ioFs,
      });
      assert.equal(result.code, expected, `${name}: the index-only registry must determine the gate\n${result.stdout}${result.stderr}`);
      if (expected === 1) assert.match(result.stderr, /gh_aw_schema_version changed .*report-only \(in the index\)/, name);
      else assert.equal(result.stderr, "", "a staged mechanical edit remains allowed");
      assert.equal(hashTree(repo.dir), before, `${name}: no file, index or object in the checkout changed`);
      assert.ok(scratches.length > 0, "the real scratch inspector ran");
      assert.ok(scratches.every((directory) => !fs.existsSync(directory)), "all scratch repositories were removed on both exit paths");
    } finally {
      forceRemove(root);
    }
  }
});

test("AC30 QA r2: the literal 100-page ceiling still updates the last permitted issue and preserves occurrence history", async () => {
  for (const continues of [false, true]) {
    const issue = existingIssue();
    const listed = [...others(9999), issue, ...(continues ? [{ ...others(1)[0], number: 10001 }] : [])];
    const api = issueApi(listed);
    const before = issue.body;
    const result = await reportFailure(api);
    assert.equal(result.code, 0, `page 100 is within the specified ceiling, even with more pages: ${result.stderr}`);
    assert.deepEqual(api.pages, Array.from({ length: 100 }, (_, index) => index + 1));
    assert.equal(listed.length, continues ? 10001 : 10000, "no duplicate issue was appended");
    assert.notEqual(issue.body, before, "the actual existing body was updated");
    assert.match(issue.body, /\| Occurrences \| 2 \|/);
    assert.match(issue.body, /correlation id `earlier` — failing command: `npm ci`/);
    assert.match(issue.body, /\| Failing command \| `npm test` \|/);
    assert.deepEqual(api.fetch.requests.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.path}`), [`PATCH ${ISSUE_PATH}/${issue.number}`]);
    assert.equal(api.fetch.state.maxInflight, 1, "all 100 pages and the update are serial");
  }
});

test("AC30 QA r2: an issue on page 101 and a matching PR in inspected pages cannot cause any issue write", async () => {
  for (const includePr of [false, true]) {
    const listed = [...others(10000), existingIssue()];
    if (includePr) listed[0] = { ...existingIssue(89999), pull_request: { url: "https://example.test/pr/89999" } };
    const before = structuredClone(listed);
    const api = issueApi(listed);
    const result = await reportFailure(api);
    assert.equal(result.code, 1, "uninspected issue/PR-only evidence must never permit a write");
    assert.match(result.stderr, /more than 10000 open issues/);
    assert.deepEqual(api.pages, Array.from({ length: 100 }, (_, index) => index + 1), "page 101 is never fetched");
    assert.deepEqual(api.fetch.requests.filter((entry) => entry.method !== "GET"), [], "neither a duplicate create nor a PR update was sent");
    assert.deepEqual(listed, before, "all actual issue/PR bodies and the issue count are untouched");
  }
});

test("AC30 QA r2: later-page API errors, malformed lists, rate limits and hostile links abort without touching an already found issue", async () => {
  const failures = [
    ["HTTP error", () => json(500, { message: "later page failed" }), /HTTP 500: later page failed/, []],
    ["non-list", () => json(200, { message: "not an issue list" }), /did not return a list/, []],
    ["persistent rate limit", () => json(429, { message: "secondary rate limit" }, { "retry-after": "1" }), /still rate limited after 1 retries/, [1000]],
    ["hostile next link", () => json(200, [], { link: '<https://elsewhere.example.test/steal-token?page=7>; rel="next"' }), /different origin/, []],
  ];
  for (const [name, failure, message, waits] of failures) {
    const listed = [existingIssue(), ...others(600)];
    const before = structuredClone(listed);
    const api = issueApi(listed, (page) => page === 6 ? failure() : undefined);
    const result = await reportFailure(api, ["--max-retries", "1"]);
    assert.equal(result.code, 1, `${name}: a page-6 failure must fail the step`);
    assert.match(result.stderr, message, name);
    assert.ok(api.pages.includes(6), "the failure actually happened after the old five-page boundary");
    assert.deepEqual(result.waits, waits, "a later-page retry still waits as instructed");
    assert.equal(api.fetch.state.maxInflight, 1);
    assert.ok(api.fetch.requests.every((entry) => new URL(entry.url).origin === "https://api.github.com"), "a hostile next origin receives no credential");
    assert.deepEqual(api.fetch.requests.filter((entry) => entry.method !== "GET"), []);
    assert.deepEqual(listed, before, "finding a candidate before a failed lookup does not authorize changing it");
  }
});
