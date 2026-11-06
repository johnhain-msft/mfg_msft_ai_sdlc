// AC53: .github/workflows/sdlc-onboard.md, whose only writer is src/reconcile.mjs (SPEC-01 AC56) and which S5 tests as rendered, is a gh-aw
// workflow that dispatches with one input per flag of bin/sdlc-onboard.mjs, installs gh-aw >= 1.0.1 through a pinned action, runs
// `node bin/sdlc-onboard.mjs`, mints its App token from vars.APP_CLIENT_ID and secrets.APP_PRIVATE_KEY, opens its pull request through
// safe-outputs.create-pull-request with auto-merge: false, and never echoes the App private key. The real compiler check is opt-in
// (SDLC_REAL_GH_AW=1) because it needs the gh-aw CLI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ONBOARD_USAGE } from "../../bin/lib/cli-flags.mjs";
import { ghEnvironment } from "../../bin/lib/gh-runner.mjs";
import { MIN_GH_AW_VERSION, compareVersions, parseVersion } from "../../bin/lib/ghaw-version.mjs";
import { REPO_ROOT, createScenario, fixtureRepos } from "./helpers/harness.mjs";

const WORKFLOW = ".github/workflows/sdlc-onboard.md";
const LOCK = ".github/workflows/sdlc-onboard.lock.yml";
const source = fs.readFileSync(path.join(REPO_ROOT, WORKFLOW), "utf8");
const lockText = fs.readFileSync(path.join(REPO_ROOT, LOCK), "utf8");
const [, frontText, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
const front = YAML.parse(frontText);
const lock = YAML.parse(lockText);
const INPUT_NAMES = ["repo", "downstream", "strategy", "watch_url", "schedule", "mode", "instructions", "manifest"];
const steps = Object.entries(lock.jobs).flatMap(([job, definition]) => (definition.steps ?? []).map((step) => ({ job, ...step })));

test("AC53: the workflow dispatches manually with exactly one input per flag of bin/sdlc-onboard.mjs", () => {
  assert.deepEqual(Object.keys(front.on).filter((key) => key !== "bots"), ["workflow_dispatch"], "workflow_dispatch is the only trigger (bots is the allowlist of the rendered on: block)");
  assert.deepEqual(Object.keys(front.on.workflow_dispatch.inputs), INPUT_NAMES);
  for (const [name, input] of Object.entries(front.on.workflow_dispatch.inputs)) {
    assert.equal(input.type, "string", name);
    assert.equal(typeof input.description, "string", name);
  }
  const flags = [...ONBOARD_USAGE.matchAll(/--([a-z]+(?:-[a-z]+)*)/g)].map((match) => match[1].replace(/-/g, "_"));
  assert.deepEqual([...new Set(flags)].sort(), [...INPUT_NAMES].sort(), "the inputs are exactly the flags that the command documents");
});

test("AC53: the lock file dispatches with the same eight inputs (the compiler adds its own aw_context)", () => {
  const dispatch = lock.on?.workflow_dispatch ?? lock[true]?.workflow_dispatch;
  assert.deepEqual(Object.keys(dispatch.inputs).filter((name) => name !== "aw_context").sort(), [...INPUT_NAMES].sort());
});

test("AC53: the instructions tell the agent to run node bin/sdlc-onboard.mjs with every input", () => {
  assert.ok(body.includes("node bin/sdlc-onboard.mjs"));
  for (const flag of ["--repo", "--downstream", "--strategy", "--watch-url", "--schedule", "--mode", "--instructions", "--manifest"]) assert.ok(body.includes(flag), flag);
  const record = front["pre-agent-steps"].find((step) => step.name === "Record the onboarding inputs");
  for (const name of INPUT_NAMES) assert.ok(Object.values(record.env).includes(`\${{ inputs.${name} }}`), `${name} is handed to the run`);
});

test("AC53: the dispatch inputs reach a step only through env, never interpolated into a shell command", () => {
  for (const step of front["pre-agent-steps"]) assert.equal(/\$\{\{\s*inputs\./.test(step.run ?? ""), false, step.name);
  for (const step of steps.filter((entry) => typeof entry.run === "string")) assert.equal(/\$\{\{\s*inputs\./.test(step.run), false, `${step.job}: ${step.name}`);
});

test("AC53: the App token is minted from vars.APP_CLIENT_ID and secrets.APP_PRIVATE_KEY, for the checkout and for the safe outputs", () => {
  for (const app of [front.checkout[0]["github-app"], front["safe-outputs"]["github-app"]]) {
    assert.equal(app["client-id"], "${{ vars.APP_CLIENT_ID }}");
    assert.equal(app["private-key"], "${{ secrets.APP_PRIVATE_KEY }}");
  }
  const minting = steps.filter((step) => /^actions\/create-github-app-token@[0-9a-f]{40}$/.test(step.uses ?? ""));
  assert.ok(minting.length >= 2);
  for (const step of minting) {
    assert.equal(step.with["client-id"], "${{ vars.APP_CLIENT_ID }}");
    assert.equal(step.with["private-key"], "${{ secrets.APP_PRIVATE_KEY }}");
  }
});

test("AC53: the pull request is opened through safe-outputs.create-pull-request with auto-merge: false, and the instructions say never merge", () => {
  const pr = front["safe-outputs"]["create-pull-request"];
  assert.strictEqual(pr["auto-merge"], false);
  assert.equal(pr.max, 1);
  assert.ok(pr.labels.includes("needs-review"), "a human reviews it");
  assert.equal(pr["protected-files"].policy, "blocked");
  assert.match(body, /Never merge\./);
  assert.match(body, /only through the safe output/);
  assert.match(source, /auto-merge: false/);
  assert.equal(/auto-merge:\s*true/.test(source), false);
  assert.equal(/auto-merge:\s*true/.test(lockText), false);
  assert.equal(front.permissions.contents, "read", "the agent job itself cannot write");
});

test("AC53: no step echoes secrets.APP_PRIVATE_KEY: it appears only as the private-key input of the App-token action and in the redaction step", () => {
  for (const step of steps) {
    if (typeof step.run === "string") assert.equal(/APP_PRIVATE_KEY/.test(step.run), false, `${step.job}: ${step.name} mentions APP_PRIVATE_KEY in its script`);
    const holders = [step.with, step.env].filter(Boolean).flatMap((block) => Object.entries(block).filter(([, value]) => /secrets\.APP_PRIVATE_KEY/.test(String(value))));
    for (const [key] of holders) {
      const mints = /^actions\/create-github-app-token@/.test(step.uses ?? "") && key === "private-key";
      const redacts = key === "SECRET_APP_PRIVATE_KEY" && step.env?.GH_AW_SECRET_NAMES !== undefined;
      assert.ok(mints || redacts, `${step.job}: ${step.name} passes the private key as ${key}`);
    }
  }
  for (const line of lockText.split("\n")) {
    if (/secrets\.APP_PRIVATE_KEY/.test(line)) assert.equal(/\b(echo|printf|cat)\b/.test(line), false, line);
  }
  assert.equal(/secrets\.APP_PRIVATE_KEY/.test(body), false);
});

test("AC53: gh-aw >= 1.0.1 is installed through a step whose action reference is pinned to a commit SHA", () => {
  const metadata = JSON.parse(/^# gh-aw-metadata: (.*)$/m.exec(lockText)[1]);
  assert.ok(compareVersions(parseVersion(metadata.compiler_version), parseVersion(MIN_GH_AW_VERSION)) >= 0, `compiled with gh-aw ${metadata.compiler_version}`);
  assert.equal(metadata.strict, true, "compiled in strict mode");
  const setups = steps.filter((step) => /^github\/gh-aw-actions\/setup@/.test(step.uses ?? ""));
  assert.ok(setups.length >= 1);
  for (const step of setups) {
    assert.match(step.uses, /^github\/gh-aw-actions\/setup@[0-9a-f]{40}$/, "pinned to a full commit SHA");
    const comment = new RegExp(`${step.uses.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} # (v\\S+)`).exec(lockText);
    assert.ok(comment && compareVersions(parseVersion(comment[1]), parseVersion(MIN_GH_AW_VERSION)) >= 0, `the pin is documented as ${comment?.[1]}`);
  }
  for (const step of steps.filter((entry) => entry.uses)) assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$|^\.\//, `${step.uses} is pinned`);
});

test("AC53: S5 does not write the workflow: nothing under bin/ names the onboarding workflow or its lock file", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, "bin"));
  for (const file of files) assert.equal(/sdlc-onboard\.(md|lock\.yml)/.test(fs.readFileSync(file, "utf8")), false, `${file} names the rendered onboarding workflow`);
});

test("AC53: running the command with every input that the workflow offers succeeds and records each of them", async () => {
  const scenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" }) } });
  try {
    scenario.workspace.write("notes/for-the-workflow.md", "Instructions that the workflow hands over as a path.\n");
    const argv = [
      "--repo", "example-owner/node-app",
      "--downstream", "example-owner/edge-ok",
      "--strategy", "content-and-docs-sync",
      "--watch-url", "https://example.com/changelog",
      "--schedule", "0 7 * * 3",
      "--mode", "ai-adaptation",
      "--instructions", "notes/for-the-workflow.md",
      "--manifest", "sdlc.yaml",
    ];
    const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    const project = data.projects.find((entry) => entry.projectKey === "node-app");
    assert.equal(project.driftAudit.upkeepStrategy, "content-and-docs-sync");
    assert.equal(project.driftAudit.schedule, "0 7 * * 3");
    assert.equal(project.driftAudit.knowledgeSources.watchUrls[0].url, "https://example.com/changelog");
    assert.equal(data.dependencyEdges.at(-1).mode, "ai-adaptation");
    assert.ok(scenario.workspace.read("instructions/node-app.md").startsWith("Instructions that the workflow hands over as a path.\n"));
    for (const flag of ["--downstream", "--strategy", "--watch-url", "--schedule", "--mode", "--instructions", "--manifest"]) assert.ok(argv.includes(flag));
  } finally {
    await scenario.cleanup();
  }
});

// --- the real compiler (opt-in) --------------------------------------------------------------------------------------------

test("AC53: gh aw compile --strict --purge --json exits 0 with no error for sdlc-onboard.md and reproduces the committed sdlc-onboard.lock.yml", { skip: process.env.SDLC_REAL_GH_AW === "1" ? false : "set SDLC_REAL_GH_AW=1 to run the real gh-aw compiler (it needs the gh-aw CLI, version 1.0.1 or newer)" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-compile-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.cpSync(path.join(REPO_ROOT, ".github"), path.join(root, ".github"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "sdlc.yaml"), path.join(root, "sdlc.yaml"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "-c", "core.autocrlf=false", "commit", "-q", "-m", "baseline"], { cwd: root });
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: root, env: ghEnvironment(process.env), encoding: "utf8", shell: process.platform === "win32" });
    assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    const results = JSON.parse(outcome.stdout);
    const own = results.filter((entry) => /sdlc-onboard\.md$/.test(entry.workflow ?? entry.file ?? ""));
    assert.ok(own.length >= 1, "the compiler reported on sdlc-onboard.md");
    for (const entry of own) assert.deepEqual(entry.errors ?? [], []);
    assert.equal(fs.readFileSync(path.join(root, LOCK), "utf8"), lockText, "the compiler reproduces the committed lock file byte for byte");
    assert.doesNotThrow(() => execFileSync("git", ["diff", "--exit-code", "--", LOCK], { cwd: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
