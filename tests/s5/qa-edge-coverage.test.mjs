// Executable QA of the S5 R1-R7 delta. Use real files, the real S1 reconciler and real loopback listeners;
// GitHub and gh-aw remain the suite's offline doubles. No product file is patched by these tests.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { findCommitPointer, inspectRepository, localReader } from "../../bin/lib/inspect-repo.mjs";
import { GENERATED_MARKER, operatorTextOf, readOperatorInstructions } from "../../bin/lib/instructions-file.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { runManifestFlow } from "../../bin/lib/manifest-flow.mjs";
import { reconcile } from "../../src/reconcile.mjs";
import {
  Capture,
  createScenario,
  createWorkspace,
  fixtureRepos,
  parseRegistrationPage,
  recordFsWrites,
  sha256Tree,
} from "./helpers/harness.mjs";
import { loopback } from "./helpers/loopback-client.mjs";

const SHA = "4".repeat(40);
const TOKEN = ["github", "pat", "A1b2C3d4E5f6G7h8I9j0".repeat(3)].join("_");
const SECRET = ["OnlyAlphabetic", "SyntheticSecret"].join("");
const repos = () => fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });
const onboard = (scenario, args, extra = {}) => scenario.onboard(args, { env: scenario.env(scenario.appCredentials()), runGh: fastGh, ...extra });

async function assertRefusedWithoutEffects(scenario, args, secret) {
  const before = sha256Tree(scenario.workspace.dir);
  const reconciles = scenario.reconcile.calls.length;
  const mutations = scenario.fake.nonGet().length;
  const { result: run, writes } = await recordFsWrites(() => onboard(scenario, args));
  assert.notEqual(run.code, 0, "unsafe input must be refused, including an otherwise-noop re-onboarding");
  assert.deepEqual(writes.map(({ op, path: file }) => ({ op, path: file })), [], "not even a temporary output file may be written");
  assert.equal(sha256Tree(scenario.workspace.dir), before, "all repository bytes remain unchanged");
  assert.equal(scenario.reconcile.calls.length, reconciles, "refusal precedes S1");
  assert.equal(scenario.fake.nonGet().length, mutations, "refusal precedes GitHub-side mutations");
  assert.equal(run.stdout, "");
  if (secret) assert.equal(run.stderr.includes(secret), false, "the diagnostic must not echo the credential");
  return run;
}

