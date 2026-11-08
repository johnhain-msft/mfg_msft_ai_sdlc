// AC21 and AC22: the APP_CLIENT_ID upsert (PATCH first, POST only on 404, the client_id and not the numeric id) and the
// variable writer's allowlist, naming rules and size limit. No GH_AW_POLICY_ variable is ever named, at any scope.
import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../bin/lib/github-api.mjs";
import {
  APP_CLIENT_ID_VARIABLE,
  MAX_VARIABLE_BYTES,
  POLL_STATE_VAR_PREFIX,
  assertWritableVariable,
  stateVariableName,
  upsertAppClientId,
  writeVariable,
} from "../../bin/lib/actions-variables.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";
import { CENTRAL, createScenario } from "./helpers/harness.mjs";

const VARIABLES = `/repos/${CENTRAL}/actions/variables`;

async function withFake(callback, options = {}) {
  const fake = await startFakeGitHub(options);
  try {
    const api = createApi({ baseUrl: fake.url, fetch: fake.fetch, token: "operator-token-fixture" });
    return await callback({ fake, api, context: { api, repo: CENTRAL } });
  } finally {
    await fake.close();
  }
}

const methods = (fake) => fake.log.map((entry) => entry.method);

// --- AC21 ------------------------------------------------------------------------------------------------------------------

test("AC21: PATCH answers 2xx: the variable is updated and no POST is sent", async () => {
  await withFake(async ({ fake, context }) => {
    fake.setVariable(CENTRAL, APP_CLIENT_ID_VARIABLE, "Iv1.old");
    const outcome = await upsertAppClientId(context, "Iv1.fixtureclientid");
    assert.deepEqual(outcome, { name: "APP_CLIENT_ID", outcome: "updated" });
    assert.deepEqual(methods(fake), ["PATCH"]);
    assert.equal(fake.log[0].path, `${VARIABLES}/APP_CLIENT_ID`);
    assert.deepEqual(fake.log[0].body, { name: "APP_CLIENT_ID", value: "Iv1.fixtureclientid" });
    assert.equal(fake.variablesOf(CENTRAL).APP_CLIENT_ID, "Iv1.fixtureclientid");
  });
});

test("AC21: PATCH answers 404: the variable is created with POST to the collection", async () => {
  await withFake(async ({ fake, context }) => {
    const outcome = await upsertAppClientId(context, "Iv1.fixtureclientid");
    assert.deepEqual(outcome, { name: "APP_CLIENT_ID", outcome: "created" });
    assert.deepEqual(methods(fake), ["PATCH", "POST"]);
    assert.equal(fake.log[1].path, VARIABLES);
    assert.deepEqual(fake.log[1].body, { name: "APP_CLIENT_ID", value: "Iv1.fixtureclientid" });
    assert.equal(fake.variablesOf(CENTRAL).APP_CLIENT_ID, "Iv1.fixtureclientid");
  });
});

for (const status of [401, 403, 422, 500]) {
  test(`AC21: PATCH answers ${status}: abort naming the 'Variables' repository permission, with no POST`, async () => {
    await withFake(async ({ fake, context }) => {
      fake.override("PATCH", `${VARIABLES}/APP_CLIENT_ID`, { status, body: { message: "Resource not accessible" } });
      await assert.rejects(upsertAppClientId(context, "Iv1.fixtureclientid"), (error) => {
        assert.match(error.message, new RegExp(`PATCH ${VARIABLES}/APP_CLIENT_ID answered ${status}`));
        assert.match(error.message, /'Variables' repository permission/);
        assert.doesNotMatch(error.message, /operator-token-fixture/, "the token is never printed");
        return true;
      });
      assert.deepEqual(methods(fake), ["PATCH"]);
    });
  });
}

