// AC4-AC8, AC10-AC15, AC17, AC55 and AC72 (the compiled half): the frontmatter of the three AI adaptation workflows and the jobs of their compiled lock files.
import assert from "node:assert/strict";
import test from "node:test";
import { REPO_ROOT, abs, fixture, readText } from "./helpers/fixtures.mjs";
import { listFiles } from "../s1/helpers/fixtures.mjs";
import { simulateJobs } from "../s1/helpers/actions-if.mjs";
import { AI, DOWNSTREAM, WORKFLOW_DIR, customJobs, edgeOf, globMatches, lockOf, lockTextOf, parseWorkflow, workflowOf } from "./helpers/workflows.mjs";

const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const handlerOf = (spec) => workflowOf(spec).frontmatter["safe-outputs"]["create-pull-request"];
const fixtureTree = () => listFiles(fixture("portfolio-min"));
const SIBLING_TESTS = ["tests/github-intermediate-labs.test.ts", "tests/github-intermediate-workshop.test.ts", "tests/pipeline-showcase.test.ts"];
const matchesAny = (patterns, file) => patterns.some((pattern) => globMatches(pattern, file));
/** A path that the pattern matches: its wildcards filled with plain names. */
const sampleOf = (pattern) => pattern.replace(/\*\*/g, "a/b/c").replace(/\*/g, "x");

test("AC5: the identities of the three workflows, and the same values in the frontmatter, the safe output and the prompt", () => {
  for (const spec of AI) {
    const { frontmatter, body } = workflowOf(spec);
    assert.equal(frontmatter.concurrency.group, spec.group, spec.id);
    assert.equal(handlerOf(spec)["close-older-key"], spec.closeOlderKey, spec.id);
    assert.ok(body.includes(spec.branchName), `${spec.id}: the prompt names the branch`);
    assert.ok(frontmatter["pre-agent-steps"][1].run.includes(`echo "BRANCH_NAME=${spec.branchName}"`), `${spec.id}: BRANCH_NAME is exported`);
    assert.equal(edgeOf(spec).upstreamKey, spec.upstreamKey);
  }
});

test("AC5: the allowed-files lists of the three workflows are pairwise disjoint, and only the showcase workflow writes the showcase surfaces", () => {
  const lists = Object.fromEntries(AI.map((spec) => [spec.id, handlerOf(spec)["allowed-files"]]));
  const universe = [...fixtureTree()];
  for (const patterns of Object.values(lists)) universe.push(...patterns.map(sampleOf));
  for (const file of universe) {
    const writers = AI.filter((spec) => matchesAny(lists[spec.id], file)).map((spec) => spec.id);
    assert.ok(writers.length <= 1, `${file} is matched by ${writers.join(" and ")}`);
  }
  const [lab, showcase, intermediate] = AI.map((spec) => lists[spec.id]);
  for (const [name, patterns, others] of [["lab", lab, [showcase, intermediate]], ["showcase", showcase, [lab, intermediate]], ["intermediate", intermediate, [lab, showcase]]]) {
    for (const pattern of patterns) for (const other of others) assert.equal(matchesAny(other, sampleOf(pattern)), false, `${name}: ${pattern}`);
  }
  const surfaces = [
    "experiences/pipeline-showcase/content/run-data.json",
    "experiences/pipeline-showcase/capture/fetch-run-data.mjs",
    "experiences/pipeline-showcase/content/provenance.json",
    "public/pipeline-showcase/index.html",
    "tests/pipeline-showcase.test.ts",
  ];
  for (const name of listFiles(REPO_ROOT, WORKFLOW_DIR).filter((file) => file.endsWith(".md"))) {
    const { frontmatter } = parseWorkflow(readText(abs(name)));
    const allowed = frontmatter["safe-outputs"]?.["create-pull-request"]?.["allowed-files"] ?? [];
    const isShowcase = name.endsWith("cascade-ai-pipeline-showcase.md");
    for (const surface of surfaces) assert.equal(matchesAny(allowed, surface), isShowcase, `${name} and ${surface}`);
  }
});

