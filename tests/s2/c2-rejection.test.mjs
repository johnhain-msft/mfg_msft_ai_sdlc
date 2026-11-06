// AC6: contract C2 error handoff, compile time (S1 implements, SPEC-01). A driftAudit entry with an invalid or wildcard URL in watchUrls,
// without instructions and instructionsFile, without a runnable verifyCommands entry, without the values that make up the
// close-older-key, or without the repository that the target-repo checkout maps, makes the reconciler reject the compilation and write no
// drift-*.md or .lock.yml file. One fixture per condition, each run through the real reconciler in a temporary copy of the repository.
//
// The close-older-key of a drift workflow is sdlc-drift-<projectKey> and its checkout mapping is the project's repo, both derived by
// the renderer (SPEC-01); neither is a key of the manifest. The fixtures no-close-older-key and no-target-checkout therefore omit the
// project key and the repository, and the schema refuses the manifest. The renderer's own gate for the rendered text (a drift workflow
// that lacks the mapping or the key) is exercised on the committed workflows below.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkRendered } from "../../src/reconcile.mjs";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflowText, fixture, presetManifest, readText, referenceRequest, WORKFLOWS } from "./helpers/fixtures.mjs";
import { git } from "./helpers/git-fixture.mjs";
import { withoutTopLevelKey } from "./helpers/lab-fixture.mjs";

const CASES = [
  { name: "invalid-watchurl", rule: "drift-watch-url-invalid", project: "bad-url", detail: "'not a url' is not an absolute URL" },
  { name: "wildcard-watchurl", rule: "drift-watch-url-invalid", project: "wildcard-url", detail: "has a wildcard host" },
  { name: "no-instructions", rule: "drift-instructions-missing", project: "no-instructions", detail: "instructions and instructionsFile are both empty" },
  { name: "no-verify-commands", rule: "drift-verify-commands-missing", project: "no-verify", detail: "verifyCommands must contain at least one runnable command" },
  { name: "no-close-older-key", rule: "schema-validation", project: null, detail: "projects/0/projectKey: must have required property 'projectKey'" },
  { name: "no-target-checkout", rule: "schema-validation", project: null, detail: "projects/0/repo: must have required property 'repo'" },
];

/** A temporary copy of the repository: the committed .github/, the instructions and the fixture manifest, as a clean git repository. */
function repositoryCopy(fixtureName) {
  const workspace = createWorkspace({ manifestText: readText(fixture("c2", fixtureName, "sdlc.yaml")), instructions: true });
  fs.cpSync(abs(".github"), workspace.path(".github"), { recursive: true });
  if (fs.existsSync(abs(".gitattributes"))) fs.copyFileSync(abs(".gitattributes"), workspace.path(".gitattributes"));
  git(workspace.dir, ["config", "user.email", "fixture@example.invalid"]);
  git(workspace.dir, ["config", "user.name", "Fixture"]);
  git(workspace.dir, ["config", "core.autocrlf", "false"]);
  git(workspace.dir, ["config", "commit.gpgsign", "false"]);
  git(workspace.dir, ["add", "-A"]);
  git(workspace.dir, ["commit", "-q", "-m", "base"]);
  const request = path.join(workspace.root, "request.json");
  fs.writeFileSync(request, JSON.stringify(referenceRequest()));
  return { workspace, request, workflowStatus: () => git(workspace.dir, ["status", "--porcelain", "--untracked-files=all", "--", ".github/workflows"]) };
}

const errorsOf = (outcome) => (outcome.json?.validationResults ?? []).flatMap((entry) => entry.errors ?? []);

