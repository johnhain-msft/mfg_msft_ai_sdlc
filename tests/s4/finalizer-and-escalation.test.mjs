// AC51-AC54 and AC73: the two custom jobs of the AI workflows. The rendered finalize_poll_state step is executed in bash against a recorder in place of SPEC-03's script
// (the seven flags, the three tokens, the order of its neighbours), and SPEC-03's real script is run in process against the local GitHub stub for each preset edge: a run
// that committed nothing, a verified pull request, a pull request that does not record the revision, and the failure transitions with their deduplicated issue.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BashSandbox } from "../s1/helpers/bash-runtime.mjs";
import { seedState, TOKENS } from "../s3/helpers/fixtures.mjs";
import { BASE, ETAG, HEAD, PR_HEAD, TARGET, flagsFor, invoke, world } from "../s3/helpers/poll-state-world.mjs";
import { AI, DOWNSTREAM, customJobs, edgeOf } from "./helpers/workflows.mjs";

const TOKEN_EXPRESSION = "${{ steps.app_token.outputs.token }}";
const updateStepOf = (job) => job.steps.find((step) => String(step.run ?? "").includes("update-poll-state.mjs"));
const stateOf = (w) => w.stub.variable(w.edgeValue.stateVariable);
const SEVEN = ["--slug", "--branch", "--provenance-file", "--base-sha", "--head-sha", "--target-sha", "--etag"];

test("AC51: finalize_poll_state is the App token, the checkout of src and schemas, npm ci, the artifact download, the export of the revisions and then the update step, with the guard and the three tokens", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    const job = customJobs(spec).finalize_poll_state;
    assert.equal(job.if, "success() && inputs.dry_run != 'true'", spec.id);
    assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"]);
    assert.equal("concurrency" in job, false);
    const [mint, checkout, install, download, exportStep, update] = job.steps;
    assert.equal(job.steps.length, 6, spec.id);
    assert.equal(mint.id, "app_token");
    assert.equal(mint.with["permission-actions-variables"], "write");
    assert.deepEqual(checkout, { uses: "actions/checkout@v4", with: { token: TOKEN_EXPRESSION, "sparse-checkout": "src\nschemas", "persist-credentials": false } });
    assert.deepEqual(install, { run: "npm ci --ignore-scripts" });
    assert.deepEqual(download, { uses: "actions/download-artifact@v4", with: { name: "sdlc-cascade-shas-${{ github.run_id }}", path: "/tmp/gh-aw" } });
    assert.ok(exportStep.run.includes("jq -r .baseSha /tmp/gh-aw/cascade-shas.json") && exportStep.run.includes('>> "$GITHUB_ENV"'), "BASE_SHA and AGENT_HEAD_SHA are read from the artifact and exported");
    assert.equal(updateStepOf(job), update);
    assert.equal(update.if, "inputs.dry_run != 'true'");
    assert.deepEqual(update.env, {
      GH_TOKEN: TOKEN_EXPRESSION,
      ISSUES_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      UPSTREAM_SHA: "${{ inputs.upstream_sha }}",
      CORRELATION_ID: "${{ inputs.correlation_id }}",
      UPSTREAM_ETAG: "${{ inputs.upstream_etag }}",
      REPO_SLUG: spec.upstreamSlug,
      BRANCH_NAME: spec.branchName,
      PROVENANCE_FILE: edge.provenanceFile,
    });
    assert.ok(update.run.startsWith('node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug "$REPO_SLUG" --branch "$BRANCH_NAME" --provenance-file "$PROVENANCE_FILE" --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"'), spec.id);
    assert.equal(update.run.includes("--record-failure"), false, `${spec.id}: finalize_poll_state records no failure (AC54)`);
    assert.equal(job.steps.some((step) => step.if === "failure()"), false, `${spec.id}: no step guarded by failure()`);
  }
  assert.equal(updateStepOf(customJobs(AI[0]).finalize_poll_state).env.PROVENANCE_FILE, "experiences/copilot-workshop/source-inputs.json");
});