test("R1 QA delta: local inspection keeps physical array indices and empty/escaped object keys without writing", async () => {
  const document = { "/~": [null, 17, "text", false, {}, { "": [{ commit: SHA }] }] };
  const workspace = createWorkspace({ files: { "meta/source.json": JSON.stringify(document) } });
  try {
    const before = sha256Tree(workspace.dir);
    const { result, writes } = await recordFsWrites(() =>
      inspectRepository(localReader(workspace.dir), { repo: "example-owner/local", defaultBranch: "main", headSha: "a".repeat(40) }),
    );
    assert.deepEqual(result.provenanceFiles, [{ path: "meta/source.json", commit: SHA, pointer: "/~1~0/5//0/commit" }]);
    const value = result.provenanceFiles[0].pointer.slice(1).split("/").reduce((node, key) => node[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
    assert.equal(value, SHA, "the emitted RFC 6901 pointer actually addresses the recorded commit");
    assert.deepEqual(writes, []);
    assert.equal(sha256Tree(workspace.dir), before);
  } finally {
    workspace.cleanup();
  }
});

test("R1 QA delta: an escaped array pointer and recorded baseline pass real S1 and produce workflow artifacts", async () => {
  const repositories = repos();
  repositories["example-owner/edge-ok"].files["public/imported/source.json"] = JSON.stringify({ "sources/with~names": [false, { commit: SHA }] });
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const results = [];
    const run = await onboard(scenario, ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], {
      reconcile: async (request, options) => {
        const answer = await reconcile(request, options);
        results.push(answer);
        return answer;
      },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "ok", JSON.stringify(results[0].validationResults));
    assert.deepEqual(results[0].validationResults.filter((entry) => !entry.valid), []);
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    const edge = data.dependencyEdges.find((entry) => entry.edgeId === "node-app");
    assert.equal(edge.provenanceJsonPointer, "/sources~1with~0names/1/commit");
    assert.equal(edge.initialBaselineSha, SHA, "the recorded downstream SHA, not the upstream HEAD, seeds the edge");
    const state = JSON.parse(scenario.fake.variablesOf("example-owner/example-repo").SDLC_SYNC_STATE_NODE_APP);
    assert.equal(state.lastMergedUpstreamSha, SHA);
    assert.equal(state.lastObservedHeadSha, SHA);
    assert.equal(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").length, 1);
    assert.ok(results[0].generatedWorkflows.some((entry) => entry.sourceMd === ".github/workflows/cascade-ai-node-app.md"));
    for (const artifact of results[0].generatedWorkflows) {
      assert.equal(scenario.workspace.exists(artifact.sourceMd), true);
      assert.equal(scenario.workspace.exists(artifact.lockYml), true);
      assert.ok(scenario.workspace.read(artifact.lockYml).includes("# sha256:"), "the compiler actually wrote its output");
    }
  } finally {
    await scenario.cleanup();
  }
});

test("R1 QA delta: array provenance without a valid SHA cannot create an edge or seed state", async () => {
  const document = { sources: [null, { commit: "a".repeat(39) }, { commit: 42 }, { commit: "not-a-sha" }] };
  assert.equal(findCommitPointer(document), null);
  const repositories = repos();
  repositories["example-owner/edge-ok"].files["public/imported/source.json"] = JSON.stringify(document);
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const run = await assertRefusedWithoutEffects(scenario, ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"]);
    assert.match(run.stderr, /provenanceJsonPointer/);
  } finally {
    await scenario.cleanup();
  }
});

test("R2 QA delta: a neutral directory link into credentials is rejected before any output write", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    scenario.workspace.write("Credentials/notes.md", "These are ordinary-looking notes.\n");
    fs.symlinkSync(scenario.workspace.path("Credentials"), scenario.workspace.path("notes-link"), process.platform === "win32" ? "junction" : "dir");
    const run = await assertRefusedWithoutEffects(scenario, ["--repo", "example-owner/node-app", "--instructions", "notes-link/notes.md"]);
    assert.match(run.stderr, /names a file that is not copied/);
  } finally {
    await scenario.cleanup();
  }
});

test("R3 QA delta: an alphabetic assignment read from a file is refused without persisting or echoing it", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    scenario.workspace.write("notes/operator.md", `# Operator notes\r\nexport SERVICE_API_KEY="${SECRET}"\r\n`);
    const run = await assertRefusedWithoutEffects(scenario, ["--repo", "example-owner/node-app", "--instructions", "notes/operator.md"], SECRET);
    assert.match(run.stderr, /appears to contain a credential/);
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, invalid] of [
  ["a lone continuation byte", [0x80]],
  ["an invalid continuation after a lead byte", [0xe2, 0x28, 0xa1]],
  ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
]) {
  test(`R4 QA delta: ${label} after ordinary text is rejected rather than replacement-decoded`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-qa-utf8-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.concat([Buffer.from("# Safe prefix\n"), Buffer.from(invalid)]);
    fs.writeFileSync(path.join(directory, "notes.md"), bytes);
    assert.throws(() => readOperatorInstructions("notes.md", directory), (error) => error.code === "instructions-binary");
    assert.deepEqual(fs.readFileSync(path.join(directory, "notes.md")), bytes);
  });
}

