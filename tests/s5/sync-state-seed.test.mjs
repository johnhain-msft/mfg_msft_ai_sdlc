// AC23: for every dependency edge S5 creates SDLC_SYNC_STATE_<SLUG> on the central repository only when GET answers 404,
// with the 14-field seed, leaves an existing variable untouched, aborts on any other answer and never falls back to PATCH.
import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../bin/lib/github-api.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { seedStateVariables, stateVariablePlan } from "../../bin/lib/state-variables.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";
import { CENTRAL, Capture, createScenario } from "./helpers/harness.mjs";

const VARIABLES = `/repos/${CENTRAL}/actions/variables`;
const ALPHA_SHA = "0123456789abcdef0123456789abcdef01234567";
const GAMMA_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const ALPHA = "SDLC_SYNC_STATE_ALPHA_SERVICE";
const GAMMA = "SDLC_SYNC_STATE_GAMMA_LIB";
const NOW = "2026-03-04T05:06:07.000Z";
const SEED_KEYS = [
  "etag",
  "lastObservedHeadSha",
  "lastMergedUpstreamSha",
  "portfolioMainSha",
  "lastNoopHeadSha",
  "dismissedTargetSha",
  "failedTargetSha",
  "failedAttempts",
  "blockedTargetSha",
  "inFlightRunId",
  "inFlightTargetSha",
  "openPrTargetSha",
  "openPrNumber",
  "updatedAt",
];
const edge = (upstreamSlug, initialBaselineSha, edgeId = upstreamSlug.toLowerCase().replace(/_/g, "-")) => ({ edgeId, upstreamSlug, initialBaselineSha });

async function withFake(callback, options = {}) {
  const fake = await startFakeGitHub(options);
  const logs = new Capture();
  try {
    return await callback({ fake, logs, api: createApi({ baseUrl: fake.url, token: "operator-token-fixture" }), logger: createLogger(logs) });
  } finally {
    await fake.close();
  }
}

const seedOf = (sha) => ({
  etag: "",
  lastObservedHeadSha: sha,
  lastMergedUpstreamSha: sha,
  portfolioMainSha: null,
  lastNoopHeadSha: null,
  dismissedTargetSha: null,
  failedTargetSha: null,
  failedAttempts: 0,
  blockedTargetSha: null,
  inFlightRunId: null,
  inFlightTargetSha: null,
  openPrTargetSha: null,
  openPrNumber: null,
  updatedAt: NOW,
});

test("AC23: the seed has exactly the 14 fields of the contract, in order, with the baseline in both SHA fields", () => {
  const seed = initialSyncState(ALPHA_SHA, NOW);
  assert.deepEqual(Object.keys(seed), SEED_KEYS);
  assert.deepEqual(seed, seedOf(ALPHA_SHA));
  assert.equal(seed.etag, "", "the empty etag makes the first poll omit If-None-Match");
  assert.equal(seed.failedAttempts, 0);
});

test("AC23: GET answers 404: exactly one POST whose JSON value is the seed of the edge's initialBaselineSha", async () => {
  await withFake(async ({ fake, api, logger }) => {
    const created = await seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA)]), nowIso: NOW, logger });
    assert.deepEqual(created, [ALPHA]);
    assert.deepEqual(fake.log.map((entry) => `${entry.method} ${entry.path}`), [`GET ${VARIABLES}/${ALPHA}`, `POST ${VARIABLES}`]);
    const post = fake.log[1];
    assert.deepEqual(Object.keys(post.body), ["name", "value"]);
    assert.equal(post.body.name, ALPHA);
    assert.equal(typeof post.body.value, "string");
    const value = JSON.parse(post.body.value);
    assert.deepEqual(value, seedOf(ALPHA_SHA));
    assert.deepEqual(Object.keys(value), SEED_KEYS);
    assert.equal(fake.variablesOf(CENTRAL)[ALPHA], post.body.value);
  });
});

