// A small GitHub REST client for the drift scripts (SPEC-02 AC32, AC9).
//
//  - Requests are issued serially: a second request waits for the first, however the caller schedules them.
//  - A rate-limited response (429, or 403 with retry-after, x-ratelimit-remaining: 0 or a rate-limit message) is
//    retried after the time the server states: retry-after, else x-ratelimit-reset, else a minute that doubles with
//    every retry. After the bounded number of retries the call fails; it is never read as an empty result.
//  - Between two writes the client leaves at least a second (the documented guidance for many POST/PATCH requests).
//  - Credentials go only to the configured API origin, over https (plain http only for a loopback address), and a
//    personal access token or an OAuth token is refused: every call of these scripts uses an App installation token.
//
// The network, the clock and the sleep are injected, so a test runs it with a fake clock and no socket.

export const DEFAULT_API_URL = "https://api.github.com";
export const API_VERSION = "2022-11-28";

/** What a token is, from its documented prefix; the token itself is never part of the answer. */
export function tokenKind(token) {
  const text = String(token ?? "");
  if (text.startsWith("github_pat_") || text.startsWith("ghp_")) return "personal access token";
  if (text.startsWith("gho_")) return "OAuth token";
  if (text.startsWith("ghu_")) return "App user access token";
  if (text.startsWith("ghs_")) return "App installation token";
  return "token of unknown kind";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PATCH", "PUT", "DELETE"]);
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const SERVER_ERRORS = new Set([502, 503, 504]);

export class GitHubApiError extends Error {
  constructor(message, { status = null, rateLimited = false, body = null } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.rateLimited = rateLimited;
    this.body = body;
  }
}

/** The API base URL: GITHUB_API_URL, else api.github.com; https only, except for a loopback address. */
export function resolveApiBase(env = process.env) {
  const raw = String(env.GITHUB_API_URL ?? "").trim() || DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GitHubApiError(`GITHUB_API_URL '${raw}' is not a URL`);
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new GitHubApiError(`GITHUB_API_URL must use https (plain http is accepted for a loopback address only), got '${parsed.protocol}//${parsed.host}'`);
  }
  return parsed.href.replace(/\/+$/, "");
}

/** Throws when a token is a personal access token or an OAuth token: these scripts authenticate as the App only. */
export function assertInstallationToken(token, label = "the token") {
  const kind = tokenKind(token);
  if (kind === "personal access token" || kind === "OAuth token") {
    throw new GitHubApiError(`${label} is a ${kind}; a GitHub App installation token is required, and no personal credential is used`);
  }
  return token;
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Milliseconds to wait before retrying a rate-limited response. */
export function rateLimitWaitMs(headers, { now, attempt }) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now());
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && reset.trim() !== "" && Number.isFinite(Number(reset))) {
    // the reset instant is whole seconds; one more second keeps a skewed clock from retrying a moment early
    return Math.max(0, Number(reset) * 1000 - now()) + 1000;
  }
  return 60000 * 2 ** attempt;
}

function isRateLimited(status, headers, message) {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (headers.get("retry-after") !== null) return true;
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit/i.test(message);
}

/**
 * @param {object} options
 * @param {string} options.baseUrl API origin and prefix, without a trailing slash
 * @param {string} [options.token] bearer credential used when a call gives none
 * @param {typeof fetch} [options.fetch]
 * @param {(milliseconds: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {number} [options.maxRateLimitRetries] retries after a rate-limited response (default 3)
 * @param {number} [options.maxServerRetries] retries of an idempotent request after a 502/503/504 or a network error (default 2)
 * @param {number} [options.maxWaitMs] a longer wait is not taken: the call fails instead (default 5 minutes)
 * @param {number} [options.minMutationGapMs] time left between two writes (default 1000)
 * @param {number} [options.timeoutMs] per request (default 60 s)
 */
