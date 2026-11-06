// Using the recording shims of tests/s2/helpers/shims/ from a test.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./stub-server.mjs";
import { tempDir } from "./fixtures.mjs";

export const SHIM_DIRECTORY = fileURLToPath(new URL("./shims/", import.meta.url));

/** The launchers need the executable bit on POSIX; on Windows this does nothing. */
function ensureExecutable() {
  if (process.platform === "win32") return;
  for (const name of ["gh", "npm", "git"]) {
    const file = path.join(SHIM_DIRECTORY, name);
    if ((fs.statSync(file).mode & 0o111) === 0) fs.chmodSync(file, 0o755);
  }
}

/**
 * @returns {{ env: (extra?: object) => object, log: () => object[], calls: (tool: string) => object[], writes: () => object[], cleanup: () => void, logFile: string }}
 */
export function createShims() {
  ensureExecutable();
  const directory = tempDir("sdlc-s2-shim-");
  const logFile = path.join(directory, "shim-log.jsonl");
  fs.writeFileSync(logFile, "");
  const hostPath = process.env.PATH ?? process.env.Path ?? "";
  const searchPath = `${SHIM_DIRECTORY.replace(/[\\/]$/, "")}${path.delimiter}${hostPath}`;
  const read = () => {
    const text = fs.readFileSync(logFile, "utf8");
    return text === "" ? [] : text.trimEnd().split("\n").map((line) => JSON.parse(line));
  };
  return {
    logFile,
    /** A clean environment (no token) whose PATH starts with the shim directory. */
    env: (extra = {}) => cleanEnv({ PATH: searchPath, Path: searchPath, SDLC_S2_SHIM_LOG: logFile, SDLC_S2_NODE: process.execPath, ...extra }),
    log: read,
    calls: (tool) => read().filter((entry) => entry.tool === tool),
    writes: () => read().filter((entry) => entry.write === true),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
