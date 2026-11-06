// Recording stand-ins for gh, npm and git (SPEC-02 AC39). A test puts the directory of this file first on PATH and sets
// SDLC_S2_SHIM_LOG, SDLC_S2_NODE and, when it wants a command to fail, SDLC_S2_NPM_FAIL (a JSON array of argument strings
// such as ["ci", "run test:unit"]) or SDLC_S2_GH_FAIL (for example ["extension install"]). When SDLC_S2_SHIM_LOG_ALL is also set (the
// hermetic run of tests/s2/no-github-writes.test.mjs sets it for every child), each call is appended to that second log as well, so that the
// parent sees the calls of every test whatever log the test itself reads.
//
//  gh   `extension install` succeeds, `aw` succeeds, `api` succeeds for a GET and is refused for any other method; every
//       other subcommand (pr, issue, workflow, release, label, ...) is a write and is refused.
//  npm  every command succeeds unless its arguments are listed in SDLC_S2_NPM_FAIL; it logs GH_DATA_DIR for each call.
//  git  `push` is refused; everything else runs the real git.
// Every call is appended to the log as one JSON line: { tool, args, cwd, GH_DATA_DIR, write }.

import fs from "node:fs";
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

function record(extra = {}) {
  const line = `${JSON.stringify({ tool, args, cwd: process.cwd(), GH_DATA_DIR: process.env.GH_DATA_DIR ?? null, write: false, ...extra })}\n`;
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

function main() {
  if (tool === "gh") {
    const joined = args.join(" ");
    if (failing("SDLC_S2_GH_FAIL").some((pattern) => joined.startsWith(pattern))) {
      record();
      process.stderr.write(`gh shim: ${joined} was told to fail\n`);
      return 1;
    }
    if (args[0] === "extension" && args[1] === "install") return (record(), 0);
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
