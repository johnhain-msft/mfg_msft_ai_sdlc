// AC37: deterministic and idempotent output. For identical inputs (the sdlc.yaml, the target checkout, the stubbed HTTP responses and the run date)
// every S2 script produces byte-identical output files, with entries ordered by url and then by manifest path; and re-running the SPEC-01
// reconciler on an unchanged sdlc.yaml leaves the three drift workflows and their .lock.yml files unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ghAwEnvironment, reconcile } from "../../src/reconcile.mjs";
import { run as checkResponse } from "../../src/drift/check-pr-response.mjs";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { composeBody, run as escalate } from "../../src/drift/escalate-gate-failure.mjs";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { run as snapshot } from "../../src/snapshot-watch-sources.mjs";
import { run as validate } from "../../src/validate-copilot-lab-audit.mjs";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { abs, DRIFT_KEYS, fixture, hashTree, listTree, readText, referenceRequest, tempDir, WORKFLOWS } from "./helpers/fixtures.mjs";
import { createRepo, git } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { createSnapshotWorkspace, invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, hangUntilAbort, json } from "./helpers/stub-server.mjs";

const TARGET = "example-owner/example-target";

const pages = () =>
  createFakeFetch((entry) => {
    if (entry.path === "/changelog") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>Release 18.0.0</body></html>" };
    if (entry.path === "/missing") return { status: 404, body: "not found" };
    return hangUntilAbort(entry);
  });
const pulls = () => createFakeFetch(() => json(200, [{ number: 2, html_url: "https://github.example/pull/2", head: { ref: "automation/weekly-audit-2026-11-01" }, labels: [{ name: "content-audit" }], draft: false }, { number: 1, html_url: "https://github.example/pull/1", head: { ref: "sdlc/x" }, labels: [], draft: false }]));
const noTimestamps = (directory) => {
  for (const file of listTree(directory)) assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(fs.readFileSync(path.join(directory, ...file.split("/")), "utf8")), false, `${file} holds no timestamp, so a later run date cannot change it`);
};

const snapshotArgs = (workspace, out, manifest = workspace.manifest) => ["--out", out, "--project", "snapshot-fixture", "--manifest", manifest, "--checkout", workspace.checkout, "--timeout-ms", "150"];

test("AC37: snapshot-watch-sources writes byte-identical files on a second run and on a run into a fresh directory", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const first = path.join(workspace.root, "first");
    const second = path.join(workspace.root, "second");
    assert.equal((await invoke(snapshot, snapshotArgs(workspace, first), { fetch: pages() })).code, 0);
    const hashed = hashTree(first);
    assert.ok(listTree(first).length >= 4, "a manifest, a snapshot and two package manifests at least");
    assert.equal((await invoke(snapshot, snapshotArgs(workspace, first), { fetch: pages() })).code, 0);
    assert.equal(hashTree(first), hashed, "the second run into the same directory");
    assert.equal((await invoke(snapshot, snapshotArgs(workspace, second), { fetch: pages() })).code, 0);
    assert.equal(hashTree(second), hashed, "a run into a fresh directory");
    noTimestamps(first);
    assert.equal(workspace.status(), "", "and the checkout is untouched");
  } finally {
    workspace.cleanup();
  }
});

