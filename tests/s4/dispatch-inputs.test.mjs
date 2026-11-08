// AC24, AC25 and AC28: the dispatch inputs are validated before anything else runs, a run in which only the upstream commit advanced does what on_commit_only_advance says,
// and dry_run makes every gate run while a commit is a failure and the poll state is never written. Every case is the rendered workflow executed in bash on local checkouts.
import assert from "node:assert/strict";
import test from "node:test";
import { git } from "./helpers/fixtures.mjs";
import { createRun } from "./helpers/runtime.mjs";
import { AI, customJobs, edgeOf, globMatches, workflowOf } from "./helpers/workflows.mjs";

const HEX = "0123456789abcdef0123456789abcdef01234567";
const LAB = AI[0];
const changedFiles = (run) => git(run.portfolio, ["diff", "--name-only", "--no-renames", run.baseSha, "HEAD"]).stdout.split("\n").filter(Boolean).sort();
const allowedBy = (spec, file) => edgeOf(spec).allowedFiles.some((pattern) => globMatches(pattern, file));

// ---- AC24: the validation step ---------------------------------------------------------------------------------------------------------------------------------

const REFUSED = [
  ["sync_scope outside the five-value enum", LAB, { sync_scope: "everything" }, /sync_scope/],
  ["sync_scope that is empty", LAB, { sync_scope: "" }, /sync_scope/],
  ["a showcase scope sent to the copilot-lab workflow", LAB, { sync_scope: "showcase-runs" }, /sync_scope/],
  ["a workshop scope sent to the showcase workflow", AI[1], { sync_scope: "both" }, /sync_scope/],
  ["a workshop scope sent to the github-intermediate workflow", AI[2], { sync_scope: "workshop-only" }, /sync_scope/],
  ["on_commit_only_advance that is neither noop nor bump-provenance", LAB, { on_commit_only_advance: "merge" }, /on_commit_only_advance/],
  ["on_commit_only_advance that is empty", LAB, { on_commit_only_advance: "" }, /on_commit_only_advance/],
  ["downstream_repo that is not the portfolio", LAB, { downstream_repo: "other-owner/other-repo" }, /downstream_repo/],
  ["upstream_repo that is not the upstream of the workflow", AI[1], { upstream_repo: "ms-mfg-community/day-in-the-life-copilot-lab" }, /upstream_repo/],
  ["upstream_sha that is a short sha", LAB, { upstream_sha: "abc1234" }, /upstream_sha/],
  ["upstream_sha in capitals", LAB, { upstream_sha: HEX.toUpperCase() }, /upstream_sha/],
  ["upstream_sha that is empty", LAB, { upstream_sha: "" }, /upstream_sha/],
  ["previous_sha that is not hexadecimal", LAB, { previous_sha: "z".repeat(40) }, /previous_sha/],
  ["previous_sha that is empty", AI[2], { previous_sha: "" }, /previous_sha/],
  ["dry_run that is yes", LAB, { dry_run: "yes" }, /dry_run/],
  ["dry_run in capitals", LAB, { dry_run: "TRUE" }, /dry_run/],
];

for (const [label, spec, override, message] of REFUSED) {
  test(`AC24: ${label}: the first pre-agent step exits 2 with a diagnostic, no other step runs and the portfolio is untouched`, () => {
    const run = createRun(spec, { inputs: override });
    try {
      const results = run.runPre();
      assert.equal(results.length, 1, "no other pre-agent step ran");
      assert.equal(results[0].status, 2, results[0].stderr);
      assert.match(results[0].stderr, message);
      assert.equal(run.porcelain(), "");
      assert.equal(run.head(), run.baseSha);
      assert.equal(run.hasArtifact("dispatch-inputs.json"), false, "nothing was recorded for the agent");
    } finally {
      run.cleanup();
    }
  });
}

test("AC24: one passing dispatch per workflow, for every scope that the workflow accepts, with both on_commit_only_advance values and the three dry_run values", () => {
  for (const spec of AI) {
    for (const scope of spec.scopes) {
      for (const [advance, dry] of [["noop", ""], ["bump-provenance", "true"], ["noop", "false"]]) {
        const run = createRun(spec, { inputs: { sync_scope: scope, on_commit_only_advance: advance, dry_run: dry } });
        try {
          const results = run.runPre();
          assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0], `${spec.id} ${scope} ${advance} ${JSON.stringify(dry)}: ${JSON.stringify(results.map((result) => result.stderr))}`);
          assert.equal(JSON.parse(run.artifact("dispatch-inputs.json")).dry_run, dry);
        } finally {
          run.cleanup();
        }
      }
    }
  }
});

// ---- AC25: previous_sha..upstream_sha, and a run in which only the commit advanced ------------------------------------------------------------------------------

test("AC25: the workflows compute the cumulative range previous_sha..upstream_sha from the dispatch and never read the poll state", () => {
  const run = createRun(LAB);
  try {
    run.runPre();
    const range = git(run.upstream, ["diff", "--name-status", run.previousSha, run.upstreamSha]).stdout;
    assert.equal(run.artifact("upstream-diff.txt"), range);
    for (const spec of AI) {
      const text = JSON.stringify(workflowOf(spec).frontmatter);
      for (const banned of ["SDLC_SYNC_STATE", "lastMergedUpstreamSha", "openPrTargetSha", "inFlightRunId"]) assert.equal(text.includes(banned), false, `${spec.id}: ${banned}`);
    }
  } finally {
    run.cleanup();
  }
});

