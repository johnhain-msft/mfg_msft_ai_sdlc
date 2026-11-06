// Shared plumbing for the drift scripts: how a script runs as a command and how it is called in-process.
//
// Every script exports `run(argv, io)`, which returns the exit code and never throws, and starts it only when the
// file is the entry point. A test calls `run` with fakes for the network, the clock and the file system.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the generated artifacts go unless --out says otherwise (the directory that gh-aw uploads). */
export const DEFAULT_OUT = "/tmp/gh-aw/agent";

/** The artifact directory: --out, else SDLC_DRIFT_OUT (a test or an operator that moves it), else the default. */
export const outDirectory = (flag, env) => flag ?? ((env.SDLC_DRIFT_OUT ?? "").trim() || DEFAULT_OUT);

/** True when the module at `metaUrl` is the script that node was started with. */
export function isMain(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

/** The default input/output of a script: what `run` falls back to when a test passes nothing. */
export function resolveIo(io = {}) {
  return {
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    fs: io.fs ?? fs,
    fetch: io.fetch ?? globalThis.fetch,
    sleep: io.sleep,
    now: io.now ?? (() => Date.now()),
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
  };
}

/** Starts `run` as the process entry point of a script. */
export async function runAsMain(metaUrl, run) {
  if (!isMain(metaUrl)) return;
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

/** The workspace of the job: GITHUB_WORKSPACE, else the current directory. */
export const workspaceOf = (io) => (io.env.GITHUB_WORKSPACE ? path.resolve(io.env.GITHUB_WORKSPACE) : io.cwd);

/** JSON with a fixed layout, so that an identical value is always an identical file. */
export const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