/** Replaces the expressions of a step's env with the values that the runner gives it. */
function resolve(env, inputs) {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      String(value).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression) => {
        if (expression.startsWith("inputs.")) return inputs[expression.slice("inputs.".length)];
        if (expression === "steps.app_token.outputs.token") return TOKENS.gh;
        if (expression === "secrets.GITHUB_TOKEN") return TOKENS.issues;
        throw new Error(`cannot resolve ${expression}`);
      }),
    ]),
  );
}

const RECORDER = (name) => `import fs from "node:fs";
const record = { argv: process.argv.slice(2), env: Object.fromEntries(["GH_TOKEN", "ISSUES_TOKEN", "CORRELATION_ID", "UPSTREAM_SHA", "UPSTREAM_ETAG", "REPO_SLUG"].map((key) => [key, process.env[key]])) };
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ script: ${JSON.stringify(name)}, ...record, resultFile: process.argv.includes("--poll-state-result") ? fs.readFileSync(process.argv[process.argv.indexOf("--poll-state-result") + 1], "utf8") : null }) + "\\n");
if (${JSON.stringify(name)} === "update-poll-state") { if (process.env.POLL_STDOUT) process.stdout.write(process.env.POLL_STDOUT + "\\n"); process.exit(Number(process.env.POLL_EXIT ?? 0)); }
process.stdout.write(JSON.stringify({ result: "from the result script" }) + "\\n");
`;

test("AC51/AC70: the update step run in bash hands the seven flags and the three tokens to the script of SPEC-03, then the result script, which prints the last line; a failing script stops the step before it", () => {
  for (const spec of AI) {
    const box = new BashSandbox();
    try {
      fs.mkdirSync(path.join(box.work, "src"), { recursive: true });
      fs.writeFileSync(path.join(box.work, "src", "update-poll-state.mjs"), RECORDER("update-poll-state"));
      fs.writeFileSync(path.join(box.work, "src", "ai-pull-request-result.mjs"), RECORDER("ai-pull-request-result"));
      const log = path.join(box.root, "calls.jsonl").replace(/\\/g, "/");
      const step = updateStepOf(customJobs(spec).finalize_poll_state);
      const inputs = { upstream_sha: TARGET, upstream_etag: ETAG, correlation_id: "run-5001-1" };
      const env = { ...resolve(step.env, inputs), BASE_SHA: BASE, AGENT_HEAD_SHA: HEAD, CALL_LOG: log, RUNNER_TEMP: box.root.replace(/\\/g, "/") };
      const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

      const poll = JSON.stringify({ outcome: "pr-opened", prNumber: 7, prUrl: "https://example.invalid/pull/7", headSha: PR_HEAD, openPrTargetSha: TARGET });
      const ok = box.run(step.run, { ...env, POLL_STDOUT: poll });
      assert.equal(ok.status, 0, `${spec.id}: ${ok.stderr}`);
      const [update, result] = calls();
      assert.deepEqual(update.argv, ["--slug", spec.upstreamSlug, "--branch", spec.branchName, "--provenance-file", edgeOf(spec).provenanceFile, "--base-sha", BASE, "--head-sha", HEAD, "--target-sha", TARGET, "--etag", ETAG], `${spec.id}: the seven flags`);
      assert.deepEqual(update.env, { GH_TOKEN: TOKENS.gh, ISSUES_TOKEN: TOKENS.issues, CORRELATION_ID: "run-5001-1", UPSTREAM_SHA: TARGET, UPSTREAM_ETAG: ETAG, REPO_SLUG: spec.upstreamSlug });
      assert.deepEqual(result.argv.slice(0, 3), ["--slug", spec.upstreamSlug, "--poll-state-result"]);
      assert.equal(result.resultFile, `${poll}\n`, `${spec.id}: the result script reads the line that the poll-state script printed`);
      assert.equal(result.env.GH_TOKEN, TOKENS.gh);
      assert.equal(ok.stdout.trim().split("\n").at(-1), JSON.stringify({ result: "from the result script" }), `${spec.id}: the result is the last line printed`);
      assert.ok(ok.stdout.includes(poll), `${spec.id}: the line of the poll-state script is printed first`);

      fs.rmSync(log);
      const failed = box.run(step.run, { ...env, POLL_STDOUT: poll, POLL_EXIT: "1" });
      assert.equal(failed.status, 1, `${spec.id}: the exit code of the script is the exit code of the step`);
      assert.deepEqual(calls().map((call) => call.script), ["update-poll-state"], `${spec.id}: the result script did not run after a failure`);
    } finally {
      box.cleanup();
    }
  }
});

