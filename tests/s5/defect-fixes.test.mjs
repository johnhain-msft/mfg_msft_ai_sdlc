// The edges of the fixes of the QA defects R1-R7 (AC11, AC45, AC49, AC50, AC51), beyond the cases that qa-defects.regression.mjs
// reproduces: how far a fix reaches, and what it must still let through. Every fixture is local or in memory; the credentials
// below are assembled at run time, so that no literal credential is in this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findCommitPointer } from "../../bin/lib/inspect-repo.mjs";
import {
  GENERATED_MARKER,
  assertNoCredentials,
  assertNoCredentialsIn,
  composeInstructions,
  operatorTextOf,
  readOperatorInstructions,
} from "../../bin/lib/instructions-file.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { runManifestFlow } from "../../bin/lib/manifest-flow.mjs";
import { Capture, createScenario, fixtureRepos } from "./helpers/harness.mjs";
import { loopback } from "./helpers/loopback-client.mjs";

const SHA = "2".repeat(40);
const OTHER_SHA = "3".repeat(40);
const TOKEN = ["github", "pat", "A1b2C3d4E5f6G7h8I9j0".repeat(3)].join("_");
const SECRET = "OnlyAlphabeticSyntheticSecret";
const GENERATED = `${GENERATED_MARKER}\n## Detected repository facts\n\nRepository \`example-owner/node-app\`, default branch \`main\`.`;

const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });
const repos = () => fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
const runOnboard = (scenario, args) => scenario.onboard(args, { env: scenario.env(scenario.appCredentials()), runGh: fastGh });