test("AC37: the snapshot manifest is ordered by url and by manifest path, whatever order the sdlc.yaml lists them in", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const parsed = YAML.parse(readText(workspace.manifest));
    const sources = parsed.projects[0].driftAudit.knowledgeSources;
    const reversed = YAML.parse(readText(workspace.manifest));
    reversed.projects[0].driftAudit.knowledgeSources.watchUrls.reverse();
    reversed.projects[0].driftAudit.knowledgeSources.packageManifests.reverse();
    const reversedManifest = path.join(workspace.root, "reversed.yaml");
    fs.writeFileSync(reversedManifest, YAML.stringify(reversed));
    const first = path.join(workspace.root, "first");
    const second = path.join(workspace.root, "second");
    assert.equal((await invoke(snapshot, snapshotArgs(workspace, first), { fetch: pages() })).code, 0);
    assert.equal((await invoke(snapshot, snapshotArgs(workspace, second, reversedManifest), { fetch: pages() })).code, 0);
    assert.equal(hashTree(second), hashTree(first), "the same files for the same inputs, in whatever order they were configured");
    const manifest = JSON.parse(fs.readFileSync(path.join(first, "sources", "manifest.json"), "utf8"));
    const urls = manifest.watchUrls.map((record) => record.url);
    assert.deepEqual(urls, [...urls].sort(), "watchUrls ordered by url");
    assert.deepEqual(urls, sources.watchUrls.map((entry) => entry.url).sort());
    const patterns = manifest.packageManifests.map((record) => record.pattern);
    assert.deepEqual(patterns, [...patterns].sort(), "package manifest patterns ordered");
    assert.deepEqual(patterns, sources.packageManifests.slice().sort(), "all of them, including the one that matches nothing");
    const matched = manifest.packageManifests.flatMap((record) => record.files);
    assert.ok(matched.length >= 2, `package manifests found: ${matched.map((file) => file.path).join(", ")}`);
    for (const record of manifest.packageManifests) {
      const paths = record.files.map((file) => file.path);
      assert.deepEqual(paths, [...paths].sort(), `the files of '${record.pattern}' are ordered by manifest path`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC37: prepare-run writes a byte-identical run context for identical inputs, and dedupe-open-prs a byte-identical report, ordered by pull request", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const env = cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: workspace.workspace, GH_APP_INSTALLATION_TOKEN: "ghs_token" });
    const prepareArgs = (out) => ["--out", out, "--target-repo", TARGET, "--correlation-id", "corr-1", "--extra-instructions", "be brief", "--dry-run", "false", "--checkout", "checkout"];
    const dedupeArgs = (out) => ["--out", out, "--target-repo", TARGET];
    const results = [];
    for (const name of ["one", "two", "one"]) {
      const out = path.join(workspace.root, name);
      results.push(await invoke(prepare, prepareArgs(out), { env }));
      results.push(await invoke(dedupe, dedupeArgs(out), { env, fetch: pulls() }));
    }
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(hashTree(path.join(workspace.root, "two")), hashTree(path.join(workspace.root, "one")), "two directories, two runs, one set of bytes (the third run re-wrote the first)");
    const report = JSON.parse(fs.readFileSync(path.join(workspace.root, "one", "open-pr-dedup.json"), "utf8"));
    assert.deepEqual(report.matches.map((match) => match.number), [1, 2], "ordered by pull request number, not by the order GitHub returned them");
    noTimestamps(path.join(workspace.root, "one"));
  } finally {
    workspace.cleanup();
  }
});

