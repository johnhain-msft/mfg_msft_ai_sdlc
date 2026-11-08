// A small GitHub REST client over fetch. It never logs a token, it only sends credentials to the
// configured API origin, and it follows pagination (Link rel="next") on the same origin only.

import { SdlcError } from "./errors.mjs";

export const DEFAULT_API_URL = "https://api.github.com";
export const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 60000;
const MAX_PAGES = 1000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** API base URL: GITHUB_API_URL, else api.github.com. Plain http is accepted for loopback addresses only. */
export function resolveApiBase(env = process.env) {
  const raw = (env.GITHUB_API_URL ?? "").trim() || DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SdlcError(`GITHUB_API_URL '${raw}' is not a URL`, { code: "api-url" });
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new SdlcError(`GITHUB_API_URL must use https (plain http is accepted for loopback addresses only), got '${parsed.protocol}//${parsed.host}'`, {
      code: "api-url",
    });
  }
  return parsed.href.replace(/\/+$/, "");
}

/** Human-readable kind of a token, from its documented prefix; the token itself is never part of the result. */
export function tokenKind(token) {
  if (typeof token !== "string" || token === "") return "no token";
  if (token.startsWith("github_pat_")) return "fine-grained personal access token";
  if (token.startsWith("ghp_")) return "classic personal access token";
  if (token.startsWith("gho_")) return "OAuth token (such as the one gh auth login issues)";
  if (token.startsWith("ghu_")) return "GitHub App user access token";
  if (token.startsWith("ghs_")) return "GitHub App installation access token";
  return "token of unknown kind";
}

/** The operator's own REST credential: GH_TOKEN, GITHUB_TOKEN or the one `gh auth token` prints. May be empty. */
export async function resolveOperatorToken({ env, runGh }) {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = (env[name] ?? "").trim();
    if (value !== "") return value;
  }
  const outcome = await runGh(["auth", "token"], { timeoutMs: 30000 });
  return outcome.code === 0 ? outcome.stdout.trim() : "";
}

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) return match[1];
  }
  return null;
}

/**
 * @param {{ baseUrl: string, fetch?: typeof fetch, token?: string, userAgent?: string }} options
 */
export function createApi({ baseUrl, fetch: fetchFn = globalThis.fetch, token = "", userAgent = "sdlc-orchestrator-cli" }) {
  const origin = new URL(baseUrl).origin;

  async function send(method, url, { body, bearer, accept = "application/vnd.github+json" } = {}) {
    const authorization = bearer === undefined ? token : bearer;
    const headers = { Accept: accept, "User-Agent": userAgent, "X-GitHub-Api-Version": API_VERSION };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: payload,
        redirect: method === "GET" ? "follow" : "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
      throw new SdlcError(`${method} ${new URL(url).pathname} could not be sent: ${error?.message ?? error}${cause}`, { code: "network" });
    }
    const text = await response.text();
    let json = null;
    if (text !== "" && /^[\s]*[[{]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 300, headers: response.headers, json, text };
  }

  return {
    baseUrl,
    token,
    kind: tokenKind(token),
    /** Sends one request; HTTP error statuses are returned, not thrown. `bearer` overrides the token (an App JWT, or null for none). */
    request: (method, apiPath, options) => send(method, `${baseUrl}${apiPath}`, options),
    /** GET of every page of a list endpoint; `pick` extracts the items of one page body. */
    async paginate(apiPath, { bearer, pick = (json) => json } = {}) {
      const items = [];
      let url = `${baseUrl}${apiPath}`;
      for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
        const response = await send("GET", url, { bearer });
        if (!response.ok) return { ok: false, status: response.status, json: response.json, items };
        items.push(...pick(response.json));
        const next = parseNextLink(response.headers.get("link"));
        if (next !== null && new URL(next, url).origin !== origin) {
          throw new SdlcError("a paginated response pointed at a different origin; refusing to send credentials there", { code: "network" });
        }
        url = next === null ? null : new URL(next, url).href;
      }
      return { ok: true, status: 200, items };
    },
  };
}
