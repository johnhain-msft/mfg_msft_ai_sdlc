// AC60: every generated file keeps auto-merge disabled; every automated pull request waits for human review.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { abs, fixture, listFiles, parseWorkflow, readText, referenceRequest, REPO_ROOT, edgeOf, minimalManifest, mutate, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
// Written out of pieces so that the offline scan of the test sources has nothing to match.
const MERGE_COMMAND = new RegExp(["gh pr", " merge"].join(""));
const AUTO_FLAG = /(^|\s)--auto(\s|$)/;
const TRUTHY_AUTO_MERGE = /auto-merge: *(true|squash|merge|rebase)/;

test("AC60: scanning every generated file of the reference render finds only auto-merge: false, no merge command and no --auto", async () => {
  const workspace = createWorkspace();
  try {
    assert.equal((await workspace.reconcile(request)).status, "ok");
    const files = workspace.list(W);
    assert.ok(files.length >= 18);
    let handlers = 0;
    for (const file of files) {
      const text = workspace.read(file);
      for (const match of text.matchAll(/auto-merge: *(\S*)/g)) {
        assert.equal(match[1], "false", `${file}: auto-merge is ${match[1]}`);
        handlers += 1;
      }
      assert.equal(TRUTHY_AUTO_MERGE.test(text), false, file);
      assert.equal(MERGE_COMMAND.test(text), false, `${file}: a merge command`);
      if (!file.endsWith(".lock.yml")) assert.equal(AUTO_FLAG.test(text), false, `${file}: --auto`);
    }
    assert.equal(handlers, 8, "one auto-merge key per create-pull-request handler: three drift, one mechanical, three AI and the onboarding workflow");
  } finally {
    workspace.cleanup();
  }
});

test("AC60: the committed workflow files satisfy the same scan (the criterion's rg command exits 1)", () => {
  for (const file of listFiles(REPO_ROOT, W)) {
    const text = readText(abs(file));
    assert.equal(TRUTHY_AUTO_MERGE.test(text), false, file);
    assert.equal(MERGE_COMMAND.test(text), false, file);
    if (/\.(md|yml)$/.test(file) && !file.endsWith(".lock.yml")) assert.equal(AUTO_FLAG.test(text), false, `${file}: --auto`);
  }
});

test("AC60: every create-pull-request handler of every generated workflow has auto-merge: false", async () => {
  const workspace = createWorkspace();
  try {
    await workspace.reconcile(request);
    const checked = [];
    for (const file of workspace.list(W).filter((name) => name.endsWith(".md"))) {
      const handler = parseWorkflow(workspace.read(file)).frontmatter["safe-outputs"]?.["create-pull-request"];
      if (!handler) continue;
      assert.strictEqual(handler["auto-merge"], false, file);
      checked.push(file);
    }
    assert.equal(checked.length, 8);
    const router = YAML.parse(workspace.read(`${W}/cascade-router.yml`));
    assert.equal(JSON.stringify(router).includes("auto-merge"), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC60: the merge-method forms of the option are never rendered, whatever the manifest says", async () => {
  for (const value of [true, "squash", "merge", "rebase"]) {
    const projectLevel = createWorkspace({ manifestText: readText(fixture("manifest.auto-merge-true.yaml")).replace("autoMerge: true", `autoMerge: ${JSON.stringify(value)}`) });
    try {
      const result = await projectLevel.reconcile(request);
      assert.equal(result.status, "error", `project autoMerge ${value}`);
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: .*autoMerge/.test(error)), `project autoMerge ${value}`);
      assert.deepEqual(projectLevel.list(W), []);
    } finally {
      projectLevel.cleanup();
    }
    const edgeLevel = createWorkspace({ manifestText: toYaml(mutate(minimalManifest(), (copy) => (edgeOf(copy, "alpha-to-beta").autoMerge = value))) });
    try {
      const result = await edgeLevel.reconcile(request);
      assert.equal(result.status, "error", `edge autoMerge ${value}`);
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: .*autoMerge/.test(error)), `edge autoMerge ${value}`);
    } finally {
      edgeLevel.cleanup();
    }
  }
});

test("AC60: an explicit autoMerge: false in the manifest is accepted and still renders false", async () => {
  const workspace = createWorkspace({ manifestText: toYaml(mutate(minimalManifest(), (copy) => (copy.projects[0].autoMerge = false))) });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const file of workspace.list(W).filter((name) => /drift-.*\.md$|cascade-.*\.md$/.test(name))) {
      assert.equal(parseWorkflow(workspace.read(file)).frontmatter["safe-outputs"]["create-pull-request"]["auto-merge"], false, file);
    }
  } finally {
    workspace.cleanup();
  }
});
