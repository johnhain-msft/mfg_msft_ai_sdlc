#!/usr/bin/env node
// Second pre-agent step of every drift workflow: open pull request deduplication (SPEC-02 AC10, AC26, AC32).
//
//   node src/drift/dedupe-open-prs.mjs --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO"
//
// The target repository is --target-repo, else CONFIGURED_TARGET_REPO. The script lists the open pull requests of the
// target with `GET /repos/{owner}/{repo}/pulls?state=open&per_page=30` (further pages when the repository has more) and
// records those whose head branch matches automation/weekly-audit-*, automation/self-improve-* or sdlc/*, or that carry
// the label content-audit or self-improving-agents, in <out>/open-pr-dedup.json (and the same content in
// <out>/open-prs.json). The agent reads that file before it calls create_pull_request.
//
// Authentication is a GitHub App installation token: GH_APP_INSTALLATION_TOKEN when the caller minted one, else the
// script signs a JSON Web Token with APP_CLIENT_ID and APP_PRIVATE_KEY and exchanges it for a token that is limited to the
// target repository and to read access to its pull requests. A personal access token is refused. The API address is
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
  "api-url": { type: "string" },
  "max-retries": { type: "string" },
  "max-wait-seconds": { type: "string" },
};

export const BRANCH_PREFIXES = ["automation/weekly-audit-", "automation/self-improve-", "sdlc/"];
export const BRANCH_PATTERNS = BRANCH_PREFIXES.map((prefix) => `${prefix}*`);
export const LABELS = ["content-audit", "self-improving-agents"];
export const QUERY = (owner, repo) => `/repos/${owner}/${repo}/pulls?state=open&per_page=30`;

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
      });
    }
    matches.sort((a, b) => a.number - b.number);
    const report = stableJson({
      version: 1,
      repository: target,
      query: `GET ${QUERY(owner, repo)}`,
      inspected: items.length,
      truncated,
      duplicate: matches.length > 0,
      matches,
    });
    writeFilesAtomically(
      [
        { path: path.join(out, "open-pr-dedup.json"), data: report },
        { path: path.join(out, "open-prs.json"), data: report },
      ],
      { fs: io.fs },
    );
    io.stdout(`dedupe-open-prs: ${items.length} open pull request(s) of ${target} inspected${truncated ? " (more exist than were read)" : ""}, ${matches.length} possible duplicate(s) recorded in ${path.join(out, "open-pr-dedup.json")}\n`);
    return 0;
  } catch (error) {
    io.stderr(`dedupe-open-prs: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
