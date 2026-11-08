// A local stand-in for the GitHub REST API, in process (SPEC-03 AC67). It opens no socket: `stub.fetch` is handed to the scripts as `io.fetch`, so a
// test makes no TCP connection at all (a connect can kill a Windows process on Node.js 24.0 to 24.15, see tests/s5/helpers/no-network.mjs) and no
// request can leave the machine. Every request is recorded; a request to a path that the stub does not model is answered 404 and listed in `unhandled`.
//
// The world is plain data: the repositories (their head, ETags, closed and open pull requests, files, runs), the variables, the issues of the orchestrator
// repository and the installations of the App. The routes follow the published REST definitions that the scripts rely on: the conditional GET (ETag,
// If-None-Match, 304), the variables endpoints (GET 200, PATCH 204), the workflow dispatch (200 with run details when return_run_details is true, else
// 204), the issue list with its Link headers, and the access-token exchange of an App installation.

import crypto from "node:crypto";
import { createFakeFetch } from "../../s2/helpers/stub-server.mjs";

export const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body });

const lower = (value) => String(value).toLowerCase();

/** A JSON Web Token has three base64url parts; the signature is checked when the stub holds the App's public key. */
function checkJwt(token, { publicKey, clientId }) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return "not a JWT";
  if (publicKey) {
    const valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
    if (!valid) return "bad signature";
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return "payload is not JSON";
  }
  if (clientId !== undefined && payload.iss !== clientId) return "wrong issuer";
  return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.central] the orchestrator repository, <owner>/<repo>
 * @param {Record<string, object>} [options.repos] repositories by slug (see `repo`)
 * @param {Record<string, unknown>} [options.variables] the Actions variables of the orchestrator repository; an object is stored as its JSON text
 * @param {object[]} [options.installations] [{ id, account: { login } }]
 * @param {string | Buffer} [options.appPublicKey] verifies the signature of every App JWT
 * @param {string} [options.clientId] the issuer that every App JWT must name
 * @param {Set<string> | string[]} [options.acceptTokens] bearer credentials that the repository endpoints accept; every other one is answered 401
 * @param {Record<string, string>} [options.rateLimitHeaders] headers added to every response
 * @param {number} [options.delayMs]
 * @param {string} [options.apiBase] the API origin that the scripts are configured with (GITHUB_API_URL); the absolute links that the stub returns point there
 */
