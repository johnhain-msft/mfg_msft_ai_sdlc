// AC54: re-running either entry point with unchanged inputs against unchanged GitHub state is idempotent: no second App is registered when
// APP_CLIENT_ID and APP_PRIVATE_KEY are supplied, no existing SDLC_SYNC_STATE_<SLUG> variable is written, sdlc.yaml and
// instructions/<projectKey>.md stay byte-identical, and two runs that start from the same fake-GitHub state print byte-identical reports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { reconcile as realReconcile } from "../../src/reconcile.mjs";
import { createScenario, fixtureRepos, githubSideBrowser } from "./helpers/harness.mjs";

const REPOS = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const EDGE = ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok", "--instructions", "Keep docs current"];
const git = (scenario, ...args) => execFileSync("git", args, { cwd: scenario.workspace.dir, encoding: "utf8" });
const stateWrites = (scenario) => scenario.fake.log.filter((entry) => entry.method !== "GET" && (entry.path.includes("SDLC_SYNC_STATE_") || entry.body?.name?.startsWith?.("SDLC_SYNC_STATE_")));
const conversions = (scenario) => scenario.fake.requests("POST /app-manifests/:code/conversions");

// --- bootstrap -------------------------------------------------------------------------------------------------------------

test("AC54: bootstrap twice against one fake: the second run writes no state variable, registers no App, binds no listener and leaves git clean", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.commitAll("baseline");
    const first = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()), reconcile: realReconcile });
    assert.equal(first.code, 0, first.stderr);
    scenario.workspace.commitAll("first run output");
    scenario.fake.clearLog();
    scenario.browser.urls.length = 0;

    const second = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()), reconcile: realReconcile });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(stateWrites(scenario), [], "zero state-variable writes");
    assert.deepEqual(conversions(scenario), [], "no conversion request");
    assert.deepEqual(scenario.browser.urls, [], "no browser page");
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code"), "git diff --exit-code is clean");
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "");
    assert.deepEqual(JSON.parse(second.stdout).variablesSet, ["APP_CLIENT_ID"], "only the idempotent upsert of APP_CLIENT_ID is repeated");
  } finally {
    await scenario.cleanup();
  }
});

test("AC54: after a registration the next run with APP_CLIENT_ID and APP_PRIVATE_KEY registers no second App", async () => {
  const scenario = await createScenario();
  try {
    const first = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(conversions(scenario).length, 1);
    const registered = { APP_CLIENT_ID: scenario.fake.state.app.client_id, APP_PRIVATE_KEY: scenario.fake.state.conversionPem };
    scenario.browser.urls.length = 0;

    const second = await scenario.bootstrap([], { env: scenario.env(registered), openBrowser: githubSideBrowser(scenario) });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(conversions(scenario).length, 1, "still the one conversion of the first run");
    assert.deepEqual(scenario.browser.urls, [], "no registration page and no installation page");
    assert.equal(stateWrites(scenario).length, 2, "the two state variables were written once, by the first run");
    assert.equal(JSON.parse(second.stdout).appSlug, JSON.parse(first.stdout).appSlug);
  } finally {
    await scenario.cleanup();
  }
});

test("AC54: two bootstrap runs from the same fresh state print byte-identical reports (existing App, then new App)", async () => {
  for (const mode of ["existing", "new"]) {
    const outputs = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scenario = await createScenario();
      try {
        const run =
          mode === "existing"
            ? await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) })
            : await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } });
        assert.equal(run.code, 0, run.stderr);
        outputs.push(run.stdout);
      } finally {
        await scenario.cleanup();
      }
    }
    assert.equal(outputs[0], outputs[1], `${mode} App: identical stdout`);
    assert.ok(outputs[0].length > 100);
  }
});

// --- onboard ---------------------------------------------------------------------------------------------------------------

test("AC54: onboard twice with the same inputs: no state-variable write, sdlc.yaml and the instructions file byte-identical, git diff clean", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    scenario.workspace.commitAll("baseline");
    const first = await scenario.onboard(EDGE, { env: scenario.env(scenario.appCredentials()), reconcile: realReconcile });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stateWrites(scenario).length, 1, "the first run created the one state variable");
    scenario.workspace.commitAll("first run output");
    const manifest = scenario.workspace.read("sdlc.yaml");
    const instructions = scenario.workspace.read("instructions/node-app.md");
    scenario.fake.clearLog();

    const second = await scenario.onboard(EDGE, { env: scenario.env(scenario.appCredentials()), reconcile: realReconcile });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(stateWrites(scenario), [], "zero state-variable writes");
    assert.deepEqual(conversions(scenario), []);
    assert.equal(scenario.workspace.read("sdlc.yaml"), manifest);
    assert.equal(scenario.workspace.read("instructions/node-app.md"), instructions);
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code"));
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "", "the generated workflows of the real S1 are byte-identical too");
    assert.match(second.stderr, /\(already up to date\)/);
    const report = JSON.parse(second.stdout);
    assert.deepEqual([report.onboardedProjects, report.variablesSet], [[], []], "nothing was added or updated");
  } finally {
    await scenario.cleanup();
  }
});

test("AC54: two onboarding runs from the same fresh state print byte-identical reports", async () => {
  const outputs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scenario = await createScenario({ fake: { repos: REPOS } });
    try {
      const run = await scenario.onboard(EDGE, { env: scenario.env(scenario.appCredentials()) });
      assert.equal(run.code, 0, run.stderr);
      outputs.push([run.stdout, scenario.workspace.read("sdlc.yaml"), scenario.workspace.read("instructions/node-app.md")]);
    } finally {
      await scenario.cleanup();
    }
  }
  assert.equal(outputs[0][0], outputs[1][0], "the report");
  assert.equal(outputs[0][1], outputs[1][1], "sdlc.yaml");
  assert.equal(outputs[0][2], outputs[1][2], "the instructions file");
  assert.equal(JSON.parse(outputs[0][0]).onboardedProjects.length, 2);
});

test("AC54: the operator's edit between two runs is not undone by the second run (idempotent does not mean overwriting)", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    assert.equal((await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) })).code, 0);
    scenario.workspace.write("sdlc.yaml", scenario.workspace.read("sdlc.yaml").replace(/(projectKey: node-app[\s\S]*?draft: )false/, "$1true"));
    const edited = scenario.workspace.read("sdlc.yaml");
    assert.match(edited, /draft: true/);
    assert.equal((await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) })).code, 0);
    assert.equal(scenario.workspace.read("sdlc.yaml"), edited);
  } finally {
    await scenario.cleanup();
  }
});
