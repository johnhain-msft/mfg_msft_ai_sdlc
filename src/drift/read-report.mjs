#!/usr/bin/env node
// Second pre-agent step of every implementation workflow: the drift report that the run implements (SPEC-02 AC45).
//
//   node src/drift/read-report.mjs --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --report-issue "$REPORT_ISSUE" \
//     --project-key <projectKey> --author "<appSlug>[bot]"
//
// The target repository is --target-repo, else CONFIGURED_TARGET_REPO. The script reads the issue --report-issue of that repository with
// `GET /repos/{owner}/{repo}/issues/{number}` and the open pull requests of its implementation branch with
// `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:sdlc/implement-report-{number}&per_page=10`, and writes <out>/report.md (the title, the
// address and the body of the report) and <out>/report.json (the same facts as data, the working branch of the run and the open implementation
// pull requests) for the agent. It does so only for a drift report of this project that the App filed: an open issue, not a pull request, opened
// by --author, labelled drift-report, whose title contains `Drift report: <projectKey> ` (two projects can share a target repository, and
// their reports differ only in the key). Anything else stops the run before the agent starts, with exit code 1 and nothing written: a
// report_issue that is not a positive whole number, an issue that is not such a report, a read that fails. A missing option that the workflow
// always passes is a usage error (exit code 2).
//
// Authentication is a GitHub App installation token: GH_APP_INSTALLATION_TOKEN when the caller minted one, else the script signs a JSON Web
// Token with APP_CLIENT_ID and APP_PRIVATE_KEY and exchanges it for a token that is limited to the target repository and to issues: read and
// pull_requests: read. A token that is not an App installation token is refused before any request (SPEC-02 AC9). The API address is
// GITHUB_API_URL (or --api-url). The script sends these two reads and, for an App credential, the token request; it writes nothing to the target.

import path from "node:path";
import { parseFlags, requireSlug, UsageError } from "./lib/args.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { outDirectory, resolveIo, runAsMain, stableJson } from "./lib/cli.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, resolveApiBase } from "./lib/github-client.mjs";

const OPTIONS = {
  out: { type: "string" },
  "target-repo": { type: "string" },
  "report-issue": { type: "string" },
  "project-key": { type: "string" },
  author: { type: "string" },
  "api-url": { type: "string" },
};

/** The label that every drift report carries (SPEC-02 AC44). */
export const REPORT_LABEL = "drift-report";
/** A report number as a dispatch input carries it: a positive whole number of at most nine digits, without sign, spaces or exponent. */
const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9-]*$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;

/** The working branch of the implementation of report <number>; `create-pull-request` prefixes it with sdlc/ (its branch-prefix). */
export const implementationBranch = (number) => `implement-report-${number}`;

/** The query of the open implementation pull requests of a report. */
export const openImplementationQuery = (owner, repo, number) =>
  `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:sdlc/${implementationBranch(number)}`)}&per_page=10`;

class NotAReport extends Error {}

/**
 * Why an issue is not a drift report of the project that the App filed, or null when it is one.
 * @param {object} issue the issue as the REST API returns it
 * @param {{ number: number, projectKey: string, author: string }} expected
 */
export function refusal(issue, { number, projectKey, author }) {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return `#${number} did not come back as an issue`;
  if (issue.pull_request !== undefined && issue.pull_request !== null) return `#${number} is a pull request, not a drift report`;
  if (issue.state !== "open") return `#${number} is ${issue.state === "closed" ? "closed" : `in the state '${String(issue.state).slice(0, 20)}'`}: only an open report is implemented`;
  const login = String(issue.user?.login ?? "");
  if (login.toLowerCase() !== author.toLowerCase()) return `#${number} was opened by ${login.slice(0, 60) || "nobody"}, not by ${author}`;
  const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((label) => String(typeof label === "string" ? label : label?.name ?? ""));
  if (!labels.includes(REPORT_LABEL)) return `#${number} does not carry the label ${REPORT_LABEL}`;
  if (!String(issue.title ?? "").includes(`Drift report: ${projectKey} `)) return `#${number} is not a drift report of ${projectKey}: its title is '${String(issue.title ?? "").slice(0, 120)}'`;
  return null;
}

