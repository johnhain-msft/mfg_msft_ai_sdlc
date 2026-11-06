// AC10: contract C5 request, deduplication. The second pre-agent step lists the open pull requests of the target repository and
// records those that could duplicate an upkeep: a head branch of automation/weekly-audit-*, automation/self-improve-* or sdlc/*,
// or the label content-audit or self-improving-agents. The tests run it in-process against a fake `fetch` (no socket), once as a
// command against a stub server on 127.0.0.1, and check the prompt that tells the agent to read the result.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { matchReasons, run } from "../../src/drift/dedupe-open-prs.mjs";
import { DRIFT_KEYS, driftWorkflow, listTree, script, tempDir } from "./helpers/fixtures.mjs";
import { invoke, isUnder, leftovers, recordingFs } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json, runNode, startStubServer } from "./helpers/stub-server.mjs";

const OWNER = "example-owner";
const REPO = "example-target";
const PULLS_PATH = `/repos/${OWNER}/${REPO}/pulls`;
const QUERY = "?state=open&per_page=30";
const TOKEN = "ghs_installationtokenfixture";
const pull = (number, ref, labels = []) => ({ number, html_url: `https://github.example/${OWNER}/${REPO}/pull/${number}`, head: { ref }, labels: labels.map((name) => ({ name })), draft: false });
const OPEN = [
  pull(11, "automation/weekly-audit-2026-11-01"),
  pull(12, "automation/self-improve-2026-11-02"),
  pull(13, "sdlc/weekly-audit-2026-11-01"),
  pull(14, "feature/audited", ["content-audit", "automated"]),
  pull(15, "feature/agents", ["self-improving-agents"]),
  pull(16, "feature/x"),
  pull(17, "docs/automation/weekly-audit-x"),
  pull(18, "sdlc"),
  pull(19, "SDLC/Upper", ["other"]),
];

const listing = (list = OPEN) => createFakeFetch((entry) => (entry.pathAndSearch === `${PULLS_PATH}${QUERY}` ? json(200, list) : json(404, { message: "Not Found" })));
const env = (extra = {}) => cleanEnv({ CONFIGURED_TARGET_REPO: `${OWNER}/${REPO}`, GH_APP_INSTALLATION_TOKEN: TOKEN, ...extra });
const out = () => path.join(tempDir("sdlc-s2-dedupe-"), "agent");
const report = (directory, name = "open-pr-dedup.json") => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const rsa = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

test("AC10: the first request is GET /repos/<owner>/<repo>/pulls?state=open&per_page=30 with the installation token", async () => {
  const fake = listing();
  const directory = out();
  const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`], { env: env(), fetch: fake });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.requests.length, 1, "one request");
  const [first] = fake.requests;
  assert.equal(first.method, "GET");
  assert.equal(first.pathAndSearch, `${PULLS_PATH}${QUERY}`);
  assert.equal(first.host, "api.github.com", "the default API address");
  assert.equal(first.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(first.headers.accept, "application/vnd.github+json");
  assert.equal(first.headers["x-github-api-version"], "2022-11-28");
  assert.equal(first.body, null, "a read has no body");
});

test("AC10: the heads automation/weekly-audit-*, automation/self-improve-* and sdlc/* and the two labels are recorded, feature/x is not", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory], { env: env(), fetch: listing() });
  assert.equal(result.code, 0, result.stderr);
  const recorded = report(directory);
  assert.deepEqual(recorded.matches.map((match) => [match.number, match.headRef]), [
    [11, "automation/weekly-audit-2026-11-01"],
    [12, "automation/self-improve-2026-11-02"],
    [13, "sdlc/weekly-audit-2026-11-01"],
    [14, "feature/audited"],
    [15, "feature/agents"],
  ]);
  assert.deepEqual(recorded.matches.map((match) => match.url), [11, 12, 13, 14, 15].map((number) => `https://github.example/${OWNER}/${REPO}/pull/${number}`), "number, head ref and URL");
  assert.equal(recorded.matches.some((match) => match.headRef === "feature/x"), false);
  assert.deepEqual(recorded.matches.map((match) => match.reasons), [
    ["head branch matches automation/weekly-audit-*"],
    ["head branch matches automation/self-improve-*"],
    ["head branch matches sdlc/*"],
    ["carries the label content-audit"],
    ["carries the label self-improving-agents"],
  ]);
  assert.deepEqual({ repository: recorded.repository, inspected: recorded.inspected, truncated: recorded.truncated, duplicate: recorded.duplicate }, { repository: `${OWNER}/${REPO}`, inspected: 9, truncated: false, duplicate: true });
  assert.equal(recorded.query, `GET ${PULLS_PATH}${QUERY}`);
  assert.deepEqual(listTree(directory), ["open-pr-dedup.json", "open-prs.json"]);
  assert.equal(fs.readFileSync(path.join(directory, "open-prs.json"), "utf8"), fs.readFileSync(path.join(directory, "open-pr-dedup.json"), "utf8"), "the same record is also written as open-prs.json");
});

