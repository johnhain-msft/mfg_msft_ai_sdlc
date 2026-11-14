// AC5: contract C2 state ownership. S1 owns the compiled workflow definitions (network.allowed, on.bots, concurrency, the static safe-outputs
// policy); S2 owns the runtime evaluation and the artifacts under /tmp/gh-aw/agent/. An S2 script writes only under the directory
// given by --out (default /tmp/gh-aw/agent), never .github/workflows/**, and leaves the target checkout and the orchestrator workspace
// as they were; the reconciler writes nothing under /tmp/gh-aw/agent. The rendered steps invoke the S2 scripts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { run as checkResponse } from "../../src/drift/check-pr-response.mjs";
import { DEFAULT_OUT, outDirectory } from "../../src/drift/lib/cli.mjs";
import { run as escalate } from "../../src/drift/escalate-gate-failure.mjs";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { run as snapshot } from "../../src/snapshot-watch-sources.mjs";
import { run as validate } from "../../src/validate-copilot-lab-audit.mjs";
import { abs, DRIFT_KEYS, driftWorkflow, driftWorkflowText, fixture, listTree, readText, script, tempDir, WORKFLOWS } from "./helpers/fixtures.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { createOrchestratorWorkspace, invoke, isUnder, recordingFs } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json, runNode } from "./helpers/stub-server.mjs";

const TARGET = "example-owner/example-target";
const TOKEN = "ghs_installationtokenfixture";

const ownershipFixture = createOrchestratorWorkspace;

const pages = () =>
  createFakeFetch((entry) => {
    if (entry.path === "/changelog") return { status: 200, headers: { "content-type": "text/html" }, body: "<html>Release 18.0.0</html>" };
    return { status: 404, body: "not found" };
  });
const pulls = () => createFakeFetch(() => json(200, [{ number: 5, html_url: "https://github.example/pull/5", head: { ref: "sdlc/weekly-audit-2026-11-01" }, labels: [], draft: false }]));

/** Runs the three scripts that write artifacts, in the order of the rendered pre-agent steps, with the same recorded file system. */
async function runPreAgentSteps(fixtureWorkspace, { dryRun = "false", cwd = fixtureWorkspace.workspace, out = fixtureWorkspace.out } = {}) {
  const recorder = recordingFs();
  const env = cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: fixtureWorkspace.workspace, GH_APP_INSTALLATION_TOKEN: TOKEN });
  const common = { env, fs: recorder.fs, cwd };
  const results = [];
  results.push(await invoke(prepare, ["--out", out, "--target-repo", TARGET, "--correlation-id", "c-1", "--extra-instructions", "keep it short", "--dry-run", dryRun, "--checkout", "checkout"], common));
  results.push(await invoke(dedupe, ["--out", out, "--target-repo", TARGET], { ...common, fetch: pulls() }));
  results.push(await invoke(snapshot, ["--out", out, "--project", "snapshot-fixture", "--manifest", fixtureWorkspace.manifest, "--checkout", fixtureWorkspace.checkout, "--timeout-ms", "150"], { ...common, fetch: pages() }));
  return { results, recorder };
}

test("AC5: the pre-agent scripts create files only under --out and leave the workspace and the target checkout clean", async () => {
  const fixtureWorkspace = ownershipFixture();
  try {
    const before = fixtureWorkspace.fingerprint();
    assert.equal(fixtureWorkspace.orchestrator.status(), "", "the fixture workspace starts clean");
    assert.equal(fixtureWorkspace.status(), "", "and so does the fixture checkout");
    const { results, recorder } = await runPreAgentSteps(fixtureWorkspace);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.ok(recorder.writes.length > 0, "the scripts did write");
    for (const written of recorder.writes) assert.ok(isUnder(written, fixtureWorkspace.out), `${written} is under ${fixtureWorkspace.out}`);
    const created = listTree(fixtureWorkspace.out);
    assert.ok(created.includes("run-context.json") && created.includes("open-pr-dedup.json") && created.includes("sources/manifest.json"), created.join(", "));
    assert.equal(fixtureWorkspace.fingerprint(), before, "nothing outside --out changed: not the sdlc.yaml, not a workflow, not the checkout");
    assert.equal(fixtureWorkspace.orchestrator.status(), "", "git status --porcelain in the orchestrator workspace is empty");
    assert.equal(fixtureWorkspace.status(), "", "git status --porcelain in the target checkout is empty");
  } finally {
    fixtureWorkspace.cleanup();
  }
});

