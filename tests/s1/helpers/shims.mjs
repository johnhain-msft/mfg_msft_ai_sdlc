// Recording `gh` and `git` shims and a compiler stub for the tests/s1 suite.
//
// installShims() writes two tiny launchers (gh and git) into a directory that a test puts first on
// PATH. Both launchers run shim-runner.mjs, which appends every invocation to a JSONL log. `gh aw
// compile` is a stub whose behaviour `compile.mode` selects (see shim-runner.mjs); every other gh
// subcommand fails loudly, so that a reconciler that calls anything else cannot go unnoticed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { stubLockContent, STUB_LOCK_HEADER } from "./shim-runner.mjs";

const RUNNER = fileURLToPath(new URL("./shim-runner.mjs", import.meta.url));
const WINDOWS = process.platform === "win32";

function findOnPath(name, pathValue, skipDirectory) {
  const extensions = WINDOWS ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of pathValue.split(path.delimiter).filter((entry) => entry !== "")) {
    if (skipDirectory && path.resolve(directory) === path.resolve(skipDirectory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function writeLauncher(directory, tool) {
  if (WINDOWS) {
    const body = `@echo off\r\n"${process.execPath}" "${RUNNER}" ${tool} %*\r\nexit /b %ERRORLEVEL%\r\n`;
    fs.writeFileSync(path.join(directory, `${tool}.cmd`), body);
  } else {
    const launcher = path.join(directory, tool);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${RUNNER}" ${tool} "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }
}

/**
 * @param {string} directory scratch directory outside the workspace under test
 * @param {{ compile?: object, gh?: boolean }} [options] `compile` is the stub configuration
 */
export function installShims(directory, options = {}) {
  const shimDirectory = path.join(directory, "shim-bin");
  fs.mkdirSync(shimDirectory, { recursive: true });
  const logPath = path.join(directory, "shim-log.jsonl");
  const configPath = path.join(directory, "shim-config.json");
  fs.writeFileSync(logPath, "");
  const realGit = findOnPath("git", process.env.PATH ?? process.env.Path ?? "", shimDirectory);
  if (realGit === null) throw new Error("the tests need a real git executable on PATH");
  const config = { logPath, realGit, compile: options.compile ?? { mode: "ok" } };
  const save = () => fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  save();
  writeLauncher(shimDirectory, "git");
  if (options.gh !== false) writeLauncher(shimDirectory, "gh");
  const hostPath = process.env.PATH ?? process.env.Path ?? "";
  const searchPath = options.gh === false ? shimDirectory : `${shimDirectory}${path.delimiter}${hostPath}`;

  return {
    directory: shimDirectory,
    logPath,
    /** Replaces the compiler-stub configuration for the next invocation. */
    compile(settings) {
      config.compile = settings;
      save();
    },
    /** Environment for reconcile(): the shims first on PATH (both spellings, for Windows). */
    env(extra = {}) {
      return { PATH: searchPath, Path: searchPath, SDLC_SHIM_CONFIG: configPath, ...extra };
    },
    log() {
      const text = fs.readFileSync(logPath, "utf8");
      return text === "" ? [] : text.trimEnd().split("\n").map((line) => JSON.parse(line));
    },
    calls(tool) {
      return this.log().filter((entry) => entry.tool === tool);
    },
    compileCalls() {
      return this.calls("gh").filter((entry) => entry.args[0] === "aw" && entry.args[1] === "compile");
    },
    reset() {
      fs.writeFileSync(logPath, "");
    },
  };
}
