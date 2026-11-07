// AC20, AC22, AC23, AC25 and AC27: the drift workflow of contract C2.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import {
  abs,
  customJobsOf,
  fixture,
  minimalManifest,
  mutate,
  parseWorkflow,
  presetManifest,
  projectOf,
  readText,
  readWorkflow,
  referenceRequest,
  REPO_ROOT,
  toYaml,
} from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const DRIFT_KEYS = ["gh-admin-msft", "copilot-lab", "self-improving-agents"];
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };

const rendered = renderFleet(request);
assert.ok(rendered.ok, JSON.stringify(rendered.result));
const generated = (key) => parseWorkflow(rendered.files.get(`${W}/drift-${key}.md`));
const trackedFiles = (pathspec) =>
  spawnSync("git", ["ls-files", pathspec], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.split("\n").filter((line) => line !== "");

test("AC20: the generated drift set equals the enabled set for the preset", () => {
  const set = rendered.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id);
  assert.deepEqual(set, ["drift-copilot-lab", "drift-gh-admin-msft", "drift-self-improving-agents"]);
  const enabled = preset.projects.filter((project) => project.driftAudit.enabled).map((project) => `drift-${project.projectKey}`);
  assert.deepEqual([...set].sort(), [...enabled].sort());
  const files = [...rendered.files.keys()].filter((file) => /\/drift-[^/]+\.md$/.test(file));
  assert.deepEqual(files, DRIFT_KEYS.map((key) => `${W}/drift-${key}.md`).sort());
});

test("AC20: with one project disabled its workflow disappears; enabling a project adds exactly one", () => {
  const disabled = mutate(preset, (copy) => (projectOf(copy, "self-improving-agents").driftAudit.enabled = false));
  const workspace = createWorkspace({ manifestText: toYaml(disabled), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok);
    assert.deepEqual(result.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id), ["drift-copilot-lab", "drift-gh-admin-msft"]);
    assert.equal(result.files.has(`${W}/drift-self-improving-agents.md`), false);
  } finally {
    workspace.cleanup();
  }
  const minimal = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  try {
    const result = renderFleet(request, { cwd: minimal.dir });
    assert.deepEqual(result.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id), ["drift-alpha-service"]);
  } finally {
    minimal.cleanup();
  }
});

test("AC20: git ls-files lists exactly the six preset drift paths", () => {
  const expected = DRIFT_KEYS.flatMap((key) => [`${W}/drift-${key}.lock.yml`, `${W}/drift-${key}.md`]).sort();
  assert.deepEqual(trackedFiles(`${W}/drift-*`), expected);
});

