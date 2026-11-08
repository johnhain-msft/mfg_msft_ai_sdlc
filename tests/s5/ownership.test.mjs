// AC24, AC39, AC40 and AC41: who owns what. S3 is the sole writer of an existing SDLC_SYNC_STATE_<SLUG> variable; S1 owns sdlc.yaml's schema, the rendered
// workflows and their policy blocks; S5 owns aw.yml and the GitHub-side App, variable and secret state, and its GitHub-side writes are
// limited to Actions variables and secrets on the central repository, the one conversion call and the opt-in workflow disabling.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { installationTargets } from "../../bin/lib/installations.mjs";
import { REPO_ROOT, createScenario, fixtureRepos, githubSideBrowser, installationOn } from "./helpers/harness.mjs";

const PRESET_ORIGIN = "https://github.com/johnhain-msft/mfg_msft_ai_sdlc.git";
const PRESET_CENTRAL = "johnhain-msft/mfg_msft_ai_sdlc";
const STATE = (slug) => `SDLC_SYNC_STATE_${slug}`;
const git = (scenario, ...args) => execFileSync("git", args, { cwd: scenario.workspace.dir, encoding: "utf8" });

/** Every file of this repository that is committed under the paths that S1 and S5 care about, as text. */
function trackedFiles() {
  const listing = execFileSync("git", ["ls-files", "-z", "--", "sdlc.yaml", "instructions", "schemas", ".github"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  return Object.fromEntries(listing.map((relative) => [relative, fs.readFileSync(path.join(REPO_ROOT, relative), "utf8")]));
}

/** A temporary git working copy of this repository (its committed sdlc.yaml, instructions, schemas and workflows), with fakes that serve its accounts. */
async function presetScenario(options = {}) {
  const { "sdlc.yaml": manifest, ...files } = trackedFiles();
  const { accounts } = installationTargets(YAML.parse(manifest), PRESET_CENTRAL);
  const scenario = await createScenario({
    workspace: { origin: PRESET_ORIGIN, manifest, files },
    fake: { installations: accounts.map((account) => installationOn(account)), repos: fixtureRepos({ "johnhain-msft/node-app": "node-app", "johnhain-msft/edge-ok": "edge-ok" }), ...(options.fake ?? {}) },
    ...(options.scenario ?? {}),
  });
  scenario.workspace.commitAll("copy of the repository");
  return scenario;
}

// --- AC39 ------------------------------------------------------------------------------------------------------------------

test("AC39: bin/sdlc-bootstrap.mjs in a working copy of this repository, with an S1 that writes nothing, leaves git status empty", async () => {
  const scenario = await presetScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.reconcile.calls.length, 1);
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "");
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code", "--", "schemas", ".github/workflows"));
    assert.equal(scenario.workspace.read("sdlc.yaml"), trackedFiles()["sdlc.yaml"]);
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, argv, projectKey] of [
  ["a repository", ["--repo", "johnhain-msft/node-app"], "node-app"],
  ["a repository with a downstream, a schedule, a watch URL and instructions", ["--repo", "johnhain-msft/node-app", "--downstream", "johnhain-msft/edge-ok", "--schedule", "0 5 * * 1", "--watch-url", "https://example.com/changelog", "--instructions", "Keep docs current"], "node-app"],
]) {
  test(`AC39: bin/sdlc-onboard.mjs onboarding ${label} changes only sdlc.yaml and instructions/<projectKey>.md`, async () => {
    const scenario = await presetScenario();
    try {
      const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()) });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(git(scenario, "status", "--porcelain", "--untracked-files=all").trimEnd().split("\n").sort(), [` M sdlc.yaml`, `?? instructions/${projectKey}.md`].sort());
      assert.doesNotThrow(() => git(scenario, "diff", "--exit-code", "--", "schemas", ".github/workflows"));
      assert.equal(scenario.reconcile.calls.length, 1);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC39: S5 has no code that names the files that S1 owns: the schema, aw.json, the rendered onboarding workflow and the router", () => {
  for (const file of listBin()) {
    const text = fs.readFileSync(file, "utf8").replace(/cascade-router\.yml workflow_dispatch with reset_blocked: true/, "");
    assert.equal(/sdlc\.schema\.json|aw\.json|sdlc-onboard\.(md|lock\.yml)|cascade-router/.test(text), false, `${path.relative(REPO_ROOT, file)} names a file that S1 owns`);
  }
});

test("AC39: the only file-writing code of S5 is the atomic writer that bin/lib/onboard-run.mjs uses for sdlc.yaml and the instructions file", () => {
  const writers = listBin().filter((file) => /\b(writeFileSync|appendFileSync|renameSync|mkdirSync|copyFileSync|cpSync|rmSync|unlinkSync|createWriteStream|writeFile|appendFile)\b/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(writers.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/")), ["bin/lib/atomic-write.mjs"]);
  const users = listBin().filter((file) => /atomic-write\.mjs/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(users.map((file) => path.basename(file)), ["onboard-run.mjs"]);
});

// --- AC40 ------------------------------------------------------------------------------------------------------------------

/** src/reconcile.mjs and every repository module that it imports, directly or not. */
function importGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const resolved = [target, `${target}.mjs`, `${target}.js`, path.join(target, "index.mjs")].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved) visit(resolved);
    }
  };
  visit(entry);
  return [...seen];
}

