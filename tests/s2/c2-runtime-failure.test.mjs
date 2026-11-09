// AC7: contract C2 error handoff, runtime (gated by OQ35). If pre_activation, checkout or detection (continue-on-error: false) fails in an S2 run,
// safe_outputs is skipped and the failure is reported in the central repository. Each compiled .lock.yml keeps the safe_outputs job conditional on
// detection and never sets safe-outputs.report-failed-jobs: false, which would disable the automatic failed-job reporting issue.
//
// This criterion asserts no detection outcome beyond the job graph (OQ35: continue-on-error defaults to true and its runtime meaning differs for a
// finding and for a detector failure; nothing here asserts it).
//
// The condition: the criterion names `needs.detection.outputs.success == 'true'` [F41]. The gh-aw compiler v1.0.1, which produced the committed locks,
// writes the same gate as `needs.detection.result == 'success'`. Both mean "detection ran and succeeded", and a failed, skipped or cancelled detection
// job makes safe_outputs skip, so the test accepts the two spellings and asserts the semantics, which is the job graph.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { abs, DRIFT_KEYS, driftLock, driftWorkflow, driftWorkflowText, WORKFLOWS } from "./helpers/fixtures.mjs";

const DETECTION_GATE = /needs\.detection\.outputs\.success == 'true'|needs\.detection\.result == 'success'/;
const needsOf = (job) => [].concat(job.needs ?? []);

for (const key of DRIFT_KEYS) {
  test(`AC7: in drift-${key}.lock.yml the safe_outputs job lists detection in needs and is conditional on detection's success`, () => {
    const { jobs } = driftLock(key).workflow;
    assert.ok(needsOf(jobs.safe_outputs).includes("detection"), "detection is in needs");
    assert.match(String(jobs.safe_outputs.if), DETECTION_GATE, `the if: is ${JSON.stringify(jobs.safe_outputs.if)}`);
    assert.match(String(jobs.safe_outputs.if), /needs\.agent\.result == 'success'/, "and on the agent job (which holds the checkout and the gate)");
    assert.match(String(jobs.safe_outputs.if), /!cancelled\(\)/, "a cancelled run does not publish");
  });

  test(`AC7: a failure in pre_activation, checkout or detection leaves safe_outputs skipped: the job graph of drift-${key} has no path around them`, () => {
    const { jobs } = driftLock(key).workflow;
    assert.ok(jobs.activation, "activation (which carries pre_activation's gates) exists");
    assert.ok(needsOf(jobs.agent).includes("activation"), "the agent job, which does the checkout, needs activation");
    assert.ok(needsOf(jobs.detection).includes("agent"), "detection needs the agent job");
    assert.ok(needsOf(jobs.safe_outputs).includes("activation") && needsOf(jobs.safe_outputs).includes("agent") && needsOf(jobs.safe_outputs).includes("detection"));
    const publishing = Object.entries(jobs).filter(([, job]) => /create_pull_request|safe_outputs/.test(JSON.stringify(job.steps ?? [])) && needsOf(job).includes("detection"));
    assert.ok(publishing.some(([name]) => name === "safe_outputs"), "safe_outputs is the publishing job");
    assert.equal(DETECTION_GATE.test(String(jobs.detection.if ?? "")) , false, "detection's own gate is the agent result");
    assert.match(String(jobs.detection.if), /needs\.agent\.result == 'success'/);
  });

  test(`AC7: the failure is reported in the central repository: drift-${key} keeps the failed-job reporting and adds the escalate_failure job`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.equal(driftWorkflowText(key).includes("report-failed-jobs"), false, "report-failed-jobs is not set, so the automatic failed-job issue stays on");
    assert.equal(fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8").includes("report-failed-jobs"), false, "nor in the lock");
    assert.equal("report-failed-jobs" in frontmatter["safe-outputs"], false);
    const { jobs } = driftLock(key).workflow;
    assert.ok(jobs.conclusion, "the conclusion job, which reports failed jobs, is compiled");
    assert.ok(needsOf(jobs.conclusion).includes("agent") && needsOf(jobs.conclusion).includes("detection") && needsOf(jobs.conclusion).includes("safe_outputs"));
    assert.deepEqual(needsOf(jobs.escalate_failure), ["agent", "detection", "safe_outputs"]);
    assert.deepEqual(frontmatter["safe-outputs"]["threat-detection"], { "continue-on-error": false });
  });
}

test("AC7: no drift workflow sets safe-outputs.report-failed-jobs: false, and each compiled conclusion job still runs the failed-job report", () => {
  for (const key of DRIFT_KEYS) {
    assert.equal(/report-failed-jobs/.test(driftWorkflowText(key)), false, `${key}: the source`);
    assert.equal(/report-failed-jobs/.test(fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8")), false, `${key}: the lock`);
    const { jobs } = driftLock(key).workflow;
    const report = jobs.conclusion.steps.find((step) => step.id === "report_failed_jobs");
    assert.ok(report, `${key}: the conclusion job carries the Report failed jobs step`);
    assert.equal(report.env.GH_AW_REPORT_FAILED_JOBS, "true", `${key}: and it is on`);
    const handler = jobs.conclusion.steps.find((step) => step.env?.GH_AW_FAILURE_REPORT_AS_ISSUE !== undefined);
    assert.equal(handler?.env.GH_AW_FAILURE_REPORT_AS_ISSUE, "false", `${key}: duplicate [aw] failure issues are disabled because escalate_failure owns [sdlc-failure]`);
  }
});

test("AC7 (OQ35): the criterion is gated: the spec still lists OQ35 as open and this file asserts no detection outcome", () => {
  const spec = fs.readFileSync(abs("specs", "02-upstream-drift-automation.md"), "utf8");
  const row = spec.split("\n").find((line) => line.startsWith("| OQ35 |"));
  assert.match(row, /CONTRADICTED/);
  assert.match(row, /AC2, AC7/);
  // The forbidden phrases are assembled from parts so that this scan does not match its own pattern.
  const outcomes = [["gh-aw", "threat", "detected"].join("-"), ["Threat detection", "engine error"].join(" "), "CAU" + "TION"];
  const source = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  for (const outcome of outcomes) assert.equal(source.includes(outcome), false, `no assertion about what a detector failure or a finding does: ${outcome}`);
});
