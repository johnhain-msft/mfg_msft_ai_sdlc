// AC11, AC12, AC14 and AC15: the loopback manifest flow. The listener is bound to 127.0.0.1 on an OS-assigned port, serves
// only /register and /callback, posts the manifest to GitHub, accepts one valid callback (a code of [A-Za-z0-9_-] and the
// per-run state), times out after ten minutes and is closed on every exit path.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { FLOW_TIMEOUT_MS, runManifestFlow } from "../../bin/lib/manifest-flow.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { Capture, createScenario, githubSideBrowser, parseRegistrationPage } from "./helpers/harness.mjs";

const USER_URL = "https://github.com/settings/apps/new";
const ORG_URL = "https://github.com/organizations/example-org/settings/apps/new";
const APP = { id: 7, slug: "flow-app", clientId: "Iv1.flow", pem: "-----BEGIN RSA PRIVATE KEY-----\nflow\n-----END RSA PRIVATE KEY-----\n", permissions: {} };

function startFlow({ registrationBase = USER_URL, env = {}, timeoutMs, signal } = {}) {
  const logs = new Capture();
  const conversions = [];
  const opened = [];
  let onListening;
  const ready = new Promise((resolve) => {
    onListening = resolve;
  });
  const promise = runManifestFlow({
    buildManifest: (redirectUrl) => ({ name: "flow", url: "https://github.com/o/r", redirect_url: redirectUrl, default_permissions: { contents: "write" } }),
    registrationBase,
    convert: async (code) => {
      conversions.push(code);
      return APP;
    },
    openBrowser: async (url) => {
      opened.push(url);
    },
    logger: createLogger(logs),
    env,
    timeoutMs,
    signal,
    hooks: { onListening },
  });
  promise.catch(() => {});
  return { promise, ready, conversions, opened, logs };
}

const get = (port, path, { method = "GET", host } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method, headers: host ? { Host: host } : {}, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });

const refused = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });

async function validCallback(port, state, code = "abc123_-XYZ") {
  return get(port, `/callback?code=${code}&state=${state}`);
}

test("AC11: the listener is bound to 127.0.0.1 on an operating-system assigned port and serves only /register and /callback", async () => {
  const flow = startFlow();
  const { address, port } = await flow.ready;
  assert.equal(address, "127.0.0.1");
  assert.ok(port > 0);
  assert.deepEqual(flow.opened, [`http://127.0.0.1:${port}/register`], "the browser opener is called once with the /register URL");
  assert.equal((await get(port, "/other")).status, 404);
  assert.equal((await get(port, "/")).status, 404);
  assert.equal((await get(port, "/register/extra")).status, 404);
  assert.equal((await get(port, "/register", { method: "POST" })).status, 405);
  assert.equal((await get(port, "/callback", { method: "POST" })).status, 405);
  assert.equal((await get(port, "/register", { host: "evil.example:80" })).status, 400, "a request addressed to another host is refused (DNS rebinding)");
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  assert.equal((await validCallback(port, state)).status, 200);
  assert.deepEqual(await flow.promise, APP);
  assert.equal(await refused(port), true, "the listener is closed after success");
  assert.match(flow.logs.text, new RegExp(`http://127\\.0\\.0\\.1:${port}/register`), "the /register URL is printed");
});

test("AC11: SDLC_BOOTSTRAP_NO_OPEN_BROWSER keeps the browser closed and the URL is still printed", async () => {
  const flow = startFlow({ env: { SDLC_BOOTSTRAP_NO_OPEN_BROWSER: "1" } });
  const { port } = await flow.ready;
  assert.deepEqual(flow.opened, []);
  assert.match(flow.logs.text, new RegExp(`/register`));
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  await validCallback(port, state);
  await flow.promise;
  assert.equal(await refused(port), true);
});

test("AC12: GET /register serves a post form with a hidden manifest input, the state, a script that submits it and a noscript button", async () => {
  const flow = startFlow({ registrationBase: ORG_URL });
  const { port } = await flow.ready;
  const response = await get(port, "/register");
  assert.equal(response.status, 200);
  const page = parseRegistrationPage(response.text);
  assert.equal(page.method, "post");
  assert.equal(new URL(page.action).origin + new URL(page.action).pathname, ORG_URL);
  assert.match(page.state, /^[0-9a-f]{32,}$/);
  assert.equal(page.manifest.redirect_url, `http://127.0.0.1:${port}/callback`);
  assert.deepEqual(page.manifest.default_permissions, { contents: "write" });
  assert.equal(page.noscriptButton, true);
  assert.equal(page.autoSubmits, true);
  await validCallback(port, page.state);
  await flow.promise;
});

