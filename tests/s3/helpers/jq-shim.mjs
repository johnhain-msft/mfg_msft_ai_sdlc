#!/usr/bin/env node
// A hermetic stand-in for jq, for the tests that run the rendered steps of the custom jobs on a machine that has none. It supports exactly what those steps use:
//   jq [-r] [-e] .key <file>     prints the value of a top-level key of a JSON file (raw for a string); with -e, exits 1 for a missing or null value.
import fs from "node:fs";

const args = process.argv.slice(2);
const flags = args.filter((argument) => /^-[a-zA-Z]+$/.test(argument)).join("");
const [filter, file] = args.filter((argument) => !/^-[a-zA-Z]+$/.test(argument));
const match = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(filter ?? "");
if (!match || !file) {
  process.stderr.write(`jq shim: unsupported invocation: ${args.join(" ")}\n`);
  process.exit(3);
}
let document;
try {
  document = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  process.stderr.write(`jq: error: Could not open ${file}: ${error.message}\n`);
  process.exit(2);
}
const value = document?.[match[1]];
if (value === undefined || value === null) {
  process.stdout.write("null\n");
  process.exit(flags.includes("e") ? 1 : 0);
}
process.stdout.write(`${typeof value === "string" && flags.includes("r") ? value : JSON.stringify(value)}\n`);
