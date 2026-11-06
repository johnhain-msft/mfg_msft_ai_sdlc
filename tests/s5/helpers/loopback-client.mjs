// A loopback HTTP client that runs in a helper process. A TCP connect can kill a process silently on Windows with Node.js 24.0 to
// 24.15 (see no-network.mjs), a test process lives long and does a lot of I/O, and the node test runner then reports the
// whole file as failed with its subtests missing. So a test process never connects: it hosts the listener (an accept is not
// affected) and this client makes the request or the connect attempt from `loopback-client-child.mjs`, a small fresh process.
//
// If the helper dies before it answers, the burst that was in flight is sent again from a new helper (at most MAX_ATTEMPTS in
// all), and `deaths` records each death. A resend is safe: the runtime dies inside the connect call, before a request byte
// leaves, and the bursts are queued, so no earlier request is still in flight when the helper dies. A helper that keeps
// dying is reported, not retried for ever.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./loopback-client-child.mjs", import.meta.url));
// The guard on shutdown uses the timer that exists when this module loads, so a test that mocks the timers cannot stall it.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export const MAX_ATTEMPTS = 3;

/** @param {{ env?: Record<string, string|undefined> }} [options] the environment of the helper processes */
export function createLoopbackClient({ env = process.env } = {}) {
  let helper = null;
  let queue = Promise.resolve();
  let nextId = 1;
  const deaths = [];

  function start() {
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [CHILD], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const current = { child, pending: null, stderr: "", exited: null };
    current.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        if (helper === current) helper = null;
        const pending = current.pending;
        current.pending = null;
        pending?.resolve({ died: true, code, signal, stderr: current.stderr });
        resolve();
      });
      child.on("error", (error) => {
        current.stderr += `${error.message}\n`;
        if (helper === current) helper = null;
        const pending = current.pending;
        current.pending = null;
        pending?.resolve({ died: true, code: null, signal: null, stderr: current.stderr });
        resolve();
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (current.stderr += chunk));
    child.stdin.on("error", () => {}); // a write to a dead helper shows up as its exit
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const reply = JSON.parse(line);
      const pending = current.pending;
      if (pending !== null && reply.id === pending.id) {
        current.pending = null;
        pending.resolve({ died: false, results: reply.results });
      }
    });
    return current;
  }

  function exchange(jobs) {
    helper ??= start();
    const current = helper;
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      current.pending = { id, resolve };
      current.child.stdin.write(`${JSON.stringify({ id, jobs })}\n`);
    });
  }

  async function run(jobs) {
    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await exchange(jobs);
      if (!outcome.died) return outcome.results;
      deaths.push({ code: outcome.code, signal: outcome.signal });
      last = outcome;
    }
    const how = last.signal ? `signal ${last.signal}` : `exit code ${last.code}`;
    throw new Error(`the loopback client helper died ${MAX_ATTEMPTS} times before it answered (${how}): ${last.stderr.trim() || "no output"}`);
  }

  /** Bursts are sent one at a time, in the order they are asked for. */
  function enqueue(jobs) {
    const result = queue.then(() => run(jobs));
    queue = result.catch(() => {});
    return result;
  }

  function unwrap(result) {
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    return { status: result.status, headers: result.headers, text: result.text };
  }

  const client = {
    deaths,
    /**
     * Sends the requests at the same time, from one helper, each on a connection of its own.
     * @param {{ url: string, method?: string, headers?: Record<string, string> }[]} specs
     * @returns {Promise<{ status: number, headers: Record<string, string|string[]>, text: string }[]>}
     */
    async requests(specs) {
      return (await enqueue(specs.map((spec) => ({ kind: "request", ...spec })))).map(unwrap);
    },
    /** One request: { status, headers, text } of the answer. */
    async request(url, options = {}) {
      return (await client.requests([{ url, ...options }]))[0];
    },
    /** Whether a connect to 127.0.0.1 on the port is refused, that is, whether the listener behind it is closed. */
    async refused(port) {
      return (await enqueue([{ kind: "refused", port }]))[0].refused;
    },
    /** Ends the helper once the queued bursts are done. */
    async close() {
      await queue;
      const current = helper;
      if (current === null) return;
      current.child.stdin.end();
      const guard = realSetTimeout(() => current.child.kill(), 5000);
      await current.exited;
      realClearTimeout(guard);
    },
  };
  return client;
}

/** The client that the suites share; it starts its helper on first use and ends it when the test file is done. */
export const loopback = createLoopbackClient();

after(() => loopback.close());