function assertContract(frontmatter, project) {
  const audit = project.driftAudit;
  const repoName = project.repo.split("/")[1];
  assert.deepEqual(Object.keys(frontmatter).sort(), [
    "checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools",
  ]);
  assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "schedule", "workflow_dispatch"]);
  assert.deepEqual(frontmatter.on.schedule, [{ cron: audit.schedule }]);
  assert.deepEqual(frontmatter.on.bots, ["fixture-app[bot]"]);
  assert.deepEqual(Object.keys(frontmatter.on.workflow_dispatch), ["inputs"]);
  const inputs = frontmatter.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["correlation_id", "dry_run", "extra_instructions", "target_repo"]);
  for (const name of ["target_repo", "correlation_id", "extra_instructions"]) assert.equal(inputs[name].type, "string", name);
  assert.equal(inputs.dry_run.type, "boolean");
  assert.deepEqual(frontmatter.concurrency, { group: `sdlc-drift-${project.projectKey}`, "cancel-in-progress": false });
  assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.deepEqual(Object.keys(frontmatter.network), ["allowed"]);
  assert.ok(Array.isArray(frontmatter.network.allowed) && frontmatter.network.allowed.every((host) => typeof host === "string"));
  assert.deepEqual(frontmatter.checkout, [{ repository: project.repo, path: repoName, current: true, "github-app": APP }]);
  assert.deepEqual(frontmatter["mcp-servers"], audit.knowledgeSources.mcpServers);
  assert.ok(Array.isArray(frontmatter["pre-agent-steps"]) && Array.isArray(frontmatter["post-steps"]));
  const outputs = frontmatter["safe-outputs"];
  assert.deepEqual(Object.keys(outputs).sort(), ["create-pull-request", "github-app", "threat-detection"]);
  assert.deepEqual(outputs["github-app"], APP);
  assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false });
  const handler = outputs["create-pull-request"];
  assert.deepEqual(Object.keys(handler).sort(), [
    "auto-merge", "branch-prefix", "close-older-key", "close-older-pull-requests", "draft", "exclude-lock-yml", "fallback-as-issue", "labels", "max",
    "preserve-branch-name", "protected-files", "recreate-ref", "reviewers", "target-repo", "title-prefix",
  ]);
  assert.equal(handler["target-repo"], project.repo);
  assert.equal(typeof handler["title-prefix"], "string");
  assert.ok(handler["title-prefix"].length > 0);
  assert.ok(Array.isArray(handler.labels) && handler.labels.length > 0 && handler.labels.every((label) => typeof label === "string"));
  assert.deepEqual(handler.reviewers, audit.reviewers);
  assert.equal(handler.draft, audit.draft);
  assert.equal(handler["branch-prefix"], "sdlc/");
  assert.equal(handler["preserve-branch-name"], true);
  assert.equal(handler["recreate-ref"], true);
  assert.equal(handler["close-older-pull-requests"], true);
  assert.equal(handler["close-older-key"], `sdlc-drift-${project.projectKey}`);
  assert.equal(handler["exclude-lock-yml"], true);
  assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: [] });
  assert.equal(handler["auto-merge"], false);
  assert.equal(handler["fallback-as-issue"], true);
  assert.equal(handler.max, 1);
  assert.ok(frontmatter.engine, "an engine key is rendered");
  assert.ok("web-fetch" in frontmatter.tools);
  assert.ok(frontmatter.tools.bash.includes("git"));
  assert.ok(frontmatter.tools.bash.includes("node"), "the lab's own S2 scripts and the preset's build commands run on node");
  for (const command of audit.buildCommands) assert.ok(frontmatter.tools.bash.includes(command.trim().split(/\s+/)[0]), `bash allows the first word of '${command}'`);
  assert.deepEqual(Object.keys(customJobsOf(frontmatter.jobs)), ["escalate_failure"]);
  const job = frontmatter.jobs.escalate_failure;
  assert.deepEqual(job.permissions, { actions: "read", contents: "read", issues: "write" });
  assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"]);
  assert.equal(job.if, "failure() && inputs.dry_run != true");
  assert.equal("concurrency" in job, false);
  assert.deepEqual(job.steps[0], { uses: "actions/checkout@v4", with: { "sparse-checkout": "src\nschemas", "persist-credentials": false } });
  assert.deepEqual(job.steps[1], { run: "npm ci --ignore-scripts" });
  assert.equal(job.steps.some((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token")), false);
  assert.ok(job.steps.some((step) => String(step.run ?? "").includes("src/drift/escalate-gate-failure.mjs")));
  assert.equal(JSON.stringify(job).includes("update-poll-state"), false);
  assert.equal("finalize_poll_state" in frontmatter.jobs, false);
}

test("AC22: the committed drift-gh-admin-msft.md has the nine contract keys plus engine, tools and jobs, and no other", () => {
  const { frontmatter } = readWorkflow("drift-gh-admin-msft.md");
  assertContract(frontmatter, projectOf(preset, "gh-admin-msft"));
  assert.ok("web-fetch" in frontmatter.tools);
  assert.ok(frontmatter.tools.bash.includes("git") && frontmatter.tools.bash.includes("node"));
});

test("AC22: every rendered drift workflow of the preset satisfies the same shape", () => {
  for (const key of DRIFT_KEYS) assertContract(generated(key).frontmatter, projectOf(preset, key));
});

test("AC22: the escalate_failure job opts out of the detection gate so it can run after a failed agent", () => {
  const job = generated("gh-admin-msft").frontmatter.jobs.escalate_failure;
  assert.equal(job["detection-gate"], "status-only");
});

test("AC23: the values are rendered from the manifest: group, key, checkout, reviewers and draft", () => {
  const groups = DRIFT_KEYS.map((key) => generated(key).frontmatter.concurrency.group);
  assert.deepEqual(groups, DRIFT_KEYS.map((key) => `sdlc-drift-${key}`));
  assert.equal(new Set(groups).size, 3);
  for (const group of groups) assert.equal(group.startsWith("sdlc-state-"), false);
  const copilot = generated("copilot-lab").frontmatter;
  assert.equal(copilot.checkout[0].path, "day-in-the-life-copilot-lab");
  assert.equal(copilot["safe-outputs"]["create-pull-request"]["target-repo"], "ms-mfg-community/day-in-the-life-copilot-lab");
  const improving = generated("self-improving-agents").frontmatter;
  assert.equal(improving["safe-outputs"]["create-pull-request"].draft, true);
  assert.equal(improving["safe-outputs"]["create-pull-request"]["close-older-key"], "sdlc-drift-self-improving-agents");
  assert.deepEqual(generated("gh-admin-msft").frontmatter["safe-outputs"]["create-pull-request"].reviewers, ["johnhain-msft"]);
});

test("AC23: the golden files equal the generated files byte for byte, freshly rendered and as committed", () => {
  for (const key of DRIFT_KEYS) {
    const name = `drift-${key}.md`;
    const golden = readText(fixture("golden", name));
    assert.equal(rendered.files.get(`${W}/${name}`), golden, `${name}: fresh render`);
    assert.equal(readText(abs(W, name)), golden, `${name}: committed file`);
  }
});

test("AC23: the dry_run input only exposes the flag and no staging key is rendered anywhere", () => {
  for (const key of DRIFT_KEYS) {
    const text = rendered.files.get(`${W}/drift-${key}.md`);
    assert.equal(/staged/.test(text), false, key);
    assert.equal(generated(key).frontmatter.on.workflow_dispatch.inputs.dry_run.type, "boolean");
  }
});

function fixtureRender() {
  const manifest = mutate(minimalManifest(), (copy) => {
    const audit = projectOf(copy, "alpha-service").driftAudit;
    audit.instructions = "INLINE-INSTRUCTIONS-MARKER keep the service current";
    audit.instructionsFile = "instructions/fixture.md";
    audit.upkeepStrategy = "code-quality-and-improvement-scan";
    audit.knowledgeSources.watchUrls = [
      { url: "https://example.org/changelog", label: "Example changelog", kind: "changelog" },
      { url: "https://blog.example.net/feed.xml", label: "Example feed", kind: "feed" },
    ];
    audit.knowledgeSources.packageManifests = ["services/api/package.json"];
    audit.buildCommands = ["npm run build:docs"];
    audit.verifyCommands = ["npm ci", "npm test", "node scripts/check.mjs --strict"];
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), files: { "instructions/fixture.md": "FILE-INSTRUCTIONS-MARKER text that comes from the file\n" } });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    return parseWorkflow(result.files.get(`${W}/drift-alpha-service.md`));
  } finally {
    workspace.cleanup();
  }
}

