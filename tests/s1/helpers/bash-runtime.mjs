// Execute the actual rendered bash against isolated, real Git checkouts.
// Revisions are synthetic fixture objects written through Git plumbing: no add, commit, push or API call.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Generous on purpose: starting bash and git is slow on a busy Windows machine, and a real hang must still end the test.
const TIMEOUT_MS = 60000;

function findBash() {
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "/bin/bash",
    "/usr/bin/bash",
    "bash",
  ].filter(Boolean);
  return candidates.find((candidate) =>
    spawnSync(candidate, ["--noprofile", "--norc", "-c", "test -n \"$BASH_VERSION\""], { timeout: TIMEOUT_MS }).status === 0,
  );
}

const BASH = findBash();
const forward = (value) => value.replace(/\\/g, "/");
const shellPath = (value) => process.platform === "win32" ? forward(value).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;

function git(directory, args, input) {
  const result = spawnSync("git", args, {
    cwd: directory,
    input,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "no-global-config") },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

/** A tree constructed from the supplied fixture bytes, not from the caller's repository or index. */
function treeOf(directory, files) {
  const children = new Map();
  for (const [name, content] of Object.entries(files)) {
    const [first, ...rest] = name.split("/");
    if (rest.length === 0) children.set(first, { content });
    else {
      if (!children.has(first)) children.set(first, { files: {} });
      children.get(first).files[rest.join("/")] = content;
    }
  }
  const entries = [...children].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entry]) => {
    if (entry.files) return `040000 tree ${treeOf(directory, entry.files)}\t${name}\n`;
    return `100644 blob ${git(directory, ["hash-object", "-t", "blob", "-w", "--stdin"], entry.content)}\t${name}\n`;
  });
  return git(directory, ["mktree"], entries.join(""));
}

export class BashSandbox {
  constructor() {
    assert.ok(BASH, "an executable bash is required for the rendered-runtime tests");
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-runtime-"));
    this.work = path.join(this.root, "workspace with spaces");
    this.artifacts = path.join(this.root, "artifacts");
    this.envFile = path.join(this.root, "github-env");
    fs.mkdirSync(this.work);
    fs.mkdirSync(this.artifacts);
    fs.writeFileSync(this.envFile, "");
  }

  path(relative = "") {
    return path.join(this.work, ...relative.split("/"));
  }

  /** Create or advance a throwaway checkout with exactly these files and a deterministic parent. */
  revision(relative, files, parent = null) {
    const directory = this.path(relative);
    if (!fs.existsSync(path.join(directory, ".git"))) {
      fs.mkdirSync(directory, { recursive: true });
      git(directory, ["init", "-q"]);
      git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      git(directory, ["config", "core.autocrlf", "false"]);
    }
    const tree = treeOf(directory, files);
    const object = [
      `tree ${tree}`,
      ...(parent ? [`parent ${parent}`] : []),
      "author QA Fixture <qa@example.invalid> 1700000000 +0000",
      "committer QA Fixture <qa@example.invalid> 1700000000 +0000",
      "",
      "Isolated runtime test fixture",
      "",
    ].join("\n");
    const sha = git(directory, ["hash-object", "-t", "commit", "-w", "--stdin"], object);
    git(directory, ["update-ref", "refs/heads/main", sha]);
    git(directory, ["read-tree", "--reset", "-u", "HEAD"]);
    return sha;
  }

  git(relative, ...args) {
    return git(this.path(relative), args);
  }

  writeEnv(text = "") {
    fs.writeFileSync(this.envFile, text);
  }

  environment() {
    return Object.fromEntries(fs.readFileSync(this.envFile, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => {
      const equals = line.indexOf("=");
      return [line.slice(0, equals), line.slice(equals + 1)];
    }));
  }

  writeArtifact(relative, content) {
    const file = path.join(this.artifacts, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  readArtifact(relative) {
    return fs.readFileSync(path.join(this.artifacts, relative), "utf8");
  }

  run(script, env = {}, workingDirectory = "") {
    // Keep /tmp/gh-aw private to this test. The checkout still has spaces, exercising the production quotes.
    const relocated = script.replaceAll("/tmp/gh-aw", forward(this.artifacts));
    return spawnSync(BASH, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-s"], {
      cwd: this.path(workingDirectory),
      input: `${relocated}\n`,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: shellPath(this.work),
        GITHUB_ENV: forward(this.envFile),
        ...env,
      },
    });
  }

  cleanup() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
