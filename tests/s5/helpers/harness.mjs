// Shared scaffolding for the S5 suites: a throwaway git working copy, the fake GitHub API, the fake `gh`, a recording
// reconciler stub and a runner that executes either entry point in process with those dependencies injected.
// Everything is hermetic: the no-network guard is installed as soon as this module is imported (AC55).
//
// A test process opens no TCP connection (see no-network.mjs for the runtime defect behind that rule): the fake GitHub
// answers an in-process run in memory, a listener under test is reached through the loopback client of
// loopback-client.mjs, and the suite ends by asserting that this process connected to nothing.

import { tcpConnects } from "./no-network.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { installFakeGh } from "./fake-gh.mjs";
import { FIXTURE_PERMISSIONS, installationOn, startFakeGitHub, undeclaredRequests } from "./fake-github.mjs";
import { loopback } from "./loopback-client.mjs";
import { runBootstrap } from "../../../bin/lib/bootstrap-run.mjs";
import { runOnboard } from "../../../bin/lib/onboard-run.mjs";

after(() => {
  assert.deepEqual(tcpConnects, [], "this test process opened a TCP connection: reach the fake GitHub with fake.fetch and a listener with the loopback client (tests/s5/helpers/no-network.mjs says why)");
});

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = path.join(REPO_ROOT, "tests", "s5", "fixtures");
export const DEFAULT_ORIGIN = "https://github.com/example-owner/example-repo.git";
export const CENTRAL = "example-owner/example-repo";
export { FIXTURE_PERMISSIONS, installationOn };

const CREDENTIAL_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_API_URL",
  "APP_CLIENT_ID",
  "APP_PRIVATE_KEY",
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GH_AW_BIN",
  "SDLC_BOOTSTRAP_NO_OPEN_BROWSER",
];

/** The host environment without any GitHub credential or CLI override, plus `extra`. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  return { ...env, ...extra };
}

/** A writable that keeps everything written to it. */
export class Capture {
  text = "";
  write(chunk) {
    this.text += String(chunk);
    return true;
  }
}

export const readFixture = (...parts) => fs.readFileSync(path.join(FIXTURES, ...parts), "utf8");

/** { path: text } of every file below a fixture directory, skipping the golden `expected.*` files. */
export function fixtureFiles(...parts) {
  const root = path.join(FIXTURES, ...parts);
  const files = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (!entry.name.startsWith("expected.")) files[next] = fs.readFileSync(path.join(root, next), "utf8");
    }
  };
  walk("");
  return files;
}

/** A repository entry for the fake GitHub, served from an onboarding fixture directory. */
export function fixtureRepo(name, extra = {}) {
  return { id: 100 + [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0), defaultBranch: "main", headSha: "a".repeat(40), files: fixtureFiles("onboard", name), ...extra };
}

/** The `repos` option of the fake GitHub: serves each onboarding fixture directory as the repository <owner>/<repo>. */
export const fixtureRepos = (map, extra = {}) => Object.fromEntries(Object.entries(map).map(([slug, directory]) => [slug, fixtureRepo(directory, extra[slug])]));

/** A git working copy (origin set) holding a copy of an onboarding fixture, so that `--repo <path>` can name it. */
export function copyFixtureToGitRepo(name, origin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-target-"));
  const dir = path.join(root, "target");
  fs.mkdirSync(dir, { recursive: true });
  for (const [relative, text] of Object.entries(fixtureFiles("onboard", name))) {
    fs.mkdirSync(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...relative.split("/")), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
export const sha256Tree = (directory) => {
  const entries = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else entries.push(`${path.relative(directory, full).split(path.sep).join("/")}:${fs.readFileSync(full).toString("hex")}`);
    }
  };
  walk(directory);
  return entries.join("\n");
};

/** A temporary git working copy whose `origin` is the given URL (no origin when `origin` is null). */
export function createWorkspace({ origin = DEFAULT_ORIGIN, manifest = "standard", files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-"));
  const dir = path.join(root, "work");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir });
  if (origin !== null) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  const workspace = {
    root,
    dir,
    path: (relative) => path.join(dir, ...relative.split("/")),
    write(relative, text) {
      fs.mkdirSync(path.dirname(workspace.path(relative)), { recursive: true });
      fs.writeFileSync(workspace.path(relative), text);
    },
    read: (relative) => fs.readFileSync(workspace.path(relative), "utf8"),
    exists: (relative) => fs.existsSync(workspace.path(relative)),
    /** Parses sdlc.yaml, applies `change` to it and writes it back (plain YAML.stringify: comments are not kept). */
    editManifest(change, relative = "sdlc.yaml") {
      const data = YAML.parse(workspace.read(relative));
      change(data);
      workspace.write(relative, YAML.stringify(data, { lineWidth: 0 }));
    },
    status: () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }),
    commitAll(message = "fixture") {
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  if (manifest === "standard") workspace.write("sdlc.yaml", readFixture("manifest.standard.yaml"));
  else if (typeof manifest === "string") workspace.write("sdlc.yaml", manifest);
  for (const [relative, text] of Object.entries(files)) workspace.write(relative, text);
  return workspace;
}

