// AC43 (disjoint writers), AC46, AC47, AC48 and AC52: allowed-files and the locked paths of the AI edges.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks, renderFleet } from "../../src/reconcile.mjs";
import { abs, edgeOf, globMatches, mutate, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();
const preset = presetManifest();
const W = ".github/workflows";

const COPILOT_LAB = [
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
];
const SHOWCASE = [
  "experiences/pipeline-showcase/content/provenance.json",
  "experiences/pipeline-showcase/capture/fetch-run-data.mjs",
  "experiences/pipeline-showcase/content/run-data.json",
  "public/pipeline-showcase/**",
  "tests/pipeline-showcase.test.ts",
];
const INTERMEDIATE = [
  "experiences/github-intermediate-labs/provenance.json",
  "experiences/github-intermediate-labs/src/**",
  "experiences/github-intermediate-workshop/content/**",
  "public/github-intermediate/**",
  "tests/github-intermediate-labs.test.ts",
  "tests/github-intermediate-workshop.test.ts",
];
const MECHANICAL = ["public/ghec-admin/**"];
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

/** AC52 "includes": equal, beneath a directory entry, matched as a glob, or matched by it. */
function includes(pattern, locked) {
  const entry = locked.replace(/\/+$/, "");
  const candidate = pattern.replace(/\/+$/, "");
  return candidate === entry || candidate.startsWith(`${entry}/`) || globMatches(candidate, entry) || globMatches(entry, candidate);
}
const overlaps = (a, b) => includes(a, b) || includes(b, a);

test("AC46: the 20 entries of cascade-ai-copilot-lab allowed-files equal the list, in order", () => {
  assert.equal(COPILOT_LAB.length, 20);
  assert.deepEqual(edgeOf(preset, "copilot-lab").allowedFiles, COPILOT_LAB);
  const handler = readWorkflow("cascade-ai-copilot-lab.md").frontmatter["safe-outputs"]["create-pull-request"];
  assert.deepEqual(handler["allowed-files"], COPILOT_LAB);
  assert.deepEqual(buildAcks(request).ai.allowedFilesByWorkflow["cascade-ai-copilot-lab"], COPILOT_LAB);
});

test("AC46: the list is read from sdlc.yaml — editing the manifest changes the generated output", () => {
  const edited = mutate(preset, (copy) => edgeOf(copy, "copilot-lab").allowedFiles.push("docs/extra-surface.md"));
  const workspace = createWorkspace({ manifestText: toYaml(edited), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const handler = parseWorkflow(result.files.get(`${W}/cascade-ai-copilot-lab.md`)).frontmatter["safe-outputs"]["create-pull-request"];
    assert.deepEqual(handler["allowed-files"], [...COPILOT_LAB, "docs/extra-surface.md"]);
    assert.deepEqual(buildAcks(request, { cwd: workspace.dir }).ai.allowedFilesByWorkflow["cascade-ai-copilot-lab"], [...COPILOT_LAB, "docs/extra-surface.md"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC47: the zeroDiffPaths of every AI edge equal the seventeen entries, in order", () => {
  assert.equal(ZERO_DIFF.length, 17);
  for (const edgeId of ["copilot-lab", "pipeline-showcase", "github-intermediate"]) {
    assert.deepEqual(edgeOf(preset, edgeId).immutableGates.zeroDiffPaths, ZERO_DIFF, edgeId);
  }
  assert.deepEqual(edgeOf(preset, "ghec-admin").immutableGates.zeroDiffPaths, []);
});

test("AC47: none of the seventeen locked paths is included by any allowedFiles entry of any AI edge", () => {
  for (const [edgeId, list] of [["copilot-lab", COPILOT_LAB], ["pipeline-showcase", SHOWCASE], ["github-intermediate", INTERMEDIATE]]) {
    for (const locked of ZERO_DIFF) {
      for (const pattern of list) assert.equal(includes(pattern, locked), false, `${edgeId}: '${pattern}' includes locked '${locked}'`);
    }
  }
});

test("AC47: cascade-ai-copilot-lab's allowed-files contains none of the locked glob forms or the sibling experiences' test files", () => {
  const allowed = readWorkflow("cascade-ai-copilot-lab.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"];
  for (const excluded of [
    "experiences/copilot-workshop/src/**",
    "src/**",
    "scripts/**",
    "apps/lab-studio/server/src/{index,copilot-bridge,sandbox,sim-terminal,skills}.ts",
    "apps/lab-studio/server/src/index.ts",
    "apps/lab-studio/server/src/copilot-bridge.ts",
    "apps/lab-studio/server/src/sandbox.ts",
    "apps/lab-studio/server/src/sim-terminal.ts",
    "apps/lab-studio/server/src/skills.ts",
    "tests/github-intermediate-labs.test.ts",
    "tests/github-intermediate-workshop.test.ts",
    "tests/pipeline-showcase.test.ts",
  ]) {
    assert.equal(allowed.includes(excluded), false, excluded);
  }
});

test("AC48: the showcase and intermediate workflows set allowed-files to exactly the lists, in order", () => {
  assert.deepEqual(readWorkflow("cascade-ai-pipeline-showcase.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], SHOWCASE);
  assert.deepEqual(readWorkflow("cascade-ai-github-intermediate.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], INTERMEDIATE);
  assert.deepEqual(readWorkflow("cascade-mechanical-ghec-admin.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], MECHANICAL);
});

test("AC43/AC48: the allowed-files of the four cascade workflows are pairwise disjoint, so each surface has exactly one writer", () => {
  const acks = buildAcks(request);
  const lists = {
    "cascade-mechanical-ghec-admin": MECHANICAL,
    ...acks.ai.allowedFilesByWorkflow,
  };
  assert.deepEqual(Object.keys(lists), ["cascade-mechanical-ghec-admin", "cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate"]);
  const names = Object.keys(lists);
  for (let first = 0; first < names.length; first += 1) {
    for (let second = first + 1; second < names.length; second += 1) {
      for (const a of lists[names[first]]) {
        for (const b of lists[names[second]]) assert.equal(overlaps(a, b), false, `${names[first]} '${a}' overlaps ${names[second]} '${b}'`);
      }
    }
  }
});

test("AC48: the showcase workflow is the sole writer of its surfaces", () => {
  const surfaces = ["experiences/pipeline-showcase/", "public/pipeline-showcase/", "tests/pipeline-showcase.test.ts"];
  const acks = buildAcks(request).ai.allowedFilesByWorkflow;
  for (const [workflow, list] of Object.entries(acks)) {
    if (workflow === "cascade-ai-pipeline-showcase") continue;
    for (const entry of list) assert.equal(surfaces.some((surface) => entry.startsWith(surface) || entry === surface), false, `${workflow}: ${entry}`);
  }
});

const MUTATIONS = [
  ["a glob over the locked rules file", "experiences/copilot-workshop/content/*.ts"],
  ["the locked rules file itself", "experiences/copilot-workshop/content/rules.ts"],
  ["the locked source file", "experiences/copilot-workshop/content/source.ts"],
  ["the locked types file", "experiences/copilot-workshop/content/types.ts"],
  ["the sandbox test", "apps/lab-studio/server/tests/sandbox.test.ts"],
  ["a directory entry beneath src", "src/**"],
  ["a file beneath the locked src directory", "src/helper.ts"],
  ["a file beneath the locked scripts directory", "scripts/build.mjs"],
  ["the locked experience src directory", "experiences/copilot-workshop/src/index.ts"],
  ["a recursive glob over the lab-studio server sources", "apps/lab-studio/server/src/**"],
  ["a wildcard over the lab-studio server tests", "apps/lab-studio/server/tests/*.ts"],
  ["a locked test file", "tests/auth.test.ts"],
];

for (const [label, pattern] of MUTATIONS) {
  test(`AC52: adding ${label} (${pattern}) to the copilot-lab allowedFiles returns status error and writes nothing`, async () => {
    const mutated = mutate(preset, (copy) => edgeOf(copy, "copilot-lab").allowedFiles.push(pattern));
    const workspace = createWorkspace({ manifestText: toYaml(mutated), instructions: true });
    try {
      workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
      const before = workspace.hash();
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "error");
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => /^allowed-files-locked-path: /.test(error) && error.includes(`'${pattern}'`) && error.includes("'copilot-lab'")), errors.join("\n"));
      assert.equal(workspace.hash(), before, "no file is emitted");
      assert.equal(workspace.shims.compileCalls().length, 0);
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC52: the locked set comes from the edge's own zeroDiffPaths — the same pattern is fine when the edge locks nothing", () => {
  const relaxed = mutate(preset, (copy) => {
    const edge = edgeOf(copy, "ghec-admin");
    edge.allowedFiles.push("src/**");
  });
  const workspace = createWorkspace({ manifestText: toYaml(relaxed), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, "the mechanical edge has no zeroDiffPaths, so src/** is its own business");
  } finally {
    workspace.cleanup();
  }
  const customLock = mutate(preset, (copy) => {
    const edge = edgeOf(copy, "ghec-admin");
    edge.immutableGates.zeroDiffPaths = ["public/ghec-admin/schema"];
  });
  const second = createWorkspace({ manifestText: toYaml(customLock), instructions: true });
  try {
    const result = renderFleet(request, { cwd: second.dir });
    assert.equal(result.ok, false);
    assert.ok(result.result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("allowed-files-locked-path: ")));
  } finally {
    second.cleanup();
  }
});

test("AC52: the engine names none of the locked paths in its own code", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  assert.equal(/rules\.ts|sandbox\.test\.ts/.test(source), false);
  for (const locked of ZERO_DIFF.filter((entry) => entry.includes("/"))) assert.equal(source.includes(locked), false, locked);
});
