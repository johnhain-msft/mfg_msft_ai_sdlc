// AC46, AC48, AC49 and AC52 against the REAL src/reconcile.mjs (S1) in a temporary working copy, with the stub compiler of tests/s5/helpers/fake-gh.mjs:
// every entry that bin/sdlc-onboard.mjs writes passes S1's validation without a manual edit, the hostnames of the watch URLs reach the
// network block of the compiled workflow, a field that cannot be derived stops the run, and the state variable of a new edge is
// created (404 only) before S1 is called exactly once.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import { reconcile as realReconcile } from "../../src/reconcile.mjs";
import { REPO_ROOT, createScenario, errorResult, fixtureRepos, readFixture, runCli } from "./helpers/harness.mjs";

const EMPTY = readFixture("manifest.empty.yaml");
const REPOS = fixtureRepos({
  "example-owner/node-app": "node-app",
  "example-owner/dotnet-app": "dotnet-app",
  "example-owner/lab-like": "lab-like",
  "example-owner/provenance-like": "provenance-like",
  "example-owner/codeowners-like": "codeowners-like",
  "example-owner/edge-ok": "edge-ok",
  "example-owner/edge-mechanical": "edge-mechanical",
  "example-owner/edge-no-provenance": "edge-no-provenance",
});
const SEED_SHA = "2222222222222222222222222222222222222222";
const VARIABLES = "/repos/example-owner/example-repo/actions/variables";

/** Runs the onboarding with the real S1; `results` holds every ReconcileResult that S1 returned. */
async function withRealS1(argv, callback, { manifest = "standard", repos = REPOS, prepare } = {}) {
  const scenario = await createScenario({ fake: { repos }, workspace: { manifest: manifest === "empty" ? EMPTY : manifest } });
  try {
    prepare?.(scenario);
    const results = [];
    const recording = async (request, options) => {
      const result = await realReconcile(request, options);
      results.push(result);
      return result;
    };
    const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()), reconcile: recording });
    return await callback({ scenario, run, results, manifest: () => YAML.parse(scenario.workspace.read("sdlc.yaml")) });
  } finally {
    await scenario.cleanup();
  }
}

const frontMatter = (text) => YAML.parse(/^---\n([\s\S]*?)\n---/.exec(text)[1]);
const entryOf = (data, key) => data.projects.find((project) => project.projectKey === key);
const assertAccepted = ({ run, results }) => {
  assert.equal(run.code, 0, run.stderr);
  assert.equal(results.length, 1, "S1 was called once");
  assert.equal(results[0].status, "ok");
  assert.deepEqual(results[0].validationResults.filter((entry) => !entry.valid), [], "no validation error, no schema error");
};

// --- AC46 and AC49: S1 accepts what S5 wrote -------------------------------------------------------------------------------

const ACCEPTED = [
  { label: "node-app (a test script, a build script)", argv: ["--repo", "example-owner/node-app"], workflows: ["drift-node-app.md"] },
  { label: "codeowners-like (an individual reviewer and a team)", argv: ["--repo", "example-owner/codeowners-like"], workflows: ["drift-codeowners-like.md"] },
  { label: "node-app with edge-ok (ai-adaptation)", argv: ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], workflows: ["drift-node-app.md", "cascade-ai-node-app.md"] },
  { label: "node-app with edge-mechanical (mechanical)", argv: ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-mechanical"], workflows: ["drift-node-app.md", "cascade-mechanical-node-app.md"] },
  { label: "node-app with edge-ok and an explicit mechanical mode", argv: ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok", "--mode", "mechanical"], workflows: ["cascade-mechanical-node-app.md"] },
  { label: "node-app with every flag", argv: ["--repo", "example-owner/node-app", "--strategy", "custom", "--schedule", "30 4 * * 2", "--watch-url", "https://example.com/changelog", "--watch-url", "https://docs.example.org/blog/feed.xml", "--instructions", "Keep the docs in step with the code."], workflows: ["drift-node-app.md"] },
];

for (const base of ["standard", "empty"]) {
  for (const { label, argv, workflows } of ACCEPTED) {
    test(`AC46/AC49: ${label}, into the ${base} manifest: the real S1 answers status ok with no schema error and renders ${workflows.join(", ")}`, async () => {
      await withRealS1(argv, ({ scenario, run, results }) => {
        assertAccepted({ run, results });
        for (const workflow of workflows) assert.equal(scenario.workspace.exists(`.github/workflows/${workflow}`), true, `${workflow} was rendered`);
        assert.ok(results[0].generatedWorkflows.some((entry) => entry.sourceMd === `.github/workflows/${workflows[0]}`));
        const report = JSON.parse(run.stdout);
        assert.deepEqual(report.compiledWorkflows, results[0].generatedWorkflows.map((entry) => entry.lockYml).sort());
        assert.equal(report.doctorStatus, "pass");
      }, { manifest: base });
    });
  }
}

test("AC46: the written sdlc.yaml also validates against schemas/sdlc.schema.json directly, with no manual edit", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "sdlc.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  await withRealS1(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok", "--watch-url", "https://example.com/changelog"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(validate(manifest()), true, JSON.stringify(validate.errors));
  });
});

