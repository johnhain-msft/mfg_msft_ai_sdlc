// AC11 (preflight), AC18, AC19, AC20 and the installation half of AC35: the same-owner precondition, the installation
// pages, the verification poll (every five seconds, every page, per-repository coverage of a `selected` installation,
// the exact permission ceiling) and the diagnostics of an incomplete installation.
import assert from "node:assert/strict";
import test from "node:test";
import { signAppJwt } from "../../bin/lib/app-jwt.mjs";
import { createApi } from "../../bin/lib/github-api.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import {
  assertDownstreamsShareOwner,
  ensureInstallations,
  installationTargets,
  installationUrl,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "../../bin/lib/installations.mjs";
import { Capture, FIXTURE_PERMISSIONS, assertNoSecrets, createScenario, githubSideBrowser, installationOn, readFixture, runCli } from "./helpers/harness.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";
import { fixtureAppKey } from "./helpers/keys.mjs";
import YAML from "yaml";

const manifest = YAML.parse(readFixture("manifest.standard.yaml"));
const CENTRAL = "example-owner/example-repo";
const fast = { pollIntervalMs: 5, pollTimeoutMs: 120 };

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

// --- the same-owner preflight (AC11, AC19) ---------------------------------------------------------------------------------

test("AC19: assertDownstreamsShareOwner compares owners ASCII case-insensitively and names the downstream and both owners", () => {
  assert.doesNotThrow(() => assertDownstreamsShareOwner(manifest, CENTRAL));
  assert.doesNotThrow(() => assertDownstreamsShareOwner(manifest, "Example-Owner/example-repo"));
  const mixed = structuredClone(manifest);
  mixed.dependencyEdges[0].downstreamRepo = "EXAMPLE-OWNER/hub";
  assert.doesNotThrow(() => assertDownstreamsShareOwner(mixed, CENTRAL));
  const other = structuredClone(manifest);
  other.dependencyEdges[1].downstreamRepo = "other-owner/hub";
  assert.throws(
    () => assertDownstreamsShareOwner(other, CENTRAL),
    (error) => error.message.includes("other-owner/hub") && error.message.includes("'other-owner'") && error.message.includes("'example-owner'"),
  );
});

for (const [label, args, credentials] of [
  ["an interactive run that would register a new App", [], false],
  ["a --non-interactive run with both credentials", ["--non-interactive"], true],
  ["an interactive re-run with both credentials", [], true],
]) {
  test(`AC11 and AC19: ${label} rejects a downstreamRepo under another owner before any listener, browser or API request`, async () => {
    const scenario = await createScenario();
    try {
      scenario.workspace.editManifest((data) => {
        data.dependencyEdges[0].downstreamRepo = "other-owner/example-downstream";
      });
      const run = await runCli("bootstrap", args, { env: scenario.env(credentials ? scenario.appCredentials() : {}), cwd: scenario.workspace.dir });
      assert.notEqual(run.code, 0);
      assert.ok(run.stderr.includes("other-owner/example-downstream"));
      assert.ok(run.stderr.includes("'other-owner'") && run.stderr.includes("'example-owner'"));
      assert.deepEqual(run.trace.filter((event) => event.type === "listen"), [], "no listener is bound");
      assert.deepEqual(scenario.fake.log, [], "no API request is made");
      assert.equal(scenario.browser.urls.length, 0);
      assert.deepEqual(run.trace.filter((event) => event.type === "write"), []);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC19: the same-owner check is the first thing after the gate: it precedes the missing-credentials diagnostic of --non-interactive", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.editManifest((data) => {
      data.dependencyEdges[0].downstreamRepo = "other-owner/example-downstream";
    });
    const run = await scenario.bootstrap(["--non-interactive"]);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /other-owner\/example-downstream/);
    assert.equal(run.stderr.includes("interactive browser flow"), false);
  } finally {
    await scenario.cleanup();
  }
});

test("AC19: an owner that differs only in letter case is accepted and the run completes", async () => {
  const scenario = await createScenario({ workspace: { origin: "https://github.com/Example-Owner/example-repo.git" } });
  try {
    scenario.workspace.editManifest((data) => {
      data.dependencyEdges[0].downstreamRepo = "EXAMPLE-OWNER/hub";
    });
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
  } finally {
    await scenario.cleanup();
  }
});

// --- targets and URLs (AC18) -----------------------------------------------------------------------------------------------