test("AC12: the user form posts to the personal registration URL, and state differs on every run", async () => {
  const states = [];
  for (let run = 0; run < 3; run += 1) {
    const flow = startFlow({ registrationBase: USER_URL });
    const { port } = await flow.ready;
    const page = parseRegistrationPage((await get(port, "/register")).text);
    assert.equal(new URL(page.action).origin + new URL(page.action).pathname, USER_URL);
    assert.match(page.state, /^[0-9a-f]{32,}$/);
    states.push(page.state);
    await validCallback(port, page.state);
    await flow.promise;
  }
  assert.equal(new Set(states).size, 3, "every run has its own state");
  assert.ok(states.every((state) => state.length >= 32), "at least 128 bits, hex-encoded");
});

test("AC12: the manifest is HTML-escaped inside the form, so a quote in the manifest cannot break out of the attribute", async () => {
  const logs = new Capture();
  let port;
  const promise = runManifestFlow({
    buildManifest: (redirectUrl) => ({ name: 'quote " <b> & \' end', redirect_url: redirectUrl }),
    registrationBase: USER_URL,
    convert: async () => APP,
    openBrowser: async () => {},
    logger: createLogger(logs),
    hooks: { onListening: (address) => (port = address.port) },
  });
  promise.catch(() => {});
  while (port === undefined) await new Promise((resolve) => setImmediate(resolve));
  const html = (await get(port, "/register")).text;
  assert.equal(html.includes('quote " <b>'), false);
  assert.equal(parseRegistrationPage(html).manifest.name, 'quote " <b> & \' end');
  await validCallback(port, parseRegistrationPage(html).state);
  await promise;
});

const BAD_CALLBACKS = [
  ["a wrong state", (state) => `code=abc123&state=${"0".repeat(state.length)}`, /state/],
  ["a missing state", () => "code=abc123", /state/],
  ["a repeated state", (state) => `code=abc123&state=${state}&state=${state}`, /state/],
  ["a missing code", (state) => `state=${state}`, /code/],
  ["code=a/b", (state) => `code=a/b&state=${state}`, /code/],
  ["code=a.b", (state) => `code=a.b&state=${state}`, /code/],
  ["an empty code", (state) => `code=&state=${state}`, /code/],
  ["a repeated code", (state) => `code=a&code=b&state=${state}`, /code/],
];

for (const [label, query, expected] of BAD_CALLBACKS) {
  test(`AC14: ${label} answers 400, aborts naming ${expected.source}, never calls the conversion and closes the listener`, async () => {
    const flow = startFlow();
    const { port } = await flow.ready;
    const state = parseRegistrationPage((await get(port, "/register")).text).state;
    const response = await get(port, `/callback?${query(state)}`);
    assert.equal(response.status, 400);
    await assert.rejects(flow.promise, (error) => expected.test(error.message) && error.exitCode === 1);
    assert.deepEqual(flow.conversions, []);
    assert.equal(await refused(port), true);
  });
}

test("AC14: the accepted code characters are exactly [A-Za-z0-9_-]", async () => {
  const flow = startFlow();
  const { port } = await flow.ready;
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  assert.equal((await validCallback(port, state, "Aa09_-")).status, 200);
  await flow.promise;
  assert.deepEqual(flow.conversions, ["Aa09_-"]);
});

test("AC14: a second callback after the valid one cannot trigger a second conversion", async () => {
  const flow = startFlow();
  const { port } = await flow.ready;
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  const [first, second] = await Promise.all([validCallback(port, state, "one"), validCallback(port, state, "two")]);
  assert.deepEqual([first.status, second.status].sort(), [200, 400]);
  await flow.promise;
  assert.equal(flow.conversions.length, 1);
});

