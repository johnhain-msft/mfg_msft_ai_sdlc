#!/usr/bin/env node
// Second pre-agent step of every drift workflow: open pull request deduplication (SPEC-02 AC10, AC26, AC32).
//
//   node src/drift/dedupe-open-prs.mjs --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" \
//     --close-older-key "<the close-older-key of this workflow>" --upkeep-strategy "<its upkeepStrategy>"
//
// The target repository is --target-repo, else CONFIGURED_TARGET_REPO. The script lists the open pull requests of the
// target with `GET /repos/{owner}/{repo}/pulls?state=open&per_page=30` (further pages when the repository has more) and
// records those whose head branch matches automation/weekly-audit-*, automation/self-improve-* or sdlc/*, or that carry
// the label content-audit or self-improving-agents, in <out>/open-pr-dedup.json (and the same content in
// <out>/open-prs.json). The agent reads that file before it calls create_pull_request.
//
// `sdlc/*` is every pull request of the orchestrator (every drift workflow of every project that has the same target repository), so a match
// does not always make a duplicate. Each match therefore says whose it is and what this workflow does about it:
//  - belongsTo "current-workflow": the body carries the marker `<!-- gh-aw-close-key: <key> -->` that gh-aw embeds for this workflow's
//    --close-older-key. It is an earlier pull request of this workflow, which the new one replaces (`close-older-pull-requests: true`).
//    decision "supersede": no reason to skip.
//  - belongsTo "implementation": the workflow is known (--close-older-key is given) and the head branch is sdlc/implement-report-<number>, the pull
//    request that implements an earlier drift report (SPEC-02 AC45). The items of that report are in this run's baseline, so this run does not list
//    them again and its own pull request cannot duplicate it. decision "ignore".
//  - belongsTo "another-workflow-or-schedule": any other match, which is a pull request of another workflow of the orchestrator or of the
//    target's own scheduled workflows. Its `upkeep` is "weekly-audit" or "self-improve" when its head branch (after automation/ or sdlc/) or its
//    label says so, else null. decision "ignore" when both it and this workflow have an upkeep and the two differ (a self-improvement pull
//    request is no duplicate of a content audit; this workflow's upkeep follows from --upkeep-strategy: content-and-docs-sync is
//    "weekly-audit", code-quality-and-improvement-scan is "self-improve"), else "skip": what is not known to be another upkeep counts as the same.
// `duplicate` is true when some match has the decision "skip", and then the agent does not call create_pull_request. Without
// --close-older-key and --upkeep-strategy nothing is known about this workflow and every match is "skip".
//
// Authentication is a GitHub App installation token: GH_APP_INSTALLATION_TOKEN when the caller minted one, else the
// script signs a JSON Web Token with APP_CLIENT_ID and APP_PRIVATE_KEY and exchanges it for a token that is limited to the
// target repository and to read access to its pull requests. A token that is not an App installation token (a personal access token, an
// OAuth token, a user access token of an App) is refused before any request. The API address is
// GITHUB_API_URL (or --api-url). Requests are serial and a rate-limited response is retried as the server states; when it
// stays limited, or anything else goes wrong, the step exits 1 and writes nothing: an unknown state is never "no duplicate".
// The script sends this one read and, for an App credential, the token request; it writes nothing to the target.

import path from "node:path";
import { parseFlags, requireSlug, UsageError } from "./lib/args.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { outDirectory, resolveIo, runAsMain, stableJson } from "./lib/cli.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, resolveApiBase } from "./lib/github-client.mjs";

const OPTIONS = {
  out: { type: "string" },
  "target-repo": { type: "string" },
  "close-older-key": { type: "string" },
  "upkeep-strategy": { type: "string" },
  "api-url": { type: "string" },
  "max-retries": { type: "string" },
  "max-wait-seconds": { type: "string" },
};

