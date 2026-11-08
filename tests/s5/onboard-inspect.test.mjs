// AC45: bin/sdlc-onboard.mjs inspects the target read-only (a local path, or <owner>/<repo> through GET requests only) and collects the
// package manifests, the workflow files (which of them schedule), the build and test scripts, the provenance files and the owners
// of .github/CODEOWNERS; it never modifies the target and sends it no non-GET request.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseCodeowners, individualOwners } from "../../bin/lib/codeowners.mjs";
import { classifyTarget, findCommitPointer, inspectRepository, localReader, remoteIdentity, remoteReader } from "../../bin/lib/inspect-repo.mjs";
import { createApi } from "../../bin/lib/github-api.mjs";
import { FIXTURES, copyFixtureToGitRepo, createScenario, createWorkspace, fixtureFiles, fixtureRepos } from "./helpers/harness.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";

const IDENTITY = { repo: "example-owner/target", defaultBranch: "main", headSha: "a".repeat(40) };
const fixtureDir = (name) => path.join(FIXTURES, "onboard", name);
const inspectFixture = (name) => inspectRepository(localReader(fixtureDir(name)), IDENTITY);
const hashOf = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** { path: sha256 } of every file of a directory tree, `.git` excluded. */
function hashes(directory) {
  const result = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(next);
      else result[next] = hashOf(fs.readFileSync(path.join(directory, next)));
    }
  };
  walk("");
  return result;
}

/** An inspection of an in-memory file set. */
async function inspectFiles(files) {
  const workspace = createWorkspace({ manifest: null });
  try {
    for (const [relative, text] of Object.entries(files)) workspace.write(relative, text);
    return await inspectRepository(localReader(workspace.dir), IDENTITY);
  } finally {
    workspace.cleanup();
  }
}

// --- the five fixtures of the spec -----------------------------------------------------------------------------------------

test("AC45: node-app: package.json, its build and test scripts, the workflow without a schedule, nothing else", async () => {
  const inspection = await inspectFixture("node-app");
  assert.deepEqual(inspection.packageManifests, ["package.json"]);
  assert.deepEqual(inspection.scriptNames, ["build", "lint", "test"]);
  assert.deepEqual(inspection.buildCommands, ["npm run build"]);
  assert.deepEqual(inspection.verifyCommands, ["npm test"]);
  assert.deepEqual(inspection.workflows, [{ path: ".github/workflows/ci.yml", scheduled: false }]);
  assert.deepEqual(inspection.provenanceFiles, []);
  assert.deepEqual(inspection.codeowners, { present: false, individuals: [], teams: [] });
  assert.deepEqual(inspection.importScripts, []);
  assert.deepEqual(inspection.warnings, []);
  assert.deepEqual([inspection.repo, inspection.defaultBranch, inspection.headSha], ["example-owner/target", "main", "a".repeat(40)]);
});

test("AC45: dotnet-app: App.csproj is a package manifest; with no package.json there is no command and a warning that says why", async () => {
  const inspection = await inspectFixture("dotnet-app");
  assert.deepEqual(inspection.packageManifests, ["App.csproj"]);
  assert.deepEqual(inspection.buildCommands, []);
  assert.deepEqual(inspection.verifyCommands, []);
  assert.equal(inspection.warnings.length, 1);
  assert.match(inspection.warnings[0], /no package\.json at its root, so verifyCommands is empty \(S5 never invents a command\)/);
});

test("AC45: lab-like: the workflow with a schedule trigger is noted, and docs/_meta/registry.yaml is a provenance file", async () => {
  const inspection = await inspectFixture("lab-like");
  assert.deepEqual(inspection.workflows, [{ path: ".github/workflows/weekly-sweep.yml", scheduled: true }]);
  assert.deepEqual(inspection.provenanceFiles, [{ path: "docs/_meta/registry.yaml", commit: null, pointer: null }]);
  assert.deepEqual(inspection.packageManifests, []);
});

