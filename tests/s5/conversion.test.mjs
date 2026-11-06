// AC16: a valid callback is exchanged with exactly one POST /app-manifests/{code}/conversions carrying
// Accept: application/vnd.github+json; 201 yields id, slug, client_id, pem and permissions; 404 and 422 abort with a
// diagnostic that names the status and are never retried.
import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../bin/lib/github-api.mjs";
import { convertManifestCode } from "../../bin/lib/github-app.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { Capture, assertNoSecrets, createScenario, githubSideBrowser } from "./helpers/harness.mjs";
import { startFakeGitHub } from "./helpers/fake-github.mjs";

test("AC16: a 201 is parsed to id, slug, client_id, pem and permissions with exactly one request that carries the Accept header", async () => {
  const fake = await startFakeGitHub({ app: { id: 9001, slug: "renamed-by-the-registrant", client_id: "Iv1.conversion", permissions: { contents: "write" } } });
  try {
    const api = createApi({ baseUrl: fake.url, fetch: fake.fetch, token: "operator-token-fixture" });
    const app = await convertManifestCode(api, "abc123_-X", createLogger(new Capture()));
    assert.deepEqual(Object.keys(app), ["id", "slug", "clientId", "pem", "permissions"]);
    assert.equal(app.id, 9001);
    assert.equal(app.slug, "renamed-by-the-registrant", "the slug comes from the response, never from the requested name");
    assert.equal(app.clientId, "Iv1.conversion");
    assert.equal(app.pem, fake.appKey.privateKeyPem);
    assert.deepEqual(app.permissions, { contents: "write" });
    const requests = fake.requests("POST /app-manifests/:code/conversions");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/app-manifests/abc123_-X/conversions");
    assert.equal(requests[0].accept, "application/vnd.github+json");
    assert.equal(requests[0].auth.present, false, "the operator's token is not sent to the unauthenticated exchange");
    assert.equal(fake.log.length, 1);
  } finally {
    await fake.close();
  }
});

test("AC16: client_secret and webhook_secret are discarded: they are not part of the result and are redacted if they ever surface", async () => {
  const fake = await startFakeGitHub();
  try {
    const logs = new Capture();
    const logger = createLogger(logs);
    const app = await convertManifestCode(createApi({ baseUrl: fake.url, fetch: fake.fetch }), "code1", logger);
    assert.equal(JSON.stringify(app).includes("fixture-client-secret"), false);
    assert.equal(JSON.stringify(app).includes("fixture-webhook-secret"), false);
    logger.info("leak: fixture-client-secret-0123456789 and fixture-webhook-secret-0123456789");
    assert.equal(logs.text.includes("fixture-client-secret-0123456789"), false);
    assert.equal(logs.text.includes("fixture-webhook-secret-0123456789"), false);
    assert.equal(logs.text.includes(fake.appKey.privateKeyPem), false);
  } finally {
    await fake.close();
  }
});

for (const [status, expected] of [
  [404, /answered 404[\s\S]*unknown or has expired/],
  [422, /answered 422[\s\S]*rate limited/],
  [500, /answered 500/],
]) {
  test(`AC16: a ${status} aborts with a diagnostic that names the status, after exactly one request`, async () => {
    const fake = await startFakeGitHub({ conversion: { status, message: "boom" } });
    try {
      await assert.rejects(convertManifestCode(createApi({ baseUrl: fake.url, fetch: fake.fetch }), "code1", createLogger(new Capture())), expected);
      assert.equal(fake.requests("POST /app-manifests/:code/conversions").length, 1, "no retry loop");
    } finally {
      await fake.close();
    }
  });
}

test("AC16: a 201 whose body lacks a required field is refused", async () => {
  const fake = await startFakeGitHub();
  try {
    fake.override("POST", "/app-manifests/:code/conversions", { status: 201, body: { id: 1, slug: "x", client_id: "c" } });
    await assert.rejects(convertManifestCode(createApi({ baseUrl: fake.url, fetch: fake.fetch }), "code1", createLogger(new Capture())), /no 'pem'/);
  } finally {
    await fake.close();
  }
});

for (const [status, expected] of [
  [404, /404/],
  [422, /422[\s\S]*rate limited/],
]) {
  test(`AC16: through the bootstrap, a ${status} from the conversion exits non-zero, names the status, writes nothing and does not call S1`, async () => {
    const scenario = await createScenario({ fake: { installations: [], conversion: { status } } });
    try {
      const run = await scenario.bootstrap([], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } });
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, expected);
      assert.equal(run.stdout, "");
      assert.equal(scenario.fake.requests("POST /app-manifests/:code/conversions").length, 1);
      assert.deepEqual(scenario.fake.nonGet().filter((entry) => !entry.path.startsWith("/app-manifests/")), [], "no variable or secret was written");
      assert.equal(scenario.reconcile.calls.length, 0);
      assertNoSecrets({ stdout: run.stdout, stderr: run.stderr }, [scenario.fake.appKey.privateKeyPem, "fixture-client-secret", "fixture-webhook-secret"]);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC16: through the bootstrap, the slug used afterwards is the one in the conversion response", async () => {
  const scenario = await createScenario({ fake: { installations: [], app: { slug: "slug-from-the-response" } } });
  try {
    const run = await scenario.bootstrap(["--app-name", "My Requested Name"], { openBrowser: githubSideBrowser(scenario), timing: { pollIntervalMs: 10 } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).appSlug, "slug-from-the-response");
    assert.equal(scenario.reconcile.calls[0].request.appSlug, "slug-from-the-response");
    assert.ok(scenario.browser.urls.some((url) => url.includes("/apps/slug-from-the-response/installations/new")));
  } finally {
    await scenario.cleanup();
  }
});
