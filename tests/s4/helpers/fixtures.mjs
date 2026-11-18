// Paths, process runners and fixture builders shared by the tests/s4 suite. Everything here is local: git repositories in temporary directories, no
// network, no token and no GitHub-side write.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const S4_ROOT = path.join(REPO_ROOT, "tests", "s4");
export const FIXTURES = path.join(S4_ROOT, "fixtures");
export const abs = (...parts) => path.join(REPO_ROOT, ...parts);
export const fixture = (...parts) => path.join(FIXTURES, ...parts);
export const readText = (file) => fs.readFileSync(file, "utf8");
export const readJson = (file) => JSON.parse(readText(file));

// Generous on purpose, like the helpers of the other suites: starting git and node is slow on a busy Windows host.
export const TIMEOUT_MS = 180000;

const trash = new Set();
process.on("exit", () => {
  for (const directory of trash) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temporary directory that is removed when the test process ends. */
export function tempDir(prefix = "sdlc-s4-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.add(directory);
  return directory;
}

/** The environment of a child: the host's PATH and system variables, and none of the variables that could reach GitHub or change what a helper reads. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ComSpec", "PATHEXT", "windir", "GIT_BASH"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "S4 Fixture", GIT_AUTHOR_EMAIL: "s4@example.invalid", GIT_COMMITTER_NAME: "S4 Fixture", GIT_COMMITTER_EMAIL: "s4@example.invalid" };

/** A git command in `directory`; throws when it fails. */
export function git(directory, args, { input, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    input,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: path.join(directory, "..", "no-global-config") },
  });
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr || result.error?.message}`);
  return result;
}

/** Writes files into a directory: a string is the new content, null deletes the file. */
export function writeFiles(directory, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, ...relative.split("/"));
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** Stages everything, commits and returns the commit id. */
export function commitAll(directory, message = "fixture") {
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]).stdout.trim();
}

/** A new git repository (branch main, no end-of-line conversion) that holds a copy of `source`, committed. @returns {{ dir: string, base: string }} */
export function repoFrom(source, prefix = "sdlc-s4-repo-") {
  const dir = path.join(tempDir(prefix), "checkout");
  fs.cpSync(source, dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.safecrlf", "false"]);
  return { dir, base: commitAll(dir, "base") };
}

let portfolioBase = null;
/** A copy of the minimal synthetic portfolio, committed; the commit is `base`. A copy of a copy is cheap, so the first one is built once. */
export function portfolioMin() {
  portfolioBase ??= repoFrom(fixture("portfolio-min"), "sdlc-s4-portfolio-");
  const dir = path.join(tempDir("sdlc-s4-portfolio-copy-"), "checkout");
  fs.cpSync(portfolioBase.dir, dir, { recursive: true });
  return { dir, base: portfolioBase.base };
}

/** The upstream files of the studio fixtures: labs/lab01.md to labs/lab20.md. */
export function labUpstream() {
  const dir = path.join(tempDir("sdlc-s4-upstream-"), "upstream");
  fs.cpSync(fixture("lab-sources", "upstream"), dir, { recursive: true });
  return dir;
}

/** A git checkout that holds the studio manifest of the lab-sources fixture (or the bad one that `variant` names). */
export function studioCheckout(variant = null) {
  const source = tempDir("sdlc-s4-studio-src-");
  const manifest = variant === null ? fixture("lab-sources", "portfolio", "apps", "lab-studio", "lab-sources.json") : fixture("lab-sources", variant, "lab-sources.json");
  writeFiles(source, { "apps/lab-studio/lab-sources.json": readText(manifest) });
  return repoFrom(source, "sdlc-s4-studio-");
}

/**
 * Runs a helper command as a child process, from `cwd` (the directory whose sdlc.yaml applies), with a clean environment.
 * @returns {{ code: number | null, stdout: string, stderr: string }}
 */
export function runNode(script, args = [], { cwd = REPO_ROOT, env = {}, frozen = false, nodeArgs = [] } = {}) {
  const result = spawnSync(process.execPath, [...(frozen ? ["--frozen-intrinsics"] : []), ...nodeArgs, script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: cleanEnv(env),
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

export const HELPERS = {
  drift: abs("scripts", "lab-studio-drift.mjs"),
  bump: abs("scripts", "bump-studio-revision-pins.mjs"),
};

/** The one JSON object on the standard output of a helper, or null when there is none (a fatal error prints none). */
export function jsonOf(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

/** The files of a Vitest stand-in for a checkout without dependencies: it writes the report that the test gives it, to --outputFile or standard output. */
export function installVitestStub(directory, report) {
  writeFiles(directory, {
    "node_modules/vitest/package.json": `${JSON.stringify({ name: "vitest", version: "0.0.0-fixture", type: "module", bin: { vitest: "vitest.mjs" } })}\n`,
    "node_modules/vitest/report.json": `${JSON.stringify(report)}\n`,
    "node_modules/vitest/vitest.mjs": [
      'import fs from "node:fs";',
      "const report = fs.readFileSync(new URL('./report.json', import.meta.url), 'utf8');",
      "const out = process.argv.slice(2).find((argument) => argument.startsWith('--outputFile='));",
      "if (out) fs.writeFileSync(out.slice('--outputFile='.length), report); else process.stdout.write(report);",
      "process.exitCode = JSON.parse(report).success ? 0 : 1;",
      "",
    ].join("\n"),
  });
}

/** A Vitest report in which every locked block of the given `lockedTestBlocks` ran and passed (one child test under each locked describe). */
export function passingReport(lockedTestBlocks, root = "/work/portfolio") {
  const testResults = lockedTestBlocks.map(({ file, blocks }) => ({
    name: `${root}/${file}`,
    status: "passed",
    message: "",
    startTime: 0,
    endTime: 1,
    assertionResults: blocks.map(({ kind, title }) =>
      kind === "it"
        ? { ancestorTitles: ["suite"], fullName: `suite ${title}`, status: "passed", title, failureMessages: [], meta: {} }
        : { ancestorTitles: [title], fullName: `${title} child`, status: "passed", title: "child", failureMessages: [], meta: {} },
    ),
  }));
  return { numTotalTestSuites: testResults.length, numFailedTests: 0, success: true, testResults };
}
