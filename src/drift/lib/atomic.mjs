// Atomic artifact writes (SPEC-02 AC38).
//
// Each file is written to a temporary file in its own directory and then renamed over the target. Several files are
// renamed one after the other and rolled back together: when any step fails, no temporary file, no truncated file and
// no new directory remains, and a file that existed before has its previous bytes again. A file whose new bytes equal
// the old ones is not touched at all, so a second identical run leaves every file (and its timestamp) alone.

import crypto from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));

function removeQuietly(fs, target) {
  try {
    fs.rmSync(target, { force: true, recursive: true });
  } catch {
    // best effort: the failure being reported is the one that matters
  }
}

/**
 * @param {{ path: string, data: string | Buffer }[]} files absolute target paths and their new content
 * @param {{ fs?: typeof nodeFs }} [options] a test injects a file system whose rename fails
 * @returns {{ written: string[], unchanged: string[] }}
 */
export function writeFilesAtomically(files, { fs = nodeFs } = {}) {
  const staged = [];
  const renamed = [];
  const unchanged = [];
  const createdDirectories = [];
  try {
    for (const file of files) {
      const target = path.resolve(file.path);
      const data = toBuffer(file.data);
      const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (previous !== null && previous.equals(data)) {
        unchanged.push(target);
        continue;
      }
      const directory = path.dirname(target);
      const created = fs.mkdirSync(directory, { recursive: true });
      if (typeof created === "string") createdDirectories.push(created);
      const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      staged.push({ target, temporary, previous });
      fs.writeFileSync(temporary, data);
    }
    for (const entry of staged) {
      fs.renameSync(entry.temporary, entry.target);
      renamed.push(entry);
    }
  } catch (error) {
    for (const entry of staged) removeQuietly(fs, entry.temporary);
    for (const entry of renamed.reverse()) {
      if (entry.previous === null) removeQuietly(fs, entry.target);
      else {
        try {
          fs.writeFileSync(entry.target, entry.previous);
        } catch {
          // the original failure is the one worth reporting
        }
      }
    }
    for (const directory of createdDirectories.reverse()) removeQuietly(fs, directory);
    throw error;
  }
  return { written: staged.map((entry) => entry.target), unchanged };
}
