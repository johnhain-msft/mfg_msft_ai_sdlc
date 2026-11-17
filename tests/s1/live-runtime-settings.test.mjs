// What live runs showed the generated workflows need. Each of these settings was first made by hand in a generated workflow, after a run failed (ae32bf1 and
// 61f0678 in drift-gh-admin-msft, 9a49f71 in cascade-mechanical-ghec-admin), and the next reconcile took it out again, because neither the manifest nor the renderer
// knew it. They are data of sdlc.yaml now and the renderer writes them; the committed workflows and their locks, which are what runs, have to carry them.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest } from "./helpers/fixtures.mjs";

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
// reaches nothing, so every drift workflow allows it, as the mechanical cascades do. Run 43716421196 of drift-copilot-lab (issue #14) did the same
// over `sed` and `cut`, so the lab's audit has those two text tools as well.
const DRIFT_BASE_BASH = ["cat", "cd", "curl", "date", "find", "git", "grep", "head", "ls", "node", "tail", "wc"];
test("61f0678: the other drift workflows keep the allowlist that cd, git, node and their build commands give them, and the lab's audit adds sed and cut", () => {
  for (const [key, bash] of [
    ["copilot-lab", [...DRIFT_BASE_BASH, "cut", "sed"].sort()],
    ["self-improving-agents", DRIFT_BASE_BASH],
  ]) {
    for (const [label, workflow] of versions(`drift-${key}.md`)) {
      assert.deepEqual(workflow.frontmatter.tools.bash, bash, `${key} ${label}`);
    }
    for (const word of bash) assert.ok(shellCommands(`drift-${key}`).includes(word), `${key}: the lock lets the agent run ${word}`);
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
    "python -m pytest -q",
    "aiam release build --out /tmp/aiam-verify-dist",
  ]);
});

// Runs 43645598635 and 43647886060, the first cascades of the copilot-config edge, show three more gates that only the first live import reaches. The downstream's
// tests import a top-level module that only `python -m pytest` puts on sys.path, as its own CI runs them. Its importer writes files with protected names, which the
// blocking protected-files policy refuses whatever allowed-files says: .github/CODEOWNERS and README.md files in the first import (12 deleted with retired skills, 1
// added), and the catalog's one DESIGN.md and one requirements.txt in any later import that changes them. And its first import changes 170 files, past the
// handler's default of 100.
const COPILOT_CONFIG_PATH_EXCLUDES = [
  ".github/CODEOWNERS",
  "assets/skills/ai-landing-zone-design/DESIGN.md",
  "assets/skills/slide-review/scripts/requirements.txt",
];
test("43645598635: the copilot-config cascade runs pytest as the downstream's CI does, un-protects the files its importer writes and allows a whole-catalog patch", () => {
  const id = "cascade-mechanical-copilot-config";
  for (const [label, workflow] of versions(`${id}.md`)) {
    const handler = workflow.frontmatter["safe-outputs"]["create-pull-request"];
    assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: [...COPILOT_CONFIG_PATH_EXCLUDES.map((path) => `/${path}`), "README.md"] }, label);
    assert.equal(handler["max-patch-files"], 1000, label);
    const runs = workflow.frontmatter["post-steps"].map((step) => step.run);
    assert.ok(runs.includes("python -m pytest -q"), label);
    assert.equal(runs.includes("pytest -q"), false, `${label}: the console script leaves the repository root off sys.path`);
  }
  const steps = agentSteps(id);
  assert.ok(steps.some((step) => step.run === "python -m pytest -q" && step["working-directory"] === "ai_asset_management"), "the lock runs the module form");
  assert.equal(steps.some((step) => step.run === "pytest -q"), false);
  const lock = lockOf(id);
  for (const [job, key] of [
    ["agent", "GH_AW_SAFE_OUTPUTS_CONFIG"],
    ["safe_outputs", "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG"],
  ]) {
    const [config] = lock.jobs[job].steps.filter((step) => Object.hasOwn(step.env ?? {}, key)).map((step) => JSON.parse(step.env[key]).create_pull_request);
    assert.equal(config.max_patch_files, 1000, `${id}: ${key}`);
  }
  const [handler] = lock.jobs.safe_outputs.steps
    .filter((step) => Object.hasOwn(step.env ?? {}, "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG"))
    .map((step) => JSON.parse(step.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG).create_pull_request);
  assert.equal(handler.protected_files_policy, "blocked");
  assert.deepEqual(handler.protected_files_path_exclude, COPILOT_CONFIG_PATH_EXCLUDES, "each protected file the catalog holds, by its exact path");
  assert.equal(handler.protected_files.includes("README.md"), false, "README.md is writable, within allowed-files");
  for (const name of ["CODEOWNERS", "DESIGN.md", "requirements.txt"]) assert.ok(handler.protected_files.includes(name), `a ${name} at any other path stays protected`);
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