for (const status of [403, 422]) {
  test(`AC21: PATCH answers 404 and POST answers ${status}: abort naming the 'Variables' repository permission`, async () => {
    await withFake(async ({ fake, context }) => {
      fake.override("POST", VARIABLES, { status, body: { message: "Resource not accessible" } });
      await assert.rejects(upsertAppClientId(context, "Iv1.fixtureclientid"), /POST .* answered \d+[\s\S]*'Variables' repository permission/);
      assert.deepEqual(methods(fake), ["PATCH", "POST"]);
      assert.deepEqual(fake.variablesOf(CENTRAL), {});
    });
  });
}

test("AC21: the written value is the App's client_id, not its numeric id", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const writes = scenario.fake.requests("PATCH /repos/:owner/:repo/actions/variables/APP_CLIENT_ID", "POST /repos/:owner/:repo/actions/variables").filter((entry) => entry.body?.name === "APP_CLIENT_ID");
    assert.ok(writes.length >= 1);
    for (const entry of writes) {
      assert.equal(entry.body.value, scenario.fake.state.app.client_id);
      assert.notEqual(entry.body.value, String(scenario.fake.state.app.id));
    }
    assert.equal(scenario.fake.variablesOf(CENTRAL).APP_CLIENT_ID, "Iv1.fixtureclientid");
    assert.notEqual(scenario.fake.variablesOf(CENTRAL).APP_CLIENT_ID, "424242");
  } finally {
    await scenario.cleanup();
  }
});

