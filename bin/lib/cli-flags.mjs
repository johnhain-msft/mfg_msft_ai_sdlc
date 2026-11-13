// Flag parsing for the two entry points. Both accept exactly the invocations of contract C10 (AC8, AC9):
// every unknown flag is refused, so that no secret can be passed on the command line, and every
// check here is pure: nothing is read, written or sent before the arguments are valid.

import { parseArgs } from "node:util";
import { usageError } from "./errors.mjs";
import { isRepoSlug, isValidCron, parseWatchUrl } from "./validators.mjs";

export const ENGINES = Object.freeze(["copilot", "claude", "codex", "gemini", "pi"]);
export const STRATEGIES = Object.freeze([
  "auto",
  "content-and-docs-sync",
  "dependency-and-pattern-modernization",
  "code-quality-and-improvement-scan",
  "custom",
]);
export const MODES = Object.freeze(["auto", "mechanical", "ai-adaptation"]);
export const APP_NAME_MAX_LENGTH = 34;
export const DEFAULT_MANIFEST = "sdlc.yaml";

export const BOOTSTRAP_USAGE =
  "usage: node bin/sdlc-bootstrap.mjs [--manifest sdlc.yaml] [--owner <user-or-org>] [--app-name <up to 34 characters>] " +
  `[--engine ${ENGINES.join("|")}] [--deconflict-upstream-schedules] [--non-interactive]`;

export const ONBOARD_USAGE =
  "usage: node bin/sdlc-onboard.mjs --repo <owner/repo-or-path> [--downstream <owner/repo>] " +
  `[--strategy ${STRATEGIES.join("|")}] [--watch-url <url>]... [--schedule <cron>] [--mode ${MODES.join("|")}] ` +
  "[--instructions <text-or-path>] [--manifest sdlc.yaml]   (or: node bin/sdlc-onboard.mjs <owner/repo> [...])";

function tokenize(argv, spec, usage, { allowPositionals }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: spec, allowPositionals, strict: true, tokens: true });
  } catch (error) {
    throw usageError(`${error.message}\n${usage}`);
  }
  return parsed;
}

function singleValued(tokens, repeatable, usage) {
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option" || repeatable.includes(token.name)) continue;
    if (seen.has(token.name)) throw usageError(`--${token.name} was given more than once\n${usage}`);
    seen.add(token.name);
  }
}

function enumerated(flag, value, members, usage) {
  if (!members.includes(value)) throw usageError(`--${flag} '${value}' is not one of ${members.join(", ")}\n${usage}`);
  return value;
}

/** Attaches the flags that were passed explicitly as a non-enumerable property, so option objects compare equal. */
function withExplicit(options, tokens) {
  const explicit = new Set(tokens.filter((token) => token.kind === "option").map((token) => token.name));
  Object.defineProperty(options, "explicit", { value: explicit, enumerable: false });
  return options;
}

/**
 * @param {string[]} argv
 * @returns {{ manifest: string, owner: string|undefined, appName: string|undefined, engine: string,
 *   deconflictUpstreamSchedules: boolean, nonInteractive: boolean }}
 */
export function parseBootstrapArgs(argv) {
  const { values, tokens } = tokenize(
    argv,
    {
      manifest: { type: "string" },
      owner: { type: "string" },
      "app-name": { type: "string" },
      engine: { type: "string" },
      "deconflict-upstream-schedules": { type: "boolean" },
      "non-interactive": { type: "boolean" },
    },
    BOOTSTRAP_USAGE,
    { allowPositionals: false },
  );
  singleValued(tokens, [], BOOTSTRAP_USAGE);
  for (const flag of ["manifest", "owner", "app-name", "engine"]) {
    if (values[flag] !== undefined && values[flag].trim() === "") throw usageError(`--${flag} must not be empty\n${BOOTSTRAP_USAGE}`);
  }
  const appName = values["app-name"];
  if (appName !== undefined && [...appName].length > APP_NAME_MAX_LENGTH) {
    throw usageError(`--app-name is ${[...appName].length} characters long; GitHub accepts at most ${APP_NAME_MAX_LENGTH}\n${BOOTSTRAP_USAGE}`);
  }
  const engine = values.engine === undefined ? "copilot" : enumerated("engine", values.engine, ENGINES, BOOTSTRAP_USAGE);
  return withExplicit(
    {
      manifest: values.manifest ?? DEFAULT_MANIFEST,
      owner: values.owner,
      appName,
      engine,
      deconflictUpstreamSchedules: values["deconflict-upstream-schedules"] === true,
      nonInteractive: values["non-interactive"] === true,
    },
    tokens,
  );
}

