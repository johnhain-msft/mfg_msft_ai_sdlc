// Hermetic guard (AC55): importing this module makes any socket attempt to a non-loopback address throw.
// Loopback addresses (127.0.0.1, ::1, localhost) and local IPC paths stay open, so the fake GitHub
// server and the loopback listener of the manifest flow keep working.

import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const originalConnect = net.Socket.prototype.connect;

/** Every blocked attempt: { host, port }. */
export const blockedAttempts = [];

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

export function installNoNetwork() {
  if (installed) return;
  installed = true;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args);
    if (!target.local && !LOOPBACK.has(target.host.toLowerCase())) {
      blockedAttempts.push({ host: target.host, port: target.port });
      const error = new Error(`no-network guard: a connection to ${target.host}:${target.port} was refused (the suite is hermetic)`);
      error.code = "ENONETWORK";
      throw error;
    }
    return originalConnect.apply(this, args);
  };
}

export function uninstallNoNetwork() {
  if (!installed) return;
  net.Socket.prototype.connect = originalConnect;
  installed = false;
}

installNoNetwork();
