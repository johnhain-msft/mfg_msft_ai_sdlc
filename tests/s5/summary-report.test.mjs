// AC43 and AC44: every run that reaches the readiness checks prints exactly one BootstrapSummaryReport on stdout (eleven keys, in
// order, arrays sorted, names and never values), validated against schemas/bootstrap-summary-report.schema.json; progress goes to
// stderr, and a run that aborts earlier prints nothing on stdout. Each field means what AC44 says it means.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { buildSummaryReport, summaryProblems } from "../../bin/lib/summary.mjs";
import { REPO_ROOT, createScenario, errorResult, fixtureRepos, githubSideBrowser, installationOn } from "./helpers/harness.mjs";

const KEYS = [
  "appId",
  "appSlug",
  "clientId",
  "installationsVerified",
  "onboardedProjects",
  "deconflictedTargetWorkflows",
  "skippedReadOnlyUpstreams",
  "variablesSet",
  "secretsSet",
  "compiledWorkflows",
  "doctorStatus",
];
const ARRAY_KEYS = KEYS.filter((key) => !["appId", "appSlug", "clientId", "doctorStatus"].includes(key));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "bootstrap-summary-report.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(SCHEMA);
const REPOS = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const WEEKLY = "weekly-content-audit.lock.yml";
const SELF_IMPROVING = "self-improving-agents.lock.yml";

const sample = () => ({
  appId: 1,
  appSlug: "a-slug",
  clientId: "Iv1.abc",
  installationsVerified: ["example-owner"],
  onboardedProjects: [],
  deconflictedTargetWorkflows: [],
  skippedReadOnlyUpstreams: [],
  variablesSet: ["APP_CLIENT_ID"],
  secretsSet: ["APP_PRIVATE_KEY"],
  compiledWorkflows: [".github/workflows/x.lock.yml"],
  doctorStatus: "pass",
});

function assertReport(stdout) {
  const report = JSON.parse(stdout);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.deepEqual(Object.keys(report), KEYS, "the eleven keys, in the order of the contract");
  for (const key of ARRAY_KEYS) assert.deepEqual(report[key], [...report[key]].sort(), `${key} is sorted lexicographically`);
  assert.equal(stdout, `${JSON.stringify(report, null, 2)}\n`, "exactly one JSON document and nothing else");
  return report;
}

