// AC25, AC26 and AC27: repository secrets are sealed locally with libsodium (crypto_box_seal) against the repository public key,
// sent as exactly { encrypted_value, key_id }, and the set of secrets follows the engine authentication mode. A failing route
// aborts with a diagnostic that names the route, the token kind and the 'Secrets' permission, and nothing further is sent.
import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../bin/lib/github-api.mjs";
import { APP_PRIVATE_KEY_SECRET, COPILOT_TOKEN_SECRET, engineSecretNames, uploadSecrets } from "../../bin/lib/actions-secrets.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";
import { fixtureAppKey, openSealedBox } from "./helpers/keys.mjs";
import { CENTRAL, createScenario, githubSideBrowser, runCli } from "./helpers/harness.mjs";

const PEM = fixtureAppKey().privateKeyPem;
const PUBLIC_KEY = `/repos/${CENTRAL}/actions/secrets/public-key`;
const PAT = "github_pat_11FIXTUREFIXTUREFIXTURE_0123456789abcdefghijklmnopqrstuvwxyz";
const SEAL_BYTES = 48; // crypto_box_SEALBYTES: an ephemeral public key (32) plus the MAC (16)

async function withFake(callback, options = {}, token = "operator-token-fixture") {
  const fake = await startFakeGitHub(options);
  try {
    return await callback({ fake, api: createApi({ baseUrl: fake.url, fetch: fake.fetch, token }) });
  } finally {
    await fake.close();
  }
}

const putsOf = (fake) => fake.requests("PUT /repos/:owner/:repo/actions/secrets/:name");
const nameOf = (entry) => decodeURIComponent(entry.path.split("/").pop());

// --- AC25 ------------------------------------------------------------------------------------------------------------------

test("AC25: GET public-key, Base64-decode 32 bytes, seal, Base64-encode, PUT exactly { encrypted_value, key_id }; the decrypted values equal the plaintext", async () => {
  await withFake(async ({ fake, api }) => {
    const secrets = [
      { name: APP_PRIVATE_KEY_SECRET, value: PEM },
      { name: COPILOT_TOKEN_SECRET, value: PAT },
    ];
    const stored = await uploadSecrets({ api, repo: CENTRAL, secrets });
    assert.deepEqual(stored, [APP_PRIVATE_KEY_SECRET, COPILOT_TOKEN_SECRET]);
    assert.equal(fake.requests(`GET ${PUBLIC_KEY}`).length, 2, "one public-key read for each secret");
    const puts = putsOf(fake);
    assert.deepEqual(puts.map(nameOf), [APP_PRIVATE_KEY_SECRET, COPILOT_TOKEN_SECRET]);
    for (const put of puts) {
      assert.deepEqual(Object.keys(put.body).sort(), ["encrypted_value", "key_id"]);
      assert.equal(put.body.key_id, fake.secretKey.keyId);
      assert.match(put.body.encrypted_value, /^[A-Za-z0-9+/]+={0,2}$/, "Base64");
    }
    assert.equal(await openSealedBox(puts[0].body.encrypted_value, fake.secretKey), PEM);
    assert.equal(await openSealedBox(puts[1].body.encrypted_value, fake.secretKey), PAT);
    assert.equal(Buffer.from(puts[1].body.encrypted_value, "base64").length, Buffer.byteLength(PAT) + SEAL_BYTES, "a sealed box (crypto_box_seal), not a plain box");
    assert.equal(JSON.stringify(fake.log).includes(PAT), false, "the plaintext occurs in no recorded request");
    assert.equal(JSON.stringify(fake.log).includes("-----BEGIN"), false);
    assert.deepEqual(Object.keys(fake.secretsOf(CENTRAL)).sort(), [APP_PRIVATE_KEY_SECRET, COPILOT_TOKEN_SECRET]);
  });
});

test("AC25: a sealed box is randomised: the same value sealed twice gives two different ciphertexts that both decrypt", async () => {
  await withFake(async ({ fake, api }) => {
    await uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "FIRST_COPY", value: PAT }, { name: "SECOND_COPY", value: PAT }] });
    const [first, second] = putsOf(fake);
    assert.notEqual(first.body.encrypted_value, second.body.encrypted_value);
    assert.equal(await openSealedBox(first.body.encrypted_value, fake.secretKey), PAT);
    assert.equal(await openSealedBox(second.body.encrypted_value, fake.secretKey), PAT);
  });
});

