// Throwaway git repositories for the tests/s2 suite: a target checkout with a known base commit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempDir, writeTree } from "./fixtures.mjs";

const NO_GLOBAL_CONFIG = path.join(os.tmpdir(), "sdlc-s2-no-global-git-config");
const SHIM_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "shims");

function resolveRealGit() {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (directory === "" || path.resolve(directory) === SHIM_DIR) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return "git";
}

const REAL_GIT = resolveRealGit();

export function git(directory, args, { input } = {}) {
  return execFileSync(REAL_GIT, args, {
    cwd: directory,
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** `git status --porcelain` with every untracked file on its own line. */
export const porcelain = (directory) => git(directory, ["status", "--porcelain", "--untracked-files=all"]);

export function writeGitFixtureConfig(dir) {
  fs.appendFileSync(
    path.join(dir, ".git", "config"),
    "\n[user]\n\temail = fixture@example.invalid\n\tname = Fixture\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n",
  );
}

/**
 * @param {Record<string, string>} files the content of the first commit
 * @param {{ dir?: string }} [options] where to create the repository (default: a new scratch directory)
 * @returns a repository with the commit made, and helpers
 */
export function createRepo(files = {}, { dir = tempDir("sdlc-s2-repo-") } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeGitFixtureConfig(dir);
  writeTree(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return {
    dir,
    head: () => git(dir, ["rev-parse", "HEAD"]),
    git: (...args) => git(dir, args),
    status: () => porcelain(dir),
    write(relative, text) {
      writeTree(dir, { [relative]: text });
    },
    read: (relative) => fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8"),
    remove(relative) {
      fs.rmSync(path.join(dir, ...relative.split("/")), { recursive: true, force: true });
    },
    commitAll(message = "change") {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", message]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
