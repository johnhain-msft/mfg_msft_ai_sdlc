// AC35: no automated merging. Every safe-outputs.create-pull-request block, script, prompt and sdlc.yaml entry that S2 owns keeps auto-merge: false,
// and nothing owned by S2 merges, enables auto-merge on, approves or labels for merge a pull request: every automated pull request needs a
// human review and a human merge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { abs, DRIFT_KEYS, driftLock, driftPreset, listTree, mutate, presetManifest, projectOf, readText, readWorkflow, referenceRequest, toYaml, WORKFLOWS } from "./helpers/fixtures.mjs";

const workflowFiles = () => fs.readdirSync(abs(WORKFLOWS)).sort();
const driftMarkdown = () => workflowFiles().filter((name) => /^drift-.+\.md$/.test(name));

/** Every value stored under `key`, at any depth. */
function valuesOf(node, key, found = []) {
  if (Array.isArray(node)) for (const item of node) valuesOf(item, key, found);
  else if (node !== null && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) found.push(value);
      valuesOf(value, key, found);
    }
  }
  return found;
}

const S2_SOURCES = () => [abs("src", "snapshot-watch-sources.mjs"), abs("src", "validate-copilot-lab-audit.mjs"), ...listTree(abs("src", "drift")).map((file) => abs("src", "drift", file))];

test("AC35: every create-pull-request block in .github/workflows/drift-*.md has auto-merge equal to false", () => {
  assert.deepEqual(driftMarkdown(), DRIFT_KEYS.map((key) => `drift-${key}.md`).sort(), "the three preset drift workflows");
  for (const file of driftMarkdown()) {
    const blocks = valuesOf(readWorkflow(file).frontmatter, "create-pull-request").flat();
    assert.equal(blocks.length, 1, `${file}: one create-pull-request block`);
    for (const block of blocks) assert.strictEqual(block["auto-merge"], false, `${file}: auto-merge is ${JSON.stringify(block["auto-merge"])}`);
  }
});

test("AC35: the compiled handler configurations of the three drift locks carry auto_merge: false and no merge method", () => {
  for (const key of DRIFT_KEYS) {
    const configs = [];
    for (const job of Object.values(driftLock(key).workflow.jobs)) {
      for (const step of job.steps ?? []) {
        for (const name of ["GH_AW_SAFE_OUTPUTS_CONFIG", "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG"]) if (step.env?.[name]) configs.push(JSON.parse(step.env[name]));
      }
    }
    assert.ok(configs.length >= 2, `${key}: the agent job and safe_outputs both carry the configuration`);
    for (const config of configs) assert.strictEqual(config.create_pull_request.auto_merge, false, `${key}: auto_merge`);
  }
});

test("AC35: no workflow file under .github/workflows sets auto-merge to anything but false (rg -n 'auto-merge: true' prints nothing)", () => {
  const names = workflowFiles();
  assert.ok(names.length >= 10);
  for (const name of names) {
    const text = readText(abs(WORKFLOWS, name));
    assert.equal(/auto-merge:\s*(?!false\b)\S/.test(text), false, `${name}: auto-merge is not false`);
    assert.equal(/auto-merge: true/.test(text), false, name);
    assert.equal(/\\?"auto_merge\\?":\s*(?!false\b)\S/.test(text), false, `${name}: auto_merge is not false`);
  }
});

test("AC35: neither src/snapshot-watch-sources.mjs nor any file under src/drift/ (nor the validator) contains /merge, auto_merge, enablePullRequestAutoMerge or gh pr merge", () => {
  const files = S2_SOURCES();
  assert.ok(files.length >= 14, `scanned ${files.length} files`);
  for (const file of files) {
    const text = readText(file);
    for (const forbidden of ["/merge", "auto_merge", "enablePullRequestAutoMerge", "gh pr merge", "auto-merge", "automerge", "mergePullRequest", "--auto", "APPROVE"]) {
      assert.equal(text.includes(forbidden), false, `${path.relative(abs("."), file)} contains '${forbidden}'`);
    }
  }
});

test("AC35: no S2 prompt, instruction or rendered body asks for a merge, an approval or a merge label", () => {
  const files = [...listTree(abs("prompts", "drift")).map((file) => abs("prompts", "drift", file)), ...listTree(abs("instructions")).map((file) => abs("instructions", file)), ...DRIFT_KEYS.map((key) => abs(WORKFLOWS, `drift-${key}.md`))];
  for (const file of files) {
    const text = file.endsWith(".md") && file.includes(`${path.sep}.github${path.sep}`) ? readWorkflow(path.basename(file)).body : readText(file);
    assert.equal(/auto-?merge|ready[- ]to[- ]merge|merge[- ]when|\bapprov(e|es|ed|al)\b|enable auto/i.test(text), false, `${path.relative(abs("."), file)} asks for a merge or an approval`);
  }
});

test("AC35: the pull requests of the three drift workflows are labelled for a human, not for a merge", () => {
  for (const key of DRIFT_KEYS) {
    const { labels } = readWorkflow(`drift-${key}.md`).frontmatter["safe-outputs"]["create-pull-request"];
    assert.ok(labels.includes("needs-review"), `${key}: needs-review`);
    assert.equal(labels.some((name) => /merge|approved|ship|ready/i.test(name)), false, `${key}: ${labels.join(", ")}`);
  }
});

test("AC35: every autoMerge key of sdlc.yaml is false, and a driftAudit entry cannot carry one at all", async () => {
  const keys = valuesOf(presetManifest(), "autoMerge");
  assert.ok(keys.length >= 1);
  for (const value of keys) assert.strictEqual(value, false);
  for (const key of DRIFT_KEYS) assert.equal("autoMerge" in driftPreset(key).driftAudit, false, `${key}: the driftAudit block has no autoMerge key`);
  for (const value of [true, "squash"]) {
    const text = toYaml(mutate(presetManifest(), (manifest) => {
      projectOf(manifest, "copilot-lab").driftAudit.autoMerge = value;
    }));
    const workspace = createWorkspace({ manifestText: text, instructions: true });
    try {
      const result = await workspace.reconcile(referenceRequest());
      assert.equal(result.status, "error", `autoMerge ${JSON.stringify(value)} in a driftAudit block`);
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: .*driftAudit\/autoMerge/.test(error)));
      assert.deepEqual(workspace.list(".github/workflows"), [], "nothing is written");
    } finally {
      workspace.cleanup();
    }
  }
});