test("AC37: the escalation's issue text is a pure function of its inputs, and two fresh runs with the same clock send the same requests", async () => {
  const input = { workflowId: "drift-example", targetRepo: TARGET, failingCommand: "npm test", runUrl: "https://github.example/run/1", correlationId: "corr-1", nowMs: Date.UTC(2026, 10, 6, 12, 0, 0), earlier: null };
  assert.equal(composeBody(input), composeBody({ ...input }));
  const sent = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const issues = [];
    const fake = createFakeFetch((entry) => {
      if (entry.method === "GET") return json(200, issues);
      const issue = { number: 1, state: "open", ...JSON.parse(entry.body) };
      issues.push(issue);
      return json(201, issue);
    });
    const clock = createClock();
    const result = await invoke(escalate, ["--workflow-id", "drift-example", "--target-repo", TARGET, "--correlation-id", "corr-1", "--run-url", "https://github.example/run/1", "--failing-command", "npm test"], {
      env: cleanEnv({ GH_TOKEN: "ghs_token", GITHUB_REPOSITORY: "example-owner/example-central" }),
      fetch: fake,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(result.code, 0, result.stderr);
    sent.push(fake.requests.map((request) => `${request.method} ${request.pathAndSearch} ${request.body}`));
  }
  assert.deepEqual(sent[1], sent[0]);
});

test("AC37: the validator and the response check print the same thing on every run", async () => {
  const lab = createRepo(labFiles());
  const out = tempDir("sdlc-s2-idempotence-validate-");
  try {
    const args = ["--checkout", lab.dir, "--out", out, "--base-sha", lab.head()];
    const first = await invoke(validate, args, { cwd: out });
    const second = await invoke(validate, args, { cwd: out });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(second, first);
    const response = [fixture("pr-response", "valid.json"), "--workflow", abs(WORKFLOWS, "drift-copilot-lab.md")];
    assert.deepEqual(await invoke(checkResponse, response), await invoke(checkResponse, response));
    assert.deepEqual(listTree(out), [], "and neither leaves a file");
  } finally {
    lab.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

/** A temporary copy of the repository: the committed sdlc.yaml, instructions and .github/, as a git repository with one commit. */
function copyOfRepository() {
  const workspace = createWorkspace({ manifestText: readText(abs("sdlc.yaml")), instructions: true });
  fs.cpSync(abs(".github"), workspace.path(".github"), { recursive: true });
  if (fs.existsSync(abs(".gitattributes"))) fs.copyFileSync(abs(".gitattributes"), workspace.path(".gitattributes"));
  for (const [name, value] of [["user.email", "fixture@example.invalid"], ["user.name", "Fixture"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) git(workspace.dir, ["config", name, value]);
  git(workspace.dir, ["add", "-A"]);
  git(workspace.dir, ["commit", "-q", "-m", "base"]);
  return workspace;
}

test("AC37: two runs of the reconciler on an unchanged sdlc.yaml leave .github/workflows as it was after the first, and the committed drift workflows are what it renders", () => {
  const workspace = copyOfRepository();
  try {
    const requestFile = path.join(workspace.root, "request.json");
    fs.writeFileSync(requestFile, JSON.stringify(referenceRequest()));
    const first = workspace.cli(requestFile);
    assert.equal(first.code, 0, `${first.stdout}${first.stderr}`);
    for (const key of DRIFT_KEYS) {
      assert.equal(workspace.read(`.github/workflows/drift-${key}.md`), readText(abs(WORKFLOWS, `drift-${key}.md`)), `drift-${key}.md: the committed workflow is the renderer's output for the committed sdlc.yaml and instructions`);
    }
    git(workspace.dir, ["add", "-A"]);
    git(workspace.dir, ["commit", "-q", "--allow-empty", "-m", "after the first run"]);
    const afterFirst = workspace.hash();
    const second = workspace.cli(requestFile);
    assert.equal(second.code, 0, `${second.stdout}${second.stderr}`);
    assert.equal(workspace.hash(), afterFirst, "byte for byte, the second run changed nothing");
    assert.doesNotThrow(() => git(workspace.dir, ["diff", "--exit-code", "--", ".github/workflows"]), "git diff --exit-code .github/workflows exits 0");
    assert.equal(git(workspace.dir, ["status", "--porcelain", "--untracked-files=all", "--", ".github/workflows"]), "");
  } finally {
    workspace.cleanup();
  }
});

// With the real compiler (opt-in, like tests/s1/compile.test.mjs): the committed .lock.yml files are the compiler's output for the committed
// .md files, so two runs of the real reconciler leave git diff --exit-code .github/workflows at 0 with no stub in between.
const requested = process.env.SDLC_REAL_GH_AW === "1";
const env = ghAwEnvironment(process.env);
const version = requested ? spawnSync("gh", ["aw", "version"], { env, encoding: "utf8" }) : null;
const installed = version?.stdout.match(/v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
const usable = installed !== null && (installed[0] > 1 || (installed[0] === 1 && (installed[1] > 0 || installed[2] >= 1)));
const skip = !requested ? "set SDLC_REAL_GH_AW=1 to run the real compiler" : !usable ? `gh aw >= v1.0.1 is required, found ${installed?.join(".") ?? "none"}` : false;

test("AC37: with the real gh-aw compiler, two runs of the reconciler leave git diff --exit-code .github/workflows at 0", { skip }, async () => {
  const workspace = copyOfRepository();
  try {
    const request = referenceRequest();
    for (let run = 1; run <= 2; run += 1) {
      const result = await reconcile(request, { cwd: workspace.dir, env });
      assert.equal(result.status, "ok", `run ${run}: ${JSON.stringify(result.validationResults)}`);
    }
    assert.doesNotThrow(() => git(workspace.dir, ["diff", "--exit-code", "--", ".github/workflows"]), "git diff --exit-code .github/workflows");
    assert.equal(git(workspace.dir, ["status", "--porcelain", "--untracked-files=all", "--", ".github/workflows"]), "");
  } finally {
    workspace.cleanup();
  }
});
