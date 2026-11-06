// AC4: contract C2 response DriftWorkflowCompileAck. SPEC-01's buildAcks(request).drift acknowledges every rendered drift
// workflow; SPEC-02, the consumer, validates each acknowledgement against schemas/drift-compile-ack.schema.json and against the
// workflow it will run.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { buildAcks } from "../../src/reconcile.mjs";
import { abs, DRIFT_KEYS, driftLock, driftPreset, driftWorkflow, readJson, referenceRequest, stepWith, WORKFLOWS } from "./helpers/fixtures.mjs";

const validate = new Ajv({ allErrors: true, strict: true }).compile(readJson(abs("schemas", "drift-compile-ack.schema.json")));
const acks = buildAcks(referenceRequest()).drift;
const ackOf = (key) => acks.find((entry) => entry.workflowId === `drift-${key}`);

test("AC4: buildAcks(request).drift acknowledges the three preset workflows, in manifest order", () => {
  assert.equal(acks.length, 3);
  assert.deepEqual(acks.map((entry) => entry.workflowId), ["drift-gh-admin-msft", "drift-copilot-lab", "drift-self-improving-agents"]);
});

for (const key of DRIFT_KEYS) {
  test(`AC4: the acknowledgement of drift-${key} has exactly five keys and validates against the schema`, () => {
    const ack = ackOf(key);
    assert.deepEqual(Object.keys(ack).sort(), ["allowedNetworkDomains", "gateCommands", "lockPath", "targetRepo", "workflowId"]);
    assert.equal(validate(ack), true, JSON.stringify(validate.errors));
  });

  test(`AC4: the acknowledgement of drift-${key} agrees with the workflow that S2 runs`, () => {
    const ack = ackOf(key);
    const { frontmatter } = driftWorkflow(key);
    assert.equal(ack.lockPath, `${WORKFLOWS}/drift-${key}.lock.yml`, "lockPath is the path of its .lock.yml");
    assert.ok(fs.existsSync(abs(ack.lockPath)), "and that file exists");
    assert.equal(ack.targetRepo, frontmatter["safe-outputs"]["create-pull-request"]["target-repo"], "targetRepo is the target-repo of create-pull-request");
    assert.deepEqual(ack.allowedNetworkDomains, frontmatter.network.allowed, "allowedNetworkDomains equals network.allowed");
    assert.deepEqual(ack.gateCommands, frontmatter["post-steps"].map((step) => step.run), "gateCommands equals the ordered verifyCommands that post-steps run");
    assert.deepEqual(ack.gateCommands, driftPreset(key).driftAudit.verifyCommands);
    const escalation = stepWith(frontmatter.jobs.escalate_failure.steps, "escalate-gate-failure.mjs");
    assert.equal(escalation.env.WORKFLOW_ID, ack.workflowId, "workflowId is the identifier used in the issue title of AC30");
    assert.equal(escalation.env.TARGET_REPO, ack.targetRepo);
    const lock = driftLock(key).workflow;
    assert.ok(lock.jobs.escalate_failure, "the compiled lock holds the escalate_failure job of that workflow");
  });
}

test("AC4: the schema refuses an acknowledgement with an extra key, a missing key, a wildcard domain or a wrong path", () => {
  const good = ackOf("copilot-lab");
  assert.equal(validate({ ...good, extra: 1 }), false, "a sixth key");
  for (const key of Object.keys(good)) {
    const copy = { ...good };
    delete copy[key];
    assert.equal(validate(copy), false, `without ${key}`);
  }
  assert.equal(validate({ ...good, allowedNetworkDomains: ["*.example.org"] }), false, "a wildcard domain");
  assert.equal(validate({ ...good, lockPath: "drift-copilot-lab.lock.yml" }), false, "a path outside .github/workflows");
  assert.equal(validate({ ...good, workflowId: "cascade-x" }), false, "a workflowId that is not drift-<projectKey>");
  assert.equal(validate({ ...good, gateCommands: [""] }), false, "an empty gate command");
  assert.equal(validate({ ...good, targetRepo: "not-a-slug" }), false, "a target that is not a slug");
});