test("AC25: noop: when only the upstream commit advanced and the agent has nothing to adapt, the worktree is untouched (AGENT_HEAD_SHA == BASE_SHA) and every post-step passes", () => {
  for (const spec of AI) {
    const run = createRun(spec, { labChanged: false, inputs: { on_commit_only_advance: "noop" } });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
      assert.equal(run.porcelain(), "");
      const post = run.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), `${spec.id}: ${JSON.stringify(post.filter((result) => result.status !== 0))}`);
      assert.equal(run.head(), run.baseSha, `${spec.id}: HEAD unchanged`);
      assert.equal(run.porcelain(), "", `${spec.id}: git status --porcelain prints nothing`);
      assert.equal(run.box.environment().AGENT_HEAD_SHA, run.baseSha, `${spec.id}: AGENT_HEAD_SHA == BASE_SHA`);
    } finally {
      run.cleanup();
    }
  }
});

test("AC25: bump-provenance: the deterministic sequence of the prompt records upstream_sha in the provenance files and changes nothing outside the workflow's allowed-files", () => {
  for (const spec of AI) {
    const run = createRun(spec, { labChanged: false, inputs: { on_commit_only_advance: "bump-provenance" } });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
      const agent = run.agentRuns();
      assert.equal(agent.status, 0, `${spec.id}: ${agent.stdout}${agent.stderr}`);
      assert.notEqual(run.head(), run.baseSha, `${spec.id}: the provenance bump is committed`);
      const files = changedFiles(run);
      assert.ok(files.length > 0, spec.id);
      for (const file of files) assert.ok(allowedBy(spec, file), `${spec.id}: ${file} is outside the allowed files`);
      assert.equal(run.porcelain(), "", `${spec.id}: nothing is left uncommitted`);
      const show = (file) => JSON.parse(git(run.portfolio, ["show", `HEAD:${file}`]).stdout);
      if (spec === LAB) {
        assert.equal(show("experiences/copilot-workshop/provenance.json").commit, run.upstreamSha);
        assert.equal(show("experiences/copilot-workshop/provenance.json").documentCommit, run.upstreamSha);
        assert.equal(show("experiences/copilot-workshop/source-inputs.json").commit, run.upstreamSha);
        assert.equal(show("apps/lab-studio/lab-sources.json")._provenance.commit, run.upstreamSha);
        assert.ok(files.includes("apps/lab-studio/client/src/labs/source.ts"), "the revision pins are bumped too");
        for (const file of files) assert.equal(/\/labs\/lab\d\d\.tsx$/.test(file), false, `${file}: no lesson content is rewritten by a bump`);
      } else {
        const provenance = show(spec.provenanceFile);
        assert.deepEqual(provenance, { repository: spec.upstreamRepo, commit: run.upstreamSha }, spec.id);
        assert.deepEqual(files, [spec.provenanceFile], `${spec.id}: only the provenance file changes in a bump`);
      }
    } finally {
      run.cleanup();
    }
  }
});

// ---- AC28: dry_run ---------------------------------------------------------------------------------------------------------------------------------------------

test("AC28: dry_run true: every gate still runs, a clean tree passes, and a commit that the agent made despite the ban fails post-steps at the dry-run check", () => {
  for (const spec of AI) {
    const clean = createRun(spec, { labChanged: false, inputs: { dry_run: "true" } });
    try {
      assert.deepEqual(clean.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
      const post = clean.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), spec.id);
      assert.ok(post.some((result) => /verify-immutable-gates/.test(result.name)), `${spec.id}: the immutable-gate helper still ran`);
      assert.ok(post.some((result) => /npm run test:browser/.test(result.name)), `${spec.id}: the five checks still ran`);
    } finally {
      clean.cleanup();
    }
    const committed = createRun(spec, { labChanged: false, inputs: { dry_run: "true", on_commit_only_advance: "bump-provenance" } });
    try {
      assert.deepEqual(committed.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
      assert.equal(committed.agentRuns().status, 0, "the agent disobeys and commits");
      const post = committed.runPost();
      const last = post.at(-1);
      assert.equal(last.status, 1, `${spec.id}: ${JSON.stringify(post.map((result) => [result.name, result.status]))}`);
      assert.match(last.name, /a dry run must not leave a commit/);
      assert.match(last.stderr, /dry_run is true but the agent committed/);
      assert.deepEqual(post.slice(0, -1).map((result) => result.status), post.slice(0, -1).map(() => 0), "every gate before it passed");
    } finally {
      committed.cleanup();
    }
    // with dry_run empty or false the same commit is not a failure
    const real = createRun(spec, { labChanged: false, inputs: { dry_run: "false", on_commit_only_advance: "bump-provenance" } });
    try {
      real.runPre();
      assert.equal(real.agentRuns().status, 0);
      const post = real.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), `${spec.id}: ${JSON.stringify(post.filter((result) => result.status !== 0))}`);
    } finally {
      real.cleanup();
    }
  }
});

test("AC28: finalize_poll_state and escalate_failure are guarded by dry_run, and every step that invokes the poll-state script carries the same guard", () => {
  for (const spec of AI) {
    const { finalize_poll_state: finalize, escalate_failure: escalate } = customJobs(spec);
    assert.equal(finalize.if, "success() && inputs.dry_run != 'true'", spec.id);
    assert.equal(escalate.if, "failure() && inputs.dry_run != 'true'", spec.id);
    for (const job of [finalize, escalate]) {
      const steps = job.steps.filter((step) => String(step.run ?? "").includes("update-poll-state.mjs"));
      assert.equal(steps.length, 1, spec.id);
      assert.equal(steps[0].if, "inputs.dry_run != 'true'", spec.id);
    }
  }
});

test("AC28: the prompt forbids git commit and create_pull_request when dry_run is true", () => {
  for (const spec of AI) {
    const { body } = workflowOf(spec);
    assert.match(body, /When the dispatch input `dry_run` is `true`, do not run `git commit` and do not call `create_pull_request`\./, spec.id);
  }
});
