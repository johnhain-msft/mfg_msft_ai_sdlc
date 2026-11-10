#!/usr/bin/env node
// The cross-repository event router of one upstream (SPEC-03 AC1-AC4, AC7-AC11, AC14-AC39, AC52, AC65-AC70; contracts C3, C6, C7).
//
//   node "$GITHUB_WORKSPACE/src/route-upstream.mjs"
//
// It runs once per matrix job of .github/workflows/cascade-router.yml, under the concurrency group of its upstream, and is given its edge and the
// event by the workflow: EDGE_JSON (the matrix entry), UPSTREAM_KEY, EVENT_NAME, CLIENT_PAYLOAD (the client_payload of a repository_dispatch),
// RESET_BLOCKED (the input of a manual run), the App's APP_CLIENT_ID and APP_PRIVATE_KEY, and the token of the job for the failure issue. It decides, from one
// conditional poll of the upstream and the state variable of the edge, whether the upstream advanced by something that the downstream has to follow, and
// then dispatches the cascade workflow of the edge (without waiting for it) or ends with one of the noop decisions.
//
//   1. the signal: a repository_dispatch is validated (UpstreamMergeClientPayload) and only wakes the router; the job whose edge it names routes,
//      every other job exits 0 without a request, and a payload that names no edge fails every job. The target is never taken from the payload.
//   2. the state is read (a missing variable is fatal; nothing here creates one) and the upstream is polled with If-None-Match: the commit of the default
//      branch and the closed pull requests. 200: the target is the sha of the response, and the ETag is held in memory. 304: the target is lastObservedHeadSha.
//   3. the downstream is read: the head of its default branch, and the commit that its provenance file records (404: the cursor of the state stands, but only
//      while it is still the seed that the bootstrap wrote; once it has moved, a cascade pull request has merged and a missing file is an error, AC14).
//   4. an open pull request that the state records is reconciled (merged: the merge cursor advances; closed unmerged: the target is dismissed); the
//      failure counters are reset when the target, the downstream head or the manual input changed; then the target is compared with the merge cursor,
//      the last no-op, the dismissed and the blocked target, the run in flight and the open pull request, in that order.
//   5. otherwise the edge's preflight decides whether anything material changed (a no-op is recorded as lastNoopHeadSha, never as a merge), and
//      otherwise the cascade is dispatched with previous_sha = the merge cursor, the run id is recorded as in flight and the job ends after five seconds.
//
// Every job appends one MergeRoutingDecision, as one JSON line, to GITHUB_STEP_SUMMARY, and writes the state at most once, last, only when a field other
// than updatedAt changed. A job that fails writes nothing, exits non-zero and opens or updates one deduplicated [sdlc-failure] issue. Requests are REST
// requests, serial, GETs to the upstream and the downstream; the only writes are the dispatch, the state variable and that issue.

import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { resolveIo, runAsMain, workspaceOf } from "./drift/lib/cli.mjs";
import { runCorrelationId } from "./drift/lib/correlation.mjs";
import { readSyncState, writeSyncState } from "./update-poll-state.mjs";
import { mintRouterTokens } from "./routing/app-auth.mjs";
import { DISPATCH_GAP_MS, dispatchInputs, dispatchWorkflow } from "./routing/dispatch.mjs";
import { cascadeWorkflowFile, loadManifestEdges, parseEdgeJson, resolveJsonPointer } from "./routing/edges.mjs";
import { closeFailureIssue, composeFailureBody, composeFailureComment, composeResolutionComment, failureTitle, upsertFailureIssue } from "./routing/failure-issue.mjs";
import { planPreflight, runPreflight, STUDIO_PROVENANCE } from "./routing/preflight.mjs";
import { createRedactor, secretsOfEnvironment } from "./routing/redact.mjs";
import { assertInstallationToken, createRestClient, encodePath, repoPath, resolveApiBase, RestError } from "./routing/rest.mjs";
import { assertShape, RoutingDataError, validateShape } from "./routing/schema.mjs";
import { changedFields } from "./routing/sync-state.mjs";

/** The timeout of the router job that SPEC-01 renders. No wait of the run may pass it; the last minutes are kept for the failure issue. */
export const ROUTER_TIMEOUT_MINUTES = 30;
const FAILURE_RESERVE_MS = 3 * 60 * 1000;

