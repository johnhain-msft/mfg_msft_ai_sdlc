// A file-write spy: records the path argument of every mutating fs call made in-process while `body` runs.
import fs from "node:fs";
import path from "node:path";

const SPIED = ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "copyFileSync", "renameSync", "unlinkSync", "mkdtempSync", "cpSync"];

export async function recordWrites(body) {
  const writes = [];
  const originals = {};
  for (const name of SPIED) {
    originals[name] = fs[name];
    fs[name] = function recorded(target, ...rest) {
      // Copy reads its first argument; only the destination is mutated. Rename mutates both paths.
      if (name === "copyFileSync" || name === "cpSync") {
        writes.push(path.resolve(String(rest[0])));
      } else {
        writes.push(path.resolve(String(target)));
        if (name === "renameSync") writes.push(path.resolve(String(rest[0])));
      }
      return originals[name].call(this, target, ...rest);
    };
  }
  try {
    await body();
  } finally {
    for (const name of SPIED) fs[name] = originals[name];
  }
  return writes;
}
