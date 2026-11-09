// AC56: the onboarding workflow sdlc-onboard.md and the .github/workflows/shared/*.md fragments it may import.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, renderFleet } from "../../src/reconcile.mjs";
import { abs, fixture, loadRenderedFixture, minimalManifest, parseWorkflow, readText, readWorkflow, referenceRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const NAME = "sdlc-onboard.md";
const request = referenceRequest();
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };

test("AC56: the golden file equals the generated file, freshly rendered and as committed", () => {
  const rendered = renderFleet(request).files.get(`${W}/${NAME}`);
  assert.equal(readText(fixture("golden", NAME)), rendered);
  assert.equal(readText(abs(W, NAME)), rendered);
});

test("AC56: on.workflow_dispatch.inputs are exactly the eight options of the bin/sdlc-onboard.mjs invocation, each a string", () => {
  const { frontmatter } = readWorkflow(NAME);
  const inputs = frontmatter.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["repo", "downstream", "strategy", "watch_url", "schedule", "mode", "instructions", "manifest"]);
  for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", name);
});

test("AC56: it is rendered under the policy of AC22: on.bots, threat-detection, an explicit protected-files policy, no auto-merge", () => {
  const { frontmatter } = readWorkflow(NAME);
  assert.deepEqual(frontmatter.on.bots, ["mfg-msft-ai-sdlc[bot]"]);
  assert.deepEqual(frontmatter["safe-outputs"]["github-app"], APP);
  assert.deepEqual(frontmatter["safe-outputs"]["threat-detection"], { "continue-on-error": false });
  const handler = frontmatter["safe-outputs"]["create-pull-request"];
  assert.equal(handler["auto-merge"], false);
  assert.equal(handler["exclude-lock-yml"], true);
  assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: [] });
  assert.equal(handler["close-older-pull-requests"], true);
  assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.deepEqual(frontmatter.checkout[0]["github-app"], APP);
  assert.equal(frontmatter.checkout[0].current, true);
  assert.ok(frontmatter.engine);
});

test("AC56: the prompt names the CLI of contract C10 and both forms of the repository argument", () => {
  const { body } = readWorkflow(NAME);
  assert.ok(body.includes("node bin/sdlc-onboard.mjs"));
  assert.ok(/--repo <repo>/.test(body));
  assert.ok(/positional `<owner\/repo>`/.test(body));
  for (const flag of ["--downstream", "--strategy", "--watch-url", "--schedule", "--mode", "--instructions", "--manifest"]) assert.ok(body.includes(flag), flag);
  assert.equal(/git push|gh pr /.test(body), false);
});

test("AC56: the onboarding workflow is part of generatedWorkflows and its own concurrency group", () => {
  const { frontmatter } = readWorkflow(NAME);
  assert.deepEqual(frontmatter.concurrency, { group: "sdlc-onboard", "cancel-in-progress": false });
  const result = renderFleet(request);
  assert.ok(result.workflows.some((workflow) => workflow.id === "sdlc-onboard" && workflow.sourceMd === `${W}/${NAME}`));
});

test("AC56: the onboarding workflow is rendered for any manifest, including one that has no drift project", () => {
  const workspace = createWorkspace({ manifestText: readText(fixture("manifest.minimal.yaml")) });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok);
    assert.ok(result.files.has(`${W}/${NAME}`));
  } finally {
    workspace.cleanup();
  }
});

function withImport(files, importPath) {
  const copy = new Map(files);
  const name = `${W}/drift-alpha-service.md`;
  const { frontmatter, body } = parseWorkflow(copy.get(name));
  frontmatter.imports = [importPath];
  copy.set(name, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
  return copy;
}

test("AC56: a fixture that imports shared/x.md resolves when the fragment is among the rendered files", () => {
  const files = withImport(loadRenderedFixture(), "shared/x.md");
  files.set(`${W}/shared/x.md`, "# Shared fragment\n");
  const results = checkRendered(files, request, minimalManifest());
  assert.deepEqual(results.filter((entry) => !entry.valid), [], JSON.stringify(results.filter((entry) => !entry.valid)));
});

test("AC56: a fixture that imports a missing file is rejected, naming the workflow and the import", () => {
  const files = withImport(loadRenderedFixture(), "shared/missing.md");
  const entry = checkRendered(files, request, minimalManifest()).find((candidate) => candidate.file === `${W}/drift-alpha-service.md`);
  assert.equal(entry.valid, false);
  assert.ok(entry.errors.some((error) => /^import-unresolved: /.test(error) && error.includes("shared/missing.md")), entry.errors.join("\n"));
});

test("AC56: a reconcile run removes a shared fragment that no workflow imports and keeps one that a workflow in the directory imports", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write(`${W}/shared/orphan.md`, "# nobody imports me\n");
    workspace.write(`${W}/shared/kept.md`, "# imported by a hand-written workflow\n");
    workspace.write(`${W}/hand-written.md`, "---\non: workflow_dispatch\nimports:\n  - shared/kept.md\n---\n\n# Hand written\n");
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(workspace.exists(`${W}/shared/orphan.md`), false, "an unimported fragment is removed");
    assert.equal(workspace.exists(`${W}/shared/kept.md`), true, "an imported fragment stays");
    assert.equal(workspace.exists(`${W}/hand-written.md`), true, "a workflow that S1 did not generate is never removed");
  } finally {
    workspace.cleanup();
  }
});

test("AC56: no generated workflow of the default preset imports a fragment, so none is rendered", () => {
  const files = [...renderFleet(request).files.keys()];
  assert.equal(files.some((file) => file.includes("/shared/")), false);
  for (const [, text] of renderFleet(request).files) {
    if (!text.startsWith("---\n")) continue;
    assert.equal("imports" in parseWorkflow(text).frontmatter, false);
  }
});
