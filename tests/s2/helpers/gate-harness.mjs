// Running the rendered post-steps and pre-agent steps of a drift workflow the way the Actions runner does (SPEC-02 AC19, AC20,
// AC24, AC29): in order, each step in its own `bash --noprofile --norc -eo pipefail` shell, in the step's working directory,
// with the first non-zero exit ending the run, and with the GITHUB_ENV protocol of the runner: a step may append NAME=value lines
// to the file that GITHUB_ENV names, and the steps after it (later calls, a job's later steps) are started with those variables.
// The orchestrator workspace has the layout that a job has after `npm ci`: the scripts of this repository under `scripts/` and the engine package under
// `node_modules/ai-sdlc-factory`, both as copies of their own (a test may change them as the agent could change the orchestrator checkout); the
// target checkout is a real git repository, and `/tmp/gh-aw` is a scratch directory. gh, npm and git are the recording shims.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { importEngine, installFactory } from "../../helpers/instance.mjs";
import { git, writeGitFixtureConfig } from "./git-fixture.mjs";
import { abs, FACTORY_DIR, forceRemove, presetManifest, tempDir, writeTree } from "./fixtures.mjs";
import { createShims } from "./shims.mjs";

// the function that prepare-run runs first to stage the validator under RUNNER_TEMP: a deep import of the engine, so that a change of it is noticed here
const { stageValidator } = await importEngine("src/drift/prepare-run.mjs");

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
    // the job's GITHUB_TOKEN is the same installation token (`ghs_...`) however it is spelled, and the scripts refuse every other kind of token
    .replace(/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/g, "ghs_fixturetoken")
    .replace(/\$\{\{\s*secrets\.[A-Za-z_]+\s*\}\}/g, "fixture-secret")
    .replace(/\$\{\{\s*vars\.[A-Za-z_]+\s*\}\}/g, "fixture-var")
    .replace(/\$\{\{\s*inputs\.\w+\s*\}\}/g, "")
    .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, "https://github.example")
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "example-owner/example-central")
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, "4242");
}

export class GateWorkspace {
  /**
   * @param {{ checkoutName: string, files: Record<string, string> }} options
   */
  constructor({ checkoutName, files }) {
    this.root = tempDir("sdlc-s2-gate-");
    this.workspace = path.join(this.root, "workspace");
    this.artifacts = path.join(this.root, "artifacts");
    this.agentDir = path.join(this.artifacts, "agent");
    // RUNNER_TEMP of this job: where prepare-run stages the validator, which the agent step mounts read-only.
    this.runnerTemp = path.join(this.root, "runner-temp");
    this.checkoutName = checkoutName;
    this.checkout = path.join(this.workspace, checkoutName);
    this.shims = createShims();
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.agentDir, { recursive: true });
    fs.mkdirSync(this.runnerTemp, { recursive: true });
    fs.cpSync(abs("scripts"), path.join(this.workspace, "scripts"), { recursive: true });
    installFactory(this.workspace);
    fs.mkdirSync(this.checkout, { recursive: true });
    git(this.checkout, ["init", "-q"]);
    writeGitFixtureConfig(this.checkout);
    writeTree(this.checkout, files);
    git(this.checkout, ["add", "-A"]);
    git(this.checkout, ["commit", "-q", "--allow-empty", "-m", "base"]);
    this.baseSha = git(this.checkout, ["rev-parse", "HEAD"]);
    // What the first pre-agent step of the job (prepare-run) leaves behind: the run context under the artifact directory, the base
    // commit that the runner hands to every later step because the step appended it to GITHUB_ENV (see runScript), and the copy of the
    // validator that it stages read-only under RUNNER_TEMP (the same function, run on this workspace's own copies: the scripts that the manifest declares as
    // staged, and the engine's drift library).
    this.exported = { SDLC_BASE_SHA: this.baseSha };
    this.writeRunContext();
    const scripts = [...new Set(presetManifest().projects.flatMap((project) => project.driftAudit?.stagedScripts ?? []))];
    stageValidator({ env: { RUNNER_TEMP: this.runnerTemp }, fs }, { workspace: this.workspace, factoryDir: FACTORY_DIR, factoryRoot: path.join(this.workspace, ...FACTORY_DIR.split("/")), scripts });
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

  /**
   * Runs one `run` body; resolves to { code, stdout, stderr }. It is asynchronous so that a stub server of the test can answer.
   * Like the runner it gives the step a fresh GITHUB_ENV file, and when the step ends it reads the NAME=value lines that the step
   * appended and keeps them in `this.exported`, so that every later step of the job (a later call) is started with them.
   */
  runScript(script, { env = {}, workingDirectory = "" } = {}) {
    const relocated = script.replaceAll("/tmp/gh-aw", forward(this.artifacts));
    const unique = Math.random().toString(16).slice(2);
    const file = path.join(this.root, `step-${unique}.sh`);
    const envFile = path.join(this.root, `github-env-${unique}`);
    fs.writeFileSync(file, `${relocated}\n`);
    fs.writeFileSync(envFile, "");
    return new Promise((resolve) => {
      const child = spawn(BASH, ["--noprofile", "--norc", "-eo", "pipefail", file], {
        cwd: path.join(this.workspace, workingDirectory),
        env: this.shims.env({ GITHUB_WORKSPACE: shellPath(this.workspace), RUNNER_TEMP: forward(this.runnerTemp), SDLC_DRIFT_OUT: forward(this.agentDir), ...this.exported, GITHUB_ENV: forward(envFile), ...env }),
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
          const entry = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
          if (entry) this.exported[entry[1]] = entry[2];
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * The runner: steps in order, the first failing one ends the run. `log` is what the runner's log shows, a `Run <step name>` line before the
   * output of each step; `output` is the output of the steps alone, which is what to read when the name of a step (the whole command, for a
   * step that is named by its command) must not be mistaken for something that the step printed.
   * @returns {Promise<{ code: number, ran: string[], failed: string | null, log: string, output: string }>}
   */
  async runSteps(steps, { env = {} } = {}) {
    const ran = [];
    let log = "";
    let output = "";
    for (const step of steps) {
      const name = step.name ?? step.run;
      ran.push(name);
      log += `Run ${name}\n`;
      const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, evaluate(value)]));
      const outcome = await this.runScript(step.run, { env: { ...stepEnv, ...env }, workingDirectory: step["working-directory"] ?? "" });
      log += outcome.stdout + outcome.stderr;
      output += outcome.stdout + outcome.stderr;
      if (outcome.code !== 0) return { code: 1, ran, failed: name, log, output };
    }
    return { code: 0, ran, failed: null, log, output };
  }

  cleanup() {
    this.shims.cleanup();
    forceRemove(this.root);
  }
}

export const createGateWorkspace = (options) => new GateWorkspace(options);

/** A gh-admin-shaped checkout: a package.json and the build script that the preset's buildCommands run (its exit code is SDLC_S2_BUILD_EXIT). */
export const adminFiles = () => ({
  "package.json": `${JSON.stringify({ name: "admin-fixture", private: true, scripts: { test: "echo tests" } }, null, 2)}\n`,
  "presentation/build.mjs": "process.exit(Number(process.env.SDLC_S2_BUILD_EXIT ?? 0));\n",
  ".gitignore": "node_modules/\n",
});
