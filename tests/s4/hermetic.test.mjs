// AC76: every test of SPEC-04 is hermetic. The suite (every file but the three immutable-gate files, which start no gh and open no connection, and which are scanned instead) runs in
// children with no GitHub token, a PATH led by a stub gh that records and refuses every write, and a preload that refuses every connection that is not to loopback; the recorded write
// count and the refused connections are then asserted to be none. The guards are themselves tested, so that "none" is an observation and not a vacuum.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hermeticWorkers } from "../s2/helpers/load.mjs";
import { REPO_ROOT, S4_ROOT, abs, readText, runNode, tempDir } from "./helpers/fixtures.mjs";

const SELF = path.basename(fileURLToPath(import.meta.url));
const CHILD_MARKER = "SDLC_S4_HERMETIC_CHILD";
const isChild = process.env[CHILD_MARKER] === "1";
const DENY_PRELOAD = abs("tests", "s2", "helpers", "deny-external-network.cjs");
const RUNNER = abs("tests", "s4", "helpers", "gh-runner.mjs");
const forward = (value) => value.replaceAll("\\", "/");
const WINDOWS = process.platform === "win32";

/** The files that the children do not run: they start no gh, hold no network code and no token, and take minutes. */
const SCANNED = ["verify-immutable-gates.test.mjs", "verify-immutable-gates-blocks.test.mjs", "verify-immutable-gates-frozen.test.mjs"];
const all = fs.readdirSync(S4_ROOT).filter((name) => name.endsWith(".test.mjs")).sort();
const files = all.filter((name) => name !== SELF && !SCANNED.includes(name));
const tail = (text, lines = 60) => text.split("\n").slice(-lines).join("\n");

/**
 * The environment of a child: the environment of this process without anything that could reach GitHub or change what a test reads, and with the stub gh first on PATH. It is not the
 * whitelist of cleanEnv: the bash of the runtime tests starts `node` (a launcher of a version manager on some hosts, which needs the variables of that manager), and a child that
 * lacked them failed for a reason that said nothing about the code under test.
 */
const SCRUBBED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DATA_DIR", "XDG_DATA_HOME", "SDLC_REAL_GH_AW", "NODE_TEST_CONTEXT", "NODE_OPTIONS"];
function childEnvironment(searchPath, extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SCRUBBED.includes(name) || /^(GITHUB_|RUNNER_|ACTIONS_)/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, PATH: searchPath, Path: searchPath, ...extra };
}

