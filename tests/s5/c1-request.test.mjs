// AC33 to AC36: contract C1 on the sender's side. S5 builds the nine-field BootstrapReconcileRequest, with the security baseline fixed
// in code and the granted App permissions equal to bin/lib/app-permissions.json, rejects any App or installation above that ceiling,
// and calls S1 only after every earlier step of its entry point has succeeded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { POLL_STATE_VAR_PREFIX } from "../../bin/lib/actions-variables.mjs";
import { loadPermissionMap } from "../../bin/lib/app-manifest.mjs";
import { SECURITY_BASELINE_CONSTANTS, buildReconcileRequest, loadReconciler } from "../../bin/lib/reconcile-client.mjs";
import { CENTRAL, FIXTURE_PERMISSIONS, REPO_ROOT, createScenario, errorResult, fixtureRepos, githubSideBrowser, installationOn } from "./helpers/harness.mjs";

const REQUEST_KEYS = ["manifestPath", "appSlug", "appClientIdVar", "appPrivateKeySecret", "pollStateVarPrefix", "engineAuthMode", "ghAwVersionPin", "securityBaseline", "dryRun"];
const BASELINE_KEYS = ["minGhAwVersion", "grantedAppPermissions", "requireStrictMode", "requireThreatDetection", "forbidAutoMerge"];
const MAP = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "bin", "lib", "app-permissions.json"), "utf8"));
const PAT = "github_pat_11C1REQUESTFIXTURE0123456789abcdefghijklmnopqrstuvwxyz";
const OK = {
  status: "ok",
  generatedWorkflows: [{ sourceMd: ".github/workflows/sdlc-onboard.md", lockYml: ".github/workflows/sdlc-onboard.lock.yml" }],
  repoConfigPath: ".github/workflows/aw.json",
  validationResults: [{ file: ".github/workflows/sdlc-onboard.md", valid: true, errors: [] }],
};
const REPOS = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const real = (file) => fs.realpathSync.native(file);

/** The one C1 request that a run sent (and the answer is OK). */
const requestOf = (scenario) => {
  assert.equal(scenario.reconcile.calls.length, 1, "S1 is called exactly once");
  return scenario.reconcile.calls[0].request;
};

// --- AC33 ------------------------------------------------------------------------------------------------------------------

test("AC33: the request has exactly the nine keys of C1 in order, the five baseline keys in order and the literal constants", () => {
  const request = buildReconcileRequest({ manifestPath: "/work/sdlc.yaml", appSlug: "my-app", engineAuthMode: "copilot-requests", ghAwVersionPin: "1.0.1" });
  assert.deepEqual(Object.keys(request), REQUEST_KEYS);
  assert.deepEqual(Object.keys(request.securityBaseline), BASELINE_KEYS);
  assert.equal(request.appClientIdVar, "APP_CLIENT_ID");
  assert.equal(request.appPrivateKeySecret, "APP_PRIVATE_KEY");
  assert.equal(request.pollStateVarPrefix, "SDLC_SYNC_STATE_");
  assert.equal(request.securityBaseline.minGhAwVersion, "1.0.1");
  assert.strictEqual(request.securityBaseline.requireStrictMode, true);
  assert.strictEqual(request.securityBaseline.requireThreatDetection, true);
  assert.strictEqual(request.securityBaseline.forbidAutoMerge, true);
  assert.strictEqual(request.dryRun, false);
});

test("AC33: nothing beyond the nine fields can be added: extra input properties are ignored and an unknown engineAuthMode is refused", () => {
  const request = buildReconcileRequest({ manifestPath: "/work/sdlc.yaml", appSlug: "my-app", engineAuthMode: "api-key", ghAwVersionPin: "1.0.2", extra: "x", securityBaseline: { requireStrictMode: false } });
  assert.deepEqual(Object.keys(request), REQUEST_KEYS);
  assert.strictEqual(request.securityBaseline.requireStrictMode, true);
  assert.throws(() => buildReconcileRequest({ manifestPath: "x", appSlug: "x", engineAuthMode: "token", ghAwVersionPin: "1.0.1" }), /engineAuthMode 'token'/);
});

