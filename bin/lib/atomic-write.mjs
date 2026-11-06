// Atomic writes (AC51): each file is written to a temporary file in its own directory and then renamed over the
// target, so a failure leaves the previous bytes. Several files are renamed one after the other and rolled back
// together; a file whose new bytes equal the old ones is not touched at all.

import crypto from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

/**
 * @param {{ path: string, text: string }[]} files absolute paths and the new UTF-8 text
 * @param {typeof nodeFs} [fs] the file system functions to use (a test injects a failing rename)
 * @returns {{ originals: Map<string, Buffer|null>, changed: string[] }} the previous bytes of every file (null when it did not exist)
 */
export function writeFilesAtomically(files, fs = nodeFs) {
  const originals = new Map();
  const pending = [];
  for (const { path: target, text } of files) {
    const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
    originals.set(target, before);
    const after = Buffer.from(text, "utf8");
    if (before !== null && before.equals(after)) continue;
    pending.push({ target, after });
  }
  const temporaries = [];
  const renamed = [];
  try {
    for (const { target, after } of pending) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      temporaries.push(temporary);
      fs.writeFileSync(temporary, after);
    }
    for (const { target } of pending) {
      const temporary = temporaries[renamed.length];
      fs.renameSync(temporary, target);
      renamed.push(target);
    }
  } catch (error) {
    for (const temporary of temporaries) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // best effort
      }
    }
    try {
      restoreFiles(new Map(renamed.map((target) => [target, originals.get(target)])), nodeFs);
    } catch {
      // the original failure is the one worth reporting
    }
    throw error;
  }
  return { originals, changed: pending.map((entry) => entry.target) };
}

/** Puts previous bytes back (or deletes a file that did not exist), each through a temporary file and a rename. */
export function restoreFiles(originals, fs = nodeFs) {
  for (const [target, bytes] of originals) {
    if (bytes === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.restore`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  }
}