test("AC25: the prompt body carries the instructions (inline first, then the file), strategy, watched sources, manifests and build commands", () => {
  const { body } = fixtureRender();
  const inline = body.indexOf("INLINE-INSTRUCTIONS-MARKER");
  const fromFile = body.indexOf("FILE-INSTRUCTIONS-MARKER");
  assert.ok(inline >= 0 && fromFile > inline, "inline instructions precede the instructions file");
  for (const text of [
    "code-quality-and-improvement-scan",
    "https://example.org/changelog", "Example changelog", "changelog",
    "https://blog.example.net/feed.xml", "Example feed", "feed",
    "services/api/package.json",
    "npm run build:docs",
  ]) {
    assert.ok(body.includes(text), `the body contains ${text}`);
  }
});

test("AC25: pre-agent-steps holds exactly the three S2 scripts in order, with one snapshot step and no per-entry hook", () => {
  const steps = fixtureRender().frontmatter["pre-agent-steps"];
  assert.equal(steps.length, 3);
  assert.ok(steps[0].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs"'));
  assert.ok(steps[1].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs"'));
  assert.ok(steps[2].run.startsWith('node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs"'));
  assert.equal(steps.filter((step) => String(step.run).includes("snapshot-watch-sources.mjs")).length, 1);
});

test("AC25: the deduplication step names its workflow: the close-older key that its pull requests carry and its upkeepStrategy (SPEC-02 AC10)", () => {
  const { frontmatter } = fixtureRender();
  const [, dedupe] = frontmatter["pre-agent-steps"];
  assert.match(dedupe.run, / --target-repo "\$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-alpha-service --upkeep-strategy code-quality-and-improvement-scan$/);
  assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"], "sdlc-drift-alpha-service", "the key is the one of the safe output, which gh-aw writes into the body of each pull request");
  for (const key of DRIFT_KEYS) {
    const step = generated(key).frontmatter["pre-agent-steps"][1];
    assert.ok(step.run.endsWith(` --close-older-key sdlc-drift-${key} --upkeep-strategy ${projectOf(preset, key).driftAudit.upkeepStrategy}`), `${key}: ${step.run}`);
  }
});

test("AC25: the strategy guidance of the prompt body is the text of prompts/drift/strategy-<value>.md of the repository that is rendered, and a repository without the file gets the built-in text, which says the same (SPEC-02 AC14)", () => {
  const manifest = mutate(minimalManifest(), (copy) => {
    projectOf(copy, "alpha-service").driftAudit.upkeepStrategy = "content-and-docs-sync";
  });
  const edited = "## Upkeep strategy: content-and-docs-sync\n\nGUIDANCE-FROM-THE-FILE-OF-THE-REPOSITORY\n";
  const withFile = createWorkspace({ manifestText: toYaml(manifest), files: { "prompts/drift/strategy-content-and-docs-sync.md": edited } });
  const without = createWorkspace({ manifestText: toYaml(manifest) });
  const broken = createWorkspace({ manifestText: toYaml(manifest), files: { "prompts/drift/strategy-content-and-docs-sync.md": "no heading\n" } });
  try {
    const bodyOf = (workspace) => parseWorkflow(renderFleet(request, { cwd: workspace.dir }).files.get(`${W}/drift-alpha-service.md`)).body;
    assert.ok(bodyOf(withFile).includes(edited.trim()), "the file of the repository");
    assert.equal(bodyOf(withFile).includes("Compare the watched-source snapshots with the target's documentation"), false, "and not the built-in text beside it");
    assert.ok(bodyOf(without).includes(readText(abs("prompts", "drift", "strategy-content-and-docs-sync.md")).trim()), "without the file, the built-in text is the committed fragment, to the letter");
    const refused = renderFleet(request, { cwd: broken.dir });
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused.result), /drift-strategy-fragment/, "a file that is there and unusable is refused and not replaced");
  } finally {
    withFile.cleanup();
    without.cleanup();
    broken.cleanup();
  }
});

test("AC25: post-steps equals verifyCommands in order, each named by its command, with no continue-on-error or if", () => {
  const steps = fixtureRender().frontmatter["post-steps"];
  assert.deepEqual(steps.map((step) => step.run), ["npm ci", "npm test", "node scripts/check.mjs --strict"]);
  assert.deepEqual(steps.map((step) => step.name), ["npm ci", "npm test", "node scripts/check.mjs --strict"]);
  for (const step of steps) {
    assert.equal("continue-on-error" in step, false);
    assert.equal("if" in step, false);
    assert.equal(step["working-directory"], "alpha-service");
  }
});

test("AC25: the preset's copilot-lab post-steps run the S2 validator of the audit", () => {
  const steps = readWorkflow("drift-copilot-lab.md").frontmatter["post-steps"];
  assert.ok(steps.some((step) => step.run.includes('node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"')));
  assert.deepEqual(steps.map((step) => step.run), projectOf(preset, "copilot-lab").driftAudit.verifyCommands.map((command) => (steps.find((step) => step.run === command)?.run ?? command)));
  for (const key of DRIFT_KEYS) {
    for (const step of generated(key).frontmatter["post-steps"]) {
      assert.equal("continue-on-error" in step, false);
      assert.equal("if" in step, false);
    }
  }
});

test("AC21: instructionsFile resolves from the repository root, whichever directory the manifest is in", () => {
  const manifest = mutate(minimalManifest(), (copy) => {
    projectOf(copy, "alpha-service").driftAudit.instructionsFile = "instructions/alpha.md";
  });
  const workspace = createWorkspace({
    manifestText: toYaml(manifest),
    files: {
      "config/fleet.yaml": toYaml(manifest),
      "instructions/alpha.md": "ROOT-INSTRUCTIONS-MARKER the file at the repository root\n",
      "config/instructions/alpha.md": "MANIFEST-DIRECTORY-MARKER the file beside the manifest\n",
    },
  });
  try {
    for (const manifestPath of ["sdlc.yaml", "config/fleet.yaml"]) {
      const result = renderFleet({ ...request, manifestPath }, { cwd: workspace.dir });
      assert.ok(result.ok, `${manifestPath}: ${JSON.stringify(result.result)}`);
      const { body } = parseWorkflow(result.files.get(`${W}/drift-alpha-service.md`));
      assert.ok(body.includes("ROOT-INSTRUCTIONS-MARKER"), `${manifestPath}: the repository-root file is used`);
      assert.equal(body.includes("MANIFEST-DIRECTORY-MARKER"), false, `${manifestPath}: the file beside the manifest is not read`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC27: a file-write spy around a reconcile run sees only .github/workflows (or the dry-run staging directory), never /tmp/gh-aw/agent", async () => {
  const workspace = createWorkspace();
  const writes = [];
  const originals = {};
  const spied = ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "copyFileSync", "renameSync", "unlinkSync", "mkdtempSync", "cpSync"];
  for (const name of spied) {
    originals[name] = fs[name];
    fs[name] = function recorded(target, ...rest) {
      writes.push(path.resolve(String(target)));
      return originals[name].call(this, target, ...rest);
    };
  }
  try {
    await workspace.reconcile(request);
    await workspace.reconcile({ ...request, dryRun: true });
  } finally {
    for (const name of spied) fs[name] = originals[name];
  }
  try {
    assert.ok(writes.length > 0, "the spy recorded the writes");
    const workflowsDirectory = path.join(workspace.dir, ".github", "workflows");
    const stagingPrefix = path.join(os.tmpdir(), "sdlc-reconcile-");
    for (const target of writes) {
      assert.equal(target.split(path.sep).join("/").includes("/tmp/gh-aw/agent"), false, target);
      const inWorkflows = target === workflowsDirectory || target.startsWith(workflowsDirectory + path.sep);
      assert.ok(inWorkflows || target.startsWith(stagingPrefix), `unexpected write: ${target}`);
    }
    assert.ok(writes.some((target) => target.startsWith(workflowsDirectory + path.sep)), "the real run wrote under .github/workflows");
    assert.ok(writes.some((target) => target.startsWith(stagingPrefix)), "the dry run wrote only to its staging directory");
  } finally {
    workspace.cleanup();
  }
});

test("AC27: the engine contains no drift evaluation and makes no network request itself", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  assert.equal(/\bfetch\s*\(|node:https?|node:net\b|node:dns|XMLHttpRequest|WebSocket/.test(source), false);
  assert.equal(/fs\.\w*(write|mkdir|append|copy|rm)\w*\([^)]*\/tmp\/gh-aw/.test(source), false);
});
