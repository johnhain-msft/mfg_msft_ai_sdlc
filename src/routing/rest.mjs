// The GitHub REST client of the S3 scripts (SPEC-03 AC11, AC27, AC30, AC32, AC39): the router and the poll-state script.
//
//  - Requests are issued serially: a second request waits for the first, however the caller schedules them [F61].
//  - A rate-limited response (429, or 403 with x-ratelimit-remaining: 0, a retry-after header or a rate-limit message) is waited out in the order
//    of AC27: the primary limit first (x-ratelimit-remaining 0: wait until x-ratelimit-reset), else retry-after, else at least 60 seconds with
//    an exponential back-off [F61]; when both the reset and retry-after are present the later of the two, because the documentation forbids a retry
//    before either. That is not the order of the drift client (retry-after first), and nothing here is shared with it. The waits
//    of one run never add up to more than the budget that the caller sets (the timeout of the router job); a wait that would pass it fails the request.
//  - Every rate-limit decision is logged with the status and the three header values that it acted on (AC27); a token is never logged.
//  - A 403 that is not a rate limit, a 401 and every other unexpected status are errors that carry the status, the request path and the
//    X-Accepted-GitHub-Permissions header (AC32). A status that the caller did not expect is never read as an empty result.
//  - A redirect is not followed: a credential goes only to the configured API origin, over https (plain http for a loopback address only).
//  - A GET or a PATCH is repeated, twice at most, after a network error or a 502, 503 or 504; a POST never is, because a dispatch is not idempotent.
//
// The network, the clock and the sleep are injected, so that a test runs it with a fake clock and no socket.

import { API_VERSION, assertInstallationToken, resolveApiBase } from "../drift/lib/github-client.mjs";

export { API_VERSION, assertInstallationToken, resolveApiBase };

const IDEMPOTENT = new Set(["GET", "HEAD", "PATCH", "PUT", "DELETE"]);
const TRANSIENT = new Set([502, 503, 504]);
const REDIRECTS = new Set([301, 302, 307, 308]);

/** The wait after a rate limit without any header: this long, doubled for every further attempt (AC27). */
export const FALLBACK_WAIT_MS = 60000;
/** One more second after x-ratelimit-reset: the instant is whole seconds and the clock of the runner is not the server's. */
export const RESET_MARGIN_MS = 1000;

export class RestError extends Error {
  /**
   * @param {string} message
   * @param {{ kind?: string, status?: number | null, method?: string, path?: string, rateLimit?: object | null, permissions?: string | null, body?: unknown }} [details]
   * `kind` is one of "rate-limit", "budget", "permission", "http" and "network".
   */
  constructor(message, { kind = "http", status = null, method = "", path = "", rateLimit = null, permissions = null, body = null } = {}) {
    super(message);
    this.name = "RestError";
    this.kind = kind;
    this.status = status;
    this.method = method;
    this.path = path;
    this.rateLimit = rateLimit;
    this.permissions = permissions;
    this.body = body;
  }
}

const header = (headers, name) => {
  const value = headers?.get?.(name);
  return value === null || value === undefined ? null : String(value);
};

/** The rate-limit evidence of a response, for the log and for the failure issue. */
export function rateLimitEvidence(status, headers) {
  return {
    status,
    remaining: header(headers, "x-ratelimit-remaining"),
    reset: header(headers, "x-ratelimit-reset"),
    retryAfter: header(headers, "retry-after"),
  };
}

const show = (value) => (value === null || value === undefined ? "-" : String(value));

/** One line that names what a rate-limit decision acted on. */
export function describeRateLimit(evidence) {
  return `HTTP ${evidence.status}; x-ratelimit-remaining=${show(evidence.remaining)}, x-ratelimit-reset=${show(evidence.reset)}, retry-after=${show(evidence.retryAfter)}`;
}

/** True for a response that is a rate limit and not a refusal: 429, or a 403 that carries one of the signs of a limit. */
export function isRateLimited(status, headers, message = "") {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (header(headers, "retry-after") !== null) return true;
  if (header(headers, "x-ratelimit-remaining")?.trim() === "0") return true;
  return /rate limit/i.test(String(message));
}

/**
 * Milliseconds to wait before the next attempt after a rate limit, in the order of SPEC-03 AC27 and without ever retrying earlier than the documentation allows
 * (REST API rate limits, 'Exceeding the rate limit': do not retry before x-ratelimit-reset when x-ratelimit-remaining is 0, and, when retry-after is present, not
 * before that many seconds):
 * 1. the primary limit: x-ratelimit-remaining is 0, so wait until x-ratelimit-reset (the instant, in whole seconds, plus a second);
 * 2. otherwise retry-after (a number of seconds, or an HTTP date); when both are there the later of the two, because neither may be retried before;
 * 3. otherwise at least 60 seconds, doubled for every earlier attempt.
 * @param {Headers} headers
 * @param {{ now: () => number, attempt: number }} input `attempt` counts the earlier attempts of the same request from 0
 * @returns {{ ms: number, basis: "x-ratelimit-reset" | "retry-after" | "back-off" }}
 */