// Run 43926158616 of drift-copilot-lab (issue #17): its agent filed a valid drift report, and then the safe_outputs job (step 7) and the conclusion job (step 3) failed at `Generate
// GitHub App token` with HTTP 404 on GET /repos/ms-mfg-community/mfg_msft_ai_sdlc/installation. The step has one owner, which gh-aw takes from the single checkout entry of the workflow,
// the target's, and it resolves every name of its `repositories` under that owner: the name of the central repository, which the renderer listed first, was looked up under the owner of
// the target, which does not have it. The handlers that a drift or an implementation workflow has all take the target as their target-repo, so the token names that repository alone; what that scope
// gives up in the conclusion job, which also writes with it, is pinned by the test after the one for the cascades.
const DRIFT_PROJECTS = presetManifest().projects.filter((project) => project.driftAudit.enabled);
const tokenSteps = (id, job) => lockOf(id).jobs[job].steps.filter((step) => step.id === "safe-outputs-app-token");

test("43926158616: the safe-outputs token of every drift and implementation workflow is minted for the target repository alone, so a target of another owner never makes it ask for the central repository", () => {
  assert.deepEqual(DRIFT_PROJECTS.map((project) => project.projectKey), ["gh-admin-msft", "copilot-lab", "self-improving-agents"]);
  assert.ok(DRIFT_PROJECTS.some((project) => project.repo.startsWith("ms-mfg-community/")), "the preset has targets of another owner, the case that failed");
  for (const project of DRIFT_PROJECTS) {
    const name = project.repo.split("/")[1];
    for (const id of [`drift-${project.projectKey}`, `implement-${project.projectKey}`]) {
      for (const [label, workflow] of versions(`${id}.md`)) {
        const app = workflow.frontmatter["safe-outputs"]["github-app"];
        assert.deepEqual(app.repositories, [name], `${id} ${label}`);
        assert.equal(JSON.stringify(app).includes("github.event.repository.name"), false, `${id} ${label}: the central repository is not named`);
      }
      for (const job of ["safe_outputs", "conclusion"]) {
        const steps = tokenSteps(id, job);
        assert.ok(steps.length > 0, `${id}: the ${job} job mints the token`);
        for (const step of steps) {
          // what actions/create-github-app-token asks the API for: every name under the one owner of the step
          const requested = String(step.with.repositories).split("\n").map((repository) => `${step.with.owner}/${repository}`);
          assert.deepEqual(requested, [project.repo], `${id} ${job}: the lock requests the target repository and no other`);
        }
      }
    }
  }
});

test("43926158616: the cascades, whose token has the orchestrator's owner, still name the central repository and the downstream one", () => {
  const names = [...rendered.files.keys()].filter((name) => /\/cascade-(?:ai|mechanical)-[^/]+\.md$/.test(name));
  assert.equal(names.length, 6, "all six cascade workflows are covered");
  for (const name of names) {
    const id = name.split("/").pop().replace(/\.md$/, "");
    const downstream = parseWorkflow(rendered.files.get(name)).frontmatter["safe-outputs"]["create-pull-request"]["target-repo"].split("/")[1];
    const repositories = ["${{ github.event.repository.name }}", downstream];
    for (const [label, workflow] of versions(`${id}.md`)) {
      assert.deepEqual(workflow.frontmatter["safe-outputs"]["github-app"].repositories, repositories, `${id} ${label}: central and the actual downstream, not just any two repositories`);
    }
    for (const job of ["safe_outputs", "conclusion"]) {
      const steps = tokenSteps(id, job);
      assert.ok(steps.length > 0, `${id}: the ${job} job mints the token`);
      for (const step of steps) {
        assert.equal(step.with.owner, "${{ github.repository_owner }}", `${id} ${job}: the cascades' downstream repositories have the orchestrator's owner (SPEC-05 AC19)`);
        assert.deepEqual(step.with.repositories.split("\n"), repositories, `${id} ${job}: the executable lock preserves both required repository grants`);
      }
    }
  }
});