// --- AC46: a target without a test script ----------------------------------------------------------------------------------

for (const name of ["dotnet-app", "lab-like", "provenance-like"]) {
  test(`AC46: ${name} has no test script: the entry is schema-valid, S1 asks for a verify command, nothing is left written, and a hand-written entry with one is kept`, async () => {
    const golden = JSON.parse(readFixture("onboard", name, "expected.projects.json"))[0];
    await withRealS1(["--repo", `example-owner/${name}`], async ({ scenario, run, results, manifest }) => {
      assert.notEqual(run.code, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "error");
      const errors = results[0].validationResults.flatMap((entry) => entry.errors);
      assert.equal(errors.length, 1, errors.join("\n"));
      assert.match(errors[0], /^drift-verify-commands-missing: project '[^']+' \(.*#\/projects\/\d+\/driftAudit\): verifyCommands must contain at least one runnable command$/);
      assert.match(run.stderr, /warning: .*verifyCommands is empty \(S5 never invents a command\)/);
      assert.match(run.stderr, /Remediation \(external:operator\):/);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"), "restored");
      assert.equal(scenario.workspace.exists(`instructions/${name}.md`), false);

      // The operator writes the entry by hand with the command that the repository lacks; the next run keeps it.
      scenario.workspace.editManifest((data) => data.projects.push({ ...structuredClone(golden), driftAudit: { ...structuredClone(golden.driftAudit), verifyCommands: ["dotnet test"] } }));
      const again = await scenario.onboard(["--repo", `example-owner/${name}`], { env: scenario.env(scenario.appCredentials()), reconcile: realReconcile });
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(entryOf(manifest(), name).driftAudit.verifyCommands, ["dotnet test"], "the operator's value is never overwritten");
    });
  });
}

// --- AC48: the network block -----------------------------------------------------------------------------------------------

test("AC48: example.com appears in the network block of .github/workflows/drift-<projectKey>.md, and no wildcard does", async () => {
  await withRealS1(["--repo", "example-owner/node-app", "--watch-url", "https://example.com/changelog"], ({ scenario, run, results }) => {
    assertAccepted({ run, results });
    const workflow = frontMatter(scenario.workspace.read(".github/workflows/drift-node-app.md"));
    assert.ok(workflow.network.allowed.includes("example.com"), JSON.stringify(workflow.network));
    assert.equal(workflow.network.allowed.some((host) => host.includes("*")), false);
  });
});

test("AC48: every watch-URL hostname reaches the network block, once", async () => {
  await withRealS1(
    ["--repo", "example-owner/node-app", "--watch-url", "https://example.com/changelog", "--watch-url", "https://docs.example.org/blog/feed.xml", "--watch-url", "https://example.com/guide"],
    ({ scenario, run, results }) => {
      assertAccepted({ run, results });
      const { allowed } = frontMatter(scenario.workspace.read(".github/workflows/drift-node-app.md")).network;
      for (const host of ["example.com", "docs.example.org"]) assert.equal(allowed.filter((entry) => entry === host).length, 1, host);
    },
  );
});