for (const spec of AI) {
  const entry = edgeOf(spec);

  test(`AC52 ${spec.id}: when the agent committed nothing (BASE_SHA == AGENT_HEAD_SHA) the script records the no-op and looks for no pull request`, async () => {
    const w = world({ edgeValue: entry, start: seedState(entry) });
    try {
      const result = await invoke(w, flagsFor(entry, { "--head-sha": BASE }));
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { outcome: "noop-no-changes" });
      const written = stateOf(w);
      assert.equal(written.etag, ETAG);
      assert.equal(written.lastObservedHeadSha, TARGET);
      assert.equal(written.lastNoopHeadSha, TARGET);
      assert.equal(written.inFlightRunId, null);
      assert.equal(written.inFlightTargetSha, null);
      assert.equal(written.failedTargetSha, null);
      assert.equal(written.failedAttempts, 0);
      assert.equal(w.stub.calls("GET", "/pulls").length, 0, "no pull-request lookup");
      assert.equal(w.stub.calls("PATCH").length, 1, "one write, of the state variable");
    } finally {
      w.workspace.cleanup();
    }
  });

  test(`AC53 ${spec.id}: with a commit, an open pull request whose provenance records upstream_sha is verified and the state is written; a mismatching commit and an absent pull request fail with no success record`, async () => {
    const good = world({ edgeValue: entry, start: seedState(entry) });
    try {
      const result = await invoke(good, flagsFor(entry));
      assert.equal(result.code, 0, result.stderr);
      const line = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.deepEqual({ outcome: line.outcome, prNumber: line.prNumber }, { outcome: "pr-opened", prNumber: 7 });
      const written = stateOf(good);
      assert.deepEqual({ etag: written.etag, lastObservedHeadSha: written.lastObservedHeadSha, openPrTargetSha: written.openPrTargetSha, openPrNumber: written.openPrNumber, failedAttempts: written.failedAttempts }, { etag: ETAG, lastObservedHeadSha: TARGET, openPrTargetSha: TARGET, openPrNumber: 7, failedAttempts: 0 });
      const lookups = good.stub.calls("GET").map((request) => request.pathAndSearch);
      assert.ok(lookups.includes(`/repos/${DOWNSTREAM}/pulls?state=open&head=johnhain-msft:${spec.branchName}`), lookups.join("\n"));
      assert.ok(lookups.some((pathAndSearch) => pathAndSearch.includes(`/contents/${entry.provenanceFile}?ref=${PR_HEAD}`)), lookups.join("\n"));
    } finally {
      good.workspace.cleanup();
    }
    const mismatch = world({ edgeValue: entry, start: seedState(entry), files: { [PR_HEAD]: { [entry.provenanceFile]: JSON.stringify({ commit: "1".repeat(40) }) } } });
    try {
      const result = await invoke(mismatch, flagsFor(entry));
      assert.notEqual(result.code, 0, "the step fails, and so does the job");
      assert.equal(stateOf(mismatch).openPrTargetSha, null, "no success record");
      assert.equal(stateOf(mismatch).openPrNumber, null);
    } finally {
      mismatch.workspace.cleanup();
    }
    const absent = world({ edgeValue: entry, start: seedState(entry), pulls: [] });
    try {
      const result = await invoke(absent, flagsFor(entry));
      assert.notEqual(result.code, 0);
      assert.equal(stateOf(absent).openPrTargetSha, null);
      assert.equal(stateOf(absent).lastObservedHeadSha, entry.initialBaselineSha, "the observation is not advanced");
    } finally {
      absent.workspace.cleanup();
    }
  });

  test(`AC54/AC73 ${spec.id}: no pull request that records upstream_sha applies the failure transition once, opens one deduplicated [sdlc-failure] issue with ISSUES_TOKEN, and a second failure comments instead`, async () => {
    const w = world({ edgeValue: entry, start: seedState(entry), pulls: [] });
    try {
      const first = await invoke(w, flagsFor(entry));
      assert.equal(first.code, 1, first.stderr);
      assert.equal(stateOf(w).failedAttempts, 1, "exactly one failure transition");
      assert.equal(stateOf(w).failedTargetSha, TARGET);
      assert.equal(w.stub.issues.length, 1);
      assert.equal(w.stub.issues[0].title, `[sdlc-failure] cascade-ai-${entry.edgeId} (${DOWNSTREAM})`);
      assert.deepEqual(w.stub.issues[0].labels, ["sdlc-gate-failure"]);
      assert.equal(w.stub.issues[0].authorization, `Bearer ${TOKENS.issues}`, "the issue is written with ISSUES_TOKEN and never with the App token");
      // the escalation job's own command: a second failure of the same target
      const second = await invoke(w, ["--record-failure", "--slug", entry.upstreamSlug, "--target-sha", TARGET, "--workflow-id", `cascade-ai-${entry.edgeId}`]);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(stateOf(w).failedAttempts, 2);
      assert.equal(stateOf(w).blockedTargetSha, TARGET, "blocked once failedAttempts reaches two");
      assert.equal(w.stub.issues.length, 1, "no second issue");
      assert.equal(w.stub.world.comments.length, 1, "a comment on the first one");
      assert.equal(w.stub.world.comments[0].authorization, `Bearer ${TOKENS.issues}`);
    } finally {
      w.workspace.cleanup();
    }
  });
}