// What that scope gives up, which SPEC-01 AC69 records. The conclusion job of gh-aw v1.0.1 mints a token of its own, with the owner, repositories and permissions of the safe_outputs job, and hands it to
// the gh-aw scripts of six steps. Those scripts address the repository that the workflow runs in (`context.repo`, the central repository), not the target-repo of a handler, and a token that is minted
// for the target alone cannot reach it, so the central-repository writes of the conclusion job are given up in every drift and implementation workflow, in those of a target with the central
// repository's owner too (their token named the central repository before). Of the six scripts only handle_detection_runs.cjs writes there under the settings that the renderer makes: when the
// detection job concludes warning or failure it searches for the issue "[aw] Detection Runs", opens it if there is none and comments on it, and it catches every error, so the step warns and the job
// does not fail. The fleet renders threat-detection: continue-on-error: false, so the lock sets GH_AW_DETECTION_CONTINUE_ON_ERROR to "false", a detection problem concludes failure and fails the
// detection job, and escalate_failure still opens the [sdlc-failure] issue of the central repository for it, with the token of its own job.
const APP_TOKEN = "${{ steps.safe-outputs-app-token.outputs.token }}";
/** The gh-aw script that a github-script step of a lock runs: the `<name>.cjs` that it requires after the one that sets up the globals. */
const handlerOf = (step) => [...String(step.with?.script ?? "").matchAll(/path\.join\(actionsDir, '([\w.]+\.cjs)'\)/g)].map((match) => match[1]).find((name) => name !== "setup_globals.cjs");
const CONCLUSION_SCRIPTS = ["handle_agent_failure.cjs", "handle_detection_runs.cjs", "handle_noop_message.cjs", "missing_tool.cjs", "report_failed_jobs.cjs", "report_incomplete_handler.cjs"];

test("43926158616 (AC69): the central-repository writes of the conclusion job are given up by every drift and implementation workflow, those of a target with the central owner included, and escalate_failure is what still reports a failed run there", () => {
  const central = presetManifest().projects.find((project) => project.projectKey === "ai-sdlc").repo;
  const sameOwner = DRIFT_PROJECTS.filter((project) => project.repo.split("/")[0] === central.split("/")[0]);
  assert.deepEqual(sameOwner.map((project) => project.projectKey), ["gh-admin-msft"], "one target has the central repository's owner: its token could have kept the central repository, and gives it up like the others");
  for (const project of DRIFT_PROJECTS) {
    for (const id of [`drift-${project.projectKey}`, `implement-${project.projectKey}`]) {
      const lock = lockOf(id);
      // the writes: the scripts of the conclusion job that get the token, and the settings that keep five of the six from writing to the central repository
      const writers = lock.jobs.conclusion.steps.filter((step) => step.with?.["github-token"] === APP_TOKEN);
      assert.deepEqual(writers.map(handlerOf).sort(), CONCLUSION_SCRIPTS, `${id}: the scripts that get the token of the conclusion job; a new one has to be read for what it writes to the central repository, and AC69 amended`);
      const step = (stepId) => writers.find((candidate) => candidate.id === stepId);
      assert.equal(handlerOf(step("detection_runs")), "handle_detection_runs.cjs", `${id}: the Log detection run step is the one that writes to the central repository`);
      assert.equal(step("noop").env.GH_AW_NOOP_REPORT_AS_ISSUE, "false", `${id}: handle_noop_message.cjs posts nothing`);
      assert.equal(step("handle_agent_failure").env.GH_AW_FAILURE_REPORT_AS_ISSUE, "false", `${id}: handle_agent_failure.cjs opens and comments on nothing`);
      // the token: the target alone, so that none of those writes reaches the central repository, and no actions permission, which report_failed_jobs.cjs needs to list the jobs of the run
      const mints = tokenSteps(id, "conclusion");
      assert.equal(mints.length, 1, `${id}: the conclusion job mints one token`);
      const requested = mints[0].with.repositories.split("\n").map((name) => `${mints[0].with.owner}/${name}`);
      assert.deepEqual(requested, [project.repo], `${id}: the target alone`);
      if (sameOwner.includes(project)) assert.equal(mints[0].with.owner, central.split("/")[0], `${id}: the token has the central repository's owner and still does not ask for the central repository`);
      assert.deepEqual(Object.keys(mints[0].with).filter((key) => key.startsWith("permission-")).sort(), ["permission-contents", "permission-issues", "permission-pull-requests"], `${id}: no actions permission`);
      // the detection problem that is left to record, and the job that reports it
      assert.equal(lock.jobs.detection.steps.find((candidate) => candidate.id === "detection_conclusion").env.GH_AW_DETECTION_CONTINUE_ON_ERROR, "false", `${id}: a detection problem fails the detection job`);
      const escalation = lock.jobs.escalate_failure;
      assert.deepEqual(escalation.needs, ["agent", "detection", "safe_outputs"], `${id}: escalate_failure waits for the detection job`);
      assert.ok(String(escalation.if).startsWith("failure()"), `${id}: and runs when one of them failed`);
      const escalate = escalation.steps.find((candidate) => String(candidate.run ?? "").includes("escalate-gate-failure.mjs"));
      assert.ok(escalate, `${id}: the job runs the escalation`);
      assert.equal(escalate.env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}", `${id}: the [sdlc-failure] issue of the central repository is filed with the token of the job, not the App's`);
    }
  }
});