export const BRANCH_PREFIXES = ["automation/weekly-audit-", "automation/self-improve-", "sdlc/"];
export const BRANCH_PATTERNS = BRANCH_PREFIXES.map((prefix) => `${prefix}*`);
export const LABELS = ["content-audit", "self-improving-agents"];
export const QUERY = (owner, repo) => `/repos/${owner}/${repo}/pulls?state=open&per_page=30`;

/** The upkeep that each of the two labels, and the working branch stem of each, stands for. */
const UPKEEP_OF_LABEL = { "content-audit": "weekly-audit", "self-improving-agents": "self-improve" };
const UPKEEP_OF_STEM = [
  ["weekly-audit-", "weekly-audit"],
  ["self-improve-", "self-improve"],
];
/** The upkeep of a workflow, from its upkeepStrategy; any other strategy has no upkeep of the target's own schedules to tell apart. */
export const UPKEEP_OF_STRATEGY = { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" };
/** The head branch of the pull request that implements drift report <number> (SPEC-02 AC45). */
export const IMPLEMENTATION_HEAD = /^sdlc\/implement-report-[1-9][0-9]*$/;

/** Why a pull request counts as a possible duplicate: [] when it does not. */
export function matchReasons(pull) {
  const reasons = [];
  const ref = String(pull?.head?.ref ?? "");
  BRANCH_PREFIXES.forEach((prefix, position) => {
    if (ref.startsWith(prefix)) reasons.push(`head branch matches ${BRANCH_PATTERNS[position]}`);
  });
  const labels = (Array.isArray(pull?.labels) ? pull.labels : []).map((label) => String(label?.name ?? ""));
  for (const label of LABELS) if (labels.includes(label)) reasons.push(`carries the label ${label}`);
  return reasons;
}

/** A close-older key as gh-aw writes it into the marker of a pull request body (generate_footer.cjs: lower case, runs of other characters are one dash). */
export function normalizeCloseOlderKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** Whether a pull request is an earlier pull request of the workflow whose close-older key is given: its body carries gh-aw's marker for that key. */
export function belongsToWorkflow(pull, closeOlderKey) {
  const key = normalizeCloseOlderKey(closeOlderKey);
  return key !== "" && String(pull?.body ?? "").includes(`<!-- gh-aw-close-key: ${key} -->`);
}

/** The upkeep that a pull request is for, by its head branch (after automation/ or sdlc/) and its labels: "weekly-audit", "self-improve" or null (none, or both). */
export function upkeepOf(pull) {
  const stem = String(pull?.head?.ref ?? "").replace(/^(?:automation|sdlc)\//, "");
  const found = new Set(UPKEEP_OF_STEM.filter(([prefix]) => stem.startsWith(prefix)).map(([, upkeep]) => upkeep));
  for (const label of Array.isArray(pull?.labels) ? pull.labels : []) {
    const upkeep = Object.hasOwn(UPKEEP_OF_LABEL, String(label?.name ?? "")) ? UPKEEP_OF_LABEL[String(label.name)] : undefined;
    if (upkeep !== undefined) found.add(upkeep);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * What the workflow does about a match: "supersede" (its own earlier pull request, replaced through close-older-pull-requests), "ignore" (the pull
 * request of another upkeep, or the implementation of an earlier drift report) or "skip" (a possible duplicate: the agent does not call
 * create_pull_request).
 * @param {object} pull a pull request of the list
 * @param {{ closeOlderKey: string | null, upkeep: string | null }} workflow
 */
export function decide(pull, workflow) {
  if (workflow.closeOlderKey !== null && belongsToWorkflow(pull, workflow.closeOlderKey)) return { belongsTo: "current-workflow", upkeep: upkeepOf(pull), decision: "supersede" };
  const upkeep = upkeepOf(pull);
  if (workflow.closeOlderKey !== null && IMPLEMENTATION_HEAD.test(String(pull?.head?.ref ?? ""))) return { belongsTo: "implementation", upkeep, decision: "ignore" };
  const other = workflow.upkeep !== null && upkeep !== null && upkeep !== workflow.upkeep;
  return { belongsTo: "another-workflow-or-schedule", upkeep, decision: other ? "ignore" : "skip" };
}

function positiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new UsageError(`${label} must be a whole number of at least 0`);
  return number;
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const target = requireSlug(flags["target-repo"] ?? io.env.CONFIGURED_TARGET_REPO, "the target repository (--target-repo or CONFIGURED_TARGET_REPO)");
    const [owner, repo] = target.split("/");
    // What this workflow is: the key under which gh-aw marks its pull requests, and its upkeep. Both are optional; without them every match is a possible duplicate.
    const closeOlderKey = flags["close-older-key"] === undefined || flags["close-older-key"].trim() === "" ? null : normalizeCloseOlderKey(flags["close-older-key"]);
    if (closeOlderKey === "") throw new UsageError("--close-older-key must contain a letter or a digit");
    const strategy = String(flags["upkeep-strategy"] ?? "").trim();
    const workflow = { closeOlderKey, upkeep: Object.hasOwn(UPKEEP_OF_STRATEGY, strategy) ? UPKEEP_OF_STRATEGY[strategy] : null };
    const baseUrl = resolveApiBase({ GITHUB_API_URL: flags["api-url"] ?? io.env.GITHUB_API_URL });
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const client = createGitHubClient({
      baseUrl,
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
      maxRateLimitRetries: positiveInteger(flags["max-retries"], "--max-retries", 3),
      maxWaitMs: positiveInteger(flags["max-wait-seconds"], "--max-wait-seconds", 300) * 1000,
    });

    let token = String(io.env.GH_APP_INSTALLATION_TOKEN ?? "").trim();
    if (token !== "") {
      assertInstallationToken(token, "GH_APP_INSTALLATION_TOKEN");
    } else {
      const clientId = String(io.env.APP_CLIENT_ID ?? "").trim();
      const privateKeyPem = String(io.env.APP_PRIVATE_KEY ?? "");
      if (clientId === "" || privateKeyPem.trim() === "") {
        throw new GitHubApiError("no GitHub App credential: set APP_CLIENT_ID and APP_PRIVATE_KEY (or GH_APP_INSTALLATION_TOKEN)");
      }
      token = await mintInstallationToken({
        client,
        clientId,
        privateKeyPem,
        owner,
        repo,
        permissions: { pull_requests: "read" },
        nowMs: io.now(),
      });
    }

    const { items, truncated } = await client.paginate(QUERY(owner, repo), { bearer: token });
    const matches = [];
    for (const pull of items) {
      const reasons = matchReasons(pull);
      if (reasons.length === 0) continue;
      matches.push({
        number: pull.number,
        headRef: String(pull.head?.ref ?? ""),
        url: String(pull.html_url ?? ""),
        draft: pull.draft === true,
        labels: (Array.isArray(pull.labels) ? pull.labels : []).map((label) => String(label?.name ?? "")).sort(),
        reasons,
        ...decide(pull, workflow),
      });
    }
    matches.sort((a, b) => a.number - b.number);
    const count = (decision) => matches.filter((match) => match.decision === decision).length;
    const report = stableJson({
      version: 1,
      repository: target,
      query: `GET ${QUERY(owner, repo)}`,
      inspected: items.length,
      truncated,
      closeOlderKey: workflow.closeOlderKey,
      upkeep: workflow.upkeep,
      duplicate: count("skip") > 0,
      matches,
    });
    writeFilesAtomically(
      [
        { path: path.join(out, "open-pr-dedup.json"), data: report },
        { path: path.join(out, "open-prs.json"), data: report },
      ],
      { fs: io.fs },
    );
    io.stdout(`dedupe-open-prs: ${items.length} open pull request(s) of ${target} inspected${truncated ? " (more exist than were read)" : ""}, ${matches.length} possible duplicate(s) recorded in ${path.join(out, "open-pr-dedup.json")} (${count("skip")} to skip for, ${count("supersede")} of this workflow to supersede, ${count("ignore")} of another upkeep or the implementation of an earlier report)\n`);
    return 0;
  } catch (error) {
    io.stderr(`dedupe-open-prs: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