test("R4 QA delta: a BOM, a legitimate replacement character and four-byte Unicode survive file onboarding and replay", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  const bytes = Buffer.from("\uFEFF# Notes\r\nA literal \uFFFD and a test tube \u{1F9EA}.\r\n");
  try {
    scenario.workspace.write("notes/operator.md", bytes);
    const run = await onboard(scenario, ["--repo", "example-owner/node-app", "--instructions", "notes/operator.md"]);
    assert.equal(run.code, 0, run.stderr);
    const instructions = fs.readFileSync(scenario.workspace.path("instructions/node-app.md"));
    assert.deepEqual(instructions.subarray(0, bytes.length), bytes, "valid bytes, including BOM and U+FFFD, are not stripped or normalized");
    assert.deepEqual(fs.readFileSync(scenario.workspace.path("notes/operator.md")), bytes);
    const project = YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((entry) => entry.projectKey === "node-app");
    assert.equal(project.driftAudit.instructions, "", "a source filename is not stored as literal instructions");
    assert.equal(project.driftAudit.instructionsFile, "instructions/node-app.md");
    assert.equal((await onboard(scenario, ["--repo", "example-owner/node-app"])).code, 0);
    assert.deepEqual(fs.readFileSync(scenario.workspace.path("instructions/node-app.md")), instructions);
  } finally {
    await scenario.cleanup();
  }
});