test("43926158616 (AC69): the spec and the generator say what the token of a drift or implementation workflow gives up, and do not claim that those workflows write only to their target", () => {
  const row = readText(abs("specs", "01-manifest-and-reconciler.md")).split("\n").find((line) => line.startsWith("| AC69 |"));
  assert.ok(row, "the spec has the AC69 row");
  for (const text of [...CONCLUSION_SCRIPTS, "[aw] Detection Runs", "gh-admin-msft", "given up", "GH_AW_DETECTION_CONTINUE_ON_ERROR", "escalate_failure", "secrets.GITHUB_TOKEN"]) assert.ok(row.includes(text), `AC69 names ${text}`);
  assert.equal(row.includes("is the only repository that they write to"), false, "AC69 does not claim what the conclusion job disproves");
  const generator = readText(abs("src", "reconcile.mjs"));
  assert.equal(/writes? only to the target/i.test(generator), false, "no comment of the generator claims it either");
  for (const text of ["Detection Runs", "given up", "AC69"]) assert.ok(generator.includes(text), `the comments of the generator name ${text}`);
});

// Run 43933185358 of cascade-mechanical-copilot-config: the agent opened with `cd "$GITHUB_WORKSPACE/ai_asset_management" && echo ... && git status --short | head && git branch
// --show-current && command -v aiam`, and then with `cd ... && git branch --show-current; echo "$UPSTREAM_SHA"; command -v aiam`. Copilot runs with --no-ask-user and refused both calls
// (denied-no-approval-rule-and-could-not-request-from-user), because `command` was not on the allowlist, and the agent called report_incomplete without running `aiam sync-upstream`.
/** The commands that the lock of a cascade (the Copilot engine without the SDK) lets its agent run: the `--allow-tool 'shell(<command>)'` arguments of the step that starts it. */
function cascadeShellCommands(id) {
  const step = agentSteps(id).find((candidate) => String(candidate.run ?? "").includes("--allow-tool"));
  assert.ok(step, `${id}: the lock has the step that starts the agent`);
  return [...step.run.matchAll(/--allow-tool '\\''shell\(([^)]+)\)'\\''/g)].map((match) => match[1].replace(/:\*$/, ""));
}

test("43933185358: every mechanical cascade lets its agent run command -v, in the workflow and in its lock, so that the agent can look for the importer before it runs it", () => {
  const ids = [...rendered.files.keys()].filter((name) => /\/cascade-mechanical-[^/]+\.md$/.test(name)).map((name) => name.split("/").pop().replace(/\.md$/, ""));
  assert.deepEqual(ids.sort(), ["cascade-mechanical-ai-sdlc", "cascade-mechanical-copilot-config", "cascade-mechanical-ghec-admin"]);
  for (const id of ids) {
    for (const [label, workflow] of versions(`${id}.md`)) assert.ok(workflow.frontmatter.tools.bash.includes("command"), `${id} ${label}`);
    assert.ok(cascadeShellCommands(id).includes("command"), `${id}: the lock lets the agent run command`);
  }
  // every command of the two calls that the run refused is now allowed: cd, echo, git, head and command (the importer, aiam, is the first word of the edge's import command)
  const commands = cascadeShellCommands("cascade-mechanical-copilot-config");
  for (const word of ["cd", "echo", "git", "head", "command", "aiam"]) assert.ok(commands.includes(word), `the lock of copilot-config lets the agent run ${word}`);
  for (const word of ["gh", "curl", "wget"]) assert.equal(commands.includes(word), false, `and not ${word}`);
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
