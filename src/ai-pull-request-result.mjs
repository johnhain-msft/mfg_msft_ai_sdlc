#!/usr/bin/env node
// The run result of an AI adaptation workflow, PortfolioAiPullRequestResult (contract C9, SPEC-04 AC70).
//
//   node src/ai-pull-request-result.mjs --slug <upstreamSlug> --poll-state-result <file>
//
// The finalizer job of an AI adaptation workflow runs the poll-state script first (SPEC-03), which verifies the pull request and prints one JSON line:
// `{"outcome":"noop-no-changes"}` when the agent committed nothing, or the pull request that it verified. This command turns that line into the result of
// the run, `{ outcome, prNumber, prUrl, recordedCommit, adaptedModules, adaptedStudioLabs }`:
//
//   - outcome, prNumber and prUrl are the poll-state script's own: `noop-no-changes` (then both are null), or `pr-opened` / `pr-updated` of the verified
//     pull request (that script decides `pr-updated` when the pull request is the one that its state already recorded);
//   - recordedCommit is UPSTREAM_SHA, the revision that the pull request records;
//   - adaptedModules and adaptedStudioLabs are the sorted base names (without their extension) of the files of the pull request that match the two globs
//     of the edge's `adaptation.pullRequestResult`; both are empty for an edge that names none, and for a run with no pull request.
//
// The result is printed as the last line of standard output and, when GITHUB_OUTPUT is set, appended to it as `result=<json>`. The files of the pull
// request are read with GET /pulls/{number}/files and the App installation token of GH_TOKEN; nothing is written to GitHub.
//
//   exit 0  the result was printed     exit 1  a request failed     exit 2  a flag, the poll-state result or the environment is wrong

import path from "node:path";
import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { resolveIo, runAsMain, workspaceOf } from "./drift/lib/cli.mjs";
import { allowedPattern } from "./adaptation/paths.mjs";
import { findEdgeBySlug } from "./routing/edges.mjs";
import { assertInstallationToken, createRestClient, repoPath, resolveApiBase } from "./routing/rest.mjs";

const OPTIONS = { slug: { type: "string" }, "poll-state-result": { type: "string" } };
const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Z0-9_]{1,64}$/;
const OUTCOMES = new Set(["pr-opened", "pr-updated"]);
const MAX_PAGES = 30;

/** The poll-state script's line: the last non-empty line of its output, as JSON. @throws {UsageError} */
export function parsePollStateResult(text) {
  const last = String(text).split(/\r?\n/).filter((line) => line.trim() !== "").at(-1);
  let value;
  try {
    value = JSON.parse(last ?? "");
  } catch {
    throw new UsageError("the poll-state result is not a JSON line");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError("the poll-state result is not a JSON object");
  if (value.outcome === "noop-no-changes") return { outcome: "noop-no-changes", prNumber: null, prUrl: null };
  if (!OUTCOMES.has(value.outcome) || !Number.isInteger(value.prNumber) || typeof value.prUrl !== "string") {
    throw new UsageError("the poll-state result names neither a no-op nor a verified pull request");
  }
  return { outcome: value.outcome, prNumber: value.prNumber, prUrl: value.prUrl };
}

/** The sorted, de-duplicated base names (without the last extension) of the files that match the glob. */
export function adaptedNames(files, glob) {
  if (typeof glob !== "string" || glob === "") return [];
  const pattern = allowedPattern(glob);
  const names = files.filter((file) => pattern.test(file)).map((file) => path.posix.basename(file).replace(/\.[^.]+$/, ""));
  return [...new Set(names)].sort();
}

/**
 * @param {string[]} argv
 * @param {object} [ioInput] `env`, `cwd`, `fs`, `fetch`, `sleep`, `now`, `stdout`, `stderr`; a test passes fakes for the network and the clock
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    for (const name of ["slug", "poll-state-result"]) if (flags[name] === undefined || flags[name] === "") throw new UsageError(`--${name} is required`);
    if (!SLUG.test(flags.slug)) throw new UsageError("--slug must be an upstreamSlug (A-Z, 0-9 and _)");
    const commit = String(io.env.UPSTREAM_SHA ?? "").trim();
    if (!SHA.test(commit)) throw new UsageError("UPSTREAM_SHA must be 40 lowercase hexadecimal characters");
    const { edge, reason } = findEdgeBySlug(workspaceOf(io), flags.slug, io);
    if (edge === null) throw new UsageError(reason);
    let text;
    try {
      text = io.fs.readFileSync(path.resolve(io.cwd, flags["poll-state-result"]), "utf8");
    } catch (error) {
      throw new UsageError(`the poll-state result cannot be read: ${error.message}`);
    }
    const poll = parsePollStateResult(text);

    let adaptedModules = [];
    let adaptedStudioLabs = [];
    const globs = edge.adaptation?.pullRequestResult ?? {};
    if (poll.prNumber !== null && (globs.adaptedModules !== undefined || globs.adaptedStudioLabs !== undefined)) {
      const token = String(io.env.GH_TOKEN ?? "").trim();
      if (token === "") throw new UsageError("GH_TOKEN is not set: it is the GitHub App installation token of the job");
      try {
        assertInstallationToken(token, "GH_TOKEN");
      } catch (error) {
        throw new UsageError(error.message);
      }
      const client = createRestClient({ baseUrl: resolveApiBase(io.env), token, fetch: io.fetch, sleep: io.sleep, now: io.now, log: (line) => io.stderr(`ai-pull-request-result: ${line}\n`) });
      const { items, truncated } = await client.paginate(`${repoPath(edge.downstreamRepo)}/pulls/${poll.prNumber}/files?per_page=100`, { maxPages: MAX_PAGES });
      if (truncated) throw new Error(`pull request #${poll.prNumber} has more files than the ${MAX_PAGES} pages that are read`);
      const files = items.map((item) => item?.filename).filter((name) => typeof name === "string");
      adaptedModules = adaptedNames(files, globs.adaptedModules);
      adaptedStudioLabs = adaptedNames(files, globs.adaptedStudioLabs);
    }

    const result = { outcome: poll.outcome, prNumber: poll.prNumber, prUrl: poll.prUrl, recordedCommit: commit, adaptedModules, adaptedStudioLabs };
    const line = JSON.stringify(result);
    const output = String(io.env.GITHUB_OUTPUT ?? "").trim();
    if (output !== "") io.fs.appendFileSync(output, `result=${line}\n`);
    io.stdout(`${line}\n`);
    return 0;
  } catch (error) {
    io.stderr(`ai-pull-request-result: ${error?.message ?? error}\n`);
    return error instanceof UsageError || error?.name === "GitHubApiError" ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
