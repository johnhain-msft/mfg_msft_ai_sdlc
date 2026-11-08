// Real git repositories and a real shell for the preflight tests (SPEC-03 AC20-AC23, AC40): bare "remotes" under a temporary directory that the router reaches
// through GITHUB_SERVER_URL=file://..., working clones that make commits and push them, a directory of stub executables (npm, gh) that record how they were
// called and answer what the test configured, and the path of a bash. Nothing leaves the machine, and no GitHub request is made: the REST side is the in-process stub.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER = fileURLToPath(new URL("./stub-runner.mjs", import.meta.url));
const TIMEOUT = 180000;
const forward = (value) => value.replace(/\\/g, "/");

export function findBash() {
  const candidates = [process.env.GIT_BASH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash", "/usr/bin/bash", "bash"].filter(Boolean);
  const found = candidates.find((candidate) => spawnSync(candidate, ["--noprofile", "--norc", "-c", 'test -n "$BASH_VERSION"'], { timeout: TIMEOUT }).status === 0);
  if (!found) throw new Error("the preflight tests need a bash");
  return found;
}

function git(directory, args, { input, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd: directory,
    input,
    encoding: "utf8",
    timeout: TIMEOUT,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "sdlc-s3-no-global-gitconfig"), GIT_TERMINAL_PROMPT: "0" },
  });
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result;
}

/** The root of the fixture: remotes, working clones and the stub bin, all removed by `cleanup`. */
export function createGitWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-git-"));
  const servers = path.join(root, "servers");
  const clones = path.join(root, "clones");
  fs.mkdirSync(servers);
  fs.mkdirSync(clones);
  const emptyConfig = path.join(root, "gitconfig");
  fs.writeFileSync(emptyConfig, "");
  const remotes = new Map();

  const remote = (slug, branch = "main") => {
    if (!remotes.has(slug)) {
      const bare = path.join(servers, ...`${slug}.git`.split("/"));
      fs.mkdirSync(bare, { recursive: true });
      git(bare, ["init", "--bare", "--quiet", `--initial-branch=${branch}`]);
      // explicit --git-dir: a machine whose configuration says safe.bareRepository=explicit refuses a bare repository that is only the working directory
      git(bare, ["--git-dir", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
      const work = path.join(clones, ...slug.split("/"));
      fs.mkdirSync(work, { recursive: true });
      git(work, ["init", "--quiet", `--initial-branch=${branch}`]);
      git(work, ["remote", "add", "origin", pathToFileURL(bare).href]);
      remotes.set(slug, { slug, bare, work, branch });
    }
    return remotes.get(slug);
  };

  return {
    root,
    emptyConfig,
    serverUrl: pathToFileURL(servers).href.replace(/\/$/, ""),
    remote,
    /** Replaces the working tree of `slug` by exactly these files (a null content deletes a file), commits and pushes; returns the commit id. */
    commit(slug, files, message = "fixture commit") {
      const { work, branch } = remote(slug);
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(work, ...name.split("/"));
        if (content === null) {
          fs.rmSync(file, { force: true });
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content);
        }
      }
      git(work, ["add", "-A"]);
      git(work, ["commit", "--quiet", "--allow-empty", "-m", message]);
      git(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`, "--force"]);
      return git(work, ["rev-parse", "HEAD"]).stdout.trim();
    },
    head: (slug) => git(remote(slug).work, ["rev-parse", "HEAD"]).stdout.trim(),
    /** The environment that points the router's git at the fixture remotes and away from the machine's configuration. */
    environment() {
      return { GITHUB_SERVER_URL: this.serverUrl, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };
    },
    git: (directory, args) => git(directory, args).stdout,
    gitMaybe: (directory, args) => git(directory, args, { allowFailure: true }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A directory of stub executables that a test puts first on PATH. Each stub records how it was called (arguments, working directory and the variables
 * that a preflight binds) and answers the first rule whose `match` (a regular expression over its joined arguments) fits:
 * { code, stdout, stderr, files: { <path relative to the working directory>: <content> } }.
 */
export function createStubBin(tools = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-bin-"));
  const configFile = path.join(dir, "stub-config.json");
  const logFile = path.join(dir, "stub-log.jsonl");
  fs.writeFileSync(logFile, "");
  const save = (config) => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  let config = tools;
  save(config);
  const names = [];
  const install = (tool) => {
    if (names.includes(tool)) return;
    names.push(tool);
    const body = `#!/bin/sh\nexec "${forward(process.execPath)}" "${forward(RUNNER)}" "${forward(dir)}" ${tool} "$@"\n`;
    fs.writeFileSync(path.join(dir, tool), body);
    fs.chmodSync(path.join(dir, tool), 0o755);
    if (process.platform === "win32") fs.writeFileSync(path.join(dir, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${RUNNER}" "${dir}" ${tool} %*\r\nexit /b %ERRORLEVEL%\r\n`);
  };
  Object.keys(tools).forEach(install);
  // `node` in the shell of a preflight is always the node that runs the tests, whatever version manager the machine has in front of it
  for (const tool of ["node"]) {
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nexec "${forward(process.execPath)}" "$@"\n`);
    fs.chmodSync(path.join(dir, tool), 0o755);
    if (process.platform === "win32") fs.writeFileSync(path.join(dir, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  }
  return {
    dir,
    /** PATH with the stub directory first. */
    path: () => `${dir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    /** Puts an executable of this name in the directory that runs `scriptPath` with the node of the tests (a hermetic stand-in for a tool that the machine may not have). */
    shim(name, scriptPath) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${forward(process.execPath)}" "${forward(scriptPath)}" "$@"\n`);
      fs.chmodSync(path.join(dir, name), 0o755);
      if (process.platform === "win32") fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    },
    set(tool, rules) {
      config = { ...config, [tool]: { rules } };
      save(config);
      install(tool);
    },
    log: () => {
      const text = fs.readFileSync(logFile, "utf8");
      return text === "" ? [] : text.trimEnd().split("\n").map((line) => JSON.parse(line));
    },
    /** Forgets the calls so far (a test that reuses one directory for several runs). */
    clearLog: () => fs.writeFileSync(logFile, ""),
    calls(tool) {
      return this.log().filter((entry) => entry.tool === tool);
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The variables of the host that a child needs to start at all on Windows; the rest of the environment is the test's own. */
export function hostEnvironment() {
  const names = ["SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles"];
  return Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}
