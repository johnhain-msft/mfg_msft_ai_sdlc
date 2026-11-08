// Regression tests for the S5 defects R1-R7 that executable QA found (AC11, AC45, AC49, AC50 and AC51); the product fixes are in.
// The suites run this file through qa-defects.regression.test.mjs (`npm test`, `node --test tests/s5/`), and it can run on its own:
// node --test tests/s5/qa-defects.regression.mjs (add --test-name-pattern='^R1 ' for one finding). Every fixture is local/in-memory.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import YAML from "yaml";
import { findCommitPointer } from "../../bin/lib/inspect-repo.mjs";
import { assertNoCredentials, readOperatorInstructions } from "../../bin/lib/instructions-file.mjs";
import { runManifestFlow } from "../../bin/lib/manifest-flow.mjs";
import { Capture, createScenario, createWorkspace, fixtureRepos, recordFsWrites } from "./helpers/harness.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { loopback } from "./helpers/loopback-client.mjs";

const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });
const repos = () => fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const runOnboard = (scenario, args) => scenario.onboard(args, { env: scenario.env(scenario.appCredentials()), runGh: fastGh });

test("R1 AC45/AC49: provenance commit keys in JSON arrays have a valid JSON Pointer", () => {
  const sha = "2".repeat(40);
  assert.deepEqual(findCommitPointer({ sources: [{ commit: sha }] }), { commit: sha, pointer: "/sources/0/commit" });
  assert.deepEqual(findCommitPointer([{ commit: sha }]), { commit: sha, pointer: "/0/commit" });
  assert.deepEqual(findCommitPointer({ "a/b": [[{ "c~d": { commit: sha } }]] }), { commit: sha, pointer: "/a~1b/0/0/c~0d/commit" });
});

test("R1 AC49: an otherwise valid downstream with array provenance onboards and seeds the recorded baseline", async () => {
  const repositories = repos();
  const sha = "2".repeat(40);
  repositories["example-owner/edge-ok"].files["public/imported/source.json"] = JSON.stringify({ sources: [{ commit: sha }] });
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"]);
    assert.equal(run.code, 0, run.stderr);
    const edge = YAML.parse(scenario.workspace.read("sdlc.yaml")).dependencyEdges.find((entry) => entry.edgeId === "node-app");
    assert.equal(edge.provenanceJsonPointer, "/sources/0/commit");
    assert.equal(edge.initialBaselineSha, sha);
    assert.equal(JSON.parse(scenario.fake.variablesOf("example-owner/example-repo").SDLC_SYNC_STATE_NODE_APP).lastMergedUpstreamSha, sha);
    assert.equal(scenario.reconcile.calls.length, 1);
  } finally {
    await scenario.cleanup();
  }
});

test("R2 AC50: .env* files and a credentials directory are refused even when their content looks harmless", () => {
  const workspace = createWorkspace();
  try {
    const names = [".envrc", ".env-local", ".environment", ".env.production", "credentials/notes.md"];
    const refused = [];
    for (const name of names) {
      workspace.write(name, "Keep the docs current.\n");
      try {
        readOperatorInstructions(name, workspace.dir);
      } catch (error) {
        assert.equal(error.code, "instructions-secret-file", name);
        refused.push(name);
      }
    }
    assert.deepEqual(refused, names, "all secret-looking file and directory names must be blocked");
  } finally {
    workspace.cleanup();
  }
});

test("R2 AC50: the CLI refuses .envrc before writing sdlc.yaml or instructions", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    scenario.workspace.write(".envrc", "Keep the docs current.\n");
    const before = scenario.workspace.read("sdlc.yaml");
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", ".envrc"]);
    assert.notEqual(run.code, 0, "a .env* file is a secret file by name, regardless of its contents");
    assert.equal(scenario.workspace.read("sdlc.yaml"), before);
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.deepEqual(scenario.fake.nonGet(), []);
  } finally {
    await scenario.cleanup();
  }
});

test("R3 AC50: secret-looking assignments are refused even if the secret contains no digit", () => {
  for (const name of ["PASSWORD", "API_KEY", "SERVICE_TOKEN", "CLIENT_SECRET"]) {
    const value = `${name}=${"OnlyAlphabeticSyntheticSecret"}`;
    assert.throws(() => assertNoCredentials(value, "--instructions"), (error) => error.code === "instructions-credential", name);
  }
});

