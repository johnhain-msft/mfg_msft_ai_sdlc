// AC29: the compiled lock files keep safe_outputs behind detection, and nothing S1 renders overrides that.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, listFiles, readText, readWorkflow, referenceRequest, REPO_ROOT } from "./helpers/fixtures.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const ids = [
  "drift-gh-admin-msft", "drift-copilot-lab", "drift-self-improving-agents", "cascade-mechanical-ghec-admin",
  "cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate", "sdlc-onboard",
];
const lockOf = (id) => YAML.parse(readText(abs(W, `${id}.lock.yml`)));

test("AC29: in every committed lock the safe_outputs job lists detection in needs and only runs after detection succeeded", () => {
  for (const id of ids) {
    const { safe_outputs: job } = lockOf(id).jobs;
    assert.ok(job, `${id} has a safe_outputs job`);
    assert.ok(Array.isArray(job.needs) && job.needs.includes("detection"), `${id}: needs ${JSON.stringify(job.needs)}`);
    const condition = String(job.if);
    // gh-aw v1.0.1 compiles the detection gate as a result check; earlier text of this criterion named the output form.
    assert.ok(condition.includes("needs.detection.result == 'success'") || condition.includes("needs.detection.outputs.success == 'true'"), `${id}: if ${condition}`);
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

test("AC29: the engine never names the repository that runs the workflows (it comes from the Actions context)", () => {
  assert.equal(/mfg_msft_ai_sdlc/.test(readText(abs("src", "reconcile.mjs"))), false);
  for (const [name, text] of renderFleet(request).files) assert.equal(/mfg_msft_ai_sdlc/.test(text), false, name);
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
