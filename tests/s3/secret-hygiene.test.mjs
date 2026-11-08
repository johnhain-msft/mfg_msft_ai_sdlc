// No script of S3 prints a credential (SPEC-03 AC69): not the App's private key, not an installation token, not the token of the job, not the signed JWT, not an
// Authorization header value. Each case injects recognisable secrets, makes the secret reach a place that a careless program would print (a server that echoes the
// Authorization header, a command that prints its environment, an error that quotes a request), and asserts that none of them is in standard output, standard
// error, the decision log, an issue (title, body, comment) or a request body. The spellings of a secret are derived here, independently of the code under test.
import assert from "node:assert/strict";
import test from "node:test";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { CHANGED_REPORT, preflightEdge } from "./helpers/preflight-world.mjs";
import { sha, state, TOKENS } from "./helpers/fixtures.mjs";
import { flagsFor, invoke, world as pollWorld } from "./helpers/poll-state-world.mjs";

/** Every spelling of a private key that could be printed: the whole, each of its lines, the collapsed body and the JSON-escaped form. */
function pemForms(pem) {
  const lines = pem.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"));
  return [pem.trim(), JSON.stringify(pem).slice(1, -1), lines.join(""), ...lines.filter((line) => line.length >= 20)];
}
const tokenForms = (token) => [token, `Bearer ${token}`, Buffer.from(`x-access-token:${token}`).toString("base64")];

function secretsOf(w) {
  const jwts = w.stub.requests.filter((request) => request.path.startsWith("/app/")).map((request) => (request.headers.authorization ?? "").replace(/^Bearer /, ""));
  return [
    ...pemForms(w.env.APP_PRIVATE_KEY),
    ...tokenForms(TOKENS.issues),
    ...w.stub.world.minted.flatMap((entry) => tokenForms(entry.token)),
    ...jwts.flatMap((jwt) => [jwt, `Bearer ${jwt}`]),
  ];
}

/** Everything that a run wrote. */
function surfacesOf(w, result) {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    "decision log": w.summaryLines().join("\n"),
    "issue titles and bodies": w.stub.issues.map((issue) => `${issue.title}\n${issue.body}`).join("\n"),
    "issue comments": w.stub.world.comments.map((comment) => comment.body).join("\n"),
    "request bodies": w.stub.requests.filter((request) => !request.path.startsWith("/app/")).map((request) => request.body ?? "").join("\n"),
  };
}

function assertNoSecrets(label, surfaces, secrets) {
  for (const [name, text] of Object.entries(surfaces)) {
    for (const secret of secrets) {
      assert.equal(String(text).includes(secret), false, `${label}: ${name} holds a secret (${secret.slice(0, 12)}…)`);
    }
  }
}

const echo = (entry) => ({ status: 500, body: { message: `Server Error; the request said ${entry.headers.authorization} (token ${String(entry.headers.authorization).replace(/^Bearer /, "")})` } });

test("AC69 a successful dispatch writes no credential anywhere", async (t) => {
  const w = routerWorld();
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(w.stub.world.minted.length >= 2, "tokens were minted, so there was something to leak");
  assertNoSecrets("dispatch", surfacesOf(w, result), secretsOf(w));
  assert.ok(result.stdout.length > 0 && w.summaryLines().length === 1, "and there is output to inspect");
});

test("AC69 a server that echoes the Authorization header of a read, of the state, of the dispatch and of the App exchange does not make the router print it", async (t) => {
  for (const [label, method, needle] of [
    ["the upstream read", "GET", "/commits/"],
    ["the state read", "GET", "/actions/variables/"],
    ["the dispatch", "POST", "/dispatches"],
    ["the installation list (the signed JWT)", "GET", "/app/installations"],
    ["the token exchange (the signed JWT)", "POST", "/access_tokens"],
  ]) {
    const w = routerWorld();
    t.after(() => w.cleanup());
    w.stub.inject(method, needle, echo);
    const result = await w.go();
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.ok(w.stub.issues.length === 1 || label.includes("signed JWT"), `${label}: the failure was reported`);
    assertNoSecrets(label, surfacesOf(w, result), secretsOf(w));
  }
});

