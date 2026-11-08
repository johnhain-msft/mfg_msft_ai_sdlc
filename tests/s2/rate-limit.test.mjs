// AC32: contract C5 error handoff, rate limits. Every S2 GitHub request honours retry-after and x-ratelimit-reset on a rate-limited
// response by waiting the indicated time before retrying; requests are serial; a response that is still rate limited after the
// bounded retries fails the step with exit 1 instead of being read as an empty result. The clock and the sleep are fakes, so no
// test waits for real, except the one command that runs against a stub server and waits the one second its stub asks for.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { run as escalate } from "../../src/drift/escalate-gate-failure.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, rateLimitWaitMs, resolveApiBase, tokenKind } from "../../src/drift/lib/github-client.mjs";
import { script, tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json, runNode, startStubServer } from "./helpers/stub-server.mjs";

const OWNER = "example-owner";
const REPO = "example-target";
const CENTRAL = "example-owner/example-central";
const PULLS = `/repos/${OWNER}/${REPO}/pulls`;
const TOKEN = "ghs_installationtokenfixture";
const dedupeEnv = () => cleanEnv({ CONFIGURED_TARGET_REPO: `${OWNER}/${REPO}`, GH_APP_INSTALLATION_TOKEN: TOKEN });
const escalateEnv = () => cleanEnv({ GITHUB_REPOSITORY: CENTRAL, GH_TOKEN: TOKEN });
const outDir = () => path.join(tempDir("sdlc-s2-rate-"), "agent");
const escalateArgs = ["--workflow-id", "drift-example", "--target-repo", `${OWNER}/${REPO}`, "--correlation-id", "c-1", "--run-url", "https://github.example/run/1", "--failing-command", "npm test"];

/** 403 with retry-after: 1, then 429 with x-ratelimit-reset two seconds ahead, then the answer. */
function limited(clock, answer) {
  const replies = [
    () => json(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "1" }),
    () => json(429, { message: "API rate limit exceeded" }, { "x-ratelimit-reset": String(Math.floor(clock.now() / 1000) + 2), "x-ratelimit-remaining": "0" }),
  ];
  return (entry, state) => (replies.length > 0 ? replies.shift()() : answer(entry, state));
}

test("AC32: the client waits the stated time after a 403 with retry-after and a 429 with x-ratelimit-reset, then succeeds", async () => {
  const clock = createClock();
  const stateAtRequest = [];
  const fake = createFakeFetch(limited(clock, () => json(200, { ok: true })));
  const original = fake;
  const client = createGitHubClient({
    baseUrl: "https://api.github.com",
    token: TOKEN,
    fetch: async (url, init) => {
      stateAtRequest.push(clock.now());
      return original(url, init);
    },
    sleep: clock.sleep,
    now: clock.now,
  });
  const body = await client.requestJson("GET", "/rate");
  assert.deepEqual(body, { ok: true });
  assert.equal(original.requests.length, 3);
  assert.equal(clock.waits.length, 2);
  assert.ok(clock.waits[0] >= 1000, `the first wait (${clock.waits[0]} ms) is at least the stated retry-after of 1 s`);
  const resetAt = Math.floor(Date.UTC(2026, 10, 6, 12, 0, 1) / 1000) + 1; // two seconds after the clock's first reading, rounded as the stub rounds
  assert.ok(stateAtRequest[2] >= resetAt * 1000, "the third request is sent at or after the reset instant");
  assert.ok(clock.waits[1] >= 2000 - 1000 && stateAtRequest[2] - stateAtRequest[1] >= clock.waits[1], "the second wait covers the time until x-ratelimit-reset");
});

