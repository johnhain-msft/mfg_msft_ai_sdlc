// AC1: the three helpers and the code they share are repository-agnostic engine code. None of it names a preset repository, path or test title; the policy comes from the sdlc.yaml of
// the working directory, and each helper completes against a synthetic fleet whose repositories, paths, constants and titles share nothing with the portfolio's. The reconciler renders the
// same fleet into a workflow whose every name is the fleet's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { HELPERS, REPO_ROOT, abs, commitAll, fixture, git, installVitestStub, jsonOf, readText, repoFrom, runNode, tempDir, writeFiles } from "./helpers/fixtures.mjs";
import { parseWorkflow, referenceRequest } from "./helpers/workflows.mjs";

const ENGINE = [
  "src/lab-studio-drift.mjs",
  "src/bump-studio-revision-pins.mjs",
  "src/verify-immutable-gates.mjs",
  "src/ai-pull-request-result.mjs",
  ...fs.readdirSync(abs("src", "adaptation")).filter((name) => name.endsWith(".mjs")).map((name) => `src/adaptation/${name}`),
];
const PRESET_NAMES = [
  "johnhain-msft/portfolio",
  "ms-mfg-community/day-in-the-life-copilot-lab",
  "ms-mfg-community/github-pipeline-showcase",
  "githubschool/gh-github-intermediate-template",
  "johnhain-msft",
  "ms-mfg-community",
  "githubschool",
  "day-in-the-life-copilot-lab",
  "github-pipeline-showcase",
  "gh-github-intermediate-template",
];
const PRESET_PATHS = [
  "experiences/copilot-workshop",
  "experiences/pipeline-showcase",
  "experiences/github-intermediate",
  "apps/lab-studio",
  "lab-sources.json",
  "source-inputs.json",
  "content/rules.ts",
  "customer-terms",
  "SOURCE_COMMIT",
  "copilot-project.html",
  "sync:workshop-source",
];
const PRESET_TITLES = ["passes every content rule", "keeps audience pages sparse", "pipeline-showcase animated SVG", "Lab 0 HTTPS prompts", "checkCourse", "findCustomerTerms", "SPEAKING_WPM", "AUDIENCE_WORDS"];
const FLEET = fixture("synthetic-fleet");

test("AC1: no engine file contains the name of a preset repository, a preset path, a preset constant or a preset test title", () => {
  assert.ok(ENGINE.length >= 11, `the engine files: ${ENGINE.join(", ")}`);
  for (const file of ENGINE) {
    const text = readText(abs(...file.split("/")));
    for (const name of [...PRESET_NAMES, ...PRESET_PATHS, ...PRESET_TITLES]) assert.equal(text.includes(name), false, `${file} names ${name}`);
  }
});

test("AC1/AC11/AC19/AC59: the helpers hold no merge, no state variable, no registry and no pace field (the rg checks of the spec)", () => {
  for (const file of ["src/lab-studio-drift.mjs", "src/bump-studio-revision-pins.mjs", "src/verify-immutable-gates.mjs"]) {
    const text = readText(abs(...file.split("/")));
    for (const banned of ["gh pr merge", "auto-merge: true", "--auto", "SDLC_SYNC_STATE", "actions/variables", "gh variable", "registry.yaml", "pace_workshop_minutes"]) {
      assert.equal(text.includes(banned), false, `${file}: ${banned}`);
    }
  }
});

/** The fleet's portfolio as a committed checkout, with the Vitest stand-in under node_modules. */
function fleetCheckout() {
  const { dir, base } = repoFrom(path.join(FLEET, "portfolio"), "sdlc-s4-fleet-");
  installVitestStub(dir, {
    success: true,
    testResults: [{ name: `/w/checks/site.test.ts`, status: "passed", assertionResults: [{ ancestorTitles: ["site guard rails"], title: "keeps the kernel limits", status: "passed" }] }],
  });
  return { dir, base };
}
const HEX = "9".repeat(40);

test("AC1: lab-studio-drift completes against the fleet's own manifest path, labs and revision: in-sync, then drift on a changed lab, then accepted, and only the fleet's manifest is rewritten", () => {
  const { dir } = fleetCheckout();
  const upstream = tempDir("sdlc-s4-fleet-upstream-");
  fs.cpSync(path.join(FLEET, "upstream"), upstream, { recursive: true });
  const args = ["--portfolio", dir, "--upstream", upstream, "--commit", HEX];
  const inSync = runNode(HELPERS.drift, args, { cwd: FLEET });
  assert.equal(inSync.code, 0, inSync.stderr);
  assert.equal(jsonOf(inSync.stdout).status, "in-sync");
  writeFiles(upstream, { "labs/lab09.md": `${readText(path.join(upstream, "labs", "lab09.md"))}\nA changed paragraph.\n` });
  const drift = runNode(HELPERS.drift, args, { cwd: FLEET });
  assert.equal(drift.code, 1, drift.stderr);
  assert.deepEqual(jsonOf(drift.stdout).changedLabs, ["lab09"]);
  const accepted = runNode(HELPERS.drift, [...args, "--accept"], { cwd: FLEET });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(jsonOf(accepted.stdout).status, "accepted");
  assert.deepEqual(git(dir, ["status", "--porcelain"]).stdout.split("\n").filter((line) => line !== ""), [" M studio/sources.json"], "only the manifest that the fleet's sdlc.yaml names");
});