test("AC69 a command of a preflight that prints its environment into its error does not put the token that it was given into the log or the issue", async (t) => {
  const edge = preflightEdge();
  const w = routerWorld({ edge, state: state({}, edge), upstream: { head: sha("head-2") } });
  t.after(() => w.cleanup());
  const seen = [];
  const fake = fakePreflight([
    // exit 3 is neither a clean nor a drifting report: the error quotes the tail of what the command printed
    { match: /sync:workshop-source/, code: 3, stdout: "no summary here\n", stderr: (call) => (seen.push(call.env.GH_TOKEN), `GH_TOKEN=${call.env.GH_TOKEN}\nAuthorization: Bearer ${call.env.GH_TOKEN}\n`) },
  ]);
  const result = await w.go({ preflightDeps: fake.deps });
  assert.equal(result.code, 1);
  assert.ok(seen.length >= 1 && /^ghs_/.test(seen[0]), "the command was given a token, and printed it");
  assert.match(result.stderr, /exited with 3: GH_TOKEN=\*\*\*/, "the error quotes what the command printed, with the token masked");
  assertNoSecrets("preflight", surfacesOf(w, result), [...secretsOf(w), ...seen.flatMap(tokenForms)]);
  assert.equal(w.stub.issues.length, 1);
  assert.match(w.stub.issues[0].body, /GH_TOKEN=\*\*\*/, "the place where the token was is marked");
});

test("AC69 a preflight that succeeds and prints a token in its report does not put it into the log", async (t) => {
  const edge = preflightEdge();
  const w = routerWorld({ edge, state: state({}, edge), upstream: { head: sha("head-2") } });
  t.after(() => w.cleanup());
  const seen = [];
  const fake = fakePreflight([
    { match: /sync:workshop-source/, code: 1, stdout: (call) => (seen.push(call.env.GH_TOKEN), `${CHANGED_REPORT}token ${call.env.GH_TOKEN}\n`) },
    { match: /lab-studio-drift\.mjs/, code: 0, stdout: `${JSON.stringify({ status: "in-sync", previousCommit: "a".repeat(40), targetCommit: "b".repeat(40), changedLabs: [] })}\n` },
  ]);
  const result = await w.go({ preflightDeps: fake.deps });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets("successful preflight", surfacesOf(w, result), [...secretsOf(w), ...seen.flatMap(tokenForms)]);
});

test("AC69 a private key that cannot be used is a configuration error (exit 2), and whatever the signer says about it does not repeat the key", async (t) => {
  const w = routerWorld();
  t.after(() => w.cleanup());
  // the key is unusable: whatever the signer says about it must not repeat it
  const broken = w.env.APP_PRIVATE_KEY.replace(/[A-Za-z0-9+/]{40,}/, (body) => `${body.slice(0, 20)}!!!${body.slice(23)}`);
  const result = await w.go({ env: { APP_PRIVATE_KEY: broken } });
  assert.equal(result.code, 2);
  assert.equal(w.stub.world.minted.length, 0, "no token was minted with it");
  const forms = [...pemForms(broken), ...pemForms(w.env.APP_PRIVATE_KEY)];
  assertNoSecrets("broken key", surfacesOf(w, result), [...forms, ...tokenForms(TOKENS.issues)]);
});

test("AC69 the poll-state script prints no credential on success, on a verification failure or when a server echoes its Authorization header", async (t) => {
  const secretsOfPoll = (w) => [...tokenForms(TOKENS.gh), ...tokenForms(TOKENS.issues), ...w.stub.requests.map((request) => request.headers.authorization ?? "").filter(Boolean)];
  const surfaces = (w, result) => ({
    stdout: result.stdout,
    stderr: result.stderr,
    "issue titles and bodies": w.stub.issues.map((issue) => `${issue.title}\n${issue.body}`).join("\n"),
    "issue comments": w.stub.world.comments.map((comment) => comment.body).join("\n"),
    "request bodies": w.stub.requests.map((request) => request.body ?? "").join("\n"),
  });

  const ok = pollWorld();
  t.after(() => ok.workspace.cleanup());
  const success = await invoke(ok, flagsFor(ok.edgeValue));
  assert.equal(success.code, 0, success.stderr);
  assertNoSecrets("success", surfaces(ok, success), secretsOfPoll(ok));

  const unverified = pollWorld({ pulls: [] });
  t.after(() => unverified.workspace.cleanup());
  const failed = await invoke(unverified, flagsFor(unverified.edgeValue));
  assert.equal(failed.code, 1);
  assertNoSecrets("verification failure", surfaces(unverified, failed), secretsOfPoll(unverified));

  for (const [label, method, needle] of [["the pull-request list", "GET", "/pulls"], ["the state read", "GET", "/actions/variables/"], ["the state write", "PATCH", "/actions/variables/"]]) {
    const hostile = pollWorld();
    t.after(() => hostile.workspace.cleanup());
    hostile.stub.inject(method, needle, echo);
    const result = await invoke(hostile, flagsFor(hostile.edgeValue));
    assert.equal(result.code, 1, label);
    assert.equal(hostile.stub.issues.length, 1, `${label}: reported`);
    assertNoSecrets(label, surfaces(hostile, result), secretsOfPoll(hostile));
    assert.match(`${result.stderr}\n${hostile.stub.issues[0].body}`, /\*\*\*/, `${label}: the place of the token is marked`);
  }
});