test("AC32: the deduplication script retries a limited read after the stated times and then writes its record", async () => {
  const clock = createClock();
  const fake = createFakeFetch(limited(clock, () => json(200, [{ number: 1, html_url: "https://github.example/p/1", head: { ref: "sdlc/x" }, labels: [] }])));
  const directory = outDir();
  const result = await invoke(dedupe, ["--out", directory], { env: dedupeEnv(), fetch: fake, sleep: clock.sleep, now: clock.now });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.requests.length, 3);
  assert.ok(fake.requests.every((request) => request.method === "GET" && request.path === PULLS && request.search === "?state=open&per_page=30"), "the same read each time");
  assert.ok(clock.waits[0] >= 1000);
  assert.ok(clock.waits[1] >= 1000 && clock.waits[1] <= 3000, `the second wait follows x-ratelimit-reset: ${clock.waits[1]} ms`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "open-pr-dedup.json"), "utf8")).matches.length, 1);
  assert.equal(fake.state.maxInflight, 1, "no two requests overlap");
});

test("AC32: the escalation script retries a limited issue read and a limited issue create, and opens one issue", async () => {
  const clock = createClock();
  const issues = [];
  const fake = createFakeFetch(
    limited(clock, (entry) => {
      if (entry.method === "GET") return json(200, issues);
      if (entry.method === "POST" && entry.path === `/repos/${CENTRAL}/issues`) {
        if (!issues.rateLimitedOnce) {
          issues.rateLimitedOnce = true;
          return json(403, { message: "secondary rate limit" }, { "retry-after": "2" });
        }
        issues.push({ number: 5, title: JSON.parse(entry.body).title, body: "", html_url: "https://github.example/c/issues/5" });
        return json(201, issues[0]);
      }
      return json(404, {});
    }),
  );
  const result = await invoke(escalate, escalateArgs, { env: escalateEnv(), fetch: fake, sleep: clock.sleep, now: clock.now });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.requests.filter((request) => request.method === "POST").length, 2, "the create was sent twice: once refused, once accepted");
  assert.equal(issues.length, 1, "and one issue exists");
  assert.ok(clock.waits.includes(2000), "the create waited the 2 s that the server stated");
  assert.equal(fake.state.maxInflight, 1);
});

test("AC32: a stub that never recovers yields exit 1, writes nothing and creates no issue", async () => {
  const clock = createClock();
  const always = createFakeFetch(() => json(429, { message: "API rate limit exceeded" }, { "retry-after": "1" }));
  const directory = outDir();
  const read = await invoke(dedupe, ["--out", directory], { env: dedupeEnv(), fetch: always, sleep: clock.sleep, now: clock.now });
  assert.equal(read.code, 1);
  assert.match(read.stderr, /still rate limited after 3 retries/);
  assert.equal(always.requests.length, 4, "the first try and three retries");
  assert.deepEqual(clock.waits, [1000, 1000, 1000]);
  assert.equal(fs.existsSync(directory), false, "a limited read is never turned into an empty result");
  const second = createClock();
  const stuck = createFakeFetch(() => json(403, { message: "secondary rate limit" }, { "retry-after": "1" }));
  const escalated = await invoke(escalate, escalateArgs, { env: escalateEnv(), fetch: stuck, sleep: second.sleep, now: second.now });
  assert.equal(escalated.code, 1);
  assert.equal(stuck.requests.some((request) => request.method === "POST"), false, "no issue was created");
  const fewer = createFakeFetch(() => json(429, {}, { "retry-after": "1" }));
  assert.equal((await invoke(dedupe, ["--out", outDir(), "--max-retries", "1"], { env: dedupeEnv(), fetch: fewer, sleep: createClock().sleep })).code, 1);
  assert.equal(fewer.requests.length, 2, "--max-retries bounds the retries");
});

