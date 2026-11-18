// AC2, AC12-AC15 (data), AC24 (scopes), AC51 (provenance files) and AC60-AC68 (commands of the edges): the three ai-adaptation edges of the preset sdlc.yaml.
import assert from "node:assert/strict";
import test from "node:test";
import { engineFile } from "../helpers/instance.mjs";
import { readJson } from "./helpers/fixtures.mjs";
import { AI, ALL_SCOPES, DOWNSTREAM, edgeOf, manifest } from "./helpers/workflows.mjs";

const aiEdges = () => manifest().dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");

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

const ALLOWED = {
  "copilot-lab": [
    "README.md",
    "public/copilot-project.html",
    "experiences/copilot-workshop/content/index.ts",
    "experiences/copilot-workshop/content/interludes.ts",
    "experiences/copilot-workshop/content/lab-pace.ts",
    "experiences/copilot-workshop/content/m*.ts",
    "experiences/copilot-workshop/provenance.json",
    "experiences/copilot-workshop/source-inputs.json",
    "experiences/copilot-workshop/public/LICENSE",
    "experiences/copilot-workshop/public/NOTICE.txt",
    "public/workshop/**",
    "tests/copilot-workshop.test.ts",
    "apps/lab-studio/lab-sources.json",
    "apps/lab-studio/README.md",
    "apps/lab-studio/client/src/labs/source.ts",
    "apps/lab-studio/client/src/labs/lab*.tsx",
    "apps/lab-studio/server/src/verify.ts",
    "apps/lab-studio/server/tests/source.test.ts",
    "apps/lab-studio/server/tests/lab-drift.test.ts",
    "apps/lab-studio/server/tests/lesson-content.test.ts",
  ],
  "pipeline-showcase": [
    "experiences/pipeline-showcase/content/provenance.json",
    "experiences/pipeline-showcase/capture/fetch-run-data.mjs",
    "experiences/pipeline-showcase/content/run-data.json",
    "public/pipeline-showcase/**",
    "tests/pipeline-showcase.test.ts",
  ],
  "github-intermediate": [
    "experiences/github-intermediate-labs/provenance.json",
    "experiences/github-intermediate-labs/src/**",
    "experiences/github-intermediate-workshop/content/**",
    "public/github-intermediate/**",
    "tests/github-intermediate-labs.test.ts",
    "tests/github-intermediate-workshop.test.ts",
  ],
};

const TEN_COMMANDS = [
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

const POST_RUN = {
  "copilot-lab": ["a dry run must not leave a commit", "committed provenance records upstream_sha", "the upstream checkout stays read-only"],
  "pipeline-showcase": [
    "a dry run must not leave a commit",
    "a changed RUNS list needs a re-captured run-data.json",
    "committed provenance records upstream_sha",
    "the upstream checkout stays read-only",
  ],
  "github-intermediate": ["a dry run must not leave a commit", "committed provenance records upstream_sha", "the upstream checkout stays read-only"],
};

test("AC2: the preset has exactly three ai-adaptation edges, all into johnhain-msft/portfolio, with the keys, slugs and upstream repositories of the spec", () => {
  const edges = aiEdges();
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map((edge) => edge.edgeId), AI.map((spec) => spec.edgeId));
  for (const spec of AI) {
    const edge = edgeOf(spec);
    assert.equal(edge.downstreamRepo, DOWNSTREAM, spec.id);
    assert.equal(edge.upstreamRepo, spec.upstreamRepo, spec.id);
    assert.equal(edge.upstreamKey, spec.upstreamKey, spec.id);
    assert.equal(edge.upstreamSlug, spec.upstreamSlug, spec.id);
    assert.equal(edge.stateVariable, `SDLC_SYNC_STATE_${spec.upstreamSlug}`, spec.id);
  }
});

