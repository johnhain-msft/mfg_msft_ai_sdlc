// AC39 and AC40 (manifest side): graph and policy validation before any workflow is emitted.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, readText, referenceRequest, withRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();
const graph = (name) => readText(fixture("graph", `${name}.yaml`));

async function run(name, requestOverride = request) {
  const workspace = createWorkspace({ manifestText: graph(name) });
  try {
    workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
    const before = workspace.hash();
    const result = await workspace.reconcile(requestOverride);
    return { result, errors: result.validationResults.flatMap((entry) => entry.errors), unchanged: workspace.hash() === before, workspace, compiles: workspace.shims.compileCalls().length };
  } finally {
    workspace.cleanup();
  }
}

/** Each invalid fixture, the rule that must fire and the entries (and values) that the message must name. */
const INVALID = [
  ["self-loop", "dependency-cycle", ["acme-labs/a", "'loop'"]],
  ["cycle-two", "dependency-cycle", ["acme-labs/a", "acme-labs/b", "'ab'", "'ba'"]],
  ["cycle-three", "dependency-cycle", ["acme-labs/a", "acme-labs/b", "acme-labs/c", "'ab'", "'bc'", "'ca'"]],
  ["missing-baseline", "schema-validation", ["initialBaselineSha", "/dependencyEdges/0"]],
  ["duplicate-branch-name", "duplicate-branch-name", ["'ab'", "'cd'", "sdlc/cascade-ab"]],
  ["duplicate-close-older-key", "duplicate-close-older-key", ["'ab'", "'cd'", "sdlc-cascade-ab"]],
  ["duplicate-upstream-key", "duplicate-upstream-key", ["'ab'", "'cd'"]],
  ["duplicate-state-variable", "duplicate-state-variable", ["'ab'", "'cd'", "SDLC_SYNC_STATE_AB"]],
  ["duplicate-edge-id", "duplicate-edge-id", ["'ab'"]],
  ["unknown-mode", "schema-validation", ["/dependencyEdges/0/mode", "mechanical", "ai-adaptation"]],
  ["empty-reviewers", "edge-reviewers-empty", ["'ab'", "reviewers"]],
  ["missing-allowed-files", "schema-validation", ["allowedFiles", "/dependencyEdges/0"]],
  ["empty-allowed-files", "edge-allowed-files-empty", ["'ab'", "allowedFiles"]],
];

for (const [name, rule, named] of INVALID) {
  test(`AC39/AC40: ${name}.yaml returns status error with ${rule}, names the offending entries and writes nothing`, async () => {
    const { result, errors, unchanged, compiles } = await run(name);
    assert.equal(result.status, "error");
    assert.deepEqual(result.generatedWorkflows, []);
    assert.ok(errors.some((error) => error.startsWith(`${rule}: `)), `${rule} in:\n${errors.join("\n")}`);
    const message = errors.filter((error) => error.startsWith(`${rule}: `)).join("\n");
    for (const needle of named) assert.ok(message.includes(needle), `the ${rule} message names ${needle}: ${message}`);
    assert.ok(unchanged, ".github/workflows is unchanged");
    assert.equal(compiles, 0, "the compiler is never reached");
  });
}

test("AC39: duplicate project keys are rejected, naming the key", async () => {
  const text = graph("valid-three-hop");
  const duplicated = text.replace("dependencyEdges:", "  - projectKey: graph-node\n    repo: acme-labs/other\n    defaultBranch: main\n    driftAudit:\n      enabled: false\n      schedule: 0 6 * * 1\n      upkeepStrategy: custom\n      instructions: ''\n      instructionsFile: null\n      knowledgeSources: { watchUrls: [], packageManifests: [], mcpServers: {} }\n      buildCommands: []\n      verifyCommands: []\n      draft: false\n      reviewers: []\ndependencyEdges:");
  const workspace = createWorkspace({ manifestText: duplicated });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^duplicate-project-key: .*'graph-node'/.test(error)), errors.join("\n"));
  } finally {
    workspace.cleanup();
  }
});

for (const [name, edgeCount] of [["valid-diamond", 4], ["valid-fan-in-four", 4], ["valid-three-hop", 3]]) {
  test(`AC39: ${name}.yaml is a valid graph and returns status ok with one workflow per edge`, async () => {
    const { result, workspace } = await (async () => {
      const ws = createWorkspace({ manifestText: graph(name) });
      try {
        return { result: await ws.reconcile(request), workspace: ws };
      } finally {
        ws.cleanup();
      }
    })();
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.ok(workspace);
    assert.equal(result.generatedWorkflows.filter((pair) => pair.sourceMd.includes("cascade-mechanical-")).length, edgeCount);
  });
}

test("AC39: the cycle message lists the closing path and every edge on it", async () => {
  const { errors } = await run("cycle-three");
  const message = errors.find((error) => error.startsWith("dependency-cycle: "));
  assert.match(message, /acme-labs\/a -> acme-labs\/b -> acme-labs\/c -> acme-labs\/a/);
});

test("AC39: repository names are compared without regard to case when looking for a cycle", async () => {
  const text = graph("cycle-two").replace("downstreamRepo: acme-labs/a", "downstreamRepo: ACME-LABS/A");
  const workspace = createWorkspace({ manifestText: text });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("dependency-cycle: ")));
  } finally {
    workspace.cleanup();
  }
});

test("AC39: an edge whose stateVariable is not the request's prefix plus the slug is rejected whatever the prefix check says elsewhere", async () => {
  const text = graph("valid-three-hop").replace("stateVariable: SDLC_SYNC_STATE_AB", "stateVariable: SDLC_SYNC_STATE_WRONG");
  const workspace = createWorkspace({ manifestText: text });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^edge-state-variable: .*'ab'.*SDLC_SYNC_STATE_AB/.test(error)));
  } finally {
    workspace.cleanup();
  }
});

test("AC39: all problems of a manifest are reported together, not just the first", async () => {
  const text = graph("duplicate-branch-name")
    .replace("closeOlderKey: sdlc-cascade-cd", "closeOlderKey: sdlc-cascade-ab")
    .replace("reviewers:\n      - graph-reviewer", "reviewers: []");
  const workspace = createWorkspace({ manifestText: text });
  try {
    const result = await workspace.reconcile(request);
    const rules = new Set(result.validationResults.flatMap((entry) => entry.errors).map((error) => error.split(": ")[0]));
    assert.ok(rules.has("duplicate-branch-name") && rules.has("duplicate-close-older-key") && rules.has("edge-reviewers-empty"), [...rules].join(", "));
  } finally {
    workspace.cleanup();
  }
});

test("AC40: reviewers and allowedFiles are checked for every edge, in both modes", async () => {
  for (const mode of ["mechanical", "ai-adaptation"]) {
    const text = graph("empty-reviewers").replace("mode: mechanical", `mode: ${mode}`);
    const workspace = createWorkspace({ manifestText: text });
    try {
      const result = await workspace.reconcile(withRequest());
      assert.equal(result.status, "error", mode);
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("edge-reviewers-empty: ")), mode);
    } finally {
      workspace.cleanup();
    }
  }
});
