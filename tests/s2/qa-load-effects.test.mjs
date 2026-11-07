// AC39: observe the recovered environment and timeout fixes at their process boundary,
// not only the exported constants or the object returned by cleanEnv.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { abs, forceRemove, tempDir } from "./helpers/fixtures.mjs";
import { createShims } from "./helpers/shims.mjs";
import { cleanEnv, runNode, runNodeSync } from "./helpers/stub-server.mjs";

const VARIABLES = ["GH_DATA_DIR", "XDG_DATA_HOME", "SDLC_REAL_GH_AW"];
const PROBE = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(VARIABLES)}.map(name => [name, process.env[name] ?? null]))))`;
const AMBIENT = { GH_DATA_DIR: "ambient-gh-data", XDG_DATA_HOME: "ambient-xdg-data", SDLC_REAL_GH_AW: "1" };

async function withAmbient(action) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, AMBIENT);
  try {
    await action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function observed(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("AC39 QA: real asynchronous and synchronous children do not inherit ambient gh data directories or the real-compiler switch", async () => {
  await withAmbient(async () => {
    const expected = Object.fromEntries(VARIABLES.map((name) => [name, null]));
    assert.deepEqual(observed(await runNode("-e", [PROBE])), expected);
    assert.deepEqual(observed(runNodeSync("-e", [PROBE])), expected);
    for (const [name, value] of Object.entries(AMBIENT)) assert.equal(process.env[name], value, "the parent is not scrubbed");
  });
});

test("AC39 QA: a child launched with the recording shims also receives a scrubbed environment", async () => {
  await withAmbient(async () => {
    const shims = createShims();
    try {
      const result = await runNode("-e", [PROBE], { env: shims.env() });
      assert.deepEqual(observed(result), Object.fromEntries(VARIABLES.map((name) => [name, null])));
      assert.deepEqual(shims.writes(), []);
    } finally {
      shims.cleanup();
    }
  });
});

test("AC39 QA: explicit child overrides, including empty and false-like values, survive scrubbing without changing the parent", async () => {
  await withAmbient(async () => {
    const explicit = { GH_DATA_DIR: "explicit-gh-data", XDG_DATA_HOME: "", SDLC_REAL_GH_AW: "0" };
    const shims = createShims();
    try {
      assert.deepEqual(observed(await runNode("-e", [PROBE], { env: cleanEnv(explicit) })), explicit);
      assert.deepEqual(observed(runNodeSync("-e", [PROBE], { env: shims.env(explicit) })), explicit);
      for (const [name, value] of Object.entries(AMBIENT)) assert.equal(process.env[name], value);
    } finally {
      shims.cleanup();
    }
  });
});

test("AC39 QA: bash discovery, real git fixture construction and rendered bash execution all receive the three-minute spawn timeout", async () => {
  const actualSpawn = childProcess.spawnSync;
  const calls = [];
  let sandbox;
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, timeout: options?.timeout });
    return actualSpawn(command, args, options);
  };
  syncBuiltinESMExports();
  try {
    // A separate module instance lets the recorder see findBash as well as the public methods.
    const helper = await import(new URL("../s1/helpers/bash-runtime.mjs?qa-timeouts", import.meta.url).href);
    sandbox = new helper.BashSandbox();
    const sha = sandbox.revision("target", { "README.md": "real fixture bytes\n" });
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sandbox.git("target", "rev-parse", "HEAD"), sha);
    assert.equal(fs.readFileSync(sandbox.path("target/README.md"), "utf8"), "real fixture bytes\n");
    const result = sandbox.run("printf 'actual-bash-effect'", {}, "target");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "actual-bash-effect");
    assert.ok(calls.some(({ args }) => args.includes("hash-object")), "git really constructed the fixture");
    assert.ok(calls.some(({ args }) => args.includes("-s")), "the rendered bash really ran");
    assert.ok(calls.some(({ args }) => args.includes("test -n \"$BASH_VERSION\"")), "bash discovery was observed");
    for (const call of calls) assert.equal(call.timeout, 180000, `spawn timeout passed to ${call.command} ${call.args.join(" ")}`);
  } finally {
    childProcess.spawnSync = actualSpawn;
    syncBuiltinESMExports();
    sandbox?.cleanup();
  }
});

test("AC39 QA: the CLI rejection regression keeps its two-minute timeout on all five actual node spawns", async () => {
  const root = tempDir("sdlc-qa-cli-timeouts-");
  const log = path.join(root, "spawns.jsonl");
  fs.writeFileSync(log, "");
  const preload = abs("tests", "s2", "fixtures", "qa", "spawn-timeout-preload.cjs").replaceAll("\\", "/");
  const env = cleanEnv({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require "${preload}"`.trim(),
    SDLC_QA_SPAWN_LOG: log,
  });
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = await runNode("--test", [
      "--test-concurrency=4",
      "--test-name-pattern=^AC12 QA: missing CLI arguments and malformed or null request JSON",
      abs("tests", "s1", "qa-boundaries.test.mjs"),
    ], { env });
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /pass 1\b/, "the existing CLI regression actually ran");
    const records = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(records, Array.from({ length: 5 }, () => ({ timeout: 120000, status: 1 })));
  } finally {
    forceRemove(root);
  }
});