/** A reconciler stand-in that records its calls (`calls`) and answers with `result` (a function of the request, or a value). */
export function createReconcileStub(result, events) {
  const calls = [];
  const okResult = (request) => ({
    status: "ok",
    generatedWorkflows: [{ sourceMd: ".github/workflows/sdlc-onboard.md", lockYml: ".github/workflows/sdlc-onboard.lock.yml" }],
    repoConfigPath: ".github/workflows/aw.json",
    validationResults: [{ file: ".github/workflows/sdlc-onboard.md", valid: true, errors: [] }],
    ...(request ? {} : {}),
  });
  const stub = async (request, options) => {
    calls.push({ request: structuredClone(request), options: { cwd: options?.cwd } });
    events?.push({ type: "reconcile" });
    const answer = typeof result === "function" ? result(request, options) : (result ?? okResult(request));
    return answer;
  };
  stub.calls = calls;
  return stub;
}

export const errorResult = (errors, file = "sdlc.yaml") => ({
  status: "error",
  generatedWorkflows: [],
  repoConfigPath: ".github/workflows/aw.json",
  validationResults: [{ file, valid: false, errors }],
});

/**
 * One hermetic scenario: workspace + fake GitHub + fake gh + stubs.
 * @param {object} [options]
 * @param {object} [options.fake] options for startFakeGitHub (installations default to a full installation on example-owner)
 * @param {object} [options.gh] configuration of the fake gh (version, validateExit, doctorExit, ...)
 * @param {object} [options.workspace] options for createWorkspace
 */
export async function createScenario(options = {}) {
  const workspace = createWorkspace(options.workspace);
  const events = [];
  const fake = await startFakeGitHub({
    installations: [installationOn("example-owner")],
    users: { "example-owner": { id: 1, type: "Organization" } },
    ...(options.fake ?? {}),
  });
  const gh = installFakeGh(path.join(workspace.root, "shims"), { apiUrl: fake.url, ...(options.gh ?? {}) });
  const reconcile = createReconcileStub(options.reconcile, events);
  const browser = { urls: [], open: async (url) => { browser.urls.push(url); events.push({ type: "browser", url }); } };
  const prompts = { questions: [], answers: { ...(options.prompts ?? {}) } };
  const prompt = async (question) => {
    prompts.questions.push(question);
    return prompts.answers[question.name] ?? "";
  };

  const env = (extra = {}) => cleanEnv({ ...gh.env(), GITHUB_API_URL: fake.url, GH_TOKEN: "operator-token-fixture", ...extra });

  async function run(entry, argv, extra = {}) {
    const stdout = new Capture();
    const stderr = new Capture();
    const runner = entry === "bootstrap" ? runBootstrap : runOnboard;
    const code = await runner(argv, {
      env: extra.env ?? env(),
      cwd: extra.cwd ?? workspace.dir,
      stdout,
      stderr,
      // The fake GitHub answers an in-process run in memory, not over a loopback socket: the connect of a socket is the call
      // that can kill a Windows process on Node.js 24.0 to 24.15 (see no-network.mjs), and an in-process run has no need of one.
      fetch: extra.fetch ?? fake.fetch,
      openBrowser: extra.openBrowser ?? browser.open,
      prompt: extra.prompt ?? prompt,
      reconcile: extra.reconcile ?? reconcile,
      fs: extra.fs,
      timing: extra.timing,
      signal: extra.signal,
      now: extra.now,
      runGh: extra.runGh,
    });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  return {
    workspace,
    fake,
    gh,
    reconcile,
    browser,
    prompts,
    events,
    env,
    /** In-process run of bin/sdlc-bootstrap.mjs. */
    bootstrap: (argv = [], extra) => run("bootstrap", argv, extra),
    /** In-process run of bin/sdlc-onboard.mjs. */
    onboard: (argv = [], extra) => run("onboard", argv, extra),
    /** Credentials of an existing App (APP_CLIENT_ID and APP_PRIVATE_KEY). */
    appCredentials: () => ({ APP_CLIENT_ID: fake.state.app.client_id, APP_PRIVATE_KEY: fake.appKey.privateKeyPem }),
    async cleanup() {
      await fake.close();
      workspace.cleanup();
    },
  };
}

/** Asserts that the fake's log holds no request outside the declared patterns ("METHOD /path/:param"). */
export function assertOnlyDeclared(fake, declared) {
  const extra = undeclaredRequests(fake.log, declared);
  assert.deepEqual(
    extra.map((entry) => `${entry.method} ${entry.path}`),
    [],
    "the recorded log holds a request that the scenario did not declare",
  );
}

/** Asserts that none of the secret values occurs in any of the texts. */
export function assertNoSecrets(texts, secrets, label = "output") {
  for (const secret of secrets) {
    for (const [name, text] of Object.entries(texts)) {
      assert.equal(String(text).includes(secret), false, `${label}: the secret value ${JSON.stringify(secret.slice(0, 12))}... appears in ${name}`);
    }
  }
}

/**
 * Runs `callback` and records every write of this process through node:fs while it runs (writeFile, appendFile and their
 * synchronous and promise forms): { result, writes: [{ op, path, data }] }, `data` being the text that was written.
 */
export async function recordFsWrites(callback) {
  const writes = [];
  const originals = [];
  const wrap = (target, name, prefix) => {
    const original = target[name];
    if (typeof original !== "function") return;
    originals.push([target, name, original]);
    target[name] = function recordedWrite(...args) {
      const data = args[1];
      const text = typeof data === "string" ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : "";
      writes.push({ op: `${prefix}${name}`, path: String(args[0]), data: text });
      return original.apply(this, args);
    };
  };
  for (const name of ["writeFileSync", "appendFileSync", "writeFile", "appendFile"]) wrap(fs, name, "");
  for (const name of ["writeFile", "appendFile"]) wrap(fs.promises, name, "promises.");
  syncBuiltinESMExports();
  try {
    return { result: await callback(), writes };
  } finally {
    for (const [target, name, original] of originals) target[name] = original;
    syncBuiltinESMExports();
  }
}

const PRELOAD = new URL("./trace-preload.mjs", import.meta.url).href;

const unescapeHtml = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Parses the page that GET /register serves: the form method and action, the state of its query string, the manifest and the noscript button. */
export function parseRegistrationPage(html) {
  const form = /<form[^>]*>/i.exec(html)?.[0] ?? "";
  const action = unescapeHtml(/action="([^"]*)"/i.exec(form)?.[1] ?? "");
  const field = /<input[^>]*name="manifest"[^>]*value="([^"]*)"/i.exec(html)?.[1];
  const stateField = /<input[^>]*name="state"[^>]*value="([^"]*)"/i.exec(html)?.[1];
  const state = new URL(action || "https://invalid.example/").searchParams.get("state") ?? stateField ?? null;
  return {
    method: /method="([^"]*)"/i.exec(form)?.[1]?.toLowerCase() ?? null,
    action,
    state,
    manifestText: field === undefined ? null : unescapeHtml(field),
    manifest: field === undefined ? null : JSON.parse(unescapeHtml(field)),
    noscriptButton: /<noscript>[\s\S]*<button[^>]*type="submit"[\s\S]*<\/noscript>/i.test(html),
    autoSubmits: /\.submit\(\)/.test(html),
  };
}

