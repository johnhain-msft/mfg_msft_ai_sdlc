// Every S3 test runs offline against the local stub, selected through GITHUB_API_URL, and makes no GitHub-side write and no request to a non-loopback host (SPEC-03 AC67).
// The stub is in process (tests/s3/helpers/github-stub.mjs, handed to the scripts as io.fetch), so no socket is opened at all: the cases here poison everything that could
// reach the network (global fetch, the resolver, net, tls, http, https), run the two scripts through their routes, and assert that nothing tried, that every recorded
// request is addressed to the configured loopback origin, and that no S3 test or helper opens a socket.
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { flagsFor, invoke, TARGET, world as pollWorld } from "./helpers/poll-state-world.mjs";
import { abs, edge, mechanicalEdge, REPO_ROOT, sha, state, STUB_API_URL } from "./helpers/fixtures.mjs";

/** Replaces everything that could open a connection with a recorder that throws. Returns what was attempted, and a function that puts everything back. */
function poisonNetwork() {
  const attempts = [];
  const saved = [];
  const poison = (owner, name, label) => {
    saved.push([owner, name, owner[name]]);
    owner[name] = (...args) => {
      attempts.push(`${label}(${String(args[0]?.hostname ?? args[0]?.host ?? args[0]).slice(0, 80)})`);
      throw new Error(`network access attempted: ${label}`);
    };
  };
  poison(globalThis, "fetch", "fetch");
  poison(dns, "lookup", "dns.lookup");
  poison(dns.promises, "lookup", "dns.promises.lookup");
  poison(dns, "resolve", "dns.resolve");
  poison(net, "connect", "net.connect");
  poison(net, "createConnection", "net.createConnection");
  poison(net.Socket.prototype, "connect", "net.Socket.connect");
  poison(tls, "connect", "tls.connect");
  for (const [module, label] of [[http, "http"], [https, "https"]]) {
    poison(module, "request", `${label}.request`);
    poison(module, "get", `${label}.get`);
  }
  return { attempts, restore: () => saved.reverse().forEach(([owner, name, original]) => (owner[name] = original)) };
}

const loopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

test("AC67 the router and the poll-state script run through every route with the network poisoned: nothing is attempted, and every request is addressed to the origin that GITHUB_API_URL names", async (t) => {
  const worlds = [];
  const poisoned = poisonNetwork();
  try {
    const e = edge();
    const routes = [
      [routerWorld(), (w) => w.go()],
      [routerWorld({ edge: mechanicalEdge(), upstream: { head: sha("m") } }), (w) => w.go()],
      [routerWorld({ state: state({ etag: 'W/"upstream-etag-1"', lastObservedHeadSha: sha("head-1"), lastNoopHeadSha: sha("head-1") }, e) }), (w) => w.go()],
      [
        (() => {
          const w = routerWorld();
          w.stub.inject("GET", "/commits/", () => ({ status: 500, body: { message: "Server Error" } }));
          return w;
        })(),
        (w) => w.go(),
      ],
      [routerWorld({ edge: edge({ preflightCommands: ["git -C <checkout> diff --quiet a b"] }), upstream: { head: sha("p") } }), (w) => w.go({ preflightDeps: fakePreflight([{ match: /diff/, code: 1 }]).deps })],
    ];
    for (const [w, go] of routes) {
      worlds.push(w);
      const result = await go(w);
      assert.ok([0, 1].includes(result.code), `${result.stderr}`);
      assert.equal(w.env.GITHUB_API_URL, STUB_API_URL, "the stub is selected through GITHUB_API_URL");
      assert.ok(w.stub.requests.length > 0);
      for (const request of w.stub.requests) {
        assert.ok(request.url.startsWith(`${STUB_API_URL}/`), request.url);
        assert.equal(loopback(request.url), true, request.url);
      }
    }
    for (const [options, argv] of [
      [{}, null],
      [{ pulls: [] }, null],
      [{}, ["--record-failure", "--slug", "WIDGETS", "--target-sha", TARGET, "--workflow-id", "wf"]],
    ]) {
      const w = pollWorld(options);
      worlds.push({ cleanup: () => w.workspace.cleanup() });
      const result = await invoke(w, argv ?? flagsFor(w.edgeValue));
      assert.ok([0, 1].includes(result.code), result.stderr);
      assert.ok(w.stub.requests.length > 0);
      for (const request of w.stub.requests) assert.ok(request.url.startsWith(`${STUB_API_URL}/`) && loopback(request.url), request.url);
    }
    assert.deepEqual(poisoned.attempts, [], "no connection, resolution or fetch was attempted");
  } finally {
    poisoned.restore();
    worlds.forEach((w) => w.cleanup());
  }
  void t;
});

test("AC67 the poison is real: a script that does reach for the network is caught by it", async () => {
  const poisoned = poisonNetwork();
  try {
    assert.throws(() => globalThis.fetch("https://example.invalid/"), /network access attempted: fetch/);
    assert.throws(() => net.connect(80, "example.invalid"), /network access attempted: net\.connect/);
    assert.throws(() => dns.lookup("example.invalid", () => {}), /network access attempted: dns\.lookup/);
    assert.equal(poisoned.attempts.length, 3);
  } finally {
    poisoned.restore();
  }
  assert.equal(typeof globalThis.fetch, "function");
});

test("AC67 a plain-http API origin that is not loopback is refused before any request, and an unparseable one too", async (t) => {
  for (const url of ["http://api.example.com", "ftp://127.0.0.1", "not a url"]) {
    const w = routerWorld({ env: { GITHUB_API_URL: url } });
    t.after(() => w.cleanup());
    const result = await w.go();
    assert.equal(result.code, 2, `${url}: ${result.stderr}`);
    assert.equal(w.stub.requests.length, 0, `${url}: no request was made`);
    const poll = pollWorld();
    t.after(() => poll.workspace.cleanup());
    const polled = await invoke(poll, flagsFor(poll.edgeValue), { env: { GITHUB_API_URL: url } });
    assert.equal(polled.code, 2, url);
    assert.equal(poll.stub.requests.length, 0);
  }
});

test("AC67 no test or helper of S3 opens a socket: there is no server, no listener and no client of a network protocol in tests/s3", () => {
  const forbidden = [
    ["create", "Server"],
    [".", "listen("],
    ["net", ".connect"],
    ["new ", "WebSocket"],
    ["http", ".request("],
    ["https", ".request("],
    ["http", ".get("],
    ["https", ".get("],
    ["fetch(", '"http'],
    ["dgram", ""],
  ].map((parts) => parts.join(""));
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs") && entry.name !== "no-remote-writes.test.mjs") files.push(full);
    }
  };
  walk(abs("tests", "s3"));
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const needle of forbidden) assert.equal(text.includes(needle), false, `${path.relative(REPO_ROOT, file)} contains ${needle}`);
  }
});

test("AC67 the git remotes of the preflight tests are directories on disk, never a host", async () => {
  const { createGitWorld } = await import("./helpers/git-world.mjs");
  const git = createGitWorld();
  try {
    assert.match(git.serverUrl, /^file:\/\//);
    assert.match(git.environment().GITHUB_SERVER_URL, /^file:\/\//);
  } finally {
    git.cleanup();
  }
});