test("AC5: a dry run adds its proposal file under --out and nowhere else", async () => {
  const fixtureWorkspace = ownershipFixture();
  try {
    const before = fixtureWorkspace.fingerprint();
    const { results, recorder } = await runPreAgentSteps(fixtureWorkspace, { dryRun: "true" });
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.ok(listTree(fixtureWorkspace.out).includes("dry-run-proposal.json"));
    for (const written of recorder.writes) assert.ok(isUnder(written, fixtureWorkspace.out), written);
    assert.equal(fixtureWorkspace.fingerprint(), before);
    assert.equal(fixtureWorkspace.orchestrator.status(), "");
    assert.equal(fixtureWorkspace.status(), "");
  } finally {
    fixtureWorkspace.cleanup();
  }
});

test("AC5: a relative --out is resolved against the current directory, which here is not the workspace, and the workspace stays untouched", async () => {
  const fixtureWorkspace = ownershipFixture();
  const elsewhere = tempDir("sdlc-s2-elsewhere-");
  try {
    const before = fixtureWorkspace.fingerprint();
    const { results, recorder } = await runPreAgentSteps(fixtureWorkspace, { cwd: elsewhere, out: "agent-artifacts" });
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    for (const written of recorder.writes) assert.ok(isUnder(written, path.join(elsewhere, "agent-artifacts")), written);
    assert.ok(fs.existsSync(path.join(elsewhere, "agent-artifacts", "run-context.json")));
    assert.equal(fixtureWorkspace.fingerprint(), before);
    assert.equal(fixtureWorkspace.orchestrator.status(), "");
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    fixtureWorkspace.cleanup();
  }
});

test("AC5: run as a command, prepare-run writes its run context under --out and nothing else", async () => {
  const fixtureWorkspace = ownershipFixture();
  try {
    const before = fixtureWorkspace.fingerprint();
    const result = await runNode(script("drift", "prepare-run.mjs"), ["--out", fixtureWorkspace.out, "--target-repo", TARGET, "--correlation-id", "c-2", "--dry-run", "false", "--checkout", "checkout"], {
      env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: fixtureWorkspace.workspace }),
      cwd: fixtureWorkspace.workspace,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listTree(fixtureWorkspace.out), ["run-context.json"]);
    assert.equal(fixtureWorkspace.fingerprint(), before);
    assert.equal(fixtureWorkspace.orchestrator.status(), "");
    assert.equal(fixtureWorkspace.status(), "");
  } finally {
    fixtureWorkspace.cleanup();
  }
});

test("AC5: where the runner provides GITHUB_ENV, prepare-run adds one line to that file and still writes its artifacts only under --out", async () => {
  const fixtureWorkspace = ownershipFixture();
  const recorder = recordingFs();
  const envFile = path.join(tempDir("sdlc-s2-github-env-"), "github-env");
  fs.writeFileSync(envFile, "");
  try {
    const before = fixtureWorkspace.fingerprint();
    const result = await invoke(prepare, ["--out", fixtureWorkspace.out, "--target-repo", TARGET, "--correlation-id", "c-3", "--dry-run", "false", "--checkout", "checkout"], {
      env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: fixtureWorkspace.workspace, GITHUB_ENV: envFile }),
      cwd: fixtureWorkspace.workspace,
      fs: recorder.fs,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(recorder.writes.filter((written) => !isUnder(written, fixtureWorkspace.out)), [path.resolve(envFile)], "the one file outside --out is the runner's environment file");
    assert.equal(fs.readFileSync(envFile, "utf8"), `SDLC_BASE_SHA=${fixtureWorkspace.repo.head()}\n`);
    assert.deepEqual(listTree(fixtureWorkspace.out), ["run-context.json"]);
    assert.equal(fixtureWorkspace.fingerprint(), before, "the workspace and the target checkout are as they were");
    assert.equal(fixtureWorkspace.status(), "");
  } finally {
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
    fixtureWorkspace.cleanup();
  }
});

