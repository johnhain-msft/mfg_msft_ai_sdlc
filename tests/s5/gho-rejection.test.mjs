// AC28: a secret value that contains `gho_` (the prefix of the OAuth token that `gh auth login` issues) is rejected before the
// first PUT, whichever way it arrived (environment or prompt), with a diagnostic that names the secret and never echoes the value.
// The operator's own REST token is not a secret value of this kind and may be an OAuth token.
import assert from "node:assert/strict";
import test from "node:test";
import { OAUTH_PREFIX, assertNotOAuthToken, assertSecretsValid } from "../../bin/lib/actions-secrets.mjs";
import { CENTRAL, createScenario, githubSideBrowser, runCli } from "./helpers/harness.mjs";

const PUT_SECRET = "PUT /repos/:owner/:repo/actions/secrets/:name";

test("AC28: the prefix is gho_ and a value is rejected when it contains the prefix anywhere", () => {
  assert.equal(OAUTH_PREFIX, "gho_");
  for (const value of ["gho_fixture", "github_pat_abcgho_def", "xgho_", "prefix-gho_-suffix"]) {
    assert.throws(
      () => assertNotOAuthToken("COPILOT_GITHUB_TOKEN", value),
      (error) => {
        assert.match(error.message, /COPILOT_GITHUB_TOKEN/);
        assert.match(error.message, /must not be used as a workflow credential/);
        assert.equal(error.message.includes(value), false, "the value is not echoed");
        return true;
      },
      value,
    );
  }
});

test("AC28: other token prefixes and look-alikes are not rejected", () => {
  for (const value of ["github_pat_11AAAA", "ghp_classic", "ghs_installation", "GHO_UPPER", "gho-dash", "gh_o_", "g-h-o"]) {
    assert.doesNotThrow(() => assertNotOAuthToken("COPILOT_GITHUB_TOKEN", value), value);
  }
});

test("AC28: every value of the set is checked, so one bad value rejects the whole set", () => {
  assert.throws(() => assertSecretsValid([{ name: "APP_PRIVATE_KEY", value: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n" }, { name: "COPILOT_GITHUB_TOKEN", value: "gho_fixture" }]), /COPILOT_GITHUB_TOKEN/);
});

for (const [label, value] of [
  ["gho_fixture", "gho_fixture"],
  ["a value with gho_ in the middle", "github_pat_abcgho_defghijklmnop"],
]) {
  test(`AC28: COPILOT_GITHUB_TOKEN=${label} with a valid APP_PRIVATE_KEY exits non-zero, names the secret, does not contain the value and sends no PUT`, async () => {
    const scenario = await createScenario();
    try {
      const run = await runCli("bootstrap", ["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: value }), cwd: scenario.workspace.dir });
      assert.notEqual(run.code, 0);
      assert.ok(run.stderr.includes("COPILOT_GITHUB_TOKEN"), run.stderr);
      assert.equal(run.stderr.includes(value), false, "stderr does not contain the value");
      assert.equal(run.stdout.includes(value), false);
      assert.equal(run.stdout, "", "an aborted run prints nothing on stdout");
      assert.deepEqual(scenario.fake.requests(PUT_SECRET), [], "zero PUT requests");
      assert.deepEqual(scenario.fake.secretsOf(CENTRAL), {}, "a rejected value leaves no secret written by that run, the App key included");
      assert.deepEqual(scenario.fake.nonGet(), [], "nothing at all was written");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC28: the check also covers an engine API key from the environment", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive", "--engine", "claude"], { env: scenario.env({ ...scenario.appCredentials(), ANTHROPIC_API_KEY: "sk-ant-gho_fixture-0123456789" }) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /ANTHROPIC_API_KEY/);
    assert.equal(run.stderr.includes("sk-ant-gho_fixture-0123456789"), false);
    assert.deepEqual(scenario.fake.requests(PUT_SECRET), []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC28: the check also covers APP_PRIVATE_KEY from the environment", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ APP_CLIENT_ID: "Iv1.fixtureclientid", APP_PRIVATE_KEY: "gho_notapemvalue0123456789" }) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /APP_PRIVATE_KEY/);
    assert.equal(run.stderr.includes("gho_notapemvalue0123456789"), false);
    assert.deepEqual(scenario.fake.log, []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC28: the check also covers a value typed at the prompt", async () => {
  const scenario = await createScenario({ prompts: { COPILOT_GITHUB_TOKEN: "gho_prompted0123456789" } });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.deepEqual(scenario.prompts.questions.map((question) => question.name), ["COPILOT_GITHUB_TOKEN"]);
    assert.match(run.stderr, /COPILOT_GITHUB_TOKEN/);
    assert.equal(run.stderr.includes("gho_prompted0123456789"), false);
    assert.deepEqual(scenario.fake.requests(PUT_SECRET), []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC28: on the new-App path the value is rejected before anything is registered: no listener, no browser page, no conversion", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env({ COPILOT_GITHUB_TOKEN: "gho_fixture0123456789" }), openBrowser: githubSideBrowser(scenario) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /COPILOT_GITHUB_TOKEN/);
    assert.deepEqual(scenario.browser.urls, []);
    assert.deepEqual(scenario.fake.log, []);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC28: the diagnostic states what to use instead and that nothing was written", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: "gho_fixture0123456789" }) });
    assert.match(run.stderr, /OAuth token that gh auth login issues/);
    assert.match(run.stderr, /must not be used as a workflow credential/);
    assert.match(run.stderr, /fine-grained personal access token/);
    assert.match(run.stderr, /Nothing was written/);
  } finally {
    await scenario.cleanup();
  }
});

test("AC28: the operator's own REST token may be an OAuth token (gh auth login); it is used for the calls and never uploaded or printed", async () => {
  const scenario = await createScenario();
  try {
    const operatorToken = "gho_OperatorOwnTokenFixture0123456789";
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), GH_TOKEN: operatorToken }) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(Object.keys(scenario.fake.secretsOf(CENTRAL)), ["APP_PRIVATE_KEY"]);
    assert.ok(scenario.fake.requests(PUT_SECRET).length >= 1);
    assert.equal((run.stdout + run.stderr).includes(operatorToken), false);
    assert.equal(JSON.stringify(scenario.fake.log).includes(operatorToken), false);
  } finally {
    await scenario.cleanup();
  }
});