// --- AC49: what cannot be derived ------------------------------------------------------------------------------------------

test("AC49: a downstream that lacks a derivable required field exits non-zero, lists the field, never calls S1 and renders nothing", async () => {
  await withRealS1(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-no-provenance"], ({ scenario, run, results }) => {
    assert.notEqual(run.code, 0);
    assert.deepEqual(results, [], "S1 was not called");
    assert.match(run.stderr, /provenanceFile, provenanceJsonPointer and allowedFiles \(no provenance file found in example-owner\/edge-no-provenance; exactly one is needed\)/);
    assert.equal(scenario.workspace.exists(".github/workflows"), false);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
  });
});

// --- AC52: the state variable of the new edge ------------------------------------------------------------------------------

const EDGE_ARGV = ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"];

/** An S1 stand-in that records what existed when it was called. */
function snapshotStub(scenario, answer) {
  const snapshots = [];
  const stub = async (request) => {
    snapshots.push({ request: structuredClone(request), requests: scenario.fake.log.map((entry) => `${entry.method} ${entry.path}`), variables: { ...scenario.fake.variablesOf("example-owner/example-repo") } });
    return answer ?? { status: "ok", generatedWorkflows: [], repoConfigPath: ".github/workflows/aw.json", validationResults: [] };
  };
  stub.snapshots = snapshots;
  return stub;
}

test("AC52: the state variable is absent: one POST seeded from the new edge's initialBaselineSha, then exactly one C1 request", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    const stub = snapshotStub(scenario);
    const run = await scenario.onboard(EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), reconcile: stub, now: () => new Date("2026-05-06T07:08:09.000Z") });
    assert.equal(run.code, 0, run.stderr);
    const posts = scenario.fake.requests("POST /repos/:owner/:repo/actions/variables");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.name, "SDLC_SYNC_STATE_NODE_APP");
    assert.deepEqual(JSON.parse(posts[0].body.value), {
      etag: "",
      lastObservedHeadSha: SEED_SHA,
      lastMergedUpstreamSha: SEED_SHA,
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
      updatedAt: "2026-05-06T07:08:09.000Z",
    });
    assert.equal(stub.snapshots.length, 1, "exactly one C1 request");
    assert.ok("SDLC_SYNC_STATE_NODE_APP" in stub.snapshots[0].variables, "the variable existed when S1 was called");
    assert.deepEqual(scenario.fake.nonGet().map((entry) => `${entry.method} ${entry.path}`), [`POST ${VARIABLES}`]);
    assert.deepEqual(JSON.parse(run.stdout).variablesSet, ["SDLC_SYNC_STATE_NODE_APP"]);
  } finally {
    await scenario.cleanup();
  }
});

test("AC52: the state variable is present: zero writes, the existing value is untouched and the operator guidance is printed", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    scenario.fake.setVariable("example-owner/example-repo", "SDLC_SYNC_STATE_NODE_APP", "operator-state");
    const stub = snapshotStub(scenario);
    const run = await scenario.onboard(EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), reconcile: stub });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(scenario.fake.nonGet(), []);
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo").SDLC_SYNC_STATE_NODE_APP, "operator-state");
    assert.match(run.stderr, /Existing state variables were left unchanged: SDLC_SYNC_STATE_NODE_APP\./);
    assert.match(run.stderr, /cascade-router\.yml/);
    assert.match(run.stderr, /reset_blocked: true/);
    assert.equal(stub.snapshots.length, 1);
    assert.deepEqual(JSON.parse(run.stdout).variablesSet, []);
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, override] of [
  ["GET answers 403", ["GET", `${VARIABLES}/SDLC_SYNC_STATE_NODE_APP`]],
  ["GET answers 500", ["GET", `${VARIABLES}/SDLC_SYNC_STATE_NODE_APP`]],
  ["POST answers 403", ["POST", VARIABLES]],
]) {
  const status = /500/.test(label) ? 500 : 403;
  test(`AC52: ${label}: non-zero exit naming the 'Variables' repository permission, S1 not called, sdlc.yaml and the instructions file restored`, async () => {
    const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
    try {
      scenario.fake.override(...override, { status, body: { message: "Resource not accessible" } });
      const stub = snapshotStub(scenario);
      const run = await scenario.onboard(EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), reconcile: stub });
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /'Variables' repository permission/);
      assert.equal(stub.snapshots.length, 0, "S1 was not called");
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"), "restored to its previous bytes");
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /were restored to their previous bytes/);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC52: without --downstream no variable is touched at all", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    const run = await scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()), reconcile: snapshotStub(scenario) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(scenario.fake.log.filter((entry) => entry.path.includes("/actions/")), []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC52: a second run finds the variable (GET 200) and writes nothing; S1 is called once per run", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    const stub = snapshotStub(scenario);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await scenario.onboard(EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), reconcile: stub });
      assert.equal(run.code, 0, run.stderr);
    }
    assert.equal(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").length, 1, "created once");
    assert.equal(stub.snapshots.length, 2);
  } finally {
    await scenario.cleanup();
  }
});