test("AC6: workflow_dispatch with an inputs object, and on.bots holding the App slug followed by [bot]", () => {
  for (const spec of AI) {
    const { on } = workflowOf(spec).frontmatter;
    assert.deepEqual(Object.keys(on).sort(), ["bots", "workflow_dispatch"], spec.id);
    assert.equal(typeof on.workflow_dispatch.inputs, "object", spec.id);
    assert.equal(on.bots.length, 1, spec.id);
    assert.match(on.bots[0], /^[a-z0-9-]+\[bot\]$/, spec.id);
    assert.ok(readText(abs(WORKFLOW_DIR, `${spec.id}.md`)).includes("bots:"), spec.id);
  }
});

test("AC7: the workflow-level concurrency group is sdlc-state-<upstreamKey> and never cancels", () => {
  for (const spec of AI) {
    const { concurrency } = workflowOf(spec).frontmatter;
    assert.deepEqual(concurrency, { group: `sdlc-state-${spec.upstreamKey}`, "cancel-in-progress": false }, spec.id);
    assert.equal(concurrency["cancel-in-progress"], false);
  }
});

test("AC8: two checkouts, the downstream as the current repository and the upstream at upstream/<repo-name> with App credentials, each token scoped to its own repository, and full history", () => {
  for (const spec of AI) {
    const { checkout } = workflowOf(spec).frontmatter;
    assert.deepEqual(checkout, [
      { repository: DOWNSTREAM, path: "portfolio", current: true, "github-app": { ...APP, repositories: ["portfolio"] } },
      { repository: spec.upstreamRepo, path: `upstream/${spec.repo}`, ref: "${{ inputs.upstream_sha }}", "fetch-depth": 0, "github-app": { ...APP, repositories: [spec.repo] } },
    ], spec.id);
  }
});

test("AC10/AC11: the pull-request handler carries the thirteen keys of the spec (and the three of the baseline), with auto-merge false", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    const handler = handlerOf(spec);
    const thirteen = {
      "title-prefix": "feat(cascade): ",
      labels: ["automated", "sdlc-cascade", "ai-adapted", "needs-review"],
      reviewers: edge.reviewers,
      draft: false,
      "preserve-branch-name": true,
      "recreate-ref": true,
      "close-older-pull-requests": true,
      "close-older-key": spec.closeOlderKey,
      "if-no-changes": "ignore",
      "auto-merge": false,
      "fallback-as-issue": false,
      max: 1,
      "allowed-files": edge.allowedFiles,
    };
    const { "target-repo": target, "exclude-lock-yml": excludeLock, "protected-files": protectedFiles, ...rest } = handler;
    assert.deepEqual(rest, thirteen, spec.id);
    assert.equal(target, DOWNSTREAM, spec.id);
    assert.equal(excludeLock, true, spec.id);
    assert.equal(protectedFiles.policy, "blocked", spec.id);
    assert.ok(handler.reviewers.length > 0, spec.id);
    assert.equal(handler["auto-merge"], false);
  }
});

test("AC11: no workflow or helper merges a pull request or enables auto-merge", () => {
  const files = [
    ...AI.map((spec) => abs(WORKFLOW_DIR, `${spec.id}.md`)),
    abs("src", "lab-studio-drift.mjs"),
    abs("src", "bump-studio-revision-pins.mjs"),
    abs("src", "verify-immutable-gates.mjs"),
  ];
  for (const file of files) {
    const text = readText(file);
    for (const banned of ["gh pr merge", "auto-merge: true", "--auto"]) assert.equal(text.includes(banned), false, `${file}: ${banned}`);
  }
});

