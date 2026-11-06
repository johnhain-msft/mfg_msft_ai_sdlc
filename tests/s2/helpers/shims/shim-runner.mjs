// Recording stand-ins for gh, npm and git (SPEC-02 AC39). A test puts the directory of this file first on PATH and sets
// SDLC_S2_SHIM_LOG, SDLC_S2_NODE and, when it wants a command to fail, SDLC_S2_NPM_FAIL (a JSON array of argument strings
// such as ["ci", "run test:unit"]) or SDLC_S2_GH_FAIL (for example ["extension install"]). When SDLC_S2_SHIM_LOG_ALL is also set (the
// hermetic run of tests/s2/no-github-writes.test.mjs sets it for every child), each call is appended to that second log as well, so that the
// parent sees the calls of every test whatever log the test itself reads.
//
//  gh   `extension install` and `extension list` keep the installed extensions the way the real CLI finds them (see below), `aw` succeeds,
//       `api` succeeds for a GET and is refused for any other method; every other subcommand (pr, issue, workflow, release, label, ...)
//       is a write and is refused.
//  npm  every command succeeds unless its arguments are listed in SDLC_S2_NPM_FAIL; it logs GH_DATA_DIR for each call.
//  git  `push` is refused; everything else runs the real git.
// Every call is appended to the log as one JSON line: { tool, args, cwd, GH_DATA_DIR, XDG_DATA_HOME, write }, and a gh or npm call also
// says which extension directory its process resolves (`dataDir`) and which version of the gh-aw extension that directory holds (`ghAwVersion`).
//
// Where gh keeps its extensions is the one thing here that is not a recording: the real CLI looks in $XDG_DATA_HOME/gh, else (Windows)
// %LocalAppData%/GitHub CLI, else ~/.local/share/gh, and has no GH_DATA_DIR variable at all (`gh help environment` of gh 2.103.3 lists none,
// and `gh extension list` with GH_DATA_DIR set to a directory that holds an extension prints nothing, with XDG_DATA_HOME set to it prints it).
// The shim resolves the directory by that rule, ignores GH_DATA_DIR, and keeps what is installed where in a JSON file in its scratch directory
// (SDLC_S2_GH_EXTENSIONS, default: next to the log), so that a test can see where an install went and nothing outside the scratch directory
// is ever written. Installing an extension that its directory already holds fails, as the real CLI does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [tool, ...args] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const logFiles = [...new Set([process.env.SDLC_S2_SHIM_LOG, process.env.SDLC_S2_SHIM_LOG_ALL].filter(Boolean))];
const failing = (name) => {
  try {
    return JSON.parse(process.env[name] ?? "[]");
  } catch {
    return [];
  }
};

/** A path as one comparable string: forward slashes, a drive letter as `c:`, no trailing slash (a Git Bash path such as /c/Users/x is the same place as C:\Users\x). */
function comparable(value) {
  let text = String(value ?? "").replace(/\\/g, "/");
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(text);
  if (drive) text = `${drive[1]}:/${drive[2]}`;
  if (process.platform === "win32") text = text.replace(/^([A-Za-z]):/, (_, letter) => `${letter.toLowerCase()}:`);
  return text.replace(/\/+$/, "");
}

/** Where this process's gh keeps its extensions: XDG_DATA_HOME, else LocalAppData on Windows, else the home directory; never GH_DATA_DIR. */
function ghDataDir(env = process.env) {
  if (env.XDG_DATA_HOME) return `${comparable(env.XDG_DATA_HOME)}/gh`;
  if (process.platform === "win32" && env.LOCALAPPDATA) return `${comparable(env.LOCALAPPDATA)}/GitHub CLI`;
  return `${comparable(env.HOME || env.USERPROFILE || os.homedir())}/.local/share/gh`;
}

const extensionsFile = () => process.env.SDLC_S2_GH_EXTENSIONS || path.join(path.dirname(process.env.SDLC_S2_SHIM_LOG || path.join(os.tmpdir(), "sdlc-s2-shim-log")), "gh-extensions.json");

