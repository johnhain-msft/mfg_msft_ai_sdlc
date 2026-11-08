// AC4: the repository is a self-contained template. Every artifact exists at its stated path, package-lock.json is
// tracked in git, and the central orchestrator repository is resolved at run time from the origin remote of the working
// copy that holds --manifest, never from a literal.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRemoteUrl, resolveCentralRepo } from "../../bin/lib/central-repo.mjs";
import { REPO_ROOT, createWorkspace } from "./helpers/harness.mjs";

const ARTIFACTS = [
  "aw.yml",
  "README.md",
  "bin/sdlc-bootstrap.mjs",
  "bin/sdlc-onboard.mjs",
  "bin/lib",
  "schemas/bootstrap-summary-report.schema.json",
  "tests/s5",
  "sdlc.yaml",
  "package-lock.json",
  "schemas/sdlc.schema.json",
  "src/reconcile.mjs",
  ".github/workflows/sdlc-onboard.md",
  ".github/workflows/sdlc-onboard.lock.yml",
];

for (const artifact of ARTIFACTS) {
  test(`AC4: ${artifact} exists`, () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...artifact.split("/"))));
  });
}

test("AC4: package-lock.json is tracked in git in the template repository", () => {
  const outcome = spawnSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
});

test("AC4: in a git repository where package-lock.json is untracked the same command exits non-zero", () => {
  const workspace = createWorkspace({ files: { "package-lock.json": "{}\n" } });
  try {
    const outcome = spawnSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], { cwd: workspace.dir, encoding: "utf8" });
    assert.notEqual(outcome.status, 0);
  } finally {
    workspace.cleanup();
  }
});

test("AC4: the resolver returns owner/repo of the origin remote of the working copy that holds the manifest", () => {
  const workspace = createWorkspace({ origin: "https://github.com/example-owner/example-repo.git" });
  try {
    const central = resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir });
    assert.equal(central.slug, "example-owner/example-repo");
    assert.equal(central.owner, "example-owner");
    assert.equal(central.repo, "example-repo");
    assert.equal(fs.realpathSync(central.workingCopy), fs.realpathSync(workspace.dir));
  } finally {
    workspace.cleanup();
  }
});

test("AC4: a manifest in a subdirectory resolves the origin of the enclosing working copy", () => {
  const workspace = createWorkspace({ origin: "https://github.com/example-owner/example-repo.git", files: { "config/fleet.yaml": "projects: []\n" } });
  try {
    const central = resolveCentralRepo("config/fleet.yaml", { cwd: workspace.dir });
    assert.equal(central.slug, "example-owner/example-repo");
    assert.equal(fs.realpathSync(central.workingCopy), fs.realpathSync(workspace.dir));
  } finally {
    workspace.cleanup();
  }
});

test("AC4: with no origin the resolver fails with a non-zero exit, as a function and as a command", () => {
  const workspace = createWorkspace({ origin: null });
  try {
    assert.throws(() => resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }), /no 'origin' remote/);
    const outcome = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "lib", "central-repo.mjs"), path.join(workspace.dir, "sdlc.yaml")], { encoding: "utf8" });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /no 'origin' remote/);
    assert.equal(outcome.stdout, "");
  } finally {
    workspace.cleanup();
  }
});

test("AC4: the command form prints owner/repo and exits zero", () => {
  const workspace = createWorkspace({ origin: "git@github.com:example-owner/example-repo.git" });
  try {
    const outcome = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "lib", "central-repo.mjs"), path.join(workspace.dir, "sdlc.yaml")], { encoding: "utf8" });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), "example-owner/example-repo");
  } finally {
    workspace.cleanup();
  }
});

test("AC4: a manifest outside any git working copy cannot be resolved", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-nogit-"));
  try {
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), "projects: []\n");
    assert.throws(() => resolveCentralRepo("sdlc.yaml", { cwd: directory, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) } }), /not inside a git working copy/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [url, expected] of [
  ["https://github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["https://github.com/example-owner/example-repo", "example-owner/example-repo"],
  ["https://github.com/example-owner/example-repo/", "example-owner/example-repo"],
  ["https://user:secret@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["git@github.com:example-owner/example-repo.git", "example-owner/example-repo"],
  ["ssh://git@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["https://ghe.example.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["file:///srv/git/example-repo.git", null],
  ["not a url", null],
  ["https://github.com/only-one-segment", null],
]) {
  test(`AC4: the origin URL ${JSON.stringify(url.replace(/secret/, "***"))} resolves to ${JSON.stringify(expected)}`, () => {
    assert.equal(parseRemoteUrl(url), expected);
  });
}

test("AC4: a credential in the origin URL never reaches a diagnostic", () => {
  const workspace = createWorkspace({ origin: "https://user:topsecret@github.com/just-one" });
  try {
    assert.throws(
      () => resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }),
      (error) => !error.message.includes("topsecret") && /does not name an <owner>\/<repo>/.test(error.message),
    );
  } finally {
    workspace.cleanup();
  }
});

test("AC4: the resolver is the only source of the central repository: no preset literal is needed to resolve a different origin", () => {
  const workspace = createWorkspace({ origin: "https://github.com/another-owner/another-repo.git" });
  try {
    assert.equal(resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }).slug, "another-owner/another-repo");
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/third-owner/third-repo.git"], { cwd: workspace.dir });
    assert.equal(resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }).slug, "third-owner/third-repo");
  } finally {
    workspace.cleanup();
  }
});