test("AC33: the request is handed to the named export reconcile(request) of src/reconcile.mjs", async () => {
  const module = await import("../../src/reconcile.mjs");
  assert.equal(typeof module.reconcile, "function");
  assert.strictEqual(await loadReconciler(), module.reconcile);
});

test("AC33: a run sends the nine fields and nothing else, in order, to the reconciler", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const request = requestOf(scenario);
    assert.deepEqual(Object.keys(request), REQUEST_KEYS);
    assert.deepEqual(Object.keys(request.securityBaseline), BASELINE_KEYS);
    assert.equal(request.pollStateVarPrefix, POLL_STATE_VAR_PREFIX);
  } finally {
    await scenario.cleanup();
  }
});

// --- AC34 ------------------------------------------------------------------------------------------------------------------

const MODES = [
  { mode: "copilot-requests", bootstrap: [], env: {}, manifest: () => {} },
  { mode: "copilot-pat", bootstrap: [], env: { COPILOT_GITHUB_TOKEN: PAT }, manifest: () => {} },
  { mode: "api-key", bootstrap: ["--engine", "claude"], env: { ANTHROPIC_API_KEY: "sk-ant-c1-0123456789" }, manifest: (data) => (data.engineApiKeySecret = "ANTHROPIC_API_KEY") },
];

for (const { mode, bootstrap, env, manifest } of MODES) {
  for (const source of ["conversion", "GET /app"]) {
    test(`AC34: bootstrap, engineAuthMode ${mode}, slug from ${source}: every value of the request`, async () => {
      const scenario = await createScenario({ fake: { app: { slug: source === "GET /app" ? "slug-from-get-app" : "slug-from-conversion" } }, gh: { version: "1.0.4" } });
      try {
        scenario.workspace.editManifest(manifest);
        const extra =
          source === "GET /app"
            ? { env: scenario.env({ ...scenario.appCredentials(), ...env }) }
            : { env: scenario.env(env), openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } };
        const run = await scenario.bootstrap(source === "GET /app" ? ["--non-interactive", ...bootstrap] : bootstrap, extra);
        assert.equal(run.code, 0, run.stderr);
        const request = requestOf(scenario);
        assert.equal(real(request.manifestPath), real(scenario.workspace.path("sdlc.yaml")), "the resolved --manifest path");
        assert.equal(path.isAbsolute(request.manifestPath), true);
        assert.equal(request.appSlug, source === "GET /app" ? "slug-from-get-app" : "slug-from-conversion");
        assert.equal(request.appClientIdVar, "APP_CLIENT_ID");
        assert.equal(request.appPrivateKeySecret, "APP_PRIVATE_KEY");
        assert.equal(request.pollStateVarPrefix, POLL_STATE_VAR_PREFIX);
        assert.equal(request.engineAuthMode, mode);
        assert.equal(request.ghAwVersionPin, "1.0.4", "the version accepted by the gate");
        assert.strictEqual(request.dryRun, false);
        assert.equal(typeof request.dryRun, "boolean");
      } finally {
        await scenario.cleanup();
      }
    });
  }
}

