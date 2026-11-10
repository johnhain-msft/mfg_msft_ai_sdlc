#!/usr/bin/env node
// The poll state of one upstream and the only writer of it (SPEC-03 AC12, AC29, AC46-AC51, AC60, AC68).
//
// It is both a module and a command. The module's state functions (readSyncState, writeSyncState) are the only way that anything in this
// repository touches the variable SDLC_SYNC_STATE_<SLUG>: the router imports them, and nothing else issues a request to the variables of the
// orchestrator repository. The variable is read and written through GET and PATCH only. It is never created here (the bootstrap seeds it from
// initialBaselineSha), so a variable that does not exist is a fatal error and not a reason to POST: neither the POST-then-PATCH of `gh variable
// set` nor the PATCH-then-POST of gh-aw is adopted. A value above the 48 KB limit is refused before any request, and a write is made only when it
// changes a field other than updatedAt.
//
// As a command it runs in the custom jobs of a cascade workflow, after safe_outputs, with the App installation token of the job in GH_TOKEN. The step also hands
// it the correlation id of the routed event, the `correlation_id` input of the dispatch, in CORRELATION_ID, and the failure issue names that id (AC52).
//
//   success path (finalize_poll_state): all seven flags are required
//     node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug S --branch B --provenance-file F --base-sha X --head-sha Y --target-sha T --etag E
//     Y == X: the agent committed nothing; the target is recorded as a no-op and no pull request is looked at.
//     Otherwise an open pull request on branch B of the downstream repository must exist whose provenance file F holds the target at its own
//     head commit; only then is the pull request recorded. Any other outcome of the verification is one failure of the target.
//   failure path (escalate_failure): --record-failure with --slug, --target-sha and --workflow-id (the success flags are ignored)
//     node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug S --target-sha T --workflow-id W
//
// The slug names a dependencyEdges entry of sdlc.yaml (in GITHUB_WORKSPACE, or the current directory), which gives the variable, the downstream
// repository and the JSON pointer of the provenance file. Exit 0: the state was updated as specified. Exit 1: the verification failed, or a request
// failed. Exit 2: a flag is missing or malformed, the slug names no edge, or the environment is incomplete, all before any request.
//
// Standard output is one JSON line: the PortfolioMechanicalCascadeResult of a verified pull request, or {"outcome":"noop-no-changes"}. A request
// that fails is never read as "no pull request" and never as an empty value: it fails the run and leaves the counters alone. A verification that
// fails (and only that) applies the failure transition once, opens or updates the deduplicated [sdlc-failure] issue, and exits 1.

import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { resolveIo, runAsMain, workspaceOf } from "./drift/lib/cli.mjs";
import { CORRELATION_ID as CORRELATION_ID_SHAPE, runCorrelationId } from "./drift/lib/correlation.mjs";
import { cascadeWorkflowId, findEdgeBySlug, resolveJsonPointer, splitSlug } from "./routing/edges.mjs";
import { closeFailureIssue, composeFailureBody, composeFailureComment, composeResolutionComment, failureTitle, upsertFailureIssue } from "./routing/failure-issue.mjs";
import { createRedactor, secretsOfEnvironment } from "./routing/redact.mjs";
import { assertInstallationToken, createRestClient, encodePath, repoPath, resolveApiBase } from "./routing/rest.mjs";
import { assertShape, RoutingDataError } from "./routing/schema.mjs";
import { changedFields, failureTransition, MAX_VARIABLE_BYTES, parseSyncState, serializeSyncState } from "./routing/sync-state.mjs";

export { SYNC_STATE_FIELDS } from "./routing/sync-state.mjs";

const OPTIONS = {
  slug: { type: "string" },
  branch: { type: "string" },
  "provenance-file": { type: "string" },
  "base-sha": { type: "string" },
  "head-sha": { type: "string" },
  "target-sha": { type: "string" },
  etag: { type: "string" },
  "workflow-id": { type: "string" },
  "record-failure": { type: "boolean" },
};
const SUCCESS_FLAGS = ["slug", "branch", "provenance-file", "base-sha", "head-sha", "target-sha", "etag"];
const FAILURE_FLAGS = ["slug", "target-sha", "workflow-id"];