test("AC12-AC14: the allowed-files of each workflow are exactly the edge's lists; a locked rules module, a built bundle of another experience and a vite config are refused", () => {
  const refused = {
    "cascade-ai-copilot-lab": ["experiences/copilot-workshop/content/rules.ts", "src/server.ts", "tests/pipeline-showcase.test.ts"],
    "cascade-ai-pipeline-showcase": ["public/workshop/source.json", "experiences/pipeline-showcase/src/chapters.ts"],
    "cascade-ai-github-intermediate": ["experiences/github-intermediate-labs/vite.config.ts", "experiences/github-intermediate-workshop/src/app.ts"],
  };
  for (const spec of AI) {
    const allowed = handlerOf(spec)["allowed-files"];
    assert.deepEqual([...allowed].sort(), [...edgeOf(spec).allowedFiles].sort(), spec.id);
    for (const file of refused[spec.id]) assert.equal(matchesAny(allowed, file), false, `${spec.id} refuses ${file}`);
  }
  assert.equal(handlerOf(AI[0])["allowed-files"].length, 20);
  assert.equal(handlerOf(AI[1])["allowed-files"].length, 5);
  assert.equal(handlerOf(AI[2])["allowed-files"].length, 6);
});

test("AC15: no allowed-files entry of any workflow matches a locked path, a file inside a locked directory, or the companion test file of another workflow", () => {
  const tree = fixtureTree();
  for (const spec of AI) {
    const edge = edgeOf(spec);
    const expanded = new Set(SIBLING_TESTS.filter((file) => !edge.immutableGates.lockedTestBlocks.some((block) => block.file === file)));
    for (const locked of edge.immutableGates.zeroDiffPaths) {
      expanded.add(locked);
      for (const file of tree) if (file === locked || file.startsWith(`${locked}/`)) expanded.add(file);
    }
    assert.ok(expanded.size > 17, `${spec.id}: the expansion found files inside the locked directories`);
    for (const file of expanded) assert.equal(matchesAny(handlerOf(spec)["allowed-files"], file), false, `${spec.id} allows ${file}`);
  }
});

test("AC17: the custom jobs, in the source and in the compiled lock: finalize_poll_state and escalate_failure only, with the guards, needs, permissions and first three steps of the spec", () => {
  for (const spec of AI) {
    for (const [label, jobs] of [["source", customJobs(spec)], ["lock", lockOf(spec).jobs]]) {
      const { finalize_poll_state: finalize, escalate_failure: escalate } = jobs;
      // the compiler wraps the condition of a job that follows detection in the detection results; the authored condition stays inside it
      assert.ok(String(finalize.if).includes("success() && inputs.dry_run != 'true'"), `${spec.id} ${label}: ${finalize.if}`);
      assert.ok(String(escalate.if).includes("failure() && inputs.dry_run != 'true'"), `${spec.id} ${label}: ${escalate.if}`);
      if (label === "source") {
        assert.equal(finalize.if, "success() && inputs.dry_run != 'true'", spec.id);
        assert.equal(escalate.if, "failure() && inputs.dry_run != 'true'", spec.id);
      }
      for (const job of [finalize, escalate]) {
        assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"], `${spec.id} ${label}`);
        assert.deepEqual(job.permissions, { issues: "write" }, `${spec.id} ${label}`);
        assert.equal("concurrency" in job, false, `${spec.id} ${label}: no job-level concurrency`);
      }
      assert.equal(finalize.steps.some((step) => String(step.run ?? "").includes("update-poll-state.mjs")), true);
    }
    const { finalize_poll_state: finalize, escalate_failure: escalate } = customJobs(spec);
    assert.deepEqual(Object.keys(customJobs(spec)).sort(), ["escalate_failure", "finalize_poll_state"], spec.id);
    for (const job of [finalize, escalate]) {
      const [mint, checkout, install] = job.steps;
      assert.equal(mint.id, "app_token");
      assert.equal(mint.uses, "actions/create-github-app-token@v2");
      assert.deepEqual(mint.with, {
        "app-id": "${{ vars.APP_CLIENT_ID }}",
        "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }},portfolio",
        "permission-contents": "read",
        "permission-pull-requests": "read",
        "permission-actions-variables": "write",
      });
      assert.equal(checkout.uses, "actions/checkout@v4");
      assert.equal(checkout.with["persist-credentials"], false);
      assert.deepEqual(install, { run: "npm ci --ignore-scripts" });
    }
  }
});

