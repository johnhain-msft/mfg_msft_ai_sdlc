// What live runs showed the generated workflows need. Each of these settings was first made by hand in a generated workflow, after a run failed (ae32bf1 and
// 61f0678 in drift-gh-admin-msft, 9a49f71 in cascade-mechanical-ghec-admin), and the next reconcile took it out again, because neither the manifest nor the renderer
// knew it. They are data of sdlc.yaml now and the renderer writes them; the committed workflows and their locks, which are what runs, have to carry them.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, parseWorkflow, readText, readWorkflow, referenceRequest } from "./helpers/fixtures.mjs";

const W = ".github/workflows";
const rendered = renderFleet(referenceRequest());
assert.ok(rendered.ok, JSON.stringify(rendered.result));
/** The workflow as the renderer writes it, and as it is committed: a reconcile that takes a setting out changes the first, a hand edit the second. */
const versions = (name) => [
  ["rendered", parseWorkflow(rendered.files.get(`${W}/${name}`))],
  ["committed", readWorkflow(name)],
];
const lockOf = (id) => YAML.parse(readText(abs(W, `${id}.lock.yml`)));
const agentSteps = (id) => lockOf(id).jobs.agent.steps;
const isAgentStep = (step) => step.env?.GH_AW_COPILOT_SDK_TOOL_CONFIG !== undefined;

/** The commands that the compiled lock lets the agent run: the `shell(<command>)` entries of the tool configuration of the step that executes it. */
function shellCommands(id) {
  const step = agentSteps(id).find(isAgentStep);
  assert.ok(step, `${id}: the lock has the step that executes the agent`);
  const { allowedTools } = JSON.parse(step.env.GH_AW_COPILOT_SDK_TOOL_CONFIG).permissions;
  return allowedTools.filter((tool) => tool.startsWith("shell(")).map((tool) => tool.slice("shell(".length, -1).replace(/:\*$/, ""));
}

const INSTALL_STEP = { name: "Install target checkout dependencies for in-sandbox validation", "working-directory": "gh-admin-msft", run: "npm ci --ignore-scripts" };
const GH_ADMIN_MSFT_BASH = [
  "awk", "cat", "cd", "cut", "date", "diff", "echo", "find", "git", "grep", "head", "jq", "ls", "mkdir", "node", "npm", "python3", "rg", "sed", "sort", "tail", "tr", "uniq", "wc", "xargs",
];
const BROWSER_GATE = "npx playwright test tests/browser/sites.spec.ts";

test("ae32bf1: drift-gh-admin-msft installs the dependencies of its target after the snapshot and before the agent starts, so that the validators run inside the sandbox", () => {
  for (const [label, workflow] of versions("drift-gh-admin-msft.md")) {
    const steps = workflow.frontmatter["pre-agent-steps"];
    assert.equal(steps.length, 4, label);
    assert.ok(steps[2].run.includes("snapshot-watch-sources.mjs"), `${label}: the snapshot is the third step`);
    assert.deepEqual(steps[3], INSTALL_STEP, label);
  }
  const steps = agentSteps("drift-gh-admin-msft");
  const at = steps.findIndex((step) => step.name === INSTALL_STEP.name);
  assert.ok(at > 0, "the lock runs the step");
  assert.deepEqual({ name: steps[at].name, "working-directory": steps[at]["working-directory"], run: steps[at].run }, INSTALL_STEP);
  assert.ok(String(steps[at - 1].run).includes("snapshot-watch-sources.mjs"), "right after the snapshot");
  assert.ok(at < steps.findIndex(isAgentStep), "and before the step that executes the agent");
});

test("ae32bf1: the drift workflows of the projects that did not ask for the install keep their three pre-agent steps", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    for (const [label, workflow] of versions(`drift-${key}.md`)) assert.equal(workflow.frontmatter["pre-agent-steps"].length, 3, `${key} ${label}`);
    assert.equal(agentSteps(`drift-${key}`).some((step) => step.run === "npm ci --ignore-scripts" && step["working-directory"] !== undefined), false, `${key}: the lock installs nothing`);
  }
});

test("61f0678: drift-gh-admin-msft lets its agent run the text tools of its validators and nothing that reaches the network", () => {
  for (const [label, workflow] of versions("drift-gh-admin-msft.md")) assert.deepEqual(workflow.frontmatter.tools.bash, GH_ADMIN_MSFT_BASH, label);
  const commands = shellCommands("drift-gh-admin-msft");
  for (const word of GH_ADMIN_MSFT_BASH) assert.ok(commands.includes(word), `the lock lets the agent run ${word}`);
  for (const word of ["gh", "curl", "wget"]) assert.equal(commands.includes(word), false, `the lock does not let the agent run ${word}`);
});

test("61f0678: the other drift workflows keep the allowlist that git, node and their build commands give them", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    for (const [label, workflow] of versions(`drift-${key}.md`)) {
      assert.deepEqual(workflow.frontmatter.tools.bash, ["cat", "date", "find", "git", "grep", "head", "ls", "node", "tail", "wc"], `${key} ${label}`);
    }
  }
});

test("9a49f71: the mechanical cascades run the browser gate that ubuntu-latest can run, in the workflow, in its lock and in the router that dispatches them", () => {
  for (const id of ["cascade-mechanical-ghec-admin", "cascade-mechanical-ai-sdlc"]) {
    for (const [label, workflow] of versions(`${id}.md`)) {
      const posts = workflow.frontmatter["post-steps"];
      assert.deepEqual(posts.at(-1), { name: BROWSER_GATE, run: BROWSER_GATE, "working-directory": "portfolio" }, `${id} ${label}`);
      assert.equal(JSON.stringify(posts).includes("test:browser"), false, `${id} ${label}: the full suite of the portfolio is not a gate`);
    }
    const steps = agentSteps(id);
    assert.ok(steps.some((step) => step.run === BROWSER_GATE && step["working-directory"] === "portfolio"), `${id}: the lock runs the gate`);
    assert.equal(steps.some((step) => /test:browser/.test(String(step.run ?? ""))), false, `${id}: and not the full suite`);
  }
  const router = YAML.parse(readText(abs(W, "cascade-router.yml")));
  const mechanical = router.jobs.route.strategy.matrix.include.filter((edge) => edge.mode === "mechanical");
  assert.deepEqual(mechanical.map((edge) => edge.edgeId), ["ghec-admin", "ai-sdlc"]);
  for (const edge of mechanical) assert.equal(edge.verifyCommands.at(-1), BROWSER_GATE, edge.edgeId);
});

test("9a49f71: the AI cascades, which no live run has failed, keep the full browser suite", () => {
  for (const key of ["copilot-lab", "pipeline-showcase", "github-intermediate"]) {
    for (const [label, workflow] of versions(`cascade-ai-${key}.md`)) {
      assert.ok(workflow.frontmatter["post-steps"].some((step) => step.run === "npm run test:browser"), `${key} ${label}`);
      assert.equal(JSON.stringify(workflow.frontmatter["post-steps"]).includes("sites.spec.ts"), false, `${key} ${label}`);
    }
  }
});
