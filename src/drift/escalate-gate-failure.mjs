#!/usr/bin/env node
// Failure escalation of every drift workflow (SPEC-02 AC30, AC32).
//
//   node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" \
//     --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
//
// It runs in the escalate_failure job of the orchestrator repository when the agent job failed (a gate of post-steps, or
// any earlier failure), with the job's GITHUB_TOKEN (GH_TOKEN or GITHUB_TOKEN), issues: write and actions: read. It opens one issue in the
// repository named by GITHUB_REPOSITORY, labelled sdlc-gate-failure and titled "[sdlc-failure] <workflowId> (<targetRepo>)",
// or, when an open issue with that title already exists, updates it: the same failure of the same workflow on the same
// target never opens a second one. The body names the failing command, the run URL and the correlation id, counts the
// occurrences and keeps a short history. Every request goes to /repos/<that repository>/ and the target repository is
// never written. Requests are serial and a rate-limited response is retried as the server states.
//
// The failing command is --failing-command when given. Otherwise it is looked up as the first failed step of the agent
// job of the run (post-steps are named by their command); that lookup needs the actions: read permission, which the
// escalate_failure job is given (a private repository refuses the read without it). A refusal or a run that cannot be found
// leaves the command "not determined" and the run URL stays the pointer; a rate limit that outlasts the retries fails the step.
//
// The correlation id is --correlation-id when given. A scheduled run has no dispatch input, so the argument is empty, and the id is then the one
// that prepare-run derived for the same run, `run-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>` (the attempt is 1 when the variable is not set; the
// run id comes from --run-url when GITHUB_RUN_ID is not set), so that the issue and run-context.json name the same id. It is "none" only when
// neither an argument nor a run gives one.

import { parseFlags, requireSlug, UsageError } from "./lib/args.mjs";
import { resolveIo, runAsMain } from "./lib/cli.mjs";
import { runCorrelationId } from "./lib/correlation.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, resolveApiBase } from "./lib/github-client.mjs";

const OPTIONS = {
  "workflow-id": { type: "string" },
  "target-repo": { type: "string" },
  "correlation-id": { type: "string" },
  "run-url": { type: "string" },
  "failing-command": { type: "string" },
  label: { type: "string" },
  "api-url": { type: "string" },
  "max-retries": { type: "string" },
  "max-wait-seconds": { type: "string" },
};

export const DEFAULT_LABEL = "sdlc-gate-failure";
export const TITLE = (workflowId, targetRepo) => `[sdlc-failure] ${workflowId} (${targetRepo})`;
const MARKER = "sdlc-gate-failure:v1";
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HISTORY_LIMIT = 20;

/** Untrusted text made safe for an inline code span in an issue body. */
const inline = (value, limit = 300) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "'").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

const timestamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** The history lines and the occurrence count of a body that this script wrote earlier. */
export function readEarlierBody(body) {
  const text = String(body ?? "");
  const history = [];
  const section = /(?:^|\n)## History\n([\s\S]*?)(?:\n## |\s*$)/.exec(text);
  if (section) for (const line of section[1].split("\n")) if (line.startsWith("- ")) history.push(line);
  const count = /\|\s*Occurrences\s*\|\s*(\d+)\s*\|/.exec(text);
  return { history, occurrences: count ? Number(count[1]) : history.length };
}

export function composeBody({ workflowId, targetRepo, failingCommand, runUrl, correlationId, nowMs, earlier }) {
  const command = failingCommand ? `\`${inline(failingCommand)}\`` : "not determined (see the run)";
  const link = runUrl ? runUrl : "not provided";
  const correlation = correlationId ? `\`${inline(correlationId, 128)}\`` : "none";
  const entry = `- ${timestamp(nowMs)} — ${runUrl ? `[run](${runUrl})` : "run not provided"} — correlation id ${correlation} — failing command: ${command}`;
  const history = [...(earlier?.history ?? []), entry].slice(-HISTORY_LIMIT);
  const occurrences = (earlier?.occurrences ?? 0) + 1;
  return [
    `<!-- ${MARKER} workflow=${workflowId} target=${targetRepo} -->`,
    `The \`${workflowId}\` workflow failed for \`${targetRepo}\`. The usual cause is a verification gate, which fails the run before any pull request is opened; the failing command is named below when it could be determined.`,
    "",
    "| | |",
    "|---|---|",
    `| Workflow | \`${workflowId}\` |`,
    `| Target repository | \`${targetRepo}\` |`,
    `| Failing command | ${command} |`,
    `| Run | ${link} |`,
    `| Correlation id | ${correlation} |`,
    `| Last failure | ${timestamp(nowMs)} |`,
    `| Occurrences | ${occurrences} |`,
    "",
    "## History",
    ...history,
    "",
    "A second failure of the same workflow on the same target repository updates this issue instead of opening another. Close it once the cause is fixed.",
    "",
  ].join("\n");
}