test("AC25: every value is encrypted before the first PUT, so the public-key reads precede every write", async () => {
  await withFake(async ({ fake, api }) => {
    await uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }, { name: "TWO_SECRET", value: "a-secret-value-2" }, { name: "THREE_SECRET", value: "a-secret-value-3" }] });
    const firstPut = fake.log.findIndex((entry) => entry.method === "PUT");
    assert.equal(firstPut, 3);
    assert.ok(fake.log.slice(0, firstPut).every((entry) => entry.method === "GET" && entry.path === PUBLIC_KEY));
  });
});

for (const [label, key] of [
  ["31 bytes", Buffer.alloc(31, 7).toString("base64")],
  ["33 bytes", Buffer.alloc(33, 7).toString("base64")],
  ["an empty key", ""],
  ["text that is not Base64", "this is not base64!!"],
]) {
  test(`AC25: a public key of ${label} aborts before any PUT`, async () => {
    await withFake(async ({ fake, api }) => {
      fake.override("GET", PUBLIC_KEY, { status: 200, body: { key_id: "kid", key } });
      await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }] }), /public key of example-owner\/example-repo (is not 32 bytes|has no key_id or key)/);
      assert.deepEqual(putsOf(fake), []);
    });
  });
}

test("AC25: a public key without a key_id aborts before any PUT", async () => {
  await withFake(async ({ fake, api }) => {
    fake.override("GET", PUBLIC_KEY, { status: 200, body: { key: Buffer.alloc(32, 7).toString("base64") } });
    await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }] }), /has no key_id or key/);
    assert.deepEqual(putsOf(fake), []);
  });
});

test("AC25: when the public key read for the second secret is bad, the first secret has not been written either", async () => {
  await withFake(async ({ fake, api }) => {
    fake.override("GET", PUBLIC_KEY, { status: 200, body: { key_id: fake.secretKey.keyId, key: fake.secretKey.publicKeyBase64 } }, 1);
    fake.override("GET", PUBLIC_KEY, { status: 200, body: { key_id: "kid", key: Buffer.alloc(31).toString("base64") } });
    await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }, { name: "TWO_SECRET", value: "a-secret-value-2" }] }), /not 32 bytes/);
    assert.deepEqual(putsOf(fake), []);
    assert.deepEqual(fake.secretsOf(CENTRAL), {});
  });
});

test("AC25: a secret name that is not a valid Actions name, and an empty value, are refused before any request", async () => {
  await withFake(async ({ fake, api }) => {
    for (const name of ["1STARTS_WITH_DIGIT", "has-hyphen", "GITHUB_TOKEN_X", "with space", ""]) {
      await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name, value: "a-secret-value-1" }] }), /not a valid Actions secret name/, name);
    }
    await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "EMPTY_ONE", value: "" }] }), /is empty/);
    assert.deepEqual(fake.log, []);
  });
});

// --- AC26 ------------------------------------------------------------------------------------------------------------------

const SECRET_ROUTES = [
  ["the public-key route", "GET", PUBLIC_KEY],
  ["the secret route", "PUT", `/repos/${CENTRAL}/actions/secrets/ONE_SECRET`],
];
for (const [routeLabel, method, route] of SECRET_ROUTES) {
  for (const status of [403, 404]) {
    for (const [tokenLabel, token, kind] of [
      ["a fine-grained personal access token", PAT, "fine-grained personal access token"],
      ["a classic personal access token", "ghp_ClassicTokenFixture0123456789abcdef", "classic personal access token"],
      ["an OAuth token", "gho_OAuthTokenFixture0123456789abcdef", "OAuth token"],
    ]) {
      test(`AC26: ${status} from ${routeLabel} with ${tokenLabel}: the diagnostic names the route, the token kind and 'Secrets', never the token, and no request follows`, async () => {
        await withFake(
          async ({ fake, api }) => {
            fake.override(method, route, { status, body: { message: "Resource not accessible" } });
            await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }] }), (error) => {
              assert.ok(error.message.includes(`${method} ${route} answered ${status}`), error.message);
              assert.ok(error.message.includes(kind), error.message);
              assert.match(error.message, /'Secrets' repository permission/);
              assert.equal(error.message.includes(token), false, "the token is never printed");
              assert.match(error.message, /No further request was made/);
              return true;
            });
            const last = fake.log.at(-1);
            assert.equal(`${last.method} ${last.path}`, `${method} ${route}`, "the failing request is the last one");
            assert.equal(last.status, status);
          },
          {},
          token,
        );
      });
    }
  }
}

