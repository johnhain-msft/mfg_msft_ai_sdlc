// Helper process of tests/s5/helpers/loopback-client.mjs: it makes the loopback HTTP requests and the TCP connect attempts that
// a test would otherwise make itself. It is a plain process, without the no-network guard, and it answers one burst at a
// time: a line of JSON { id, jobs } on stdin, a line of JSON { id, results } on stdout.
//
// SDLC_S5_LOOPBACK_CRASH makes it die before it answers, so that the tests of the retry need no real crash: "always", or
// "once:<marker file>" (it dies when the marker does not exist yet and creates the marker first).

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import readline from "node:readline";

const CRASH = process.env.SDLC_S5_LOOPBACK_CRASH ?? "";
const SIMULATED_CRASH_EXIT_CODE = 86;

function simulateCrash() {
  if (CRASH === "always") process.exit(SIMULATED_CRASH_EXIT_CODE);
  if (CRASH.startsWith("once:")) {
    const marker = CRASH.slice("once:".length);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "died");
      process.exit(SIMULATED_CRASH_EXIT_CODE);
    }
  }
}

const failure = (error) => ({ ok: false, error: error.message, code: error.code });

/** One HTTP request on a connection of its own (no keep-alive). The Host header is whatever the job gives. */
function request({ url, method = "GET", headers = {} }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const outgoing = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ ok: true, status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", (error) => resolve(failure(error)));
    });
    outgoing.on("error", (error) => resolve(failure(error)));
    outgoing.end();
  });
}

/** Whether a connect to the port of 127.0.0.1 is refused (the listener behind it is closed). */
function refused({ port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, refused: false });
    });
    socket.once("error", (error) => resolve({ ok: true, refused: error.code === "ECONNREFUSED", code: error.code }));
  });
}

const JOBS = { request, refused };

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  simulateCrash();
  const { id, jobs } = JSON.parse(line);
  const results = await Promise.all(jobs.map((job) => JOBS[job.kind](job)));
  process.stdout.write(`${JSON.stringify({ id, results })}\n`);
});
// The parent closes stdin when it is done; the bursts that are still running keep the process alive until they answer.