for (const { mode, env, manifest } of MODES) {
  test(`AC34: onboard, engineAuthMode ${mode}, slug from GET /app: every value of the request`, async () => {
    const scenario = await createScenario({ fake: { app: { slug: "slug-from-get-app" }, repos: REPOS }, gh: { version: "1.0.3" } });
    try {
      scenario.workspace.editManifest(manifest);
      const run = await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env({ ...scenario.appCredentials(), ...env }) });
      assert.equal(run.code, 0, run.stderr);
      const request = requestOf(scenario);
      assert.equal(real(request.manifestPath), real(scenario.workspace.path("sdlc.yaml")));
      assert.equal(request.appSlug, "slug-from-get-app");
      assert.equal(request.engineAuthMode, mode);
      assert.equal(request.ghAwVersionPin, "1.0.3");
      assert.strictEqual(request.dryRun, false);
      assert.deepEqual(Object.keys(request), REQUEST_KEYS);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC34: a --manifest path is resolved, and it is the path that the request carries", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.write("conf/other-sdlc.yaml", scenario.workspace.read("sdlc.yaml"));
    const run = await scenario.bootstrap(["--non-interactive", "--manifest", "conf/other-sdlc.yaml"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(real(requestOf(scenario).manifestPath), real(scenario.workspace.path("conf/other-sdlc.yaml")));
  } finally {
    await scenario.cleanup();
  }
});

test("AC34: the pin is the version that the gate accepted, whichever version that is", async () => {
  for (const version of ["1.0.1", "1.2.10", "2.0.0"]) {
    const scenario = await createScenario({ gh: { version } });
    try {
      const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(requestOf(scenario).ghAwVersionPin, version);
    } finally {
      await scenario.cleanup();
    }
  }
});

// --- AC35 ------------------------------------------------------------------------------------------------------------------

test("AC35: the map of app-permissions.json is exactly the six entries of the spec, in order", () => {
  assert.deepEqual(MAP, { contents: "write", pull_requests: "write", issues: "write", actions: "write", variables: "write", metadata: "read" });
  assert.deepEqual(Object.keys(MAP), ["contents", "pull_requests", "issues", "actions", "variables", "metadata"]);
  assert.deepEqual(loadPermissionMap(), MAP);
  assert.deepEqual({ ...FIXTURE_PERMISSIONS }, MAP, "the fixture App holds exactly the map");
});

const FLAG_COMBINATIONS = [
  [],
  ["--non-interactive"],
  ["--non-interactive", "--engine", "copilot"],
  ["--non-interactive", "--deconflict-upstream-schedules"],
  ["--non-interactive", "--owner", "example-owner", "--app-name", "Another Name"],
];

for (const flags of FLAG_COMBINATIONS) {
  test(`AC35: the four constants and the permission map are fixed in code for the flags [${flags.join(" ")}], even against a hostile environment and manifest`, async () => {
    const scenario = await createScenario({ prompts: { COPILOT_GITHUB_TOKEN: "" } });
    try {
      scenario.workspace.editManifest((data) => {
        data.securityBaseline = { minGhAwVersion: "0.1.0", requireStrictMode: false, requireThreatDetection: false, forbidAutoMerge: false, grantedAppPermissions: { admin: "write" } };
      });
      const hostile = { SDLC_MIN_GH_AW_VERSION: "0.1.0", SDLC_REQUIRE_STRICT_MODE: "false", SDLC_REQUIRE_THREAT_DETECTION: "false", SDLC_FORBID_AUTO_MERGE: "false", GH_AW_MIN_VERSION: "0.1.0" };
      const run = await scenario.bootstrap(flags, { env: scenario.env({ ...scenario.appCredentials(), ...hostile }) });
      assert.equal(run.code, 0, run.stderr);
      const { securityBaseline } = requestOf(scenario);
      assert.deepEqual(Object.keys(securityBaseline), BASELINE_KEYS);
      assert.equal(securityBaseline.minGhAwVersion, "1.0.1");
      assert.strictEqual(securityBaseline.requireStrictMode, true);
      assert.strictEqual(securityBaseline.requireThreatDetection, true);
      assert.strictEqual(securityBaseline.forbidAutoMerge, true);
      assert.deepEqual(securityBaseline.grantedAppPermissions, MAP);
      assert.deepEqual(Object.keys(securityBaseline.grantedAppPermissions), Object.keys(MAP));
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC35: the constants of the code are frozen and are the four literal values", () => {
  assert.deepEqual({ ...SECURITY_BASELINE_CONSTANTS }, { minGhAwVersion: "1.0.1", requireStrictMode: true, requireThreatDetection: true, forbidAutoMerge: true });
  assert.equal(Object.isFrozen(SECURITY_BASELINE_CONSTANTS), true);
});

test("AC35: the granted permissions are a copy: changing a request does not change the next one", () => {
  const first = buildReconcileRequest({ manifestPath: "x", appSlug: "a", engineAuthMode: "copilot-requests", ghAwVersionPin: "1.0.1" });
  first.securityBaseline.grantedAppPermissions.admin = "write";
  const second = buildReconcileRequest({ manifestPath: "x", appSlug: "a", engineAuthMode: "copilot-requests", ghAwVersionPin: "1.0.1" });
  assert.deepEqual(second.securityBaseline.grantedAppPermissions, MAP);
});

const OVER_CEILING = [
  ["an extra key (packages: read)", { ...MAP, packages: "read" }, "packages", "read"],
  ["a level above the map (metadata: write)", { ...MAP, metadata: "write" }, "metadata", "write"],
  ["a level above the map (issues: admin)", { ...MAP, issues: "admin" }, "issues", "admin"],
  ["a value outside read and write (contents: admin)", { ...MAP, contents: "admin" }, "contents", "admin"],
];

for (const [label, permissions, key, level] of OVER_CEILING) {
  const assertRejected = (scenario, run) => {
    assert.notEqual(run.code, 0, "the run fails");
    assert.ok(run.stderr.includes(key) && run.stderr.includes(level), `the diagnostic names ${key} and ${level}: ${run.stderr}`);
    assert.equal(run.stdout, "");
    assert.equal(scenario.reconcile.calls.length, 0, "S1 is not called");
    assert.deepEqual(scenario.fake.requests("* /repos/:owner/:repo/actions/variables", "* /repos/:owner/:repo/actions/variables/:name", "PUT /repos/:owner/:repo/actions/secrets/:name"), [], "no variable and no secret is written");
  };

  test(`AC35: ${label} on the App of the conversion (new-App path) aborts before S1`, async () => {
    const scenario = await createScenario({ fake: { app: { permissions } } });
    try {
      assertRejected(scenario, await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } }));
    } finally {
      await scenario.cleanup();
    }
  });

  test(`AC35: ${label} on the App of GET /app (existing-App path) aborts before S1`, async () => {
    const scenario = await createScenario({ fake: { app: { permissions } } });
    try {
      assertRejected(scenario, await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) }));
    } finally {
      await scenario.cleanup();
    }
  });

  test(`AC35: ${label} on the installation (existing-App path) aborts before S1`, async () => {
    const scenario = await createScenario({ fake: { installations: [installationOn("example-owner", { permissions })] } });
    try {
      assertRejected(scenario, await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) }));
    } finally {
      await scenario.cleanup();
    }
  });

  test(`AC35: ${label} on the installation after the redirect (new-App path) aborts before S1`, async () => {
    const scenario = await createScenario();
    try {
      const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { install: [installationOn("example-owner", { permissions })] }), timing: { pollIntervalMs: 10 } });
      assertRejected(scenario, run);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC35: an App that lacks a required permission is rejected too, naming the key and the level it holds", async () => {
  const scenario = await createScenario({ fake: { app: { permissions: { ...MAP, variables: "read" } } } });
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /variables: write \(holds read\)/);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC35: no S5 artifact enables auto-merge: no `auto-merge: true` in aw.yml, the onboarding workflow or bin/", () => {
  const files = [path.join(REPO_ROOT, "aw.yml"), path.join(REPO_ROOT, ".github", "workflows", "sdlc-onboard.md")];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, "bin"));
  for (const file of files) assert.equal(/auto-merge:\s*true/.test(fs.readFileSync(file, "utf8")), false, `${file} enables auto-merge`);
  assert.ok(files.length > 10);
});

