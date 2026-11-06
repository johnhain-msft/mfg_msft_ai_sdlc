// Hermetic guard (AC55): importing this module makes any socket attempt to a non-loopback address throw.
// Loopback addresses (127.0.0.1, ::1, localhost) and local IPC paths stay open, so the fake GitHub
// server and the loopback listener of the manifest flow keep working.
//
// The guard also records every loopback TCP connect it lets through (`tcpConnects`), because a connect is a risk on a
// runtime with a known defect. On Windows, Node.js 24.15 (libuv 1.51.0; nodejs/node#63620 reports 24.0 to 24.15) has
// uv_tcp_connect pass an uninitialised OSVERSIONINFOW to RtlGetVersion: undefined behaviour that can corrupt the stack
// cookie of the connect frame (fixed by libuv/libuv#5107, shipped in Node.js 24.16). The process then dies silently with exit
// code 3221226505 (0xC0000409): no stderr, no handler, no report. The node test runner shows that as a test file that failed
// with its subtests missing, at random and mostly under load. So a test process of the S5 suites opens no TCP connection: the
// fake GitHub answers an in-process run in memory (`fake.fetch`), a listener under test is reached by the loopback client
// (a helper process that is replaced if it dies), and the closing check of the suite asserts that `tcpConnects` is empty.

import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const originalConnect = net.Socket.prototype.connect;

/** Every blocked attempt: { host, port }. */
export const blockedAttempts = [];

/** Every loopback TCP connect that the guard let through: { host, port }. Local IPC paths are not TCP and are not listed. */
export const tcpConnects = [];

let installed = false;

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

/**
 * The guard around a `connect` implementation: it throws for a TCP target outside loopback, records a loopback TCP target
 * and hands it, like a local IPC path, to `connect`. The installed guard wraps the real `net.Socket.prototype.connect`;
 * a test can wrap a recording stub instead and exercise the decision without opening a socket.
 */
export function guardConnect(connect) {
  return function guardedConnect(...args) {
    const target = targetOf(args);
    if (!target.local) {
      if (!LOOPBACK.has(target.host.toLowerCase())) {
        blockedAttempts.push({ host: target.host, port: target.port });
        const error = new Error(`no-network guard: a connection to ${target.host}:${target.port} was refused (the suite is hermetic)`);
        error.code = "ENONETWORK";
        throw error;
      }
      tcpConnects.push({ host: target.host, port: target.port });
    }
    return connect.apply(this, args);
  };
}

export function installNoNetwork() {
  if (installed) return;
  installed = true;
  net.Socket.prototype.connect = guardConnect(originalConnect);
}

export function uninstallNoNetwork() {
  if (!installed) return;
  net.Socket.prototype.connect = originalConnect;
  installed = false;
}

installNoNetwork();
