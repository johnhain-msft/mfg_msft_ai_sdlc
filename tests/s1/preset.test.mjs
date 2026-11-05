// AC5, AC6 and AC7: the portfolio reference preset sdlc.yaml.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Ajv from "ajv";
import { abs, edgeOf, globMatches, presetManifest, projectOf, readJson, REPO_ROOT } from "./helpers/fixtures.mjs";

const manifest = presetManifest();
const validate = new Ajv({ allErrors: true, strict: true }).compile(readJson(abs("schemas", "sdlc.schema.json")));
const trackedFiles = (pathspec) =>
  spawnSync("git", ["ls-files", pathspec], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.split("\n").filter((line) => line !== "");

const FIVE_GATES = ["npm run typecheck", "npm run lint", "npm test", "npm run test:studio", "npm run test:browser"];
const AI_REBUILD = [
  "npm run build:workshop",
  "npm run build:experiences",
  'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain',
  "npm run build",
  "STUDIO_ORIGIN=https://studio.example.com npm run build:catalog",
];

function indexOfSequence(list, sequence) {
  let from = 0;
  const positions = [];
  for (const item of sequence) {
    const at = list.indexOf(item, from);
    if (at === -1) return null;
    positions.push(at);
    from = at + 1;
  }
  return positions;
}

test("AC5: sdlc.yaml validates against the schema", () => {
  assert.ok(validate(manifest), JSON.stringify(validate.errors));
});

test("AC5: git ls-files lists sdlc.yaml", () => {
  assert.deepEqual(trackedFiles("sdlc.yaml"), ["sdlc.yaml"]);
});

test("AC5: six project entries with the named keys and repositories", () => {
  assert.deepEqual(
    manifest.projects.map((project) => [project.projectKey, project.repo]),
    [
      ["gh-admin-msft", "johnhain-msft/gh-admin-msft"],
      ["copilot-lab", "ms-mfg-community/day-in-the-life-copilot-lab"],
      ["self-improving-agents", "ms-mfg-community/day-in-the-life-copilot-lab"],
      ["pipeline-showcase", "ms-mfg-community/github-pipeline-showcase"],
      ["github-intermediate", "githubschool/gh-github-intermediate-template"],
      ["portfolio", "johnhain-msft/portfolio"],
    ],
  );
});

test("AC5: driftAudit.enabled is true for exactly gh-admin-msft, copilot-lab and self-improving-agents", () => {
  const enabled = manifest.projects.filter((project) => project.driftAudit.enabled).map((project) => project.projectKey);
  assert.deepEqual(enabled, ["gh-admin-msft", "copilot-lab", "self-improving-agents"]);
});

test("AC5: each drift-enabled project has an https watchUrl, runnable verifyCommands and instructions", () => {
  for (const key of ["gh-admin-msft", "copilot-lab", "self-improving-agents"]) {
    const audit = projectOf(manifest, key).driftAudit;
    assert.ok(audit.knowledgeSources.watchUrls.length >= 1, `${key} watchUrls`);
    for (const entry of audit.knowledgeSources.watchUrls) assert.equal(new URL(entry.url).protocol, "https:", `${key} ${entry.url}`);
    assert.ok(audit.verifyCommands.some((command) => command.trim() !== ""), `${key} verifyCommands`);
    assert.ok(audit.instructions.trim() !== "" || audit.instructionsFile !== null, `${key} instructions`);
  }
});

test("AC5: reviewers are non-empty for gh-admin-msft and every project defaults deconflictInRepoSchedules to none", () => {
  assert.ok(projectOf(manifest, "gh-admin-msft").driftAudit.reviewers.length > 0);
  for (const project of manifest.projects) {
    assert.equal(project.deconflictInRepoSchedules, "none", project.projectKey);
    assert.deepEqual(project.deconflictWorkflowIds, [], project.projectKey);
  }
});

test("AC6: exactly four edges, all into the portfolio, with the named modes, slugs, state variables and files", () => {
  const edges = manifest.dependencyEdges;
  assert.deepEqual(edges.map((edge) => edge.edgeId), ["ghec-admin", "copilot-lab", "pipeline-showcase", "github-intermediate"]);
  for (const edge of edges) assert.equal(edge.downstreamRepo, "johnhain-msft/portfolio");
  const ghec = edgeOf(manifest, "ghec-admin");
  assert.equal(ghec.mode, "mechanical");
  assert.equal(ghec.upstreamRepo, "johnhain-msft/gh-admin-msft");
  assert.equal(ghec.upstreamKey, "gh-admin-msft");
  assert.equal(ghec.upstreamSlug, "GH_ADMIN_MSFT");
  assert.equal(ghec.stateVariable, "SDLC_SYNC_STATE_GH_ADMIN_MSFT");
  assert.deepEqual(ghec.allowedFiles, ["public/ghec-admin/**"]);
  for (const [edgeId, slug] of [["copilot-lab", "COPILOT_LAB"], ["pipeline-showcase", "PIPELINE_SHOWCASE"], ["github-intermediate", "GITHUB_INTERMEDIATE"]]) {
    const edge = edgeOf(manifest, edgeId);
    assert.equal(edge.mode, "ai-adaptation", edgeId);
    assert.equal(edge.upstreamSlug, slug, edgeId);
    assert.equal(edge.stateVariable, `SDLC_SYNC_STATE_${slug}`, edgeId);
  }
});

test("AC6: per-edge derived values, baselines and reviewers", () => {
  for (const edge of manifest.dependencyEdges) {
    const upstream = manifest.projects.find((project) => project.projectKey === edge.upstreamKey);
    assert.ok(upstream, `${edge.edgeId}: upstreamKey names a project`);
    assert.equal(upstream.repo, edge.upstreamRepo, edge.edgeId);
    assert.equal(edge.branchName, `sdlc/cascade-${edge.edgeId}`);
    assert.equal(edge.closeOlderKey, `sdlc-cascade-${edge.edgeId}`);
    assert.match(edge.initialBaselineSha, /^[0-9a-f]{40}$/);
    assert.ok(edge.reviewers.length > 0, `${edge.edgeId} reviewers`);
    assert.equal(edge.autoMerge, false);
  }
});

test("AC6: branchName, closeOlderKey, upstreamKey and stateVariable are pairwise distinct and the graph is acyclic", () => {
  const edges = manifest.dependencyEdges;
  for (const key of ["branchName", "closeOlderKey", "upstreamKey", "stateVariable"]) {
    assert.equal(new Set(edges.map((edge) => edge[key])).size, edges.length, `${key} values are distinct`);
  }
  const upstreams = new Set(edges.map((edge) => edge.upstreamRepo));
  for (const edge of edges) assert.equal(upstreams.has(edge.downstreamRepo), false, `${edge.downstreamRepo} is never an upstream`);
});

test("AC7: the ghec-admin edge imports through <checkout> and records its provenance in public/ghec-admin/source.json", () => {
  const edge = edgeOf(manifest, "ghec-admin");
  assert.ok(edge.importCommands.includes("npm run import:ghec-admin -- <checkout>"));
  assert.equal(edge.provenanceFile, "public/ghec-admin/source.json");
  assert.equal(edge.provenanceJsonPointer, "/commit");
});

test("AC7: the copilot-lab edge carries the sync, accept and build commands and the source-inputs.json baseline", () => {
  const edge = edgeOf(manifest, "copilot-lab");
  assert.ok(edge.preflightCommands.includes("npm run sync:workshop-source -- <checkout>"));
  assert.ok(edge.acceptCommands.includes("npm run sync:workshop-source -- <checkout> --accept"));
  assert.ok(edge.buildCommands.includes("npm run build:workshop"));
  assert.equal(edge.provenanceFile, "experiences/copilot-workshop/source-inputs.json");
  assert.equal(edge.provenanceJsonPointer, "/commit");
  assert.notEqual(edge.provenanceFile, "apps/lab-studio/lab-sources.json");
  assert.notEqual(edge.provenanceFile, "experiences/copilot-workshop/provenance.json");
});

test("AC7: the pipeline-showcase edge references fetch-run-data.mjs in one of its command arrays", () => {
  const edge = edgeOf(manifest, "pipeline-showcase");
  const arrays = [edge.preflightCommands, edge.acceptCommands, edge.buildCommands];
  assert.ok(arrays.some((commands) => commands.includes("node experiences/pipeline-showcase/capture/fetch-run-data.mjs")));
  assert.equal(edge.provenanceFile, "experiences/pipeline-showcase/content/provenance.json");
});

test("AC7: the github-intermediate edge has its own provenance file", () => {
  assert.equal(edgeOf(manifest, "github-intermediate").provenanceFile, "experiences/github-intermediate-labs/provenance.json");
});

test("AC7: every edge's verifyCommands list the five portfolio gates in order", () => {
  for (const edge of manifest.dependencyEdges) {
    assert.notEqual(indexOfSequence(edge.verifyCommands, FIVE_GATES), null, `${edge.edgeId} lists the five gates in order`);
  }
});

test("AC7: the verifyCommands of each AI edge begin with the five rebuild and catalog commands, then the gates", () => {
  for (const edge of manifest.dependencyEdges.filter((candidate) => candidate.mode === "ai-adaptation")) {
    assert.deepEqual(edge.verifyCommands.slice(0, 5), AI_REBUILD, `${edge.edgeId} rebuild commands`);
    assert.deepEqual(edge.verifyCommands.slice(5, 10), FIVE_GATES, `${edge.edgeId} gates`);
    for (const extra of edge.verifyCommands.slice(10)) assert.ok(extra.trimStart().startsWith("#"), `${edge.edgeId}: post-run checks start with a comment`);
  }
});

test("AC7: every provenanceFile matches one of its edge's allowedFiles", () => {
  for (const edge of manifest.dependencyEdges) {
    assert.ok(
      edge.allowedFiles.some((pattern) => globMatches(pattern, edge.provenanceFile)),
      `${edge.edgeId}: ${edge.provenanceFile} is covered by allowedFiles`,
    );
  }
});

test("AC7: no importCommands or preflightCommands entry spells the upstream path other than as <checkout>", () => {
  for (const edge of manifest.dependencyEdges) {
    for (const command of [...edge.importCommands, ...edge.preflightCommands]) {
      assert.equal(/upstream\//.test(command.replace(/--upstream\b/g, "")), false, `${edge.edgeId}: ${command}`);
      assert.equal(command.includes("$GITHUB_WORKSPACE/upstream"), false, `${edge.edgeId}: ${command}`);
    }
  }
});