/** A directory with a gh launcher, which is the only thing that the stub PATH adds. */
function createGhShim() {
  const directory = tempDir("sdlc-s4-gh-shim-");
  const log = path.join(directory, "shim-log.jsonl");
  fs.writeFileSync(log, "");
  if (WINDOWS) fs.writeFileSync(path.join(directory, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${RUNNER}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  else {
    fs.writeFileSync(path.join(directory, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${RUNNER}" "$@"\n`);
    fs.chmodSync(path.join(directory, "gh"), 0o755);
  }
  const hostPath = process.env.PATH ?? process.env.Path ?? "";
  const searchPath = `${directory}${path.delimiter}${hostPath}`;
  return {
    directory,
    log,
    env: (extra = {}) => childEnvironment(searchPath, { SDLC_S4_SHIM_LOG: log, ...extra }),
    entries: () => fs.readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

let hermeticRun;
/** Runs the files once, a few at a time, and returns what the children and the guards recorded. */
function hermetic() {
  hermeticRun ??= (async () => {
    const shim = createGhShim();
    const logs = tempDir("sdlc-s4-hermetic-");
    const denyLog = path.join(logs, "deny.jsonl");
    fs.writeFileSync(denyLog, "");
    const env = shim.env({ NODE_OPTIONS: `--require "${forward(DENY_PRELOAD)}"`, SDLC_S2_DENY_LOG: denyLog, [CHILD_MARKER]: "1" });
    assert.equal(env.GH_TOKEN, undefined, "GH_TOKEN is unset in the children");
    assert.equal(env.GITHUB_TOKEN, undefined, "GITHUB_TOKEN is unset in the children");
    const results = new Map();
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        results.set(
          file,
          await new Promise((resolve) => {
            const child = spawn(process.execPath, ["--test", path.join(S4_ROOT, file)], { env, cwd: REPO_ROOT, windowsHide: true });
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk));
            child.stderr.on("data", (chunk) => (output += chunk));
            child.on("close", (code) => resolve({ code, output }));
          }),
        );
      }
    };
    await Promise.all(Array.from({ length: hermeticWorkers() }, worker));
    const read = (file) => fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    const run = { results, calls: shim.entries(), denied: read(denyLog), env };
    shim.cleanup();
    fs.rmSync(logs, { recursive: true, force: true });
    return run;
  })();
  return hermeticRun;
}

const options = { skip: isChild ? "this is a child of the hermetic run" : false };

test("AC76: the suite has the files that this run covers, and no other test file is hidden from it", options, () => {
  assert.ok(files.length >= 15, `${files.length} files`);
  for (const name of ["pre-agent-steps.test.mjs", "post-steps.test.mjs", "finalizer-and-escalation.test.mjs", "pr-result.test.mjs", "lab-studio-drift.test.mjs", "bump-studio-revision-pins.test.mjs"]) assert.ok(files.includes(name), name);
  assert.equal(files.includes(SELF), false);
  const nonTests = fs.readdirSync(S4_ROOT).filter((name) => /\.m?js$/.test(name) && !name.endsWith(".test.mjs"));
  assert.deepEqual(nonTests, ["recheck-portfolio-facts.mjs"], "every .mjs file directly under tests/s4/ is a test file, except the opt-in recheck script");
});

for (const file of files) {
  test(`AC76: ${file} passes in a child with no token, a stub gh first on PATH and the network guard preloaded`, options, async () => {
    const run = await hermetic();
    const result = run.results.get(file);
    assert.equal(result.code, 0, `${file} failed in the hermetic child:\n${tail(result.output)}`);
    assert.match(result.output, /pass \d+/, `${file}: the child reported a result`);
  });
}

test("AC76: the stub gh of the whole run recorded no write: no pull request, issue, comment, label, workflow dispatch, variable or release, and no gh api with a method other than GET", options, async () => {
  const { calls } = await hermetic();
  assert.deepEqual(calls.filter((call) => call.write), [], "the recorded write count is 0");
  assert.ok(calls.every((call) => call.tool === "gh"));
});

test("AC76: the network guard refused nothing: no child tried a connection that is not to loopback", options, async () => {
  const { denied } = await hermetic();
  assert.deepEqual(denied, []);
});

test("AC76: no child saw a GitHub token, and no S4 test or fixture holds a real-looking token or a desktop-automation call", options, async () => {
  const { env } = await hermetic();
  assert.equal(Object.keys(env).some((name) => /^(GH_TOKEN|GITHUB_TOKEN)$/.test(name)), false);
  const everything = [
    ...fs.readdirSync(S4_ROOT).filter((name) => /\.m?js$/.test(name) && name !== SELF).map((name) => path.join(S4_ROOT, name)),
    ...fs.readdirSync(path.join(S4_ROOT, "helpers")).map((name) => path.join(S4_ROOT, "helpers", name)),
  ];
  for (const file of everything) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/github_pat_[A-Za-z0-9_]{36,}|gh[pousr]_[A-Za-z0-9]{36,}/.test(text), false, `${file} holds a real-looking token`);
    assert.equal(/\b(?:SendKeys|robotjs|nut-js|playwright\.chromium|puppeteer)\b/.test(text), false, `${file}: desktop automation`);
  }
});

test("AC76: the three immutable-gate test files that the children skip start no gh, hold no network code, push nothing and read no token", () => {
  for (const name of SCANNED) {
    const text = readText(path.join(S4_ROOT, name));
    assert.ok(all.includes(name), `${name} exists`);
    for (const banned of ["fetch(", "http.request", "https.request", "net.connect", "WebSocket", "git push", "gh pr", "gh api", "gh issue", "GH_TOKEN", "GITHUB_TOKEN", "XMLHttpRequest"]) assert.equal(text.includes(banned), false, `${name}: ${banned}`);
    assert.equal(/https?:\/\/(?!example\.)/.test(text), false, `${name}: a URL that is not an example`);
  }
});

