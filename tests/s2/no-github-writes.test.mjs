// AC39: hermetic tests. No test, fixture or verification command of SPEC-02 performs a GitHub-side write (a push, pull request, issue, comment,
// label, workflow dispatch or release) or needs network access to github.com: HTTP is exercised only against a fake `fetch` or a local stub
// server on 127.0.0.1, and gh and npm are replaced by shims on PATH.
//
// This file runs every other tests/s2/*.test.mjs file in a child process of its own, with GH_TOKEN and GITHUB_TOKEN unset, PATH led by
// tests/s2/helpers/shims/ (gh, npm and a pass-through git that logs and fails `git push`) and NODE_OPTIONS preloading
// tests/s2/helpers/deny-external-network.cjs (which rejects any connection that is not to loopback). It then reads what the shims logged
// and what the deny guard logged. The guards are themselves tested below, so that "the logs are empty" is an observation and not a vacuum.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { abs, REPO_ROOT, S2_ROOT, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP } from "./helpers/gate-harness.mjs";
import { createShims, SHIM_DIRECTORY } from "./helpers/shims.mjs";
import { cleanEnv, runNode } from "./helpers/stub-server.mjs";

const SELF = path.basename(fileURLToPath(import.meta.url));
const CHILD_MARKER = "SDLC_S2_NO_GITHUB_WRITES_CHILD";
const isChild = process.env[CHILD_MARKER] === "1";
const DENY_PRELOAD = abs("tests", "s2", "helpers", "deny-external-network.cjs");
const forward = (value) => value.replaceAll("\\", "/");

const files = fs.readdirSync(S2_ROOT).filter((name) => name.endsWith(".test.mjs") && name !== SELF).sort();
const tail = (text, lines = 60) => text.split("\n").slice(-lines).join("\n");

/** The shims' own classification is not trusted alone: a write is also recognised from the arguments. */
const GH_WRITES = [/^pr (create|merge|edit|comment|close|review|ready|reopen)\b/, /^issue (create|edit|comment|close|reopen|delete|transfer|lock|pin)\b/, /^workflow (run|enable|disable)\b/, /^release (create|edit|delete|upload)\b/, /^label (create|edit|delete|clone)\b/, /^(secret|variable) (set|delete|remove)\b/, /^repo (create|delete|edit|fork|rename|archive|sync)\b/, /^run (rerun|cancel|delete)\b/];
function isWrite(entry) {
  if (entry.write === true) return true;
  const joined = entry.args.join(" ");
  if (entry.tool === "git") return entry.args.includes("push");
  if (entry.tool === "gh") {
    if (entry.args[0] === "api") {
      const method = /(?:-X|--method)[ =]?(\w+)/.exec(joined)?.[1] ?? (/(?:^| )(?:-f|-F|--field|--raw-field|--input)\b/.test(joined) ? "POST" : "GET");
      return method.toUpperCase() !== "GET";
    }
    return GH_WRITES.some((pattern) => pattern.test(joined));
  }
  return false;
}

let hermeticRun;
/** Runs the other files once, a few at a time, and returns what the children and the guards recorded. */
function hermetic() {
  hermeticRun ??= (async () => {
    const shims = createShims();
    const logs = tempDir("sdlc-s2-hermetic-");
    const allShimLog = path.join(logs, "shim-all.jsonl");
    const denyLog = path.join(logs, "deny.jsonl");
    fs.writeFileSync(allShimLog, "");
    fs.writeFileSync(denyLog, "");
    const env = shims.env({
      NODE_OPTIONS: `--require "${forward(DENY_PRELOAD)}"`,
      SDLC_S2_DENY_LOG: denyLog,
      SDLC_S2_SHIM_LOG_ALL: allShimLog,
      [CHILD_MARKER]: "1",
    });
    // A child that is itself a `node --test` run refuses to start while this variable (set by the parent test runner) is inherited.
    delete env.NODE_TEST_CONTEXT;
    assert.equal(env.GH_TOKEN, undefined, "GH_TOKEN is unset in the children");
    assert.equal(env.GITHUB_TOKEN, undefined, "GITHUB_TOKEN is unset in the children");
    assert.ok(env.PATH.startsWith(SHIM_DIRECTORY.replace(/[\\/]$/, "")), "PATH is led by tests/s2/helpers/shims/");
    const results = new Map();
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        results.set(
          file,
          await new Promise((resolve) => {
            const child = spawn(process.execPath, ["--test", path.join(S2_ROOT, file)], { env, cwd: REPO_ROOT, windowsHide: true });
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk));
            child.stderr.on("data", (chunk) => (output += chunk));
            child.on("close", (code) => resolve({ code, output }));
          }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.availableParallelism())) }, worker));
    const read = (file) => fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const run = { results, shimCalls: read(allShimLog).map((line) => JSON.parse(line)), denied: read(denyLog).map((line) => JSON.parse(line)), env };
    shims.cleanup();
    fs.rmSync(logs, { recursive: true, force: true });
    return run;
  })();
  return hermeticRun;
}

const options = { skip: isChild ? "this is a child of the hermetic run" : false };

test("AC39: the suite has the files that this run covers, and no other test file is hidden from it", options, () => {
  assert.ok(files.length >= 30, `${files.length} files`);
  for (const name of ["c2-frontmatter.test.mjs", "snapshot-watch-sources.test.mjs", "gate-failure-escalation.test.mjs", "validate-copilot-lab-audit.test.mjs", "oq-gates.test.mjs"]) assert.ok(files.includes(name), name);
  assert.equal(files.includes(SELF), false);
  const everything = fs.readdirSync(S2_ROOT).filter((name) => /\.(test\.)?m?js$/.test(name) && !name.endsWith(".test.mjs"));
  assert.deepEqual(everything, [], "every .mjs file directly under tests/s2/ is a test file");
});