test("AC2: every edge carries the data its workflow needs, and none of it is empty", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    for (const field of ["preflightCommands", "acceptCommands", "buildCommands", "verifyCommands", "allowedFiles"]) {
      assert.ok(Array.isArray(edge[field]) && edge[field].length > 0, `${spec.id}.${field}`);
      for (const command of edge[field]) assert.equal(typeof command, "string", `${spec.id}.${field}`), assert.notEqual(command.trim(), "", `${spec.id}.${field}`);
    }
    assert.ok(typeof edge.adaptationInstructions === "string" && edge.adaptationInstructions.trim() !== "", `${spec.id}.adaptationInstructions`);
    const gates = edge.immutableGates;
    assert.ok(gates.zeroDiffPaths.length > 0, `${spec.id}.immutableGates.zeroDiffPaths`);
    assert.ok(Array.isArray(gates.lockedTestBlocks) && gates.lockedTestBlocks.length > 0, `${spec.id}.immutableGates.lockedTestBlocks`);
    assert.ok(gates.inProcessInvariants && Object.keys(gates.inProcessInvariants).length > 0, `${spec.id}.immutableGates.inProcessInvariants`);
    assert.equal(edge.autoMerge, false, spec.id);
  }
});

test("AC2: the workflow identities and the provenance files of the edges are the ones of the spec (AC5, AC51)", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    assert.equal(edge.branchName, spec.branchName, spec.id);
    assert.equal(edge.closeOlderKey, spec.closeOlderKey, spec.id);
    assert.equal(edge.provenanceFile, spec.provenanceFile, spec.id);
    assert.equal(edge.provenanceJsonPointer, "/commit", spec.id);
    assert.deepEqual(edge.reviewers.length > 0, true, spec.id);
  }
});

test("AC12-AC14: the allowed files of each edge are exactly the lists of the spec (order does not matter)", () => {
  for (const spec of AI) {
    assert.deepEqual([...edgeOf(spec).allowedFiles].sort(), [...ALLOWED[spec.edgeId]].sort(), spec.id);
  }
  assert.equal(ALLOWED["copilot-lab"].length, 20);
});

test("AC24: the sync scopes of each edge are the ones that its workflow accepts: ids that the installed engine's schema takes for a scope, and members of this fleet's five", () => {
  // a scope is a free-form id in the engine's schemas (the router dispatches one of the edge's, the workflow refuses any other), so the engine fixes only the shape of one
  const pattern = new RegExp(readJson(engineFile("schemas", "sdlc.schema.json")).definitions.scopeId.pattern);
  for (const spec of AI) {
    const scopes = edgeOf(spec).syncScopes;
    assert.deepEqual(scopes, spec.scopes, spec.id);
    for (const scope of scopes) {
      assert.match(scope, pattern, `${spec.id}: ${scope}`);
      assert.ok(ALL_SCOPES.includes(scope), `${spec.id}: ${scope}`);
    }
  }
  assert.deepEqual([...new Set(AI.flatMap((spec) => edgeOf(spec).syncScopes))].sort(), [...ALL_SCOPES].sort(), "and the fleet uses no other");
});

test("AC41/AC15: the seventeen locked paths are the same, in order, for the three edges", () => {
  for (const spec of AI) assert.deepEqual(edgeOf(spec).immutableGates.zeroDiffPaths, ZERO_DIFF, spec.id);
  assert.equal(ZERO_DIFF.length, 17);
});