test("AC26: a failing PUT of the first secret stops the upload: the second secret is not sent", async () => {
  await withFake(async ({ fake, api }) => {
    fake.override("PUT", `/repos/${CENTRAL}/actions/secrets/ONE_SECRET`, { status: 403, body: { message: "Resource not accessible" } });
    await assert.rejects(uploadSecrets({ api, repo: CENTRAL, secrets: [{ name: "ONE_SECRET", value: "a-secret-value-1" }, { name: "TWO_SECRET", value: "a-secret-value-2" }] }), /answered 403/);
    assert.equal(putsOf(fake).length, 1);
  });
});

test("AC26: in a whole run a 403 on the public key route exits non-zero with the route, the token kind and 'Secrets', no PUT, no S1 call and an empty stdout", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.override("GET", PUBLIC_KEY, { status: 403, body: { message: "Resource not accessible by personal access token" } });
    const run = await scenario.bootstrap([], { env: scenario.env({ ...scenario.appCredentials(), GH_TOKEN: PAT }) });
    assert.notEqual(run.code, 0);
    assert.ok(run.stderr.includes(`GET ${PUBLIC_KEY} answered 403`), run.stderr);
    assert.ok(run.stderr.includes("fine-grained personal access token"));
    assert.match(run.stderr, /'Secrets' repository permission/);
    assert.equal(run.stderr.includes(PAT), false);
    assert.equal(run.stdout, "");
    assert.deepEqual(putsOf(scenario.fake), []);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

// --- AC27 ------------------------------------------------------------------------------------------------------------------

test("AC27: the API-key secret names per engine are the ones of gh-aw's authentication reference", () => {
  assert.deepEqual(engineSecretNames("copilot"), []);
  assert.deepEqual(engineSecretNames("claude"), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(engineSecretNames("codex"), ["OPENAI_API_KEY", "CODEX_API_KEY"]);
  assert.deepEqual(engineSecretNames("gemini"), ["GEMINI_API_KEY"]);
  assert.ok(engineSecretNames("pi").length > 0);
  assert.deepEqual(engineSecretNames("not-an-engine"), []);
});

async function uploadedSecrets(scenario) {
  const decrypted = {};
  for (const [name, entry] of Object.entries(scenario.fake.secretsOf(CENTRAL))) decrypted[name] = await openSealedBox(entry.encrypted_value, scenario.fake.secretKey);
  return decrypted;
}

const MATRIX = [
  { label: "copilot without a token: only APP_PRIVATE_KEY (copilot-requests)", argv: [], env: {}, mode: "copilot-requests", names: ["APP_PRIVATE_KEY"] },
  { label: "copilot with COPILOT_GITHUB_TOKEN: plus COPILOT_GITHUB_TOKEN (copilot-pat)", argv: ["--engine", "copilot"], env: { COPILOT_GITHUB_TOKEN: PAT }, mode: "copilot-pat", names: ["APP_PRIVATE_KEY", "COPILOT_GITHUB_TOKEN"] },
  { label: "claude: plus ANTHROPIC_API_KEY (api-key)", argv: ["--engine", "claude"], env: { ANTHROPIC_API_KEY: "sk-ant-fixture-0123456789" }, mode: "api-key", names: ["ANTHROPIC_API_KEY", "APP_PRIVATE_KEY"] },
  { label: "codex: plus OPENAI_API_KEY (api-key)", argv: ["--engine", "codex"], env: { OPENAI_API_KEY: "sk-openai-fixture-0123456789" }, mode: "api-key", names: ["APP_PRIVATE_KEY", "OPENAI_API_KEY"] },
  { label: "codex with CODEX_API_KEY: plus CODEX_API_KEY (api-key)", argv: ["--engine", "codex"], env: { CODEX_API_KEY: "sk-codex-fixture-0123456789" }, mode: "api-key", names: ["APP_PRIVATE_KEY", "CODEX_API_KEY"] },
  { label: "gemini: plus GEMINI_API_KEY (api-key)", argv: ["--engine", "gemini"], env: { GEMINI_API_KEY: "gemini-fixture-0123456789" }, mode: "api-key", names: ["APP_PRIVATE_KEY", "GEMINI_API_KEY"] },
  { label: "pi: plus the API key that is set (api-key)", argv: ["--engine", "pi"], env: { OPENAI_API_KEY: "sk-openai-fixture-0123456789" }, mode: "api-key", names: ["APP_PRIVATE_KEY", "OPENAI_API_KEY"] },
];

for (const { label, argv, env, mode, names } of MATRIX) {
  test(`AC27: ${label}`, async () => {
    const scenario = await createScenario();
    try {
      const run = await scenario.bootstrap(["--non-interactive", ...argv], { env: scenario.env({ ...scenario.appCredentials(), ...env }) });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(Object.keys(scenario.fake.secretsOf(CENTRAL)).sort(), names);
      assert.deepEqual(JSON.parse(run.stdout).secretsSet, names);
      assert.equal(scenario.reconcile.calls.length, 1);
      assert.equal(scenario.reconcile.calls[0].request.engineAuthMode, mode);
      const decrypted = await uploadedSecrets(scenario);
      assert.equal(decrypted.APP_PRIVATE_KEY, PEM, "the decrypted APP_PRIVATE_KEY equals the fixture PEM byte for byte");
      for (const [name, value] of Object.entries(env)) assert.equal(decrypted[name], value);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC27: APP_PRIVATE_KEY holds the entire PEM, including its BEGIN and END RSA PRIVATE KEY lines, exactly as returned by the conversion", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } });
    assert.equal(run.code, 0, run.stderr);
    const decrypted = await uploadedSecrets(scenario);
    assert.equal(decrypted.APP_PRIVATE_KEY, scenario.fake.state.conversionPem);
    assert.ok(decrypted.APP_PRIVATE_KEY.startsWith("-----BEGIN RSA PRIVATE KEY-----\n"));
    assert.ok(decrypted.APP_PRIVATE_KEY.trimEnd().endsWith("-----END RSA PRIVATE KEY-----"));
  } finally {
    await scenario.cleanup();
  }
});

test("AC27: an interactive run asks for COPILOT_GITHUB_TOKEN at a prompt that does not echo and uploads the answer", async () => {
  const scenario = await createScenario({ prompts: { COPILOT_GITHUB_TOKEN: PAT } });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(scenario.prompts.questions.length >= 1);
    assert.deepEqual(scenario.prompts.questions.map((question) => question.name), ["COPILOT_GITHUB_TOKEN"]);
    for (const question of scenario.prompts.questions) assert.strictEqual(question.echo, false, "no-echo input");
    assert.equal((await uploadedSecrets(scenario)).COPILOT_GITHUB_TOKEN, PAT);
    assert.equal(scenario.reconcile.calls[0].request.engineAuthMode, "copilot-pat");
    assert.equal(run.stderr.includes(PAT), false);
  } finally {
    await scenario.cleanup();
  }
});

test("AC27: an empty answer at the prompt selects copilot-requests and uploads no engine secret", async () => {
  const scenario = await createScenario({ prompts: { COPILOT_GITHUB_TOKEN: "   " } });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(Object.keys(scenario.fake.secretsOf(CENTRAL)), ["APP_PRIVATE_KEY"]);
    assert.equal(scenario.reconcile.calls[0].request.engineAuthMode, "copilot-requests");
  } finally {
    await scenario.cleanup();
  }
});

test("AC27: an interactive run for the claude engine asks for ANTHROPIC_API_KEY without echo", async () => {
  const scenario = await createScenario({ prompts: { ANTHROPIC_API_KEY: "sk-ant-prompted-0123456789" } });
  try {
    const run = await scenario.bootstrap(["--engine", "claude"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(scenario.prompts.questions.map((question) => [question.name, question.echo]), [["ANTHROPIC_API_KEY", false]]);
    assert.equal((await uploadedSecrets(scenario)).ANTHROPIC_API_KEY, "sk-ant-prompted-0123456789");
  } finally {
    await scenario.cleanup();
  }
});

test("AC27: a non-copilot engine without its API key exits non-zero naming the variable, before any request, and never prompts under --non-interactive", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive", "--engine", "claude"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /the claude engine needs an API key: set ANTHROPIC_API_KEY in the environment/);
    assert.deepEqual(scenario.fake.log, []);
    assert.deepEqual(scenario.prompts.questions, []);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

for (const flag of ["--copilot-github-token", "--copilot-token", "--app-private-key", "--private-key", "--api-key", "--token", "--secret"]) {
  test(`AC27: no flag accepts a secret value: ${flag} is rejected as an unknown option, before any request`, async () => {
    const scenario = await createScenario();
    try {
      const run = await runCli("bootstrap", ["--non-interactive", flag, "a-secret-value-12345"], { env: scenario.env(scenario.appCredentials()), cwd: scenario.workspace.dir });
      assert.equal(run.code, 2, run.stderr);
      assert.equal(run.stderr.includes("a-secret-value-12345"), false, "the value is not echoed");
      assert.deepEqual(scenario.fake.log, []);
      assert.equal(run.stdout, "");
    } finally {
      await scenario.cleanup();
    }
  });
}
