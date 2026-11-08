// Node 22 and later no longer expand a directory argument of `node --test`: `node --test tests/s5/` runs
// `node tests/s5/` as a test file and fails to resolve it. This entry makes that form (the one SPEC-05 uses)
// work by running every *.test.mjs of this directory with the regular test runner and passing its exit code on.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(here, name));

// The outer runner marks its children with NODE_TEST_CONTEXT; the nested run must start a fresh one.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const outcome = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env });
process.exitCode = outcome.status ?? 1;
