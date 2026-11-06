// AC55: the S5 suites are hermetic. The no-network guard refuses any non-loopback connection, the fake GitHub
// records every request and only ever sees requests addressed to itself, and a complete scenario leaves no
// request that it did not declare. The in-process scenarios also reach the fake GitHub in memory: a loopback TCP
// connect can kill a Windows process on Node.js 24.0 to 24.15 (see tests/s5/helpers/no-network.mjs), and the node test
// runner once reported this very file as failed, with all its subtests missing, in one full run out of a few.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { blockedAttempts, guardConnect, installNoNetwork, tcpConnects, uninstallNoNetwork } from "./helpers/no-network.mjs";
import { assertOnlyDeclared, cleanEnv, createScenario, fixtureRepos } from "./helpers/harness.mjs";
import { suiteUndeclaredRequests } from "./helpers/fake-github.mjs";

test("AC55: the no-network guard rejects a connection to a non-loopback address", async () => {
  const before = blockedAttempts.length;
  assert.throws(() => net.connect({ host: "203.0.113.7", port: 443 }), /no-network guard/);
  assert.throws(() => net.connect(443, "api.github.com"), /no-network guard/);
  await assert.rejects(fetch("https://api.github.com/app"), (error) => /fetch failed/.test(error.message));
  assert.ok(blockedAttempts.length >= before + 3, "every attempt is recorded");
  assert.equal(blockedAttempts.at(-1).host, "api.github.com");
});

test("AC55: the guard hands loopback TCP targets and local IPC to the real connect and refuses every other target before it", async () => {
  // The decision is exercised on a recording stand-in for `connect`, so this test opens no TCP socket (see no-network.mjs);
  // a real loopback connect through the installed guard is exercised by the manifest-flow and the child-process suites.
  const forwarded = [];
  const guarded = guardConnect(function recordingConnect(...args) {
    forwarded.push(args);
    return this;
  });
  const socket = {};
  const before = tcpConnects.length;
  const loopback = [
    [[{ host: "127.0.0.1", port: 8080 }, () => {}]], // what net.connect() hands over: [options, callback]
    [[{ host: "::1", port: 8080 }]],
    [[{ host: "[::1]", port: 8080 }]],
    [[{ host: "LocalHost", port: 8080 }]],
    [[{ port: 8080 }]],
    [{ host: "127.0.0.1", port: 8080 }], // socket.connect(options)
    [8080, "127.0.0.1"], // socket.connect(port, host)
    [8080], // socket.connect(port)
  ];
  for (const args of loopback) assert.equal(guarded.apply(socket, args), socket, JSON.stringify(args));
  assert.equal(forwarded.length, loopback.length, "every loopback TCP target reached the real connect");
  assert.equal(tcpConnects.length, before + loopback.length, "and was recorded as a TCP connect");

  const ipc = [[[{ path: "\\\\.\\pipe\\example" }]], [[{ path: "/tmp/example.sock" }]], ["/tmp/example.sock"]];
  for (const args of ipc) assert.equal(guarded.apply(socket, args), socket, JSON.stringify(args));
  assert.equal(forwarded.length, loopback.length + ipc.length, "local IPC reached the real connect");
  assert.equal(tcpConnects.length, before + loopback.length, "but it is not a TCP connect");

  const refusedBefore = blockedAttempts.length;
  const outside = [[[{ host: "203.0.113.7", port: 443 }]], [[{ host: "api.github.com", port: 443 }]], [443, "api.github.com"], [[{ host: "198.51.100.9", port: 80 }, () => {}]]];
  for (const args of outside) assert.throws(() => guarded.apply(socket, args), (error) => error.code === "ENONETWORK" && /no-network guard/.test(error.message), JSON.stringify(args));
  assert.equal(forwarded.length, loopback.length + ipc.length, "a refused target never reached the real connect");
  assert.equal(blockedAttempts.length, refusedBefore + outside.length, "every refusal is recorded");
  assert.equal(tcpConnects.length, before + loopback.length, "and none is counted as a connect");
  tcpConnects.splice(before); // deliberate: these records came from a stand-in connect, and the closing check of the suite asserts that this process connected to nothing

  // The installed guard can be lifted and restored, and local IPC (a named pipe, a socket file) passes through it.
  const installedGuard = net.Socket.prototype.connect;
  uninstallNoNetwork();
  assert.notEqual(net.Socket.prototype.connect, installedGuard, "lifting the guard puts the real connect back");
  installNoNetwork();
  assert.throws(() => net.connect({ host: "198.51.100.9", port: 80 }), /no-network guard/);
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const address = process.platform === "win32" ? `\\\\.\\pipe\\sdlc-s5-hermetic-${suffix}` : path.join(os.tmpdir(), `sdlc-s5-hermetic-${suffix}.sock`);
  const server = net.createServer((connection) => connection.end("ok"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  try {
    const received = await new Promise((resolve, reject) => {
      const client = net.connect({ path: address });
      client.once("data", (chunk) => resolve(String(chunk)));
      client.once("error", reject);
    });
    assert.equal(received, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test("AC55: an in-process bootstrap and onboarding reach the fake GitHub in memory: neither opens a TCP connection", async () => {
  // A TCP connect can kill the process silently on Windows with Node.js 24.0 to 24.15 (exit code 3221226505, see
  // tests/s5/helpers/no-network.mjs), and a run that needs none must not make one, or a test file dies at random under load.
  const bootstrapScenario = await createScenario();
  const onboardScenario = await createScenario({ fake: { repos: fixtureRepos({ "example-owner/node-app": "node-app" }) } });
  try {
    const before = tcpConnects.length;
    const bootstrap = await bootstrapScenario.bootstrap([], { env: bootstrapScenario.env(bootstrapScenario.appCredentials()) });
    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    const onboard = await onboardScenario.onboard(["--repo", "example-owner/node-app"], { env: onboardScenario.env(onboardScenario.appCredentials()) });
    assert.equal(onboard.code, 0, onboard.stderr);
    assert.ok(bootstrapScenario.fake.log.length > 0, "the bootstrap was answered by its fake");
    assert.ok(onboardScenario.fake.requests("GET /repos/:owner/:repo/contents/*").length > 0, "the onboarding read the target repository from its fake");
    assert.deepEqual(tcpConnects.slice(before), [], "no TCP connect was made");
  } finally {
    await bootstrapScenario.cleanup();
    await onboardScenario.cleanup();
  }
});

test("AC55: a request outside the declared routes is caught by the undeclared-request check and by the closing check of the suite", async () => {
  const scenario = await createScenario();
  try {
    await scenario.fake.fetch(`${scenario.fake.url}/surprise`);
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
    await scenario.fake.fetch(`${scenario.fake.url}/users/example-owner`);
    assert.deepEqual(suiteUndeclaredRequests().filter((line) => line.includes("/users/example-owner")).length, 1);
    scenario.fake.clearLog();
  } finally {
    await scenario.cleanup();
  }
});