/**
 * An openBrowser stand-in that plays GitHub's part of the manifest flow: when the CLI opens its /register page it reads the
 * form and calls /callback back (through the loopback client, so that this process does not connect); when it opens an
 * installation page it installs the App (unless `install` is false).
 * @param {{ browser: { urls: string[] }, fake: object }} scenario
 * @param {{ code?: string, callbackQuery?: (state: string) => string, install?: boolean|object[], onCallback?: Function, onPage?: Function }} [options]
 */
export function githubSideBrowser(scenario, options = {}) {
  return async (url) => {
    scenario.browser.urls.push(url);
    if (/\/register$/.test(url)) {
      const page = await loopback.request(url);
      const parsed = parseRegistrationPage(page.text);
      options.onPage?.(parsed);
      const query = options.callbackQuery ? options.callbackQuery(parsed.state) : `code=${options.code ?? "abc123_-X"}&state=${parsed.state}`;
      const response = await loopback.request(`${parsed.manifest.redirect_url}?${query}`);
      options.onCallback?.(response.status);
    } else if (options.install !== false) {
      scenario.fake.setInstallations(Array.isArray(options.install) ? options.install : [installationOn("example-owner")]);
    }
  };
}

/**
 * Runs an entry point as a real process with the trace preload: { code, stdout, stderr, trace }. The process is spawned
 * asynchronously, so the fake GitHub of this process keeps answering while it runs.
 * @param {"bootstrap"|"onboard"} entry
 */
export function runCli(entry, argv, { env, cwd, timeoutMs = 120000 }) {
  const traceFile = path.join(os.tmpdir(), `sdlc-s5-trace-${process.pid}-${Math.random().toString(16).slice(2)}.jsonl`);
  const script = path.join(REPO_ROOT, "bin", entry === "bootstrap" ? "sdlc-bootstrap.mjs" : "sdlc-onboard.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, script, ...argv], {
      cwd,
      env: { ...env, SDLC_S5_TRACE: traceFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
      fs.rmSync(traceFile, { force: true });
      resolve({ code, stdout, stderr, trace });
    });
  });
}
