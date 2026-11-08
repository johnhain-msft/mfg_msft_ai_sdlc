// Network guard for the hermetic run of the S2 suite (SPEC-02 AC39): `node --require tests/s2/helpers/deny-external-network.cjs`.
//
// Any TCP connection to a host other than loopback (127.0.0.1, ::1, localhost) is refused with an error, and each refusal is
// appended, as one JSON line, to the file named by SDLC_S2_DENY_LOG. Local IPC paths and loopback stay open.

"use strict";

const fs = require("node:fs");
const net = require("node:net");

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const original = net.Socket.prototype.connect;

function targetOf(args) {
  // net.connect() hands Socket.prototype.connect the normalized form [options, callback] as one argument.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return { local: true };
    return { host: String(first.host ?? "localhost"), port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { local: true };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  if (!target.local && !LOOPBACK.has(target.host.toLowerCase())) {
    const line = JSON.stringify({ host: target.host, port: target.port, pid: process.pid });
    if (process.env.SDLC_S2_DENY_LOG) fs.appendFileSync(process.env.SDLC_S2_DENY_LOG, `${line}\n`);
    const error = new Error(`deny-external-network: a connection to ${target.host}:${target.port} was refused (the suite is hermetic)`);
    error.code = "ENONETWORK";
    throw error;
  }
  return original.apply(this, args);
};
