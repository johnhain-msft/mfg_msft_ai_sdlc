// AC43 (disjoint writers), AC46, AC47 and AC48: the allowed-files and the locked paths of the AI edges of THIS fleet. The behaviour of the engine that reads them (the list comes
// from the manifest, a pattern that includes a locked path is refused, the locked set is the edge's own) is tested in the engine, over its own example fleet. What is pinned here is
// the data of this repository: the exact lists, in order, in the manifest, in the generated workflows and in the acknowledgement that the renderer gives.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks } from "ai-sdlc-factory/reconcile";
import { edgeOf, globMatches, presetManifest, readWorkflow, referenceRequest } from "./helpers/fixtures.mjs";

const request = referenceRequest();
const preset = presetManifest();

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
  "apps/lab-studio/client/src/labs/**",
  "apps/lab-studio/client/src/components/Home.tsx",
  "apps/lab-studio/client/src/components/Manual.tsx",
  "apps/lab-studio/client/src/components/Rail.tsx",
  "apps/lab-studio/client/src/styles.css",
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
const INTERMEDIATE = ["public/github-intermediate/**"];
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
  "apps/lab-studio/client/src/hosted.ts",
  "apps/lab-studio/client/src/components/AccountBar.tsx",
];

/** AC52 "includes": equal, beneath a directory entry, matched as a glob, or matched by it. */
function includes(pattern, locked) {
  const entry = locked.replace(/\/+$/, "");
  const candidate = pattern.replace(/\/+$/, "");
  return candidate === entry || candidate.startsWith(`${entry}/`) || globMatches(candidate, entry) || globMatches(entry, candidate);
}
const overlaps = (a, b) => includes(a, b) || includes(b, a);

test("AC46: the 23 entries of cascade-ai-copilot-lab allowed-files equal the list, in order", () => {
  assert.equal(COPILOT_LAB.length, 23);
  assert.deepEqual(edgeOf(preset, "copilot-lab").allowedFiles, COPILOT_LAB);
  const handler = readWorkflow("cascade-ai-copilot-lab.md").frontmatter["safe-outputs"]["create-pull-request"];
  assert.deepEqual(handler["allowed-files"], COPILOT_LAB);
  assert.deepEqual(buildAcks(request).ai.allowedFilesByWorkflow["cascade-ai-copilot-lab"], COPILOT_LAB);
});

test("AC47: the zeroDiffPaths of every AI edge equal the nineteen entries, in order", () => {
  assert.equal(ZERO_DIFF.length, 19);
  for (const edgeId of ["copilot-lab", "pipeline-showcase"]) {
    assert.deepEqual(edgeOf(preset, edgeId).immutableGates.zeroDiffPaths, ZERO_DIFF, edgeId);
  }
  assert.deepEqual(edgeOf(preset, "ghec-admin").immutableGates.zeroDiffPaths, []);
  assert.deepEqual(edgeOf(preset, "github-intermediate").immutableGates.zeroDiffPaths, []);
});

test("AC47: none of the nineteen locked paths is included by any allowedFiles entry of any AI edge", () => {
  for (const [edgeId, list] of [["copilot-lab", COPILOT_LAB], ["pipeline-showcase", SHOWCASE]]) {
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
    "apps/lab-studio/client/src/hosted.ts",
    "apps/lab-studio/client/src/components/AccountBar.tsx",
    "tests/github-intermediate-labs.test.ts",
    "tests/github-intermediate-workshop.test.ts",
    "tests/pipeline-showcase.test.ts",
  ]) {
    assert.equal(allowed.includes(excluded), false, excluded);
  }
});

test("AC48: the showcase and intermediate workflows set allowed-files to exactly the lists, in order", () => {
  assert.deepEqual(readWorkflow("cascade-ai-pipeline-showcase.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], SHOWCASE);
  assert.deepEqual(readWorkflow("cascade-mechanical-github-intermediate.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], INTERMEDIATE);
  assert.deepEqual(readWorkflow("cascade-mechanical-ghec-admin.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], MECHANICAL);
});

test("AC43/AC48: the allowed-files of the four cascade workflows are pairwise disjoint, so each surface has exactly one writer", () => {
  const acks = buildAcks(request);
  const lists = {
    "cascade-mechanical-ghec-admin": MECHANICAL,
    "cascade-mechanical-github-intermediate": INTERMEDIATE,
    ...acks.ai.allowedFilesByWorkflow,
  };
  assert.deepEqual(Object.keys(lists), ["cascade-mechanical-ghec-admin", "cascade-mechanical-github-intermediate", "cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase"]);
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