test("AC21: a 403 on the variables route in a whole run names the 'Variables' permission and stops before any secret and before S1", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.override("PATCH", `${VARIABLES}/APP_CLIENT_ID`, { status: 403, body: { message: "Resource not accessible by personal access token" } });
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /'Variables' repository permission/);
    assert.equal(run.stdout, "", "an aborted run prints nothing on stdout");
    assert.deepEqual(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables", "PUT /repos/:owner/:repo/actions/secrets/:name"), []);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

// --- AC22 ------------------------------------------------------------------------------------------------------------------

test("AC22: GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST is refused before any request", async () => {
  await withFake(async ({ fake, context }) => {
    await assert.rejects(writeVariable("GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST", "false", context), /GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST="false"[\s\S]*refuse to start|refusing to write the variable 'GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST'/);
    assert.deepEqual(fake.log, []);
  });
});

for (const [label, name, value] of [
  ["a GITHUB_ name", "GITHUB_X", "1"],
  ["a lower-case GITHUB_ name", "github_token", "1"],
  ["a name with a leading digit", "1SDLC", "1"],
  ["an unlisted name", "SOMETHING_ELSE", "1"],
  ["a different GH_AW_ name", "GH_AW_POLICY_ANYTHING", "true"],
  ["the bare prefix without a slug", "SDLC_SYNC_STATE_", "{}"],
  ["a slug with a lower-case letter", "SDLC_SYNC_STATE_lower", "{}"],
  ["a slug with a hyphen", "SDLC_SYNC_STATE_A-B", "{}"],
  ["a slug of 65 characters", `SDLC_SYNC_STATE_${"A".repeat(65)}`, "{}"],
  ["a 49 KB value for a state variable", "SDLC_SYNC_STATE_BIG", "x".repeat(49 * 1024)],
  ["a 49 KB value for APP_CLIENT_ID", "APP_CLIENT_ID", "x".repeat(49 * 1024)],
  ["a value that is not a string", "APP_CLIENT_ID", 12345],
]) {
  test(`AC22: ${label} is refused before any request`, async () => {
    await withFake(async ({ fake, context }) => {
      await assert.rejects(writeVariable(name, value, context), (error) => error.name === "SdlcError" || /refus|naming rules|48 KB/.test(error.message));
      assert.deepEqual(fake.log, [], "no request was made");
    });
  });
}

test("AC22: the size limit is 48 KB: 48 KB is accepted and one byte more is not; a multi-byte value counts in bytes", () => {
  assert.equal(MAX_VARIABLE_BYTES, 48 * 1024);
  assert.doesNotThrow(() => assertWritableVariable("SDLC_SYNC_STATE_X", "a".repeat(MAX_VARIABLE_BYTES)));
  assert.throws(() => assertWritableVariable("SDLC_SYNC_STATE_X", "a".repeat(MAX_VARIABLE_BYTES + 1)), /48 KB/);
  assert.throws(() => assertWritableVariable("SDLC_SYNC_STATE_X", "é".repeat(MAX_VARIABLE_BYTES / 2 + 1)), /48 KB/, "two bytes per character");
});

test("AC22: SDLC_SYNC_STATE_GH_ADMIN_MSFT is accepted, and a slug of exactly 64 characters is accepted", async () => {
  await withFake(async ({ fake, context }) => {
    assert.deepEqual(await writeVariable("SDLC_SYNC_STATE_GH_ADMIN_MSFT", "{}", context), { name: "SDLC_SYNC_STATE_GH_ADMIN_MSFT", outcome: "created" });
    assert.deepEqual(await writeVariable(`SDLC_SYNC_STATE_${"A".repeat(64)}`, "{}", context), { name: `SDLC_SYNC_STATE_${"A".repeat(64)}`, outcome: "created" });
    assert.deepEqual(methods(fake), ["GET", "POST", "GET", "POST"]);
    assert.equal(stateVariableName("GH_ADMIN_MSFT"), "SDLC_SYNC_STATE_GH_ADMIN_MSFT");
    assert.equal(POLL_STATE_VAR_PREFIX, "SDLC_SYNC_STATE_");
  });
});

test("AC22: the writer dispatches by name: APP_CLIENT_ID is upserted (PATCH first) and a state variable is created only after a GET answers 404", async () => {
  await withFake(async ({ fake, context }) => {
    await writeVariable("APP_CLIENT_ID", "Iv1.x", context);
    await writeVariable("SDLC_SYNC_STATE_ALPHA", "{}", context);
    assert.deepEqual(
      fake.log.map((entry) => `${entry.method} ${entry.path}`),
      [`PATCH ${VARIABLES}/APP_CLIENT_ID`, `POST ${VARIABLES}`, `GET ${VARIABLES}/SDLC_SYNC_STATE_ALPHA`, `POST ${VARIABLES}`],
    );
  });
});

test("AC22: a full bootstrap with deconfliction never names a GH_AW_POLICY_ variable, at any scope, in a request, a body or a gh call", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.editManifest((data) => {
      const gamma = data.projects.find((project) => project.projectKey === "gamma-lib");
      gamma.deconflictInRepoSchedules = "disable-workflow-schedules";
      gamma.deconflictWorkflowIds = ["weekly-content-audit.lock.yml", "self-improving-agents.lock.yml"];
    });
    const run = await scenario.bootstrap(["--deconflict-upstream-schedules"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.fake.state.disabledWorkflows.length, 2, "the deconfliction ran");
    assert.equal(/GH_AW_POLICY_/.test(JSON.stringify(scenario.fake.log) + JSON.stringify(scenario.gh.log())), false);
    assert.equal(/GH_AW_POLICY_/.test(run.stdout + run.stderr), false);
    for (const entry of scenario.fake.log) {
      assert.equal(/\/(orgs|organizations|enterprises|environments)\//.test(entry.path), false, `no variable at organization, enterprise or environment scope: ${entry.path}`);
    }
    for (const entry of scenario.fake.log.filter((request) => request.path.includes("/actions/variables"))) {
      assert.ok(entry.path.startsWith(`/repos/${CENTRAL}/`), `variables are written on the central repository only: ${entry.path}`);
    }
  } finally {
    await scenario.cleanup();
  }
});

test("AC22: variables are addressed by name; no run lists a variables collection, so no per_page value is relied on", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(scenario.fake.requests("GET /repos/:owner/:repo/actions/variables"), []);
    assert.deepEqual(scenario.fake.requests("GET /repos/:owner/:repo/actions/secrets"), []);
    for (const entry of scenario.fake.log.filter((request) => /\/actions\/(variables|secrets)/.test(request.path))) {
      assert.doesNotMatch(entry.query, /per_page/);
    }
  } finally {
    await scenario.cleanup();
  }
});
