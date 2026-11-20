// The hand-written workflow of this repository's CI (.github/workflows/instance-ci.yml). Nothing generates it and no compiler reads it, and it cannot run on this machine, so the
// shape that it has to have is pinned here: every action by the commit that .github/aw/actions-lock.json holds for it, the install step that every generated job also has,
// and `npm test` after it.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { abs, readJson, readText, readWorkflow } from "./helpers/instance.mjs";

const FILE = abs(".github", "workflows", "instance-ci.yml");
const text = readText(FILE);
const workflow = YAML.parse(text);
const steps = workflow.jobs.test.steps;
const lock = readJson(abs(".github", "aw", "actions-lock.json")).entries;

test("it runs on the pull requests of the default branch and by hand, with a read-only token", () => {
  assert.equal(workflow.name, "Instance CI");
  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["test"]);
});

test("every action is pinned by the commit that .github/aw/actions-lock.json holds for it, with the version of the pin as the comment", () => {
  const uses = [...text.matchAll(/^\s*uses: (\S+)@([0-9a-f]{40}) # (\S+)\s*$/gm)].map(([, name, sha, version]) => ({ name, sha, version }));
  assert.deepEqual(uses.map((entry) => entry.name), ["actions/checkout", "actions/setup-node"]);
  assert.equal([...text.matchAll(/^\s*uses: /gm)].length, uses.length, "no action is used without its commit and its version");
  for (const { name, sha, version } of uses) {
    const pinned = lock[`${name}@${version}`];
    assert.ok(pinned, `the lock holds ${name}@${version}`);
    assert.equal(pinned.repo, name);
    assert.equal(sha, pinned.sha, `${name}@${version} is pinned to the commit of the lock`);
  }
});

test("the checkout keeps no credential, and the job installs the public engine directly with npm ci --ignore-scripts", () => {
  const [checkout, node, install, run] = steps;
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(node.uses, /^actions\/setup-node@/);
  assert.equal(node.with["node-version"], "24");
  assert.equal(install.run, "npm ci --ignore-scripts");
  assert.equal(run.run, "npm test");
  assert.equal(steps.length, 4);
  assert.equal(/git config|--global|\.gitconfig/.test(steps.map((step) => step.run ?? "").join("\n")), false, "no step writes a git configuration");
});

test("the install step is the one that the generated jobs have: no token step and no git rewrites", () => {
  const generated = readWorkflow("drift-copilot-lab.md").frontmatter["pre-agent-steps"].find((step) => step.run === "npm ci --ignore-scripts");
  assert.ok(generated, "a generated job has the install step");
  assert.deepEqual(steps[2].env, generated.env, "the environment of the step is the generated one");
  assert.equal(steps[2].env, undefined);
});