export function createGitHubStub(options = {}) {
  const central = options.central ?? "acme/orchestrator";
  const apiBase = String(options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const variables = new Map(Object.entries(options.variables ?? {}).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]));
  const issues = [...(options.issues ?? [])];
  const installations = options.installations ?? [];
  const accepted = options.acceptTokens === undefined ? null : new Set(options.acceptTokens);
  const repos = new Map();
  const world = {
    central,
    variables,
    issues,
    repos,
    minted: [],
    dispatches: [],
    writes: [],
    comments: [],
    unhandled: [],
    nextIssue: 100,
    nextRun: 9000,
    dispatchReplies: [],
    interceptors: [],
    issuePageSize: 100,
  };

  const repo = (slug, config = {}) => {
    const key = lower(slug);
    if (!repos.has(key)) {
      repos.set(key, {
        slug,
        defaultBranch: "main",
        head: null,
        etag: null,
        pullsEtag: null,
        closedPulls: [],
        openPullsByHead: {},
        pulls: {},
        files: {},
        filesAtRef: {},
        runs: {},
        runList: null,
        ...config,
      });
    } else {
      Object.assign(repos.get(key), config);
    }
    return repos.get(key);
  };
  for (const [slug, config] of Object.entries(options.repos ?? {})) repo(slug, config);
  if (!repos.has(lower(central))) repo(central);

  const rate = options.rateLimitHeaders ?? { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1893456000" };
  const reply = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...rate, ...headers }, body });
  const notFound = () => reply(404, { message: "Not Found" });

  const issuePage = (entry) => {
    const page = Number(new URL(entry.url).searchParams.get("page") ?? "1");
    const size = world.issuePageSize;
    const open = issues.filter((issue) => issue.state !== "closed");
    const slice = open.slice((page - 1) * size, page * size);
    const next = page * size < open.length ? { link: `<${apiBase}/repos/${central}/issues?state=open&per_page=${size}&page=${page + 1}>; rel="next"` } : {};
    return reply(200, slice, next);
  };

  async function handle(entry) {
    const { method, path } = entry;
    const url = new URL(entry.url);
    const auth = entry.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    for (const interceptor of world.interceptors) {
      if (interceptor.method !== method || !interceptor.match(path, url, entry)) continue;
      if (interceptor.times !== undefined && interceptor.used >= interceptor.times) continue;
      interceptor.used += 1;
      const answer = await interceptor.answer(entry, world);
      if (answer !== undefined) return answer.status === undefined ? reply(200, answer) : { ...answer, headers: { ...rate, ...(answer.headers ?? {}) } };
    }

    if (path.startsWith("/app/")) {
      const problem = checkJwt(bearer, { publicKey: options.appPublicKey, clientId: options.clientId });
      if (problem) return reply(401, { message: `A JSON web token could not be decoded (${problem})` });
      if (method === "GET" && path === "/app/installations") return reply(200, installations);
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (method === "POST" && mint) {
        const installation = installations.find((candidate) => String(candidate.id) === mint[1]);
        if (!installation) return notFound();
        const body = JSON.parse(entry.body ?? "{}");
        const token = `ghs_minted${String(world.minted.length + 1).padStart(2, "0")}${crypto.randomBytes(6).toString("hex")}`;
        world.minted.push({ token, installation: installation.account.login, repositories: body.repositories, permissions: body.permissions });
        return reply(201, { token, expires_at: "2030-01-01T00:00:00Z", permissions: body.permissions, repository_selection: "selected" });
      }
      return notFound();
    }

    if (accepted !== null && !accepted.has(bearer) && !world.minted.some((entryMinted) => entryMinted.token === bearer)) {
      return reply(401, { message: "Bad credentials" });
    }

    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "repos" || parts.length < 3) {
      world.unhandled.push(`${method} ${path}`);
      return notFound();
    }
    const slug = `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}`;
    const rest = parts.slice(3).map(decodeURIComponent);
    const target = repos.get(lower(slug));

    // the orchestrator repository: variables, dispatches, issues, runs
    if (lower(slug) === lower(central)) {
      if (rest[0] === "actions" && rest[1] === "variables" && rest.length === 3) {
        const name = rest[2];
        if (method === "GET") return variables.has(name) ? reply(200, { name, value: variables.get(name), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }) : reply(404, { message: "Not Found" });
        if (method === "PATCH") {
          if (!variables.has(name)) return reply(404, { message: "Not Found" });
          const body = JSON.parse(entry.body ?? "{}");
          if (typeof body.value !== "string" || body.name !== name) return reply(422, { message: "Validation Failed" });
          variables.set(name, body.value);
          world.writes.push({ name, value: body.value, authorization: auth });
          return reply(204, "");
        }
      }
      if (rest[0] === "actions" && rest[1] === "workflows" && rest[3] === "dispatches" && method === "POST") {
        const body = JSON.parse(entry.body ?? "{}");
        const record = { file: rest[2], body, headers: entry.headers };
        world.dispatches.push(record);
        const queued = world.dispatchReplies.shift();
        if (queued !== undefined) return typeof queued === "function" ? queued(record, world) : queued;
        if (body.return_run_details === true) {
          const id = world.nextRun;
          world.nextRun += 1;
          record.runId = id;
          return reply(200, { workflow_run_id: id, run_url: `${apiBase}/repos/${central}/actions/runs/${id}`, html_url: `https://github.com/${central}/actions/runs/${id}` });
        }
        return reply(204, "");
      }
      if (rest[0] === "issues" && rest.length === 1 && method === "GET") return issuePage(entry);
      if (rest[0] === "issues" && rest.length === 1 && method === "POST") {
        const body = JSON.parse(entry.body ?? "{}");
        const issue = { number: world.nextIssue, title: body.title, body: body.body, labels: body.labels ?? [], state: "open", html_url: `https://github.com/${central}/issues/${world.nextIssue}`, authorization: auth };
        world.nextIssue += 1;
        issues.push(issue);
        return reply(201, issue);
      }
      if (rest[0] === "issues" && rest[2] === "comments" && method === "POST") {
        const issue = issues.find((candidate) => String(candidate.number) === rest[1]);
        if (!issue) return notFound();
        const body = JSON.parse(entry.body ?? "{}");
        world.comments.push({ issue: issue.number, body: body.body, authorization: auth });
        return reply(201, { id: world.comments.length, html_url: `${issue.html_url}#issuecomment-${world.comments.length}`, body: body.body });
      }
    }

    if (target === undefined) return notFound();

    if (rest.length === 0 && method === "GET") return reply(200, { full_name: target.slug, default_branch: target.defaultBranch });

    // one run by its id, in any repository: the run of the orchestrator that a state records as in flight, and the runs of an upstream that a capture script records
    // (GET /repos/{owner}/{repo}/actions/runs/{run_id} answers the same object as the listing: it names its workflow_id)
    if (rest[0] === "actions" && rest[1] === "runs" && rest.length === 3 && method === "GET") {
      const run = target.runs?.[rest[2]];
      return run ? reply(200, run) : notFound();
    }

    if (rest[0] === "commits" && method === "GET") {
      const ref = rest.slice(1).join("/");
      if (ref !== target.defaultBranch && ref !== "HEAD" && ref !== target.head) return reply(404, { message: "No commit found for SHA: " + ref });
      const headers = target.etag === null ? {} : { etag: target.etag };
      if (target.etag !== null && entry.headers["if-none-match"] === target.etag) return reply(304, "", headers);
      return reply(200, { sha: target.head, commit: { message: "a commit" } }, headers);
    }

    if (rest[0] === "pulls" && rest.length === 1 && method === "GET") {
      const state = url.searchParams.get("state");
      if (state === "open") return reply(200, target.openPullsByHead[url.searchParams.get("head")] ?? []);
      const headers = target.pullsEtag === null ? {} : { etag: target.pullsEtag };
      if (target.pullsEtag !== null && entry.headers["if-none-match"] === target.pullsEtag) return reply(304, "", headers);
      return reply(200, target.closedPulls, headers);
    }
    if (rest[0] === "pulls" && rest.length === 2 && method === "GET") {
      const pr = target.pulls[rest[1]];
      return pr ? reply(200, pr) : notFound();
    }

    if (rest[0] === "contents" && method === "GET") {
      const file = rest.slice(1).join("/");
      const ref = url.searchParams.get("ref");
      const text = target.filesAtRef[ref]?.[file] ?? target.files[file];
      if (text === undefined) return notFound();
      return reply(200, { type: "file", encoding: "base64", name: file.split("/").pop(), path: file, sha: sha1(text), size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") });
    }

    if (rest[0] === "actions" && rest[1] === "runs" && rest.length === 2 && method === "GET") {
      const list = target.runList ?? Object.values(target.runs);
      return reply(200, { total_count: list.length, workflow_runs: list });
    }

    world.unhandled.push(`${method} ${path}`);
    return notFound();
  }

  const fake = createFakeFetch(handle, { delayMs: options.delayMs });
  const requests = fake.requests;

  return {
    fetch: fake,
    requests,
    world,
    variables,
    issues,
    repo,
    /** The parsed JSON of a variable, or null. */
    variable(name) {
      return variables.has(name) ? JSON.parse(variables.get(name)) : null;
    },
    setVariable(name, value) {
      variables.set(name, typeof value === "string" ? value : JSON.stringify(value));
    },
    /** Answers the requests that match with `answer(entry, world)` (a reply, or undefined to fall through) before the routes do. */
    inject(method, match, answer, { times } = {}) {
      const matcher = typeof match === "string" ? (path) => path.includes(match) : match instanceof RegExp ? (path, url) => match.test(path + url.search) : match;
      world.interceptors.push({ method, match: matcher, answer: typeof answer === "function" ? answer : () => answer, times, used: 0 });
    },
    /** Every recorded request that satisfies the method and the path test. */
    calls(method, match) {
      const test = match === undefined ? () => true : typeof match === "string" ? (request) => request.pathAndSearch.includes(match) : (request) => match.test(request.pathAndSearch);
      return requests.filter((request) => (method === undefined || request.method === method) && test(request));
    },
    get unhandled() {
      return world.unhandled;
    },
  };
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** A pull request object as the list and get endpoints return it. */
export function pullRequest({ number, state = "open", merged = false, headSha, headRef = "feature", htmlUrl, mergeCommitSha = null }) {
  return {
    number,
    state,
    merged,
    merged_at: merged ? "2026-11-05T12:00:00Z" : null,
    merge_commit_sha: mergeCommitSha,
    html_url: htmlUrl ?? `https://github.com/acme/portal/pull/${number}`,
    head: { ref: headRef, sha: headSha ?? "f".repeat(40) },
  };
}
