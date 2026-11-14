// AC62: every manifest string is data; none of them can add a key, a step, a job or an expression.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { customJobsOf, minimalManifest, mutate, parseWorkflow, projectOf, referenceRequest, toYaml, edgeOf } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();

const NEWLINE_STEP = "line one\n- run: injected-step\n  name: pwn";
const TRICKY = [
  "---\nnewline then - run: x",
  "back`tick `echo hi` and \"double quotes\" and 'single quotes'",
  "# a comment: with a colon\nkey: value\n- item",
  NEWLINE_STEP,
  "{ flow: [mapping], &anchor *alias }",
  "]\n---\nsafe-outputs:\n  github-token: stolen",
];

const DRIFT_KEYS = ["checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools"];
const MECHANICAL_KEYS = ["checkout", "concurrency", "engine", "jobs", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "steps", "tools"];

/** The minimal manifest with a hostile value placed in every field that reaches a workflow. */
function hostileManifest(value) {
  return mutate(minimalManifest(), (copy) => {
    const audit = projectOf(copy, "alpha-service").driftAudit;
    audit.instructions = value;
    audit.knowledgeSources.watchUrls[0].label = value;
    audit.reviewers = [value];
    audit.buildCommands = [value];
    audit.verifyCommands = ["npm ci", `echo ${value}`];
    audit.knowledgeSources.packageManifests = [value];
    const edge = edgeOf(copy, "alpha-to-beta");
    edge.reviewers = [value];
    edge.buildCommands = [value];
    edge.importCommands = [`node import.mjs <checkout> ${value}`];
    edge.adaptationInstructions = value;
  });
}

async function renderHostile(manifest) {
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    return { result, files: result.ok ? result.files : new Map() };
  } finally {
    workspace.cleanup();
  }
}

for (const [index, value] of TRICKY.entries()) {
  test(`AC62: tricky string #${index + 1} round-trips as an inert scalar and adds no key, step or job`, async () => {
    const { result, files } = await renderHostile(hostileManifest(value));
    assert.ok(result.ok, JSON.stringify(result.result));
    const drift = parseWorkflow(files.get(`${W}/drift-alpha-service.md`)).frontmatter;
    assert.deepEqual(Object.keys(drift).sort(), DRIFT_KEYS);
    assert.deepEqual(Object.keys(drift.jobs).sort(), ["conclusion", "detection", "escalate_failure", "implement_report", "safe_outputs"], "no job is added to the three guard sections and the two custom jobs");
    assert.equal(drift["pre-agent-steps"].length, 5, "the five S2 steps of SPEC-01 AC25 and no install, which the minimal manifest does not ask for");
    assert.equal(drift["post-steps"].length, 2, "one step per verify command, however many lines it has");
    assert.deepEqual(drift["safe-outputs"]["create-pull-request"].reviewers, [value], "the reviewer is a scalar");
    assert.equal("github-token" in drift["safe-outputs"], false);
    for (const step of drift["post-steps"]) assert.deepEqual(Object.keys(step).sort(), ["name", "run", "working-directory"]);
    assert.equal(drift["post-steps"][1].run, `echo ${value}`, "the command string is preserved exactly");

    const mechanical = parseWorkflow(files.get(`${W}/cascade-mechanical-alpha-to-beta.md`)).frontmatter;
    assert.deepEqual(Object.keys(mechanical).sort(), MECHANICAL_KEYS);
    assert.deepEqual(Object.keys(mechanical.jobs).sort(), ["detection", "escalate_failure", "finalize_poll_state", "safe_outputs"]);
    assert.deepEqual(mechanical.jobs.detection, { if: "needs.agent.result == 'success'" }, "the hostile value does not reach the guard");
    assert.deepEqual(mechanical.jobs.safe_outputs, { if: "needs.agent.result == 'success'" });
    assert.deepEqual(mechanical["safe-outputs"]["create-pull-request"].reviewers, [value]);
    assert.equal(mechanical["post-steps"].length, 5 + 1 + 1, "five fixed steps, one build command and one verify command");
    assert.equal(mechanical["pre-agent-steps"].length, 1);
    for (const job of Object.values(customJobsOf(mechanical.jobs))) assert.equal(job.steps.length >= 4, true);

    const router = YAML.parse(files.get(`${W}/cascade-router.yml`));
    assert.deepEqual(Object.keys(router).sort(), ["jobs", "name", "on", "permissions"]);
    assert.deepEqual(Object.keys(router.jobs), ["route"]);
    assert.equal(router.jobs.route.steps.length, 3);
    assert.deepEqual(router.jobs.route.strategy.matrix.include[0].reviewers, [value]);

    const onboard = parseWorkflow(files.get(`${W}/sdlc-onboard.md`)).frontmatter;
    assert.equal(JSON.stringify(onboard).includes("injected-step"), false);
  });
}

test("AC62: a hostile string appears in the generated Markdown body only inside the prompt, never as workflow structure", async () => {
  const { files } = await renderHostile(hostileManifest(NEWLINE_STEP));
  const parsed = parseWorkflow(files.get(`${W}/drift-alpha-service.md`));
  const frontmatter = parsed.frontmatter;
  const steps = [...frontmatter["pre-agent-steps"], ...frontmatter["post-steps"], ...Object.values(customJobsOf(frontmatter.jobs)).flatMap((job) => job.steps)];
  assert.equal(steps.some((step) => step.name === "pwn" || step.run === "injected-step"), false, "the injected step does not exist");
  assert.ok(parsed.body.includes("injected-step"), "the text reaches the prompt as text");
  for (const [name, text] of files) {
    if (name.endsWith(".md")) assert.equal(/^---\n/.test(text), true);
  }
});

