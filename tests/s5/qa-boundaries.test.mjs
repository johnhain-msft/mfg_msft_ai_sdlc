// Independent S5 QA boundary checks. Assertions are about requests, persisted state and file bytes, not progress text.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createGhRunner } from "../../bin/lib/gh-runner.mjs";
import { compareVersions, parseVersion } from "../../bin/lib/ghaw-version.mjs";
import { createApi, resolveApiBase, resolveOperatorToken, tokenKind } from "../../bin/lib/github-api.mjs";
import { uploadSecrets } from "../../bin/lib/actions-secrets.mjs";
import { signAppJwt } from "../../bin/lib/app-jwt.mjs";
import { evaluateInstallations } from "../../bin/lib/installations.mjs";
import { inspectRepository, localReader } from "../../bin/lib/inspect-repo.mjs";
import { composeInstructions, generatedSection, operatorTextOf, readOperatorInstructions } from "../../bin/lib/instructions-file.mjs";
import { createScenario, createWorkspace, FIXTURE_PERMISSIONS, installationOn, recordFsWrites, sha256Tree } from "./helpers/harness.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";
import { fixtureAppKey } from "./helpers/keys.mjs";

const invariant = (condition, message) => assert.equal(condition, true, message);
const CENTRAL = "example-owner/example-repo";
const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });

test("QA AC7: prerelease identifier precedence is symmetric, numeric and lexicographic", () => {
  const pairs = [
    ["1.0.1-alpha", "1.0.1-alpha.1"],
    ["1.0.1-alpha.1", "1.0.1-alpha.beta"],
    ["1.0.1-alpha.beta", "1.0.1-beta"],
    ["1.0.1-beta", "1.0.1-beta.2"],
    ["1.0.1-beta.2", "1.0.1-beta.11"],
    ["1.0.1-beta.11", "1.0.1-rc.1"],
    ["1.0.1-rc.1", "1.0.1"],
    ["1.9.99", "1.10.0"],
  ];
  for (const [left, right] of pairs) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    invariant(compareVersions(a, b) === -1 && compareVersions(b, a) === 1, `${left} < ${right}, in both directions`);
  }
  assert.equal(compareVersions(parseVersion("v1.0.1+one"), parseVersion("1.0.1+two")), 0);
});

test("QA AC6: a nonexistent GH_AW_BIN fails closed without consulting GitHub or the fallback gh", async () => {
  const workspace = createWorkspace();
  try {
    const runGh = createGhRunner({ env: { GH_AW_BIN: workspace.path("missing-gh-aw.exe"), PATH: "", Path: "" } });
    const result = await runGh(["aw", "version"]);
    invariant(result.code === null && /ENOENT|not found/i.test(result.error ?? ""), "a missing explicit executable is a failed invocation");
    assert.equal(result.stdout, "");
  } finally {
    workspace.cleanup();
  }
});

test("QA AC6: Windows cmd metacharacters are refused before a PATH shim can run", { skip: process.platform !== "win32" }, async () => {
  const scenario = await createScenario();
  try {
    const runGh = createGhRunner({ env: scenario.env() });
    const result = await runGh(["aw", "version", "unsafe&argument"]);
    invariant(result.code === null && scenario.gh.log().length === 0, "the unsafe command never reached the shim");
    assert.match(result.error, /not safe to pass through the command shell/);
    assert.deepEqual(scenario.fake.log, []);
  } finally {
    await scenario.cleanup();
  }
});

test("QA AC17/AC26: operator credential precedence and the empty fallback do not make unintended calls", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "  fallback-fixture-token  \n", stderr: "" };
  };
  assert.equal(await resolveOperatorToken({ env: { GH_TOKEN: " first ", GITHUB_TOKEN: "second" }, runGh }), "first");
  assert.equal(await resolveOperatorToken({ env: { GH_TOKEN: " ", GITHUB_TOKEN: " second " }, runGh }), "second");
  invariant(calls.length === 0, "environment credentials never cause gh auth token to run");
  assert.equal(await resolveOperatorToken({ env: {}, runGh }), "fallback-fixture-token");
  assert.deepEqual(calls, [["auth", "token"]]);
  const empty = await resolveOperatorToken({ env: {}, runGh: async () => ({ code: 1, stdout: "not-a-token", stderr: "not authenticated" }) });
  assert.equal(empty, "");
});