test("AC52: when S1 rejects the manifest the files are restored, and the variable stays (it is only ever created, never removed)", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    const run = await scenario.onboard(EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), reconcile: async () => errorResult(["fixture S1 error"]) });
    assert.notEqual(run.code, 0);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
    assert.deepEqual(Object.keys(scenario.fake.variablesOf("example-owner/example-repo")), ["SDLC_SYNC_STATE_NODE_APP"]);
  } finally {
    await scenario.cleanup();
  }
});

// --- the real entry points as processes ------------------------------------------------------------------------------------

test("the real bin/sdlc-onboard.mjs process with the real S1: exit 0, one JSON document on stdout, and only sdlc.yaml, the instructions file and .github/workflows written", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: "standard" } });
  try {
    scenario.workspace.commitAll("baseline");
    const run = await runCli("onboard", EDGE_ARGV, { env: scenario.env(scenario.appCredentials()), cwd: scenario.workspace.dir });
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.onboardedProjects, ["edge-ok", "node-app"]);
    assert.ok(report.compiledWorkflows.includes(".github/workflows/cascade-ai-node-app.lock.yml"));
    assert.equal(run.stdout, `${JSON.stringify(report, null, 2)}\n`);
    const changed = scenario.workspace.status().split("\n").filter(Boolean).map((line) => line.slice(3));
    assert.ok(changed.includes("sdlc.yaml") && changed.includes("instructions/node-app.md"));
    for (const file of changed) assert.ok(file === "sdlc.yaml" || file.startsWith("instructions/") || file.startsWith(".github/"), `unexpected change: ${file}`);
    const outside = run.trace.filter((event) => event.type === "write" && !path.resolve(event.path).toLowerCase().startsWith(path.resolve(scenario.workspace.root).toLowerCase()) && !/sdlc-s5-trace/.test(event.path));
    assert.deepEqual(outside, [], "no write outside the working copy");
    assert.equal(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").length, 1);
    assert.deepEqual(scenario.fake.nonGet().map((entry) => entry.method), ["POST"]);
  } finally {
    await scenario.cleanup();
  }
});

test("the real bin/sdlc-bootstrap.mjs process with the real S1: exit 0, one JSON document, sdlc.yaml untouched and only .github/workflows changed", async () => {
  const scenario = await createScenario();
  try {
    scenario.workspace.commitAll("baseline");
    const run = await runCli("bootstrap", ["--non-interactive"], { env: scenario.env(scenario.appCredentials()), cwd: scenario.workspace.dir });
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.doctorStatus, "pass");
    assert.ok(report.compiledWorkflows.length >= 3);
    assert.deepEqual(report.onboardedProjects, []);
    const changed = scenario.workspace.status().split("\n").filter(Boolean).map((line) => line.slice(3));
    assert.ok(changed.length > 0);
    for (const file of changed) assert.ok(file.startsWith(".github/"), `bootstrap changed ${file}`);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
  } finally {
    await scenario.cleanup();
  }
});
