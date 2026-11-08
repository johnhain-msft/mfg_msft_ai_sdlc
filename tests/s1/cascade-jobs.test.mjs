// AC35, AC36, AC38 and AC49 (jobs half): the finalize_poll_state and escalate_failure custom jobs.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, customJobsOf, edgeOf, listFiles, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest, REPO_ROOT } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const CASCADE = ["cascade-mechanical-ghec-admin", "cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate"];
const AI = CASCADE.filter((name) => name.startsWith("cascade-ai-"));
const DRIFT = ["drift-gh-admin-msft", "drift-copilot-lab", "drift-self-improving-agents"];
const NEEDS = ["agent", "detection", "safe_outputs"];
const TOKEN = "${{ steps.app_token.outputs.token }}";
const SEVEN_FLAGS = ["--slug", "--branch", "--provenance-file", "--base-sha", "--head-sha", "--target-sha", "--etag"];

const edgeOfWorkflow = (id) => edgeOf(preset, id.replace(/^cascade-(mechanical|ai)-/, ""));
const jobs = (id) => customJobsOf(readWorkflow(`${id}.md`).frontmatter.jobs);
const updateStep = (job) => job.steps.find((step) => String(step.run ?? "").includes("update-poll-state.mjs"));

test("AC35: every cascade workflow has exactly finalize_poll_state and escalate_failure with the specified guards, needs and permissions", () => {
  for (const id of CASCADE) {
    const { finalize_poll_state: finalize, escalate_failure: escalate, ...rest } = jobs(id);
    assert.deepEqual(rest, {}, `${id}: no other custom job`);
    assert.equal(finalize.if, "success() && inputs.dry_run != 'true'", id);
    assert.equal(escalate.if, "failure() && inputs.dry_run != 'true'", id);
    for (const job of [finalize, escalate]) {
      assert.deepEqual(job.needs, NEEDS, id);
      assert.deepEqual(job.permissions, { issues: "write" }, id);
      assert.equal("concurrency" in job, false, `${id}: no job-level concurrency`);
    }
  }
});

test("AC35: in both jobs the first step mints the App token, the second checks out src and schemas, the third installs", () => {
  for (const id of CASCADE) {
    for (const [name, job] of Object.entries(jobs(id))) {
      const [mint, checkout, install] = job.steps;
      assert.equal(mint.id, "app_token", `${id}.${name}`);
      assert.equal(mint.uses, "actions/create-github-app-token@v2");
      assert.deepEqual(mint.with, {
        "app-id": "${{ vars.APP_CLIENT_ID }}",
        "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }},portfolio",
        "permission-contents": "read",
        "permission-pull-requests": "read",
        "permission-variables": "write",
      });
      assert.equal(checkout.uses, "actions/checkout@v4");
      assert.deepEqual(checkout.with, { token: TOKEN, "sparse-checkout": "src\nschemas", "persist-credentials": false });
      assert.deepEqual(install, { run: "npm ci --ignore-scripts" });
    }
  }
});

test("AC35: the repositories list names the orchestrator through the Actions context and the downstream repository by name", () => {
  const workspace = createWorkspace({ manifestText: readText(abs("tests", "s1", "fixtures", "manifest.minimal.yaml")) });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const { frontmatter } = parseWorkflow(result.files.get(`${W}/cascade-mechanical-alpha-to-beta.md`));
    for (const job of Object.values(customJobsOf(frontmatter.jobs))) {
      assert.equal(job.steps[0].with.owner, "${{ github.repository_owner }}");
      assert.equal(job.steps[0].with.repositories, "${{ github.event.repository.name }},beta-docs");
    }
    const text = result.files.get(`${W}/cascade-mechanical-alpha-to-beta.md`);
    assert.equal(/mfg_msft_ai_sdlc/.test(text), false, "the orchestrator repository is never named");
  } finally {
    workspace.cleanup();
  }
});

test("AC35: every downstreamRepo shares the owner of the App token: owner is always the Actions context owner", () => {
  for (const id of CASCADE) {
    for (const job of Object.values(jobs(id))) assert.equal(job.steps[0].with.owner, "${{ github.repository_owner }}");
  }
  for (const edge of preset.dependencyEdges) assert.equal(edge.downstreamRepo.split("/")[0], "johnhain-msft", "the preset's downstreams share one owner");
});