function withTree(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-defect-fixes-"));
  try {
    return callback(root, (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- R1 (AC45, AC49): a provenance commit key inside an array -------------------------------------------------------------------

test("R1 AC45: the commit key is found shallowest first through objects and arrays, in document order within a level", () => {
  assert.deepEqual(findCommitPointer({ a: { b: { commit: SHA } }, sources: [{ commit: OTHER_SHA }] }), { commit: SHA, pointer: "/a/b/commit" });
  assert.deepEqual(findCommitPointer({ sources: [{ commit: SHA }], a: { b: { commit: OTHER_SHA } } }), { commit: SHA, pointer: "/sources/0/commit" });
  assert.deepEqual(findCommitPointer({ sources: [{ commit: OTHER_SHA }], commit: SHA }), { commit: SHA, pointer: "/commit" }, "a top-level key is shallower than any element");
  assert.deepEqual(findCommitPointer({ items: [{ commit: "abc" }, { name: "x" }, { commit: SHA }] }), { commit: SHA, pointer: "/items/2/commit" }, "a value that is no 40-hex SHA is skipped");
  assert.deepEqual(findCommitPointer([[{ commit: SHA }]]), { commit: SHA, pointer: "/0/0/commit" });
});

test("R1 AC45: scalars, empty containers and arrays without a commit key hold no pointer", () => {
  for (const value of [null, 5, "x", true, [], {}, [1, "x", null, [], [[]], {}], { a: [{ b: [] }] }]) assert.equal(findCommitPointer(value), null, JSON.stringify(value));
});

test("R1 AC45: a very large or very deep document is walked without stalling or overflowing the stack", () => {
  const started = process.hrtime.bigint();
  assert.equal(findCommitPointer(new Array(300000).fill(0)), null);
  const crowded = Array.from({ length: 150000 }, (_, index) => ({ n: index }));
  crowded.push({ commit: SHA });
  assert.deepEqual(findCommitPointer(crowded), { commit: SHA, pointer: "/150000/commit" });
  let deep = { commit: SHA };
  for (let level = 0; level < 20000; level += 1) deep = [deep];
  assert.equal(findCommitPointer(deep).commit, SHA);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 20, "a quadratic walk of the queue would take minutes");
});

// --- R2 (AC50): .env* and credentials/ ----------------------------------------------------------------------------------------

for (const relative of [".ENV", ".Envrc", ".env-local", ".environment", "config/.envrc", "Credentials/notes.md", "credentials/notes.md", "a/credentials/b/notes.md"]) {
  test(`R2 AC50: ${relative} is refused by its name or its directory, with nothing echoed`, () => {
    withTree((root, put) => {
      put(relative, "Keep the docs current.\n");
      assert.throws(
        () => readOperatorInstructions(relative, root),
        (error) => error.code === "instructions-secret-file" && /Nothing was written/.test(error.message) && !error.message.includes("Keep the docs current"),
      );
    });
  });
}

for (const relative of ["env.md", "docs/environment.md", "docs/dotenv.md", "docs/credentials-guide.md", "docs/credential-rotation.md"]) {
  test(`R2 AC50: ${relative} is an ordinary file and is still copied`, () => {
    withTree((root, put) => {
      put(relative, "Keep the docs current.\n");
      assert.deepEqual(readOperatorInstructions(relative, root), { text: "Keep the docs current.\n", literal: "" });
    });
  });
}

// --- R3 (AC50): an assigned secret without a digit ------------------------------------------------------------------------------

for (const text of [
  `PASSWORD=${SECRET}`,
  `password: ${SECRET}`,
  `export SECRET="${SECRET}"`,
  `{ "api_key": "${SECRET}" }`,
  "CLIENT_SECRET = Abcdefghijkl",
  "GH_TOKEN='abcdefghijklmnop'",
  "db_password=correct-horse-battery-staple",
  `settings:\n  token: ${SECRET}\n`,
]) {
  test(`R3 AC50: ${JSON.stringify(text.slice(0, 48))} is refused, without echoing the value`, () => {
    assert.throws(() => assertNoCredentials(text, "--instructions"), (error) => error.code === "instructions-credential" && !error.message.includes(SECRET));
  });
}

for (const text of [
  "token_count=1234567890123",
  "PASSWORD=",
  "PASSWORD=short",
  "PASSWORD=elevenchars",
  "API_KEY=<your key here>",
  "password: ${DB_PASSWORD}",
  "api_key: %API_KEY%",
  "PASSWORD=*****************",
  "The password reset flow is described in docs/password-reset.md.",
]) {
  test(`R3 AC50: ${JSON.stringify(text.slice(0, 48))} is still ordinary text (a number, a reference, a mask or a short value)`, () => {
    assert.doesNotThrow(() => assertNoCredentials(text, "--instructions"));
  });
}

// --- R4 (AC50): bytes that are not UTF-8 text -------------------------------------------------------------------------------------

for (const [label, bytes] of [
  ["a lead byte with no continuation", [0xff, 0xfe, 0x81, 0x82, 0x83]],
  ["a multi-byte sequence cut short at the end", [0x68, 0x69, 0x20, 0xe6, 0x97]],
  ["an overlong encoding", [0xc0, 0xaf]],
  ["an encoded surrogate", [0xed, 0xa0, 0x80]],
  ["a NUL byte in valid UTF-8", [0x61, 0x00, 0x62]],
]) {
  test(`R4 AC50: a file with ${label} is refused as not text`, () => {
    withTree((root, put) => {
      put("notes.md", Buffer.from(bytes));
      assert.throws(() => readOperatorInstructions("notes.md", root), (error) => error.code === "instructions-binary" && /is not a text file; nothing was written/.test(error.message));
    });
  });
}

test("R4 AC50: valid UTF-8 is copied byte for byte: non-ASCII text, an empty file and a leading byte order mark", () => {
  withTree((root, put) => {
    for (const bytes of [Buffer.from("日本語 — café\r\nno last newline"), Buffer.alloc(0), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Notes\r\n")])]) {
      put("notes.md", bytes);
      const read = readOperatorInstructions("notes.md", root);
      assert.ok(Buffer.from(read.text, "utf8").equals(bytes), JSON.stringify(read.text));
      assert.equal(read.literal, "");
    }
  });
});

// --- R5 (AC50): what the inspection finds is held to the same guard ----------------------------------------------------------------

test("R5 AC50: assertNoCredentialsIn looks at every string of nested objects and arrays and ignores everything else, and names only its label", () => {
  assert.doesNotThrow(() => assertNoCredentialsIn([undefined, null, 5, true, { a: ["package.json", { b: "npm test" }] }], "the entries"));
  for (const value of [`public/${TOKEN}/source.json`, [`x/${TOKEN}`], { a: [{ b: [TOKEN] }] }]) {
    assert.throws(
      () => assertNoCredentialsIn(value, "the entries of sdlc.yaml that this run writes"),
      (error) => error.code === "instructions-credential" && error.message.startsWith("the entries of sdlc.yaml that this run writes appears to contain a credential") && !error.message.includes(TOKEN),
    );
  }
});

/** Runs the onboarding of node-app over `repositories` and expects a refusal that wrote nothing and echoed nothing. */
async function expectRefusedFacts(repositories, args = []) {
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const before = scenario.workspace.read("sdlc.yaml");
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app", ...args]);
    assert.notEqual(run.code, 0, run.stdout);
    assert.match(run.stderr, /appears to contain a credential/);
    assert.equal(`${run.stdout}${run.stderr}`.includes(TOKEN), false, "the credential is not echoed, not even by a warning");
    assert.equal(scenario.workspace.read("sdlc.yaml"), before);
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.deepEqual(scenario.fake.nonGet(), []);
  } finally {
    await scenario.cleanup();
  }
}

test("R5 AC50: a provenance path with a credential is refused before the warning about its invalid JSON can print it", async () => {
  const repositories = repos();
  repositories["example-owner/node-app"].files[`public/${TOKEN}/source.json`] = "{ not json";
  await expectRefusedFacts(repositories);
});

test("R5 AC50: the downstream repository is held to the guard too: a provenance path, a manifest path and a key of the provenance file", async () => {
  for (const change of [
    (files) => {
      delete files["public/imported/source.json"];
      files[`public/${TOKEN}/source.json`] = JSON.stringify({ commit: SHA });
    },
    (files) => {
      files[`${TOKEN}/package.json`] = "{}";
    },
    (files) => {
      files["public/imported/source.json"] = JSON.stringify({ [TOKEN]: { commit: SHA } });
    },
  ]) {
    const repositories = repos();
    change(repositories["example-owner/edge-ok"].files);
    await expectRefusedFacts(repositories, ["--downstream", "example-owner/edge-ok"]);
  }
});

test("R5 AC50: a --watch-url that carries a credential does not reach sdlc.yaml", async () => {
  await expectRefusedFacts(repos(), ["--watch-url", `https://example.com/hooks/${TOKEN}`]);
});

test("R5 AC50: the path of a workflow without a schedule is neither printed nor written, so it does not refuse the run", async () => {
  const repositories = repos();
  repositories["example-owner/node-app"].files[`.github/workflows/${TOKEN}.yml`] = "on:\n  push:\n";
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app"]);
    assert.equal(run.code, 0, run.stderr);
    for (const written of [scenario.workspace.read("sdlc.yaml"), scenario.workspace.read("instructions/node-app.md"), run.stdout, run.stderr]) assert.equal(written.includes(TOKEN), false);
  } finally {
    await scenario.cleanup();
  }
});

test("R5 AC50: an instructions file that already holds a credential is refused when it would be rewritten, and is left as it is", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    assert.equal((await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", "Keep docs current"])).code, 0);
    scenario.workspace.write("instructions/node-app.md", scenario.workspace.read("instructions/node-app.md").replace("Keep docs current", `PASSWORD=${SECRET}`));
    const edited = scenario.workspace.read("instructions/node-app.md");
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app"]);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /^error: the instructions file instructions\/node-app\.md appears to contain a credential/m);
    assert.equal(`${run.stdout}${run.stderr}`.includes(SECRET), false);
    assert.equal(scenario.workspace.read("instructions/node-app.md"), edited);
  } finally {
    await scenario.cleanup();
  }
});

// --- R6 (AC51): the boundary of the generated section ---------------------------------------------------------------------------

test("R6 AC51: only the last marker line that is followed by the section heading starts the generated section", () => {
  const quoted = `Document the section like this:\n${GENERATED_MARKER}\n## Detected repository facts\nand keep this paragraph.`;
  const file = composeInstructions(quoted, GENERATED);
  assert.equal(operatorTextOf(file), quoted, "a quotation of the whole boundary inside the operator's text is the operator's text");
  assert.equal(composeInstructions(operatorTextOf(file), GENERATED), file);
  const markerOnly = `Use the marker ${GENERATED_MARKER} inline,\n${GENERATED_MARKER}\nand on its own line.`;
  assert.equal(operatorTextOf(composeInstructions(markerOnly, GENERATED)), markerOnly);
  assert.equal(operatorTextOf(`${GENERATED}\n`), "", "a file that starts with the section has no operator text");
});

test("R6 AC51: a file without the boundary is the operator's text as a whole", () => {
  for (const text of [
    "plain operator text\nmore\n",
    `inline ${GENERATED_MARKER} marker\nmore`,
    `${GENERATED_MARKER}\n## Detected repository facts and more\nrest`,
    `${GENERATED_MARKER}\n\n## Detected repository facts`,
    "",
  ]) {
    assert.equal(operatorTextOf(text), text, JSON.stringify(text));
  }
});

test("R6 AC51: a CRLF checkout of the file (core.autocrlf) still has its generated section found", () => {
  const operator = operatorTextOf(composeInstructions("Operator text", GENERATED).replace(/\n/g, "\r\n"));
  assert.ok(operator.startsWith("Operator text"), JSON.stringify(operator));
  assert.equal(operator.includes("Detected repository facts"), false, "the generated section is not taken for operator text");
});

test("R6 AC51: the letter case of the marker and of the heading is not significant", () => {
  assert.equal(operatorTextOf("Operator text\n\n<!-- SDLC-ONBOARD:GENERATED -->\n## Detected Repository Facts\n\nan older section\n"), "Operator text");
});

test("R6 AC51: re-onboarding a CRLF checkout keeps the operator's text and does not duplicate the generated section", async () => {
  const scenario = await createScenario({ fake: { repos: repos() } });
  try {
    assert.equal((await runOnboard(scenario, ["--repo", "example-owner/node-app", "--instructions", "Keep docs current"])).code, 0);
    scenario.workspace.write("instructions/node-app.md", scenario.workspace.read("instructions/node-app.md").replace(/\n/g, "\r\n"));
    const run = await runOnboard(scenario, ["--repo", "example-owner/node-app"]);
    assert.equal(run.code, 0, run.stderr);
    const text = scenario.workspace.read("instructions/node-app.md");
    assert.ok(text.startsWith("Keep docs current"), JSON.stringify(text.slice(0, 40)));
    assert.equal(text.split("## Detected repository facts").length - 1, 1, "one generated section");
  } finally {
    await scenario.cleanup();
  }
});

// --- R7 (AC11): the listener is closed whatever fails after it is bound ------------------------------------------------------------

/** Runs a manifest flow that fails after its listener is bound; the leaked listener of a broken flow is closed so that it cannot hang this process. */
async function failingFlow({ buildManifest, hooks }) {
  const createServer = http.createServer;
  let server;
  let port;
  http.createServer = (...args) => {
    server = createServer(...args);
    return server;
  };
  try {
    const settled = await runManifestFlow({
      buildManifest,
      registrationBase: "https://github.com/settings/apps/new",
      convert: async () => assert.fail("no code is exchanged"),
      openBrowser: async () => assert.fail("no browser is opened"),
      logger: createLogger(new Capture()),
      hooks: { onListening: (address) => { port = address.port; hooks?.onListening?.(address); } },
    }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    return { ...settled, refused: await loopback.refused(port) };
  } finally {
    http.createServer = createServer;
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

test("R7 AC11: the error of the manifest builder is the error of the flow, and the port is released", async () => {
  const failure = new Error("synthetic manifest failure");
  const outcome = await failingFlow({ buildManifest: () => { throw failure; } });
  assert.equal(outcome.error, failure);
  assert.equal(outcome.refused, true);
});

test("R7 AC11: the port is released when the listening hook fails as well", async () => {
  const failure = new Error("synthetic hook failure");
  const outcome = await failingFlow({ buildManifest: () => ({}), hooks: { onListening: () => { throw failure; } } });
  assert.equal(outcome.error, failure);
  assert.equal(outcome.refused, true);
});