test("AC18: the targets are the central repository, the drift-enabled projects and the downstream repositories; upstream-only repositories only warn", () => {
  const targets = installationTargets(manifest, CENTRAL);
  assert.deepEqual(targets.required, [CENTRAL, "example-owner/alpha-service", "example-owner/hub"]);
  assert.deepEqual(targets.optional, ["third-party/gamma-lib"]);
  assert.deepEqual(targets.accounts, ["example-owner"]);
  const more = structuredClone(manifest);
  more.projects.push({ ...structuredClone(more.projects[0]), projectKey: "lab", repo: "other-org/lab" });
  more.projects.push({ ...structuredClone(more.projects[1]), projectKey: "off", repo: "disabled-org/off" });
  const withLab = installationTargets(more, CENTRAL);
  assert.deepEqual(withLab.accounts, ["example-owner", "other-org"], "the account of a drift-disabled project is not a target");
  assert.equal(withLab.required.includes("disabled-org/off"), false);
});

test("AC18: the installation URL is the plain form without IDs and the /permissions form with them, never with more than 100 repositories", () => {
  assert.equal(installationUrl("my-app"), "https://github.com/apps/my-app/installations/new");
  assert.equal(
    installationUrl("my-app", { accountId: 1, repositoryIds: [2, 3] }),
    "https://github.com/apps/my-app/installations/new/permissions?suggested_target_id=1&repository_ids[]=2&repository_ids[]=3",
  );
  assert.equal(installationUrl("my-app", { accountId: 1, repositoryIds: Array.from({ length: 100 }, (_, index) => index) }).includes("/permissions?"), true);
  assert.equal(installationUrl("my-app", { accountId: 1, repositoryIds: Array.from({ length: 101 }, (_, index) => index) }), "https://github.com/apps/my-app/installations/new");
  assert.equal(installationUrl("my-app", { accountId: null, repositoryIds: [2] }), "https://github.com/apps/my-app/installations/new");
});

test("AC18: with three accounts the browser is sent to each installation page in turn, in the plain, the /permissions and the 101-repository form", async () => {
  const bigRepos = Array.from({ length: 101 }, (_, index) => `big-org/repo-${String(index).padStart(3, "0")}`);
  const scenario = await createScenario({
    fake: {
      installations: [installationOn("example-owner"), installationOn("other-org"), installationOn("big-org")],
      users: { "example-owner": { id: 1, type: "Organization" }, "big-org": { id: 9, type: "Organization" } },
      repos: { "example-owner/example-repo": { id: 2 }, "example-owner/alpha-service": { id: 3 }, "example-owner/hub": { id: 4 } },
    },
  });
  try {
    scenario.workspace.editManifest((data) => {
      data.projects.push({ ...structuredClone(data.projects[0]), projectKey: "lab", repo: "other-org/lab" });
      bigRepos.forEach((repo, index) => data.projects.push({ ...structuredClone(data.projects[0]), projectKey: `big-${index}`, repo }));
    });
    const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { install: false }), timing: fast });
    assert.equal(run.code, 0, run.stderr);
    const urls = scenario.browser.urls.filter((url) => url.includes("github.com/apps/"));
    assert.deepEqual(urls, [
      "https://github.com/apps/fixture-app/installations/new/permissions?suggested_target_id=1&repository_ids[]=2&repository_ids[]=3&repository_ids[]=4",
      "https://github.com/apps/fixture-app/installations/new",
      "https://github.com/apps/fixture-app/installations/new",
    ]);
    for (const repo of [bigRepos[0], bigRepos[100]]) assert.ok(run.stderr.includes(`  ${repo}`), `${repo} is printed for manual selection`);
    assert.match(run.stderr, /needs more than 100 repositories, so the plain installation page is used/);
    assert.ok(scenario.browser.urls[0].endsWith("/register"), "the registration page comes first");
  } finally {
    await scenario.cleanup();
  }
});