test("AC40: src/reconcile.mjs and every module that it imports name neither aw.yml nor an Actions secrets route", () => {
  const modules = importGraph(path.join(REPO_ROOT, "src", "reconcile.mjs"));
  assert.ok(modules.length >= 1);
  assert.ok(modules.some((file) => file.endsWith("reconcile.mjs")));
  for (const file of modules) assert.equal(/aw\.yml|actions\/secrets/.test(fs.readFileSync(file, "utf8")), false, `${path.relative(REPO_ROOT, file)}`);
});

test("AC40: S1 does not call the GitHub API itself: no module of its import graph opens an HTTP connection", () => {
  for (const file of importGraph(path.join(REPO_ROOT, "src", "reconcile.mjs"))) {
    assert.equal(/\bfetch\s*\(|node:https?|from\s+["']https?["']|require\(["']https?["']\)/.test(fs.readFileSync(file, "utf8")), false, `${path.relative(REPO_ROOT, file)}`);
  }
});

// --- AC24 ------------------------------------------------------------------------------------------------------------------

const EXISTING = (scenario, slugs) => slugs.forEach((slug) => scenario.fake.setVariable("example-owner/example-repo", STATE(slug), `{"existing":"${slug}"}`));
const nonGetToState = (scenario) => scenario.fake.log.filter((entry) => entry.method !== "GET" && (entry.path.includes("SDLC_SYNC_STATE_") || entry.body?.name?.startsWith?.("SDLC_SYNC_STATE_")));

test("AC24: bootstrap with every state variable present: no non-GET request to a state variable, and the operator is told how a reset works", async () => {
  const scenario = await createScenario();
  try {
    EXISTING(scenario, ["ALPHA_SERVICE", "GAMMA_LIB"]);
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(nonGetToState(scenario), []);
    assert.ok(run.stderr.includes("cascade-router.yml"));
    assert.ok(run.stderr.includes("reset_blocked: true"));
    assert.match(run.stderr, /Existing state variables were left unchanged: SDLC_SYNC_STATE_ALPHA_SERVICE, SDLC_SYNC_STATE_GAMMA_LIB\./);
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo").SDLC_SYNC_STATE_ALPHA_SERVICE, '{"existing":"ALPHA_SERVICE"}');
  } finally {
    await scenario.cleanup();
  }
});

test("AC24: onboard with the state variable of the edge present: the same", async () => {
  const scenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" }) } });
  try {
    EXISTING(scenario, ["NODE_APP"]);
    const run = await scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(nonGetToState(scenario), []);
    assert.ok(run.stderr.includes("cascade-router.yml") && run.stderr.includes("reset_blocked: true"));
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo").SDLC_SYNC_STATE_NODE_APP, '{"existing":"NODE_APP"}');
  } finally {
    await scenario.cleanup();
  }
});

test("AC24: no flag, prompt or environment variable resets a state variable, and no code path updates or deletes one", async () => {
  const text = (file) => fs.readFileSync(file, "utf8");
  const bin = listBin();
  assert.equal(bin.some((file) => /"DELETE"|'DELETE'/.test(text(file))), false, "no DELETE request anywhere in S5");
  const patching = bin.filter((file) => /"PATCH"|'PATCH'/.test(text(file))).map((file) => path.basename(file));
  assert.deepEqual(patching, ["actions-variables.mjs"], "PATCH is sent only by the variable writer");
  assert.equal(/PATCH[^\n]*SDLC_SYNC_STATE|SDLC_SYNC_STATE[^\n]*PATCH/.test(text(path.join(REPO_ROOT, "bin", "lib", "actions-variables.mjs")).replace(/\/\/.*$/gm, "")), false);
  for (const file of bin) assert.equal(/env\.\w*RESET\w*|env\[["']\w*RESET/i.test(text(file)), false, `${path.basename(file)} reads a reset switch from the environment`);
  const { ONBOARD_USAGE, BOOTSTRAP_USAGE } = await import("../../bin/lib/cli-flags.mjs");
  assert.equal(/reset|force|overwrite/i.test(ONBOARD_USAGE + BOOTSTRAP_USAGE), false, "no such flag is offered");
  for (const flag of ["--reset", "--reset-state", "--force", "--overwrite-state"]) {
    const scenario = await createScenario();
    try {
      const run = await scenario.bootstrap(["--non-interactive", flag], { env: scenario.env(scenario.appCredentials()) });
      assert.equal(run.code, 2, flag);
      assert.deepEqual(scenario.fake.log, []);
    } finally {
      await scenario.cleanup();
    }
  }
});

// --- AC41 ------------------------------------------------------------------------------------------------------------------

const ALLOWED_WRITES = [
  /^PATCH \/repos\/example-owner\/example-repo\/actions\/variables\/APP_CLIENT_ID$/,
  /^POST \/repos\/example-owner\/example-repo\/actions\/variables$/,
  /^PUT \/repos\/example-owner\/example-repo\/actions\/secrets\/[A-Z_]+$/,
  /^POST \/app-manifests\/[A-Za-z0-9_-]+\/conversions$/,
];
const DISABLE = /^PUT \/repos\/third-party\/[^/]+\/actions\/workflows\/[^/]+\/disable$/;

function assertWritesWithinOwnership(scenario, { optIn = false } = {}) {
  const writes = scenario.fake.nonGet().map((entry) => `${entry.method} ${entry.path}`);
  assert.ok(writes.length > 0);
  for (const write of writes) assert.ok(ALLOWED_WRITES.some((pattern) => pattern.test(write)) || (optIn && DISABLE.test(write)), `a write that S5 does not own: ${write}`);
  assert.ok(writes.filter((write) => /\/app-manifests\//.test(write)).length <= 1, "at most one conversion");
  assert.equal(scenario.fake.log.some((entry) => /^\/(orgs|organizations|enterprises|user|app\/installations\/\d+)/.test(entry.path) && entry.method !== "GET"), false, "no account, organization or installation setting is written");
  assert.equal(optIn === false && writes.some((write) => DISABLE.test(write)), false, "no workflow is disabled without the opt-in");
}

const OWNERSHIP_SCENARIOS = [
  {
    label: "bootstrap, existing App",
    run: (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: "github_pat_11OWNERSHIPFIXTURE0123456789abcdefghijklmnopqrstuvwxyz" }) }),
  },
  {
    label: "bootstrap, new App through the manifest flow",
    run: (scenario) => scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } }),
    conversion: 1,
  },
  {
    label: "bootstrap with the opt-in deconfliction",
    optIn: true,
    prepare: (scenario) =>
      scenario.workspace.editManifest((data) => {
        const project = data.projects.find((entry) => entry.projectKey === "gamma-lib");
        project.deconflictInRepoSchedules = "disable-workflow-schedules";
        project.deconflictWorkflowIds = ["weekly-content-audit.lock.yml"];
      }),
    run: (scenario) => scenario.bootstrap(["--non-interactive", "--deconflict-upstream-schedules"], { env: scenario.env(scenario.appCredentials()) }),
  },
  { label: "onboard, one project", repos: true, run: (scenario) => scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) }) },
  { label: "onboard, with a downstream", repos: true, run: (scenario) => scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], { env: scenario.env(scenario.appCredentials()) }) },
];

