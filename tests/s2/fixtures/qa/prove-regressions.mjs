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
const files = ["qa-load-effects.test.mjs", "qa-transport-boundaries.test.mjs", "qa-round2-regressions.test.mjs"];
const expectedTests = 19;
const gitArtifacts = "src/drift/lib/git-artifacts.mjs";
const githubClient = "src/drift/lib/github-client.mjs";
const validator = "src/validate-copilot-lab-audit.mjs";
const escalation = "src/drift/escalate-gate-failure.mjs";
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
  {
    name: "the old token denylist accepts App user and unknown credentials",
    file: githubClient,
    pattern: "installation-only token guard|invalid credentials cannot use GITHUB_TOKEN",
    break: (source) => replaceOnce(
      source,
      'if (kind !== "App installation token")',
      'if (kind === "personal access token" || kind === "OAuth token")',
    ),
    evidence: /a non-installation credential must be refused/,
    failures: 2,
  },
  {
    name: "the escalation loses the installation token in GITHUB_TOKEN",
    file: escalation,
    pattern: "trimmed installation tokens",
    break: (source) => replaceOnce(
      source,
      'String(io.env.GH_TOKEN ?? io.env.GITHUB_TOKEN ?? "").trim()',
      'String(io.env.GH_TOKEN ?? "").trim()',
    ),
    evidence: /the installation token supplied through GITHUB_TOKEN must work/,
    failures: 1,
  },
  {
    name: "a token-length assumption rejects stateless installation tokens",
    file: githubClient,
    pattern: "trimmed installation tokens",
    break: (source) => replaceOnce(
      source,
      'if (kind !== "App installation token")',
      'if (kind !== "App installation token" || String(token).length > 40)',
    ),
    evidence: /not a GitHub App installation token/,
    failures: 1,
  },
  {
    name: "the index file reader reads HEAD instead of stage-zero bytes",
    file: gitArtifacts,
    pattern: "indexFileText reads stage-zero",
    break: (source) => replaceOnce(
      source,
      'return git(["cat-file", "blob", `:${relative}`], scratch.checkoutIndexOptions);',
      'return git(["cat-file", "blob", `HEAD:${relative}`], scratch.options);',
    ),
    evidence: /the reader must use the checkout's stage-zero index bytes/,
    failures: 1,
  },
  {
    name: "an unreadable index file is reported as text instead of null",
    file: gitArtifacts,
    pattern: "indexFileText reads stage-zero",
    break: (source) => replaceOnce(
      source,
      "  } catch {\n    return null;\n  }\n}\n\nconst COMMAND_KEY",
      '  } catch {\n    return "";\n  }\n}\n\nconst COMMAND_KEY',
    ),
    evidence: /a missing index entry is null/,
    failures: 1,
  },
  {
    name: "the validator no longer checks the pinned value of the index",
    file: validator,
    pattern: "index-only registries fail closed",
    break: (source) => replaceOnce(
      source,
      '      observed.push(["the index", staged === null ? null : pinnedValueOf(staged)]);\n',
      "",
    ),
    evidence: /the index-only registry must determine the gate/,
    failures: 1,
  },
  {
    name: "the escalation stops before the specified last page",
    file: escalation,
    pattern: "literal 100-page ceiling",
    break: (source) => replaceOnce(source, "export const MAX_ISSUE_PAGES = 100;", "export const MAX_ISSUE_PAGES = 99;"),
    evidence: /page 100 is within the specified ceiling/,
    failures: 1,
  },
  {
    name: "a truncated escalation search opens a duplicate issue",
    file: escalation,
    pattern: "an issue on page 101",
    break: (source) => replaceOnce(source, "if (existing === undefined && truncated)", "if (false)"),
    evidence: /uninspected issue\/PR-only evidence must never permit a write/,
    failures: 1,
  },
  {
    name: "a PR is taken for the matching escalation issue",
    file: escalation,
    pattern: "an issue on page 101",
    break: (source) => replaceOnce(
      source,
      "items.find((issue) => issue?.title === title && issue?.pull_request === undefined)",
      "items.find((issue) => issue?.title === title)",
    ),
    evidence: /uninspected issue\/PR-only evidence must never permit a write/,
    failures: 1,
  },
  {
    name: "an error during a later issue page is downgraded to success",
    file: escalation,
    pattern: "later-page API errors",
    break: (source) => replaceOnce(source, "return error instanceof UsageError ? 2 : 1;", "return error instanceof UsageError ? 2 : 0;"),
    evidence: /a page-6 failure must fail the step/,
    failures: 1,
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
  assert.match(baseline.output, new RegExp(`pass ${expectedTests}\\b`));
  console.log(`Unmodified disposable copy: exit 0, all ${expectedTests} added tests pass.`);
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
  assert.match(green.output, new RegExp(`pass ${expectedTests}\\b`));
  console.log(`Restored disposable copy: exit 0, all ${expectedTests} added tests pass.`);
} finally {
  forceRemove(scratch);
}
