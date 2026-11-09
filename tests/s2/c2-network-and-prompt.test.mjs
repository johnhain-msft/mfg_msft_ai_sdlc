// AC3: contract C2 request, derived configuration. The literal hostnames of knowledgeSources.watchUrls are in network.allowed
// (no wildcard), the prompt body carries the instruction text and the upkeepStrategy value, the frontmatter has exactly the
// twelve keys, and pre-agent-steps holds exactly the three S2 scripts in order, followed by the install of the dependencies of the
// target only for a project whose agentSandbox asks for it.
import assert from "node:assert/strict";
import test from "node:test";
import { abs, customJobsOf, DRIFT_KEYS, driftPreset, driftWorkflow, readText } from "./helpers/fixtures.mjs";

const TWELVE_KEYS = ["checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools"];
const hostnamesOf = (project) => project.driftAudit.knowledgeSources.watchUrls.map((entry) => new URL(entry.url).hostname);

for (const key of DRIFT_KEYS) {
  test(`AC3: drift-${key}.md allows every watched hostname and no wildcard`, () => {
    const { frontmatter } = driftWorkflow(key);
    const project = driftPreset(key);
    const allowed = frontmatter.network.allowed;
    for (const host of hostnamesOf(project)) assert.ok(allowed.includes(host), `${host} is in network.allowed`);
    assert.deepEqual([...allowed].sort(), [...new Set(hostnamesOf(project))].sort(), "network.allowed holds exactly the watched hostnames");
    for (const entry of allowed) assert.equal(entry.includes("*"), false, `${entry} has no wildcard`);
  });

  test(`AC3: the prompt body of drift-${key}.md carries the instruction text and the upkeepStrategy value`, () => {
    const { body } = driftWorkflow(key);
    const audit = driftPreset(key).driftAudit;
    assert.ok(body.includes(audit.instructions.trim()), "the inline instructions");
    assert.ok(body.includes(readText(abs(audit.instructionsFile)).replace(/\s+$/, "")), "the text of the instructions file, unmodified");
    assert.ok(body.includes(`## Upkeep strategy: ${audit.upkeepStrategy}`), "the upkeepStrategy value");
    for (const entry of audit.knowledgeSources.watchUrls) assert.ok(body.includes(entry.url), `the prompt lists ${entry.url}`);
    for (const pattern of audit.knowledgeSources.packageManifests) assert.ok(body.includes(`\`${pattern}\``), `the prompt lists the pattern ${pattern}`);
  });

  test(`AC3: drift-${key}.md has exactly the twelve top-level keys and the three S2 pre-agent-steps in order, and after them the dependency install only when its project asks for it`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(Object.keys(frontmatter).sort(), TWELVE_KEYS);
    const steps = frontmatter["pre-agent-steps"];
    const project = driftPreset(key);
    const installs = project.driftAudit.agentSandbox?.installDependencies === true;
    assert.equal(steps.length, installs ? 4 : 3, installs ? "the three S2 scripts and the install" : "exactly three pre-agent steps");
    assert.ok(steps[0].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs"'), steps[0].run);
    assert.ok(steps[1].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs"'), steps[1].run);
    assert.ok(steps[2].run.startsWith('node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs"'), steps[2].run);
    assert.equal(steps.filter((step) => step.run.includes("snapshot-watch-sources.mjs")).length, 1, "one snapshot invocation covers every watchUrls and packageManifests entry");
    if (installs) {
      assert.deepEqual(steps[3], { name: "Install target checkout dependencies for in-sandbox validation", "working-directory": project.repo.split("/")[1], run: "npm ci --ignore-scripts" });
    }
    assert.deepEqual(Object.keys(customJobsOf(frontmatter.jobs)), ["escalate_failure"], "jobs holds only escalate_failure besides the built-in guards");
  });

  test(`AC3: post-steps of drift-${key}.md are the project's verifyCommands in order`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(frontmatter["post-steps"].map((step) => step.run), driftPreset(key).driftAudit.verifyCommands);
  });
}

test("AC3: no network.allowed entry of any drift workflow contains a wildcard", () => {
  for (const key of DRIFT_KEYS) for (const entry of driftWorkflow(key).frontmatter.network.allowed) assert.doesNotMatch(entry, /\*/, `${key}: ${entry}`);
});
