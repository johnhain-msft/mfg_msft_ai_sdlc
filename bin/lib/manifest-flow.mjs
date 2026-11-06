// The three-step GitHub App manifest flow over a short-lived loopback listener (AC11-AC16): a local
// page posts the manifest to GitHub, GitHub redirects the browser back to /callback with a temporary
// code, and the CLI exchanges that code. The listener is bound to 127.0.0.1 on an operating-system
// assigned port, serves only /register and /callback, and is closed on every exit path.

import crypto from "node:crypto";
import http from "node:http";
import { SdlcError } from "./errors.mjs";

export const FLOW_TIMEOUT_MS = 600000;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** The static page of GET /register: a form that posts the manifest to GitHub, auto-submitted, with a noscript button. */
export function registrationPage({ action, manifest }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Register the GitHub App</title>
</head>
<body>
<p>Sending the GitHub App manifest to GitHub. Review the App on GitHub and confirm its creation there.</p>
<form id="manifest-form" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("manifest-form").submit();</script>
</body>
</html>
`;
}

const resultPage = (message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>sdlc bootstrap</title></head><body><p>${escapeHtml(message)}</p></body></html>
`;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The shutdown guard uses the timers that exist when this module loads, so mocked global timers
// (the tests that drive the ten-minute timeout) cannot keep the listener open.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Stops accepting connections, lets a response that is being written finish, and drops whatever is still open after two seconds. */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const guard = realSetTimeout(() => server.closeAllConnections?.(), 2000);
    server.close(() => {
      realClearTimeout(guard);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

/**
 * Runs the interactive registration and returns whatever `convert(code)` returns for the one valid callback.
 * @param {object} input
 * @param {(redirectUrl: string) => object} input.buildManifest builds the manifest for the bound port
 * @param {string} input.registrationBase https://github.com/settings/apps/new or the organization form
 * @param {(code: string) => Promise<object>} input.convert exchanges the code (exactly one call per valid callback)
 * @param {(url: string) => void|Promise<void>} input.openBrowser
 * @param {{ info: Function, warn: Function }} input.logger
 * @param {object} [input.env] SDLC_BOOTSTRAP_NO_OPEN_BROWSER keeps the browser closed
 * @param {number} [input.timeoutMs] defaults to ten minutes, counted from the moment the /register URL is printed
 * @param {AbortSignal} [input.signal] an interrupt closes the listener and aborts
 * @param {{ onListening?: (address: {address:string, port:number}) => void }} [input.hooks]
 */
export async function runManifestFlow(input) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The listener is bound from here on, and it is closed whatever follows: a callback, the timeout, an interrupt and also a failure
  // of the manifest builder or of a hook, which would otherwise leave the port open for as long as the process lives (AC11).
  try {
    return await serveRegistration(server, input);
  } finally {
    await closeServer(server);
  }
}

/** The part of the flow that needs the bound listener. The caller closes it, however this ends. */
async function serveRegistration(server, { buildManifest, registrationBase, convert, openBrowser, logger, env = process.env, timeoutMs = FLOW_TIMEOUT_MS, signal, hooks }) {
  const state = crypto.randomBytes(32).toString("hex");
  const { address, port } = server.address();
  hooks?.onListening?.({ address, port });
  const origin = `http://127.0.0.1:${port}`;
  const manifest = buildManifest(`${origin}/callback`);
  const action = `${registrationBase}?state=${state}`;

  let settle;
  const outcome = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A rejection can arrive while the browser opener is still running; it is read by `await outcome` below.
  outcome.catch(() => {});
  let callbackSeen = false;

  const respond = (response, status, type, body) => {
    response.writeHead(status, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  };

  server.on("request", (request, response) => {
    const host = String(request.headers.host ?? "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      respond(response, 400, "text/plain", "unexpected Host header\n");
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname !== "/register" && url.pathname !== "/callback") {
      respond(response, 404, "text/plain", "not found\n");
      return;
    }
    if (request.method !== "GET") {
      respond(response, 405, "text/plain", "method not allowed\n");
      return;
    }
    if (url.pathname === "/register") {
      respond(response, 200, "text/html", registrationPage({ action, manifest }));
      return;
    }
    const codes = url.searchParams.getAll("code");
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !safeEqual(states[0], state)) {
      respond(response, 400, "text/plain", "state does not match this run\n");
      settle.reject(new SdlcError("the callback carried a state that does not match this run (possible cross-site request); no code was exchanged and nothing was written", { code: "state-mismatch" }));
      return;
    }
    if (codes.length !== 1 || !CODE_PATTERN.test(codes[0])) {
      respond(response, 400, "text/plain", "code is missing or invalid\n");
      settle.reject(new SdlcError("the callback carried a missing or invalid code (only [A-Za-z0-9_-] is accepted); no code was exchanged and nothing was written", { code: "invalid-code" }));
      return;
    }
    if (callbackSeen) {
      respond(response, 400, "text/plain", "the code was already used\n");
      return;
    }
    callbackSeen = true;
    Promise.resolve()
      .then(() => convert(codes[0]))
      .then(
        (app) => {
          respond(response, 200, "text/html", resultPage("The GitHub App was created. Return to the terminal."));
          settle.resolve(app);
        },
        (error) => {
          respond(response, 502, "text/html", resultPage("GitHub did not accept the registration code. See the terminal."));
          settle.reject(error);
        },
      );
  });

  const onAbort = () => settle.reject(new SdlcError("interrupted before the GitHub App registration finished", { exitCode: 130, code: "interrupted" }));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer;
  try {
    logger.info(`Open ${origin}/register to register the GitHub App (waiting up to ${Math.round(timeoutMs / 60000)} minutes for GitHub to call back).`);
    timer = setTimeout(
      () =>
        settle.reject(
          new SdlcError(
            "no callback was received from GitHub within 10 minutes. If you completed the registration in the browser, " +
              "the App exists and its owner can delete it from the App's settings; run the bootstrap again to register a new one.",
            { code: "callback-timeout" },
          ),
        ),
      timeoutMs,
    );
    if ((env.SDLC_BOOTSTRAP_NO_OPEN_BROWSER ?? "") === "") {
      try {
        await openBrowser(`${origin}/register`);
      } catch (error) {
        logger.warn(`the browser could not be opened (${error.message}); open the URL above yourself`);
      }
    }
    return await outcome;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