test("AC1: bump-studio-revision-pins completes against the fleet's provenance files, pin files and constant", () => {
  const { dir } = fleetCheckout();
  const result = runNode(HELPERS.bump, ["--portfolio", dir, "--new-sha", HEX], { cwd: FLEET });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonOf(result.stdout).newSha, HEX);
  assert.match(readText(path.join(dir, "web", "revision.ts")), new RegExp(`PINNED_REVISION\\s*=\\s*["']${HEX}["']`));
  const changed = git(dir, ["status", "--porcelain"]).stdout.split("\n").filter((line) => line !== "").map((line) => line.slice(3)).sort();
  assert.deepEqual(changed, ["README.md", "web/revision.ts"], "exactly the fleet's pin files, never a provenance file");
});

test("AC1: verify-immutable-gates completes against the fleet's policy: ok for an editable change, a violation for a locked file, and a violation of a locked block", () => {
  const { dir, base } = fleetCheckout();
  writeFiles(dir, { "web/pages/p1.ts": "export const p1 = { lines: ['a calm first page'] };\n" });
  commitAll(dir, "an editable change");
  const args = ["--portfolio", dir, "--base", base, "--workflow", "cascade-ai-gadget-lessons"];
  const ok = runNode(HELPERS.gates, args, { cwd: FLEET, frozen: true });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(jsonOf(ok.stdout), { status: "ok", violatingFiles: [] });
  writeFiles(dir, { "ops/deploy.sh": "#!/bin/sh\necho changed\n" });
  commitAll(dir, "a locked change");
  const locked = runNode(HELPERS.gates, args, { cwd: FLEET, frozen: true });
  assert.equal(locked.code, 1);
  assert.deepEqual(jsonOf(locked.stdout), { status: "violation", violatingFiles: ["ops/deploy.sh"] });
  assert.equal(runNode(HELPERS.gates, ["--portfolio", dir, "--base", base, "--workflow", "cascade-ai-widget-site"], { cwd: FLEET, frozen: true }).code, 2, "the preset's workflow ids are unknown to this fleet");
});

test("AC1: the reconciler renders the same fleet into a workflow whose names, paths, reports, locked blocks and helper command are the fleet's, and which names no preset repository", () => {
  const rendered = renderFleet({ ...referenceRequest(), manifestPath: "sdlc.yaml" }, { cwd: FLEET });
  assert.ok(rendered.ok, JSON.stringify(rendered.result));
  const file = ".github/workflows/cascade-ai-gadget-lessons.md";
  const text = rendered.files.get(file);
  assert.ok(text, "the fleet's AI workflow is rendered");
  const { frontmatter, body } = parseWorkflow(text);
  assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["target-repo"], "acme-labs/widget-site");
  assert.deepEqual(frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], ["web/**", "checks/site.test.ts"]);
  assert.equal(frontmatter["post-steps"][2].run, 'node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/widget-site" --base "$BASE_SHA" --workflow cascade-ai-gadget-lessons');
  const capture = frontmatter["pre-agent-steps"].find((step) => step.name === "Capture the drift reports");
  assert.ok(capture.run.includes("cp /tmp/gh-aw/agent/preflight-1.txt /tmp/gh-aw/agent/lessons-drift.txt"), "the fleet's report name");
  assert.ok(body.includes("`lessons-drift.txt` (also `preflight-1.txt`)"));
  assert.ok(body.includes('`it("keeps the kernel limits")`') && body.includes('`describe("site guard rails")`'), "the fleet's locked blocks");
  assert.ok(body.includes("`kernel`") && body.includes("`ops/deploy.sh`"), "the fleet's locked paths");
  assert.ok(body.includes("sdlc/cascade-gadget-lessons"));
  for (const name of PRESET_NAMES) assert.equal(text.includes(name), false, `the fleet's workflow names ${name}`);
  assert.equal(/SDLC_SYNC_STATE_(?!GADGET_LESSONS)/.test(JSON.stringify(frontmatter)), false);
});

test("AC1: the policy is read from the sdlc.yaml of the working directory and nowhere else: a helper started where no sdlc.yaml exists decides nothing (exit 2)", () => {
  const { dir, base } = fleetCheckout();
  const elsewhere = tempDir("sdlc-s4-nowhere-");
  const result = runNode(HELPERS.gates, ["--portfolio", dir, "--base", base, "--workflow", "cascade-ai-gadget-lessons"], { cwd: elsewhere, frozen: true });
  assert.equal(result.code, 2);
  assert.equal(jsonOf(result.stdout), null);
  const drift = runNode(HELPERS.drift, ["--portfolio", dir, "--upstream", path.join(FLEET, "upstream"), "--commit", HEX], { cwd: elsewhere });
  assert.equal(drift.code, 2, "no manifest path, no run");
  assert.ok(REPO_ROOT.length > 0);
});