test("AC35: every drift workflow has exactly one custom job, escalate_failure, with its own guard, permissions, checkout and install steps", () => {
  for (const id of DRIFT) {
    const custom = jobs(id);
    assert.deepEqual(Object.keys(custom), ["escalate_failure"], id);
    const job = custom.escalate_failure;
    assert.equal(job.if, "failure() && inputs.dry_run != true", id);
    assert.deepEqual(job.needs, NEEDS);
    assert.deepEqual(job.permissions, { actions: "read", contents: "read", issues: "write" });
    assert.equal("concurrency" in job, false);
    assert.deepEqual(job.steps[0], { uses: "actions/checkout@v4", with: { "sparse-checkout": "src\nschemas", "persist-credentials": false } });
    assert.deepEqual(job.steps[1], { run: "npm ci --ignore-scripts" });
    assert.equal(job.steps.some((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token")), false, "a drift workflow mints no App token");
    assert.equal(JSON.stringify(custom).includes("finalize_poll_state"), false);
    assert.equal(JSON.stringify(custom).includes("success()"), false, "no job guarded by if: success()");
    assert.equal(JSON.stringify(custom).includes("update-poll-state.mjs"), false, "a drift workflow never invokes S3's script");
  }
});

test("AC36: finalize_poll_state is app_token, checkout, install, artifact download, the SHA export and then the update step", () => {
  for (const id of CASCADE) {
    const job = jobs(id).finalize_poll_state;
    const { steps } = job;
    assert.equal(steps[3].uses, "actions/download-artifact@v4", id);
    assert.deepEqual(steps[3].with, { name: "sdlc-cascade-shas-${{ github.run_id }}", path: "/tmp/gh-aw" });
    assert.ok(steps[4].run.includes("BASE_SHA") && steps[4].run.includes("AGENT_HEAD_SHA") && steps[4].run.includes('>> "$GITHUB_ENV"'), `${id}: appends both revisions to GITHUB_ENV`);
    assert.ok(steps[4].run.includes("/tmp/gh-aw/cascade-shas.json"));
    assert.equal(steps.indexOf(updateStep(job)), 5, `${id}: the script step follows the export`);
    assert.equal(steps.length, 6);
  }
});

test("AC36: the update step carries if, GH_TOKEN, ISSUES_TOKEN and the revisions, and runs the seven flags of S3's script", () => {
  for (const id of CASCADE) {
    const step = updateStep(jobs(id).finalize_poll_state);
    assert.equal(step.if, "inputs.dry_run != 'true'", id);
    assert.equal(step.env.GH_TOKEN, TOKEN, id);
    assert.equal(step.env.ISSUES_TOKEN, "${{ secrets.GITHUB_TOKEN }}", id);
    assert.equal(step.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}", id);
    assert.equal(step.env.UPSTREAM_ETAG, "${{ inputs.upstream_etag }}", id);
    assert.equal(step.env.CORRELATION_ID, "${{ inputs.correlation_id }}", `${id}: the failure issue of the script names the id of the routed event (SPEC-03 AC52)`);
    assert.ok(step.run.startsWith('node "$GITHUB_WORKSPACE/src/update-poll-state.mjs"'), id);
    for (const flag of SEVEN_FLAGS) assert.ok(step.run.includes(flag), `${id}: ${flag}`);
    assert.ok(step.run.includes('--base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"'), id);
    assert.equal(step.run.includes("--record-failure"), false, `${id}: finalize_poll_state has no --record-failure`);
  }
});

test("AC36: the mechanical workflow passes slug, branch and provenance file as literals", () => {
  const step = updateStep(jobs("cascade-mechanical-ghec-admin").finalize_poll_state);
  assert.ok(step.run.includes("--slug GH_ADMIN_MSFT --branch sdlc/cascade-ghec-admin --provenance-file public/ghec-admin/source.json"));
  assert.equal("REPO_SLUG" in step.env, false);
});

test("AC36: the AI workflows pass them through REPO_SLUG, BRANCH_NAME and PROVENANCE_FILE", () => {
  for (const id of AI) {
    const edge = edgeOfWorkflow(id);
    const step = updateStep(jobs(id).finalize_poll_state);
    assert.equal(step.env.REPO_SLUG, edge.upstreamSlug, id);
    assert.equal(step.env.BRANCH_NAME, edge.branchName, id);
    assert.equal(step.env.PROVENANCE_FILE, edge.provenanceFile, id);
    assert.ok(step.run.includes('--slug "$REPO_SLUG" --branch "$BRANCH_NAME" --provenance-file "$PROVENANCE_FILE"'), id);
  }
  assert.equal(updateStep(jobs("cascade-ai-copilot-lab").finalize_poll_state).env.PROVENANCE_FILE, "experiences/copilot-workshop/source-inputs.json");
});

test("AC36: escalate_failure passes --record-failure, the slug, --target-sha and its own workflow id", () => {
  for (const id of CASCADE) {
    const edge = edgeOfWorkflow(id);
    const job = jobs(id).escalate_failure;
    const { steps } = job;
    assert.equal(steps.length, 4, id);
    const step = updateStep(job);
    assert.equal(step, steps[3], `${id}: the script step follows app_token, checkout and install`);
    assert.equal(step.if, "inputs.dry_run != 'true'");
    assert.equal(step.env.GH_TOKEN, TOKEN);
    assert.equal(step.env.ISSUES_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    assert.equal(step.env.CORRELATION_ID, "${{ inputs.correlation_id }}", `${id}: the failure issue of the script names the id of the routed event (SPEC-03 AC52)`);
    assert.ok(step.run.includes("--record-failure"), id);
    assert.ok(step.run.includes(edge.mode === "mechanical" ? edge.upstreamSlug : '"$REPO_SLUG"'), `${id}: the slug`);
    assert.ok(step.run.includes('--target-sha "$UPSTREAM_SHA"'), id);
    assert.ok(step.run.includes(`--workflow-id ${id}`), `${id}: the workflow id`);
    assert.equal(step.run.includes("--base-sha"), false);
  }
  assert.ok(readText(abs(W, "cascade-mechanical-ghec-admin.md")).includes("--record-failure"));
});

test("AC36: the resolved edge values are not passed to S3 (stateVariable, downstreamRepo, provenanceJsonPointer)", () => {
  for (const id of CASCADE) {
    const text = JSON.stringify(jobs(id));
    assert.equal(text.includes("SDLC_SYNC_STATE_"), false, `${id}: the state variable name is resolved by S3 from --slug`);
    assert.equal(text.includes("provenanceJsonPointer"), false);
    assert.equal(text.includes("--downstream"), false);
  }
});

test("AC36: the drift escalate_failure runs the S2 script and never S3's", () => {
  for (const id of DRIFT) {
    const job = jobs(id).escalate_failure;
    const step = job.steps.find((candidate) => String(candidate.run ?? "").includes("src/drift/escalate-gate-failure.mjs"));
    assert.ok(step, id);
    assert.ok(job.steps.indexOf(step) > 1, "after the checkout and the install step");
    assert.equal(job.steps.some((candidate) => String(candidate.run ?? "").includes("update-poll-state.mjs")), false);
  }
});

test("AC38: no generated workflow writes a variable, secret or state: the AC38 write scan over fresh and committed files", () => {
  const generated = renderFleet(request);
  const files = [...generated.files].filter(([name]) => name.endsWith(".md") || name.endsWith(".yml")).map(([name, text]) => [name, text]);
  for (const name of listFiles(REPO_ROOT, W).filter((file) => /cascade-.*\.md$|cascade-router\.yml$/.test(file))) files.push([name, readText(abs(name))]);
  assert.ok(files.length >= 8);
  for (const [name, text] of files) {
    assert.equal(/gh variable|gh secret/.test(text), false, `${name}: gh variable / gh secret`);
    if (/cascade-/.test(name)) assert.equal(/actions\/variables/.test(text), false, `${name}: actions/variables`);
    assert.equal(/gh api[^\n]*(-X|--method)\s+(PATCH|POST|PUT|DELETE)/i.test(text), false, `${name}: a non-GET gh api call`);
  }
});

test("AC49: the three AI workflows invoke update-poll-state.mjs in both jobs, with GH_TOKEN and ISSUES_TOKEN", () => {
  for (const id of AI) {
    const text = readText(abs(W, `${id}.md`));
    assert.ok(text.includes("update-poll-state.mjs"), id);
    for (const job of Object.values(jobs(id))) {
      const step = updateStep(job);
      assert.ok(step.env.GH_TOKEN && step.env.ISSUES_TOKEN, id);
    }
  }
});

test("AC49: the AI workflows write no SDLC_SYNC_STATE variable outside the two jobs", () => {
  for (const id of AI) {
    const { frontmatter, body } = readWorkflow(`${id}.md`);
    const { jobs: customJobs, ...outside } = frontmatter;
    assert.equal(JSON.stringify(outside).includes("update-poll-state"), false, id);
    assert.equal(JSON.stringify(outside).includes("SDLC_SYNC_STATE"), false, id);
    assert.equal(body.includes("SDLC_SYNC_STATE"), false, id);
    assert.ok(JSON.stringify(customJobs).includes("update-poll-state.mjs"));
  }
});

test("AC35: the escalate_failure jobs opt out of the compiler's detection gate so they run after a failed agent", () => {
  for (const id of [...CASCADE, ...DRIFT]) assert.equal(jobs(id).escalate_failure["detection-gate"], "status-only", id);
  for (const id of CASCADE) assert.equal("detection-gate" in jobs(id).finalize_poll_state, false, `${id}: finalize stays behind detection`);
});