test("AC15: 599,999 ms leaves the flow waiting and 600,000 ms aborts with the diagnostic, no conversion and a closed listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flow = startFlow();
  const { port } = await flow.ready;
  let settled = false;
  flow.promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  t.mock.timers.tick(FLOW_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "still waiting at 599,999 ms");
  assert.equal(await refused(port), false, "the listener is still open");
  t.mock.timers.tick(1);
  await assert.rejects(flow.promise, (error) => /no callback was received/.test(error.message) && /deleted by its owner|can delete it/.test(error.message) && error.exitCode === 1);
  assert.deepEqual(flow.conversions, []);
  assert.equal(await refused(port), true);
  assert.equal(FLOW_TIMEOUT_MS, 600000);
});

test("AC15: a valid callback at 540,000 ms triggers exactly one conversion call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flow = startFlow();
  const { port } = await flow.ready;
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  t.mock.timers.tick(540000);
  assert.equal((await validCallback(port, state)).status, 200);
  assert.deepEqual(await flow.promise, APP);
  assert.equal(flow.conversions.length, 1);
  assert.equal(await refused(port), true);
});

test("AC11: an interrupt closes the listener and aborts", async () => {
  const controller = new AbortController();
  const flow = startFlow({ signal: controller.signal });
  const { port } = await flow.ready;
  controller.abort();
  await assert.rejects(flow.promise, (error) => /interrupted/.test(error.message) && error.exitCode === 130);
  assert.equal(await refused(port), true);
});

test("AC11: a failing conversion closes the listener and reports the failure (502 to the browser)", async () => {
  const logs = new Capture();
  let port;
  const promise = runManifestFlow({
    buildManifest: (redirectUrl) => ({ redirect_url: redirectUrl }),
    registrationBase: USER_URL,
    convert: async () => {
      throw new Error("GitHub answered 422");
    },
    openBrowser: async () => {},
    logger: createLogger(logs),
    hooks: { onListening: (address) => (port = address.port) },
  });
  promise.catch(() => {});
  while (port === undefined) await new Promise((resolve) => setImmediate(resolve));
  const state = parseRegistrationPage((await get(port, "/register")).text).state;
  assert.equal((await validCallback(port, state)).status, 502);
  await assert.rejects(promise, /GitHub answered 422/);
  assert.equal(await refused(port), true);
});

test("AC11 and AC14: through the bootstrap, a state mismatch exits non-zero, writes nothing and never converts", async () => {
  const scenario = await createScenario({ fake: { installations: [] } });
  try {
    const statuses = [];
    const openBrowser = githubSideBrowser(scenario, { callbackQuery: (state) => `code=abc&state=${"f".repeat(state.length)}`, onCallback: (status) => statuses.push(status) });
    const run = await scenario.bootstrap([], { openBrowser, timing: { pollIntervalMs: 10 } });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /state that does not match this run/);
    assert.equal(run.stdout, "");
    assert.deepEqual(statuses, [400]);
    assert.equal(scenario.fake.requests("POST /app-manifests/:code/conversions").length, 0);
    assert.deepEqual(scenario.fake.nonGet(), [], "no variable, no secret and no conversion was written");
    assert.equal(scenario.reconcile.calls.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test("AC11: the interactive run registers the App under an organization owner at the organization URL", async () => {
  const scenario = await createScenario();
  try {
    const pages = [];
    const run = await scenario.bootstrap(["--owner", "example-owner"], { openBrowser: githubSideBrowser(scenario, { onPage: (page) => pages.push(page) }), timing: { pollIntervalMs: 10 } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(new URL(pages[0].action).pathname, "/organizations/example-owner/settings/apps/new");
    assert.equal(scenario.fake.requests("GET /users/:login")[0].path, "/users/example-owner", "the owner kind is determined from the API before the URL is chosen");
  } finally {
    await scenario.cleanup();
  }
});

test("AC12: a user owner is registered at the personal URL", async () => {
  const scenario = await createScenario({ fake: { users: { "example-owner": { id: 1, type: "User" } } } });
  try {
    const pages = [];
    const run = await scenario.bootstrap(["--owner", "example-owner"], { openBrowser: githubSideBrowser(scenario, { onPage: (page) => pages.push(page) }), timing: { pollIntervalMs: 10 } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(new URL(pages[0].action).origin + new URL(pages[0].action).pathname, USER_URL);
    assert.match(run.stderr, /is a user account: GitHub registers the App under the account that is signed in/);
  } finally {
    await scenario.cleanup();
  }
});