export function createGitHubClient(options) {
  const {
    baseUrl,
    token = "",
    fetch: fetchFn = globalThis.fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
    userAgent = "sdlc-orchestrator-drift",
    maxRateLimitRetries = 3,
    maxServerRetries = 2,
    maxWaitMs = 300000,
    minMutationGapMs = 1000,
    timeoutMs = 60000,
  } = options;
  const origin = new URL(baseUrl).origin;
  let tail = Promise.resolve();
  let lastMutationAt = null;
  const requests = [];

  const serially = (task) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const redact = (text) => (token ? String(text).split(token).join("***") : String(text));

  async function once(method, url, { body, bearer, headers: extra }) {
    const credential = bearer === undefined ? token : bearer;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": userAgent, "X-GitHub-Api-Version": API_VERSION, ...extra };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetchFn(url, { method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let json = null;
    if (/^\s*[[{]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 300, headers: response.headers, json, text };
  }

  async function send(method, url, callOptions) {
    const target = `${method} ${new URL(url).pathname}`;
    if (MUTATING.has(method) && lastMutationAt !== null) {
      const remaining = minMutationGapMs - (now() - lastMutationAt);
      if (remaining > 0) await sleep(remaining);
    }
    let rateLimitRetries = 0;
    let serverRetries = 0;
    for (;;) {
      let response;
      requests.push({ method, url });
      try {
        response = await once(method, url, callOptions);
      } catch (error) {
        if (IDEMPOTENT.has(method) && serverRetries < maxServerRetries) {
          await sleep(1000 * 2 ** serverRetries);
          serverRetries += 1;
          continue;
        }
        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw new GitHubApiError(redact(`${target} could not be sent: ${error?.message ?? error}${cause}`));
      }
      if (isRateLimited(response.status, response.headers, response.json?.message ?? response.text)) {
        if (rateLimitRetries >= maxRateLimitRetries) {
          throw new GitHubApiError(`${target} is still rate limited after ${rateLimitRetries} retries (HTTP ${response.status})`, { status: response.status, rateLimited: true, body: response.json });
        }
        const wait = rateLimitWaitMs(response.headers, { now, attempt: rateLimitRetries });
        if (wait > maxWaitMs) {
          throw new GitHubApiError(`${target} is rate limited and the server asks for ${Math.ceil(wait / 1000)} s, more than the ${Math.floor(maxWaitMs / 1000)} s this run waits`, { status: response.status, rateLimited: true, body: response.json });
        }
        await sleep(wait);
        rateLimitRetries += 1;
        continue;
      }
      if (SERVER_ERRORS.has(response.status) && IDEMPOTENT.has(method) && serverRetries < maxServerRetries) {
        await sleep(1000 * 2 ** serverRetries);
        serverRetries += 1;
        continue;
      }
      if (MUTATING.has(method)) lastMutationAt = now();
      return response;
    }
  }

  const absolute = (apiPath) => (/^https?:\/\//.test(apiPath) ? apiPath : `${baseUrl}${apiPath}`);

  return {
    baseUrl,
    /** Every request line that was sent, as { method, url }, in order (a retry is listed again). */
    requests,
    /** One request; an HTTP error status is returned, a rate limit or a network failure is thrown. */
    request: (method, apiPath, callOptions = {}) => serially(() => send(method, absolute(apiPath), callOptions)),
    /** One request whose status must be one of `expect`; anything else throws with the API's message. */
    async requestJson(method, apiPath, { expect = [200], ...callOptions } = {}) {
      const response = await serially(() => send(method, absolute(apiPath), callOptions));
      if (!expect.includes(response.status)) {
        const message = response.json?.message ? `: ${response.json.message}` : "";
        throw new GitHubApiError(redact(`${method} ${new URL(absolute(apiPath)).pathname} returned HTTP ${response.status}${message}`), { status: response.status, body: response.json });
      }
      return response.json;
    },
    /** Every page of a list endpoint, following rel="next" links on the API origin only. */
    async paginate(apiPath, { bearer, maxPages = 10, pick = (json) => json } = {}) {
      const items = [];
      let url = absolute(apiPath);
      let pages = 0;
      let truncated = false;
      while (url !== null) {
        if (pages >= maxPages) {
          truncated = true;
          break;
        }
        const response = await serially(() => send("GET", url, { bearer }));
        if (!response.ok) {
          const message = response.json?.message ? `: ${response.json.message}` : "";
          throw new GitHubApiError(redact(`GET ${new URL(url).pathname} returned HTTP ${response.status}${message}`), { status: response.status, body: response.json });
        }
        const page = pick(response.json);
        if (!Array.isArray(page)) throw new GitHubApiError(`GET ${new URL(url).pathname} did not return a list`);
        items.push(...page);
        pages += 1;
        const next = nextLink(response.headers.get("link"), url);
        if (next !== null && new URL(next).origin !== origin) {
          throw new GitHubApiError("a paginated response pointed at a different origin; the credential is not sent there");
        }
        url = next;
      }
      return { items, truncated, pages };
    },
  };
}

function nextLink(header, base) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) return new URL(match[1], base).href;
  }
  return null;
}
