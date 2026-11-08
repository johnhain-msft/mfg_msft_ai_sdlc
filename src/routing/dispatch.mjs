// The asynchronous dispatch of a cascade workflow (SPEC-03 AC34-AC39, AC65; contract C7).
//
// POST /repos/{central}/actions/workflows/{workflow_file}/dispatches with `return_run_details: true`, which REST API version 2022-11-28 answers
// with 200 and { workflow_run_id, run_url, html_url }, and with an empty 204 when it is false. A response without a numeric workflow_run_id is a failed
// dispatch, whatever its status: nothing is recorded for it, and it is not retried (the run may exist). The request is retried only after a 404 or a 422
// (the workflow file may not be registered yet) or a rate limit, at most three attempts in all, and the waits follow SPEC-03 AC27 (the primary limit
// first, then retry-after, then at least a minute with a back-off). All of the values of `inputs` are strings.

import { assertShape } from "./schema.mjs";
import { describeRateLimit, isRateLimited, rateLimitEvidence, rateLimitWait, repoPath, RestError } from "./rest.mjs";

/** Consecutive dispatches are kept at least this far apart: the router waits this long after each one [F65]. */
export const DISPATCH_GAP_MS = 5000;
export const MAX_DISPATCH_ATTEMPTS = 3;

/** The dispatch did not start a run that the router can follow. */
export class DispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * The `inputs` of the dispatch: the ten inputs of an AI-adaptation workflow (AC35), or the eight of the mechanical workflow (AC65: without
 * sync_scope and on_commit_only_advance). `previous_sha` is always the merge cursor of the state (AC36).
 * @throws {import("./schema.mjs").RoutingDataError} when a value does not have the shape of the workflow's input
 */
export function dispatchInputs({ edge, correlationId, previousSha, targetSha, etag, prNumber, syncScope }) {
  const inputs = {
    correlation_id: correlationId,
    upstream_repo: edge.upstreamRepo,
    previous_sha: previousSha,
    upstream_sha: targetSha,
    upstream_etag: etag,
    upstream_pr_number: prNumber === null || prNumber === undefined ? "" : String(prNumber),
    downstream_repo: edge.downstreamRepo,
  };
  if (edge.mode === "ai-adaptation") {
    inputs.sync_scope = syncScope;
    inputs.on_commit_only_advance = edge.onCommitOnlyAdvance;
  }
  inputs.dry_run = "false";
  assertShape(edge.mode === "ai-adaptation" ? "AiCascadeDispatchInputs" : "MechanicalDispatchInputs", inputs, "the dispatch inputs");
  return inputs;
}

/**
 * @param {object} input
 * @param {ReturnType<import("./rest.mjs").createRestClient>} input.client the client of the App installation token
 * @param {string} input.central the orchestrator repository
 * @param {string} input.ref the branch that holds the workflow files
 * @param {string} input.file the workflow file, e.g. cascade-ai-<edge>.lock.yml
 * @param {Record<string, string>} input.inputs
 * @param {number} input.deadlineMs the instant that no wait may pass
 * @param {(line: string) => void} input.log
 * @returns {Promise<{ workflow_run_id: number, run_url: string, html_url: string }>}
 * @throws {DispatchError | RestError}
 */
export async function dispatchWorkflow({ client, central, ref, file, inputs, deadlineMs, log }) {
  const apiPath = `${repoPath(central)}/actions/workflows/${encodeURIComponent(file)}/dispatches`;
  const target = `POST ${apiPath}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await client.request("POST", apiPath, { body: { ref, inputs, return_run_details: true }, rateLimitHandling: "caller" });
    if (response.status === 200) {
      const details = response.json;
      if (details === null || typeof details !== "object" || !Number.isInteger(details.workflow_run_id) || details.workflow_run_id < 1) {
        throw new DispatchError(`${target} answered 200 without a numeric workflow_run_id, so the dispatch is not recorded`);
      }
      assertShape("WorkflowDispatchRunDetails", details, "the dispatch response");
      return details;
    }
    if (response.status === 204) {
      throw new DispatchError(`${target} answered 204 with no run details although return_run_details was true, so the run is not known and nothing is recorded`);
    }
    const limited = isRateLimited(response.status, response.headers, response.json?.message ?? response.text);
    if (!(response.status === 404 || response.status === 422 || limited)) throw client.unexpected("POST", apiPath, response, [200]);
    const evidence = rateLimitEvidence(response.status, response.headers);
    if (attempt >= MAX_DISPATCH_ATTEMPTS) {
      const error = client.unexpected("POST", apiPath, response, [200]);
      error.message = `${error.message} (${attempt} attempts)`;
      throw error;
    }
    const { ms, basis } = rateLimitWait(response.headers, { now: client.now, attempt: attempt - 1 });
    if (client.now() + ms > deadlineMs) {
      log(`dispatch: ${file} answered ${describeRateLimit(evidence)}; the wait of ${Math.ceil(ms / 1000)} s (${basis}) passes the budget of the run, so it is not taken`);
      throw new RestError(`${target} answered HTTP ${response.status} and the wait of ${Math.ceil(ms / 1000)} s before the next attempt passes the budget of this run`, { kind: "budget", status: response.status, method: "POST", path: apiPath, rateLimit: evidence });
    }
    log(`dispatch: ${file} answered ${describeRateLimit(evidence)}; waiting ${Math.ceil(ms / 1000)} s (${basis}), attempt ${attempt + 1} of ${MAX_DISPATCH_ATTEMPTS}`);
    await client.sleep(ms);
  }
}
