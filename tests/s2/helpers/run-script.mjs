// Calling the S2 scripts in-process (their `run(argv, io)` exports) and watching what they write.

import fs from "node:fs";
import path from "node:path";
import { cleanEnv } from "./stub-server.mjs";

/** Runs a script's `run` with captured output: { code, stdout, stderr }. */
export async function invoke(run, args, io = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { env: cleanEnv(), ...io, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

const WRITERS = new Set(["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "copyFileSync", "cpSync", "mkdtempSync", "truncateSync", "symlinkSync", "linkSync", "chmodSync", "utimesSync"]);

/**
 * A stand-in for `fs` that records every path that a write-class call names, and optionally fails a call.
 * @param {{ failRename?: (from: string, to: string, count: number) => boolean }} [options]
 * @returns {{ fs: typeof fs, writes: string[], renames: string[][] }}
 */
export function recordingFs({ failRename } = {}) {
  const writes = [];
  const renames = [];
  let renameCount = 0;
  const wrapped = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      if (property === "renameSync") {
        return (from, to) => {
          renameCount += 1;
          writes.push(path.resolve(String(from)), path.resolve(String(to)));
          renames.push([path.resolve(String(from)), path.resolve(String(to))]);
          if (failRename?.(String(from), String(to), renameCount)) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
          return value.call(target, from, to);
        };
      }
      if (WRITERS.has(property)) {
        return (...args) => {
          writes.push(path.resolve(String(args[0])));
          if (property === "copyFileSync" || property === "cpSync") writes.push(path.resolve(String(args[1])));
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { fs: wrapped, writes, renames };
}

export const isUnder = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Files below a directory that look like a leftover temporary file or a hidden artifact of an interrupted write. */
export function leftovers(directory) {
  const found = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (/\.tmp$|\.restore$/.test(entry.name)) found.push(child);
    }
  }
  return found;
}
