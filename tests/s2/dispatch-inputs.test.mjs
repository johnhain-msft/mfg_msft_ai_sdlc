// AC8: workflow_dispatch inputs at runtime (target_repo, correlation_id, extra_instructions, dry_run). prepare-run.mjs, the first
// pre-agent step, guards the target repository, records the correlation id, the dispatch inputs and the base commit of the
// target checkout in run-context.json, and leaves the proposal file of a dry run. The failure-escalation job is guarded on
// dry_run by the reconciler; the guard of the other write-capable job is the open item at the end of this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { run } from "../../src/drift/prepare-run.mjs";
import { DRIFT_KEYS, driftLock, driftWorkflow, driftPreset, listTree, script, tempDir } from "./helpers/fixtures.mjs";
import { createGateWorkspace, BASH_SKIP } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, runNode } from "./helpers/stub-server.mjs";

const CONFIGURED = "example-owner/example-target";
let root;
let workspace;
let repo;
let outCounter = 0;

before(() => {
  root = tempDir("sdlc-s2-dispatch-");
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  repo = createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const nextOut = () => path.join(root, `out-${(outCounter += 1)}`);
const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: CONFIGURED, ...extra });
const prepare = (out, args, extra) => invoke(run, ["--out", out, ...args], { env: env(extra), cwd: root });
const context = (out) => JSON.parse(fs.readFileSync(path.join(out, "run-context.json"), "utf8"));
const baseSha = () => repo.head();