test("AC10: a branch has to start with the prefix, in this case, and a pull request that matches in two ways lists both reasons", () => {
  assert.deepEqual(matchReasons(pull(1, "docs/sdlc/x")), []);
  assert.deepEqual(matchReasons(pull(1, "SDLC/x")), []);
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit")), [], "the prefix ends with a dash");
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit-")), ["head branch matches automation/weekly-audit-*"]);
  assert.deepEqual(matchReasons(pull(1, "sdlc/a/b")), ["head branch matches sdlc/*"]);
  assert.deepEqual(matchReasons(pull(1, "sdlc/x", ["content-audit"])), ["head branch matches sdlc/*", "carries the label content-audit"]);
  assert.deepEqual(matchReasons(pull(1, "x", ["Content-Audit"])), [], "labels are matched exactly");
  assert.deepEqual(matchReasons({}), []);
  assert.deepEqual(matchReasons({ head: { ref: "sdlc/x" }, labels: null }), ["head branch matches sdlc/*"]);
});

test("AC10: with nothing that could be a duplicate the record says so, and the checkout is not needed", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory], { env: env(), fetch: listing([pull(1, "feature/x"), pull(2, "fix/y", ["bug"])]) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual({ duplicate: report(directory).duplicate, matches: report(directory).matches, inspected: report(directory).inspected }, { duplicate: false, matches: [], inspected: 2 });
  const empty = out();
  assert.equal((await invoke(run, ["--out", empty], { env: env(), fetch: listing([]) })).code, 0);
  assert.equal(report(empty).inspected, 0);
});

test("AC10: more open pull requests than one page are all read, and a repository beyond the page limit is marked truncated", async () => {
  const first = Array.from({ length: 30 }, (_, index) => pull(100 + index, `feature/${index}`));
  const second = [pull(200, "sdlc/late-2026-11-03")];
  const pages = createFakeFetch((entry) => {
    if (entry.pathAndSearch === `${PULLS_PATH}${QUERY}`) return json(200, first, { link: `<https://api.github.com/repositories/42/pulls?state=open&per_page=30&page=2>; rel="next", <https://api.github.com/repositories/42/pulls?state=open&per_page=30&page=2>; rel="last"` });
    if (entry.path === "/repositories/42/pulls" && entry.search.includes("page=2")) return json(200, second);
    return json(404, {});
  });
  const directory = out();
  assert.equal((await invoke(run, ["--out", directory], { env: env(), fetch: pages })).code, 0);
  assert.equal(pages.requests.length, 2);
  assert.deepEqual(report(directory).matches.map((match) => match.number), [200]);
  assert.equal(report(directory).inspected, 31);
  assert.equal(report(directory).truncated, false);
  const endless = createFakeFetch(() => json(200, [pull(1, "feature/a")], { link: '<https://api.github.com/repositories/42/pulls?state=open&per_page=30&page=2>; rel="next"' }));
  const capped = out();
  const result = await invoke(run, ["--out", capped], { env: env(), fetch: endless });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endless.requests.length, 10, "ten pages at most");
  assert.equal(report(capped).truncated, true);
  const foreign = createFakeFetch(() => json(200, [pull(1, "feature/a")], { link: '<https://evil.example/pulls?page=2>; rel="next"' }));
  const refused = await invoke(run, ["--out", out()], { env: env(), fetch: foreign });
  assert.equal(refused.code, 1, "a next link to another origin is not followed with the credential");
  assert.equal(foreign.requests.length, 1);
});

