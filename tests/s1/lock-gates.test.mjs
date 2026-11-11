// AC29: the compiled lock files keep safe_outputs behind detection and behind a successful agent job, and nothing S1
// renders overrides that.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { evaluateExpression, simulateJobs } from "./helpers/actions-if.mjs";
import { abs, AGENT_SUCCESS_GUARD, BUILT_IN_JOB_SECTIONS, fixture, listFiles, mutate, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest, REPO_ROOT, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const ids = [
  "drift-gh-admin-msft", "drift-copilot-lab", "drift-self-improving-agents",
  "cascade-mechanical-ghec-admin", "cascade-mechanical-ai-sdlc", "cascade-mechanical-copilot-config",
  "cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate", "sdlc-onboard",
];
const lockOf = (id) => YAML.parse(readText(abs(W, `${id}.lock.yml`)));
const conditionOf = (job) => String(job.if).replace(/\s+/g, " ").trim();

/** Which jobs of a compiled lock run when the agent, detection and safe_outputs jobs end with the given results. */
function simulateGates(id, lock, { agent = "success", detection = "success", safe_outputs: safeOutputs = "success", dryRun = false }) {
  return simulateJobs(lock.jobs, {
    results: { agent, detection, safe_outputs: safeOutputs },
    outputs: { detection: { detection_success: detection === "success" ? "true" : "false" } },
    inputs: { dry_run: id.startsWith("drift-") ? dryRun : String(dryRun) },
  });
}

test("AC29: in every committed lock the safe_outputs job lists detection in needs and only runs after detection succeeded", () => {
  for (const id of ids) {
    const { safe_outputs: job } = lockOf(id).jobs;
    assert.ok(job, `${id} has a safe_outputs job`);
    assert.ok(Array.isArray(job.needs) && job.needs.includes("detection"), `${id}: needs ${JSON.stringify(job.needs)}`);
    // The form that the pinned compiler (gh-aw v1.0.1) emits; the documented needs.detection.outputs.success form is not
    // an output of its detection job, which publishes detection_success (see section 4 of the spec).
    assert.ok(conditionOf(job).includes("needs.detection.result == 'success'"), `${id}: if ${conditionOf(job)}`);
  }
});

test("AC29: the criterion in the spec names the condition forms that the committed locks carry, so the test needs no either-or", () => {
  const row = readText(abs("specs", "01-manifest-and-reconciler.md")).split("\n").find((line) => line.startsWith("| AC29 |"));
  assert.ok(row, "the spec has the AC29 row");
  assert.ok(row.includes("needs.detection.result == 'success'"), "the observation names the result form that gh-aw v1.0.1 emits");
  assert.ok(row.includes("needs.agent.result == 'success'"), "the observation names the agent-success guard");
  assert.equal(row.includes("needs.detection.outputs.success == 'true'"), false, "the form that no compiled lock contains is not the observation");
  for (const id of ids) assert.equal(readText(abs(W, `${id}.lock.yml`)).includes("needs.detection.outputs.success == 'true'"), false, id);
});

test("AC29: in every committed lock detection and safe_outputs also require the agent job to have succeeded", () => {
  for (const id of ids) {
    const { detection, safe_outputs: safeOutputs } = lockOf(id).jobs;
    for (const job of [detection, safeOutputs]) {
      assert.ok(job.needs.includes("agent"), `${id}: needs ${JSON.stringify(job.needs)}`);
      assert.ok(conditionOf(job).includes(AGENT_SUCCESS_GUARD), `${id}: if ${conditionOf(job)}`);
    }
    if (id.startsWith("drift-")) {
      assert.ok(conditionOf(safeOutputs).includes("inputs.dry_run != true"), `${id}: safe_outputs also guards on inputs.dry_run`);
    }
  }
});

test("AC29: a failed agent job — a failing post-steps gate runs inside it — stops detection and safe_outputs and still escalates", () => {
  for (const id of ids) {
    const lock = lockOf(id);
    for (const result of ["failure", "cancelled"]) {
      const run = simulateGates(id, lock, { agent: result });
      assert.equal(run.ran.includes("detection"), false, `${id}: detection after an agent that ${result}`);
      assert.equal(run.ran.includes("safe_outputs"), false, `${id}: safe_outputs after an agent that ${result}`);
      assert.equal(run.ran.includes("finalize_poll_state"), false, `${id}: the poll state is not finalized`);
      assert.ok(run.ran.includes("conclusion"), `${id}: the conclusion job still reports`);
    }
    if ("escalate_failure" in lock.jobs) assert.ok(simulateGates(id, lock, { agent: "failure" }).ran.includes("escalate_failure"), `${id}: the failure is still recorded`);
  }
});

test("AC29: a successful agent job and a passed detection still let safe_outputs run, and a failed detection still stops it", () => {
  for (const id of ids) {
    const lock = lockOf(id);
    const passed = simulateGates(id, lock, {});
    assert.ok(passed.ran.includes("detection") && passed.ran.includes("safe_outputs"), `${id}: ${passed.ran}`);
    assert.equal(passed.ran.includes("escalate_failure"), false, `${id}: nothing failed`);
    if ("finalize_poll_state" in lock.jobs) assert.ok(passed.ran.includes("finalize_poll_state"), `${id}: the poll state is finalized`);
    const flagged = simulateGates(id, lock, { detection: "failure" });
    assert.ok(flagged.ran.includes("detection"), id);
    assert.equal(flagged.ran.includes("safe_outputs"), false, `${id}: safe_outputs after a failed detection`);
    if ("escalate_failure" in lock.jobs) assert.ok(flagged.ran.includes("escalate_failure"), id);
  }
});

test("AC29: the conditions gh-aw compiled without the guard ran detection and safe_outputs after a failed agent job (the defect)", () => {
  const jobs = {
    activation: {},
    agent: { needs: "activation" },
    detection: { needs: ["activation", "agent"], if: "always() && needs.agent.result != 'skipped'" },
    safe_outputs: {
      needs: ["activation", "agent", "detection"],
      if: "(!cancelled()) && needs.agent.result != 'skipped' && needs.detection.result == 'success'",
    },
  };
  const run = simulateJobs(jobs, { results: { agent: "failure" } });
  assert.deepEqual(run.ran, ["activation", "agent", "detection", "safe_outputs"]);
  const guarded = structuredClone(jobs);
  guarded.detection.if = `(${guarded.detection.if}) && (${AGENT_SUCCESS_GUARD})`;
  guarded.safe_outputs.if = `(${guarded.safe_outputs.if}) && (${AGENT_SUCCESS_GUARD})`;
  assert.deepEqual(simulateJobs(guarded, { results: { agent: "failure" } }).ran, ["activation", "agent"]);
});

test("AC29: the condition evaluator follows the Actions expression semantics that the compiled conditions rely on", () => {
  const holds = (text, options) => evaluateExpression(text, options);
  assert.equal(holds("'Success' == 'success'"), true, "strings compare case-insensitively");
  assert.equal(holds("true == 1"), true, "operands of different types compare as numbers");
  assert.equal(holds("needs.a.outputs.missing != 'true'", { context: { needs: { a: { outputs: {} } } } }), true);
  assert.equal(holds("needs.a.result == 'success'", { context: { needs: { a: { result: "failure" } } } }), false);
  assert.equal(holds("true || false && false"), true, "&& binds tighter than ||");
  assert.equal(holds("(true || false) && false"), false);
  assert.equal(holds("!cancelled() && failure()", { failure: true }), true);
  assert.equal(holds("${{ success() && inputs.dry_run != 'true' }}", { context: { inputs: { dry_run: "false" } } }), true);
  assert.equal(holds("contains(needs.agent.outputs.output_types, 'create_pull_request')", { context: { needs: { agent: { outputs: { output_types: "noop,create_pull_request" } } } } }), true);
});

const DRIFT_SAFE_OUTPUTS_GUARD = `${AGENT_SUCCESS_GUARD} && inputs.dry_run != true`;
const DRIFT_CONCLUSION_GUARD = "inputs.dry_run != true";
const isDrift = (name) => name.split("/").pop().startsWith("drift-");
const expectedSafeOutputsGuard = (name) => (isDrift(name) ? DRIFT_SAFE_OUTPUTS_GUARD : AGENT_SUCCESS_GUARD);

test("AC29: detection and safe_outputs are rendered as the agent-success guard alone (with dry_run on drift safe_outputs): nothing widens when they run", () => {
  for (const id of ids) {
    const { jobs } = readWorkflow(`${id}.md`).frontmatter;
    assert.deepEqual(jobs.detection, { if: AGENT_SUCCESS_GUARD }, `${id}.detection`);
    assert.deepEqual(jobs.safe_outputs, { if: expectedSafeOutputsGuard(`${id}.md`) }, `${id}.safe_outputs`);
  }
  for (const [name, text] of renderFleet(request).files) {
    if (name.endsWith(".md")) assert.ok(text.includes(`  safe_outputs:\n    if: ${expectedSafeOutputsGuard(name)}\n`), name);
  }
});

test("AC29: the conclusion job is rendered as a dry-run guard in a drift workflow and left to the compiler in every other workflow", () => {
  for (const id of ids) {
    const { jobs } = readWorkflow(`${id}.md`).frontmatter;
    if (isDrift(id)) assert.deepEqual(jobs.conclusion, { if: DRIFT_CONCLUSION_GUARD }, `${id}.conclusion`);
    else assert.equal("conclusion" in jobs, false, `${id} has no conclusion section`);
  }
  for (const [name, text] of renderFleet(request).files) {
    if (name.endsWith(".md") && isDrift(name)) assert.ok(text.includes(`  conclusion:\n    if: ${DRIFT_CONCLUSION_GUARD}\n`), name);
  }
});

test("AC29: in every committed drift lock the conclusion job also requires inputs.dry_run != true, and keeps the compiler's own condition", () => {
  for (const id of ids.filter(isDrift)) {
    const { conclusion } = lockOf(id).jobs;
    assert.ok(conclusion, `${id} has a conclusion job`);
    const condition = conditionOf(conclusion);
    assert.ok(condition.endsWith(" && (inputs.dry_run != true)"), `${id}: if ${condition}`);
    assert.ok(condition.includes("needs.agent.result != 'skipped'"), `${id}: the compiler's condition is still there, the guard only narrows it`);
  }
});

test("AC8: a dry run of a drift workflow reaches neither safe_outputs, conclusion nor escalate_failure, whatever the agent job ended with", () => {
  for (const id of ids.filter(isDrift)) {
    const lock = lockOf(id);
    for (const agent of ["success", "failure", "cancelled"]) {
      const run = simulateGates(id, lock, { agent, dryRun: true });
      for (const name of ["safe_outputs", "conclusion", "escalate_failure"]) assert.equal(run.ran.includes(name), false, `${id}: ${name} in a dry run after an agent that ended ${agent}`);
    }
    assert.ok(simulateGates(id, lock, { agent: "failure", dryRun: true }).ran.includes("agent"), `${id}: the dry run itself still runs the agent`);
    assert.ok(simulateGates(id, lock, { agent: "failure" }).ran.includes("conclusion"), `${id}: outside a dry run the failure is still reported`);
  }
});

test("AC8: the conclusion condition that the compiler writes on its own ran in a dry run after a failed agent job (the defect)", () => {
  for (const id of ids.filter(isDrift)) {
    const lock = structuredClone(lockOf(id));
    const guarded = conditionOf(lock.jobs.conclusion);
    const unguarded = /^\((.*)\) && \(inputs\.dry_run != true\)$/.exec(guarded)?.[1];
    assert.ok(unguarded, `${id}: the compiled condition is the compiler's own, joined with the guard: ${guarded}`);
    assert.equal(simulateGates(id, lock, { agent: "failure", dryRun: true }).ran.includes("conclusion"), false, `${id}: guarded`);
    lock.jobs.conclusion.if = unguarded;
    assert.equal(simulateGates(id, lock, { agent: "failure", dryRun: true }).ran.includes("conclusion"), true, `${id}: without the guard the failure issue is opened in a dry run`);
  }
});

test("AC29: the guard is rendered for any manifest, not only for the preset: every workflow of the minimal fixture carries it", () => {
  const workspace = createWorkspace({ manifestText: readText(fixture("manifest.minimal.yaml")) });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const sources = [...result.files].filter(([name]) => name.endsWith(".md"));
    assert.deepEqual(sources.map(([name]) => name.split("/").pop()), ["cascade-mechanical-alpha-to-beta.md", "drift-alpha-service.md", "sdlc-onboard.md"]);
    for (const [name, text] of sources) {
      const { jobs } = parseWorkflow(text).frontmatter;
      assert.deepEqual(jobs.detection, { if: AGENT_SUCCESS_GUARD }, `${name}.detection`);
      assert.deepEqual(jobs.safe_outputs, { if: expectedSafeOutputsGuard(name) }, `${name}.safe_outputs`);
      if (isDrift(name)) assert.deepEqual(jobs.conclusion, { if: DRIFT_CONCLUSION_GUARD }, `${name}.conclusion`);
      else assert.equal("conclusion" in jobs, false, `${name} has no conclusion section`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC29: the detection job itself is never allowed to fail open", () => {
  for (const id of ids) {
    const { detection } = lockOf(id).jobs;
    assert.ok(detection, `${id} has a detection job`);
    assert.notEqual(detection["continue-on-error"], true, id);
    assert.equal(JSON.stringify(detection).includes("continue-on-error: true"), false, id);
  }
});

test("AC29: threat-detection is rendered as { continue-on-error: false } and no if, needs or continue-on-error true overrides safe_outputs", () => {
  for (const id of ids) {
    const outputs = readWorkflow(`${id}.md`).frontmatter["safe-outputs"];
    assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false }, id);
    assert.equal("if" in outputs || "needs" in outputs, false, id);
    for (const [name, value] of Object.entries(outputs)) {
      if (value && typeof value === "object") {
        assert.equal("if" in value, false, `${id}.${name}`);
        assert.equal("needs" in value, false, `${id}.${name}`);
        assert.notEqual(value["continue-on-error"], true, `${id}.${name}`);
      }
    }
  }
});

test("AC29: no rendered gh-aw source or the router contains continue-on-error: true", () => {
  const rendered = renderFleet(request).files;
  for (const [name, text] of rendered) {
    if (name.endsWith(".md") || name.endsWith("cascade-router.yml")) assert.equal(text.includes("continue-on-error: true"), false, name);
  }
  for (const file of listFiles(REPO_ROOT, W).filter((name) => name.endsWith(".md") || name.endsWith("cascade-router.yml"))) {
    assert.equal(readText(abs(file)).includes("continue-on-error: true"), false, file);
  }
});

test("AC29: the engine never names the repository that runs the workflows (it comes from the Actions context); only the manifest names it, as the upstream of the self-cascade edge", () => {
  assert.equal(/mfg_msft_ai_sdlc/.test(readText(abs("src", "reconcile.mjs"))), false);
  const withoutSelfCascade = mutate(presetManifest(), (copy) => {
    copy.projects = copy.projects.filter((project) => project.projectKey !== "ai-sdlc");
    copy.dependencyEdges = copy.dependencyEdges.filter((edge) => edge.edgeId !== "ai-sdlc");
  });
  const workspace = createWorkspace({ manifestText: toYaml(withoutSelfCascade), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    for (const [name, text] of result.files) assert.equal(/mfg_msft_ai_sdlc/.test(text), false, name);
  } finally {
    workspace.cleanup();
  }
  const named = [...renderFleet(request).files].filter(([, text]) => /mfg_msft_ai_sdlc/.test(text)).map(([name]) => name);
  assert.deepEqual(named, [`${W}/cascade-mechanical-ai-sdlc.md`, `${W}/cascade-router.yml`], "the edge's workflow and the router carry it as data of the edge");
});

test("AC29: failure escalation stays in the repository that runs the workflow: escalate_failure runs after a failed agent", () => {
  for (const id of ids.filter((name) => !name.startsWith("sdlc-"))) {
    const { escalate_failure: job } = lockOf(id).jobs;
    assert.ok(job, `${id} has escalate_failure`);
    assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"], id);
    const expected = id.startsWith("drift-") ? "failure() && inputs.dry_run != true" : "failure() && inputs.dry_run != 'true'";
    assert.equal(job.if, expected, `${id}: the compiler left the guard unwrapped, so it still fires after a failed agent`);
  }
});

test("AC29: finalize_poll_state stays behind the detection result", () => {
  for (const id of ids.filter((name) => name.startsWith("cascade-"))) {
    const { finalize_poll_state: job } = lockOf(id).jobs;
    assert.ok(String(job.if).includes("needs.detection.result == 'success'"), id);
    assert.ok(String(job.if).includes("success() && inputs.dry_run != 'true'"), id);
  }
});

test("AC29: every rendered source has a compiled lock in the repository and every lock has a source", () => {
  const files = listFiles(REPO_ROOT, W);
  for (const id of ids) {
    assert.ok(files.includes(`${W}/${id}.md`), `${id}.md`);
    assert.ok(files.includes(`${W}/${id}.lock.yml`), `${id}.lock.yml`);
  }
  const locks = files.filter((name) => name.endsWith(".lock.yml")).map((name) => name.split("/").pop().replace(".lock.yml", ""));
  assert.deepEqual(locks.sort(), [...ids].sort());
  assert.equal(fs.existsSync(abs(".github", "aw", "actions-lock.json")), true, "the compiler's pin cache is committed");
});
