// Runs the real `gh` executable (or whatever stands in for it on PATH) and collects its output.
//
// Two environment conveniences live here and nowhere else:
//   * GH_AW_BIN names the executable that replaces `gh` for `aw` subcommands. A file called
//     gh-aw[.exe] is the extension binary itself and takes the subcommand directly; anything else is
//     run as `<GH_AW_BIN> aw ...`.
//   * XDG_DATA_HOME defaults to the directory that SDLC_GH_AW_DATA_HOME names (an isolated gh-aw
//     installation, for a machine whose globally installed extension is an older release) when
//     XDG_DATA_HOME is unset and that directory exists. No directory is built in. An explicit
//     XDG_DATA_HOME, a PATH shim or GH_AW_BIN always win. (src/reconcile.mjs is self-contained and
//     keeps its own copy of this rule, ghAwEnvironment; one test drives both.)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 600000;
const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_./:@=+,-]+$/;
// Guards on child processes use the timers that exist when this module loads, so a test that
// mocks the global timers to drive the 10-minute flows does not also fire these guards.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Environment for a gh invocation: the given one plus the XDG_DATA_HOME default that SDLC_GH_AW_DATA_HOME names. */
export function ghEnvironment(env = process.env, exists = fs.existsSync) {
  const merged = { ...env };
  const dataHome = merged.SDLC_GH_AW_DATA_HOME;
  if (!merged.XDG_DATA_HOME && dataHome && exists(dataHome)) merged.XDG_DATA_HOME = dataHome;
  return merged;
}

/** Finds an executable on the PATH of `env` (PATHEXT aware on Windows); null when there is none. */
export function findExecutable(name, env) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")] : [""];
  for (const directory of pathValue.split(path.delimiter).filter((entry) => entry !== "")) {
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

/** The executable and arguments that implement `gh <args>` under `env`. */
export function resolveGhCommand(args, env) {
  const override = env.GH_AW_BIN;
  if (args[0] === "aw" && typeof override === "string" && override !== "") {
    const direct = /^gh-aw(?:\.(?:exe|cmd|bat))?$/i.test(path.basename(override));
    return { executable: override, args: direct ? args.slice(1) : args };
  }
  return { executable: findExecutable("gh", env), args };
}

/**
 * @param {{ env?: Record<string,string|undefined> }} [defaults]
 * @returns {(args: string[], options?: { cwd?: string, env?: object, timeoutMs?: number }) =>
 *   Promise<{ code: number|null, stdout: string, stderr: string, error?: string }>}
 */
export function createGhRunner(defaults = {}) {
  return function runGh(args, options = {}) {
    const env = ghEnvironment({ ...(defaults.env ?? process.env), ...(options.env ?? {}) });
    const { executable, args: finalArgs } = resolveGhCommand(args, env);
    return spawnCollect(executable, finalArgs, { cwd: options.cwd, env, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  };
}

function spawnCollect(executable, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    if (executable === null || executable === undefined) {
      resolve({ code: null, stdout: "", stderr: "", error: "the 'gh' executable was not found on PATH" });
      return;
    }
    const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
    if (viaShell && !args.every((argument) => SAFE_SHELL_ARGUMENT.test(argument))) {
      resolve({ code: null, stdout: "", stderr: "", error: "an argument is not safe to pass through the command shell" });
      return;
    }
    let child;
    try {
      child = viaShell
        ? spawn(env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[`"${executable}"`, ...args].join(" ")}"`], {
            cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      realClearTimeout(timer);
      resolve(result);
    };
    const timer = realSetTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done({ code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
