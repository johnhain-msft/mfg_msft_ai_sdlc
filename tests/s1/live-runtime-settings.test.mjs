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
const UPLOAD_STEP_NAME = "Upload the watch index";
const GH_ADMIN_MSFT_BASH = [
  "awk", "cat", "cd", "curl", "cut", "date", "diff", "echo", "find", "git", "grep", "head", "jq", "ls", "mkdir", "node", "npm", "python3", "rg", "sed", "sort", "tail", "tr", "uniq", "wc", "xargs",
];
const BROWSER_GATE = "npx playwright test tests/browser/sites.spec.ts";

test("ae32bf1: drift-gh-admin-msft installs the dependencies of its target after the snapshot and before the agent starts, so that the validators run inside the sandbox", () => {
  for (const [label, workflow] of versions("drift-gh-admin-msft.md")) {
    const steps = workflow.frontmatter["pre-agent-steps"];
    assert.equal(steps.length, 6, label);
    assert.ok(steps[3].run.includes("snapshot-watch-sources.mjs"), `${label}: the snapshot is the fourth step`);
    assert.equal(steps[4].name, UPLOAD_STEP_NAME, `${label}: the upload of the watch index follows it`);
    assert.deepEqual(steps[5], INSTALL_STEP, label);
  }
  const steps = agentSteps("drift-gh-admin-msft");
  const at = steps.findIndex((step) => step.name === INSTALL_STEP.name);
  assert.ok(at > 0, "the lock runs the step");
  assert.deepEqual({ name: steps[at].name, "working-directory": steps[at]["working-directory"], run: steps[at].run }, INSTALL_STEP);
  assert.equal(steps[at - 1].name, UPLOAD_STEP_NAME, "right after the upload of the watch index");
  assert.ok(String(steps[at - 2].run).includes("snapshot-watch-sources.mjs"), "which follows the snapshot");
  assert.ok(at < steps.findIndex(isAgentStep), "and before the step that executes the agent");
});

test("ae32bf1: the drift workflows of the projects that did not ask for the install keep their five pre-agent steps", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    for (const [label, workflow] of versions(`drift-${key}.md`)) assert.equal(workflow.frontmatter["pre-agent-steps"].length, 5, `${key} ${label}`);
    assert.equal(agentSteps(`drift-${key}`).some((step) => step.run === "npm ci --ignore-scripts" && step["working-directory"] !== undefined), false, `${key}: the lock installs nothing`);
  }
});

test("61f0678: drift-gh-admin-msft lets its agent run the text tools of its validators, and curl only for the hosts that its firewall allows", () => {
  for (const [label, workflow] of versions("drift-gh-admin-msft.md")) assert.deepEqual(workflow.frontmatter.tools.bash, GH_ADMIN_MSFT_BASH, label);
  const commands = shellCommands("drift-gh-admin-msft");
  for (const word of GH_ADMIN_MSFT_BASH) assert.ok(commands.includes(word), `the lock lets the agent run ${word}`);
  for (const word of ["gh", "wget"]) assert.equal(commands.includes(word), false, `the lock does not let the agent run ${word}`);
  // dry run 43631574930: behind the API proxy the agent has no web_fetch tool, so curl is how it reads a source page, and Copilot runs it only for a URL it
  // was given permission for: the lock passes exactly the hosts of network.allowed to the Copilot server, and the firewall allows those and no other
  const step = agentSteps("drift-gh-admin-msft").find(isAgentStep);
  const server = JSON.parse(step.env.GH_AW_COPILOT_SDK_SERVER_ARGS);
  const urls = server.flatMap((arg, index) => (arg === "--allow-url" ? [server[index + 1]] : []));
  assert.deepEqual(urls, readWorkflow("drift-gh-admin-msft.md").frontmatter.network.allowed);
  assert.equal(server.some((arg) => arg.startsWith("--allow-all-urls")), false);
});