/** The names that the fake recorded as variables written and secrets written, for comparison with the report. */
function writtenNames(scenario) {
  const variables = new Set();
  for (const entry of scenario.fake.log) {
    if (entry.method === "POST" && /\/actions\/variables$/.test(entry.path) && entry.status < 300) variables.add(entry.body.name);
    if (entry.method === "PATCH" && /\/actions\/variables\//.test(entry.path) && entry.status < 300) variables.add(entry.path.split("/").pop());
  }
  const secrets = scenario.fake.log.filter((entry) => entry.method === "PUT" && /\/actions\/secrets\//.test(entry.path) && entry.status < 300).map((entry) => entry.path.split("/").pop());
  return { variables: [...variables].sort(), secrets: secrets.sort() };
}

// --- AC43: the schema ------------------------------------------------------------------------------------------------------

test("AC43: the schema is draft-07, closed, requires all eleven keys and declares them in the order of the contract", () => {
  assert.equal(SCHEMA.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(SCHEMA.additionalProperties, false);
  assert.deepEqual(SCHEMA.required, KEYS);
  assert.deepEqual(Object.keys(SCHEMA.properties), KEYS);
  assert.equal(validate(sample()), true);
});

for (const key of KEYS) {
  test(`AC43: a report without ${key} does not validate`, () => {
    const report = sample();
    delete report[key];
    assert.equal(validate(report), false);
  });
}

test("AC43: a report with a twelfth key, a wrong type or a value outside the enumerations does not validate", () => {
  const variants = [
    { ...sample(), extra: 1 },
    { ...sample(), appId: "1" },
    { ...sample(), appSlug: "" },
    { ...sample(), clientId: 5 },
    { ...sample(), doctorStatus: "ok" },
    { ...sample(), variablesSet: [1] },
    { ...sample(), secretsSet: "APP_PRIVATE_KEY" },
    { ...sample(), onboardedProjects: ["Upper-Case"] },
    { ...sample(), deconflictedTargetWorkflows: ["not-a-target"] },
    { ...sample(), skippedReadOnlyUpstreams: ["owner/repo:workflow"] },
    { ...sample(), variablesSet: ["has space"] },
  ];
  for (const variant of variants) assert.equal(validate(variant), false, JSON.stringify(variant));
});

test("AC43: buildSummaryReport orders the keys, sorts and de-duplicates every array, and refuses a report that would not validate", () => {
  const report = buildSummaryReport({
    ...sample(),
    installationsVerified: ["b-owner", "a-owner", "b-owner"],
    variablesSet: ["SDLC_SYNC_STATE_B", "APP_CLIENT_ID", "SDLC_SYNC_STATE_A"],
    secretsSet: ["COPILOT_GITHUB_TOKEN", "APP_PRIVATE_KEY"],
    compiledWorkflows: ["z.lock.yml", "a.lock.yml"],
  });
  assert.deepEqual(Object.keys(report), KEYS);
  assert.deepEqual(report.installationsVerified, ["a-owner", "b-owner"]);
  assert.deepEqual(report.variablesSet, ["APP_CLIENT_ID", "SDLC_SYNC_STATE_A", "SDLC_SYNC_STATE_B"]);
  assert.deepEqual(report.secretsSet, ["APP_PRIVATE_KEY", "COPILOT_GITHUB_TOKEN"]);
  assert.deepEqual(report.compiledWorkflows, ["a.lock.yml", "z.lock.yml"]);
  assert.throws(() => buildSummaryReport({ ...sample(), doctorStatus: "maybe" }), /does not validate/);
  assert.deepEqual(summaryProblems(sample()), []);
  assert.ok(summaryProblems({ ...sample(), extra: 1 }).length > 0);
});

// --- AC43: the runs --------------------------------------------------------------------------------------------------------

test("AC43: a success run prints exactly one validating document on stdout and its progress on stderr", async () => {
  const scenario = await createScenario();
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.equal(report.doctorStatus, "pass");
    assert.ok(result.stderr.length > 0, "human-readable progress goes to stderr");
    assert.equal(/^\s*[{[]/m.test(result.stderr), false, "stderr carries no JSON document");
  } finally {
    await scenario.cleanup();
  }
});

test("AC43: a readiness-failure run prints the same kind of document with doctorStatus fail and exits non-zero", async () => {
  const scenario = await createScenario({ gh: { doctorExit: 1 } });
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 1);
    assert.equal(assertReport(result.stdout).doctorStatus, "fail");
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, run] of [
  ["a missing credential (AC10)", (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env({}) })],
  ["a rejection by S1", (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()), reconcile: async () => errorResult(["x"]) })],
  ["an invalid flag", (scenario) => scenario.bootstrap(["--no-such-flag"], { env: scenario.env(scenario.appCredentials()) })],
  [
    "a gh-aw that is too old",
    (scenario) => {
      scenario.gh.set({ version: "1.0.0" });
      return scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    },
  ],
]) {
  test(`AC43: a run that aborts earlier (${label}) leaves stdout empty and puts its diagnostics on stderr`, async () => {
    const scenario = await createScenario();
    try {
      const result = await run(scenario);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.length > 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

// --- AC44: the meaning of each field ---------------------------------------------------------------------------------------

test("AC44: bootstrap on the existing-App path: appId and appSlug from GET /app, clientId from APP_CLIENT_ID, and every list from the recorded activity", async () => {
  const scenario = await createScenario({ fake: { app: { id: 777, slug: "existing-app-slug" } } });
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), APP_CLIENT_ID: "Iv1.fromenvironment" }) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    const written = writtenNames(scenario);
    assert.equal(report.appId, 777);
    assert.equal(report.appSlug, "existing-app-slug");
    assert.equal(report.clientId, "Iv1.fromenvironment");
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo").APP_CLIENT_ID, "Iv1.fromenvironment", "the same value was written to the variable");
    assert.deepEqual(report.installationsVerified, ["example-owner"]);
    assert.deepEqual(report.onboardedProjects, [], "bootstrap never edits sdlc.yaml");
    assert.deepEqual(report.deconflictedTargetWorkflows, []);
    assert.deepEqual(report.skippedReadOnlyUpstreams, []);
    assert.deepEqual(report.variablesSet, written.variables);
    assert.deepEqual(report.variablesSet, ["APP_CLIENT_ID", "SDLC_SYNC_STATE_ALPHA_SERVICE", "SDLC_SYNC_STATE_GAMMA_LIB"]);
    assert.deepEqual(report.secretsSet, written.secrets);
    assert.deepEqual(report.secretsSet, ["APP_PRIVATE_KEY"]);
    assert.deepEqual(report.compiledWorkflows, [".github/workflows/sdlc-onboard.lock.yml"]);
    assert.equal(report.doctorStatus, "pass");
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: bootstrap on the new-App path: appId, appSlug and clientId from the conversion response", async () => {
  const scenario = await createScenario({ fake: { app: { id: 31337, slug: "converted-app", client_id: "Iv1.converted" } } });
  try {
    const result = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 }, env: scenario.env({ COPILOT_GITHUB_TOKEN: "github_pat_11SUMMARYFIXTURE0123456789abcdefghijklmnopqrstuvwxyz" }) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.deepEqual([report.appId, report.appSlug, report.clientId], [31337, "converted-app", "Iv1.converted"]);
    assert.deepEqual(report.secretsSet, ["APP_PRIVATE_KEY", "COPILOT_GITHUB_TOKEN"]);
    assert.deepEqual(report.secretsSet, writtenNames(scenario).secrets);
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo").APP_CLIENT_ID, "Iv1.converted");
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: installationsVerified lists the account as GitHub spells it, one entry per verified installation", async () => {
  const scenario = await createScenario({ fake: { installations: [installationOn("Example-Owner")] } });
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(assertReport(result.stdout).installationsVerified, ["Example-Owner"]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: bootstrap with deconfliction and a read-only upstream: deconflictedTargetWorkflows and skippedReadOnlyUpstreams", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.editManifest((data) => {
      const project = (key, repo, ids) => ({ ...structuredClone(data.projects[1]), projectKey: key, repo, deconflictInRepoSchedules: "disable-workflow-schedules", deconflictWorkflowIds: ids });
      data.projects.push(project("up-writable", "third-party/up-writable", [WEEKLY, SELF_IMPROVING]), project("up-read-only", "third-party/up-read-only", [WEEKLY]));
    });
    scenario.fake.override("PUT", "/repos/third-party/up-read-only/actions/workflows/:id/disable", { status: 403, body: { message: "Must have admin rights to Repository." } });
    const result = await scenario.bootstrap(["--non-interactive", "--deconflict-upstream-schedules"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.deepEqual(report.deconflictedTargetWorkflows, [`third-party/up-writable:${SELF_IMPROVING}`, `third-party/up-writable:${WEEKLY}`]);
    assert.deepEqual(report.skippedReadOnlyUpstreams, ["third-party/up-read-only"]);
    assert.deepEqual(report.deconflictedTargetWorkflows, scenario.fake.state.disabledWorkflows.sort());
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: onboarding of one project: onboardedProjects holds its projectKey; installationsVerified, secretsSet and the deconfliction lists are empty", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    const result = await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.deepEqual(report.onboardedProjects, ["node-app"]);
    assert.deepEqual(report.installationsVerified, []);
    assert.deepEqual(report.secretsSet, []);
    assert.deepEqual(report.variablesSet, [], "no edge, so no variable");
    assert.deepEqual(report.deconflictedTargetWorkflows, []);
    assert.deepEqual(report.skippedReadOnlyUpstreams, []);
    assert.equal(report.appSlug, "fixture-app");
    assert.equal(report.clientId, scenario.fake.state.app.client_id);
    assert.deepEqual(writtenNames(scenario), { variables: [], secrets: [] });
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: onboarding with a downstream: variablesSet holds the state variable that the run created", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    const result = await scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.deepEqual(report.onboardedProjects, ["edge-ok", "node-app"], "the added upstream project and the downstream project, sorted");
    assert.deepEqual(report.variablesSet, ["SDLC_SYNC_STATE_NODE_APP"]);
    assert.deepEqual(report.variablesSet, writtenNames(scenario).variables);
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: existing state variables are not reported as set", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.setVariable("example-owner/example-repo", "SDLC_SYNC_STATE_ALPHA_SERVICE", "{}");
    scenario.fake.setVariable("example-owner/example-repo", "SDLC_SYNC_STATE_GAMMA_LIB", "{}");
    scenario.fake.setVariable("example-owner/example-repo", "APP_CLIENT_ID", "Iv1.old");
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    assert.deepEqual(report.variablesSet, ["APP_CLIENT_ID"], "APP_CLIENT_ID was updated; the state variables were left alone");
    assert.deepEqual(report.variablesSet, writtenNames(scenario).variables);
  } finally {
    await scenario.cleanup();
  }
});

test("AC44: variablesSet and secretsSet hold names only, never values", async () => {
  const scenario = await createScenario();
  try {
    const result = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: "github_pat_11NAMESONLYFIXTURE0123456789abcdefghijklmnopqrstuvwxyz" }) });
    assert.equal(result.code, 0, result.stderr);
    const report = assertReport(result.stdout);
    for (const name of [...report.variablesSet, ...report.secretsSet]) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(result.stdout.includes("github_pat_"), false);
    assert.equal([...report.variablesSet, ...report.secretsSet].some((name) => name.includes("Iv1.")), false, "the client ID value is not an entry of variablesSet");
    assert.equal(result.stdout.includes("-----BEGIN"), false);
  } finally {
    await scenario.cleanup();
  }
});
