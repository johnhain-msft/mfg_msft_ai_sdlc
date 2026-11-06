// AC29: no secret value (the PEM, the client_secret and webhook_secret of the conversion, an engine credential, a JSON Web Token,
// the operator's token) appears in stdout, stderr, an error message, a file that the process writes, sdlc.yaml, aw.yml or a
// request body; and a failure after the registration says that the App exists and that its private key was not stored.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixtureAppKey } from "./helpers/keys.mjs";
import { CENTRAL, createScenario, errorResult, githubSideBrowser, readFixture, recordFsWrites, REPO_ROOT } from "./helpers/harness.mjs";

const PEM = fixtureAppKey().privateKeyPem;
const PEM_LINES = PEM.split("\n").filter((line) => line.length >= 30 && !line.startsWith("-----")).slice(0, 4);
const CLIENT_SECRET = "fixture-client-secret-0123456789";
const WEBHOOK_SECRET = "fixture-webhook-secret-0123456789";
const ENGINE_TOKEN = "github_pat_11HYGIENEENGINEFIXTURE0123456789abcdefghijklmnopqrstuvwxyz";
const OPERATOR_TOKEN = "github_pat_11HYGIENEOPERATORFIXTURE0123456789abcdefghijklmnopqrstuvwxyz";
const OAUTH_VALUE = "gho_HygieneFixtureOAuthValue0123456789";
const SECRETS = [PEM, PEM.trim(), ...PEM_LINES, CLIENT_SECRET, WEBHOOK_SECRET, ENGINE_TOKEN, OPERATOR_TOKEN, OAUTH_VALUE];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const SECRETS_ROUTE = "PUT /repos/:owner/:repo/actions/secrets/:name";

/** Runs the bootstrap in process and gathers everything that it emitted or sent. */
async function collect(scenario, argv, extra) {
  const { result, writes } = await recordFsWrites(() => scenario.bootstrap(argv, extra));
  return {
    ...result,
    files: writes.map((write) => `${write.path}\n${write.data}`).join("\n"),
    requests: JSON.stringify(scenario.fake.log.map(({ path, query, body }) => ({ path, query, body }))),
    writes,
  };
}