test("AC10: with a GitHub App credential the script mints an installation token for the target repository only, then reads", async () => {
  const { privateKey, publicKey } = rsa();
  const claims = [];
  const fake = createFakeFetch((entry) => {
    const bearer = String(entry.headers.authorization ?? "").replace(/^Bearer /, "");
    if (entry.path.startsWith("/app/")) {
      const [header, payload, signature] = bearer.split(".");
      assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true, "the App JWT is signed with the private key");
      const parsed = { header: JSON.parse(Buffer.from(header, "base64url")), payload: JSON.parse(Buffer.from(payload, "base64url")) };
      claims.push(parsed);
    }
    if (entry.pathAndSearch === "/app/installations?per_page=100") return json(200, [{ id: 5, account: { login: "someone-else" } }, { id: 77, account: { login: OWNER.toUpperCase() } }]);
    if (entry.method === "POST" && entry.path === "/app/installations/77/access_tokens") return json(201, { token: "ghs_minted", expires_at: "2026-11-06T13:00:00Z" });
    if (entry.pathAndSearch === `${PULLS_PATH}${QUERY}`) return entry.headers.authorization === "Bearer ghs_minted" ? json(200, OPEN) : json(401, { message: "Bad credentials" });
    return json(404, {});
  });
  const directory = out();
  const clock = createClock();
  const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`], { env: cleanEnv({ APP_CLIENT_ID: "Iv1.fixtureclient", APP_PRIVATE_KEY: privateKey }), fetch: fake, now: clock.now, sleep: clock.sleep });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.requests.map((request) => `${request.method} ${request.pathAndSearch}`), ["GET /app/installations?per_page=100", "POST /app/installations/77/access_tokens", `GET ${PULLS_PATH}${QUERY}`]);
  assert.deepEqual(JSON.parse(fake.requests[1].body), { repositories: [REPO], permissions: { pull_requests: "read" } }, "limited to the one repository and to read access to its pull requests");
  assert.equal(claims.length, 2);
  for (const { header, payload } of claims) {
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
    assert.equal(payload.iss, "Iv1.fixtureclient", "the issuer is the client ID");
    assert.ok(payload.exp - payload.iat <= 600 && payload.exp > payload.iat, "valid for at most ten minutes");
    assert.ok(Math.abs(payload.iat - clock.now() / 1000) <= 120);
  }
  assert.equal(report(directory).duplicate, true);
  for (const text of [result.stdout, result.stderr, ...listTree(directory).map((file) => fs.readFileSync(path.join(directory, file), "utf8"))]) {
    assert.equal(text.includes("PRIVATE KEY"), false, "the private key is never printed or written");
    assert.equal(text.includes("ghs_minted"), false, "and neither is the minted token");
  }
});

test("AC10: an App that is not installed on the owner, a key that is not a key and a refused token exchange each exit 1 and write nothing", async () => {
  const { privateKey } = rsa();
  const answer = (installations, exchange = 201) =>
    createFakeFetch((entry) => {
      if (entry.path === "/app/installations") return json(200, installations);
      if (entry.method === "POST") return exchange === 201 ? json(201, { token: "ghs_x" }) : json(exchange, { message: "Resource not accessible by integration" });
      return json(200, []);
    });
  const credentials = (extra = {}) => cleanEnv({ APP_CLIENT_ID: "Iv1.fixture", APP_PRIVATE_KEY: privateKey, ...extra });
  const cases = [
    ["not installed", answer([{ id: 1, account: { login: "other" } }]), credentials(), /not installed on 'example-owner'/],
    ["bad key", answer([]), credentials({ APP_PRIVATE_KEY: "not a pem" }), /not a valid PEM private key/],
    ["refused exchange", answer([{ id: 1, account: { login: OWNER } }], 403), credentials(), /returned HTTP 403: Resource not accessible/],
    ["no credential", answer([]), cleanEnv(), /no GitHub App credential/],
  ];
  for (const [name, fake, environment, message] of cases) {
    const directory = out();
    const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`], { env: environment, fetch: fake });
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, message, name);
    assert.equal(fs.existsSync(directory), false, `${name}: nothing is written`);
    assert.equal(fake.requests.filter((request) => request.path.includes("/pulls")).length, 0, `${name}: the pull requests are not read`);
  }
});

test("AC9 and AC10: a personal access token or an OAuth token is refused before any request, and nothing is written", async () => {
  for (const token of ["ghp_personalaccesstoken", "github_pat_11ABCDEFG_fixture", "gho_oauthtoken"]) {
    const fake = listing();
    const directory = out();
    const result = await invoke(run, ["--out", directory], { env: env({ GH_APP_INSTALLATION_TOKEN: token }), fetch: fake });
    assert.equal(result.code, 1, token);
    assert.match(result.stderr, /installation token is required/);
    assert.equal(fake.requests.length, 0, "no request carries the credential");
    assert.equal(result.stderr.includes(token), false, "the token is not echoed");
    assert.equal(fs.existsSync(directory), false);
  }
  const noEnvToken = listing();
  assert.equal((await invoke(run, ["--out", out()], { env: cleanEnv({ CONFIGURED_TARGET_REPO: `${OWNER}/${REPO}`, GH_TOKEN: "ghs_jobtoken", GITHUB_TOKEN: "ghs_jobtoken" }), fetch: noEnvToken })).code, 1, "GH_TOKEN and GITHUB_TOKEN are not used: only an App installation token for the target is");
  assert.equal(noEnvToken.requests.length, 0);
});