const SHA = /^[0-9a-f]{40}$/;
const EVENTS = ["repository_dispatch", "schedule", "workflow_dispatch"];
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function parseBoolean(value, label) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false" || text === "") return false;
  throw new UsageError(`${label} must be true or false, got '${String(value).slice(0, 40)}'`);
}

/** The client_payload of a repository_dispatch. @throws {RoutingDataError} when it is not an UpstreamMergeClientPayload */
export function parseClientPayload(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new RoutingDataError(`the client_payload is not JSON: ${error.message}`, { code: "invalid-client-payload" });
  }
  const { valid, errors } = validateShape("UpstreamMergeClientPayload", payload);
  if (!valid) throw new RoutingDataError(`the client_payload is not a valid UpstreamMergeClientPayload: ${errors.join("; ")}`, { code: "invalid-client-payload" });
  return payload;
}

const matchesSignal = (edge, payload) => sameRepo(edge.upstreamRepo, payload.upstream_repo) && edge.upstreamDefaultBranch === payload.default_branch;

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

/** The conditional poll of the upstream (AC11, AC16): the commit of the default branch, then the closed pull requests, serially, with the same If-None-Match. */
async function pollUpstream({ client, edge, state }) {
  const base = repoPath(edge.upstreamRepo);
  const conditional = state.etag === "" ? {} : { headers: { "If-None-Match": state.etag } };
  const commits = await client.requestJson("GET", `${base}/commits/${encodePath(edge.upstreamDefaultBranch)}`, { ...conditional, expect: [200, 304] });
  const pulls = await client.requestJson("GET", `${base}/pulls?state=closed&base=${edge.upstreamDefaultBranch}&per_page=30`, { ...conditional, expect: [200, 304] });
  let targetSha;
  let heldEtag;
  if (commits.status === 304) {
    if (state.etag === "") throw new RoutingDataError("the commit request answered 304 although it carried no If-None-Match");
    targetSha = state.lastObservedHeadSha;
    heldEtag = state.etag;
  } else {
    targetSha = commits.json?.sha;
    if (typeof targetSha !== "string" || !SHA.test(targetSha)) throw new RoutingDataError(`the commit response of ${edge.upstreamRepo} holds no full sha`);
    heldEtag = commits.headers.get("etag") ?? "";
  }
  // the closed pull requests only tell which merged pull request, if any, is the target (a direct commit has none)
  let prNumber = null;
  if (pulls.status === 200 && Array.isArray(pulls.json)) {
    const merged = pulls.json.find((pr) => pr?.merged_at && pr?.merge_commit_sha === targetSha && Number.isInteger(pr?.number));
    if (merged) prNumber = merged.number;
  }
  return { status: commits.status, targetSha, heldEtag, prNumber };
}

/** The head of the downstream's default branch and the commit that its provenance file records there (AC14). */
async function readDownstream({ client, edge }) {
  const base = repoPath(edge.downstreamRepo);
  const repository = await client.requestJson("GET", base, { expect: [200] });
  const branch = repository.json?.default_branch;
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new RoutingDataError(`${edge.downstreamRepo} has no default branch in its repository response`);
  const head = await client.requestJson("GET", `${base}/commits/${encodePath(branch)}`, { expect: [200] });
  const mainSha = head.json?.sha;
  if (typeof mainSha !== "string" || !SHA.test(mainSha)) throw new RoutingDataError(`the head of ${edge.downstreamRepo} ${branch} is not a full sha`);
  const commit = await readProvenance({ client, slug: edge.downstreamRepo, file: edge.provenanceFile, pointer: edge.provenanceJsonPointer, ref: mainSha });
  return { branch, mainSha, provenanceCommit: commit };
}

