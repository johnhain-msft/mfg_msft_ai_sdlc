// The loopback client (tests/s5/helpers/loopback-client.mjs): a test process hosts a listener and a helper process makes the
// requests and the connect attempts, so that the test process opens no TCP connection (a connect can kill a process silently
// on Windows with Node.js 24.0 to 24.15, see tests/s5/helpers/no-network.mjs). A helper that dies before it answers is replaced
// and the burst is sent again; one that keeps dying is reported.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ATTEMPTS, createLoopbackClient } from "./helpers/loopback-client.mjs";
import { tcpConnects } from "./helpers/no-network.mjs";

/** A listener in this process; `handler` answers, `requests` records what arrived. */
async function withListener(handler, callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback({ port: server.address().port, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Runs `callback` with a client of its own and ends the client's helper afterwards. */
async function withClient(options, callback) {
  const client = createLoopbackClient(options);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

test("a request is made by a helper process: the answer arrives, the Host header is the job's and the test process opens no TCP connection", async () => {
  await withClient({}, (client) =>
    withListener(
      (request, response) => {
        response.writeHead(201, { "X-Seen": "yes" });
        response.end(`hello ${request.url}`);
      },
      async ({ port, requests }) => {
        const before = tcpConnects.length;
        const response = await client.request(`http://127.0.0.1:${port}/a?b=1`, { headers: { Host: "evil.example:80" } });
        assert.equal(response.status, 201);
        assert.equal(response.headers["x-seen"], "yes");
        assert.equal(response.text, "hello /a?b=1");
        assert.deepEqual(requests, [{ method: "GET", url: "/a?b=1", host: "evil.example:80" }]);
        assert.deepEqual(tcpConnects.slice(before), [], "the connect was the helper's, not this process's");
        assert.deepEqual(client.deaths, []);
      },
    ),
  );
});

test("the requests of one burst are in flight together, and a method other than GET is passed on", async () => {
  await withClient({}, (client) => {
    const waiting = [];
    return withListener(
      (request, response) => {
        waiting.push(response);
        if (waiting.length === 2) for (const pending of waiting) pending.end("both arrived");
      },
      async ({ port, requests }) => {
        let giveUp;
        const stalled = new Promise((resolve, reject) => {
          giveUp = setTimeout(() => reject(new Error("the second request was not sent while the first one was still waiting")), 10000);
        });
        try {
          const answers = await Promise.race([client.requests([{ url: `http://127.0.0.1:${port}/one` }, { url: `http://127.0.0.1:${port}/two`, method: "POST" }]), stalled]);
          assert.deepEqual(answers.map((answer) => answer.text), ["both arrived", "both arrived"]);
        } finally {
          clearTimeout(giveUp);
        }
        assert.deepEqual(requests.map((entry) => `${entry.method} ${entry.url}`).sort(), ["GET /one", "POST /two"]);
      },
    );
  });
});

test("refused() tells a closed port from an open one, and a request to a closed port rejects with the error code", async () => {
  await withClient({}, async (client) => {
    let closedPort;
    await withListener(
      (request, response) => response.end("open"),
      async ({ port }) => {
        assert.equal(await client.refused(port), false, "a listener accepts the connect");
        closedPort = port;
      },
    );
    assert.equal(await client.refused(closedPort), true, "a closed one refuses it");
    await assert.rejects(client.request(`http://127.0.0.1:${closedPort}/`), (error) => error.code === "ECONNREFUSED");
  });
});

test("a helper that dies before it answers is replaced and the burst is sent again", async () => {
  const marker = path.join(os.tmpdir(), `sdlc-s5-loopback-${process.pid}-${Date.now()}.marker`);
  try {
    await withClient({ env: { ...process.env, SDLC_S5_LOOPBACK_CRASH: `once:${marker}` } }, (client) =>
      withListener(
        (request, response) => response.end("answered"),
        async ({ port, requests }) => {
          const response = await client.request(`http://127.0.0.1:${port}/x`);
          assert.equal(response.text, "answered");
          assert.equal(client.deaths.length, 1, "the first helper died");
          assert.equal(requests.length, 1, "and the request reached the listener once, from the second helper");
          assert.equal((await client.request(`http://127.0.0.1:${port}/y`)).text, "answered", "the replacement serves the next burst");
          assert.equal(client.deaths.length, 1);
        },
      ),
    );
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test("a helper that keeps dying is reported after the last attempt, and nothing reaches the listener", async () => {
  await withClient({ env: { ...process.env, SDLC_S5_LOOPBACK_CRASH: "always" } }, (client) =>
    withListener(
      () => {},
      async ({ port, requests }) => {
        await assert.rejects(client.request(`http://127.0.0.1:${port}/x`), (error) => error.message.includes(`died ${MAX_ATTEMPTS} times before it answered (exit code 86)`));
        assert.equal(client.deaths.length, MAX_ATTEMPTS);
        assert.deepEqual(requests, []);
      },
    ),
  );
});