test("AC62: any manifest string containing the expression opener is rejected, wherever it sits", async () => {
  const opener = "${{ secrets.X }}";
  const places = {
    "project instructions": (copy) => (projectOf(copy, "alpha-service").driftAudit.instructions = `see ${opener}`),
    "watch URL label": (copy) => (projectOf(copy, "alpha-service").driftAudit.knowledgeSources.watchUrls[0].label = opener),
    "drift reviewer": (copy) => (projectOf(copy, "alpha-service").driftAudit.reviewers = [opener]),
    "drift build command": (copy) => (projectOf(copy, "alpha-service").driftAudit.buildCommands = [`echo ${opener}`]),
    "drift verify command": (copy) => (projectOf(copy, "alpha-service").driftAudit.verifyCommands = [`echo ${opener}`]),
    "package manifest": (copy) => (projectOf(copy, "alpha-service").driftAudit.knowledgeSources.packageManifests = [opener]),
    "mcp server value": (copy) => (projectOf(copy, "alpha-service").driftAudit.knowledgeSources.mcpServers = { s: { command: opener } }),
    "mcp server key": (copy) => (projectOf(copy, "alpha-service").driftAudit.knowledgeSources.mcpServers = { [opener]: {} }),
    "edge reviewer": (copy) => (edgeOf(copy, "alpha-to-beta").reviewers = [opener]),
    "edge import command": (copy) => (edgeOf(copy, "alpha-to-beta").importCommands = [opener]),
    "edge verify command": (copy) => (edgeOf(copy, "alpha-to-beta").verifyCommands = [opener]),
    "edge adaptation instructions": (copy) => (edgeOf(copy, "alpha-to-beta").adaptationInstructions = opener),
    "edge locked test blocks": (copy) => (edgeOf(copy, "alpha-to-beta").immutableGates.lockedTestBlocks = [{ title: opener }]),
  };
  for (const [label, change] of Object.entries(places)) {
    const workspace = createWorkspace({ manifestText: toYaml(mutate(minimalManifest(), change)) });
    try {
      const before = workspace.hash();
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "error", label);
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => error.startsWith("manifest-expression-opener: ")), `${label}: ${errors.join(" | ")}`);
      assert.equal(workspace.hash(), before, `${label}: nothing is written`);
    } finally {
      workspace.cleanup();
    }
  }
});

test("AC62: an instructions file that contains the expression opener is rejected too", async () => {
  const manifest = mutate(minimalManifest(), (copy) => (projectOf(copy, "alpha-service").driftAudit.instructionsFile = "instructions/hostile.md"));
  const workspace = createWorkspace({ manifestText: toYaml(manifest), files: { "instructions/hostile.md": "Do ${{ github.token }} things\n" } });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("manifest-expression-opener: ") && error.includes("instructions/hostile.md")));
  } finally {
    workspace.cleanup();
  }
});

test("AC62: a branchName that tries to add structure fails the schema instead of being rendered", async () => {
  for (const branchName of ["sdlc/x\n- run: y", "sdlc/x y", "sdlc/x'; rm -rf /; '", "sdlc/$(id)"]) {
    const manifest = mutate(minimalManifest(), (copy) => (edgeOf(copy, "alpha-to-beta").branchName = branchName));
    const workspace = createWorkspace({ manifestText: toYaml(manifest) });
    try {
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "error", JSON.stringify(branchName));
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: .*branchName/.test(error)), JSON.stringify(branchName));
    } finally {
      workspace.cleanup();
    }
  }
});

test("AC62: a hostile MCP server key is serialised as a quoted key, not as structure", async () => {
  const key = "evil: {x: y}\n- run: z";
  const manifest = mutate(minimalManifest(), (copy) => (projectOf(copy, "alpha-service").driftAudit.knowledgeSources.mcpServers = { [key]: { command: "echo" } }));
  const { result, files } = await renderHostile(manifest);
  assert.ok(result.ok, JSON.stringify(result.result));
  const drift = parseWorkflow(files.get(`${W}/drift-alpha-service.md`)).frontmatter;
  assert.deepEqual(Object.keys(drift["mcp-servers"]), [key]);
  assert.deepEqual(Object.keys(drift).sort(), DRIFT_KEYS);
});

test("AC62: renderer-built expressions are the only ones in a generated file", async () => {
  const { files } = await renderHostile(hostileManifest(TRICKY[1]));
  // needs.safe_outputs... and the correlation fallback are the two expressions of the implement_report job (SPEC-02 AC46)
  const allowed = /^(?:vars\.APP_CLIENT_ID|secrets\.APP_PRIVATE_KEY|secrets\.COPILOT_GITHUB_TOKEN|secrets\.GITHUB_TOKEN|github\.[a-z_.]+|inputs\.[a-z_]+|steps\.app_token\.outputs\.token|matrix\.[A-Za-z]+|toJSON\([^)]*\)|needs\.safe_outputs\.outputs\.created_issue_number|inputs\.correlation_id \|\| format\('run-\{0\}-\{1\}', github\.run_id, github\.run_attempt\))$/;
  for (const [name, text] of files) {
    for (const match of text.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) assert.match(match[1], allowed, `${name}: \${{ ${match[1]} }}`);
  }
});