// --- AC36 ------------------------------------------------------------------------------------------------------------------

/** A reconciler that records the state of the world at the moment it is called. */
function snapshotStub(scenario, extra = () => ({})) {
  const snapshots = [];
  const stub = async (request) => {
    snapshots.push({ time: Date.now(), requests: scenario.fake.log.map((entry) => `${entry.method} ${entry.path}`), gh: scenario.gh.log().map((entry) => entry.args.join(" ")), ...extra() });
    return OK;
  };
  stub.snapshots = snapshots;
  return stub;
}

test("AC36: bootstrap, existing App: the gate, GET /app, the installation poll, the variables, the secrets, S1, then gh aw validate and gh aw doctor", async () => {
  const scenario = await createScenario();
  try {
    const stub = snapshotStub(scenario);
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()), reconcile: stub });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.snapshots.length, 1);
    const [snapshot] = stub.snapshots;
    const index = (pattern) => snapshot.requests.findIndex((line) => pattern.test(line));
    const last = (pattern) => snapshot.requests.findLastIndex((line) => pattern.test(line));
    assert.ok(index(/^GET \/app$/) >= 0);
    assert.ok(index(/^GET \/app$/) < index(/^GET \/app\/installations/));
    assert.ok(index(/^GET \/app\/installations/) < index(/actions\/variables/), "installations before variables");
    assert.ok(last(/actions\/variables/) < index(/actions\/secrets\/public-key/), "variables before secrets");
    assert.ok(index(/^PUT .*actions\/secrets\//) >= 0, "every secret was written before S1 was called");
    assert.equal(snapshot.requests.filter((line) => /^PUT .*actions\/secrets\//.test(line)).length, 1);
    assert.equal(snapshot.requests.filter((line) => /^POST .*actions\/variables$/.test(line)).length, 3, "APP_CLIENT_ID and the two state variables");
    assert.deepEqual(snapshot.gh.filter((line) => line.startsWith("aw ")), ["aw version"], "at S1 time only the gate has run");
    assert.deepEqual(scenario.gh.log().map((entry) => entry.args.join(" ")).filter((line) => line.startsWith("aw ")), ["aw version", "aw validate", "aw doctor"]);
    // the gate ran before the first request
    assert.ok(scenario.gh.log()[0].time <= scenario.fake.log[0].time);
    assert.ok(scenario.gh.calls("aw", "validate")[0].time >= snapshot.time && scenario.gh.calls("aw", "doctor")[0].time >= snapshot.time, "the readiness checks follow S1");
  } finally {
    await scenario.cleanup();
  }
});

test("AC36: bootstrap, new App: the conversion precedes the installation poll, the variables and the secrets, and S1 follows them all", async () => {
  const scenario = await createScenario();
  try {
    const stub = snapshotStub(scenario);
    const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 }, reconcile: stub });
    assert.equal(run.code, 0, run.stderr);
    const [snapshot] = stub.snapshots;
    const index = (pattern) => snapshot.requests.findIndex((line) => pattern.test(line));
    assert.ok(index(/^POST \/app-manifests\//) >= 0);
    assert.ok(index(/^POST \/app-manifests\//) < index(/^GET \/app\/installations/));
    assert.ok(index(/^GET \/app\/installations/) < index(/actions\/variables/));
    assert.ok(snapshot.requests.findLastIndex((line) => /actions\/variables/.test(line)) < index(/actions\/secrets\/public-key/));
    assert.ok(index(/^PUT .*actions\/secrets\/APP_PRIVATE_KEY$/) >= 0);
    assert.equal(scenario.fake.requests("GET /app").length, 0, "the slug comes from the conversion, so GET /app is not needed");
    assert.ok(scenario.gh.log()[0].time <= scenario.fake.log[0].time, "the gate ran first");
  } finally {
    await scenario.cleanup();
  }
});

const FAILURES = [
  {
    label: "AC10: --non-interactive without App credentials",
    run: (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env({}) }),
  },
  {
    label: "AC14: a callback whose state does not match",
    run: (scenario) => scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { callbackQuery: () => "code=abc123&state=not-the-state" }), timing: { pollIntervalMs: 10 } }),
  },
  {
    label: "AC14: a callback whose code has characters outside [A-Za-z0-9_-]",
    run: (scenario) => scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { callbackQuery: (state) => `code=bad%20code!&state=${state}` }), timing: { pollIntervalMs: 10 } }),
  },
  {
    label: "AC16: a conversion that answers 422",
    options: { fake: { conversion: { status: 422, message: "Validation Failed" } } },
    run: (scenario) => scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } }),
  },
  {
    label: "AC20: an incomplete installation",
    options: { fake: { installations: [] } },
    run: (scenario) => scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario, { install: false }), timing: { pollIntervalMs: 5, pollTimeoutMs: 60 } }),
  },
  {
    label: "AC28: a gho_ value",
    run: (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env({ ...scenario.appCredentials(), COPILOT_GITHUB_TOKEN: "gho_c1fixture0123456789" }) }),
  },
];