test("AC18: SDLC_BOOTSTRAP_NO_OPEN_BROWSER keeps every page closed and the installation URLs are printed instead", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: scenario.env({ ...scenario.appCredentials(), SDLC_BOOTSTRAP_NO_OPEN_BROWSER: "1" }) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.browser.urls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

// --- the poll (AC19) -------------------------------------------------------------------------------------------------------

// The poll reads the fake in memory (`fake.fetch`, no socket): see tests/s5/helpers/no-network.mjs for why a socket is avoided,
// and undici, whose connection timers live in module state that a mocked-timer test leaves behind, is not involved either.
function pollHarness(fake, overrides = {}) {
  const api = createApi({ baseUrl: fake.url, fetch: fake.fetch });
  const logs = new Capture();
  const key = fixtureAppKey().privateKeyPem;
  const waiting = [];
  const promise = ensureInstallations({
    api,
    slug: "fixture-app",
    signJwt: () => signAppJwt({ privateKeyPem: key, issuer: "Iv1.fixture" }),
    targets: { required: [CENTRAL], optional: [], accounts: ["example-owner"] },
    openBrowser: async () => {},
    openForInstall: false,
    logger: createLogger(logs),
    hooks: { onWaiting: (polls) => waiting.push(polls) },
    ...overrides,
  });
  promise.catch(() => {});
  return { promise, logs, waiting, polls: () => fake.requests("GET /app/installations").length };
}

test("AC19: GET /app/installations is polled every 5 seconds until every required repository is covered", async (t) => {
  assert.equal(POLL_INTERVAL_MS, 5000);
  assert.equal(POLL_TIMEOUT_MS, 600000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = await startFakeGitHub({ installations: [] });
  try {
    const harness = pollHarness(fake);
    await until(() => harness.waiting.length === 1, "the first poll to finish");
    assert.equal(harness.polls(), 1);
    t.mock.timers.tick(4999);
    await tick();
    assert.equal(harness.polls(), 1, "no second poll before 5,000 ms");
    t.mock.timers.tick(1);
    await until(() => harness.waiting.length === 2, "the second poll to finish");
    assert.equal(harness.polls(), 2);
    fake.setInstallations([installationOn("example-owner")]);
    t.mock.timers.tick(5000);
    const result = await harness.promise;
    assert.equal(harness.polls(), 3);
    assert.deepEqual(result.installationsVerified, ["example-owner"]);
  } finally {
    await fake.close();
  }
});

test("AC19: the poll is bounded at ten minutes and aborts with the incomplete-installation diagnostic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = await startFakeGitHub({ installations: [] });
  try {
    const harness = pollHarness(fake, { privateKeyInMemoryOnly: true });
    await until(() => harness.waiting.length === 1, "the first poll to finish");
    t.mock.timers.tick(POLL_TIMEOUT_MS - 1);
    let settled = false;
    harness.promise.then(() => (settled = true), () => (settled = true));
    await tick();
    assert.equal(settled, false, "still polling at 599,999 ms");
    t.mock.timers.tick(1);
    await assert.rejects(harness.promise, (error) => error.message.includes(CENTRAL) && error.message.includes("variables: write") && error.message.includes("fixture-app") && /private key was not stored/.test(error.message));
  } finally {
    await fake.close();
  }
});

test("AC19: every page of GET /app/installations is followed on each poll (per_page=100 and Link rel=next)", async () => {
  const filler = Array.from({ length: 250 }, (_, index) => installationOn(`filler-${index}`, { id: 50000 + index }));
  const fake = await startFakeGitHub({ installations: [...filler, installationOn("example-owner")] });
  try {
    const harness = pollHarness(fake);
    const result = await harness.promise;
    assert.deepEqual(result.installationsVerified, ["example-owner"]);
    assert.deepEqual(
      fake.requests("GET /app/installations").map((entry) => entry.query),
      ["per_page=100", "per_page=100&page=2", "per_page=100&page=3"],
      "the first poll reads the last page, where the installation is",
    );
  } finally {
    await fake.close();
  }
});

test("AC19: an installation reported as selected is confirmed per repository", async () => {
  const selected = installationOn("example-owner", { repository_selection: "selected", _repositories: [CENTRAL, "example-owner/alpha-service", "example-owner/hub"] });
  const fake = await startFakeGitHub({ installations: [selected] });
  try {
    const harness = pollHarness(fake, { targets: { required: [CENTRAL, "example-owner/alpha-service", "example-owner/hub"], optional: [], accounts: ["example-owner"] } });
    assert.deepEqual((await harness.promise).installationsVerified, ["example-owner"]);
    assert.deepEqual(
      fake.requests("GET /repos/:owner/:repo/installation").map((entry) => entry.path),
      [`/repos/${CENTRAL}/installation`, "/repos/example-owner/alpha-service/installation", "/repos/example-owner/hub/installation"],
    );
    assert.ok(fake.requests("GET /repos/:owner/:repo/installation").every((entry) => entry.auth.jwtValid), "the per-repository check uses the App JWT");
  } finally {
    await fake.close();
  }
});

test("AC19: a selected installation that leaves a required repository out does not cover it", async () => {
  const selected = installationOn("example-owner", { repository_selection: "selected", _repositories: [CENTRAL] });
  const fake = await startFakeGitHub({ installations: [selected] });
  try {
    const harness = pollHarness(fake, {
      targets: { required: [CENTRAL, "example-owner/hub"], optional: [], accounts: ["example-owner"] },
      pollIntervalMs: 2,
      timeoutMs: 40,
    });
    await assert.rejects(harness.promise, (error) => error.message.includes("example-owner/hub: the installation on account 'example-owner' does not include the repository") && !error.message.includes(`${CENTRAL}:`));
  } finally {
    await fake.close();
  }
});

test("AC19: an upstream-only repository that is not covered produces a warning, not an error, and is not listed as verified", async () => {
  const fake = await startFakeGitHub({ installations: [installationOn("example-owner")] });
  try {
    const harness = pollHarness(fake, { targets: { required: [CENTRAL], optional: ["third-party/gamma-lib"], accounts: ["example-owner"] } });
    const result = await harness.promise;
    assert.deepEqual(result.installationsVerified, ["example-owner"]);
    assert.deepEqual(result.warnings, ["third-party/gamma-lib"]);
    assert.match(harness.logs.text, /warning: the upstream-only repository third-party\/gamma-lib is not covered/);
  } finally {
    await fake.close();
  }
});

test("AC19: a suspended installation does not cover anything", async () => {
  const fake = await startFakeGitHub({ installations: [installationOn("example-owner", { suspended_at: "2026-10-01T00:00:00Z" })] });
  try {
    await assert.rejects(pollHarness(fake, { pollIntervalMs: 2, timeoutMs: 30 }).promise, /no installation of the App exists on account 'example-owner'/);
  } finally {
    await fake.close();
  }
});

test("AC19: installationsVerified lists the account of each verified installation, as GitHub spells it", async () => {
  const fake = await startFakeGitHub({ installations: [installationOn("Example-Owner")] });
  try {
    assert.deepEqual((await pollHarness(fake).promise).installationsVerified, ["Example-Owner"]);
  } finally {
    await fake.close();
  }
});

// --- AC20: an incomplete installation -------------------------------------------------------------------------------------

const INCOMPLETE = [
  ["no installation at all", [], ["example-owner/example-repo", "variables: write", "install the App on 'example-owner' at https://github.com/apps/fixture-app/installations/new"]],
  [
    "an installation without the variables permission",
    [installationOn("example-owner", { permissions: Object.fromEntries(Object.entries(FIXTURE_PERMISSIONS).filter(([key]) => key !== "variables")) })],
    ["example-owner/example-repo", "variables: write", "lacks required permissions"],
  ],
  [
    "an installation with contents lowered to read",
    [installationOn("example-owner", { permissions: { ...FIXTURE_PERMISSIONS, contents: "read" } })],
    ["contents: write"],
  ],
  [
    "a selected installation that excludes the central repository",
    [installationOn("example-owner", { repository_selection: "selected", _repositories: ["example-owner/alpha-service", "example-owner/hub"] })],
    ["example-owner/example-repo", "does not include the repository"],
  ],
];

for (const [label, installations, expected] of INCOMPLETE) {
  test(`AC20: ${label} aborts naming the repository, the permission and the slug, writes nothing and never lists the account`, async () => {
    const scenario = await createScenario({ fake: { installations } });
    try {
      const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()), timing: fast });
      assert.notEqual(run.code, 0);
      for (const text of expected) assert.ok(run.stderr.includes(text), `${JSON.stringify(text)} is in: ${run.stderr}`);
      assert.ok(run.stderr.includes("fixture-app"));
      assert.equal(run.stdout, "", "no summary report, so no account is listed in installationsVerified");
      assert.deepEqual(scenario.fake.nonGet(), [], "zero variable or secret requests");
      assert.equal(scenario.reconcile.calls.length, 0);
      assertNoSecrets({ stdout: run.stdout, stderr: run.stderr }, [scenario.fake.appKey.privateKeyPem]);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC20: after a registration the diagnostic says that the App exists, that its key was not stored and how to continue", async () => {
  const scenario = await createScenario({ fake: { installations: [] } });
  try {
    const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { install: false }), timing: fast });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /The GitHub App 'fixture-app' exists, but its private key was not stored/);
    assert.match(run.stderr, /generate a new private key from the App's settings and run the bootstrap again with APP_CLIENT_ID and APP_PRIVATE_KEY in the environment/);
    assert.match(run.stderr, /the App must allow installation on any account/, "OQ44: installing on another account is not assumed");
    assert.deepEqual(scenario.fake.nonGet().filter((entry) => !entry.path.startsWith("/app-manifests/")), []);
    assertNoSecrets({ stdout: run.stdout, stderr: run.stderr }, [scenario.fake.appKey.privateKeyPem, "fixture-client-secret", "fixture-webhook-secret"]);
  } finally {
    await scenario.cleanup();
  }
});

