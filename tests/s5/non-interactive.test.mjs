// AC10: bin/sdlc-bootstrap.mjs run with --non-interactive never starts a loopback listener or opens a browser, and without
// both App credentials it exits non-zero with `creating a new GitHub App requires an interactive browser flow`,
// having attempted no GitHub-side write.
import assert from "node:assert/strict";
import test from "node:test";
import { createScenario, runCli } from "./helpers/harness.mjs";

const MESSAGE = "creating a new GitHub App requires an interactive browser flow";

const CASES = [
  ["neither APP_CLIENT_ID nor APP_PRIVATE_KEY", () => ({}), null],
  ["only APP_CLIENT_ID", (credentials) => ({ APP_CLIENT_ID: credentials.APP_CLIENT_ID }), "APP_PRIVATE_KEY"],
  ["only APP_PRIVATE_KEY", (credentials) => ({ APP_PRIVATE_KEY: credentials.APP_PRIVATE_KEY }), "APP_CLIENT_ID"],
];

for (const [label, pick, missing] of CASES) {
  test(`AC10: --non-interactive with ${label} exits non-zero with the diagnostic, no listener, no browser and no non-GET request`, async () => {
    const scenario = await createScenario();
    try {
      const env = scenario.env(pick(scenario.appCredentials()));
      const run = await runCli("bootstrap", ["--non-interactive"], { env, cwd: scenario.workspace.dir });
      assert.notEqual(run.code, 0);
      assert.ok(run.stderr.includes(MESSAGE), run.stderr);
      if (missing) assert.ok(run.stderr.includes(`${missing} is missing`), "the missing value is named");
      assert.equal(run.stdout, "");
      assert.deepEqual(run.trace.filter((event) => event.type === "listen"), [], "zero listener binds");
      assert.deepEqual(scenario.fake.nonGet(), [], "zero non-GET requests");
      assert.deepEqual(scenario.fake.log, [], "no request at all");
      assert.equal(scenario.browser.urls.length, 0, "zero browser-opener calls");
      // the same run in process, with the browser stub injected
      const inProcess = await scenario.bootstrap(["--non-interactive"], { env });
      assert.notEqual(inProcess.code, 0);
      assert.ok(inProcess.stderr.includes(MESSAGE));
      assert.equal(scenario.browser.urls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC10: --non-interactive with both credentials registers nothing: no listener, no browser, no conversion", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.browser.urls.length, 0);
    assert.equal(scenario.fake.requests("POST /app-manifests/:code/conversions").length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC10: --non-interactive never prompts, even when the engine credential is missing: it fails naming the variable", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive", "--engine", "claude"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /the claude engine needs an API key: set ANTHROPIC_API_KEY/);
    assert.equal(scenario.prompts.questions.length, 0, "no prompt in --non-interactive mode");
    assert.deepEqual(scenario.fake.log, [], "the credential is checked before any request");
  } finally {
    await scenario.cleanup();
  }
});
