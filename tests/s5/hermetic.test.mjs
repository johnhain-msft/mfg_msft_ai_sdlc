// AC55: the S5 suites are hermetic. The no-network guard refuses any non-loopback connection, the fake GitHub
// records every request and only ever sees requests addressed to itself, and a complete scenario leaves no
// request that it did not declare.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { blockedAttempts, installNoNetwork, uninstallNoNetwork } from "./helpers/no-network.mjs";
import { assertOnlyDeclared, cleanEnv, createScenario } from "./helpers/harness.mjs";
import { suiteUndeclaredRequests } from "./helpers/fake-github.mjs";

test("AC55: the no-network guard rejects a connection to a non-loopback address", async () => {
  const before = blockedAttempts.length;
  assert.throws(() => net.connect({ host: "203.0.113.7", port: 443 }), /no-network guard/);
  assert.throws(() => net.connect(443, "api.github.com"), /no-network guard/);
  await assert.rejects(fetch("https://api.github.com/app"), (error) => /fetch failed/.test(error.message));
  assert.ok(blockedAttempts.length >= before + 3, "every attempt is recorded");
  assert.equal(blockedAttempts.at(-1).host, "api.github.com");
});

test("AC55: loopback connections stay open, and the guard can be lifted and restored", async () => {
  const server = net.createServer((socket) => socket.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {});
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.once("error", reject);
  });
  assert.equal(received, "ok");
  uninstallNoNetwork();
  installNoNetwork();
  assert.throws(() => net.connect({ host: "198.51.100.9", port: 80 }), /no-network guard/);
  await new Promise((resolve) => server.close(resolve));
});

test("AC55: a complete scenario runs with no GitHub credential in the environment and every request goes to the fake", async () => {
  assert.equal(cleanEnv().GH_TOKEN, undefined);
  assert.equal(cleanEnv().APP_PRIVATE_KEY, undefined);
  const scenario = await createScenario();
  try {
    const before = blockedAttempts.length;
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(scenario.fake.log.length > 0);
    for (const entry of scenario.fake.log) assert.equal(entry.host, scenario.fake.host, "no recorded request targets a host other than the fake");
    assert.equal(blockedAttempts.length, before, "nothing tried to leave the machine");
    assertOnlyDeclared(scenario.fake, [
      "GET /app",
      "GET /app/installations",
      "PATCH /repos/:owner/:repo/actions/variables/:name",
      "POST /repos/:owner/:repo/actions/variables",
      "GET /repos/:owner/:repo/actions/variables/:name",
      "GET /repos/:owner/:repo/actions/secrets/public-key",
      "PUT /repos/:owner/:repo/actions/secrets/:name",
    ]);
    assert.deepEqual(scenario.fake.log.filter((entry) => entry.unhandled), [], "the fake answered no unhandled route");
  } finally {
    await scenario.cleanup();
  }
});

test("AC55: a request outside the declared routes is caught by the undeclared-request check and by the closing check of the suite", async () => {
  const scenario = await createScenario();
  try {
    await fetch(`${scenario.fake.url}/surprise`);
    assert.throws(() => assertOnlyDeclared(scenario.fake, ["GET /app"]), /did not declare/);
    assert.equal(scenario.fake.log.at(-1).unhandled, true);
    assert.ok(suiteUndeclaredRequests().some((line) => line.includes("GET /surprise")), "the closing check of the suite reports it");
    scenario.fake.clearLog(); // deliberate: this scenario must not fail the closing check of this suite
    assert.deepEqual(suiteUndeclaredRequests(), []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC55: a scenario that narrows its declared routes has an undeclared request reported by the closing check", async () => {
  const scenario = await createScenario({ fake: { declared: ["GET /app"] } });
  try {
    await fetch(`${scenario.fake.url}/users/example-owner`);
    assert.deepEqual(suiteUndeclaredRequests().filter((line) => line.includes("/users/example-owner")).length, 1);
    scenario.fake.clearLog();
  } finally {
    await scenario.cleanup();
  }
});