/** The commit that a provenance file records at `ref`; null when the file does not exist (404); an error when it exists and says nothing usable. */
async function readProvenance({ client, slug, file, pointer, ref }) {
  const response = await client.requestJson("GET", `${repoPath(slug)}/contents/${encodePath(file)}?ref=${ref}`, { expect: [200, 404] });
  if (response.status === 404) return null;
  const json = response.json;
  if (json?.type !== "file" || json?.encoding !== "base64" || typeof json?.content !== "string") {
    throw new RoutingDataError(`${file} of ${slug} is not a file that the contents API returned as base64`);
  }
  let document;
  try {
    document = JSON.parse(Buffer.from(json.content.replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch (error) {
    throw new RoutingDataError(`${file} of ${slug} is not JSON: ${error.message}`);
  }
  const value = resolveJsonPointer(document, pointer);
  if (typeof value !== "string" || !SHA.test(value)) throw new RoutingDataError(`${file}${pointer} of ${slug} does not hold a full commit id`);
  return value;
}

async function readOpenPullRequest({ client, edge, number }) {
  const response = await client.requestJson("GET", `${repoPath(edge.downstreamRepo)}/pulls/${number}`, { expect: [200] });
  const pr = response.json;
  if (typeof pr?.merged !== "boolean" || typeof pr?.state !== "string") throw new RoutingDataError(`pull request #${number} of ${edge.downstreamRepo} has no merged flag or state`);
  return pr;
}

/** The status of a run of the orchestrator; null when the run does not exist any more (a stale record, AC18). */
async function readRunStatus({ client, central, runId }) {
  const response = await client.requestJson("GET", `${repoPath(central)}/actions/runs/${runId}`, { expect: [200, 404] });
  if (response.status === 404) return null;
  if (typeof response.json?.status !== "string") throw new RoutingDataError(`run ${runId} has no status`);
  return response.json.status;
}

// ---------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------

/**
 * Reconciliation, resets and terminal comparisons (AC15, AC17, AC18) as one function of what was read; it makes no request except through `runStatusOf`.
 *
 * The provenance file of the downstream decides the merge cursor (AC14). Its absence (`provenanceCommit` null, a 404 on main) is a fact about the time before
 * the first cascade pull request merged: the file does not exist yet, so the cursor of the state, which the bootstrap seeded with `baselineSha` (the edge's
 * initialBaselineSha, AC13), stands. Once the cursor has moved off its seed, the router has seen a cascade merge (or a provenance file that existed) and the
 * file has to be there: a 404 then is a deleted or moved file, never the bootstrap, and nothing is decided from a cursor that main no longer confirms.
 * @param {object} input
 * @param {string} input.baselineSha the edge's initialBaselineSha, the seed of the merge cursor
 * @param {string} [input.provenanceLabel] what was read, for the message of a refusal (the file, its repository and the commit it was read at)
 * @returns {Promise<{ working: object, action: string | null }>} `action` is a terminal noop, or null when the target has to be dispatched or checked
 * @throws {RoutingDataError} `provenance-missing`, when the provenance file is absent and the merge cursor is not the seed
 */
export async function decide({ stored, targetSha, mainSha, provenanceCommit, provenanceLabel = "the provenance file", baselineSha, openPr, resetBlocked, runStatusOf }) {
  const working = { ...stored };
  let merged = false;
  if (openPr !== null) {
    if (openPr.merged === true) {
      merged = true;
    } else if (openPr.state === "closed") {
      working.dismissedTargetSha = stored.openPrTargetSha;
      working.openPrNumber = null;
      working.openPrTargetSha = null;
    }
  }
  // the provenance file of the downstream is authoritative for the merge cursor; a pull request that was seen merged is newer than any file read before it
  if (provenanceCommit !== null) {
    working.lastMergedUpstreamSha = provenanceCommit;
  } else if (stored.lastMergedUpstreamSha !== baselineSha) {
    throw new RoutingDataError(
      `${provenanceLabel} does not exist (404), but the merge cursor ${stored.lastMergedUpstreamSha} has moved off the seed ${baselineSha} (initialBaselineSha): either a cascade pull request has merged, ` +
        "so the file has to be on the default branch, or initialBaselineSha changed after the variable was seeded. The fallback to the cursor of the state holds only before the first " +
        "merged cascade pull request (SPEC-03 AC14). Nothing was routed and nothing was written. Restore the file on the default branch, or correct provenanceFile in sdlc.yaml if it moved.",
      { code: "provenance-missing" },
    );
  }
  if (merged) {
    working.lastMergedUpstreamSha = stored.openPrTargetSha;
    working.openPrNumber = null;
    working.openPrTargetSha = null;
  }

  if (targetSha !== working.failedTargetSha || mainSha !== working.portfolioMainSha || resetBlocked) {
    working.failedTargetSha = null;
    working.failedAttempts = 0;
    working.blockedTargetSha = null;
  }
  working.portfolioMainSha = mainSha;

  if (targetSha === working.lastMergedUpstreamSha) return { working, action: "noop-304" };
  if (targetSha === working.lastNoopHeadSha) return { working, action: "noop-304" };
  if (targetSha === working.dismissedTargetSha) return { working, action: "noop-dismissed-pr" };
  if (targetSha === working.blockedTargetSha) return { working, action: "noop-blocked-sha" };

  if (working.inFlightRunId !== null) {
    const status = await runStatusOf(working.inFlightRunId);
    if (status === "queued" || status === "in_progress") {
      if (targetSha === working.inFlightTargetSha) return { working, action: "noop-304" };
    } else {
      working.inFlightRunId = null;
      working.inFlightTargetSha = null;
    }
  }
  if (working.openPrNumber !== null && targetSha === working.openPrTargetSha) return { working, action: "noop-304" };
  if (working.failedTargetSha === targetSha && working.failedAttempts >= 2) {
    // two failures of this target block it; a state that counted them without the block is brought to it
    working.blockedTargetSha = targetSha;
    return { working, action: "noop-blocked-sha" };
  }
  return { working, action: null };
}

// ---------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------

/** The data that a failure report needs, filled in as the job learns it. */
function newContext(io) {
  return { io, edge: null, correlationId: "", targetSha: null, dispatched: null, central: null, upstreamRepoHint: null, redactor: createRedactor() };
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = { ...resolveIo(ioInput), bash: ioInput.bash, randomUUID: ioInput.randomUUID, preflightDeps: ioInput.preflightDeps };
  // nothing that the job holds as a secret is ever written: every line, the decision log and the body of the issue pass through the redactor
  const redactor = createRedactor(secretsOfEnvironment(io.env));
  const rawStdout = io.stdout;
  const rawStderr = io.stderr;
  io.stdout = (text) => rawStdout(redactor.redact(text));
  io.stderr = (text) => rawStderr(redactor.redact(text));
  const ctx = newContext(io);
  ctx.redactor = redactor;
  const log = (line) => io.stdout(`route-upstream: ${line}\n`);
  ctx.log = log;
  try {
    parseFlags(argv, {});
    await route(ctx);
    return 0;
  } catch (error) {
    return await fail(ctx, error);
  }
}

function environmentOf(io) {
  const env = io.env;
  const central = String(env.GITHUB_REPOSITORY ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(central)) throw new UsageError("GITHUB_REPOSITORY must be the <owner>/<repository> of the orchestrator");
  const eventName = String(env.EVENT_NAME ?? "").trim();
  if (!EVENTS.includes(eventName)) throw new UsageError(`EVENT_NAME must be one of ${EVENTS.join(", ")}, got '${eventName.slice(0, 40)}'`);
  const upstreamKey = String(env.UPSTREAM_KEY ?? "").trim();
  if (upstreamKey === "") throw new UsageError("UPSTREAM_KEY is not set");
  return { central, eventName, upstreamKey };
}

async function route(ctx) {
  const { io, log } = ctx;
  const { central, eventName, upstreamKey } = environmentOf(io);
  ctx.central = central;
  const edge = parseEdgeJson(io.env.EDGE_JSON, upstreamKey);
  ctx.edge = edge;
  const workspace = workspaceOf(io);
  const startedAt = io.now();
  const deadlineMs = startedAt + ROUTER_TIMEOUT_MINUTES * 60 * 1000 - FAILURE_RESERVE_MS;
  ctx.correlationId = runCorrelationId(io.env) ?? (ioInputRandom(io) ?? "");

  // 1. the signal
  if (eventName === "repository_dispatch") {
    const payload = parseClientPayload(io.env.CLIENT_PAYLOAD);
    ctx.correlationId = payload.correlation_id;
    if (!matchesSignal(edge, payload)) {
      const manifest = loadManifestEdges(workspace, io);
      if (!manifest.found) throw new RoutingDataError(`sdlc.yaml is not in ${workspace}, so the signal for ${payload.upstream_repo} cannot be matched to an edge`);
      if (!manifest.edges.some((candidate) => matchesSignal(candidate, payload))) {
        throw new RoutingDataError(`no dependency edge has the upstream ${payload.upstream_repo} with the default branch ${payload.default_branch}`, { code: "unknown-signal" });
      }
      log(`the signal is for another edge (${payload.upstream_repo}); this job routes ${edge.upstreamRepo} and makes no request`);
      return;
    }
  }
  const resetBlocked = eventName === "workflow_dispatch" && parseBoolean(io.env.RESET_BLOCKED, "RESET_BLOCKED");
  if (ctx.correlationId === "") throw new UsageError("GITHUB_RUN_ID is not set and no correlation id was generated");

  // the manifest only tells which sync scopes an edge's workflow accepts; the job does not depend on it
  let manifestEdge;
  try {
    manifestEdge = loadManifestEdges(workspace, io).edges.find((candidate) => candidate.upstreamKey === edge.upstreamKey);
  } catch (error) {
    if (!(error instanceof RoutingDataError)) throw error;
    log(`sdlc.yaml is not read for the sync scopes: ${error.message}`);
  }

  // 2. the tokens and the clients
  const clientId = String(io.env.APP_CLIENT_ID ?? "").trim();
  const privateKey = String(io.env.APP_PRIVATE_KEY ?? "");
  if (clientId === "" || privateKey.trim() === "") throw new UsageError("APP_CLIENT_ID and APP_PRIVATE_KEY (the GitHub App's client ID and private key) are required");
  const baseUrl = resolveApiBase(io.env);
  const sleep = io.sleep ?? defaultSleep;
  const makeClient = (token) => createRestClient({ baseUrl, token, fetch: io.fetch, sleep, now: io.now, log, deadlineMs });
  const tokens = await mintRouterTokens({
    client: makeClient(""),
    clientId,
    privateKeyPem: privateKey,
    centralSlug: central,
    requiredReadSlugs: [edge.downstreamRepo],
    optionalReadSlugs: [edge.upstreamRepo],
    nowMs: io.now(),
    onSecret: ctx.redactor.add,
  });
  for (const note of tokens.notes) log(note);
  const write = makeClient(tokens.write);
  const readers = new Map();
  const readerFor = (slug) => {
    const token = tokens.readTokenFor(slug);
    if (!readers.has(token)) readers.set(token, makeClient(token));
    return readers.get(token);
  };

  // 3. what is read
  const { state: stored } = await readSyncState({ client: write, central, name: edge.stateVariable });
  const poll = await pollUpstream({ client: readerFor(edge.upstreamRepo), edge, state: stored });
  ctx.targetSha = poll.targetSha;
  const downstream = await readDownstream({ client: readerFor(edge.downstreamRepo), edge });
  const plan = planPreflight(edge);
  if (plan.commands.some((entry) => entry.kind === "studio-drift")) {
    await noteStudioProvenance({ client: readerFor(edge.downstreamRepo), edge, mainSha: downstream.mainSha, edgeCommit: downstream.provenanceCommit, log });
  }
  const openPr = stored.openPrNumber === null ? null : await readOpenPullRequest({ client: readerFor(edge.downstreamRepo), edge, number: stored.openPrNumber });

  // 4. the decision
  const { working, action: terminal } = await decide({
    stored,
    targetSha: poll.targetSha,
    mainSha: downstream.mainSha,
    provenanceCommit: downstream.provenanceCommit,
    provenanceLabel: `${edge.provenanceFile} of ${edge.downstreamRepo} at ${downstream.mainSha}`,
    baselineSha: edge.initialBaselineSha,
    openPr,
    resetBlocked,
    runStatusOf: (runId) => readRunStatus({ client: write, central, runId }),
  });
  const target = poll.targetSha;
  const persist = async (next) => {
    if (changedFields(stored, next).length > 0) await writeSyncState({ client: write, central, name: edge.stateVariable, state: { ...next, updatedAt: new Date(io.now()).toISOString() } });
  };
  const settle = (action, dispatchedWorkflowId = null) => {
    const decision = { correlationId: ctx.correlationId, upstreamRepo: edge.upstreamRepo, previousSha: working.lastMergedUpstreamSha, targetSha: target, action, dispatchedWorkflowId };
    assertShape("MergeRoutingDecision", decision, "the routing decision");
    const line = JSON.stringify(decision);
    const summary = String(io.env.GITHUB_STEP_SUMMARY ?? "").trim();
    if (summary !== "") io.fs.appendFileSync(summary, `${ctx.redactor.redact(line)}\n`);
    io.stdout(`routing-decision: ${line}\n`);
    return decision;
  };

  if (terminal !== null) {
    // a confirmed no-op after a 200 records what was observed; after a 304 there is nothing new to record
    const next = poll.status === 200 ? { ...working, etag: poll.heldEtag, lastObservedHeadSha: target } : working;
    await persist(next);
    settle(terminal);
    if (terminal !== "noop-blocked-sha") await resolveFailureIssue(ctx, terminal);
    return;
  }

  // 5. the preflight, then the dispatch
  let verdict = { drift: true, scope: null, noopAction: null, summary: "" };
  if (edge.preflightCommands.length > 0) {
    verdict = await runPreflight({
      edge,
      manifestEdge,
      targetSha: target,
      lastMergedSha: working.lastMergedUpstreamSha,
      downstreamSha: downstream.mainSha,
      workspace,
      serverUrl: String(io.env.GITHUB_SERVER_URL ?? "").trim() || "https://github.com",
      environment: io.env,
      readTokenFor: (slug) => tokens.readTokenFor(slug),
      readClientFor: readerFor,
      bash: io.bash,
      deps: io.preflightDeps,
      log,
    });
    log(`preflight: ${verdict.drift ? "material change" : "nothing material"} (${verdict.summary})`);
  }
  if (!verdict.drift) {
    await persist({ ...working, etag: poll.heldEtag, lastObservedHeadSha: target, lastNoopHeadSha: target, portfolioMainSha: downstream.mainSha });
    settle(verdict.noopAction);
    await resolveFailureIssue(ctx, verdict.noopAction);
    return;
  }

  const file = cascadeWorkflowFile(edge);
  const inputs = dispatchInputs({
    edge,
    correlationId: ctx.correlationId,
    previousSha: working.lastMergedUpstreamSha,
    targetSha: target,
    etag: poll.heldEtag,
    prNumber: poll.prNumber,
    syncScope: edge.mode === "ai-adaptation" ? (verdict.scope ?? chooseDefaultScope(manifestEdge)) : null,
  });
  const centralRepo = await write.requestJson("GET", repoPath(central), { expect: [200] });
  const ref = centralRepo.json?.default_branch;
  if (typeof ref !== "string" || ref === "") throw new RoutingDataError(`${central} has no default branch in its repository response`);
  const details = await dispatchWorkflow({ client: write, central, ref, file, inputs, deadlineMs, log });
  ctx.dispatched = { runId: details.workflow_run_id, file };
  log(`dispatched ${file} as run ${details.workflow_run_id} for ${target}`);
  await persist({ ...working, inFlightRunId: details.workflow_run_id, inFlightTargetSha: target });
  const action = edge.mode === "mechanical" ? "dispatch-mechanical" : "dispatch-ai-adaptation";
  settle(action, file);
  await resolveFailureIssue(ctx, action);
  // the queued cascade run takes the lock of this upstream once this job ends; consecutive dispatches stay five seconds apart [F65]
  await sleep(DISPATCH_GAP_MS);
}

function chooseDefaultScope(manifestEdge) {
  const allowed = manifestEdge?.syncScopes;
  return Array.isArray(allowed) && allowed.length > 0 && !allowed.includes("both") ? allowed[0] : "both";
}

function ioInputRandom(io) {
  return typeof io.randomUUID === "function" ? io.randomUUID() : globalThis.crypto?.randomUUID?.() ?? null;
}

/** The studio helper's own provenance, beside the edge's: a difference is noted and never decides (AC14). */
async function noteStudioProvenance({ client, edge, mainSha, edgeCommit, log }) {
  try {
    const studio = await readProvenance({ client, slug: edge.downstreamRepo, file: STUDIO_PROVENANCE.file, pointer: STUDIO_PROVENANCE.pointer, ref: mainSha });
    if (studio === null) log(`${STUDIO_PROVENANCE.file} does not exist in ${edge.downstreamRepo}; its provenance is not compared`);
    else if (studio !== edgeCommit) log(`provenance mismatch (recorded, not an error): ${edge.provenanceFile} records ${edgeCommit ?? "no commit"}, ${STUDIO_PROVENANCE.file} records ${studio}; ${edge.provenanceFile} is authoritative`);
  } catch (error) {
    log(`${STUDIO_PROVENANCE.file} could not be read for the decision log (${error.message}); it decides nothing`);
  }
}

// ---------------------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------------------

/** What a failure report says about a request that failed: the status, the path, the permission header and the rate-limit evidence that were seen. */
function evidenceOf(error) {
  const extra = {};
  if (error instanceof RestError) {
    if (error.status !== null) extra.Status = String(error.status);
    if (error.path) extra.Request = `${error.method} ${error.path}`;
    if (error.permissions) extra["X-Accepted-GitHub-Permissions"] = error.permissions;
    if (error.rateLimit) extra["Rate limit"] = `HTTP ${error.rateLimit.status}; x-ratelimit-remaining=${error.rateLimit.remaining ?? "-"}, x-ratelimit-reset=${error.rateLimit.reset ?? "-"}, retry-after=${error.rateLimit.retryAfter ?? "-"}`;
  }
  return extra;
}

function issuesContextOf(ctx) {
  const { io } = ctx;
  const token = String(io.env.ISSUES_TOKEN ?? "").trim();
  const central = ctx.central ?? String(io.env.GITHUB_REPOSITORY ?? "").trim();
  if (token === "" || !/^[^/]+\/[^/]+$/.test(central)) return null;
  assertInstallationToken(token, "the issues token");
  const client = createRestClient({ baseUrl: resolveApiBase(io.env), token, fetch: io.fetch, sleep: io.sleep ?? defaultSleep, now: io.now, log: (line) => io.stderr(`route-upstream: ${line}\n`), deadlineMs: io.now() + FAILURE_RESERVE_MS });
  const run = String(io.env.GITHUB_RUN_ID ?? "").trim();
  const server = String(io.env.GITHUB_SERVER_URL ?? "").trim() || "https://github.com";
  return { client, central, runUrl: run === "" ? "" : `${server.replace(/\/+$/, "")}/${central}/actions/runs/${run}` };
}

/** Writes nothing to the state, opens or updates the one issue of this upstream, and returns the exit code. */
async function fail(ctx, error) {
  const { io } = ctx;
  const message = error?.message ?? String(error);
  io.stderr(`route-upstream: ${message}\n`);
  const usage = error instanceof UsageError || error?.name === "GitHubApiError";
  const subject = ctx.edge?.upstreamRepo ?? (String(io.env.UPSTREAM_KEY ?? "").trim() || "unknown upstream");
  const extra = evidenceOf(error);
  if (ctx.dispatched) extra["Dispatched run"] = `${ctx.dispatched.file} run ${ctx.dispatched.runId}`;
  try {
    const issues = issuesContextOf(ctx);
    if (issues === null) {
      io.stderr("route-upstream: no [sdlc-failure] issue was opened: the token of the job (issues: write) or the repository is not set\n");
      return usage ? 2 : 1;
    }
    const input = {
      workflowId: "cascade-router",
      subject,
      correlationId: ctx.correlationId,
      targetSha: ctx.targetSha,
      reason: message,
      runUrl: issues.runUrl,
      nowIso: new Date(io.now()).toISOString(),
      extra,
    };
    const outcome = await upsertFailureIssue({
      client: issues.client,
      central: issues.central,
      title: failureTitle("cascade-router", subject),
      body: ctx.redactor.redact(composeFailureBody(input)),
      comment: ctx.redactor.redact(composeFailureComment(input)),
    });
    io.stderr(`route-upstream: ${outcome.action === "created" ? "opened" : "commented on"} issue #${outcome.number}\n`);
  } catch (issueError) {
    io.stderr(`route-upstream: the [sdlc-failure] issue could not be written: ${issueError?.message ?? issueError}\n`);
  }
  return usage ? 2 : 1;
}

/** Closes any open [sdlc-failure] issue for this upstream once a routing run succeeds. */
async function resolveFailureIssue(ctx, action) {
  const { io } = ctx;
  const subject = ctx.edge?.upstreamRepo;
  if (!subject) return;
  try {
    const issues = issuesContextOf(ctx);
    if (issues === null) return;
    const input = {
      workflowId: "cascade-router",
      subject,
      correlationId: ctx.correlationId,
      targetSha: ctx.targetSha,
      reason: `resolved (${action})`,
      runUrl: issues.runUrl,
      nowIso: new Date(io.now()).toISOString(),
    };
    const outcome = await closeFailureIssue({
      client: issues.client,
      central: issues.central,
      title: failureTitle("cascade-router", subject),
      comment: ctx.redactor.redact(composeResolutionComment(input)),
    });
    if (outcome.action === "closed") ctx.log(`closed issue #${outcome.number} ${outcome.url}`.trim());
  } catch (issueError) {
    io.stderr(`route-upstream: the [sdlc-failure] issue could not be closed: ${issueError?.message ?? issueError}\n`);
  }
}

await runAsMain(import.meta.url, run);
