// The reproductions that the QA stage recorded for five findings of round 2 (AC10, AC11, AC21, AC32, AC71).
// Each test states the contract that was broken, not the broken behavior, and fails without the matching fix.
// They run with `npm test`; tests/s1/fixtures/qa-regressions.mjs re-exports this file so that the QA
// reproduction command `node --test tests/s1/fixtures/qa-regressions.mjs` keeps working.
// The AC71 test needs the pinned compiler: set SDLC_REAL_GH_AW=1 to run it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, ghAwEnvironment, reconcile, renderFleet } from "../../src/reconcile.mjs";
import { abs, loadRenderedFixture, minimalManifest, parseWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { recordWrites } from "./helpers/fs-spy.mjs";
import { BashSandbox } from "./helpers/bash-runtime.mjs";

test("AC21 regression: instructionsFile is repository-relative even when manifestPath is in a subdirectory", (t) => {
  const manifest = minimalManifest();
  manifest.projects[0].driftAudit.instructionsFile = "instructions/alpha.md";
  const work = createWorkspace({
    manifestText: toYaml(manifest),
    files: { "config/fleet.yaml": toYaml(manifest), "instructions/alpha.md": "Existing repository-root instruction file\n" },
  });
  t.after(() => work.cleanup());
  const result = renderFleet({ ...referenceRequest(), manifestPath: "config/fleet.yaml" }, { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.ok(result.files.get(".github/workflows/drift-alpha-service.md").includes("Existing repository-root instruction file"));
});

test("AC11 regression: malformed threat-detection scalars and arrays cannot pass the required detection policy", () => {
  const file = ".github/workflows/drift-alpha-service.md";
  const accepted = [];
  for (const detection of [true, "disabled", 17, []]) {
    const files = loadRenderedFixture();
    const { frontmatter, body } = parseWorkflow(files.get(file));
    frontmatter["safe-outputs"]["threat-detection"] = detection;
    files.set(file, `---\n${YAML.stringify(frontmatter)}---\n${body}`);
    const entry = checkRendered(files, referenceRequest(), minimalManifest()).find((item) => item.file === file);
    if (entry.valid) accepted.push(detection);
  }
  assert.deepEqual(accepted, [], "requireThreatDetection must reject values without continue-on-error: false");
});

test("AC10 regression: a dry run must not write into the working tree when staging git init fails", async (t) => {
  const work = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  t.after(() => work.cleanup());
  const launcher = path.join(work.shims.directory, process.platform === "win32" ? "git.cmd" : "git");
  fs.writeFileSync(launcher, process.platform === "win32" ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  const before = work.hash(["."]);
  const writes = await recordWrites(async () => {
    await work.reconcile({ ...referenceRequest(), dryRun: true });
  });
  assert.equal(work.hash(["."]), before, "restoring final bytes is necessary, but not a no-write dry run");
  const inside = writes.filter((file) => file.startsWith(`${work.dir}${path.sep}`));
  assert.deepEqual(inside, [], "dryRun is not allowed to temporarily overwrite real workflow files");
});

test("AC32 regression: a single-star allowed-files pattern must not admit nested changed files", (t) => {
  const manifest = minimalManifest();
  manifest.dependencyEdges[0].allowedFiles = ["docs/*.md"];
  manifest.dependencyEdges[0].provenanceFile = "docs/source.md";
  const work = createWorkspace({ manifestText: toYaml(manifest) });
  const box = new BashSandbox();
  t.after(() => { work.cleanup(); box.cleanup(); });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true);
  const { frontmatter } = parseWorkflow(result.files.get(".github/workflows/cascade-mechanical-alpha-to-beta.md"));
  const script = frontmatter["post-steps"].find((step) => step.name === "Verify changed paths are covered by the allowed files").run;
  const base = box.revision("beta-docs", { "docs/source.md": "original\n" });
  box.revision("beta-docs", { "docs/source.md": "original\n", "docs/nested/forbidden.md": "outside the single-star glob\n" }, base);
  const outcome = box.run(script, { BASE_SHA: base });
  assert.equal(outcome.status, 1, "docs/*.md does not cover docs/nested/forbidden.md");
});

test("AC71 regression: api-key with the valid secret name OPENAI_API_KEY must compile under the pinned compiler", {
  skip: process.env.SDLC_REAL_GH_AW !== "1" ? "set SDLC_REAL_GH_AW=1 for the real compiler reproduction" : false,
}, async (t) => {
  const manifest = minimalManifest();
  manifest.engineApiKeySecret = "OPENAI_API_KEY";
  const work = createWorkspace({ manifestText: toYaml(manifest) });
  t.after(() => work.cleanup());
  work.write(".github/aw/actions-lock.json", fs.readFileSync(abs(".github", "aw", "actions-lock.json")));
  const result = await reconcile({ ...referenceRequest(), engineAuthMode: "api-key" }, {
    cwd: work.dir,
    env: ghAwEnvironment(process.env),
  });
  assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
});
