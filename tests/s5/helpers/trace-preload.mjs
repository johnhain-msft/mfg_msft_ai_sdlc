// Preloaded into a CLI child process (`node --import tests/s5/helpers/trace-preload.mjs bin/...`): it installs the
// no-network guard and records every listener bind, every file-system write and every blocked connection into the
// JSONL file named by SDLC_S5_TRACE, so that a test can assert "zero listener binds, zero file writes" for a run
// that it executes as a real process.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { blockedAttempts } from "./no-network.mjs";

const traceFile = process.env.SDLC_S5_TRACE;
const originalAppend = fs.appendFileSync;
const events = [];

const normalize = (value) => (typeof value === "string" || value instanceof URL ? String(value) : Buffer.isBuffer(value) ? "<buffer>" : String(value));
const isTrace = (target) => traceFile !== undefined && normalize(target) === traceFile;

const WRITERS = [
  "writeFileSync",
  "appendFileSync",
  "renameSync",
  "mkdirSync",
  "copyFileSync",
  "rmSync",
  "unlinkSync",
  "rmdirSync",
  "createWriteStream",
  "writeFile",
  "appendFile",
  "rename",
  "mkdir",
  "copyFile",
  "rm",
];

for (const name of WRITERS) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function recordedWrite(...args) {
    if (!isTrace(args[0])) events.push({ type: "write", op: name, path: normalize(args[0]) });
    return original.apply(this, args);
  };
  const promised = fs.promises[name.replace(/Sync$/, "")];
  if (name.endsWith("Sync") && typeof promised === "function") {
    fs.promises[name.replace(/Sync$/, "")] = function recordedPromiseWrite(...args) {
      if (!isTrace(args[0])) events.push({ type: "write", op: `promises.${name.replace(/Sync$/, "")}`, path: normalize(args[0]) });
      return promised.apply(this, args);
    };
  }
}

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function recordedListen(...args) {
  events.push({ type: "listen", args: args.filter((value) => typeof value !== "function").map(String) });
  return originalListen.apply(this, args);
};

// Named imports of node:fs (import { writeFileSync } from "node:fs") must see the recording wrappers too.
syncBuiltinESMExports();

process.on("exit", () => {
  if (!traceFile) return;
  const lines = [...events, ...blockedAttempts.map((attempt) => ({ type: "blocked", ...attempt }))].map((event) => JSON.stringify(event));
  if (lines.length > 0) originalAppend(traceFile, `${lines.join("\n")}\n`);
});