/**
 * @param {string[]} argv
 * @returns {{ repo: string, downstream: string|undefined, strategy: string, watchUrl: {url:string,label:string,kind:string}[],
 *   schedule: string|undefined, mode: string, instructions: string|undefined, manifest: string }}
 */
export function parseOnboardArgs(argv) {
  const { values, positionals, tokens } = tokenize(
    argv,
    {
      repo: { type: "string" },
      downstream: { type: "string" },
      strategy: { type: "string" },
      "watch-url": { type: "string", multiple: true },
      schedule: { type: "string" },
      mode: { type: "string" },
      instructions: { type: "string" },
      manifest: { type: "string" },
    },
    ONBOARD_USAGE,
    { allowPositionals: true },
  );
  singleValued(tokens, ["watch-url"], ONBOARD_USAGE);
  if (positionals.length > 1) throw usageError(`only one positional <owner/repo> is accepted, got ${positionals.length}\n${ONBOARD_USAGE}`);
  if (values.repo !== undefined && positionals.length === 1) {
    throw usageError(`give the repository either as --repo or as one positional argument, not both\n${ONBOARD_USAGE}`);
  }
  const repo = values.repo ?? positionals[0];
  if (repo === undefined || repo.trim() === "") throw usageError(`the repository is required: --repo <owner/repo-or-path> or one positional <owner/repo>\n${ONBOARD_USAGE}`);
  for (const flag of ["downstream", "strategy", "schedule", "mode", "manifest"]) {
    if (values[flag] !== undefined && values[flag].trim() === "") throw usageError(`--${flag} must not be empty\n${ONBOARD_USAGE}`);
  }
  if (values.downstream !== undefined && !isRepoSlug(values.downstream)) {
    throw usageError(`--downstream '${values.downstream}' is not an <owner/repo> repository\n${ONBOARD_USAGE}`);
  }
  const strategy = values.strategy === undefined ? "auto" : enumerated("strategy", values.strategy, STRATEGIES, ONBOARD_USAGE);
  const mode = values.mode === undefined ? "auto" : enumerated("mode", values.mode, MODES, ONBOARD_USAGE);
  if (mode !== "auto" && values.downstream === undefined) {
    throw usageError(`--mode ${mode} needs --downstream: a mode describes the edge to the downstream repository\n${ONBOARD_USAGE}`);
  }
  if (values.schedule !== undefined && !isValidCron(values.schedule)) {
    throw usageError(`--schedule '${values.schedule}' is not a five-field cron expression such as "23 6 * * 1"\n${ONBOARD_USAGE}`);
  }
  const watchUrl = [];
  for (const value of values["watch-url"] ?? []) {
    let entry;
    try {
      entry = parseWatchUrl(value);
    } catch (error) {
      throw usageError(`--watch-url: ${error.message}\n${ONBOARD_USAGE}`);
    }
    if (!watchUrl.some((existing) => existing.url === entry.url)) watchUrl.push(entry);
  }
  return withExplicit(
    {
      repo,
      downstream: values.downstream,
      strategy,
      watchUrl,
      schedule: values.schedule,
      mode,
      instructions: values.instructions,
      manifest: values.manifest ?? DEFAULT_MANIFEST,
    },
    tokens,
  );
}