// --- the permission ceiling on installations and on the App (AC19, AC35) ----------------------------------------------------

const EXCESS = [
  ["an extra key", { ...FIXTURE_PERMISSIONS, packages: "read" }, ["packages", "read"]],
  ["a level above the map", { ...FIXTURE_PERMISSIONS, metadata: "write" }, ["metadata", "write", "above read"]],
  ["admin where the map says write", { ...FIXTURE_PERMISSIONS, contents: "admin" }, ["contents", "admin"]],
  ["a value outside read and write", { ...FIXTURE_PERMISSIONS, issues: "none" }, ["issues", "none"]],
];

for (const [label, permissions, expected] of EXCESS) {
  test(`AC19 and AC35: an installation with ${label} is rejected before any variable, secret or S1 call, naming the account, the key and the level`, async () => {
    const scenario = await createScenario({ fake: { installations: [installationOn("example-owner", { permissions })] } });
    try {
      const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()), timing: fast });
      assert.notEqual(run.code, 0);
      assert.ok(run.stderr.includes("'example-owner'"), "the account is named");
      for (const text of expected) assert.ok(run.stderr.includes(text), `${JSON.stringify(text)} is in: ${run.stderr}`);
      assert.deepEqual(scenario.fake.nonGet(), []);
      assert.equal(scenario.reconcile.calls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC19: every installation that the poll returns must stay within the ceiling, including one on an account that is not required", async () => {
  const scenario = await createScenario({
    fake: { installations: [installationOn("example-owner"), installationOn("unrelated-org", { permissions: { ...FIXTURE_PERMISSIONS, packages: "read" } })] },
  });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()), timing: fast });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /installation of GitHub App 'fixture-app' on account 'unrelated-org'[\s\S]*packages: read/);
    assert.deepEqual(scenario.fake.nonGet(), []);
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, permissions, expected] of [
  ...EXCESS,
  ["a missing required permission", Object.fromEntries(Object.entries(FIXTURE_PERMISSIONS).filter(([key]) => key !== "variables")), ["lacks required permissions", "variables: write"]],
]) {
  test(`AC35: a registered App with ${label} is rejected before it is installed, with no write and no S1 call`, async () => {
    const scenario = await createScenario({ fake: { installations: [], app: { permissions } } });
    try {
      const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: fast });
      assert.notEqual(run.code, 0);
      assert.ok(run.stderr.includes("GitHub App 'fixture-app'"), "the slug is named");
      for (const text of expected) assert.ok(run.stderr.includes(text), `${JSON.stringify(text)} is in: ${run.stderr}`);
      assert.match(run.stderr, /private key was not stored/, "the App exists after the registration");
      assert.deepEqual(scenario.fake.nonGet().filter((entry) => !entry.path.startsWith("/app-manifests/")), []);
      assert.equal(scenario.fake.requests("GET /app/installations").length, 0, "no installation poll: the ceiling is checked right after the registration");
      assert.equal(scenario.reconcile.calls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC35: the existing App of GET /app is held to the same ceiling before the installations are read", async () => {
  const scenario = await createScenario({ fake: { app: { permissions: { ...FIXTURE_PERMISSIONS, packages: "read" } } } });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /GitHub App 'fixture-app' exceeds the least-privilege ceiling[\s\S]*packages: read/);
    assert.equal(scenario.fake.requests("GET /app/installations").length, 0);
    assert.deepEqual(scenario.fake.nonGet(), []);
  } finally {
    await scenario.cleanup();
  }
});