test("AC54: the escalation job runs only on failure, outside finalize_poll_state, and invokes --record-failure with the slug, the target and its own workflow id", () => {
  for (const spec of AI) {
    const job = customJobs(spec).escalate_failure;
    assert.equal(job.if, "failure() && inputs.dry_run != 'true'", spec.id);
    assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"], `${spec.id}: it does not list finalize_poll_state`);
    assert.equal(job["detection-gate"], "status-only", spec.id);
    assert.equal(job.steps.length, 4);
    const step = updateStepOf(job);
    assert.equal(step.if, "inputs.dry_run != 'true'");
    assert.equal(step.run, `node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug "$REPO_SLUG" --target-sha "$UPSTREAM_SHA" --workflow-id ${spec.id}`);
    assert.equal(step.env.GH_TOKEN, TOKEN_EXPRESSION);
    assert.equal(step.env.ISSUES_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    assert.equal(step.env.CORRELATION_ID, "${{ inputs.correlation_id }}");
    assert.equal(JSON.stringify(customJobs(spec).finalize_poll_state).includes("--record-failure"), false, "exactly one failure transition is applied");
  }
});

test("AC51: the finalizer step reads the three values of the dispatch (upstream_sha, upstream_etag, correlation_id) and never recomputes the revisions from main", () => {
  for (const spec of AI) {
    const job = customJobs(spec).finalize_poll_state;
    const text = JSON.stringify(job);
    assert.equal(text.includes("git "), false, `${spec.id}: the finalizer runs no git command`);
    assert.equal(/gh api|curl|fetch\(/.test(text), false, spec.id);
    assert.ok(text.includes("cascade-shas.json"), spec.id);
  }
  assert.deepEqual(SEVEN.length, 7);
});
