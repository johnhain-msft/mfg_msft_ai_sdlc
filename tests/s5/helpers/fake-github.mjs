// In-memory stand-in for the GitHub REST API (AC55): it listens on 127.0.0.1, implements only the routes the CLIs use,
// records every request, and answers anything else with 404 and an `unhandled` mark so that a test can fail on a
// request its scenario did not declare. State persists while the server is up, so two runs can share one fake.

import assert from "node:assert/strict";
import http from "node:http";
import { after } from "node:test";
import { fixtureAppKey, sodiumKeyPair, verifyJwt } from "./keys.mjs";

export const FIXTURE_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  variables: "write",
  metadata: "read",
});

/** Every route that a scenario of the S5 suites may use; a suite narrows it per scenario with `declared`. */
export const DEFAULT_DECLARED = Object.freeze([
  "GET /users/:login",
  "GET /app",
  "GET /app/installations",
  "GET /repos/:owner/:repo/installation",
  "POST /app-manifests/:code/conversions",
  "GET /repos/:owner/:repo/actions/secrets/public-key",
  "PUT /repos/:owner/:repo/actions/secrets/:name",
  "GET /repos/:owner/:repo/actions/variables/:name",
  "POST /repos/:owner/:repo/actions/variables",
  "PATCH /repos/:owner/:repo/actions/variables/:name",
  "PUT /repos/:owner/:repo/actions/workflows/:id/disable",
  "GET /repos/:owner/:repo/commits/:ref",
  "GET /repos/:owner/:repo/git/trees/:sha",
  "GET /repos/:owner/:repo/contents/*",
  "GET /repos/:owner/:repo",
]);

const lower = (value) => String(value).toLowerCase();
const lowerKeys = (object) => new Map(Object.entries(object).map(([key, value]) => [lower(key), value]));

function patternToRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern;
  const source = String(pattern)
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/]+" : part === "*" ? ".+" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

/** Matches a recorded request against patterns such as "GET /repos/:owner/:repo/actions/variables/:name". */
export function requestMatches(entry, pattern) {
  const space = pattern.indexOf(" ");
  const method = pattern.slice(0, space);
  return (method === "*" || method === entry.method) && patternToRegExp(pattern.slice(space + 1)).test(entry.path);
}

/** Fails when the log holds a request that none of the declared patterns covers (every suite ends with this check). */
export function undeclaredRequests(log, declared) {
  return log.filter((entry) => !declared.some((pattern) => requestMatches(entry, pattern)));
}

// AC55: every suite ends by asserting that the log of each fake GitHub that it started holds no request that its scenario
// did not declare: no request to a route that the fake does not implement and none outside the scenario's `declared` list.
const started = [];

/** What the closing check of the suite would report right now: one line per request that its scenario did not declare. */
export function suiteUndeclaredRequests() {
  const problems = [];
  started.forEach((entry, index) => {
    for (const request of entry.log) {
      if (request.unhandled) problems.push(`fake GitHub #${index + 1}: ${request.method} ${request.path} is not a route of the fake`);
      else if (!entry.declared.some((pattern) => requestMatches(request, pattern))) problems.push(`fake GitHub #${index + 1}: ${request.method} ${request.path} was not declared by its scenario`);
    }
  });
  return problems;
}

after(() => {
  assert.deepEqual(suiteUndeclaredRequests(), [], "the recorded log holds requests that their scenario did not declare");
});

/**
 * @param {object} [options]
 * @param {object} [options.app] overrides for the App object served by GET /app and the conversion
 * @param {{ privateKeyPem: string, publicKeyPem: string }} [options.appKey] the App key pair (default: the fixture pair)
 * @param {object[]} [options.installations] { id, account: { login, id, type }, repository_selection, permissions, _repositories }
 * @param {Record<string, {type: string, id: number}>} [options.users]
 * @param {Record<string, {id: number, defaultBranch?: string, headSha?: string, files?: Record<string,string>}>} [options.repos]
 * @param {{ status?: number, message?: string }} [options.conversion] the answer of POST /app-manifests/{code}/conversions
 * @param {string[]} [options.declared] the "METHOD /path/:param" patterns that the scenario declares (default: DEFAULT_DECLARED);
 *   the suite's closing check fails on any recorded request outside them
 */