function readExtensions() {
  try {
    return JSON.parse(fs.readFileSync(extensionsFile(), "utf8"));
  } catch {
    return {};
  }
}

const installedIn = (dataDir) => readExtensions()[dataDir] ?? {};

function record(extra = {}) {
  const dataDir = tool === "gh" || tool === "npm" ? ghDataDir() : null;
  const seen = dataDir === null ? {} : { dataDir, ghAwVersion: installedIn(dataDir).aw?.tag ?? null };
  const line = `${JSON.stringify({ tool, args, cwd: process.cwd(), GH_DATA_DIR: process.env.GH_DATA_DIR ?? null, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null, ...seen, write: false, ...extra })}\n`;
  for (const logFile of logFiles) fs.appendFileSync(logFile, line);
}

function realGit() {
  if (process.env.SDLC_S2_REAL_GIT) return process.env.SDLC_S2_REAL_GIT;
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (directory === "" || path.resolve(directory) === path.resolve(here)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return "git";
}

/** `gh extension install <owner>/gh-<name> [--pin <tag>]`: the extension is added to the directory that this process's gh resolves. */
function installExtension() {
  const repository = args[2] ?? "";
  const name = repository.split("/").pop().replace(/^gh-/, "");
  const pin = args.indexOf("--pin");
  const tag = pin === -1 ? "latest" : args[pin + 1] ?? "latest";
  const dataDir = ghDataDir();
  const extensions = readExtensions();
  if (extensions[dataDir]?.[name]) {
    record();
    process.stderr.write(`X there is already an installed extension that provides the "${name}" command\n`);
    return 1;
  }
  extensions[dataDir] = { ...extensions[dataDir], [name]: { repository, tag } };
  fs.writeFileSync(extensionsFile(), `${JSON.stringify(extensions, null, 2)}\n`);
  record({ installed: { name, repository, tag } });
  return 0;
}

function listExtensions() {
  const installed = installedIn(ghDataDir());
  for (const [name, { repository, tag }] of Object.entries(installed)) process.stdout.write(`gh ${name}\t${repository}\t${tag}\n`);
  record();
  return 0;
}

function main() {
  if (tool === "gh") {
    const joined = args.join(" ");
    if (failing("SDLC_S2_GH_FAIL").some((pattern) => joined.startsWith(pattern))) {
      record();
      process.stderr.write(`gh shim: ${joined} was told to fail\n`);
      return 1;
    }
    if (args[0] === "extension" && args[1] === "install") return installExtension();
    if (args[0] === "extension" && args[1] === "list") return listExtensions();
    if (args[0] === "aw") return (record(), 0);
    if (args[0] === "api") {
      const method = (/(?:-X|--method)[ =]?(\w+)/.exec(joined)?.[1] ?? (/(?:^| )(?:-f|-F|--field|--raw-field|--input)\b/.test(joined) ? "POST" : "GET")).toUpperCase();
      if (method === "GET") return (record({ method }), 0);
      record({ method, write: true });
      process.stderr.write(`gh shim: a ${method} request was refused\n`);
      return 1;
    }
    record({ write: true });
    process.stderr.write(`gh shim: '${joined}' is refused (the suite performs no GitHub-side write)\n`);
    return 1;
  }
  if (tool === "npm") {
    const joined = args.join(" ");
    record();
    if (failing("SDLC_S2_NPM_FAIL").some((pattern) => joined === pattern || joined.startsWith(`${pattern} `))) {
      process.stderr.write(`npm shim: '${joined}' was told to fail\n`);
      return 1;
    }
    return 0;
  }
  if (tool === "git") {
    const subcommand = args.find((argument, position) => !argument.startsWith("-") && !(position > 0 && ["-C", "-c"].includes(args[position - 1])));
    if (subcommand === "push") {
      record({ write: true });
      process.stderr.write("git shim: push is refused (the suite performs no GitHub-side write)\n");
      return 1;
    }
    record();
    return spawnSync(realGit(), args, { stdio: "inherit" }).status ?? 1;
  }
  process.stderr.write(`shim: unknown tool ${tool}\n`);
  return 3;
}

process.exitCode = main();
