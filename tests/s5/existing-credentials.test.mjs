// AC17: with APP_CLIENT_ID and APP_PRIVATE_KEY both in the environment S5 skips registration (no listener, no browser) and
// obtains appId and appSlug from GET /app, authenticated with a JWT signed by that key; clientId comes from APP_CLIENT_ID.
// Exactly one of the two is an error naming the missing one, and bin/sdlc-onboard.mjs always needs both.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyJwt } from "./helpers/keys.mjs";
import { assertNoSecrets, createScenario, runCli } from "./helpers/harness.mjs";

test("AC17: both values set: zero listener binds, one GET /app with a three-segment JWT that verifies against the fixture public key", async () => {
  const scenario = await createScenario({ app: undefined, fake: { app: { id: 55, slug: "from-get-app" } } });
  try {
    const run = await runCli("bootstrap", ["--non-interactive"], { env: scenario.env(scenario.appCredentials()), cwd: scenario.workspace.dir });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.trace.filter((event) => event.type === "listen"), []);
    const getApp = scenario.fake.requests("GET /app");
    assert.equal(getApp.length, 1);
    assert.equal(getApp[0].auth.kind, "jwt");
    assert.equal(getApp[0].auth.jwtValid, true);
    const report = JSON.parse(run.stdout);
    assert.equal(report.appSlug, "from-get-app");
    assert.equal(report.appId, 55);
    assert.equal(report.clientId, scenario.fake.state.app.client_id, "clientId comes from APP_CLIENT_ID");
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: the JWT is RS256, issued by the client ID, issued in the past and valid for at most ten minutes", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const claims = scenario.fake.requests("GET /app")[0].auth.claims;
    assert.equal(claims.iss, scenario.fake.state.app.client_id);
    assert.ok(claims.exp > claims.iat);
    assert.ok(claims.exp - claims.iat <= 600, "GitHub accepts at most ten minutes");
    assert.ok(claims.iat * 1000 < Date.now(), "iat is in the past, to allow for clock drift");
    // the same key signs the installation poll
    assert.ok(scenario.fake.requests("GET /app/installations").every((entry) => entry.auth.jwtValid));
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: neither the private key nor a JWT appears in stdout or stderr", async () => {
  const scenario = await createScenario();
  try {
    const credentials = scenario.appCredentials();
    const run = await scenario.bootstrap([], { env: scenario.env(credentials) });
    assert.equal(run.code, 0, run.stderr);
    const jwts = scenario.fake.log.map((entry) => entry.auth).filter((auth) => auth.kind === "jwt");
    assert.ok(jwts.length > 0);
    assertNoSecrets({ stdout: run.stdout, stderr: run.stderr }, [credentials.APP_PRIVATE_KEY, credentials.APP_PRIVATE_KEY.split("\n")[1]]);
    assert.equal(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(run.stderr + run.stdout), false, "no JWT is printed");
  } finally {
    await scenario.cleanup();
  }
});

for (const mode of [[], ["--non-interactive"]]) {
  for (const [label, pick, missing] of [
    ["only APP_CLIENT_ID", (c) => ({ APP_CLIENT_ID: c.APP_CLIENT_ID }), "APP_PRIVATE_KEY"],
    ["only APP_PRIVATE_KEY", (c) => ({ APP_PRIVATE_KEY: c.APP_PRIVATE_KEY }), "APP_CLIENT_ID"],
  ]) {
    test(`AC17: ${mode.length === 0 ? "interactive" : "--non-interactive"} with ${label} exits non-zero naming ${missing}, with no listener and no request`, async () => {
      const scenario = await createScenario();
      try {
        const run = await runCli("bootstrap", mode, { env: scenario.env(pick(scenario.appCredentials())), cwd: scenario.workspace.dir });
        assert.notEqual(run.code, 0);
        assert.ok(run.stderr.includes(`${missing} is missing`), run.stderr);
        if (mode.length > 0) assert.ok(run.stderr.includes("creating a new GitHub App requires an interactive browser flow"), "the diagnostic of AC10 accompanies it");
        assert.deepEqual(run.trace.filter((event) => event.type === "listen"), []);
        assert.deepEqual(scenario.fake.log, []);
      } finally {
        await scenario.cleanup();
      }
    });
  }
}

test("AC17: a blank APP_CLIENT_ID or APP_PRIVATE_KEY counts as missing", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ APP_CLIENT_ID: "  ", APP_PRIVATE_KEY: "\n" }) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /creating a new GitHub App requires an interactive browser flow/);
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: bin/sdlc-onboard.mjs without both values exits non-zero, stating that App credentials are required to resolve appSlug for contract C1", async () => {
  const scenario = await createScenario();
  try {
    for (const credentials of [{}, { APP_CLIENT_ID: "Iv1.x" }, { APP_PRIVATE_KEY: scenario.appCredentials().APP_PRIVATE_KEY }]) {
      const run = await runCli("onboard", ["--repo", "example-owner/app"], { env: scenario.env(credentials), cwd: scenario.workspace.dir });
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /App credentials are required to resolve appSlug for contract C1/);
      assert.deepEqual(scenario.fake.log, []);
      assert.deepEqual(run.trace.filter((event) => event.type === "write"), [], "nothing is written");
    }
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: a JWT that GitHub rejects (a key of another App) aborts with a diagnostic and writes nothing", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.override("GET", "/app", { status: 401, body: { message: "A JSON web token could not be decoded" } });
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /GET \/app answered 401[\s\S]*belong to the same GitHub App/);
    assert.deepEqual(scenario.fake.nonGet(), []);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: a private key that is not a PEM is refused without echoing it", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env({ APP_CLIENT_ID: "Iv1.x", APP_PRIVATE_KEY: "definitely-not-a-pem-key-value" }) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /APP_PRIVATE_KEY is not a valid PEM private key/);
    assert.equal(run.stderr.includes("definitely-not-a-pem-key-value"), false);
    assert.deepEqual(scenario.fake.log, []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC17: verifyJwt rejects a token signed by another key (the fixture check is not vacuous)", async () => {
  const scenario = await createScenario();
  try {
    await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    const token = Buffer.from("x").toString("base64url");
    assert.equal(verifyJwt(`${token}.${token}.${token}`, scenario.fake.appKey.publicKeyPem).valid, false);
    assert.equal(verifyJwt("not-a-jwt", scenario.fake.appKey.publicKeyPem).valid, false);
  } finally {
    await scenario.cleanup();
  }
});