test("AC23: updatedAt is an ISO-8601 UTC timestamp of the creation time", async () => {
  await withFake(async ({ fake, api, logger }) => {
    await seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA)]), nowIso: new Date().toISOString(), logger });
    const { updatedAt } = JSON.parse(fake.log[1].body.value);
    assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(updatedAt).toISOString(), updatedAt);
    assert.ok(Math.abs(Date.now() - Date.parse(updatedAt)) < 60_000);
  });
});

test("AC23: GET answers 200: zero writes and the existing value is untouched, with the operator guidance on stderr", async () => {
  await withFake(async ({ fake, api, logger, logs }) => {
    fake.setVariable(CENTRAL, ALPHA, "operator-edited-value");
    const created = await seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA)]), nowIso: NOW, logger });
    assert.deepEqual(created, []);
    assert.deepEqual(fake.log.map((entry) => entry.method), ["GET"]);
    assert.equal(fake.variablesOf(CENTRAL)[ALPHA], "operator-edited-value");
    assert.match(logs.text, /left unchanged/);
    assert.match(logs.text, /cascade-router\.yml/);
    assert.match(logs.text, /reset_blocked: true/);
  });
});

for (const status of [403, 500]) {
  test(`AC23: GET answers ${status}: abort with no write at all`, async () => {
    await withFake(async ({ fake, api, logger }) => {
      fake.override("GET", `${VARIABLES}/${ALPHA}`, { status, body: { message: "failure" } });
      await assert.rejects(seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA), edge("GAMMA_LIB", GAMMA_SHA)]), nowIso: NOW, logger }), (error) => {
        assert.match(error.message, new RegExp(`GET ${VARIABLES}/${ALPHA} answered ${status}`));
        assert.match(error.message, /'Variables' repository permission/);
        return true;
      });
      assert.deepEqual(fake.log.map((entry) => entry.method), ["GET"], "no POST, and the second edge was not reached");
      assert.deepEqual(fake.variablesOf(CENTRAL), {});
    });
  });
}

test("AC23: GET answers 404 and POST answers 409: the variable counts as existing, with a warning, and no PATCH, PUT or DELETE follows", async () => {
  await withFake(async ({ fake, api, logger, logs }) => {
    fake.override("POST", VARIABLES, { status: 409, body: { message: "Already exists" } });
    const created = await seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA)]), nowIso: NOW, logger });
    assert.deepEqual(created, [], "a variable that already existed is not reported as created");
    assert.deepEqual(fake.log.map((entry) => entry.method), ["GET", "POST"]);
    assert.deepEqual(fake.log.filter((entry) => ["PATCH", "PUT", "DELETE"].includes(entry.method)), []);
    assert.match(logs.text, /warning: SDLC_SYNC_STATE_ALPHA_SERVICE was created concurrently \(HTTP 409\)/);
  });
});

test("AC23: POST answers another failure: abort naming the 'Variables' permission", async () => {
  await withFake(async ({ fake, api, logger }) => {
    fake.override("POST", VARIABLES, { status: 403, body: { message: "Resource not accessible" } });
    await assert.rejects(seedStateVariables({ api, repo: CENTRAL, plan: stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA)]), nowIso: NOW, logger }), /POST .* answered 403[\s\S]*'Variables' repository permission/);
    assert.deepEqual(fake.log.map((entry) => entry.method), ["GET", "POST"]);
  });
});

test("AC23: an edge that cannot be seeded is refused before any request", async () => {
  const bad = [
    edge("alpha", ALPHA_SHA),
    edge("ALPHA-SERVICE", ALPHA_SHA),
    edge("A".repeat(65), ALPHA_SHA),
    edge("ALPHA_SERVICE", ALPHA_SHA.toUpperCase()),
    edge("ALPHA_SERVICE", ALPHA_SHA.slice(1)),
    edge("ALPHA_SERVICE", undefined),
    { edgeId: "x", initialBaselineSha: ALPHA_SHA },
  ];
  await withFake(async ({ fake }) => {
    for (const entry of bad) assert.throws(() => stateVariablePlan([entry]), /upstreamSlug|initialBaselineSha/, JSON.stringify(entry));
    assert.deepEqual(fake.log, []);
  });
});

