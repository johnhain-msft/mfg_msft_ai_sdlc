// Calling the S2 scripts in-process (their `run(argv, io)` exports) and watching what they write.

import fs from "node:fs";
import path from "node:path";
import { cleanEnv } from "./stub-server.mjs";
import { createRepo, porcelain } from "./git-fixture.mjs";
import { abs, DRIFT_KEYS, fixture, listTree, readText, sha256, tempDir, WORKFLOWS } from "./fixtures.mjs";

/** Runs a script's `run` with captured output: { code, stdout, stderr }. */
export async function invoke(run, args, io = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { env: cleanEnv(), ...io, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

const WRITERS = new Set(["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "copyFileSync", "cpSync", "mkdtempSync", "truncateSync", "symlinkSync", "linkSync", "chmodSync", "utimesSync"]);

/**
 * A stand-in for `fs` that records every path that a write-class call names, and optionally fails a call.
 * @param {{ failRename?: (from: string, to: string, count: number) => boolean }} [options]
 * @returns {{ fs: typeof fs, writes: string[], renames: string[][] }}
 */
export function recordingFs({ failRename } = {}) {
  const writes = [];
  const renames = [];
  let renameCount = 0;
  const wrapped = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      if (property === "renameSync") {
        return (from, to) => {
          renameCount += 1;
          writes.push(path.resolve(String(from)), path.resolve(String(to)));
          renames.push([path.resolve(String(from)), path.resolve(String(to))]);
          if (failRename?.(String(from), String(to), renameCount)) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
          return value.call(target, from, to);
        };
      }
      if (WRITERS.has(property)) {
        return (...args) => {
          writes.push(path.resolve(String(args[0])));
          if (property === "copyFileSync" || property === "cpSync") writes.push(path.resolve(String(args[1])));
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { fs: wrapped, writes, renames };
}

export const isUnder = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Files below a directory that look like a leftover temporary file or a hidden artifact of an interrupted write. */
export function leftovers(directory) {
  const found = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (/\.tmp$|\.restore$/.test(entry.name)) found.push(child);
    }
  }
  return found;
}

/**
 * The workspace of a drift job for the snapshot script: <root>/workspace/sdlc.yaml and a checkout that is a git repository.
 * `placeholders` replaces text in the manifest (for example the origin of a stub server).
 */
export function createSnapshotWorkspace({ placeholders = {}, checkoutName = "checkout" } = {}) {
  const root = tempDir("sdlc-s2-snapshot-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  let manifest = fs.readFileSync(fixture("snapshot", "sdlc.yaml"), "utf8");
  for (const [from, to] of Object.entries(placeholders)) manifest = manifest.split(from).join(to);
  fs.writeFileSync(path.join(workspace, "sdlc.yaml"), manifest);
  const files = {};
  const stack = [fixture("snapshot", "checkout")];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else files[path.relative(fixture("snapshot", "checkout"), child).split(path.sep).join("/")] = fs.readFileSync(child, "utf8");
    }
  }
  const checkout = path.join(workspace, checkoutName);
  const repo = createRepo(files, { dir: checkout });
  return {
    root,
    workspace,
    checkout,
    repo,
    manifest: path.join(workspace, "sdlc.yaml"),
    out: path.join(root, "out"),
    status: () => porcelain(checkout),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The snapshot workspace with an orchestrator repository around it: `workspace/` is a git repository that holds the sdlc.yaml and a copy of the
 * committed drift workflows (so that a script that wrote one would show), `workspace/checkout/` is the target checkout, a repository of its own
 * that the orchestrator repository ignores, and `out` (next to the workspace) is where a script may write.
 * `fingerprint()` is the "path:sha256" listing of everything outside `out` and outside the .git directories.
 */
export function createOrchestratorWorkspace() {
  const snapshotWorkspace = createSnapshotWorkspace();
  const files = { ".gitignore": "/checkout/\n", "sdlc.yaml": readText(snapshotWorkspace.manifest) };
  for (const key of DRIFT_KEYS) {
    for (const extension of [".md", ".lock.yml"]) files[`.github/workflows/drift-${key}${extension}`] = readText(abs(WORKFLOWS, `drift-${key}${extension}`));
  }
  const orchestrator = createRepo(files, { dir: snapshotWorkspace.workspace });
  const outside = snapshotWorkspace.root;
  const fingerprint = () =>
    listTree(outside)
      .filter((file) => !file.startsWith("out/") && !file.split("/").includes(".git"))
      .map((file) => `${file}:${sha256(fs.readFileSync(path.join(outside, ...file.split("/"))))}`)
      .join("\n");
  return { ...snapshotWorkspace, orchestrator, fingerprint };
}