for (const [label, target, change, downstream] of [
  ["upstream default branch", "example-owner/node-app", (repo) => { repo.defaultBranch = TOKEN; }, false],
  ["downstream default branch", "example-owner/edge-ok", (repo) => { repo.defaultBranch = TOKEN; }, true],
  ["downstream scheduled workflow", "example-owner/edge-ok", (repo) => { repo.files[`.github/workflows/${TOKEN}.yml`] = "on:\n  schedule:\n    - cron: '0 5 * * 0'\n"; }, true],
  ["upstream array-provenance key", "example-owner/node-app", (repo) => { repo.files["source.json"] = JSON.stringify({ sources: [{ [TOKEN]: { commit: SHA } }] }); }, false],
]) {
  test(`R5 QA delta: a credential in the ${label} stops every file, state and S1 effect`, async () => {
    const repositories = repos();
    change(repositories[target]);
    const scenario = await createScenario({ fake: { repos: repositories } });
    try {
      const run = await assertRefusedWithoutEffects(scenario, ["--repo", "example-owner/node-app", ...(downstream ? ["--downstream", "example-owner/edge-ok"] : [])], TOKEN);
      assert.match(run.stderr, /appears to contain a credential/);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("R5 QA delta: retained operator credentials refuse even a noop re-onboarding before S1 or any write", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    assert.equal((await onboard(scenario, ["--repo", "example-owner/node-app", "--instructions", "Ordinary notes."])).code, 0);
    scenario.workspace.write("instructions/node-app.md", scenario.workspace.read("instructions/node-app.md").replace("Ordinary notes.", `PASSWORD=${SECRET}`));
    const run = await assertRefusedWithoutEffects(scenario, ["--repo", "example-owner/node-app"], SECRET);
    assert.match(run.stderr, /the instructions file instructions\/node-app\.md appears to contain a credential/);
  } finally {
    await scenario.cleanup();
  }
});

test("R6 QA delta: complete marker examples survive a facts refresh, and the next replay is byte-identical", async () => {
  const operator = [
    `An inline example ${GENERATED_MARKER} is prose.`,
    "",
    "```markdown",
    GENERATED_MARKER,
    "## Detected repository facts",
    "This paragraph still belongs to the operator.",
    "```",
    "",
    GENERATED_MARKER,
    "## Detected Repository Facts",
    "A second complete example is also operator text.",
  ].join("\n");
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    assert.equal((await onboard(scenario, ["--repo", "example-owner/node-app", "--instructions", operator])).code, 0);
    const manifest = scenario.workspace.read("sdlc.yaml");
    const before = scenario.workspace.read("instructions/node-app.md");
    scenario.fake.state.repos.get("example-owner/node-app").files["extras/pyproject.toml"] = "[project]\nname = 'extra'\n";
    const refreshed = await onboard(scenario, ["--repo", "example-owner/node-app"]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const after = scenario.workspace.read("instructions/node-app.md");
    assert.equal(operatorTextOf(after), operator, "the last generated boundary, not a quoted example, is removed");
    assert.ok(after.startsWith(`${operator}\n\n${GENERATED_MARKER}\n`));
    assert.equal(before.includes("extras/pyproject.toml"), false);
    assert.equal(after.includes("extras/pyproject.toml"), true, "facts are refreshed, not blindly copied from the old file");
    assert.equal(scenario.workspace.read("sdlc.yaml"), manifest);
    assert.equal((await onboard(scenario, ["--repo", "example-owner/node-app"])).code, 0);
    assert.equal(scenario.workspace.read("instructions/node-app.md"), after);
    assert.equal(scenario.workspace.read("sdlc.yaml"), manifest);
  } finally {
    await scenario.cleanup();
  }
});

async function withTrackedServers(t, callback) {
  const servers = [];
  const createServer = http.createServer;
  t.mock.method(http, "createServer", function (...args) {
    const server = createServer.apply(this, args);
    servers.push(server);
    return server;
  });
  try {
    return await callback(servers);
  } finally {
    for (const server of servers) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
}

test("R7 QA delta: a setup-logger failure releases the listener and removes its abort subscription", async (t) => {
  await withTrackedServers(t, async (servers) => {
    const controller = new AbortController();
    const failure = new Error("synthetic setup logger failure");
    let port;
    await assert.rejects(runManifestFlow({
      buildManifest: (redirectUrl) => ({ redirect_url: redirectUrl }),
      registrationBase: "https://github.com/settings/apps/new",
      convert: async () => assert.fail("a setup failure must not convert"),
      openBrowser: async () => assert.fail("a setup failure must not open the browser"),
      logger: { info: () => { throw failure; }, warn: () => {} },
      signal: controller.signal,
      hooks: { onListening: (address) => { port = address.port; } },
    }), (error) => error === failure);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].listening, false);
    assert.equal(await loopback.refused(port), true);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  });
});

test("R7 QA delta: a failing concurrent flow closes only its own port while its sibling completes once", { timeout: 30000 }, async (t) => {
  await withTrackedServers(t, async (servers) => {
    const controller = new AbortController();
    const conversions = [];
    const app = { id: 123 };
    let ready;
    const listening = new Promise((resolve) => { ready = resolve; });
    const successful = runManifestFlow({
      buildManifest: (redirectUrl) => ({ redirect_url: redirectUrl }),
      registrationBase: "https://github.com/settings/apps/new",
      convert: async (code) => { conversions.push(code); return app; },
      openBrowser: async () => {},
      logger: createLogger(new Capture()),
      env: { SDLC_BOOTSTRAP_NO_OPEN_BROWSER: "1" },
      signal: controller.signal,
      hooks: { onListening: ready },
    });
    successful.catch(() => {});
    try {
      const { port } = await listening;
      let failedPort;
      const failure = new Error("synthetic concurrent builder failure");
      await assert.rejects(runManifestFlow({
        buildManifest: () => { throw failure; },
        registrationBase: "https://github.com/settings/apps/new",
        convert: async () => assert.fail("the failed flow must not convert"),
        openBrowser: async () => assert.fail("the failed flow must not open the browser"),
        logger: createLogger(new Capture()),
        hooks: { onListening: (address) => { failedPort = address.port; } },
      }), (error) => error === failure);
      assert.equal(await loopback.refused(failedPort), true);
      assert.equal(await loopback.refused(port), false, "the other flow remains available");
      const page = parseRegistrationPage((await loopback.request(`http://127.0.0.1:${port}/register`)).text);
      const callback = await loopback.request(`${page.manifest.redirect_url}?code=one-valid-code&state=${page.state}`);
      assert.equal(callback.status, 200);
      assert.deepEqual(await successful, app);
      assert.deepEqual(conversions, ["one-valid-code"]);
      assert.equal(await loopback.refused(port), true);
      assert.equal(servers.every((server) => !server.listening), true);
      assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    } finally {
      controller.abort();
      await successful.catch(() => {});
    }
  });
});