test("AC10: a failed read exits 1 and writes nothing: an unknown state is never 'no duplicate'", async () => {
  const cases = [
    [json(401, { message: "Bad credentials" }), /HTTP 401: Bad credentials/],
    [json(403, { message: "Resource not accessible by integration" }), /HTTP 403: Resource not accessible/],
    [json(404, { message: "Not Found" }), /HTTP 404: Not Found/],
    [json(200, { not: "a list" }), /did not return a list/],
    [{ status: 200, body: "<html>proxy error</html>" }, /did not return a list/],
  ];
  for (const [reply, message] of cases) {
    const directory = out();
    const result = await invoke(run, ["--out", directory], { env: env(), fetch: createFakeFetch(() => reply) });
    assert.equal(result.code, 1, JSON.stringify(reply).slice(0, 60));
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(directory), false);
  }
  const failing = createFakeFetch(() => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
  });
  const clock = createClock();
  const down = await invoke(run, ["--out", out()], { env: env(), fetch: failing, sleep: clock.sleep, now: clock.now });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /could not be sent: fetch failed.*ENOTFOUND/);
  assert.equal(failing.requests.length, 3, "a read is tried three times when the network fails");
  assert.deepEqual(clock.waits, [1000, 2000]);
});

test("AC10: the API address must be https, except for a loopback address, so that a token is never sent in the clear", async () => {
  for (const url of ["http://api.example.test", "ftp://api.example.test", "not a url"]) {
    const fake = listing();
    const result = await invoke(run, ["--out", out(), "--api-url", url], { env: env(), fetch: fake });
    assert.equal(result.code, 1, url);
    assert.match(result.stderr, /GITHUB_API_URL/);
    assert.equal(fake.requests.length, 0);
  }
  const loopback = createFakeFetch((entry) => json(200, entry.host === "127.0.0.1:4567" ? [] : [pull(1, "sdlc/x")]));
  assert.equal((await invoke(run, ["--out", out()], { env: env({ GITHUB_API_URL: "http://127.0.0.1:4567" }), fetch: loopback })).code, 0);
  assert.equal(loopback.requests[0].url, `http://127.0.0.1:4567${PULLS_PATH}${QUERY}`);
  const enterprise = createFakeFetch(() => json(200, []));
  assert.equal((await invoke(run, ["--out", out()], { env: env({ GITHUB_API_URL: "https://ghe.example.test/api/v3/" }), fetch: enterprise })).code, 0);
  assert.equal(enterprise.requests[0].url, `https://ghe.example.test/api/v3${PULLS_PATH}${QUERY}`, "an enterprise API prefix is kept");
});

test("AC10: a missing or malformed target repository is a usage error before any request", async () => {
  const fake = listing();
  assert.equal((await invoke(run, ["--out", out()], { env: cleanEnv({ GH_APP_INSTALLATION_TOKEN: TOKEN }), fetch: fake })).code, 2, "no target");
  assert.equal((await invoke(run, ["--out", out(), "--target-repo", "not-a-slug"], { env: env(), fetch: fake })).code, 2);
  assert.equal((await invoke(run, ["--out", out(), "--bogus", "x"], { env: env(), fetch: fake })).code, 2);
  assert.equal(fake.requests.length, 0);
});

test("AC10: the script writes only under --out and leaves nothing temporary behind", async () => {
  const directory = out();
  const spy = recordingFs();
  const result = await invoke(run, ["--out", directory], { env: env(), fetch: listing(), fs: spy.fs });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(spy.writes.length > 0);
  for (const target of spy.writes) assert.ok(isUnder(target, directory) || isUnder(target, path.dirname(directory)), `${target} is under --out`);
  assert.deepEqual(leftovers(path.dirname(directory)), []);
});

test("AC10: the command, run as a process against a stub server on 127.0.0.1, sends GET pulls?state=open&per_page=30 first", async () => {
  const server = await startStubServer((entry) => (entry.pathAndSearch === `${PULLS_PATH}${QUERY}` ? json(200, OPEN) : json(404, { message: "Not Found" })));
  const directory = out();
  try {
    const result = await runNode(script("drift", "dedupe-open-prs.mjs"), ["--out", directory, "--target-repo", `${OWNER}/${REPO}`], { env: env({ GITHUB_API_URL: server.url }) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.requests.map((request) => `${request.method} ${request.pathAndSearch}`), [`GET ${PULLS_PATH}${QUERY}`]);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(report(directory).matches.map((match) => match.number), [11, 12, 13, 14, 15]);
  } finally {
    await server.close();
  }
});

for (const key of DRIFT_KEYS) {
  test(`AC10: the prompt of drift-${key} tells the agent to read open-pr-dedup.json before it calls create_pull_request`, () => {
    const { body } = driftWorkflow(key);
    assert.match(body, /Read `\/tmp\/gh-aw\/agent\/open-pr-dedup\.json` before (?:you )?call(?:ing)? `create_pull_request`/);
    assert.match(body, /skip(?: the upkeep)? when it lists a matching open pull request/);
    assert.ok(body.indexOf("open-pr-dedup.json") < body.indexOf("## Operating rules") || body.includes("## Operating rules"), "the rule is in the rendered prompt");
  });
}