test("QA AC26: API base URLs accept HTTPS and loopback HTTP but reject other transports", () => {
  const accepted = [
    [{}, "https://api.github.com"],
    [{ GITHUB_API_URL: " https://ghe.example/api/v3/ " }, "https://ghe.example/api/v3"],
    [{ GITHUB_API_URL: "http://127.0.0.1:8123/" }, "http://127.0.0.1:8123"],
    [{ GITHUB_API_URL: "http://localhost:8123/" }, "http://localhost:8123"],
    [{ GITHUB_API_URL: "http://[::1]:8123/" }, "http://[::1]:8123"],
  ];
  invariant(accepted.every(([env, expected]) => resolveApiBase(env) === expected), "allowed API origins are preserved without a trailing slash");
  for (const value of ["not-a-url", "http://api.github.com", "file:///tmp/api", "ftp://example.com"]) {
    assert.throws(() => resolveApiBase({ GITHUB_API_URL: value }), (error) => error.code === "api-url");
  }
});

test("QA AC19: same-origin relative pagination follows the last page with the same App bearer", async () => {
  const calls = [];
  const api = createApi({
    baseUrl: "https://api.example.invalid",
    token: "operator-fixture",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(calls.length === 1 ? [{ id: 1 }] : [{ id: 2 }]), {
        status: 200,
        headers: calls.length === 1 ? { link: '</app/installations?page=2>; rel="next"' } : {},
      });
    },
  });
  const result = await api.paginate("/app/installations", { bearer: "app-jwt-fixture" });
  invariant(result.ok && JSON.stringify(result.items) === '[{"id":1},{"id":2}]', "both pages, including the last, contribute items");
  assert.deepEqual(calls.map((call) => call.url), ["https://api.example.invalid/app/installations", "https://api.example.invalid/app/installations?page=2"]);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "Bearer app-jwt-fixture");
    assert.equal(call.options.headers.Accept, "application/vnd.github+json");
  }
});

test("QA AC19/AC29: foreign-origin pagination is rejected before credentials can be sent there", async () => {
  const calls = [];
  const api = createApi({
    baseUrl: "https://api.example.invalid",
    token: "operator-fixture",
    fetch: async (url) => {
      calls.push(url);
      return new Response("[]", { status: 200, headers: { link: '<https://other.example.invalid/app/installations>; rel="next"' } });
    },
  });
  await assert.rejects(api.paginate("/app/installations", { bearer: "app-jwt-fixture" }), (error) => error.code === "network");
  invariant(calls.length === 1 && calls[0] === "https://api.example.invalid/app/installations", "there was no request to the foreign origin");
});

test("QA AC19: a 200 repository-installation response with the wrong installation ID is not coverage", async () => {
  const fake = await startFakeGitHub({ installations: [installationOn("example-owner", { id: 100, repository_selection: "selected", _repositories: [CENTRAL] })] });
  try {
    fake.override("GET", `/repos/${CENTRAL}/installation`, { status: 200, body: { id: 101 } });
    const result = await evaluateInstallations({
      api: createApi({ baseUrl: fake.url, fetch: fake.fetch }),
      jwt: signAppJwt({ privateKeyPem: fixtureAppKey().privateKeyPem, issuer: "Iv1.fixture" }),
      slug: "fixture-app",
      required: [CENTRAL],
      optional: [],
      map: FIXTURE_PERMISSIONS,
    });
    invariant(!result.done && result.verifiedAccounts.length === 0, "the wrong installation cannot authorize a required repository");
    assert.equal(result.missing[0].repository, CENTRAL);
    assert.deepEqual(fake.nonGet(), []);
  } finally {
    await fake.close();
  }
});

test("QA AC19/AC36: a failing installation-list request prevents every variable, secret and S1 write", async () => {
  const scenario = await createScenario();
  try {
    scenario.fake.override("GET", "/app/installations", { status: 500, body: { message: "synthetic unavailable" } });
    const before = scenario.workspace.read("sdlc.yaml");
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()), runGh: fastGh });
    invariant(run.code !== 0 && scenario.fake.nonGet().length === 0 && scenario.reconcile.calls.length === 0, "failure stops all downstream effects");
    assert.equal(run.stdout, "");
    assert.equal(scenario.workspace.read("sdlc.yaml"), before);
    assert.equal(scenario.fake.log.at(-1).path, "/app/installations");
  } finally {
    await scenario.cleanup();
  }
});

test("QA AC29/AC36: a thrown transport error stops bootstrap without a write or a reconcile call", async () => {
  const scenario = await createScenario();
  try {
    const calls = [];
    const before = sha256Tree(scenario.workspace.dir);
    const run = await scenario.bootstrap(["--non-interactive"], {
      env: scenario.env(scenario.appCredentials()),
      runGh: fastGh,
      fetch: async (url) => {
        calls.push(url);
        throw new Error("synthetic transport error", { cause: new Error("synthetic cause") });
      },
    });
    invariant(run.code !== 0 && calls.length === 1 && scenario.reconcile.calls.length === 0 && sha256Tree(scenario.workspace.dir) === before, "a failed GET /app leaves the working tree and S1 untouched");
    assert.match(run.stderr, /GET \/app could not be sent/);
    assert.equal(run.stderr.includes(scenario.appCredentials().APP_PRIVATE_KEY), false);
    assert.equal(run.stdout, "");
  } finally {
    await scenario.cleanup();
  }
});