// Dry runs 43497657653 (this branch) and 43499249738 (main) of drift-copilot-lab: the agent opened with `cd` into the artifact directory and into
// its checkout, the allowlist refused the whole command, and the agent gave up the shell, wrote no audit report and failed the validator. `cd`
// reaches nothing, so every drift workflow allows it, as the mechanical cascades do.
test("61f0678: the other drift workflows keep the allowlist that cd, git, node and their build commands give them", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    for (const [label, workflow] of versions(`drift-${key}.md`)) {
      assert.deepEqual(workflow.frontmatter.tools.bash, ["cat", "cd", "curl", "date", "find", "git", "grep", "head", "ls", "node", "tail", "wc"], `${key} ${label}`);
    }
    assert.ok(shellCommands(`drift-${key}`).includes("cd"), `${key}: the lock lets the agent run cd`);
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
  assert.deepEqual(mechanical.map((edge) => edge.edgeId), ["ghec-admin", "ai-sdlc", "copilot-config"]);
  for (const edge of mechanical.filter((e) => e.downstreamRepo === "johnhain-msft/portfolio")) assert.equal(edge.verifyCommands.at(-1), BROWSER_GATE, edge.edgeId);
  assert.deepEqual(mechanical.find((e) => e.edgeId === "copilot-config").verifyCommands, [
    "aiam validate",
    "pytest -q",
    "aiam release build --out /tmp/aiam-verify-dist",
  ]);
});

test("9a49f71: the AI cascades also run the narrowed browser gate that ubuntu-latest can run, without the full Segoe UI browser suite", () => {
  for (const key of ["copilot-lab", "pipeline-showcase", "github-intermediate"]) {
    for (const [label, workflow] of versions(`cascade-ai-${key}.md`)) {
      assert.ok(workflow.frontmatter["post-steps"].some((step) => step.run === BROWSER_GATE), `${key} ${label}`);
      assert.equal(JSON.stringify(workflow.frontmatter["post-steps"]).includes("test:browser"), false, `${key} ${label}`);
    }
    const steps = agentSteps(`cascade-ai-${key}`);
    assert.ok(steps.some((step) => step.run === BROWSER_GATE && step["working-directory"] === "portfolio"), `${key}: the lock runs the gate`);
    assert.equal(steps.some((step) => /test:browser/.test(String(step.run ?? ""))), false, `${key}: and not the full suite`);
  }
});

test("QA: every rendered and compiled drift or cascade disables automatic failure issues and carries the generated-bundle patch limit", () => {
  const names = [...rendered.files.keys()].filter((name) => /\/(?:drift-|cascade-(?:ai-|mechanical-)).*\.md$/.test(name));
  assert.equal(names.length, 9, "all three drift and six cascade workflows are covered");
  for (const name of names) {
    const id = name.split("/").pop().replace(/\.md$/, "");
    for (const [label, workflow] of versions(`${id}.md`)) {
      assert.equal(workflow.frontmatter["safe-outputs"]["report-failure-as-issue"], false, `${id} ${label}`);
      assert.equal(workflow.frontmatter["safe-outputs"]["create-pull-request"]["max-patch-size"], 10240, `${id} ${label}`);
    }
    const lock = lockOf(id);
    for (const [job, key] of [
      ["activation", "GH_AW_BLOCKED_VERSION_REPORT_AS_ISSUE"],
      ["conclusion", "GH_AW_FAILURE_REPORT_AS_ISSUE"],
    ]) {
      const reporting = lock.jobs[job].steps.filter((step) => Object.hasOwn(step.env ?? {}, key));
      assert.equal(reporting.length, 1, `${id}: ${job} has one reporting control`);
      assert.equal(reporting[0].env[key], "false", `${id}: ${key} is disabled in the executable workflow`);
    }
    for (const [job, key] of [
      ["agent", "GH_AW_SAFE_OUTPUTS_CONFIG"],
      ["safe_outputs", "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG"],
    ]) {
      const configs = lock.jobs[job].steps.filter((step) => Object.hasOwn(step.env ?? {}, key));
      assert.equal(configs.length, 1, `${id}: ${job} has one effective safe-output configuration`);
      assert.equal(JSON.parse(configs[0].env[key]).create_pull_request.max_patch_size, 10240, `${id}: ${key} enforces the same patch limit`);
    }
  }
});