for (const { label, run, prepare, optIn = false, repos = false, conversion = 0 } of OWNERSHIP_SCENARIOS) {
  test(`AC41: ${label}: every GitHub-side write is a variable or secret write on the central repository, the one conversion, or an opt-in workflow disable`, async () => {
    const scenario = await createScenario({ fake: repos ? { repos: fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" }) } : {} });
    try {
      prepare?.(scenario);
      const result = await run(scenario);
      assert.equal(result.code, 0, result.stderr);
      if (label.startsWith("onboard")) assert.ok(scenario.fake.log.length > 0);
      if (scenario.fake.nonGet().length > 0) assertWritesWithinOwnership(scenario, { optIn });
      assert.equal(scenario.fake.requests("POST /app-manifests/:code/conversions").length, conversion);
      assert.equal(scenario.fake.state.disabledWorkflows.length > 0, optIn);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC41: the ownership check itself rejects a write outside the list", () => {
  const stray = { fake: { nonGet: () => [{ method: "PUT", path: "/repos/third-party/x/contents/file" }], log: [{ method: "PUT", path: "/repos/third-party/x/contents/file" }] } };
  assert.throws(() => assertWritesWithinOwnership(stray), /a write that S5 does not own: PUT \/repos\/third-party\/x\/contents\/file/);
});

test("AC41: variables and secrets are written on the central repository only, never on an upstream, a downstream or another account", async () => {
  const scenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" }) } });
  try {
    assert.equal((await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) })).code, 0);
    assert.equal((await scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], { env: scenario.env(scenario.appCredentials()) })).code, 0);
    for (const entry of scenario.fake.log.filter((request) => /\/actions\/(variables|secrets)/.test(request.path) && request.method !== "GET")) {
      assert.ok(entry.path.startsWith("/repos/example-owner/example-repo/"), entry.path);
    }
  } finally {
    await scenario.cleanup();
  }
});

test("AC41: the manifest flow is the only way an App is created: a manifest with the permission ceiling in it and one POST to the conversion", async () => {
  const scenario = await createScenario();
  try {
    let page;
    const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { onPage: (parsed) => (page = parsed) }), timing: { pollIntervalMs: 10 } });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(page.manifest.default_permissions, { contents: "write", pull_requests: "write", issues: "write", actions: "write", variables: "write", metadata: "read" });
    assert.equal(scenario.fake.requests("POST /app-manifests/:code/conversions").length, 1);
    assert.deepEqual(scenario.fake.log.filter((entry) => entry.method !== "GET").map((entry) => entry.method).filter((method, index, all) => all.indexOf(method) === index).sort(), ["PATCH", "POST", "PUT"]);
  } finally {
    await scenario.cleanup();
  }
});

function listBin() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, "bin"));
  return files.sort();
}
