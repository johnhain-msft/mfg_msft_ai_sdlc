// AC37: the CascadeCompileAck of contract C3, returned by buildAcks(request).cascade.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks } from "../../src/reconcile.mjs";
import { clone, minimalManifest, mutate, presetManifest, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();

function acksFor(manifest) {
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    return buildAcks(request, { cwd: workspace.dir }).cascade;
  } finally {
    workspace.cleanup();
  }
}

test("AC37: for the preset the cascade ack is the router path, the three mechanical workflows and six edges", () => {
  assert.deepEqual(buildAcks(request).cascade, {
    routerWorkflowPath: ".github/workflows/cascade-router.yml",
    mechanicalWorkflowPaths: [
      ".github/workflows/cascade-mechanical-ghec-admin.md",
      ".github/workflows/cascade-mechanical-ai-sdlc.md",
      ".github/workflows/cascade-mechanical-copilot-config.md",
    ],
    dependencyEdgesCount: 6,
  });
});

test("AC37: adding a fixture edge raises the count by one and a mechanical edge is listed in manifest order", () => {
  const base = presetManifest();
  const grown = mutate(base, (copy) => {
    const extra = clone(copy.dependencyEdges[0]);
    Object.assign(extra, {
      edgeId: "second-mechanical",
      upstreamRepo: "acme-labs/second-source",
      upstreamKey: "second-source",
      upstreamSlug: "SECOND_SOURCE",
      stateVariable: "SDLC_SYNC_STATE_SECOND_SOURCE",
      branchName: "sdlc/cascade-second-mechanical",
      closeOlderKey: "sdlc-cascade-second-mechanical",
      allowedFiles: ["public/second/**"],
      provenanceFile: "public/second/source.json",
    });
    copy.dependencyEdges.splice(1, 0, extra);
  });
  const ack = acksFor(grown);
  assert.equal(ack.dependencyEdgesCount, buildAcks(request).cascade.dependencyEdgesCount + 1);
  assert.deepEqual(ack.mechanicalWorkflowPaths, [
    ".github/workflows/cascade-mechanical-ghec-admin.md",
    ".github/workflows/cascade-mechanical-second-mechanical.md",
    ".github/workflows/cascade-mechanical-ai-sdlc.md",
    ".github/workflows/cascade-mechanical-copilot-config.md",
  ]);
});

test("AC37: an AI-only manifest has no mechanical workflow path and the router still covers every edge", () => {
  const aiOnly = mutate(presetManifest(), (copy) => (copy.dependencyEdges = copy.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation")));
  const ack = acksFor(aiOnly);
  assert.deepEqual(ack.mechanicalWorkflowPaths, []);
  assert.equal(ack.dependencyEdgesCount, 3);
  assert.equal(ack.routerWorkflowPath, ".github/workflows/cascade-router.yml");
});

test("AC37: a manifest without edges counts zero", () => {
  const none = mutate(minimalManifest(), (copy) => (copy.dependencyEdges = []));
  assert.equal(acksFor(none).dependencyEdgesCount, 0);
});