test("AC5: the scripts that produce no artifact (escalation, response check, audit validator) write no file in the target checkout or under --out; the escalation and the response check write none at all, and the validator only its own scratch directory, which it removes", async () => {
  const recorder = recordingFs();
  const validatorRecorder = recordingFs();
  const lab = createRepo(labFiles());
  const out = tempDir("sdlc-s2-validate-out-");
  try {
    const fake = createFakeFetch((entry) => (entry.method === "POST" ? json(201, { number: 1, html_url: "https://github.example/issues/1" }) : json(200, [])));
    const escalation = await invoke(escalate, ["--workflow-id", "drift-x", "--target-repo", TARGET, "--run-url", "https://github.example/run/1"], { env: cleanEnv({ GH_TOKEN: TOKEN, GITHUB_REPOSITORY: "example-owner/example-central" }), fs: recorder.fs, fetch: fake });
    assert.equal(escalation.code, 0, escalation.stderr);
    const response = await invoke(checkResponse, [fixture("pr-response", "valid.json"), "--workflow", abs(WORKFLOWS, "drift-copilot-lab.md")], { fs: recorder.fs });
    assert.equal(response.code, 0, response.stderr);
    const validation = await invoke(validate, ["--checkout", lab.dir, "--out", out, "--base-sha", lab.head()], { fs: validatorRecorder.fs, cwd: out });
    assert.equal(validation.code, 0, validation.stderr);
    assert.deepEqual(recorder.writes, [], "no write-class file system call");
    // The validator reads the checkout in a scratch repository (SPEC-02 AC22). It makes that directory, writes in it and removes it; the recorder also
    // lists the source of a copy beside its destination, so the refs, HEAD and shallow file that it copies out of the checkout's .git directory show up too.
    const isScratch = (written) => isUnder(written, os.tmpdir()) && /[\\/]sdlc-inspect-[^\\/]*([\\/]|$)/.test(written);
    const checkoutGitDirectory = path.join(lab.dir, ".git");
    assert.deepEqual(
      validatorRecorder.writes.filter((written) => !isScratch(written) && !isUnder(written, checkoutGitDirectory)),
      [],
      "every path of a write-class call is in the scratch directory or is a source of a copy",
    );
    const sources = new Set(validatorRecorder.writes.filter((written) => isUnder(written, checkoutGitDirectory)).map((written) => path.relative(checkoutGitDirectory, written)));
    for (const source of sources) assert.ok(["HEAD", "refs", "packed-refs", "shallow"].includes(source), `${source} is only read out of the checkout's .git`);
    const scratchDirectories = new Set(validatorRecorder.writes.map((written) => /^(.*[\\/]sdlc-inspect-[^\\/]+)/.exec(written)?.[1]).filter(Boolean));
    assert.equal(scratchDirectories.size, 1, "one scratch directory");
    for (const directory of scratchDirectories) assert.equal(fs.existsSync(directory), false, `${directory} is removed`);
    assert.deepEqual(listTree(out), [], "nothing under its --out either");
    assert.equal(lab.status(), "", "and the lab checkout is clean");
  } finally {
    lab.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("AC5: with no --out and no override the artifact directory is /tmp/gh-aw/agent, and SDLC_DRIFT_OUT or --out moves it", () => {
  assert.equal(DEFAULT_OUT, "/tmp/gh-aw/agent");
  assert.equal(outDirectory(undefined, {}), "/tmp/gh-aw/agent");
  assert.equal(outDirectory(undefined, { SDLC_DRIFT_OUT: "  " }), "/tmp/gh-aw/agent");
  assert.equal(outDirectory(undefined, { SDLC_DRIFT_OUT: "/somewhere/else" }), "/somewhere/else");
  assert.equal(outDirectory("/given", { SDLC_DRIFT_OUT: "/somewhere/else" }), "/given", "the flag wins");
});

for (const key of DRIFT_KEYS) {
  test(`AC5: the rendered steps of drift-${key}.md invoke the S2 scripts, and each writes to the default artifact directory`, () => {
    const text = driftWorkflowText(key);
    assert.match(text, /src\/drift\/prepare-run\.mjs/);
    assert.match(text, /src\/drift\/dedupe-open-prs\.mjs/);
    assert.match(text, /src\/snapshot-watch-sources\.mjs/);
    assert.match(text, /src\/drift\/previous-watch-index\.mjs/);
    assert.match(text, /src\/drift\/escalate-gate-failure\.mjs/);
    const { frontmatter } = driftWorkflow(key);
    const [prepareStep, dedupeStep, previousStep, snapshotStep, uploadStep] = frontmatter["pre-agent-steps"];
    assert.match(prepareStep.run, /node "\$GITHUB_WORKSPACE\/src\/drift\/prepare-run\.mjs" --out \/tmp\/gh-aw\/agent /);
    assert.match(dedupeStep.run, /node "\$GITHUB_WORKSPACE\/src\/drift\/dedupe-open-prs\.mjs" --out \/tmp\/gh-aw\/agent /);
    assert.match(previousStep.run, /node "\$GITHUB_WORKSPACE\/src\/drift\/previous-watch-index\.mjs" --out \/tmp\/gh-aw\/agent /);
    assert.match(snapshotStep.run, /node "\$GITHUB_WORKSPACE\/src\/snapshot-watch-sources\.mjs" --out \/tmp\/gh-aw\/agent /);
    assert.equal(uploadStep.with.path, "/tmp/gh-aw/agent/sources/watch-index.json", "the upload reads the index that the snapshot wrote under the artifact directory");
    for (const step of frontmatter["pre-agent-steps"]) {
      assert.equal(/\.github\/workflows|network\.allowed|on\.bots|safe-outputs/.test(step.run ?? ""), false, `${step.name}: the step names no S1-owned location`);
    }
  });
}

test("AC5: the reconciler writes under no /tmp/gh-aw path: no write-class call of src/reconcile.mjs names it", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  const writeCalls = source.split("\n").filter((line) => /\bfs\.(writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync|cpSync|rmSync|mkdtempSync)\(/.test(line));
  assert.ok(writeCalls.length > 0, "the scan found the reconciler's writes");
  for (const line of writeCalls) assert.equal(/AGENT_DIR|tmp\/gh-aw|gh-aw\/agent/.test(line), false, line.trim());
});

test("AC5: no S2 script names .github/workflows in a write-class call or imports the reconciler", () => {
  const files = [abs("src", "snapshot-watch-sources.mjs"), abs("src", "validate-copilot-lab-audit.mjs"), ...listTree(abs("src", "drift")).filter((file) => file.endsWith(".mjs")).map((file) => abs("src", "drift", file))];
  assert.ok(files.length >= 12);
  for (const file of files) {
    const source = readText(file);
    assert.equal(/reconcile\.mjs/.test(source), false, `${path.basename(file)} does not import the reconciler`);
    for (const line of source.split("\n").filter((candidate) => /\b(writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync|cpSync|rmSync)\(/.test(candidate))) {
      assert.equal(/\.github|workflows/.test(line), false, `${path.basename(file)}: ${line.trim()}`);
    }
  }
});