test("AC74: every criterion that says it is gated by an open question is listed in the Blocks column of the section 4 row of that question, and every Blocks entry names a criterion of the spec", () => {
  const spec = readText(abs("specs", "04-ai-downstream-adaptation.md")).split("\n");
  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const gated = new Map();
  for (const line of spec.filter((candidate) => /^\| AC\d+ \|/.test(candidate))) {
    const [id, text] = cells(line);
    const match = /\(gated by ((?:OQ\d+(?:, )?)+)\)/.exec(text);
    if (match) gated.set(id, match[1].split(", "));
  }
  const blocks = new Map();
  for (const line of spec.filter((candidate) => /^\| OQ\d+ \|/.test(candidate))) {
    const row = cells(line);
    blocks.set(row[0], row.at(-1).split(",").map((entry) => entry.trim()));
  }
  assert.ok(gated.size >= 10, `${gated.size} gated criteria`);
  assert.ok(blocks.size >= 12, `${blocks.size} open questions`);
  for (const [criterion, questions] of gated) {
    for (const question of questions) assert.ok(blocks.get(question)?.includes(criterion), `${criterion} is gated by ${question}, whose Blocks column is ${blocks.get(question)?.join(", ")}`);
  }
  for (const [question, criteria] of blocks) {
    for (const criterion of criteria) {
      // a criterion may be blocked by a question without saying so in its own text (AC74 lists them), but it must exist
      assert.ok(spec.some((line) => line.startsWith(`| ${criterion} |`)), `${question} blocks ${criterion}, which is not a criterion of the spec`);
    }
  }
});

// --- the guards are live ---------------------------------------------------------------------------------------------------------------------

test("AC76: the stub gh logs every call, refuses each kind of write with exit 98, and lets the reads through", options, async () => {
  const shim = createGhShim();
  try {
    const attempt = (...args) => runNode(RUNNER, args, { env: { SDLC_S4_SHIM_LOG: shim.log } });
    const refused = [
      ["pr", "create", "--title", "x"],
      ["pr", "merge", "12"],
      ["issue", "create", "--title", "x"],
      ["issue", "comment", "3", "--body", "x"],
      ["workflow", "run", "x.yml"],
      ["release", "create", "v1"],
      ["label", "create", "x"],
      ["variable", "set", "X"],
      ["api", "-X", "POST", "/repos/example-owner/example-target/issues"],
      ["api", "--method", "PATCH", "/repos/example-owner/example-target/issues/1"],
      ["api", "/repos/example-owner/example-target/issues", "-f", "title=x"],
    ];
    for (const call of refused) assert.equal((await attempt(...call)).code, 98, `${call.join(" ")} is refused`);
    const allowed = [["api", "/repos/example-owner/example-target/pulls"], ["pr", "view", "1"], ["issue", "list"], ["api", "-X", "GET", "/repos/example-owner/example-target"]];
    for (const call of allowed) assert.equal((await attempt(...call)).code, 0, `${call.join(" ")} is let through`);
    const entries = shim.entries();
    assert.equal(entries.length, refused.length + allowed.length, "every call is logged");
    assert.deepEqual(entries.filter((entry) => entry.write).map((entry) => entry.args.join(" ")), refused.map((call) => call.join(" ")), "and exactly the refused ones are the writes");
  } finally {
    shim.cleanup();
  }
});

test("AC76: the network guard refuses a connection to a host that is not loopback, logs it, and leaves loopback alone", options, async () => {
  const logs = tempDir("sdlc-s4-deny-");
  const denyLog = path.join(logs, "deny.jsonl");
  try {
    const probe = [
      'const net = require("node:net");',
      "let denied = null;",
      "try { net.connect(443, 'github.com'); } catch (error) { denied = error.code; }",
      "const loopback = net.connect({ host: '127.0.0.1', port: 1 });",
      "loopback.on('error', (error) => { console.log(JSON.stringify({ denied, loopback: error.code })); });",
    ].join(" ");
    const result = runNode("-e", [probe], { env: { NODE_OPTIONS: `--require "${forward(DENY_PRELOAD)}"`, SDLC_S2_DENY_LOG: denyLog } });
    assert.equal(result.code, 0, result.stderr);
    const outcome = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(outcome.denied, "ENONETWORK", "a name that is not loopback is refused before any socket opens");
    assert.notEqual(outcome.loopback, "ENONETWORK");
    const logged = fs.readFileSync(denyLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logged.map((entry) => entry.host), ["github.com"]);
  } finally {
    fs.rmSync(logs, { recursive: true, force: true });
  }
});