function requiredText(value, label, pattern) {
  const text = String(value ?? "").trim();
  if (!pattern.test(text)) throw new UsageError(`${label} is missing or malformed`);
  return text;
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const target = requireSlug(flags["target-repo"] ?? io.env.CONFIGURED_TARGET_REPO, "the target repository (--target-repo or CONFIGURED_TARGET_REPO)");
    const projectKey = requiredText(flags["project-key"], "--project-key", PROJECT_KEY);
    const author = requiredText(flags.author, "--author", LOGIN);
    const given = String(flags["report-issue"] ?? "");
    if (!ISSUE_NUMBER.test(given)) throw new NotAReport(`report_issue must be the number of an issue, a positive whole number, not '${given.slice(0, 40)}'`);
    const number = Number(given);
    const [owner, repo] = target.split("/");
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const client = createGitHubClient({ baseUrl: resolveApiBase({ GITHUB_API_URL: flags["api-url"] ?? io.env.GITHUB_API_URL }), fetch: io.fetch, sleep: io.sleep, now: io.now });

    let token = String(io.env.GH_APP_INSTALLATION_TOKEN ?? "").trim();
    if (token !== "") {
      assertInstallationToken(token, "GH_APP_INSTALLATION_TOKEN");
    } else {
      const clientId = String(io.env.APP_CLIENT_ID ?? "").trim();
      const privateKeyPem = String(io.env.APP_PRIVATE_KEY ?? "");
      if (clientId === "" || privateKeyPem.trim() === "") throw new GitHubApiError("no GitHub App credential: set APP_CLIENT_ID and APP_PRIVATE_KEY (or GH_APP_INSTALLATION_TOKEN)");
      token = await mintInstallationToken({ client, clientId, privateKeyPem, owner, repo, permissions: { issues: "read", pull_requests: "read" }, nowMs: io.now() });
    }

    const issue = await client.requestJson("GET", `/repos/${owner}/${repo}/issues/${number}`, { bearer: token });
    const why = refusal(issue, { number, projectKey, author });
    if (why !== null) throw new NotAReport(`${target}${why}`);
    const pulls = await client.requestJson("GET", openImplementationQuery(owner, repo, number), { bearer: token });
    if (!Array.isArray(pulls)) throw new GitHubApiError(`GET ${openImplementationQuery(owner, repo, number)} did not return a list`);
    const openPullRequests = pulls
      .map((pull) => ({ number: pull?.number, url: String(pull?.html_url ?? ""), headRef: String(pull?.head?.ref ?? "") }))
      .filter((pull) => Number.isInteger(pull.number))
      .sort((a, b) => a.number - b.number);
    const title = String(issue.title ?? "");
    const url = String(issue.html_url ?? "");
    const body = typeof issue.body === "string" ? issue.body.replace(/\r\n?/g, "\n") : "";
    const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((label) => String(typeof label === "string" ? label : label?.name ?? "")).sort();
    writeFilesAtomically(
      [
        { path: path.join(out, "report.md"), data: `# ${title.replace(/[\r\n]+/g, " ")}\n\n${url}\n\n${body}` },
        {
          path: path.join(out, "report.json"),
          data: stableJson({
            version: 1,
            repository: target,
            number,
            url,
            title,
            createdAt: String(issue.created_at ?? ""),
            author: String(issue.user?.login ?? ""),
            labels,
            branch: implementationBranch(number),
            openPullRequests,
            body,
          }),
        },
      ],
      { fs: io.fs },
    );
    io.stdout(`read-report: report #${number} of ${target} (${title.slice(0, 120)}) written to ${path.join(out, "report.md")}; ${openPullRequests.length === 0 ? "no implementation of it is open" : `its implementation is open already: ${openPullRequests.map((pull) => `#${pull.number}`).join(", ")}`}\n`);
    return 0;
  } catch (error) {
    io.stderr(`read-report: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
