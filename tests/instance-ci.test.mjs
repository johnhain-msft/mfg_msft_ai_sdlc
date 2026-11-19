// The hand-written workflow of this repository's CI (.github/workflows/instance-ci.yml). Nothing generates it and no compiler reads it, and it cannot run on this machine, so the
// shape that it has to have is pinned here: every action by the commit that .github/aw/actions-lock.json holds for it, the read token for the engine's repository minted with
// the narrowest permission, the install step that every generated job also has (the three git rewrites, in the environment of that one step), and `npm test` after it.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { abs, presetManifest, readJson, readText, readWorkflow } from "./helpers/instance.mjs";

const FILE = abs(".github", "workflows", "instance-ci.yml");
const text = readText(FILE);
const workflow = YAML.parse(text);
const steps = workflow.jobs.test.steps;
const lock = readJson(abs(".github", "aw", "actions-lock.json")).entries;
const [, owner, repository] = /^github:([^/]+)\/(.+)$/.exec(presetManifest().factory.source);

test("it runs on the pull requests of the default branch and by hand, with a read-only token", () => {
  assert.equal(workflow.name, "Instance CI");
  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["test"]);
});

test("every action is pinned by the commit that .github/aw/actions-lock.json holds for it, with the version of the pin as the comment", () => {
  const uses = [...text.matchAll(/^\s*uses: (\S+)@([0-9a-f]{40}) # (\S+)\s*$/gm)].map(([, name, sha, version]) => ({ name, sha, version }));
  assert.deepEqual(uses.map((entry) => entry.name), ["actions/checkout", "actions/create-github-app-token", "actions/setup-node"]);
  assert.equal([...text.matchAll(/^\s*uses: /gm)].length, uses.length, "no action is used without its commit and its version");
  for (const { name, sha, version } of uses) {
    const pinned = lock[`${name}@${version}`];
    assert.ok(pinned, `the lock holds ${name}@${version}`);
    assert.equal(pinned.repo, name);
    assert.equal(sha, pinned.sha, `${name}@${version} is pinned to the commit of the lock`);
  }
});

test("the checkout keeps no credential, and the job installs nothing before the read token of the engine's repository exists", () => {
  const [checkout, token, node, install, run] = steps;
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(token.id, "factory_token");
  assert.deepEqual(token.with, { "app-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}", owner, repositories: repository, "permission-contents": "read" });
  assert.match(node.uses, /^actions\/setup-node@/);
  assert.equal(node.with["node-version"], "24");
  assert.equal(install.run, "npm ci --ignore-scripts");
  assert.equal(run.run, "npm test");
  assert.equal(steps.length, 5);
  assert.equal(/git config|--global|\.gitconfig/.test(steps.map((step) => step.run ?? "").join("\n")), false, "no step writes a git configuration: the rewrites live in the environment of the install step");
});

test("the install step is the one that the generated jobs have: the same three rewrites of the engine's repository to the token's address, and no prompt", () => {
  const generated = readWorkflow("drift-copilot-lab.md").frontmatter["pre-agent-steps"].find((step) => step.run === "npm ci --ignore-scripts");
  assert.ok(generated, "a generated job has the install step");
  assert.deepEqual(steps[3].env, generated.env, "the environment of the step is the generated one");
  assert.equal(steps[3].env.GIT_CONFIG_COUNT, "3");
  assert.equal(steps[3].env.GIT_TERMINAL_PROMPT, "0");
  const rewrites = [0, 1, 2].map((index) => [steps[3].env[`GIT_CONFIG_KEY_${index}`], steps[3].env[`GIT_CONFIG_VALUE_${index}`]]);
  for (const [key] of rewrites) assert.equal(key, `url.https://x-access-token:\${{ steps.factory_token.outputs.token }}@github.com/${owner}/${repository}.insteadOf`);
  assert.deepEqual(rewrites.map(([, value]) => value), [`ssh://git@github.com/${owner}/${repository}`, `git@github.com:${owner}/${repository}`, `https://github.com/${owner}/${repository}`], "every spelling that npm may resolve the dependency to");
});