export function rateLimitWait(headers, { now, attempt }) {
  const remaining = header(headers, "x-ratelimit-remaining");
  const reset = header(headers, "x-ratelimit-reset");
  const primary = remaining !== null && remaining.trim() === "0" && reset !== null && reset.trim() !== "" && Number.isFinite(Number(reset)) ? Math.max(0, Number(reset) * 1000 - now()) + RESET_MARGIN_MS : null;
  let advised = null;
  const retryAfter = header(headers, "retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) advised = Math.max(0, seconds) * 1000;
    else if (!Number.isNaN(Date.parse(retryAfter))) advised = Math.max(0, Date.parse(retryAfter) - now());
  }
  if (primary !== null && advised !== null) return advised > primary ? { ms: advised, basis: "retry-after" } : { ms: primary, basis: "x-ratelimit-reset" };
  if (primary !== null) return { ms: primary, basis: "x-ratelimit-reset" };
  if (advised !== null) return { ms: advised, basis: "retry-after" };
  return { ms: FALLBACK_WAIT_MS * 2 ** attempt, basis: "back-off" };
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function nextLink(linkHeader, base) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) return new URL(match[1], base).href;
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl API origin and prefix, without a trailing slash
 * @param {string} [options.token] the bearer credential that a call uses unless it names another
 * @param {typeof fetch} [options.fetch]
 * @param {(milliseconds: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log] receives the rate-limit decisions
 * @param {number} [options.deadlineMs] the instant (on the clock of `now`) that no wait may pass; the budget of the run
 * @param {number} [options.maxRateLimitRetries] retries of one request after a rate limit (default 5)
 * @param {number} [options.maxTransientRetries] retries of a GET or PATCH after a network error or a 502, 503, 504 (default 2)
 * @param {number} [options.timeoutMs] per request (default 60 s)
 */
export function createRestClient(options) {
  const {
    baseUrl,
    token = "",
    fetch: fetchFn = globalThis.fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
    log = () => {},
    userAgent = "sdlc-orchestrator-routing",
    deadlineMs = Number.POSITIVE_INFINITY,
    maxRateLimitRetries = 5,
    maxTransientRetries = 2,
    timeoutMs = 60000,
  } = options;
  const origin = new URL(baseUrl).origin;
  const secrets = new Set([token].filter((value) => value !== ""));
  const requests = [];
  let tail = Promise.resolve();

  const serially = (task) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const redact = (text) => {
    let out = String(text);
    for (const secret of secrets) out = out.split(secret).join("***");
    return out;
  };

  const absolute = (apiPath) => (/^https?:\/\//.test(apiPath) ? apiPath : `${baseUrl}${apiPath}`);

  async function once(method, url, { body, bearer, headers: extra }) {
    const credential = bearer === undefined ? token : bearer;
    if (credential) secrets.add(credential);
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

  const pathOf = (url) => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  /** The error for a response that the caller did not expect (never a rate limit that is still being waited out). */
  function failure(method, url, response, expected) {
    const message = response.json?.message ? `: ${response.json.message}` : "";
    const permissions = header(response.headers, "x-accepted-github-permissions");
    const limited = isRateLimited(response.status, response.headers, response.json?.message ?? response.text);
    const evidence = limited ? rateLimitEvidence(response.status, response.headers) : null;
    const kind = limited ? "rate-limit" : response.status === 401 || response.status === 403 ? "permission" : "http";
    const accepted = permissions === null ? "" : `; X-Accepted-GitHub-Permissions: ${permissions}`;
    // a redirect is never followed (the credential goes to the configured origin only): it is reported with its target, because the manifest names a repository that moved
    const location = REDIRECTS.has(response.status) ? header(response.headers, "location") : null;
    const moved = location === null ? "" : `; it redirects to ${location} and a redirect is not followed, so sdlc.yaml has to name the repository where it is now`;
    const wanted = expected ? ` (expected ${expected.join(" or ")})` : "";
    return new RestError(redact(`${method} ${pathOf(url)} returned HTTP ${response.status}${wanted}${message}${accepted}${moved}`), {
      kind,
      status: response.status,
      method,
      path: pathOf(url),
      rateLimit: evidence,
      permissions,
      body: response.json,
    });
  }

  async function send(method, url, callOptions) {
    const target = `${method} ${new URL(url).pathname}`;
    const retriesAllowed = callOptions.rateLimitRetries ?? maxRateLimitRetries;
    let rateLimitRetries = 0;
    let transientRetries = 0;
    for (;;) {
      let response;
      requests.push({ method, url });
      try {
        response = await once(method, url, callOptions);
      } catch (error) {
        if (IDEMPOTENT.has(method) && transientRetries < maxTransientRetries) {
          const wait = 1000 * 2 ** transientRetries;
          if (now() + wait > deadlineMs) {
            throw new RestError(redact(`${target} could not be sent (${error?.message ?? error}) and the budget of the run leaves no time to repeat it`), { kind: "budget", method, path: pathOf(url) });
          }
          await sleep(wait);
          transientRetries += 1;
          continue;
        }
        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw new RestError(redact(`${target} could not be sent: ${error?.message ?? error}${cause}`), { kind: "network", method, path: pathOf(url) });
      }
      if (isRateLimited(response.status, response.headers, response.json?.message ?? response.text)) {
        // a caller that paces its own retries (the dispatch of AC39 allows three attempts in all) gets the limited response and its headers
        if (callOptions.rateLimitHandling === "caller") return { response, url };
        const evidence = rateLimitEvidence(response.status, response.headers);
        if (rateLimitRetries >= retriesAllowed) {
          if (retriesAllowed > 0) log(`rate limit: ${target} is still limited after ${rateLimitRetries} retries (${describeRateLimit(evidence)}); no further attempt`);
          throw failure(method, url, response, null);
        }
        const { ms, basis } = rateLimitWait(response.headers, { now, attempt: rateLimitRetries });
        if (now() + ms > deadlineMs) {
          log(`rate limit: ${target} answered ${describeRateLimit(evidence)}; the wait of ${Math.ceil(ms / 1000)} s (${basis}) passes the budget of the run, so it is not taken`);
          throw new RestError(redact(`${target} is rate limited and the wait of ${Math.ceil(ms / 1000)} s that the server asks for passes the budget of this run (${describeRateLimit(evidence)})`), {
            kind: "budget",
            status: response.status,
            method,
            path: pathOf(url),
            rateLimit: evidence,
            permissions: header(response.headers, "x-accepted-github-permissions"),
          });
        }
        log(`rate limit: ${target} answered ${describeRateLimit(evidence)}; waiting ${Math.ceil(ms / 1000)} s (${basis}), retry ${rateLimitRetries + 1} of ${retriesAllowed}`);
        await sleep(ms);
        rateLimitRetries += 1;
        continue;
      }
      if (TRANSIENT.has(response.status) && IDEMPOTENT.has(method) && transientRetries < maxTransientRetries) {
        const wait = 1000 * 2 ** transientRetries;
        if (now() + wait <= deadlineMs) {
          await sleep(wait);
          transientRetries += 1;
          continue;
        }
      }
      return { response, url };
    }
  }

  const run = (method, apiPath, callOptions = {}) => serially(() => send(method, absolute(apiPath), callOptions));

  return {
    baseUrl,
    now,
    sleep,
    /** Every request line that was sent, as { method, url }, in order (a retry is listed again). */
    requests,
    /** One request; a status that is not a rate limit is returned as it is, a rate limit that outlasts the retries or the budget is thrown. */
    async request(method, apiPath, callOptions = {}) {
      const { response } = await run(method, apiPath, callOptions);
      return response;
    },
    /**
     * One request whose status must be one of `expect` (default 200). Any other status throws a RestError that names the status, the path and the
     * X-Accepted-GitHub-Permissions header when there is one.
     */
    async requestJson(method, apiPath, { expect = [200], ...callOptions } = {}) {
      const { response, url } = await run(method, apiPath, callOptions);
      if (!expect.includes(response.status)) throw failure(method, url, response, expect);
      return response;
    },
    /** The RestError for a response that a caller of `request` does not accept. */
    unexpected(method, apiPath, response, expect = null) {
      return failure(method, absolute(apiPath), response, expect);
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
        const { response } = await serially(() => send("GET", url, { bearer }));
        if (!response.ok) throw failure("GET", url, response, [200]);
        const page = pick(response.json);
        if (!Array.isArray(page)) throw new RestError(`GET ${pathOf(url)} did not return a list`, { kind: "http", status: response.status, method: "GET", path: pathOf(url) });
        items.push(...page);
        pages += 1;
        const next = nextLink(response.headers.get("link"), url);
        if (next !== null && new URL(next).origin !== origin) {
          throw new RestError("a paginated response pointed at a different origin; the credential is not sent there", { kind: "http", method: "GET", path: pathOf(url) });
        }
        url = next;
      }
      return { items, truncated, pages };
    },
  };
}

/** The `owner` and `repo` of a slug, each encoded for a path segment. */
export function repoPath(slug) {
  const [owner, ...rest] = String(slug).split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(rest.join("/"))}`;
}

/** A path inside a repository, each segment encoded and the slashes kept (a file path or a branch name). */
export const encodePath = (value) => String(value).split("/").map(encodeURIComponent).join("/");