test("AC8: an empty target_repo, or one equal to the configured repository in any case, starts the run", async () => {
  for (const given of ["", CONFIGURED, CONFIGURED.toUpperCase(), `  ${CONFIGURED}  `]) {
    const out = nextOut();
    const result = await prepare(out, ["--target-repo", given]);
    assert.equal(result.code, 0, `'${given}': ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(out, "run-context.json")));
  }
});

test("AC8: a non-empty target_repo that differs from the configured repository exits 1, names both, and writes nothing", async () => {
  for (const given of ["example-owner/other", "other-owner/example-target", "example-owner/example-target-2"]) {
    const out = nextOut();
    const result = await prepare(out, ["--target-repo", given]);
    assert.equal(result.code, 1, given);
    assert.ok(result.stderr.includes(given) && result.stderr.includes(CONFIGURED), result.stderr);
    assert.equal(fs.existsSync(out), false, "no artifact directory is created");
  }
});

test("AC8: run-context.json records correlation_id and the base commit of the target checkout as baseSha", async () => {
  const out = nextOut();
  const result = await prepare(out, ["--target-repo", CONFIGURED, "--correlation-id", "run-2026.11/abc:1", "--extra-instructions", "", "--dry-run", "false"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(context(out), {
    version: 1,
    target_repo: CONFIGURED,
    checkout: "example-target",
    baseSha: baseSha(),
    correlation_id: "run-2026.11/abc:1",
    extra_instructions: "",
    dry_run: false,
  });
  assert.match(context(out).baseSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(listTree(out), ["run-context.json"], "a normal run leaves only the run context");
});

test("AC8: extra_instructions is recorded byte for byte, to be appended after the registration instructions and never replace them", async () => {
  const text = "- first: do this\r\n  - nested (é, 日本語)\n\nlast line with --dashes and `code`";
  const out = nextOut();
  const result = await prepare(out, ["--extra-instructions", text, "--correlation-id", "c1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(context(out).extra_instructions, text);
  assert.ok(fs.readFileSync(path.join(out, "run-context.json"), "utf8").includes("\\r\\n"), "the text is kept, escaped in JSON");
});

test("AC8: when dry_run is true the run leaves the file for the pull request it would have proposed, and when it is not it does not", async () => {
  const dry = nextOut();
  assert.equal((await prepare(dry, ["--dry-run", "true"])).code, 0);
  assert.equal(context(dry).dry_run, true);
  assert.deepEqual(listTree(dry), ["dry-run-proposal.json", "run-context.json"]);
  const proposal = JSON.parse(fs.readFileSync(path.join(dry, "dry-run-proposal.json"), "utf8"));
  assert.equal(proposal.dry_run, true);
  assert.equal(proposal.proposal, null, "the agent fills the proposal in");
  for (const value of ["TRUE", " True "]) {
    const out = nextOut();
    assert.equal((await prepare(out, ["--dry-run", value])).code, 0, value);
    assert.equal(context(out).dry_run, true, value);
  }
  for (const value of ["false", "", "FALSE"]) {
    const out = nextOut();
    assert.equal((await prepare(out, ["--dry-run", value])).code, 0, JSON.stringify(value));
    assert.equal(context(out).dry_run, false, JSON.stringify(value));
    assert.equal(fs.existsSync(path.join(out, "dry-run-proposal.json")), false, "no proposal file outside a dry run");
  }
  const invalid = nextOut();
  assert.notEqual((await prepare(invalid, ["--dry-run", "maybe"])).code, 0, "a value that is neither true nor false is refused");
  assert.equal(fs.existsSync(invalid), false);
});

test("AC8: a run without a correlation_id derives one from the Actions run, and an unusable one is refused", async () => {
  const derived = nextOut();
  assert.equal((await prepare(derived, [], { GITHUB_RUN_ID: "9001", GITHUB_RUN_ATTEMPT: "2" })).code, 0);
  assert.equal(context(derived).correlation_id, "run-9001-2");
  const noAttempt = nextOut();
  assert.equal((await prepare(noAttempt, [], { GITHUB_RUN_ID: "9001" })).code, 0);
  assert.equal(context(noAttempt).correlation_id, "run-9001-1");
  const local = nextOut();
  assert.equal((await prepare(local, [])).code, 0);
  assert.equal(context(local).correlation_id, "local");
  for (const bad of ["has space", "@everyone", "x".repeat(129), "-leading-dash", "line\nbreak", "a`b"]) {
    const out = nextOut();
    const result = await prepare(out, ["--correlation-id", bad]);
    assert.equal(result.code, 1, JSON.stringify(bad));
    assert.match(result.stderr, /correlation_id/);
    assert.equal(fs.existsSync(out), false);
  }
  const huge = nextOut();
  assert.equal((await prepare(huge, ["--extra-instructions", "x".repeat(65537)])).code, 1, "extra_instructions has a limit");
});

test("AC8: a missing configured repository, an absent checkout or a checkout that is not a git repository exits non-zero", async () => {
  const noConfigured = nextOut();
  const result = await invoke(run, ["--out", noConfigured], { env: cleanEnv({ GITHUB_WORKSPACE: workspace }), cwd: root });
  assert.notEqual(result.code, 0, "the configured repository is required");
  assert.match(result.stderr, /CONFIGURED_TARGET_REPO/);
  const absent = nextOut();
  const missing = await prepare(absent, ["--checkout", "no-such-directory"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /base commit/);
  const plain = path.join(workspace, "plain");
  fs.mkdirSync(plain);
  const notRepo = await prepare(nextOut(), ["--checkout", "plain"]);
  assert.equal(notRepo.code, 1, "a directory that is not a repository has no base commit");
  assert.notEqual((await prepare(nextOut(), ["--unknown", "x"])).code, 0, "an unknown option is refused");
});

test("AC8: the command, run as a process, exits 1 on a target_repo mismatch and 0 otherwise", async () => {
  const out = nextOut();
  const args = ["--out", out, "--target-repo", "example-owner/other", "--correlation-id", "c", "--extra-instructions", "", "--dry-run", "true"];
  const mismatch = await runNode(script("drift", "prepare-run.mjs"), args, { env: env(), cwd: root });
  assert.equal(mismatch.code, 1);
  assert.equal(fs.existsSync(out), false);
  const accepted = await runNode(script("drift", "prepare-run.mjs"), args.map((value) => (value === "example-owner/other" ? CONFIGURED : value)), { env: env(), cwd: root });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(context(out).dry_run, true);
});

for (const key of DRIFT_KEYS) {
  test(`AC8: the rendered first pre-agent step of drift-${key} behaves as specified when the runner runs it`, { skip: BASH_SKIP }, async () => {
    const { frontmatter } = driftWorkflow(key);
    const repoSlug = driftPreset(key).repo;
    const step = frontmatter["pre-agent-steps"][0];
    assert.equal(step.env.CONFIGURED_TARGET_REPO, repoSlug);
    assert.deepEqual(Object.entries(step.env).filter(([, value]) => String(value).includes("inputs.")).map(([name]) => name).sort(), ["CORRELATION_ID", "DRY_RUN", "EXTRA_INSTRUCTIONS", "TARGET_REPO_INPUT"]);
    const gate = createGateWorkspace({ checkoutName: repoSlug.split("/")[1], files: { "README.md": "x\n" } });
    try {
      // a dispatch whose target_repo names another repository stops before the agent starts
      const stopped = await gate.runSteps([step], { env: { TARGET_REPO_INPUT: "someone/else" } });
      assert.equal(stopped.code, 1, stopped.log);
      assert.equal(fs.existsSync(path.join(gate.agentDir, "run-context.json")), true, "the harness pre-wrote a context; the step must not replace it");
      assert.equal(JSON.parse(fs.readFileSync(path.join(gate.agentDir, "run-context.json"), "utf8")).correlation_id, "test");
      // an empty target_repo (a schedule run) records the context of the checkout
      const started = await gate.runSteps([step], { env: { TARGET_REPO_INPUT: "", CORRELATION_ID: "dispatch-7", EXTRA_INSTRUCTIONS: "- also check links", DRY_RUN: "true" } });
      assert.equal(started.code, 0, started.log);
      const written = JSON.parse(fs.readFileSync(path.join(gate.agentDir, "run-context.json"), "utf8"));
      assert.deepEqual({ target: written.target_repo, id: written.correlation_id, extra: written.extra_instructions, dry: written.dry_run, sha: written.baseSha }, { target: repoSlug, id: "dispatch-7", extra: "- also check links", dry: true, sha: gate.baseSha });
      assert.ok(fs.existsSync(path.join(gate.agentDir, "dry-run-proposal.json")));
    } finally {
      gate.cleanup();
    }
  });
}

test("AC8: the compiled escalate_failure job of every drift workflow is guarded by failure() && inputs.dry_run != true", () => {
  for (const key of DRIFT_KEYS) {
    const job = driftLock(key).workflow.jobs.escalate_failure;
    assert.equal(job.if, "failure() && inputs.dry_run != true", key);
    assert.equal(driftWorkflow(key).frontmatter.jobs.escalate_failure.if, "failure() && inputs.dry_run != true", `${key}: the source says the same`);
    assert.match(String(job.if), /inputs\.dry_run/);
  }
});

test("AC8: the safe_outputs job of every compiled drift workflow carries an if: that references inputs.dry_run", () => {
  for (const key of DRIFT_KEYS) {
    const job = driftLock(key).workflow.jobs.safe_outputs;
    assert.match(String(job.if), /inputs\.dry_run/, `${key}: safe_outputs.if is ${JSON.stringify(job.if)}`);
  }
});

test("AC8: the prompt of every drift workflow tells the agent to read run-context.json, to follow extra_instructions after its own and to write a dry-run proposal", () => {
  for (const key of DRIFT_KEYS) {
    const { body } = driftWorkflow(key);
    assert.ok(body.includes("/tmp/gh-aw/agent/run-context.json"), `${key}: reads the run context`);
    assert.match(body, /extra_instructions[\s\S]{0,80}follow it as well, after the instructions above and never in their place/, `${key}: extra instructions come after and do not replace`);
    assert.match(body, /dry_run[^\n]*true[\s\S]{0,80}do not call `create_pull_request`/, `${key}: no pull request in a dry run`);
    assert.ok(body.includes("/tmp/gh-aw/agent/dry-run-proposal.json"), `${key}: the proposal file`);
    assert.ok(body.indexOf("## Registration instructions") < body.indexOf("## Run context"), `${key}: the run context follows the registration instructions`);
  }
});
