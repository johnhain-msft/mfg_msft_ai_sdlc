#!/usr/bin/env node
// A recording stand-in for a command that a preflight runs (npm, gh): tests/s3/helpers/git-world.mjs createStubBin.
//
//   node stub-runner.mjs <bin-directory> <tool> <args...>
//
// <bin-directory>/stub-config.json maps a tool to { rules: [{ match, code, stdout, stderr, files }] }; the first rule whose `match` (a regular expression
// over the arguments joined by a space) fits answers. Every call is appended to <bin-directory>/stub-log.jsonl with the arguments, the working directory,
// the variables that the preflight binds and the names of all the variables that the process saw (a secret in a child would show there).

import fs from "node:fs";
import path from "node:path";

const [binDirectory, tool, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(binDirectory, "stub-config.json"), "utf8"));
const line = args.join(" ");
const rule = (config[tool]?.rules ?? []).find((candidate) => new RegExp(candidate.match).test(line));
const BOUND = ["UPSTREAM_DIR", "TARGET_SHA", "LAST_MERGED_SHA", "GITHUB_WORKSPACE", "GH_TOKEN", "STUDIO_ORIGIN"];

fs.appendFileSync(
  path.join(binDirectory, "stub-log.jsonl"),
  `${JSON.stringify({
    tool,
    args,
    cwd: process.cwd(),
    bound: Object.fromEntries(BOUND.map((name) => [name, process.env[name] ?? null])),
    envNames: Object.keys(process.env).sort(),
    matched: rule !== undefined,
  })}\n`,
);

if (rule === undefined) {
  process.stderr.write(`stub ${tool}: no rule for '${line}'\n`);
  process.exit(99);
}
for (const [name, content] of Object.entries(rule.files ?? {})) {
  const file = path.resolve(process.cwd(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.code ?? 0);
