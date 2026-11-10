// AC18: the compile acknowledgment AiWorkflowCompileAck that the reconciler reports for the three AI workflows, and its agreement with the rendered post-steps.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks } from "../../src/reconcile.mjs";
import { REPO_ROOT } from "./helpers/fixtures.mjs";
import { AI, edgeOf, referenceRequest, workflowOf } from "./helpers/workflows.mjs";

const ack = () => buildAcks(referenceRequest(), { cwd: REPO_ROOT }).ai;
const ZERO_DIFF = [
  "experiences/copilot-workshop/content/rules.ts",
  "experiences/copilot-workshop/content/source.ts",
  "experiences/copilot-workshop/content/types.ts",
  "experiences/copilot-workshop/src",
  "src",
  "scripts",
  "tests/auth.test.ts",
  "tests/runtime.test.ts",
  "tests/catalog.test.ts",
  "tests/copilot-workshop-geometry.test.ts",
  "tests/copilot-workshop-runtime.test.ts",
  "apps/lab-studio/server/src/index.ts",
  "apps/lab-studio/server/src/copilot-bridge.ts",
  "apps/lab-studio/server/src/sandbox.ts",
  "apps/lab-studio/server/src/sim-terminal.ts",
  "apps/lab-studio/server/src/skills.ts",
  "apps/lab-studio/server/tests/sandbox.test.ts",
];
const GATE = [
  'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
  'AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"',
  'node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow <workflow-id>',
  "npm run build:workshop",
  "npm run build:experiences",
  'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain',
  "npm run build",
  "STUDIO_ORIGIN=https://studio.example.com npm run build:catalog",
  "npm run typecheck",
  "npm run lint",
  "npm test",
  "npm run test:studio",
  "npx playwright test tests/browser/sites.spec.ts",
];

test("AC18: the acknowledgment has exactly the five members, and the workflow ids and lock paths are those of the three workflows, in order", () => {
  const value = ack();
  assert.deepEqual(Object.keys(value).sort(), ["allowedFilesByWorkflow", "immutableProtectedPaths", "lockPaths", "verificationGate", "workflowIds"]);
  assert.deepEqual(value.workflowIds, ["cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate"]);
  assert.deepEqual(value.lockPaths, AI.map((spec) => `.github/workflows/${spec.id}.lock.yml`));
});

test("AC18: allowedFilesByWorkflow maps each workflow to the exact list that its safe output carries", () => {
  const value = ack();
  assert.deepEqual(Object.keys(value.allowedFilesByWorkflow), value.workflowIds);
  for (const spec of AI) {
    assert.deepEqual(value.allowedFilesByWorkflow[spec.id], edgeOf(spec).allowedFiles, spec.id);
    assert.deepEqual(value.allowedFilesByWorkflow[spec.id], workflowOf(spec).frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], `${spec.id}: the rendered workflow`);
  }
  assert.deepEqual(value.allowedFilesByWorkflow["cascade-ai-pipeline-showcase"].length, 5);
});

test("AC18: immutableProtectedPaths are the seventeen zero-diff paths, sorted", () => {
  const { immutableProtectedPaths } = ack();
  assert.equal(immutableProtectedPaths.length, 17);
  assert.deepEqual(immutableProtectedPaths, [...ZERO_DIFF].sort());
});

test("AC18: verificationGate is the ordered list of the thirteen command templates, with <workflow-id> as the only per-workflow variable", () => {
  const { verificationGate } = ack();
  assert.deepEqual(verificationGate, GATE);
  assert.equal(verificationGate.length, 13);
  for (const hand of ["GITHUB_ENV", "upload-artifact", "cascade-shas.json", "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"]) {
    assert.equal(verificationGate.some((template) => template.includes(hand) && !template.startsWith("AGENT_HEAD_SHA=")), false, `${hand} is not a member of the gate`);
  }
  assert.equal(verificationGate.filter((template) => template.includes("<")).length, 1, "only the helper names the workflow");
});

test("AC18: the rendered post-steps of each workflow run the gate: the first two templates in the first run step, then the helper with its own id, then the ten commands", () => {
  for (const spec of AI) {
    const steps = workflowOf(spec).frontmatter["post-steps"];
    const [handOff, upload, helper, ...commands] = steps;
    assert.ok(handOff.run.includes(GATE[0]) && handOff.run.includes(GATE[1]), `${spec.id}: the first step records both revisions`);
    assert.ok(handOff.run.includes('/tmp/gh-aw/cascade-shas.json') && handOff.run.includes('>> "$GITHUB_ENV"'), spec.id);
    assert.equal(upload.uses, "actions/upload-artifact@v4", spec.id);
    assert.equal(upload.with.name, "sdlc-cascade-shas-${{ github.run_id }}", spec.id);
    assert.equal(helper.run, GATE[2].replace("<workflow-id>", spec.id), `${spec.id}: the helper`);
    const ten = commands.slice(0, 10).map((step) => step.run);
    ten.forEach((run, index) => {
      if (GATE[3 + index].includes("status --porcelain")) {
        // a status command is rendered as the clean-tree check that fails when it prints anything
        assert.ok(run.includes(GATE[3 + index]) && run.includes("exit 1"), `${spec.id}: the clean-tree check`);
      } else {
        assert.equal(run, GATE[3 + index], `${spec.id}: command ${index + 1} of ten`);
      }
    });
    assert.equal(commands.length, edgeOf(spec).verifyCommands.length, `${spec.id}: followed by the post-run checks`);
  }
});