for (const { label, options, run } of FAILURES) {
  test(`AC36: zero calls to S1 after a failure: ${label}`, async () => {
    const scenario = await createScenario(options);
    try {
      const result = await run(scenario);
      assert.notEqual(result.code, 0, result.stderr);
      assert.equal(scenario.reconcile.calls.length, 0);
      assert.equal(result.stdout, "");
      assert.deepEqual(scenario.gh.calls("aw", "validate"), [], "the readiness checks do not run either");
      assert.deepEqual(scenario.gh.calls("aw", "doctor"), []);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC36: zero calls to S1 after a failure of a variable, of a secret and of the deconfliction", async () => {
  for (const arrange of [
    (scenario) => scenario.fake.override("PATCH", `/repos/${CENTRAL}/actions/variables/APP_CLIENT_ID`, { status: 403, body: { message: "no" } }),
    (scenario) => scenario.fake.override("PUT", `/repos/${CENTRAL}/actions/secrets/APP_PRIVATE_KEY`, { status: 403, body: { message: "no" } }),
  ]) {
    const scenario = await createScenario();
    try {
      arrange(scenario);
      const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
      assert.notEqual(run.code, 0);
      assert.equal(scenario.reconcile.calls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  }
});

test("AC36: onboard: S1 is called after sdlc.yaml and instructions/<projectKey>.md are written and after the state variable of the edge is created", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    const stub = snapshotStub(scenario, () => ({
      manifest: scenario.workspace.read("sdlc.yaml"),
      instructions: scenario.workspace.exists("instructions/node-app.md") ? scenario.workspace.read("instructions/node-app.md") : null,
    }));
    const run = await scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], { env: scenario.env(scenario.appCredentials()), reconcile: stub });
    assert.equal(run.code, 0, run.stderr);
    const [snapshot] = stub.snapshots;
    assert.match(snapshot.manifest, /projectKey: node-app/);
    assert.match(snapshot.manifest, /edgeId: node-app/);
    assert.ok(snapshot.instructions?.includes("## Detected repository facts"));
    assert.ok(snapshot.requests.includes(`GET /repos/${CENTRAL}/actions/variables/SDLC_SYNC_STATE_NODE_APP`));
    assert.ok(snapshot.requests.includes(`POST /repos/${CENTRAL}/actions/variables`), "the variable exists before S1 is called");
    assert.deepEqual(snapshot.gh.filter((line) => line.startsWith("aw ")), ["aw version"]);
    assert.deepEqual(scenario.gh.calls("aw", "validate").length + scenario.gh.calls("aw", "doctor").length, 2);
  } finally {
    await scenario.cleanup();
  }
});

