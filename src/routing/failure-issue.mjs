// The deduplicated [sdlc-failure] issue of the S3 scripts (SPEC-03 AC7, AC28, AC39, AC50, AC51, AC52).
//
// One issue per title in the orchestrator repository, never two: the open issues are read page by page to the end and compared by exact title,
// and an issue that exists is updated by a comment. A list that is cut short before the issue was found is not read as "no such issue" (a second
// one would duplicate it somewhere further down): the upsert fails and writes nothing. The only credential is the one that the caller hands in,
// the token of the workflow's job (issues: write), which authenticates nothing else.

import { RestError, repoPath } from "./rest.mjs";

export const FAILURE_LABEL = "sdlc-gate-failure";
const ISSUES_PER_PAGE = 100;
/** The open issues are read to their end, up to this many pages (a hundred each). */
export const MAX_ISSUE_PAGES = 100;
const MARKER = "sdlc-failure:v1";

export const failureTitle = (workflowId, subject) => `[sdlc-failure] ${workflowId} (${subject})`;

/** Untrusted text made safe for an inline code span in an issue body. */
export const inline = (value, limit = 400) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "'").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function rowsOf({ workflowId, subject, correlationId, targetSha = null, reason, runUrl = "", nowIso, extra = {} }) {
  return [
    ["Workflow", `\`${inline(workflowId, 120)}\``],
    ["Subject", `\`${inline(subject, 200)}\``],
    ["Correlation id", correlationId ? `\`${inline(correlationId, 128)}\`` : "none"],
    ["Target", targetSha ? `\`${inline(targetSha, 64)}\`` : "not determined"],
    ["Run", runUrl ? runUrl : "not provided"],
    ["When", nowIso],
    ["Reason", `\`${inline(reason, 600)}\``],
    ...Object.entries(extra).map(([name, value]) => [name, `\`${inline(value, 300)}\``]),
  ].map(([name, value]) => `| ${name} | ${value} |`);
}

/**
 * The body of a new issue.
 * @param {{ workflowId: string, subject: string, correlationId: string, targetSha?: string | null, reason: string, runUrl?: string, nowIso: string, extra?: Record<string, string> }} input
 */
export function composeFailureBody(input) {
  const { workflowId, subject } = input;
  return [
    `<!-- ${MARKER} workflow=${inline(workflowId, 120)} subject=${inline(subject, 200)} -->`,
    `The \`${inline(workflowId, 120)}\` workflow failed for \`${inline(subject, 200)}\`. What failed, and the run that failed, are below.`,
    "",
    "| | |",
    "|---|---|",
    ...rowsOf(input),
    "",
    "A later failure with the same title updates this issue by comment instead of opening another. Close it once the cause is fixed.",
    "",
  ].join("\n");
}

/** The comment that records one more failure on an issue that exists. */
export function composeFailureComment(input) {
  return ["Another failure was recorded for this issue.", "", "| | |", "|---|---|", ...rowsOf(input), ""].join("\n");
}

/** The comment posted when a subsequent run succeeds and closes an open failure issue. */
export function composeResolutionComment(input) {
  return ["This failure issue is being closed automatically because a subsequent run succeeded.", "", "| | |", "|---|---|", ...rowsOf(input), ""].join("\n");
}

/**
 * Opens the issue, or comments on the open issue with the same title.
 * @param {{ client: ReturnType<import("./rest.mjs").createRestClient>, central: string, title: string, label?: string, body: string, comment: string }} input
 * @returns {Promise<{ action: "created" | "commented", number: number, url: string }>}
 * @throws {RestError} on any API error, and when more than MAX_ISSUE_PAGES pages of open issues hold no issue of this title
 */
export async function upsertFailureIssue({ client, central, title, label = FAILURE_LABEL, body, comment }) {
  const base = repoPath(central);
  const { items, truncated } = await client.paginate(`${base}/issues?state=open&per_page=${ISSUES_PER_PAGE}`, { maxPages: MAX_ISSUE_PAGES });
  const existing = items.find((issue) => issue?.title === title && issue?.pull_request === undefined);
  if (existing === undefined && truncated) {
    throw new RestError(`more than ${MAX_ISSUE_PAGES * ISSUES_PER_PAGE} open issues exist and none of those read is '${title}'; it may be further down the list, so no issue is opened (a second one would duplicate it)`, { kind: "http", method: "GET", path: `${base}/issues` });
  }
  if (existing !== undefined) {
    const created = await client.requestJson("POST", `${base}/issues/${existing.number}/comments`, { body: { body: comment }, expect: [201] });
    return { action: "commented", number: existing.number, url: created.json?.html_url ?? existing.html_url ?? "" };
  }
  const created = await client.requestJson("POST", `${base}/issues`, { body: { title, body, labels: [label] }, expect: [201] });
  return { action: "created", number: created.json?.number ?? 0, url: created.json?.html_url ?? "" };
}

/**
 * Closes an open failure issue with the exact title after posting a resolution comment, or does nothing when none is open.
 * @param {{ client: ReturnType<import("./rest.mjs").createRestClient>, central: string, title: string, comment: string }} input
 * @returns {Promise<{ action: "closed" | "none", number: number, url: string }>}
 */
export async function closeFailureIssue({ client, central, title, comment }) {
  const base = repoPath(central);
  const { items } = await client.paginate(`${base}/issues?state=open&per_page=${ISSUES_PER_PAGE}`, { maxPages: MAX_ISSUE_PAGES });
  const existing = items.find((issue) => issue?.title === title && issue?.pull_request === undefined);
  if (existing === undefined) {
    return { action: "none", number: 0, url: "" };
  }
  await client.requestJson("POST", `${base}/issues/${existing.number}/comments`, { body: { body: comment }, expect: [201] });
  const closed = await client.requestJson("PATCH", `${base}/issues/${existing.number}`, {
    body: { state: "closed", state_reason: "completed" },
    expect: [200],
  });
  return { action: "closed", number: existing.number, url: closed.json?.html_url ?? existing.html_url ?? "" };
}