test("AC32: the wait follows retry-after (seconds or a date), then x-ratelimit-reset, then a minute that doubles", () => {
  const now = () => Date.UTC(2026, 10, 6, 12, 0, 0);
  const headers = (values) => new Headers(values);
  assert.equal(rateLimitWaitMs(headers({ "retry-after": "7" }), { now, attempt: 0 }), 7000);
  assert.equal(rateLimitWaitMs(headers({ "retry-after": "0" }), { now, attempt: 0 }), 0);
  assert.equal(rateLimitWaitMs(headers({ "retry-after": new Date(now() + 5000).toUTCString() }), { now, attempt: 0 }), 5000);
  assert.equal(rateLimitWaitMs(headers({ "x-ratelimit-reset": String(now() / 1000 + 30) }), { now, attempt: 0 }), 31000, "30 s to the reset and a second of margin");
  assert.equal(rateLimitWaitMs(headers({ "x-ratelimit-reset": String(now() / 1000 - 30) }), { now, attempt: 0 }), 1000, "a reset in the past still waits the margin");
  assert.equal(rateLimitWaitMs(headers({ "retry-after": "2", "x-ratelimit-reset": String(now() / 1000 + 600) }), { now, attempt: 0 }), 2000, "retry-after wins");
  assert.equal(rateLimitWaitMs(headers({}), { now, attempt: 0 }), 60000);
  assert.equal(rateLimitWaitMs(headers({}), { now, attempt: 1 }), 120000);
  assert.equal(rateLimitWaitMs(headers({}), { now, attempt: 2 }), 240000);
});

test("AC32: a limit is recognised by 429, by 403 with retry-after, x-ratelimit-remaining: 0 or a rate-limit message, and not by a plain 403", async () => {
  const cases = [
    [() => json(403, { message: "Resource not accessible by integration" }), false],
    [() => json(403, { message: "Forbidden" }), false],
    [() => json(403, { message: "API rate limit exceeded for installation" }), true],
    [() => json(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }), true],
    [() => json(403, { message: "Forbidden" }, { "retry-after": "1" }), true],
    [() => json(429, {}), true],
    [() => json(401, { message: "Bad credentials" }), false],
    [() => json(404, {}), false],
  ];
  for (const [reply, expectedRetry] of cases) {
    const clock = createClock();
    const replies = [reply, () => json(200, { done: true })];
    const fake = createFakeFetch(() => replies.shift()());
    const client = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: fake, sleep: clock.sleep, now: clock.now });
    const response = await client.request("GET", "/x");
    assert.equal(fake.requests.length, expectedRetry ? 2 : 1, JSON.stringify(reply()));
    assert.equal(response.status, expectedRetry ? 200 : reply().status);
  }
});

test("AC32: a wait longer than the run is willing to take fails at once, without sleeping", async () => {
  const clock = createClock();
  const fake = createFakeFetch(() => json(403, { message: "rate limit" }, { "retry-after": "3600" }));
  const result = await invoke(dedupe, ["--out", outDir()], { env: dedupeEnv(), fetch: fake, sleep: clock.sleep, now: clock.now });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /asks for 3600 s, more than the 300 s this run waits/);
  assert.deepEqual(clock.waits, []);
  assert.equal(fake.requests.length, 1);
  const patient = createFakeFetch(() => json(200, []));
  assert.equal((await invoke(dedupe, ["--out", outDir(), "--max-wait-seconds", "10"], { env: dedupeEnv(), fetch: patient })).code, 0);
});

test("AC32: requests are issued serially, however the caller schedules them", async () => {
  const clock = createClock();
  const fake = createFakeFetch(() => json(200, { ok: true }), { delayMs: 15 });
  const client = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: fake, sleep: clock.sleep, now: clock.now });
  const results = await Promise.all([1, 2, 3, 4, 5].map((index) => client.requestJson("GET", `/n/${index}`)));
  assert.equal(results.length, 5);
  assert.equal(fake.state.maxInflight, 1, "never more than one request in flight");
  assert.deepEqual(fake.requests.map((request) => request.path), ["/n/1", "/n/2", "/n/3", "/n/4", "/n/5"], "in the order they were made");
});