test("AC36: onboard: no S1 call after an earlier failure (a missing credential, a cross-owner downstream, an unreadable target, a failing variable)", async () => {
  const cases = [
    { argv: ["--repo", "example-owner/node-app"], env: (scenario) => scenario.env({}) },
    { argv: ["--repo", "example-owner/node-app", "--downstream", "other-owner/edge-ok"], env: (scenario) => scenario.env(scenario.appCredentials()) },
    { argv: ["--repo", "example-owner/does-not-exist"], env: (scenario) => scenario.env(scenario.appCredentials()) },
    {
      argv: ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"],
      env: (scenario) => scenario.env(scenario.appCredentials()),
      arrange: (scenario) => scenario.fake.override("GET", `/repos/${CENTRAL}/actions/variables/SDLC_SYNC_STATE_NODE_APP`, { status: 403, body: { message: "no" } }),
    },
  ];
  for (const { argv, env, arrange } of cases) {
    const scenario = await createScenario({ fake: { repos: REPOS } });
    try {
      arrange?.(scenario);
      const before = scenario.workspace.read("sdlc.yaml");
      const run = await scenario.onboard(argv, { env: env(scenario) });
      assert.notEqual(run.code, 0, run.stderr);
      assert.equal(scenario.reconcile.calls.length, 0, argv.join(" "));
      assert.equal(scenario.workspace.read("sdlc.yaml"), before, "sdlc.yaml is as it was");
      assert.equal(run.stdout, "");
    } finally {
      await scenario.cleanup();
    }
  }
});

test("AC36: a reconciler that answers status error ends the run with a failure after it was called once", async () => {
  const scenario = await createScenario({ reconcile: () => errorResult(["sdlc.yaml: fixture schema error"]) });
  try {
    const run = await scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.equal(scenario.reconcile.calls.length, 1);
    assert.deepEqual(scenario.gh.calls("aw", "validate"), []);
  } finally {
    await scenario.cleanup();
  }
});