function assertClean(collected, label) {
  const texts = { stdout: collected.stdout, stderr: collected.stderr, "file writes": collected.files, "request bodies": collected.requests };
  for (const [name, text] of Object.entries(texts)) {
    assert.equal(text.includes("-----BEGIN"), false, `${label}: the text -----BEGIN appears in ${name}`);
    assert.equal(JWT.test(text), false, `${label}: a JSON Web Token appears in ${name}`);
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label}: a fixture secret (${JSON.stringify(secret.slice(0, 14))}...) appears in ${name}`);
  }
}

const NEW_APP = (scenario, options) => ({ openBrowser: githubSideBrowser(scenario, options), timing: { pollIntervalMs: 10, pollTimeoutMs: 100 }, env: scenario.env({ COPILOT_GITHUB_TOKEN: ENGINE_TOKEN, GH_TOKEN: OPERATOR_TOKEN }) });
const EXISTING = (scenario, extraEnv = {}) => ({ env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: ENGINE_TOKEN, GH_TOKEN: OPERATOR_TOKEN, ...extraEnv }) });

const SCENARIOS = [
  {
    label: "a success on the new-App path",
    exit: 0,
    run: (scenario) => collect(scenario, [], NEW_APP(scenario)),
  },
  {
    label: "a success on the existing-App path",
    exit: 0,
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario)),
  },
  {
    label: "a conversion that answers 422",
    options: { fake: { conversion: { status: 422, message: "Validation Failed" } } },
    run: (scenario) => collect(scenario, [], NEW_APP(scenario)),
  },
  {
    label: "an installation timeout after the registration",
    notStored: true,
    options: { fake: { installations: [] } },
    run: (scenario) => collect(scenario, [], NEW_APP(scenario, { install: false })),
  },
  {
    label: "a secret PUT that answers 403 after the registration",
    notStored: true,
    setup: (scenario) => scenario.fake.override("PUT", `/repos/${CENTRAL}/actions/secrets/APP_PRIVATE_KEY`, { status: 403, body: { message: "Resource not accessible" } }),
    run: (scenario) => collect(scenario, [], NEW_APP(scenario)),
  },
  {
    label: "a secret PUT that answers 403 on the existing-App path",
    setup: (scenario) => scenario.fake.override("PUT", `/repos/${CENTRAL}/actions/secrets/:name`, { status: 403, body: { message: "Resource not accessible" } }),
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario)),
  },
  {
    label: "a public-key route that answers 404",
    setup: (scenario) => scenario.fake.override("GET", `/repos/${CENTRAL}/actions/secrets/public-key`, { status: 404, body: { message: "Not Found" } }),
    run: (scenario) => collect(scenario, [], NEW_APP(scenario)),
    notStored: true,
  },
  {
    label: "a gho_ value",
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario, { COPILOT_GITHUB_TOKEN: OAUTH_VALUE })),
  },
  {
    label: "a variable write that answers 403 after the registration",
    notStored: true,
    setup: (scenario) => scenario.fake.override("PATCH", `/repos/${CENTRAL}/actions/variables/APP_CLIENT_ID`, { status: 403, body: { message: "Resource not accessible" } }),
    run: (scenario) => collect(scenario, [], NEW_APP(scenario)),
  },
  {
    label: "a GET /app that answers 401 on the existing-App path",
    setup: (scenario) => scenario.fake.override("GET", "/app", { status: 401, body: { message: "A JSON web token could not be decoded" } }),
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario)),
  },
  {
    label: "a rejection by S1 on the existing-App path",
    options: { reconcile: () => errorResult(["fixture S1 error: network configuration is missing"]) },
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario)),
  },
  {
    label: "a failed readiness check",
    options: { gh: { doctorExit: 1 } },
    exit: 1,
    printsReport: true,
    run: (scenario) => collect(scenario, ["--non-interactive"], EXISTING(scenario)),
  },
];

for (const { label, options, setup, run, exit, notStored, printsReport } of SCENARIOS) {
  test(`AC29: ${label}: no secret value and no PEM header in stdout, stderr, file writes or request bodies`, async () => {
    const scenario = await createScenario(options);
    try {
      setup?.(scenario);
      const collected = await run(scenario);
      if (exit !== undefined) assert.equal(collected.code, exit, collected.stderr);
      else assert.notEqual(collected.code, 0, "the scenario is a failure");
      assertClean(collected, label);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"), "sdlc.yaml is untouched");
      if (exit !== 0 && !printsReport) assert.equal(collected.stdout, "", "an aborted run prints nothing on stdout");
      if (notStored) {
        assert.match(collected.stderr, /The GitHub App 'fixture-app' exists, but its private key was not stored/);
        assert.match(collected.stderr, /generate a new private key/);
      }
      if (exit === 0 || printsReport) assert.equal(JSON.parse(collected.stdout).appSlug, "fixture-app");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC29: client_secret and webhook_secret of the conversion are discarded: they reach neither the report, nor a request, nor a log line", async () => {
  const scenario = await createScenario();
  try {
    const collected = await collect(scenario, [], NEW_APP(scenario));
    assert.equal(collected.code, 0, collected.stderr);
    assert.deepEqual(Object.keys(JSON.parse(collected.stdout)), [
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
    ]);
    for (const text of [collected.stdout, collected.stderr, collected.requests, collected.files]) {
      assert.equal(text.includes(CLIENT_SECRET) || text.includes(WEBHOOK_SECRET), false);
    }
  } finally {
    await scenario.cleanup();
  }
});

test("AC29: the PEM is uploaded only as the encrypted APP_PRIVATE_KEY and only after every secret is encrypted", async () => {
  const scenario = await createScenario();
  try {
    const collected = await collect(scenario, [], NEW_APP(scenario));
    assert.equal(collected.code, 0, collected.stderr);
    const puts = scenario.fake.requests(SECRETS_ROUTE);
    assert.deepEqual(puts.map((entry) => entry.path.split("/").pop()), ["APP_PRIVATE_KEY", "COPILOT_GITHUB_TOKEN"]);
    for (const put of puts) assert.deepEqual(Object.keys(put.body).sort(), ["encrypted_value", "key_id"]);
    assert.equal(collected.writes.length, 0, "the bootstrap writes no file at all, so the key never touches the disk");
  } finally {
    await scenario.cleanup();
  }
});

test("AC29: the committed aw.yml holds no credential", () => {
  const manifest = fs.readFileSync(path.join(REPO_ROOT, "aw.yml"), "utf8");
  assert.equal(manifest.includes("-----BEGIN"), false);
  assert.equal(/gho_|github_pat_|ghp_|ghs_|client_secret|webhook_secret/.test(manifest), false);
});