test("AC17/AC72: in the compiled lock detection and safe_outputs need the agent job and run only after it succeeded, so a failing post-steps gate stops them and the escalation job still runs", () => {
  const results = (agent) => ({ agent, detection: "success", safe_outputs: "success" });
  const outputs = { detection: { detection_success: "true" } };
  for (const spec of AI) {
    const { jobs } = lockOf(spec);
    for (const name of ["detection", "safe_outputs"]) {
      assert.ok([jobs[name].needs].flat().includes("agent"), `${spec.id}.${name} needs agent`);
      assert.ok(String(jobs[name].if).includes("needs.agent.result == 'success'"), `${spec.id}.${name}: ${jobs[name].if}`);
    }
    for (const failed of ["failure", "cancelled"]) {
      const run = simulateJobs(jobs, { results: results(failed), outputs, inputs: { dry_run: "false" } });
      assert.equal(run.ran.includes("detection"), false, `${spec.id}: detection after an agent that ${failed}`);
      assert.equal(run.ran.includes("safe_outputs"), false, `${spec.id}: safe_outputs after an agent that ${failed}`);
      assert.equal(run.ran.includes("finalize_poll_state"), false, spec.id);
      if (failed === "failure") assert.equal(run.ran.includes("escalate_failure"), true, `${spec.id}: the failure is escalated`);
    }
    const passed = simulateJobs(jobs, { results: results("success"), outputs, inputs: { dry_run: "false" } });
    for (const name of ["detection", "safe_outputs", "finalize_poll_state"]) assert.ok(passed.ran.includes(name), `${spec.id}: ${name} runs after success`);
    assert.equal(passed.ran.includes("escalate_failure"), false, spec.id);
    const dry = simulateJobs(jobs, { results: results("success"), outputs, inputs: { dry_run: "true" } });
    assert.equal(dry.ran.includes("finalize_poll_state"), false, `${spec.id}: a dry run finalizes nothing`);
    assert.equal(simulateJobs(jobs, { results: results("failure"), outputs, inputs: { dry_run: "true" } }).ran.includes("escalate_failure"), false, `${spec.id}: a dry run escalates nothing`);
  }
});

test("AC4: the compiled workflows hold the generated jobs and the two custom ones (the v1.0.1 compiler folds pre_activation into activation), and each lock names its compiler", () => {
  for (const spec of AI) {
    const { jobs } = lockOf(spec);
    for (const name of ["activation", "agent", "detection", "safe_outputs", "finalize_poll_state", "escalate_failure"]) {
      assert.ok(name in jobs, `${spec.id} has ${name}`);
    }
    assert.match(lockTextOf(spec), /^# gh-aw-metadata: .*"compiler_version":"v1\.\d+\.\d+".*"strict":true/m, spec.id);
  }
});

test("AC55: Node.js 24, the two npm ci --include=dev installs in order, the Edge installation before the checks, every npm run in the portfolio directory, fallback-as-issue false", () => {
  for (const spec of AI) {
    const { steps, "post-steps": post } = workflowOf(spec).frontmatter;
    assert.equal(steps[0].uses, "actions/setup-node@v4");
    assert.equal(steps[0].with["node-version"], "24");
    assert.deepEqual([steps[1].run, steps[1]["working-directory"]], ["npm ci --include=dev", "portfolio"]);
    assert.deepEqual([steps[2].run, steps[2]["working-directory"]], ["npm ci --include=dev", "portfolio/apps/lab-studio"]);
    assert.match(steps[3].run, /playwright install --with-deps msedge/);
    assert.equal(steps.length, 4);
    for (const step of post.filter((candidate) => typeof candidate.run === "string" && /^(?:STUDIO_ORIGIN=\S+ )?npm /.test(candidate.run))) {
      assert.equal(step["working-directory"], "portfolio", `${spec.id}: ${step.run}`);
    }
    assert.equal(handlerOf(spec)["fallback-as-issue"], false);
  }
});

test("AC23: the ten dispatch inputs of every workflow are strings, with sync_scope among them", () => {
  for (const spec of AI) {
    const { inputs } = workflowOf(spec).frontmatter.on.workflow_dispatch;
    assert.equal(Object.keys(inputs).length, 10, spec.id);
    for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", `${spec.id}.${name}`);
    assert.ok("sync_scope" in inputs, spec.id);
  }
});