test("AC23: the plan holds one variable per upstream slug, each with its own edge's baseline", () => {
  const plan = stateVariablePlan([edge("ALPHA_SERVICE", ALPHA_SHA), edge("GAMMA_LIB", GAMMA_SHA)]);
  assert.deepEqual([...plan], [[ALPHA, ALPHA_SHA], [GAMMA, GAMMA_SHA]]);
});

// --- through the entry point -----------------------------------------------------------------------------------------------

test("AC23: a bootstrap creates one state variable per dependency edge, seeded from that edge's baseline, with the injected creation time", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()), now: () => new Date(NOW) });
    assert.equal(run.code, 0, run.stderr);
    const variables = scenario.fake.variablesOf(CENTRAL);
    assert.deepEqual(JSON.parse(variables[ALPHA]), seedOf(ALPHA_SHA));
    assert.deepEqual(JSON.parse(variables[GAMMA]), seedOf(GAMMA_SHA));
    assert.deepEqual(scenario.fake.log.filter((entry) => entry.method === "PATCH" && entry.path.includes("SDLC_SYNC_STATE_")), []);
    assert.deepEqual(scenario.gh.calls("variable"), [], "gh variable set is not used for state variables");
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.variablesSet, ["APP_CLIENT_ID", ALPHA, GAMMA]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC23: with the variables present a bootstrap writes none of them, whatever the manifest's baseline says now", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.setVariable(CENTRAL, ALPHA, "existing-alpha");
    scenario.fake.setVariable(CENTRAL, GAMMA, "existing-gamma");
    scenario.workspace.editManifest((data) => {
      data.dependencyEdges[0].initialBaselineSha = "f".repeat(40);
    });
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(scenario.fake.variablesOf(CENTRAL)[ALPHA], "existing-alpha");
    assert.deepEqual(scenario.fake.variablesOf(CENTRAL)[GAMMA], "existing-gamma");
    assert.deepEqual(scenario.fake.requests("* /repos/:owner/:repo/actions/variables").filter((entry) => entry.body?.name?.startsWith("SDLC_SYNC_STATE_")), []);
    assert.deepEqual(JSON.parse(run.stdout).variablesSet, ["APP_CLIENT_ID"]);
  } finally {
    await scenario.cleanup();
  }
});

for (const status of [403, 500]) {
  test(`AC23: GET ${status} on a state variable in a whole run: non-zero exit, no state variable written, no secret, no S1 call, empty stdout`, async () => {
    const scenario = await createScenario();
    try {
      scenario.fake.override("GET", `${VARIABLES}/${ALPHA}`, { status, body: { message: "failure" } });
      const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
      assert.notEqual(run.code, 0);
      assert.equal(run.stdout, "");
      const writes = scenario.fake.log.filter((entry) => entry.method !== "GET");
      assert.deepEqual(writes.filter((entry) => entry.body?.name?.startsWith("SDLC_SYNC_STATE_") || entry.path.includes("SDLC_SYNC_STATE_")), []);
      assert.deepEqual(scenario.fake.requests("PUT /repos/:owner/:repo/actions/secrets/:name"), []);
      assert.equal(scenario.reconcile.calls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC23: POST 409 on a state variable in a whole run: no PATCH, PUT or DELETE to a state variable, a warning, exit 0", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.setVariable(CENTRAL, "APP_CLIENT_ID", "old-client-id");
    scenario.fake.override("POST", VARIABLES, { status: 409, body: { message: "Already exists" } });
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /warning: SDLC_SYNC_STATE_ALPHA_SERVICE was created concurrently/);
    assert.deepEqual(
      scenario.fake.log.filter((entry) => entry.path.includes("SDLC_SYNC_STATE_") && entry.method !== "GET"),
      [],
      "nothing but GET was sent to a state variable",
    );
    assert.deepEqual(JSON.parse(run.stdout).variablesSet, ["APP_CLIENT_ID"]);
  } finally {
    await scenario.cleanup();
  }
});
