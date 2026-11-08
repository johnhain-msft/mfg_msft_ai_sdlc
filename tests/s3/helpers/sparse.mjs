// A copy of the repository as a cascade job has it after `actions/checkout` with `sparse-checkout: "src\nschemas"` in cone mode: src/, schemas/ and the files at the
// root, and no bin/ or tests/. The dependencies are the repository's own node_modules (what `npm ci --ignore-scripts` installs), linked rather than copied.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abs } from "./fixtures.mjs";

const ROOT_FILES = ["package.json", "package-lock.json", "sdlc.yaml"];

export function sparseCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-sparse-"));
  fs.cpSync(abs("src"), path.join(dir, "src"), { recursive: true });
  fs.cpSync(abs("schemas"), path.join(dir, "schemas"), { recursive: true });
  for (const file of ROOT_FILES) if (fs.existsSync(abs(file))) fs.copyFileSync(abs(file), path.join(dir, file));
  fs.symlinkSync(abs("node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return {
    dir,
    /** A minimal environment: no token, no workspace, nothing that could make a request. */
    environment: () => ({ PATH: process.env.PATH ?? process.env.Path ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: os.tmpdir(), TMP: os.tmpdir() }),
    cleanup() {
      // unlink the link first, so that removing the copy can never reach the repository's own dependencies
      fs.rmSync(path.join(dir, "node_modules"), { recursive: false, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
