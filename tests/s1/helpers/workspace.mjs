// A throwaway working tree for tests that run the reconciler for real against the stub compiler.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "ai-sdlc-factory/reconcile";
import { engineFile } from "../../helpers/instance.mjs";
import { abs, hashListing, listFiles } from "./fixtures.mjs";
import { installShims } from "./shims.mjs";

// the command line of the installed engine package: `sdlc-reconcile --request <file>`
const RECONCILE_CLI = engineFile("bin", "sdlc-reconcile.mjs");

export class Workspace {
  constructor(root, shims) {
    this.root = root;
    this.dir = path.join(root, "work");
    this.shims = shims;
  }

  path(relative) {
    return path.join(this.dir, ...relative.split("/"));
  }

  write(relative, text) {
    fs.mkdirSync(path.dirname(this.path(relative)), { recursive: true });
    fs.writeFileSync(this.path(relative), text);
  }

  read(relative) {
    return fs.readFileSync(this.path(relative), "utf8");
  }

  exists(relative) {
    return fs.existsSync(this.path(relative));
  }

  remove(relative) {
    fs.rmSync(this.path(relative), { recursive: true, force: true });
  }

  /** Sorted POSIX paths of the files below a directory of the workspace. */
  list(relative = ".github/workflows") {
    return listFiles(this.dir, relative);
  }

  /** "path:sha256" listing of everything the reconciler may touch (or of the given roots). */
  hash(roots = [".github", ".gitattributes"]) {
    return hashListing(this.dir, roots);
  }

  /** `git status --porcelain` with every untracked file listed on its own line. */
  status() {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: this.dir, encoding: "utf8" });
  }

  /** Runs reconcile() in the workspace with the shims first on PATH. */
  reconcile(request, extraEnv = {}) {
    return reconcile(request, { cwd: this.dir, env: this.shims.env(extraEnv) });
  }

  /** Runs `sdlc-reconcile --request <file>` of the installed engine in the workspace. */
  cli(requestFile) {
    const outcome = spawnSync(process.execPath, [RECONCILE_CLI, "--request", requestFile], {
      cwd: this.dir,
      env: { ...process.env, ...this.shims.env() },
      encoding: "utf8",
    });
    let json = null;
    try {
      json = JSON.parse(outcome.stdout);
    } catch {
      // left null; the caller asserts on it
    }
    return { code: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr, json };
  }

  cleanup() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * @param {{ manifestText?: string, instructions?: boolean, files?: Record<string,string>,
 *           compile?: object, gh?: boolean }} [options]
 * By default the workspace holds a copy of the committed sdlc.yaml and its instructions/ directory.
 */
export function createWorkspace(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s1-"));
  const shims = installShims(path.join(root, "shims"), { compile: options.compile, gh: options.gh });
  const workspace = new Workspace(root, shims);
  fs.mkdirSync(workspace.dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace.dir });
  if (options.manifestText !== undefined) {
    workspace.write("sdlc.yaml", options.manifestText);
  } else {
    fs.copyFileSync(abs("sdlc.yaml"), workspace.path("sdlc.yaml"));
  }
  if (options.instructions ?? options.manifestText === undefined) {
    fs.cpSync(abs("instructions"), workspace.path("instructions"), { recursive: true });
  }
  for (const [relative, text] of Object.entries(options.files ?? {})) workspace.write(relative, text);
  return workspace;
}
