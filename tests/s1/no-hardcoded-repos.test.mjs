// AC59: the engine is repository-agnostic; every repository name and path of the preset is data.
import assert from "node:assert/strict";
import test from "node:test";
import { abs, fixture, listFiles, presetManifest, readText, referenceRequest, REPO_ROOT } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const manifest = presetManifest();

/** The engine files: src/reconcile.mjs and every module it imports from src/, plus the schema. */
function engineFiles() {
  const files = new Set(["src/reconcile.mjs", "schemas/sdlc.schema.json"]);
  const queue = ["src/reconcile.mjs"];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const match of readText(abs(file)).matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const resolved = new URL(match[1], new URL(`file:///${file}`)).pathname.replace(/^\//, "");
      if (!files.has(resolved)) {
        files.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...files];
}

const repositories = [
  ...manifest.projects.map((project) => project.repo),
  ...manifest.dependencyEdges.flatMap((edge) => [edge.upstreamRepo, edge.downstreamRepo]),
];
const presetPaths = [
  ...manifest.dependencyEdges.flatMap((edge) => [...edge.allowedFiles, ...edge.immutableGates.zeroDiffPaths, edge.provenanceFile]),
].filter((entry) => entry.includes("/"));

test("AC59: the engine and its imports are exactly the files this test inspects", () => {
  const files = engineFiles();
  assert.ok(files.includes("src/reconcile.mjs") && files.includes("schemas/sdlc.schema.json"));
  assert.deepEqual(files.filter((file) => file.startsWith("src/")), ["src/reconcile.mjs"], "the engine is one module; update this test when it is split");
});

test("AC59: no repo, upstreamRepo or downstreamRepo value of sdlc.yaml appears in the engine files", () => {
  assert.equal(new Set(repositories).size, 8, "eight distinct repositories in the preset");
  for (const file of engineFiles()) {
    const text = readText(abs(file));
    for (const repository of new Set(repositories)) {
      assert.equal(text.includes(repository), false, `${file} contains ${repository}`);
      assert.equal(text.toLowerCase().includes(repository.toLowerCase()), false, `${file} contains ${repository} (case-insensitive)`);
      // The bare repository name must not appear either; `--portfolio` is the name of an S4 helper option, not a repository.
      const bare = repository.split("/")[1];
      assert.equal(text.replaceAll("--portfolio", "").includes(bare), false, `${file} contains the repository name ${bare}`);
    }
  }
});

test("AC59: the criterion's own scan finds nothing: no owner of the preset and no orchestrator repository name", () => {
  const owners = new RegExp(["johnhain-msft", "ms-mfg-community", "githubschool", "mfg_msft_ai_sdlc"].join("|"));
  for (const file of ["src/reconcile.mjs", "schemas/sdlc.schema.json"]) assert.equal(owners.test(readText(abs(file))), false, file);
});

test("AC59: none of the preset's file paths appears in the engine", () => {
  assert.ok(presetPaths.length > 20);
  for (const file of engineFiles()) {
    const text = readText(abs(file));
    for (const entry of new Set(presetPaths)) assert.equal(text.includes(entry), false, `${file} contains ${entry}`);
    for (const fragment of ["experiences/copilot-workshop", "experiences/pipeline-showcase", "experiences/github-intermediate", "public/ghec-admin", "public/ai-sdlc", "apps/lab-studio", "dist-catalog"]) {
      assert.equal(text.includes(fragment), false, `${file} contains ${fragment}`);
    }
  }
});

test("AC59: no command of the preset is hard-coded either", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  for (const command of ["import:ghec-admin", "import:ai-sdlc", "sync:workshop-source", "build:workshop", "build:experiences", "build:catalog", "test:studio", "test:browser", "fetch-run-data"]) {
    assert.equal(source.includes(command), false, command);
  }
});

test("AC59: the fixture manifest with other owners and repositories renders valid workflows", async () => {
  const workspace = createWorkspace({ manifestText: readText(fixture("manifest.minimal.yaml")) });
  try {
    const result = await workspace.reconcile(JSON.parse(readText(fixture("request.reference.json"))));
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.deepEqual(result.generatedWorkflows.map((pair) => pair.sourceMd), [
      ".github/workflows/cascade-mechanical-alpha-to-beta.md",
      ".github/workflows/drift-alpha-service.md",
      ".github/workflows/implement-alpha-service.md",
      ".github/workflows/sdlc-onboard.md",
    ]);
    const text = workspace.list(".github/workflows").filter((file) => file.endsWith(".md") || file.endsWith(".yml")).map((file) => workspace.read(file)).join("\n");
    for (const repository of new Set(repositories)) assert.equal(text.includes(repository), false, `the minimal render mentions ${repository}`);
    assert.ok(text.includes("acme-labs/alpha-service") && text.includes("globex-corp/beta-docs"));
  } finally {
    workspace.cleanup();
  }
});

test("AC59: the reconciler engine is self-contained in src/reconcile.mjs and imports none of the other streams' modules", () => {
  const sources = listFiles(REPO_ROOT, "src");
  assert.ok(sources.includes("src/reconcile.mjs"));
  assert.deepEqual(engineFiles().filter((file) => file.startsWith("src/")), ["src/reconcile.mjs"]);
  assert.ok(referenceRequest());
});