const SLUG = /^[A-Z0-9_]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RELATIVE_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000-\u001f\u007f]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The longest wait that the script takes for a rate limit, in all: a state write that cannot be made within it fails the job. */
export const WAIT_BUDGET_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------
// The state functions: the only access to the variable
// ---------------------------------------------------------------------------------------

/** The variable does not exist. Creating it belongs to the bootstrap, so this script stops. */
export class SyncStateMissingError extends RoutingDataError {
  constructor(name, central) {
    super(`the variable ${name} does not exist in ${central}; the bootstrap creates it from initialBaselineSha and this script never does, so nothing was written`, { code: "state-missing" });
    this.name = "SyncStateMissingError";
  }
}

const variablePath = (central, name) => `${repoPath(central)}/actions/variables/${encodeURIComponent(name)}`;

/**
 * GET of the state variable.
 * @param {{ client: ReturnType<typeof createRestClient>, central: string, name: string }} input
 * @returns {Promise<{ state: object }>}
 * @throws {SyncStateMissingError} on a 404, {RoutingDataError} when the value is not a valid SyncState, {RestError} on any other failure
 */
export async function readSyncState({ client, central, name }) {
  const response = await client.requestJson("GET", variablePath(central, name), { expect: [200, 404] });
  if (response.status === 404) throw new SyncStateMissingError(name, central);
  if (typeof response.json?.value !== "string") throw new RoutingDataError(`the variable ${name} has no value`);
  return { state: parseSyncState(response.json.value, name) };
}

/**
 * PATCH of the state variable, with the `name` and `value` fields. The state is validated and measured first; a value above 48 KB, or one that is
 * not a valid SyncState, is refused before any request. There is no fallback to a POST: a 404 is an error.
 * @returns {Promise<string>} the value that was sent
 */
export async function writeSyncState({ client, central, name, state }) {
  const value = serializeSyncState(state, name);
  await client.requestJson("PATCH", variablePath(central, name), { body: { name, value }, expect: [204, 200] });
  return value;
}

// ---------------------------------------------------------------------------------------
// Verification of the pull request (AC48)
// ---------------------------------------------------------------------------------------

function decodeFile(json, file) {
  if (json === null || typeof json !== "object" || Array.isArray(json) || json.type !== "file" || json.encoding !== "base64" || typeof json.content !== "string") {
    throw new RoutingDataError(`${file} is not a file that the contents API returned as base64 (a directory, a link or a file above its size limit)`);
  }
  return Buffer.from(json.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

/** The commit that a provenance document records, or a reason why there is none. */
function provenanceCommit(text, pointer, file) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { commit: null, reason: `${file} is not JSON (${error.message})` };
  }
  const value = resolveJsonPointer(document, pointer);
  if (typeof value !== "string" || !SHA.test(value)) return { commit: null, reason: `${file}${pointer} does not hold a full commit id` };
  return { commit: value, reason: null };
}

/**
 * The open pull request of the branch whose provenance file records `target` at the pull request's own head commit (AC48).
 * @returns {Promise<{ pr: object | null, reason: string }>}
 */
async function verifyOpenPullRequest({ client, edge, branch, provenanceFile, target }) {
  const { owner } = splitSlug(edge.downstreamRepo);
  const listing = await client.requestJson("GET", `${repoPath(edge.downstreamRepo)}/pulls?state=open&head=${owner}:${branch}`, { expect: [200] });
  if (!Array.isArray(listing.json)) throw new RoutingDataError(`the list of open pull requests of ${edge.downstreamRepo} is not a list`);
  if (listing.json.length === 0) return { pr: null, reason: `no open pull request of ${edge.downstreamRepo} has the head branch ${branch}` };
  const problems = [];
  for (const pr of listing.json) {
    if (!Number.isInteger(pr?.number) || !SHA.test(pr?.head?.sha ?? "") || typeof pr?.html_url !== "string") {
      throw new RoutingDataError("a pull request of the list has no number, no head commit or no address");
    }
    const contents = await client.requestJson("GET", `${repoPath(edge.downstreamRepo)}/contents/${encodePath(provenanceFile)}?ref=${pr.head.sha}`, { expect: [200, 404] });
    if (contents.status === 404) {
      problems.push(`#${pr.number}: ${provenanceFile} does not exist at ${pr.head.sha}`);
      continue;
    }
    let found;
    try {
      found = provenanceCommit(decodeFile(contents.json, provenanceFile), edge.provenanceJsonPointer, provenanceFile);
    } catch (error) {
      if (!(error instanceof RoutingDataError)) throw error;
      problems.push(`#${pr.number}: ${error.message}`);
      continue;
    }
    if (found.commit === target) return { pr, reason: "" };
    problems.push(`#${pr.number}: ${found.reason ?? `${provenanceFile}${edge.provenanceJsonPointer} is ${found.commit} at ${pr.head.sha}, not ${target}`}`);
  }
  return { pr: null, reason: problems.join("; ") };
}