for (const { name, rule, project, detail } of CASES) {
  test(`AC6: the fixture ${name} is rejected by the reconciler with a non-zero exit code and no drift workflow written`, () => {
    const { workspace, request, workflowStatus } = repositoryCopy(name);
    try {
      const committed = workspace.list(".github/workflows");
      assert.ok(committed.some((file) => /\/drift-.+\.lock\.yml$/.test(file)), "the copy holds the committed drift workflows, so that a deletion or a rewrite would be seen");
      assert.equal(workflowStatus(), "", "the copy starts clean");
      const before = workspace.hash();
      const outcome = workspace.cli(request);
      assert.notEqual(outcome.code, 0, `exit code of ${name}: ${outcome.stdout}${outcome.stderr}`);
      assert.equal(outcome.json?.status, "error");
      assert.deepEqual(outcome.json.generatedWorkflows, [], "no workflow is reported as generated");
      const errors = errorsOf(outcome);
      assert.ok(errors.some((error) => error.startsWith(`${rule}: `) && error.includes(detail)), `${rule} / ${detail} in ${errors.join(" | ")}`);
      if (project !== null) assert.ok(errors.some((error) => error.includes(`project '${project}'`)), `the project is named: ${errors.join(" | ")}`);
      assert.equal(workflowStatus(), "", "git status --porcelain .github/workflows is empty afterwards");
      assert.equal(workspace.hash(), before, "and so is every file of .github and .gitattributes");
      assert.deepEqual(workspace.list(".github/workflows"), committed, "no workflow file was added or removed");
      assert.equal(workspace.shims.compileCalls().length, 0, "the compiler is never reached");
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC6: a control manifest with every drift audit disabled is accepted by the same harness, which does see a change in .github/workflows", () => {
  const { workspace, request, workflowStatus } = repositoryCopy("disabled");
  try {
    const outcome = workspace.cli(request);
    assert.equal(outcome.code, 0, `${outcome.stdout}${outcome.stderr}`);
    assert.equal(outcome.json.status, "ok");
    assert.notEqual(workflowStatus(), "", "the successful run changed the workflows, so the empty status of the rejections above is a real observation");
    assert.equal(workspace.list(".github/workflows").some((file) => /\/drift-.+\.md$/.test(file)), false, "and a disabled audit renders no drift workflow");
  } finally {
    workspace.cleanup();
  }
});

test("AC6: the committed drift workflows pass the reconciler's rendered-file gate", () => {
  const files = new Map(DRIFT_KEYS.map((key) => [`${WORKFLOWS}/drift-${key}.md`, driftWorkflowText(key)]));
  const entries = checkRendered(files, referenceRequest(), presetManifest()).filter((entry) => entry.file.includes("/drift-"));
  assert.equal(entries.length, DRIFT_KEYS.length);
  for (const entry of entries) assert.deepEqual(entry.errors, [], `${entry.file}: ${entry.errors.join(" | ")}`);
});

for (const key of DRIFT_KEYS) {
  test(`AC6: the rendered-file gate refuses drift-${key}.md without its target-repo checkout mapping`, () => {
    const mutated = withoutTopLevelKey(driftWorkflowText(key), "checkout");
    assert.notEqual(mutated, driftWorkflowText(key));
    const entries = checkRendered(new Map([[`${WORKFLOWS}/drift-${key}.md`, mutated]]), referenceRequest(), presetManifest());
    const entry = entries.find((candidate) => candidate.file.endsWith(`drift-${key}.md`));
    assert.equal(entry.valid, false);
    assert.ok(entry.errors.some((error) => error.startsWith("drift-checkout-mapping-missing: ") && error.includes(`project '${key}'`) && error.includes(driftPreset(key).repo)), entry.errors.join("\n"));
  });

  test(`AC6: the rendered-file gate refuses drift-${key}.md with a blank close-older-key`, () => {
    const original = driftWorkflowText(key);
    const mutated = original.replace(`close-older-key: sdlc-drift-${key}`, 'close-older-key: ""');
    assert.notEqual(mutated, original);
    const entries = checkRendered(new Map([[`${WORKFLOWS}/drift-${key}.md`, mutated]]), referenceRequest(), presetManifest());
    const entry = entries.find((candidate) => candidate.file.endsWith(`drift-${key}.md`));
    assert.equal(entry.valid, false);
    assert.ok(entry.errors.some((error) => error.startsWith("drift-close-older-key-missing: ") && error.includes(`project '${key}'`)), entry.errors.join("\n"));
  });
}