test("AC45: provenance-like: source.json is a provenance file with its 40-hex commit and the JSON Pointer of the key", async () => {
  const inspection = await inspectFixture("provenance-like");
  assert.deepEqual(inspection.provenanceFiles, [{ path: "source.json", commit: "1111111111111111111111111111111111111111", pointer: "/commit" }]);
});

test("AC45: codeowners-like: the individual owner and the team are read from .github/CODEOWNERS", async () => {
  const inspection = await inspectFixture("codeowners-like");
  assert.deepEqual(inspection.codeowners, { present: true, individuals: ["lead-dev"], teams: ["@example-owner/platform-team"] });
  assert.deepEqual(inspection.verifyCommands, ["npm test"]);
  assert.deepEqual(inspection.buildCommands, []);
});

// --- read-only: local ------------------------------------------------------------------------------------------------------

for (const name of ["node-app", "dotnet-app", "lab-like", "provenance-like", "codeowners-like"]) {
  test(`AC45: ${name}: every fixture file hash is unchanged after the inspection and after a whole onboarding run that names the path`, async () => {
    const target = copyFixtureToGitRepo(name, `https://github.com/example-owner/${name}.git`);
    const scenario = await createScenario();
    try {
      const before = hashes(target.dir);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target.dir, encoding: "utf8" });
      const sourceHashes = Object.fromEntries(Object.entries(fixtureFiles("onboard", name)).map(([file, text]) => [file, hashOf(text)]));
      assert.deepEqual(before, sourceHashes, "the working copy starts as the fixture");

      await inspectRepository(localReader(target.dir), IDENTITY);
      assert.deepEqual(hashes(target.dir), before, "unchanged after the inspection");

      const run = await scenario.onboard(["--repo", target.dir], { env: scenario.env(scenario.appCredentials()) });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(hashes(target.dir), before, "unchanged after the onboarding run");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: target.dir, encoding: "utf8" }), head, "no commit was made");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: target.dir, encoding: "utf8" }), "", "no file was added, changed or left behind");
      assert.deepEqual(scenario.fake.requests("GET /repos/:owner/:repo", "GET /repos/:owner/:repo/git/trees/:sha", "GET /repos/:owner/:repo/contents/*"), [], "a local target is not read through the API");
    } finally {
      await scenario.cleanup();
      target.cleanup();
    }
  });
}

test("AC45: a local path is recognised, an <owner>/<repo> is recognised, anything else is refused", () => {
  assert.deepEqual(classifyTarget(fixtureDir("node-app"), process.cwd()), { kind: "local", directory: fixtureDir("node-app") });
  assert.deepEqual(classifyTarget("example-owner/some-repo", FIXTURES), { kind: "remote", slug: "example-owner/some-repo" });
  assert.deepEqual(classifyTarget("onboard/node-app", FIXTURES), { kind: "local", directory: fixtureDir("node-app") }, "an existing relative directory wins over a slug lookalike");
  assert.throws(() => classifyTarget("not a repository", FIXTURES), /neither an existing directory nor an <owner>\/<repo> repository/);
});

// --- read-only: remote -----------------------------------------------------------------------------------------------------