// ---------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------

const nowIsoOf = (io) => new Date(io.now()).toISOString();

function requireValues(flags, names) {
  for (const name of names) if (flags[name] === undefined) throw new UsageError(`--${name} is required`);
}

function checkFlagValues(flags, names) {
  if (names.includes("slug") && !SLUG.test(flags.slug)) throw new UsageError("--slug must be an upstreamSlug (A-Z, 0-9 and _)");
  if (names.includes("branch") && !(BRANCH.test(flags.branch) && flags.branch.length <= 200)) throw new UsageError("--branch must be a branch name (letters, digits and . _ / -)");
  if (names.includes("provenance-file") && !RELATIVE_PATH.test(flags["provenance-file"])) throw new UsageError("--provenance-file must be a path inside the repository");
  for (const name of ["base-sha", "head-sha", "target-sha"]) {
    if (names.includes(name) && !SHA.test(flags[name])) throw new UsageError(`--${name} must be 40 lowercase hexadecimal characters`);
  }
  if (names.includes("workflow-id") && !WORKFLOW_ID.test(flags["workflow-id"])) throw new UsageError("--workflow-id must be the workflow's identifier (letters, digits, . _ -)");
  if (names.includes("etag") && Buffer.byteLength(flags.etag, "utf8") > MAX_VARIABLE_BYTES) {
    throw new UsageError("--etag is longer than the 48 KB that an Actions variable can hold; refusing to send it");
  }
}

function environment(io) {
  const central = String(io.env.GITHUB_REPOSITORY ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(central)) throw new UsageError("GITHUB_REPOSITORY must be the <owner>/<repository> of the orchestrator");
  const token = String(io.env.GH_TOKEN ?? "").trim();
  if (token === "") throw new UsageError("GH_TOKEN is not set: it is the GitHub App installation token of the job");
  try {
    assertInstallationToken(token, "GH_TOKEN");
  } catch (error) {
    throw new UsageError(error.message);
  }
  return { central, token };
}

const runUrlOf = (io) => {
  const run = String(io.env.GITHUB_RUN_ID ?? "").trim();
  const repo = String(io.env.GITHUB_REPOSITORY ?? "").trim();
  if (run === "" || repo === "") return "";
  const server = String(io.env.GITHUB_SERVER_URL ?? "").trim() || "https://github.com";
  return `${server.replace(/\/+$/, "")}/${repo}/actions/runs/${run}`;
};

/**
 * The correlation id that the failure issue names (SPEC-03 AC52): the one that the router generated for the event, which reaches this script as the
 * `correlation_id` input of the dispatch that the step binds to CORRELATION_ID. This is another run than the router's, so the id that its own run implies
 * (`run-<run id>-<attempt>`) is only the fallback, for a dispatch that carried none (a manual one) and for one that carried an id that cannot be one: what a
 * person typed into the input never reaches the table of an issue, the failure is still recorded, and the log says that the value was not used (not what it was).
 */
function correlationIdOf(io, log) {
  const given = String(io.env.CORRELATION_ID ?? "").trim();
  if (given !== "") {
    if (CORRELATION_ID_SHAPE.test(given)) return given;
    log("CORRELATION_ID is not a correlation id (1 to 128 characters of letters, digits and . _ : / + = -, starting with a letter or a digit), so the id of this run is used instead");
  }
  return runCorrelationId(io.env) ?? "";
}

function issuesClientOf(io, log) {
  const token = String(io.env.ISSUES_TOKEN ?? "").trim();
  if (token === "") return null;
  assertInstallationToken(token, "the issues token");
  return createRestClient({
    baseUrl: resolveApiBase(io.env),
    token,
    fetch: io.fetch,
    sleep: io.sleep,
    now: io.now,
    log,
    deadlineMs: io.now() + WAIT_BUDGET_MS,
  });
}

