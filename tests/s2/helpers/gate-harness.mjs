// Running the rendered post-steps and pre-agent steps of a drift workflow the way the Actions runner does (SPEC-02 AC19, AC20,
// AC24, AC29): in order, each step in its own `bash --noprofile --norc -eo pipefail` shell, in the step's working directory,
// with the first non-zero exit ending the run. The orchestrator workspace has `src/` of this repository linked in, the
// target checkout is a real git repository, and `/tmp/gh-aw` is a scratch directory. gh, npm and git are the recording shims.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { git, writeGitFixtureConfig } from "./git-fixture.mjs";
import { REPO_ROOT, tempDir, writeTree } from "./fixtures.mjs";
import { createShims } from "./shims.mjs";

const TIMEOUT_MS = 120000;

function findBash() {
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "/bin/bash",
    "/usr/bin/bash",
    "bash",
  ].filter(Boolean);
  return candidates.find((candidate) => spawnSync(candidate, ["--noprofile", "--norc", "-c", 'test -n "$BASH_VERSION"'], { timeout: TIMEOUT_MS }).status === 0) ?? null;
}

export const BASH = findBash();
export const BASH_SKIP = BASH === null ? "no bash executable was found" : false;
const forward = (value) => value.replace(/\\/g, "/");
export const shellPath = (value) => (process.platform === "win32" ? forward(value).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value);

/** The values that the runner would substitute for the expressions that a step's env uses. */
function evaluate(value) {
  return String(value)
    .replace(/\$\{\{\s*github\.token\s*\}\}/g, "ghs_fixturetoken")
    .replace(/\$\{\{\s*secrets\.[A-Za-z_]+\s*\}\}/g, "fixture-secret")
    .replace(/\$\{\{\s*vars\.[A-Za-z_]+\s*\}\}/g, "fixture-var")
    .replace(/\$\{\{\s*inputs\.\w+\s*\}\}/g, "")
    .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, "https://github.example")
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "example-owner/example-central")
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, "4242");
}

export class GateWorkspace {
  constructor({ checkoutName, files }) {
    this.root = tempDir("sdlc-s2-gate-");
    this.workspace = path.join(this.root, "workspace");
    this.artifacts = path.join(this.root, "artifacts");
    this.agentDir = path.join(this.artifacts, "agent");
    this.checkoutName = checkoutName;
    this.checkout = path.join(this.workspace, checkoutName);
    this.shims = createShims();
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.agentDir, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "src"), path.join(this.workspace, "src"), process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(this.checkout, { recursive: true });
    git(this.checkout, ["init", "-q"]);
    writeGitFixtureConfig(this.checkout);
    writeTree(this.checkout, files);
    git(this.checkout, ["add", "-A"]);
    git(this.checkout, ["commit", "-q", "--allow-empty", "-m", "base"]);
    this.baseSha = git(this.checkout, ["rev-parse", "HEAD"]);
    this.writeRunContext();
  }

  writeRunContext(extra = {}) {
    fs.writeFileSync(
      path.join(this.agentDir, "run-context.json"),
      `${JSON.stringify({ version: 1, target_repo: "example-owner/example-target", checkout: this.checkoutName, baseSha: this.baseSha, correlation_id: "test", extra_instructions: "", dry_run: false, ...extra }, null, 2)}\n`,
    );
  }

  write(relative, text) {
    writeTree(this.checkout, { [relative]: text });
  }

  remove(relative) {
    fs.rmSync(path.join(this.checkout, ...relative.split("/")), { recursive: true, force: true });
  }

  /** git in the target checkout. */
  git(...args) {
    return git(this.checkout, args);
  }

  /** Runs one `run` body; resolves to { code, stdout, stderr }. It is asynchronous so that a stub server of the test can answer. */
  runScript(script, { env = {}, workingDirectory = "" } = {}) {
    const relocated = script.replaceAll("/tmp/gh-aw", forward(this.artifacts));
    const file = path.join(this.root, `step-${Math.random().toString(16).slice(2)}.sh`);
    fs.writeFileSync(file, `${relocated}\n`);
    return new Promise((resolve) => {
      const child = spawn(BASH, ["--noprofile", "--norc", "-eo", "pipefail", file], {
        cwd: path.join(this.workspace, workingDirectory),
        env: this.shims.env({ GITHUB_WORKSPACE: shellPath(this.workspace), RUNNER_TEMP: forward(os.tmpdir()), SDLC_DRIFT_OUT: forward(this.agentDir), ...env }),
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * The runner: steps in order, the first failing one ends the run.
   * @returns {Promise<{ code: number, ran: string[], failed: string | null, log: string }>}
   */
  async runSteps(steps, { env = {} } = {}) {
    const ran = [];
    let log = "";
    for (const step of steps) {
      const name = step.name ?? step.run;
      ran.push(name);
      log += `Run ${name}\n`;
      const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, evaluate(value)]));
      const outcome = await this.runScript(step.run, { env: { ...stepEnv, ...env }, workingDirectory: step["working-directory"] ?? "" });
      log += outcome.stdout + outcome.stderr;
      if (outcome.code !== 0) return { code: 1, ran, failed: name, log };
    }
    return { code: 0, ran, failed: null, log };
  }

  cleanup() {
    this.shims.cleanup();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export const createGateWorkspace = (options) => new GateWorkspace(options);

/** A gh-admin-shaped checkout: a package.json and the build script that the preset's buildCommands run (its exit code is SDLC_S2_BUILD_EXIT). */
export const adminFiles = () => ({
  "package.json": `${JSON.stringify({ name: "admin-fixture", private: true, scripts: { test: "echo tests" } }, null, 2)}\n`,
  "presentation/build.mjs": "process.exit(Number(process.env.SDLC_S2_BUILD_EXIT ?? 0));\n",
  ".gitignore": "node_modules/\n",
});