export async function startFakeGitHub(options = {}) {
  const key = options.appKey ?? fixtureAppKey();
  const secretKey = options.secretKey ?? (await sodiumKeyPair());
  const state = {
    app: {
      id: 424242,
      slug: "fixture-app",
      node_id: "A_fixture",
      client_id: "Iv1.fixtureclientid",
      name: "Fixture App",
      permissions: { ...FIXTURE_PERMISSIONS },
      ...options.app,
    },
    installations: options.installations ?? [],
    users: lowerKeys(options.users ?? {}),
    repos: lowerKeys(options.repos ?? {}),
    variables: new Map(),
    secrets: new Map(),
    disabledWorkflows: [],
    conversion: { status: 201, ...options.conversion },
    conversionPem: options.conversionPem ?? key.privateKeyPem,
    overrides: [],
  };
  const log = [];
  started.push({ log, declared: options.declared ?? DEFAULT_DECLARED });
  let baseUrl = "";

  const variablesOf = (repo) => {
    if (!state.variables.has(lower(repo))) state.variables.set(lower(repo), new Map());
    return state.variables.get(lower(repo));
  };
  const secretsOf = (repo) => {
    if (!state.secrets.has(lower(repo))) state.secrets.set(lower(repo), new Map());
    return state.secrets.get(lower(repo));
  };

  const json = (status, body, headers = {}) => ({ status, body, headers });
  const jwtOf = (request) => {
    const header = String(request.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return { token, ...verifyJwt(token, key.publicKeyPem) };
  };
  const requireJwt = (request) => {
    const result = jwtOf(request);
    return result.valid ? null : json(401, { message: "A JSON web token could not be decoded" });
  };

  const appObject = () => ({ ...state.app });
  const installationObject = (installation) => {
    const { _repositories, ...rest } = installation;
    return { suspended_at: null, target_type: rest.account?.type ?? "User", ...rest };
  };

  function treeOf(files) {
    const entries = [];
    const directories = new Set();
    for (const path of Object.keys(files).sort()) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
      entries.push({ path, type: "blob", sha: "0".repeat(40), size: Buffer.byteLength(files[path]) });
    }
    for (const directory of directories) entries.push({ path: directory, type: "tree", sha: "1".repeat(40) });
    return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  const routes = [
    ["GET", /^\/users\/([^/]+)$/, (request, [login]) => {
      const user = state.users.get(lower(login));
      return user ? json(200, { login, ...user }) : json(404, { message: "Not Found" });
    }],
    ["GET", /^\/app$/, (request) => requireJwt(request) ?? json(200, appObject())],
    ["GET", /^\/app\/installations$/, (request, params, query) => {
      const denied = requireJwt(request);
      if (denied) return denied;
      const perPage = Math.min(Number(query.get("per_page") ?? 30), 100);
      const page = Number(query.get("page") ?? 1);
      const items = state.installations.slice((page - 1) * perPage, page * perPage).map(installationObject);
      const headers = {};
      if (page * perPage < state.installations.length) {
        headers.Link = `<${baseUrl}/app/installations?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return json(200, items, headers);
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/installation$/, (request, [owner, repo]) => {
      const denied = requireJwt(request);
      if (denied) return denied;
      const installation = state.installations.find((candidate) => lower(candidate.account.login) === lower(owner));
      if (!installation) return json(404, { message: "Not Found" });
      if (installation.repository_selection === "selected" && !(installation._repositories ?? []).map(lower).includes(lower(`${owner}/${repo}`))) {
        return json(404, { message: "Not Found" });
      }
      return json(200, installationObject(installation));
    }],
    ["POST", /^\/app-manifests\/([^/]+)\/conversions$/, (request, [code]) => {
      if (state.conversion.status !== 201) return json(state.conversion.status, { message: state.conversion.message ?? "Validation failed, or the endpoint has been spammed." });
      return json(201, {
        ...appObject(),
        client_secret: "fixture-client-secret-0123456789",
        webhook_secret: "fixture-webhook-secret-0123456789",
        pem: state.conversionPem,
      });
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/actions\/secrets\/public-key$/, () => json(200, { key_id: secretKey.keyId, key: secretKey.publicKeyBase64 })],
    ["PUT", /^\/repos\/([^/]+)\/([^/]+)\/actions\/secrets\/([^/]+)$/, (request, [owner, repo, name], query, body) => {
      const keys = Object.keys(body ?? {}).sort();
      if (keys.join(",") !== "encrypted_value,key_id") return json(422, { message: "Validation Failed" });
      const secrets = secretsOf(`${owner}/${repo}`);
      const existed = secrets.has(name);
      secrets.set(name, { encrypted_value: body.encrypted_value, key_id: body.key_id });
      return { status: existed ? 204 : 201, body: undefined, headers: {} };
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/actions\/variables\/([^/]+)$/, (request, [owner, repo, name]) => {
      const variables = variablesOf(`${owner}/${repo}`);
      return variables.has(name) ? json(200, { name, value: variables.get(name), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }) : json(404, { message: "Not Found" });
    }],
    ["POST", /^\/repos\/([^/]+)\/([^/]+)\/actions\/variables$/, (request, [owner, repo], query, body) => {
      const variables = variablesOf(`${owner}/${repo}`);
      if (typeof body?.name !== "string" || typeof body?.value !== "string") return json(422, { message: "Validation Failed" });
      if (variables.has(body.name)) return json(409, { message: "Already exists" });
      variables.set(body.name, body.value);
      return json(201, {});
    }],
    ["PATCH", /^\/repos\/([^/]+)\/([^/]+)\/actions\/variables\/([^/]+)$/, (request, [owner, repo, name], query, body) => {
      const variables = variablesOf(`${owner}/${repo}`);
      if (!variables.has(name)) return json(404, { message: "Not Found" });
      variables.set(name, body?.value ?? variables.get(name));
      return { status: 204, body: undefined, headers: {} };
    }],
    ["PUT", /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/disable$/, (request, [owner, repo, workflow]) => {
      state.disabledWorkflows.push(`${owner}/${repo}:${decodeURIComponent(workflow)}`);
      return { status: 204, body: undefined, headers: {} };
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/, (request, [owner, repo]) => {
      const entry = state.repos.get(lower(`${owner}/${repo}`));
      return entry ? json(200, { sha: entry.headSha ?? "a".repeat(40) }) : json(404, { message: "Not Found" });
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/, (request, [owner, repo]) => {
      const entry = state.repos.get(lower(`${owner}/${repo}`));
      return entry ? json(200, { sha: entry.headSha ?? "a".repeat(40), tree: treeOf(entry.files ?? {}), truncated: entry.truncated === true }) : json(404, { message: "Not Found" });
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, (request, [owner, repo, path]) => {
      const entry = state.repos.get(lower(`${owner}/${repo}`));
      const text = entry?.files?.[decodeURIComponent(path)];
      if (text === undefined) return json(404, { message: "Not Found" });
      if (String(request.headers.accept ?? "").includes("raw")) return { status: 200, body: text, headers: { "Content-Type": "text/plain; charset=utf-8" }, raw: true };
      return json(200, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), path: decodeURIComponent(path) });
    }],
    ["GET", /^\/repos\/([^/]+)\/([^/]+)$/, (request, [owner, repo]) => {
      const entry = state.repos.get(lower(`${owner}/${repo}`));
      if (!entry) return json(404, { message: "Not Found" });
      return json(200, {
        id: entry.id,
        name: repo,
        full_name: entry.fullName ?? `${owner}/${repo}`,
        default_branch: entry.defaultBranch ?? "main",
        owner: { login: owner },
        private: entry.private === true,
      });
    }],
  ];

  function takeOverride(entry) {
    const index = state.overrides.findIndex(
      (override) => (override.method === "*" || override.method === entry.method) && patternToRegExp(override.path).test(entry.path) && override.remaining !== 0,
    );
    if (index === -1) return null;
    const override = state.overrides[index];
    if (override.remaining > 0) override.remaining -= 1;
    return override;
  }

  /** The routing core, shared by the HTTP server and the in-process `fetch`: one recorded request in, one { status, body, headers, raw? } out. */
  function dispatch({ method, target, headers: requestHeaders, raw }) {
    const url = new URL(target, "http://fake");
    let body;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request = { method, headers: requestHeaders };
    const authorization = String(requestHeaders.authorization ?? "");
    const jwt = authorization.startsWith("Bearer ") ? jwtOf(request) : null;
    const entry = {
      time: Date.now(),
      method,
      path: url.pathname,
      query: url.search.slice(1),
      host: requestHeaders.host,
      accept: requestHeaders.accept,
      body,
      auth: { present: authorization !== "", kind: jwt ? (jwt.valid ? "jwt" : "token") : "none", jwtValid: jwt?.valid === true, claims: jwt?.valid ? jwt.payload : undefined },
      status: 0,
    };
    log.push(entry);
    let result;
    const override = takeOverride(entry);
    if (override) {
      result = typeof override.response === "function" ? override.response(entry) : override.response;
    } else {
      const route = routes.find(([routeMethod, pattern]) => routeMethod === method && pattern.test(url.pathname));
      if (route) {
        const match = route[1].exec(url.pathname).slice(1).map(decodeURIComponent);
        result = route[2](request, match, url.searchParams, body);
      } else {
        entry.unhandled = true;
        result = json(404, { message: "Not Found (fake GitHub: unhandled route)" });
      }
    }
    entry.status = result.status;
    return result;
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const result = dispatch({ method: request.method, target: request.url, headers: request.headers, raw: Buffer.concat(chunks).toString("utf8") });
      const headers = { ...(result.headers ?? {}) };
      if (result.body === undefined) {
        response.writeHead(result.status, headers);
        response.end();
      } else if (result.raw) {
        response.writeHead(result.status, headers);
        response.end(result.body);
      } else {
        response.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8", ...headers });
        response.end(JSON.stringify(result.body));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  /**
   * A `fetch` that answers from the same routes and the same log without a socket. It is the transport of every in-process
   * run and client of the suites: a socket connect can kill a Windows process on Node.js 24.0 to 24.15 (see no-network.mjs), and
   * undici (the engine of the global fetch) keeps its connection timers in module state, so a test that mocks the timers
   * would also leave a dead timer there for a later mocked test of the same process. The HTTP server below stays for the
   * runs that are real processes (`runCli`) and for the `gh` stand-in.
   */
  async function inProcessFetch(input, init = {}) {
    const parsed = new URL(String(input));
    if (parsed.origin !== baseUrl) throw new TypeError(`fetch failed: ${parsed.origin} is not the fake GitHub (${baseUrl})`);
    const requestHeaders = Object.fromEntries(new Headers(init.headers ?? {}));
    requestHeaders.host ??= parsed.host;
    const result = dispatch({
      method: String(init.method ?? "GET").toUpperCase(),
      target: `${parsed.pathname}${parsed.search}`,
      headers: requestHeaders,
      raw: init.body === undefined || init.body === null ? "" : String(init.body),
    });
    if (result.body === undefined) return new Response(null, { status: result.status, headers: result.headers ?? {} });
    if (result.raw) return new Response(result.body, { status: result.status, headers: result.headers ?? {} });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json; charset=utf-8", ...(result.headers ?? {}) } });
  }

  return {
    url: baseUrl,
    host: `127.0.0.1:${server.address().port}`,
    log,
    state,
    secretKey,
    appKey: key,
    fetch: inProcessFetch,
    /** Recorded requests, optionally filtered by "METHOD /path/:pattern" patterns. */
    requests: (...patterns) => (patterns.length === 0 ? [...log] : log.filter((entry) => patterns.some((pattern) => requestMatches(entry, pattern)))),
    nonGet: () => log.filter((entry) => entry.method !== "GET"),
    /** Replaces an answer: `response` is { status, body, headers } or a function of the recorded request; `times` limits its use. */
    override(method, path, response, times = -1) {
      state.overrides.push({ method, path, response, remaining: times });
    },
    variablesOf: (repo) => Object.fromEntries(variablesOf(repo)),
    secretsOf: (repo) => Object.fromEntries(secretsOf(repo)),
    setVariable: (repo, name, value) => variablesOf(repo).set(name, value),
    setInstallations(installations) {
      state.installations = installations;
    },
    clearLog() {
      log.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** An installation of the fixture App on `login` that covers everything and holds the full permission map. */
export function installationOn(login, extra = {}) {
  return {
    id: 1000 + [...login].reduce((sum, character) => sum + character.charCodeAt(0), 0),
    account: { login, id: 7000 + login.length, type: "User" },
    repository_selection: "all",
    permissions: { ...FIXTURE_PERMISSIONS },
    ...extra,
  };
}