/** Opens or updates the deduplicated issue; returns an error message, or null when it was written. */
async function reportFailureIssue({ io, central, edge, workflowId, targetSha, reason, log }) {
  try {
    const client = issuesClientOf(io, log);
    if (client === null) return "the token of the job (issues: write) is not set, so no [sdlc-failure] issue was opened";
    const input = {
      workflowId,
      subject: edge.downstreamRepo,
      correlationId: correlationIdOf(io, log),
      targetSha,
      reason,
      runUrl: runUrlOf(io),
      nowIso: nowIsoOf(io),
    };
    const redact = io.redact ?? ((text) => text);
    const outcome = await upsertFailureIssue({
      client,
      central,
      title: failureTitle(workflowId, edge.downstreamRepo),
      body: redact(composeFailureBody(input)),
      comment: redact(composeFailureComment(input)),
    });
    log(`${outcome.action === "created" ? "opened" : "commented on"} issue #${outcome.number} ${outcome.url}`.trim());
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
}

/** Closes any open [sdlc-failure] issue for this workflow and downstream repository once verification succeeds. */
async function resolveFailureIssue({ io, central, edge, workflowId, targetSha, outcome, log }) {
  try {
    const client = issuesClientOf(io, log);
    if (client === null) return;
    const input = {
      workflowId,
      subject: edge.downstreamRepo,
      correlationId: correlationIdOf(io, log),
      targetSha,
      reason: `resolved (${outcome})`,
      runUrl: runUrlOf(io),
      nowIso: nowIsoOf(io),
    };
    const redact = io.redact ?? ((text) => text);
    const closed = await closeFailureIssue({
      client,
      central,
      title: failureTitle(workflowId, edge.downstreamRepo),
      comment: redact(composeResolutionComment(input)),
    });
    if (closed.action === "closed") log(`closed issue #${closed.number} ${closed.url}`.trim());
  } catch (error) {
    log(`the [sdlc-failure] issue could not be closed: ${error?.message ?? error}`);
  }
}

/**
 * @param {string[]} argv
 * @param {object} [ioInput] `env`, `cwd`, `fs`, `fetch`, `sleep`, `now`, `stdout`, `stderr`; a test passes fakes for the network and the clock
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  // nothing that the job holds as a secret is ever written: every line and the body of the issue pass through the redactor
  const redactor = createRedactor(secretsOfEnvironment(io.env));
  const rawStdout = io.stdout;
  const rawStderr = io.stderr;
  io.stdout = (text) => rawStdout(redactor.redact(text));
  io.stderr = (text) => rawStderr(redactor.redact(text));
  io.redact = redactor.redact;
  const log = (line) => io.stderr(`update-poll-state: ${line}\n`);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const recordFailure = flags["record-failure"] === true;
    const names = recordFailure ? FAILURE_FLAGS : SUCCESS_FLAGS;
    requireValues(flags, names);
    checkFlagValues(flags, names);
    const { edge, reason } = findEdgeBySlug(workspaceOf(io), flags.slug, io);
    if (edge === null) throw new UsageError(reason);
    const { central, token } = environment(io);

    const client = createRestClient({
      baseUrl: resolveApiBase(io.env),
      token,
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
      log,
      deadlineMs: io.now() + WAIT_BUDGET_MS,
    });
    const context = { io, log, edge, flags, central, client };
    return recordFailure ? await recordFailurePath(context) : await successPath(context);
  } catch (error) {
    log(error?.message ?? String(error));
    // a flag, the slug or the environment that is wrong is the caller's mistake and made no request; everything else failed after one
    return error instanceof UsageError || error?.name === "GitHubApiError" ? 2 : 1;
  }
}

/** Writes `next` when it differs from `before` in a field other than updatedAt; returns whether a request was made. */
async function writeWhenChanged({ client, central, edge, before, next }) {
  if (changedFields(before, next).length === 0) return false;
  await writeSyncState({ client, central, name: edge.stateVariable, state: next });
  return true;
}

/**
 * The success path. A request that fails (the state, the pull requests or the provenance file) fails the run and says why in the issue, and leaves the
 * counters alone: only a verification that came back negative is a failure of the target.
 */
async function successPath({ io, log, edge, flags, central, client }) {
  const target = flags["target-sha"];
  const workflowId = cascadeWorkflowId(edge);
  try {
    return await verifyAndRecord({ io, log, edge, flags, central, client });
  } catch (error) {
    const failed = await reportFailureIssue({ io, central, edge, workflowId, targetSha: target, reason: `the sync state could not be updated: ${error?.message ?? error}`, log });
    if (failed !== null) log(failed);
    throw error;
  }
}

async function verifyAndRecord({ io, log, edge, flags, central, client }) {
  const target = flags["target-sha"];
  const base = flags["base-sha"];
  const head = flags["head-sha"];
  const etag = flags.etag;
  const workflowId = cascadeWorkflowId(edge);
  const updatedAt = nowIsoOf(io);
  const { state } = await readSyncState({ client, central, name: edge.stateVariable });

  if (head === base) {
    const next = {
      ...state,
      etag,
      lastObservedHeadSha: target,
      lastNoopHeadSha: target,
      inFlightRunId: null,
      inFlightTargetSha: null,
      failedTargetSha: null,
      failedAttempts: 0,
      updatedAt,
    };
    await writeWhenChanged({ client, central, edge, before: state, next });
    io.stdout(`${JSON.stringify({ outcome: "noop-no-changes" })}\n`);
    return 0;
  }

  const verification = await verifyOpenPullRequest({ client, edge, branch: flags.branch, provenanceFile: flags["provenance-file"], target });

  if (verification.pr === null) {
    const transition = failureTransition(state, target, updatedAt);
    const reason = `no open pull request of ${edge.downstreamRepo} on ${flags.branch} records ${target} in ${flags["provenance-file"]}: ${verification.reason}`;
    log(reason);
    let writeError = null;
    try {
      await writeSyncState({ client, central, name: edge.stateVariable, state: transition });
    } catch (error) {
      writeError = error;
    }
    const counted = `failure ${transition.failedAttempts} of 2 for ${target}${transition.blockedTargetSha === target ? "; the target is blocked until the downstream changes or reset_blocked is set" : ""}`;
    const failed = await reportFailureIssue({ io, central, edge, workflowId, targetSha: target, reason: `${reason} (${counted})`, log });
    if (failed !== null) log(failed);
    if (writeError !== null) log(`the failure could not be recorded in ${edge.stateVariable}: ${writeError.message}`);
    return 1;
  }

  const { pr } = verification;
  const result = {
    outcome: state.openPrNumber === pr.number ? "pr-updated" : "pr-opened",
    prNumber: pr.number,
    prUrl: pr.html_url,
    headSha: pr.head.sha,
    openPrTargetSha: target,
  };
  assertShape("PortfolioMechanicalCascadeResult", result, "the result");
  const next = {
    ...state,
    etag,
    lastObservedHeadSha: target,
    openPrTargetSha: target,
    openPrNumber: pr.number,
    inFlightRunId: null,
    inFlightTargetSha: null,
    failedTargetSha: null,
    failedAttempts: 0,
    updatedAt,
  };
  await writeWhenChanged({ client, central, edge, before: state, next });
  await resolveFailureIssue({ io, central, edge, workflowId, targetSha: target, outcome: result.outcome, log });
  io.stdout(`${JSON.stringify(result)}\n`);
  return 0;
}

async function recordFailurePath({ io, log, edge, flags, central, client }) {
  const target = flags["target-sha"];
  const workflowId = flags["workflow-id"];
  const updatedAt = nowIsoOf(io);
  let outcome = null;
  let problem = null;
  try {
    const { state } = await readSyncState({ client, central, name: edge.stateVariable });
    const next = failureTransition(state, target, updatedAt);
    await writeSyncState({ client, central, name: edge.stateVariable, state: next });
    outcome = next;
  } catch (error) {
    problem = error;
    log(`the failure could not be recorded in ${edge.stateVariable}: ${error?.message ?? error}`);
  }
  const counted =
    outcome === null
      ? "the failure could not be recorded in the sync state"
      : `failure ${outcome.failedAttempts} of 2 for ${target}${outcome.blockedTargetSha === target ? "; the target is blocked until the downstream changes or reset_blocked is set" : ""}`;
  const failed = await reportFailureIssue({ io, central, edge, workflowId, targetSha: target, reason: `a job of ${workflowId} failed before its pull request was verified (${counted})`, log });
  if (failed !== null) log(failed);
  return problem === null && failed === null ? 0 : 1;
}

await runAsMain(import.meta.url, run);
