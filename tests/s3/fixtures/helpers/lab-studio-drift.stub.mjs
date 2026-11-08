// A hermetic stand-in for src/lab-studio-drift.mjs: the studio drift helper of contract C7 (2)(a), which SPEC-04 implements and SPEC-03 only runs. It exists
// only inside the fixtures of the router's tests; the production helper is not part of SPEC-03, and the router never substitutes this file for a missing one.
//
// It answers what lab-studio-drift.stub.json beside it says ({ code, stdout, stderr }; an object `stdout` is printed as JSON) and appends how it was called
// to lab-studio-drift.log.jsonl, so that a test can see the arguments (and that none of them is --accept).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "lab-studio-drift.stub.json"), "utf8"));
fs.appendFileSync(path.join(here, "lab-studio-drift.log.jsonl"), `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), upstreamDir: process.env.UPSTREAM_DIR ?? null })}\n`);
if (config.stdout !== undefined) process.stdout.write(typeof config.stdout === "string" ? config.stdout : `${JSON.stringify(config.stdout)}\n`);
if (config.stderr) process.stderr.write(config.stderr);
process.exit(config.code ?? 0);