for (const [prefix, kind] of [
  ["ghu_", "GitHub App user access token"],
  ["ghs_", "GitHub App installation access token"],
]) {
  test(`QA AC26: a ${kind} permission failure is identified without exposing the token or continuing`, async () => {
    const fake = await startFakeGitHub();
    const token = `${prefix}${"SyntheticCredential123".repeat(2)}`;
    try {
      fake.override("GET", `/repos/${CENTRAL}/actions/secrets/public-key`, { status: 403, body: { message: "synthetic forbidden" } });
      assert.equal(tokenKind(token), kind);
      await assert.rejects(uploadSecrets({
        api: createApi({ baseUrl: fake.url, fetch: fake.fetch, token }),
        repo: CENTRAL,
        secrets: [{ name: "ONE_SECRET", value: "synthetic-value" }],
      }), (error) => error.message.includes(kind) && error.message.includes("'Secrets'") && !error.message.includes(token));
      invariant(fake.log.length === 1 && fake.nonGet().length === 0, "no upload or subsequent request follows the permission failure");
    } finally {
      await fake.close();
    }
  });
}

test("QA AC45: an oversized local package manifest is not read or executed and target bytes remain unchanged", async () => {
  const workspace = createWorkspace({ files: { "package.json": " ".repeat(1024 * 1024 + 1) } });
  try {
    const before = sha256Tree(workspace.dir);
    const { result, writes } = await recordFsWrites(() => inspectRepository(localReader(workspace.dir), { repo: "example-owner/large", defaultBranch: "main", headSha: "a".repeat(40) }));
    invariant(result.packageManifests.includes("package.json") && result.scriptNames.length === 0 && writes.length === 0 && sha256Tree(workspace.dir) === before, "the size boundary keeps inspection read-only and invents no script");
    assert.deepEqual(result.buildCommands, []);
    assert.deepEqual(result.verifyCommands, []);
  } finally {
    workspace.cleanup();
  }
});

test("QA AC50: generated facts exclude expression/backtick paths without discarding ordinary facts", () => {
  const generated = generatedSection({
    repo: "example-owner/project",
    defaultBranch: "main",
    packageManifests: ["package.json", "bad`name/package.json", "bad${{expression}}/package.json"],
    buildCommands: ["npm run build"],
    verifyCommands: ["npm test", "bad`command"],
    workflows: [{ path: ".github/workflows/nightly.yml", scheduled: true }, { path: ".github/workflows/bad`name.yml", scheduled: true }],
    provenanceFiles: [{ path: "public/source.json" }, { path: "bad${{expression}}/source.json" }],
  });
  invariant(generated.includes("package.json") && generated.includes("nightly.yml") && generated.includes("public/source.json") && !generated.includes("bad"), "unsafe detected paths never reach the generated Markdown");
  assert.match(generated, /Build: `npm run build`/);
  assert.match(generated, /Verify: `npm test`/);
});

test("QA AC50/AC54: operator instructions remain byte-identical across empty, Unicode, CRLF and trailing-newline boundaries", () => {
  for (const text of ["", "one line", "one line\n", "one line\n\n", "one line\n\n\n", "# Notes\r\n\r\n日本語 — café\r\n", "first\n\nsecond\n\n"]) {
    const generated = "<!-- sdlc-onboard:generated -->\n## Detected repository facts";
    const first = composeInstructions(text, generated);
    invariant(first.startsWith(text) && composeInstructions(operatorTextOf(first), generated) === first, "re-onboarding preserves the exact file bytes, including the operator text");
  }
});

test("QA AC50: a valid UTF-8 non-ASCII instructions file is read byte for byte without writing", () => {
  const workspace = createWorkspace({ files: { "notes/operator.md": "日本語 — café\r\nNo last newline" } });
  try {
    const before = fs.readFileSync(workspace.path("notes/operator.md"));
    const value = readOperatorInstructions("notes/operator.md", workspace.dir);
    invariant(Buffer.from(value.text, "utf8").equals(before) && value.literal === "", "safe UTF-8 file content is preserved exactly");
    assert.deepEqual(fs.readFileSync(workspace.path("notes/operator.md")), before);
  } finally {
    workspace.cleanup();
  }
});
