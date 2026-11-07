// Executable red/green proof for the added QA tests. All mutations are made in
// disposable copies; the repository's product code and recovered files are untouched.
// Run: node tests/s2/fixtures/qa/prove-regressions.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../../helpers/stub-server.mjs";
import { forceRemove, tempDir } from "../../helpers/fixtures.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = tempDir("sdlc-qa-mutations-");
const files = ["qa-load-effects.test.mjs", "qa-transport-boundaries.test.mjs"];
const gitArtifacts = "src/drift/lib/git-artifacts.mjs";
const envHelper = "tests/s2/helpers/stub-server.mjs";
const bashHelper = "tests/s1/helpers/bash-runtime.mjs";
const cliRegression = "tests/s1/qa-boundaries.test.mjs";
const originals = new Map();

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `mutation anchor must occur once: ${before}`);
  return source.replace(before, after);
}

const mutations = [
  {
    name: "ambient XDG data leaks to real children",
    file: envHelper,
    pattern: "real asynchronous and synchronous children|child launched with the recording shims",
    break: (source) => replaceOnce(source, '  "XDG_DATA_HOME",\n', ""),
    evidence: /ambient-xdg-data/,
    failures: 2,
  },
  {
    name: "explicit child overrides are lost",
    file: envHelper,
    pattern: "explicit child overrides",
    break: (source) => replaceOnce(source, "return { ...env, ...extra };", "return env;"),
    evidence: /explicit-gh-data/,
    failures: 1,
  },
  {
    name: "the bash run receives the old timeout even though the export stays correct",
    file: bashHelper,
    pattern: "three-minute spawn timeout",
    break(source) {
      const at = source.lastIndexOf("timeout: TIMEOUT_MS,");
      assert.ok(at >= 0);
      return source.slice(0, at) + source.slice(at).replace("timeout: TIMEOUT_MS,", "timeout: 60000,");
    },
    evidence: /spawn timeout passed to/,
    failures: 1,
  },
  {
    name: "the CLI rejection regression uses the old ten-second timeout",
    file: cliRegression,
    pattern: "CLI rejection regression keeps",
    break: (source) => replaceOnce(source, "timeout: 120000,", "timeout: 10000,"),
    evidence: /two-minute CLI spawn timeout/,
    failures: 1,
  },
  {
    name: "an oversized transport is copied",
    file: gitArtifacts,
    pattern: "transport exactly at the byte limit",
    break: (source) => replaceOnce(source, "if (stat.size > FILE_LIMIT_BYTES)", "if (false && stat.size > FILE_LIMIT_BYTES)"),
    evidence: /more than/,
    failures: 1,
  },
  {
    name: "per-entry stat and copy failures are dropped",
    file: gitArtifacts,
    pattern: "stat, non-regular-file and copy errors",
    break: (source) => replaceOnce(source, "return { ...entry, error };", "return { ...entry };"),
    evidence: /EACCES/,
    failures: 1,
  },
  {
    name: "an unreadable transport directory is treated as empty",
    file: gitArtifacts,
    pattern: "unreadable directory",
    break: (source) => replaceOnce(
      source,
      'if (error?.code === "ENOENT" || error?.code === "ENOTDIR")',
      'if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EACCES")',
    ),
    evidence: /Missing expected exception/,
    failures: 1,
  },
  {
    name: "a copied transport bypasses the second size check",
    file: gitArtifacts,
    pattern: "both patch and bundle readers recheck",
    break: (source) => replaceOnce(source, "if (size > FILE_LIMIT_BYTES)", "if (false && size > FILE_LIMIT_BYTES)"),
    evidence: /oversized bytes must not be read/,
    failures: 1,
  },
  {
    name: "bundle connectivity launches git in the checkout's repository",
    file: gitArtifacts,
    pattern: "bundle with packed prerequisite refs",
    break: (source) => replaceOnce(
      source,
      '    git(["config", "--file", path.join(gitDir, "config"), "core.alternateRefsCommand", ": #"], { cwd: directory, env: isolated });\n',
      "",
    ),
    evidence: /no git process selected the checkout as its repository/,
    failures: 2,
  },
];

function execute(pattern) {
  const env = cleanEnv();
  delete env.NODE_TEST_CONTEXT;
  const outcome = spawnSync(process.execPath, [
    "--test", "--test-concurrency=4",
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
    ...files.map((name) => path.join(scratch, "tests", "s2", name)),
  ], { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(outcome.error, undefined, outcome.error?.message);
  return { code: outcome.status, output: `${outcome.stdout}${outcome.stderr}` };
}

try {
  for (const relative of ["src", "schemas", "tests/s1/helpers", "tests/s2/helpers", "tests/s2/fixtures/lab"]) {
    fs.cpSync(path.join(repository, relative), path.join(scratch, relative), { recursive: true });
  }
  fs.copyFileSync(path.join(repository, cliRegression), path.join(scratch, cliRegression));
  const cliFixture = "tests/s1/fixtures/manifest.minimal.yaml";
  fs.mkdirSync(path.dirname(path.join(scratch, cliFixture)), { recursive: true });
  fs.copyFileSync(path.join(repository, cliFixture), path.join(scratch, cliFixture));
  const preload = "tests/s2/fixtures/qa/spawn-timeout-preload.cjs";
  fs.mkdirSync(path.dirname(path.join(scratch, preload)), { recursive: true });
  fs.copyFileSync(path.join(repository, preload), path.join(scratch, preload));
  fs.copyFileSync(path.join(repository, "package.json"), path.join(scratch, "package.json"));
  for (const name of files) fs.copyFileSync(path.join(repository, "tests", "s2", name), path.join(scratch, "tests", "s2", name));
  fs.symlinkSync(path.join(repository, "node_modules"), path.join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const relative of new Set(mutations.map(({ file }) => file))) originals.set(relative, fs.readFileSync(path.join(scratch, relative), "utf8"));

  const baseline = execute();
  assert.equal(baseline.code, 0, baseline.output);
  assert.match(baseline.output, /pass 11\b/);
  console.log("Unmodified disposable copy: exit 0, all 11 added tests pass.");
  for (const mutation of mutations) {
    const target = path.join(scratch, mutation.file);
    try {
      fs.writeFileSync(target, mutation.break(originals.get(mutation.file)));
      const red = execute(mutation.pattern);
      assert.equal(red.code, 1, `${mutation.name}: the broken behavior must go red\n${red.output}`);
      assert.match(red.output, mutation.evidence, `${mutation.name}: failure must be caused by the targeted assertion`);
      assert.match(red.output, new RegExp(`fail ${mutation.failures}\\b`), `${mutation.name}: expected test failures\n${red.output}`);
      console.log(`RED exit 1 (${mutation.failures} test${mutation.failures === 1 ? "" : "s"}): ${mutation.name}`);
    } finally {
      fs.writeFileSync(target, originals.get(mutation.file));
    }
  }
  const green = execute();
  assert.equal(green.code, 0, green.output);
  assert.match(green.output, /pass 11\b/);
  console.log("Restored disposable copy: exit 0, all 11 added tests pass.");
} finally {
  forceRemove(scratch);
}