async function findFailingStep(client, central, runId) {
  let jobs;
  try {
    jobs = await client.requestJson("GET", `/repos/${central}/actions/runs/${runId}/jobs?per_page=100&filter=latest`, { expect: [200] });
  } catch (error) {
    // A refusal (the token cannot read the run) or a run that is not found leaves the command undetermined. A rate limit that outlasts
    // the bounded retries fails the step like every other request of this script (AC32), and so does any error that is not an API error.
    if (!(error instanceof GitHubApiError) || error.rateLimited) throw error;
    return null;
  }
  const agent = (Array.isArray(jobs?.jobs) ? jobs.jobs : []).find((job) => job?.name === "agent" && job?.conclusion === "failure");
  const step = (Array.isArray(agent?.steps) ? agent.steps : []).find((candidate) => candidate?.conclusion === "failure");
  return typeof step?.name === "string" && step.name !== "" ? step.name : null;
}

function wholeNumber(value, label, fallback) {
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
    const workflowId = String(flags["workflow-id"] ?? "").trim();
    if (!WORKFLOW_ID.test(workflowId)) throw new UsageError("--workflow-id must be the workflow's identifier (letters, digits, . _ -)");
    const targetRepo = requireSlug(flags["target-repo"], "--target-repo");
    const central = requireSlug(io.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
    const token = String(io.env.GH_TOKEN ?? io.env.GITHUB_TOKEN ?? "").trim();
    if (token === "") throw new GitHubApiError("no token: set GH_TOKEN (the job's GITHUB_TOKEN)");
    assertInstallationToken(token, "GH_TOKEN");
    const label = String(flags.label ?? DEFAULT_LABEL).trim() || DEFAULT_LABEL;
    const runUrlInput = String(flags["run-url"] ?? "").trim();
    const runUrl = /^https?:\/\/[^\s<>()]+$/.test(runUrlInput) ? runUrlInput : "";
    const correlationInput = String(flags["correlation-id"] ?? "").trim();
    const correlationId = correlationInput !== "" ? correlationInput : (runCorrelationId(io.env, runUrl) ?? "");

    const client = createGitHubClient({
      baseUrl: resolveApiBase({ GITHUB_API_URL: flags["api-url"] ?? io.env.GITHUB_API_URL }),
      token,
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
      maxRateLimitRetries: wholeNumber(flags["max-retries"], "--max-retries", 3),
      maxWaitMs: wholeNumber(flags["max-wait-seconds"], "--max-wait-seconds", 300) * 1000,
    });

    let failingCommand = String(flags["failing-command"] ?? "").trim();
    if (failingCommand === "") {
      const runId = /\/actions\/runs\/(\d+)/.exec(runUrl)?.[1] ?? /^\d+$/.exec(String(io.env.GITHUB_RUN_ID ?? ""))?.[0];
      if (runId) failingCommand = (await findFailingStep(client, central, runId)) ?? "";
    }

    const title = TITLE(workflowId, targetRepo);
    const { items } = await client.paginate(`/repos/${central}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`, { maxPages: 5 });
    const existing = items.find((issue) => issue?.title === title && issue?.pull_request === undefined);
    const body = composeBody({
      workflowId,
      targetRepo,
      failingCommand,
      runUrl,
      correlationId,
      nowMs: io.now(),
      earlier: existing ? readEarlierBody(existing.body) : null,
    });
    if (existing) {
      const updated = await client.requestJson("PATCH", `/repos/${central}/issues/${existing.number}`, { body: { body }, expect: [200] });
      io.stdout(`escalate-gate-failure: updated issue #${existing.number} ${updated?.html_url ?? ""}\n`);
    } else {
      const created = await client.requestJson("POST", `/repos/${central}/issues`, { body: { title, body, labels: [label] }, expect: [201] });
      io.stdout(`escalate-gate-failure: opened issue #${created?.number} ${created?.html_url ?? ""}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`escalate-gate-failure: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
