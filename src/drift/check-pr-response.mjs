#!/usr/bin/env node
// Checks the pull request that a drift run opened or updated against contract C5 (SPEC-02 AC27).
//
//   node src/drift/check-pr-response.mjs <response.json> --workflow .github/workflows/drift-<projectKey>.md
//
// It exits 0 only when the response validates against schemas/github-pull-request-response.schema.json (number,
// html_url, head.ref, head.sha and draft, with their types), head.ref matches sdlc/<workflowKey>-YYYY-MM-DD and draft equals
// the safe-outputs.create-pull-request.draft that the workflow renders. A failure exits 1 and names each reason on stderr.
// The script reads two files and writes nothing. It is a verification tool, not a pre-agent step, so it uses the `ajv`
// and `yaml` packages of the repository.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import YAML from "yaml";
import { resolveIo, runAsMain } from "./lib/cli.mjs";

export const BRANCH_PATTERN = /^sdlc\/.+-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "github-pull-request-response.schema.json");

class UsageProblem extends Error {}

/** The `draft` that a rendered drift workflow gives its pull requests, or undefined. */
export function renderedDraft(workflowText) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(workflowText);
  if (match === null) throw new UsageProblem("the workflow has no frontmatter");
  const frontmatter = YAML.parse(match[1]);
  return frontmatter?.["safe-outputs"]?.["create-pull-request"]?.draft;
}

/** @returns {string[]} what is wrong with the response (empty when it is valid) */
export function checkResponse(response, { draft }) {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")));
  if (validate(response)) {
    const problems = [];
    if (!BRANCH_PATTERN.test(response.head.ref)) problems.push(`head.ref '${response.head.ref}' does not match ${BRANCH_PATTERN} (sdlc/<workflowKey>-YYYY-MM-DD)`);
    if (response.draft !== draft) problems.push(`draft is ${response.draft}, but the workflow renders draft: ${draft}`);
    return problems;
  }
  return validate.errors.map((error) => `${error.instancePath === "" ? "the response" : error.instancePath.slice(1).replace(/\//g, ".")} ${error.message}${error.params?.missingProperty ? ` (${error.params.missingProperty})` : ""}`);
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const positional = [];
    let workflow = null;
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--workflow") {
        index += 1;
        workflow = argv[index] ?? null;
      } else if (token.startsWith("--workflow=")) workflow = token.slice("--workflow=".length);
      else if (token.startsWith("--")) throw new UsageProblem(`unknown option '${token}'`);
      else positional.push(token);
    }
    if (positional.length !== 1 || workflow === null || workflow === "") throw new UsageProblem("usage: check-pr-response.mjs <response.json> --workflow <drift workflow .md>");
    let response;
    try {
      response = JSON.parse(io.fs.readFileSync(path.resolve(io.cwd, positional[0]), "utf8"));
    } catch (error) {
      io.stderr(`check-pr-response: ${positional[0]} cannot be read as JSON: ${error.message}\n`);
      return 1;
    }
    const draft = renderedDraft(io.fs.readFileSync(path.resolve(io.cwd, workflow), "utf8"));
    if (typeof draft !== "boolean") throw new UsageProblem(`${workflow} renders no safe-outputs.create-pull-request.draft`);
    const problems = checkResponse(response, { draft });
    if (problems.length > 0) {
      for (const problem of problems) io.stderr(`check-pr-response: ${problem}\n`);
      return 1;
    }
    io.stdout(`check-pr-response: pull request #${response.number} is valid (${response.head.ref}, draft ${response.draft})\n`);
    return 0;
  } catch (error) {
    io.stderr(`check-pr-response: ${error.message}\n`);
    return error instanceof UsageProblem ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