test("AC45: a remote target is read with GET requests only and yields the same structure as the local inspection", async () => {
  const fake = await startFakeGitHub({ repos: fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/codeowners-like": "codeowners-like", "example-owner/lab-like": "lab-like" }) });
  try {
    const api = createApi({ baseUrl: fake.url, fetch: fake.fetch, token: "operator-token-fixture" });
    for (const name of ["node-app", "codeowners-like", "lab-like"]) {
      const identity = await remoteIdentity({ api, slug: `example-owner/${name}` });
      assert.deepEqual([identity.repo, identity.defaultBranch, identity.headSha], [`example-owner/${name}`, "main", "a".repeat(40)]);
      const reader = await remoteReader({ api, slug: identity.repo, ref: identity.defaultBranch });
      const remote = await inspectRepository(reader, identity);
      const local = await inspectRepository(localReader(fixtureDir(name)), identity);
      assert.deepEqual(remote, local, name);
    }
    assert.deepEqual(fake.nonGet(), [], "no request other than GET");
    assert.ok(fake.log.length > 0);
  } finally {
    await fake.close();
  }
});

test("AC45: through the entry point a remote target also receives GET requests only, and a missing repository is a clear error", async () => {
  const scenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app" }) } });
  try {
    const run = await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const toTarget = scenario.fake.log.filter((entry) => entry.path.startsWith("/repos/example-owner/node-app"));
    assert.ok(toTarget.length >= 3);
    assert.deepEqual(toTarget.filter((entry) => entry.method !== "GET"), []);

    const missing = await scenario.onboard(["--repo", "example-owner/no-such-repo"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /the repository example-owner\/no-such-repo was not found or is not readable with the current credentials/);
  } finally {
    await scenario.cleanup();
  }
});

test("AC45: a truncated file list from GitHub is reported as a warning, not hidden", async () => {
  const scenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app" }, { "example-owner/node-app": { truncated: true } }) } });
  try {
    const run = await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /the file list of example-owner\/node-app was truncated by GitHub/);
  } finally {
    await scenario.cleanup();
  }
});

// --- the details of what is collected --------------------------------------------------------------------------------------

test("AC45: other language manifests are collected too, at any depth, and node_modules and .git are not walked", async () => {
  const inspection = await inspectFiles({
    "package.json": '{ "scripts": { "test": "node --test" } }',
    "pyproject.toml": "[project]\nname = 'x'\n",
    "go.mod": "module example.com/x\n",
    "services/api/Api.csproj": "<Project />",
    "services/web/package.json": "{}",
    "tools/Tool.fsproj": "<Project />",
    "node_modules/dep/package.json": "{}",
    ".git/hooks/package.json": "{}",
    "README.md": "x",
  });
  assert.deepEqual(inspection.packageManifests, ["go.mod", "package.json", "pyproject.toml", "services/api/Api.csproj", "services/web/package.json", "tools/Tool.fsproj"]);
});

test("AC45: the npm-init placeholder test script is not a test script; a missing or invalid package.json says so", async () => {
  const placeholder = await inspectFiles({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" } }) });
  assert.deepEqual(placeholder.verifyCommands, []);
  assert.deepEqual(placeholder.buildCommands, ["npm run build"]);
  assert.ok(placeholder.warnings.some((line) => /placeholder test script of npm init/.test(line)));
  assert.ok(placeholder.warnings.some((line) => /has no test script, so verifyCommands is empty/.test(line)));

  const invalid = await inspectFiles({ "package.json": "{ not json" });
  assert.ok(invalid.warnings.some((line) => /package\.json is not valid JSON/.test(line)));
  assert.deepEqual(invalid.verifyCommands, []);

  const noScripts = await inspectFiles({ "package.json": '{ "name": "x" }' });
  assert.deepEqual(noScripts.scriptNames, []);
  assert.ok(noScripts.warnings.some((line) => /has no test script/.test(line)));
});

test("AC45: only scripts of the root package.json count, and a command is never invented for a script that does not exist", async () => {
  const inspection = await inspectFiles({
    "package.json": JSON.stringify({ scripts: { lint: "eslint .", "import:data": "node import.mjs", "import:more": "node more.mjs" } }),
    "sub/package.json": JSON.stringify({ scripts: { test: "jest", build: "tsc" } }),
  });
  assert.deepEqual(inspection.buildCommands, []);
  assert.deepEqual(inspection.verifyCommands, []);
  assert.deepEqual(inspection.importScripts, ["import:data", "import:more"]);
});

test("AC45: workflows: schedule triggers are recognised in the string, array and mapping forms, and in the front matter of an agentic .md workflow", async () => {
  const inspection = await inspectFiles({
    ".github/workflows/a-mapping.yml": "on:\n  schedule:\n    - cron: '0 5 * * 0'\n",
    ".github/workflows/b-array.yaml": "on: [push, schedule]\n",
    ".github/workflows/c-string.yml": "on: schedule\n",
    ".github/workflows/d-none.yml": "on:\n  push:\n    branches: [main]\n",
    ".github/workflows/e-agentic.md": "---\non:\n  schedule: daily on weekdays\n---\n# Agent\n",
    ".github/workflows/f-agentic-dispatch.md": "---\non: workflow_dispatch\n---\n# Agent\n",
    ".github/workflows/g-invalid.yml": "on: [unclosed\n",
    ".github/workflows/sub/h-nested.yml": "on: schedule\n",
    ".github/workflows/not-a-workflow.txt": "on: schedule\n",
  });
  assert.deepEqual(inspection.workflows, [
    { path: ".github/workflows/a-mapping.yml", scheduled: true },
    { path: ".github/workflows/b-array.yaml", scheduled: true },
    { path: ".github/workflows/c-string.yml", scheduled: true },
    { path: ".github/workflows/d-none.yml", scheduled: false },
    { path: ".github/workflows/e-agentic.md", scheduled: true },
    { path: ".github/workflows/f-agentic-dispatch.md", scheduled: false },
    { path: ".github/workflows/g-invalid.yml", scheduled: false },
  ]);
});

test("AC45: provenance files: the four names at any depth, with the shallowest 40-hex commit key and its JSON Pointer", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const inspection = await inspectFiles({
    "source.json": JSON.stringify({ commit: sha }),
    "data/lab-sources.json": JSON.stringify({ meta: { commit: "not-a-sha" }, source: { commit: sha } }),
    "x/provenance.json": JSON.stringify({ "a/b": { "c~d": { commit: sha } } }),
    "y/provenance.json": "{ not json",
    "z/source.json": JSON.stringify({ sources: [{ name: "first" }, { commit: sha }] }),
    "docs/_meta/registry.yaml": "labs: {}\n",
    "other.json": JSON.stringify({ commit: sha }),
  });
  assert.deepEqual(inspection.provenanceFiles, [
    { path: "data/lab-sources.json", commit: sha, pointer: "/source/commit" },
    { path: "docs/_meta/registry.yaml", commit: null, pointer: null },
    { path: "source.json", commit: sha, pointer: "/commit" },
    { path: "x/provenance.json", commit: sha, pointer: "/a~1b/c~0d/commit" },
    { path: "y/provenance.json", commit: null, pointer: null },
    { path: "z/source.json", commit: sha, pointer: "/sources/1/commit" },
  ]);
  assert.ok(inspection.warnings.some((line) => line === "y/provenance.json is not valid JSON"));
  assert.deepEqual(findCommitPointer({ commit: "short" }), null);
  assert.deepEqual(findCommitPointer([{ commit: sha }]), { commit: sha, pointer: "/0/commit" }, "arrays are walked and an element is addressed by its index");
  assert.deepEqual(findCommitPointer([1, "x", null, [], [[]], {}]), null, "an array without a commit key yields none");
});

test("AC45: CODEOWNERS: individuals in first-appearance order without duplicates, teams apart, e-mail owners and comments ignored", () => {
  const text = [
    "# comment line",
    "*       @Alice @example-owner/team-a   # trailing comment",
    "/docs/  @alice @bob-the-builder someone@example.com",
    "/src/   @example-owner/team-a @example-owner/team-b",
    "",
    "   ",
    "/lonely-pattern-without-owner",
  ].join("\r\n");
  assert.deepEqual(parseCodeowners(text), { individuals: ["Alice", "bob-the-builder"], teams: ["@example-owner/team-a", "@example-owner/team-b"] });
  assert.deepEqual(individualOwners(text), ["Alice", "bob-the-builder"]);
  assert.deepEqual(individualOwners(null), []);
  assert.deepEqual(individualOwners(undefined), []);
  assert.deepEqual(parseCodeowners(""), { individuals: [], teams: [] });
});

test("AC45: a CODEOWNERS file that is not at .github/CODEOWNERS is not read", async () => {
  const inspection = await inspectFiles({ CODEOWNERS: "* @someone\n", "docs/CODEOWNERS": "* @someone-else\n" });
  assert.deepEqual(inspection.codeowners, { present: false, individuals: [], teams: [] });
});
