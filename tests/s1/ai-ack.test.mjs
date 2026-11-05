// AC50: the AiWorkflowCompileAck of contract C4, returned by buildAcks(request).ai.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks, renderFleet } from "../../src/reconcile.mjs";
import { clone, edgeOf, minimalManifest, mutate, parseWorkflow, presetManifest, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();
const preset = presetManifest();
const W = ".github/workflows";

const AI_IDS = ["cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate"];
const ZERO_DIFF = edgeOf(preset, "copilot-lab").immutableGates.zeroDiffPaths;
const THIRTEEN = [
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
  "npm run test:browser",
];

test("AC50: the ack has the three workflow ids, three lock paths and the three allowedFilesByWorkflow keys, in manifest order", () => {
  const { ai } = buildAcks(request);
  assert.deepEqual(Object.keys(ai).sort(), ["allowedFilesByWorkflow", "immutableProtectedPaths", "lockPaths", "verificationGate", "workflowIds"]);
  assert.deepEqual(ai.workflowIds, AI_IDS);
  assert.deepEqual(ai.lockPaths, AI_IDS.map((id) => `${W}/${id}.lock.yml`));
  assert.deepEqual(Object.keys(ai.allowedFilesByWorkflow), AI_IDS);
  for (const id of AI_IDS) {
    const edge = edgeOf(preset, id.replace("cascade-ai-", ""));
    assert.deepEqual(ai.allowedFilesByWorkflow[id], edge.allowedFiles);
  }
});

test("AC50: allowedFilesByWorkflow is each workflow's rendered allowed-files", () => {
  const rendered = renderFleet(request);
  const { ai } = buildAcks(request);
  for (const id of AI_IDS) {
    const handler = parseWorkflow(rendered.files.get(`${W}/${id}.md`)).frontmatter["safe-outputs"]["create-pull-request"];
    assert.deepEqual(ai.allowedFilesByWorkflow[id], handler["allowed-files"], id);
  }
});

test("AC50: immutableProtectedPaths is the sorted union of the zeroDiffPaths — the seventeen entries", () => {
  const { ai } = buildAcks(request);
  assert.equal(ai.immutableProtectedPaths.length, 17);
  assert.deepEqual(ai.immutableProtectedPaths, [...ZERO_DIFF].sort());
  assert.deepEqual(ai.immutableProtectedPaths, [...ai.immutableProtectedPaths].sort());
  const union = mutate(preset, (copy) => {
    edgeOf(copy, "pipeline-showcase").immutableGates.zeroDiffPaths = [...ZERO_DIFF, "extra/locked.ts"];
  });
  const workspace = createWorkspace({ manifestText: toYaml(union), instructions: true });
  try {
    const grown = buildAcks(request, { cwd: workspace.dir }).ai.immutableProtectedPaths;
    assert.equal(grown.length, 18);
    assert.ok(grown.includes("extra/locked.ts"));
    assert.deepEqual(grown, [...grown].sort());
  } finally {
    workspace.cleanup();
  }
});

test("AC50: verificationGate is the thirteen command templates in order; the append and artifact steps are not members", () => {
  const { ai } = buildAcks(request);
  assert.deepEqual(ai.verificationGate, THIRTEEN);
  assert.equal(ai.verificationGate.length, 13);
  assert.equal(ai.verificationGate.some((entry) => /GITHUB_ENV|upload-artifact|cascade-shas/.test(entry)), false);
  assert.ok(ai.verificationGate[2].includes("<workflow-id>"), "<workflow-id> is the only per-workflow variable");
});

test("AC50: the verificationGate commands are the ones the rendered post-steps run, with <workflow-id> filled in", () => {
  const rendered = renderFleet(request);
  const { ai } = buildAcks(request);
  for (const id of AI_IDS) {
    const post = parseWorkflow(rendered.files.get(`${W}/${id}.md`)).frontmatter["post-steps"];
    assert.ok(post[0].run.includes(ai.verificationGate[0]) && post[0].run.includes(ai.verificationGate[1]));
    assert.equal(post[2].run, ai.verificationGate[2].replace("<workflow-id>", id));
    const gates = post.slice(3, 13).map((step) => (step.name === ai.verificationGate[5] ? step.name : step.run));
    assert.deepEqual(gates, ai.verificationGate.slice(3));
  }
});

test("AC50: post-run checks (entries that open with #) stay out of verificationGate wherever they sit and the other commands keep manifest order", () => {
  const isPostRunCheck = (command) => command.trimStart().startsWith("#");
  const reordered = mutate(preset, (copy) => {
    const edge = edgeOf(copy, "copilot-lab");
    const checks = edge.verifyCommands.filter(isPostRunCheck);
    const gates = edge.verifyCommands.filter((command) => !isPostRunCheck(command));
    assert.equal(checks.length, 3);
    // two gate commands swapped, a check first and one in the middle: the ack follows the manifest, not a constant
    [gates[7], gates[8]] = [gates[8], gates[7]];
    edge.verifyCommands = [checks[0], ...gates.slice(0, 4), checks[1], ...gates.slice(4), checks[2]];
  });
  const workspace = createWorkspace({ manifestText: toYaml(reordered), instructions: true });
  try {
    const { ai } = buildAcks(request, { cwd: workspace.dir });
    const gates = edgeOf(reordered, "copilot-lab").verifyCommands.filter((command) => !isPostRunCheck(command));
    assert.notDeepEqual(gates, THIRTEEN.slice(3), "the manifest order differs from the preset order");
    assert.deepEqual(ai.verificationGate.slice(0, 3), THIRTEEN.slice(0, 3));
    assert.deepEqual(ai.verificationGate.slice(3), gates);
    assert.equal(ai.verificationGate.length, 13);
    assert.equal(ai.verificationGate.some(isPostRunCheck), false);
    const post = parseWorkflow(renderFleet(request, { cwd: workspace.dir }).files.get(`${W}/cascade-ai-copilot-lab.md`)).frontmatter["post-steps"].slice(3);
    assert.equal(post.length, 13, "the three post-run checks are rendered with the ten gate commands");
    assert.ok(post[0].run.includes("# post-run check: a dry run must not leave a commit"), "a post-run check keeps its manifest position");
  } finally {
    workspace.cleanup();
  }
});

test("AC50: a manifest without AI edges yields empty lists", () => {
  const workspace = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  try {
    const { ai } = buildAcks(request, { cwd: workspace.dir });
    assert.deepEqual(ai, { workflowIds: [], lockPaths: [], allowedFilesByWorkflow: {}, immutableProtectedPaths: [], verificationGate: [] });
  } finally {
    workspace.cleanup();
  }
});

test("AC50: the working tree is unchanged by buildAcks", () => {
  const workspace = createWorkspace();
  try {
    const before = workspace.hash(["."]);
    buildAcks(request, { cwd: workspace.dir });
    assert.equal(workspace.hash(["."]), before);
  } finally {
    workspace.cleanup();
  }
  assert.equal(clone(buildAcks(request)).ai.workflowIds.length, 3);
});