for (const file of files) {
  test(`AC39: ${file} passes in a child with no token, shims first on PATH and the network guard preloaded`, options, async () => {
    const run = await hermetic();
    const result = run.results.get(file);
    assert.equal(result.code, 0, `${file} failed in the hermetic child:\n${tail(result.output)}`);
    assert.match(result.output, /pass \d+/, `${file}: the child reported a result`);
  });
}

test("AC39: the shim logs of the whole run hold no gh pr create, gh issue create, gh workflow run, gh api with a non-GET method or git push", options, async () => {
  const { shimCalls } = await hermetic();
  const writes = shimCalls.filter(isWrite);
  assert.deepEqual(writes.map((entry) => `${entry.tool} ${entry.args.join(" ")}`), [], "no write call reached a shim");
  if (BASH_SKIP === false) assert.ok(shimCalls.length > 0, "the shims were exercised, so an empty write list is an observation");
  assert.ok(shimCalls.every((entry) => ["gh", "npm", "git"].includes(entry.tool)));
});

test("AC39: the network guard logged no connection that is not to loopback", options, async () => {
  const { denied } = await hermetic();
  assert.deepEqual(denied, [], "the deny log is empty");
});

test("AC39: no child saw a GitHub token, and no S2 test or fixture holds a real-looking token", options, async () => {
  const { env } = await hermetic();
  assert.equal(Object.keys(env).some((name) => /^(GH_TOKEN|GITHUB_TOKEN)$/.test(name)), false);
  for (const file of files) {
    const text = fs.readFileSync(path.join(S2_ROOT, file), "utf8");
    assert.equal(/github_pat_[A-Za-z0-9_]{36,}|gh[pousr]_[A-Za-z0-9]{36,}/.test(text), false, `${file} holds a real-looking token`);
  }
});

// --- the guards are live ---------------------------------------------------------------------------------------------------------------------

test("AC39: the shims refuse and log every write and let the reads and the installs through", options, async () => {
  const shims = createShims();
  try {
    const runner = path.join(SHIM_DIRECTORY, "shim-runner.mjs");
    const attempt = (tool, ...args) => runNode(runner, [tool, ...args], { env: shims.env(), cwd: os.tmpdir() });
    const refused = [
      ["gh", "pr", "create", "--title", "x"],
      ["gh", "issue", "create", "--title", "x"],
      ["gh", "workflow", "run", "drift.yml"],
      ["gh", "release", "create", "v1"],
      ["gh", "label", "create", "x"],
      ["gh", "api", "-X", "POST", "/repos/example-owner/example-target/issues"],
      ["gh", "api", "--method", "PATCH", "/repos/example-owner/example-target/issues/1"],
      ["gh", "api", "/repos/example-owner/example-target/issues", "-f", "title=x"],
      ["git", "push", "origin", "main"],
    ];
    for (const call of refused) {
      const result = await attempt(...call);
      assert.notEqual(result.code, 0, `${call.join(" ")} is refused`);
    }
    const allowed = [
      ["gh", "api", "/repos/example-owner/example-target/pulls"],
      ["gh", "extension", "install", "github/gh-aw", "--pin", "v0.86.2"],
      ["npm", "ci"],
      ["npm", "test"],
    ];
    for (const call of allowed) assert.equal((await attempt(...call)).code, 0, `${call.join(" ")} is let through`);
    const log = shims.log();
    assert.equal(log.length, refused.length + allowed.length, "every call is logged, refused or not");
    assert.deepEqual(log.filter(isWrite).map((entry) => `${entry.tool} ${entry.args.join(" ")}`), refused.map((call) => call.join(" ")), "and exactly the refused ones are the writes");
    assert.deepEqual(shims.writes().length, refused.length, "the shims' own flag agrees");
  } finally {
    shims.cleanup();
  }
});

test("AC39: the network guard rejects a connection to a host that is not loopback, logs it, and leaves loopback alone", options, async () => {
  const logs = tempDir("sdlc-s2-deny-");
  const denyLog = path.join(logs, "deny.jsonl");
  try {
    const probe = [
      'const net = require("node:net");',
      "let denied = null;",
      "try { net.connect(443, 'github.com'); } catch (error) { denied = error.code; }",
      "let hostOption = null;",
      "try { net.connect({ host: 'api.github.com', port: 443 }); } catch (error) { hostOption = error.code; }",
      "const loopback = net.connect({ host: '127.0.0.1', port: 1 });",
      "loopback.on('error', (error) => { console.log(JSON.stringify({ denied, hostOption, loopback: error.code })); });",
    ].join(" ");
    const result = await runNode("-e", [probe], { env: cleanEnv({ NODE_OPTIONS: `--require "${forward(DENY_PRELOAD)}"`, SDLC_S2_DENY_LOG: denyLog }) });
    assert.equal(result.code, 0, result.stderr);
    const outcome = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.deepEqual({ denied: outcome.denied, hostOption: outcome.hostOption }, { denied: "ENONETWORK", hostOption: "ENONETWORK" }, "a name that is not loopback is refused before any socket opens");
    assert.notEqual(outcome.loopback, "ENONETWORK", "loopback is not refused by the guard (the connection itself fails here only because nothing listens)");
    const logged = fs.readFileSync(denyLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logged.map((entry) => entry.host), ["github.com", "api.github.com"], "each refusal is logged with its host");
  } finally {
    fs.rmSync(logs, { recursive: true, force: true });
  }
});