test("AC68: each edge's verifyCommands are the ten commands that follow the helper, then the post-run checks of AC28, AC66 (showcase only), AC69 and AC77", () => {
  for (const spec of AI) {
    const { verifyCommands } = edgeOf(spec);
    assert.deepEqual(verifyCommands.slice(0, 10), TEN_COMMANDS, spec.id);
    const checks = verifyCommands.slice(10);
    assert.deepEqual(
      checks.map((command) => command.split("\n")[0].replace(/^#\s*post-run check:\s*/, "")),
      POST_RUN[spec.edgeId],
      `${spec.id}: the post-run checks, in order`,
    );
    for (const command of checks) assert.match(command, /^# post-run check: /, spec.id);
  }
  assert.equal(edgeOf(AI[0]).verifyCommands.length, 13);
  assert.equal(edgeOf(AI[1]).verifyCommands.length, 14);
});

test("AC60/AC63: the copilot-lab accept commands run the revision bump first, then the two --accept commands, then the build", () => {
  const edge = edgeOf(AI[0]);
  assert.deepEqual(edge.acceptCommands, [
    'node "$GITHUB_WORKSPACE/scripts/bump-studio-revision-pins.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --new-sha "$UPSTREAM_SHA"',
    "npm run sync:workshop-source -- <checkout> --accept",
    'node "$GITHUB_WORKSPACE/scripts/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream <checkout> --commit "$UPSTREAM_SHA" --accept',
  ]);
  assert.deepEqual(edge.buildCommands, ["npm run build:workshop"]);
  assert.deepEqual(edge.preflightCommands, [
    "npm run sync:workshop-source -- <checkout>",
    'node "$GITHUB_WORKSPACE/scripts/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream <checkout> --commit "$TARGET_SHA"',
  ]);
});

test("AC64-AC67: the showcase and intermediate edges write the exact provenance object, and the showcase captures run data and builds", () => {
  const showcase = edgeOf(AI[1]);
  assert.equal(showcase.acceptCommands.length, 1);
  assert.ok(showcase.acceptCommands[0].includes('JSON.stringify({ repository: "ms-mfg-community/github-pipeline-showcase", commit: process.env.UPSTREAM_SHA }, null, 2)'));
  assert.ok(showcase.acceptCommands[0].includes('"experiences/pipeline-showcase/content/provenance.json"'));
  assert.deepEqual(showcase.buildCommands, ["node experiences/pipeline-showcase/capture/fetch-run-data.mjs", "npm run build:experiences"]);
  assert.deepEqual(showcase.preflightCommands, ['gh api "repos/ms-mfg-community/github-pipeline-showcase/actions/runs?per_page=100"']);
  const intermediate = edgeOf(AI[2]);
  assert.equal(intermediate.acceptCommands.length, 1);
  assert.ok(intermediate.acceptCommands[0].includes('JSON.stringify({ repository: "githubschool/gh-github-intermediate-template", commit: process.env.UPSTREAM_SHA }, null, 2)'));
  assert.ok(intermediate.acceptCommands[0].includes('"experiences/github-intermediate-labs/provenance.json"'));
  assert.deepEqual(intermediate.buildCommands, ["npm run build:experiences"]);
});

test("AC2: the adaptation data of the edges is the data that the helpers and the run report read (SPEC-04 schema field): the engine's own keys, and the data of the helpers under adaptation.helpers", () => {
  const lab = edgeOf(AI[0]).adaptation;
  assert.deepEqual(Object.keys(lab), ["preflightReports", "helpers", "pullRequestResult"], "the keys of the engine, and one place for the helpers' data that the engine does not read");
  assert.deepEqual(lab.preflightReports, ["workshop-drift.txt", "lab-studio-drift.txt"]);
  assert.deepEqual(Object.keys(lab.helpers), ["labStudioDrift", "revisionPins"], "the two helpers that read their data through helperSection");
  assert.equal(lab.helpers.labStudioDrift.manifest, "apps/lab-studio/lab-sources.json");
  assert.deepEqual(lab.helpers.revisionPins.provenance, [
    { file: "apps/lab-studio/lab-sources.json", pointer: "/_provenance/commit" },
    { file: "experiences/copilot-workshop/provenance.json", pointer: "/commit" },
  ]);
  assert.deepEqual(lab.helpers.revisionPins.files, [
    "apps/lab-studio/client/src/labs/source.ts",
    "apps/lab-studio/server/tests/source.test.ts",
    "apps/lab-studio/server/tests/lab-drift.test.ts",
    "README.md",
    "experiences/copilot-workshop/public/NOTICE.txt",
    "public/copilot-project.html",
  ]);
  assert.deepEqual(lab.helpers.revisionPins.constant, { file: "apps/lab-studio/client/src/labs/source.ts", name: "SOURCE_COMMIT" });
  assert.equal("labStudioDrift" in lab || "revisionPins" in lab, false, "and neither is a key of adaptation any more: the engine's schema does not know them");
  assert.deepEqual(lab.pullRequestResult, { adaptedModules: "experiences/copilot-workshop/content/m*.ts", adaptedStudioLabs: "apps/lab-studio/client/src/labs/lab*.tsx" });
  assert.deepEqual(edgeOf(AI[1]).adaptation, { preflightReports: ["upstream-runs.json"] });
  assert.equal(edgeOf(AI[2]).adaptation, undefined);
});