test("R3 AC50: a literal alphabetic password is not persisted in the instructions or manifest", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  const value = "OnlyAlphabeticSyntheticSecret";
  try {
    const before = scenario.workspace.read("sdlc.yaml");
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", `PASSWORD=${value}`]);
    assert.notEqual(run.code, 0, "the secret-looking assignment must be rejected before writing");
    assert.equal(scenario.workspace.read("sdlc.yaml"), before);
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.equal(run.stdout.includes(value) || run.stderr.includes(value), false);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("R4 AC50: a non-text file is refused without silently replacing invalid UTF-8 bytes", () => {
  const workspace = createWorkspace();
  try {
    fs.writeFileSync(workspace.path("notes.bin"), Buffer.from([0xff, 0xfe, 0x81, 0x82, 0x83]));
    assert.throws(() => readOperatorInstructions("notes.bin", workspace.dir), (error) => error.code === "instructions-binary");
  } finally {
    workspace.cleanup();
  }
});

test("R4 AC50: the CLI rejects a non-text instructions file instead of persisting replacement characters", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    fs.writeFileSync(scenario.workspace.path("notes.bin"), Buffer.from([0xff, 0xfe, 0x81, 0x82, 0x83]));
    const before = scenario.workspace.read("sdlc.yaml");
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", "notes.bin"]);
    assert.notEqual(run.code, 0, "a non-text file must be rejected before writing repository files");
    assert.equal(scenario.workspace.read("sdlc.yaml"), before);
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

for (const [kind, relative, content] of [
  ["manifest", (token) => `${token}/package.json`, "{}"],
  ["scheduled workflow", (token) => `.github/workflows/${token}.yml`, "on:\n  schedule:\n    - cron: '0 5 * * 0'\n"],
  ["provenance", (token) => `public/${token}/source.json`, JSON.stringify({ commit: "2".repeat(40) })],
]) {
  test(`R5 AC50/AC29: credentials in detected ${kind} paths do not reach generated repository files`, async () => {
    const token = ["github", "pat", "A1b2C3d4E5f6G7h8I9j0".repeat(3)].join("_");
    const repositories = repos();
    repositories["example-owner/node-app"].files[relative(token)] = content;
    const scenario = await createScenario({ fake: { repos: repositories } });
    try {
      const before = scenario.workspace.read("sdlc.yaml");
      const { result: run, writes } = await recordFsWrites(() => runOnboard(scenario, ["--repo", "example-owner/node-app"]));
      const written = [scenario.workspace.read("sdlc.yaml")];
      if (scenario.workspace.exists("instructions/node-app.md")) written.push(scenario.workspace.read("instructions/node-app.md"));
      assert.notEqual(run.code, 0, "a credential must cause refusal, not merely disappear from generated facts");
      assert.match(run.stderr, /appears to contain a credential/);
      assert.deepEqual(writes, [], "refusal must precede even a temporary output write");
      assert.equal(scenario.workspace.read("sdlc.yaml"), before);
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.equal(scenario.reconcile.calls.length, 0);
      assert.deepEqual(scenario.fake.nonGet(), []);
      assert.equal(written.some((text) => text.includes(token)), false, "generated facts must pass the same credential guard as operator text");
      assert.equal(run.stdout.includes(token) || run.stderr.includes(token), false);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("R6 AC51: an operator's literal generated-marker example survives re-onboarding without --instructions", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  const text = "Document this marker:\n<!-- sdlc-onboard:generated -->\nKeep this operator paragraph.";
  try {
    const first = await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", text]);
    assert.equal(first.code, 0, first.stderr);
    const manifest = scenario.workspace.read("sdlc.yaml");
    const instructions = scenario.workspace.read("instructions/node-app.md");
    const second = await runOnboard(scenario, ["--repo", "example-owner/node-app"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(scenario.workspace.read("sdlc.yaml"), manifest, "the unrequested project fields stay as they were");
    assert.equal(scenario.workspace.read("instructions/node-app.md"), instructions, "no operator paragraph is truncated");
  } finally {
    await scenario.cleanup();
  }
});

test("R7 AC11: a manifest-builder failure closes the already-bound listener before rejecting", async () => {
  // The real builder reads app-permissions.json; a read/parse failure must not leave the CLI's server alive.
  // Capture the actual server solely so this RED reproducer can clean up the implementation's leaked listener.
  const createServer = http.createServer;
  let server;
  let port;
  let conversions = 0;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  try {
    await assert.rejects(runManifestFlow({
      buildManifest: () => { throw new Error("synthetic permission-map read failure"); },
      registrationBase: "https://github.com/settings/apps/new",
      convert: async () => { conversions += 1; },
      openBrowser: async () => {},
      logger: createLogger(new Capture()),
      hooks: { onListening: (address) => { port = address.port; } },
    }), /synthetic permission-map read failure/);
    assert.equal(conversions, 0);
    assert.equal(await loopback.refused(port), true, "every failing exit path must release the loopback port");
  } finally {
    http.createServer = createServer;
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
