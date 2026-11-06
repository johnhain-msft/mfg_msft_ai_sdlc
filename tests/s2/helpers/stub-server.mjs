// Network and process stand-ins for the tests/s2 suite (SPEC-02 AC39).
//
//  - createFakeFetch(handler): an in-process `fetch` that opens no socket. It records every request and the greatest number
//    of requests that were in flight together, so that a test can assert that the scripts issue requests serially. The
//    suite uses it wherever it can: a TCP connect can kill a Windows process on Node.js 24.0 to 24.15 (libuv
//    uv_tcp_connect, fixed in 24.16), see tests/s5/helpers/no-network.mjs.
//  - startStubServer(handler): a real HTTP server bound to 127.0.0.1, for the few tests that run a script as a command and
//    let that child process connect to it. The test process only accepts connections; a child that dies of the libuv
//    defect (exit code 3221226505) is started again by runNode.
//  - createClock(): a clock and a sleep that advance together, so that a retry that waits a minute takes no time.
// A handler gets the recorded request ({ method, path, search, pathAndSearch, headers, body, signal }) and returns
// { status, headers, body } (body: a string, or an object that is sent as JSON) or a Response. A handler of the real server may also
// return { delayMs } to answer late, { drop: true } to close the connection without answering, or a promise that never settles to
// keep the request open until the client gives up.

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const lowerKeys = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
const NO_BODY = new Set([101, 204, 205, 304]);

export const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body });

function toResponse(reply) {
  if (reply instanceof Response) return reply;
  const { status = 200, headers = {}, body = "" } = reply;
  const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const withType = typeof body === "object" && !Buffer.isBuffer(body) && !lowerKeys(headers)["content-type"] ? { "content-type": "application/json", ...headers } : headers;
  return new Response(NO_BODY.has(status) ? null : text, { status, headers: withType });
}

/** A promise that settles only when the request is aborted: a response that never comes. A live timer keeps the process up. */
export function hangUntilAbort(entry, limitMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: 200, body: "too late" }), limitMs);
    const abort = () => {
      clearTimeout(timer);
      reject(entry.signal.reason ?? new Error("aborted"));
    };
    if (entry.signal?.aborted) abort();
    else entry.signal?.addEventListener("abort", abort, { once: true });
  });
}

/** @returns {typeof fetch & { state: object, requests: object[] }} */
export function createFakeFetch(handler, { delayMs = 0 } = {}) {
  const state = { requests: [], inflight: 0, maxInflight: 0 };
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const entry = {
      method: (init.method ?? "GET").toUpperCase(),
      url: String(url),
      path: parsed.pathname,
      search: parsed.search,
      pathAndSearch: parsed.pathname + parsed.search,
      host: parsed.host,
      headers: lowerKeys(init.headers),
      body: init.body === undefined ? null : String(init.body),
      signal: init.signal,
    };
    state.requests.push(entry);
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return toResponse(await handler(entry, state));
    } finally {
      state.inflight -= 1;
    }
  }
  return Object.assign(fakeFetch, { state, requests: state.requests });
}

export function createClock(start = Date.UTC(2026, 10, 6, 12, 0, 0)) {
  const clock = {
    time: start,
    waits: [],
    now: () => clock.time,
    sleep: async (milliseconds) => {
      clock.waits.push(milliseconds);
      clock.time += milliseconds;
    },
  };
  return clock;
}

/** A real HTTP server on 127.0.0.1: { url, port, requests, state, close }. */
export async function startStubServer(handler) {
  const state = { requests: [], inflight: 0, maxInflight: 0 };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const parsed = new URL(request.url, "http://127.0.0.1");
      const entry = {
        method: request.method,
        url: request.url,
        path: parsed.pathname,
        search: parsed.search,
        pathAndSearch: parsed.pathname + parsed.search,
        headers: lowerKeys(request.headers),
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null,
      };
      state.requests.push(entry);
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      try {
        const reply = await handler(entry, state);
        if (reply?.drop) {
          request.socket.destroy();
          return;
        }
        if (reply?.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        const { status = 200, headers = {}, body = "" } = reply ?? {};
        const text = typeof body === "string" ? body : JSON.stringify(body);
        response.writeHead(status, typeof body === "string" ? headers : { "content-type": "application/json", ...headers });
        response.end(text);
      } catch (error) {
        response.writeHead(500);
        response.end(String(error?.message ?? error));
      } finally {
        state.inflight -= 1;
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

const CREDENTIAL_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_APP_INSTALLATION_TOKEN",
  "APP_CLIENT_ID",
  "APP_PRIVATE_KEY",
  "GITHUB_API_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKSPACE",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "CONFIGURED_TARGET_REPO",
  "GH_DATA_DIR",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "SDLC_BASE_SHA",
];

/** The environment of a child: the current one without any credential or workflow variable, plus `extra`. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  return { ...env, ...extra };
}

const LIBUV_CRASH = 3221226505;

/** Runs a node script as a command: { code, stdout, stderr }. A child killed by the Windows libuv defect is run again. */
export async function runNode(file, args = [], { env = cleanEnv(), cwd = process.cwd(), retries = 3, timeoutMs = 120000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [file, ...args], { env, cwd, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    if (result.code === LIBUV_CRASH && attempt < retries) continue;
    return result;
  }
}

export function runNodeSync(file, args = [], { env = cleanEnv(), cwd = process.cwd() } = {}) {
  const result = spawnSync(process.execPath, [file, ...args], { env, cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
