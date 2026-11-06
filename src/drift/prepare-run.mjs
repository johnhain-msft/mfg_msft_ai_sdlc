#!/usr/bin/env node
// First pre-agent step of every drift workflow: the run context (SPEC-02 AC8).
//
//   node src/drift/prepare-run.mjs --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" \
//     --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"
//
// The configured target repository comes from CONFIGURED_TARGET_REPO (or --configured-target-repo), and the target
// checkout is <workspace>/<repository name> unless --checkout names another directory.
//
// The step exits 1, before the agent starts, when a non-empty target_repo differs from the configured repository. It
// writes <out>/run-context.json with the correlation id, the dispatch inputs and the base commit of the target checkout
// (`baseSha`). The verification steps that run after the agent do not read that file for the base commit, because the agent can
// edit anything under <out>: when the runner provides GITHUB_ENV, this step also appends SDLC_BASE_SHA=<base commit> to it, and
// the runner hands that variable to every later step (the validator of the lab audit compares the checkout against it). For a
// dry run it also leaves <out>/dry-run-proposal.json, the file in which the agent records the pull request it would have proposed.
// The script only reads the checkout and writes under --out (and appends the one line to GITHUB_ENV).

import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseBoolean, parseFlags, repoName, requireSlug, UsageError } from "./lib/args.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { BASE_SHA_VARIABLE, outDirectory, resolveIo, runAsMain, stableJson, workspaceOf } from "./lib/cli.mjs";

const OPTIONS = {
  out: { type: "string" },
  "target-repo": { type: "string" },
  "configured-target-repo": { type: "string" },
  checkout: { type: "string" },
  "correlation-id": { type: "string" },
  "extra-instructions": { type: "string" },
  "dry-run": { type: "string" },
};

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,127}$/;
const MAX_EXTRA_INSTRUCTIONS = 64 * 1024;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class RunFailure extends Error {}

/** The correlation id: the given one, else one derived from the run, else "local". */
function resolveCorrelationId(given, env) {
  const text = String(given ?? "").trim();
  if (text !== "") {
    if (!CORRELATION_ID.test(text)) throw new RunFailure("correlation_id must be 1 to 128 characters of letters, digits and . _ : / + = -, starting with a letter or digit");
    return text;
  }
  const runId = String(env.GITHUB_RUN_ID ?? "").trim();
  if (runId === "") return "local";
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim() || "1";
  const derived = `run-${runId}-${attempt}`;
  return CORRELATION_ID.test(derived) ? derived : "local";
}

function baseCommitOf(checkout, env) {
  let output;
  try {
    output = execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? "").trim().split("\n")[0];
    throw new RunFailure(`the base commit of the target checkout '${checkout}' cannot be read: ${detail}`);
  }
  if (!COMMIT.test(output)) throw new RunFailure(`the target checkout '${checkout}' did not report a commit id`);
  return output;
}

/**
 * Hands the base commit to the later steps of the job: the runner reads the file that GITHUB_ENV names when this step ends and sets the
 * variable for every step after it. Outside Actions (no GITHUB_ENV) there is nothing to hand it to. The commit id was checked above to be
 * hexadecimal, so the line cannot carry anything else into the environment file.
 */
function exportBaseCommit(baseSha, io) {
  const file = String(io.env.GITHUB_ENV ?? "").trim();
  if (file === "") return false;
  try {
    io.fs.appendFileSync(file, `${BASE_SHA_VARIABLE}=${baseSha}\n`);
  } catch (error) {
    throw new RunFailure(`the base commit cannot be exported to the later steps through GITHUB_ENV (${file}): ${String(error.message ?? error).split("\n")[0]}`);
  }
  return true;
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const configured = requireSlug(flags["configured-target-repo"] ?? io.env.CONFIGURED_TARGET_REPO, "the configured target repository (CONFIGURED_TARGET_REPO)");
    const requested = String(flags["target-repo"] ?? "").trim();
    if (requested !== "" && requested.toLowerCase() !== configured.toLowerCase()) {
      throw new RunFailure(`target_repo '${requested.slice(0, 120)}' does not match the configured target repository '${configured}'; this workflow only runs on its configured repository`);
    }
    const dryRun = parseBoolean(flags["dry-run"], "dry_run");
    const correlationId = resolveCorrelationId(flags["correlation-id"], io.env);
    const extra = String(flags["extra-instructions"] ?? "");
    if (extra.length > MAX_EXTRA_INSTRUCTIONS) throw new RunFailure(`extra_instructions is longer than ${MAX_EXTRA_INSTRUCTIONS} characters`);
    if (extra.includes("\0")) throw new RunFailure("extra_instructions contains a NUL character");

    const checkoutName = flags.checkout ?? repoName(configured);
    const checkout = path.resolve(workspaceOf(io), checkoutName);
    const baseSha = baseCommitOf(checkout, io.env);
    const exported = exportBaseCommit(baseSha, io);

    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const files = [
      {
        path: path.join(out, "run-context.json"),
        data: stableJson({
          version: 1,
          target_repo: configured,
          checkout: checkoutName,
          baseSha,
          correlation_id: correlationId,
          extra_instructions: extra,
          dry_run: dryRun,
        }),
      },
    ];
    if (dryRun) {
      files.push({
        path: path.join(out, "dry-run-proposal.json"),
        data: stableJson({
          version: 1,
          dry_run: true,
          proposal: null,
          instructions:
            "Replace `proposal` with the pull request you would have proposed: { branch, title, body, draft, labels, reviewers, files }. Do not call create_pull_request.",
        }),
      });
    }
    writeFilesAtomically(files, { fs: io.fs });
    io.stdout(`prepare-run: run context for ${configured} written to ${path.join(out, "run-context.json")} (base ${baseSha.slice(0, 12)}${exported ? `, exported as ${BASE_SHA_VARIABLE}` : ""}, dry run: ${dryRun ? "yes" : "no"}, correlation id ${correlationId})\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`prepare-run: ${error.message}\n`);
      return 2;
    }
    io.stderr(`prepare-run: ${error.message}\n`);
    return 1;
  }
}

await runAsMain(import.meta.url, run);