test("AC32: two writes are at least a second apart, and a server error is retried for a read but not for a write", async () => {
  const clock = createClock();
  const fake = createFakeFetch(() => json(201, {}));
  const client = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: fake, sleep: clock.sleep, now: clock.now });
  await client.request("POST", "/a", { body: {} });
  await client.request("POST", "/b", { body: {} });
  assert.deepEqual(clock.waits, [1000], "the second write waited out the second");
  const flaky = [502, 503, 200];
  const read = createFakeFetch(() => json(flaky.shift(), { ok: true }));
  const readClock = createClock();
  const reader = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: read, sleep: readClock.sleep, now: readClock.now });
  assert.deepEqual(await reader.requestJson("GET", "/r"), { ok: true });
  assert.deepEqual(readClock.waits, [1000, 2000], "a read is retried after 1 s and 2 s");
  const post = createFakeFetch(() => json(502, { message: "Bad Gateway" }));
  const writer = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: post, sleep: createClock().sleep });
  await assert.rejects(writer.requestJson("POST", "/w", { body: {}, expect: [201] }), /returned HTTP 502: Bad Gateway/);
  assert.equal(post.requests.length, 1, "a write that may have been applied is not sent again");
});

test("AC32: the address and the credential of the client are checked: https only, a token is never echoed", async () => {
  assert.equal(resolveApiBase({}), "https://api.github.com");
  assert.equal(resolveApiBase({ GITHUB_API_URL: "https://ghe.example.test/api/v3/" }), "https://ghe.example.test/api/v3");
  assert.equal(resolveApiBase({ GITHUB_API_URL: "http://localhost:8080" }), "http://localhost:8080");
  assert.equal(resolveApiBase({ GITHUB_API_URL: "http://[::1]:8080" }), "http://[::1]:8080");
  assert.throws(() => resolveApiBase({ GITHUB_API_URL: "http://github.example.test" }), GitHubApiError);
  assert.equal(tokenKind("ghs_x"), "App installation token");
  assert.equal(tokenKind("ghp_x"), "personal access token");
  assert.equal(tokenKind("github_pat_x"), "personal access token");
  assert.equal(tokenKind("gho_x"), "OAuth token");
  assert.equal(tokenKind("ghu_x"), "App user access token");
  // only an installation token is accepted; every other kind is refused by its kind, and the message never carries the token
  assert.equal(assertInstallationToken("ghs_secretvalue", "GH_TOKEN"), "ghs_secretvalue");
  for (const token of ["ghp_secretvalue", "github_pat_secretvalue", "gho_secretvalue", "ghu_secretvalue", "ghr_secretvalue", "0123456789abcdef0123456789abcdef01234567", "secretvalue", ""]) {
    assert.throws(() => assertInstallationToken(token, "GH_TOKEN"), (error) => error instanceof GitHubApiError && /^GH_TOKEN is not a GitHub App installation token \(.+\); a GitHub App installation token is required/.test(error.message) && (token === "" || !error.message.includes(token)), token);
  }
  const failing = createFakeFetch(() => {
    throw new Error(`socket hang up while sending ${TOKEN}`);
  });
  const client = createGitHubClient({ baseUrl: "https://api.github.com", token: TOKEN, fetch: failing, sleep: createClock().sleep, maxServerRetries: 0 });
  await assert.rejects(client.request("GET", "/x"), (error) => error instanceof GitHubApiError && !error.message.includes(TOKEN) && error.message.includes("***"));
});

test("AC32: the command waits the one second that a stub server asks for and then succeeds", async () => {
  let served = 0;
  const server = await startStubServer((entry) => {
    served += 1;
    if (served === 1) return json(403, { message: "secondary rate limit" }, { "retry-after": "1" });
    return json(200, []);
  });
  const directory = outDir();
  try {
    const started = Date.now();
    const result = await runNode(script("drift", "dedupe-open-prs.mjs"), ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, "--max-wait-seconds", "5"], { env: { ...dedupeEnv(), GITHUB_API_URL: server.url } });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started >= 1000, "the process waited at least the stated second");
    assert.equal(server.requests.length, 2);
    assert.equal(server.state.maxInflight, 1);
  } finally {
    await server.close();
  }
});
