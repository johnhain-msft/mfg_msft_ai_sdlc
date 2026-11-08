// Actions variables on the central orchestrator repository (AC21-AC24). The writer accepts exactly two
// kinds of name: APP_CLIENT_ID (upsert: PATCH, then POST on 404) and SDLC_SYNC_STATE_<SLUG> (create only
// when GET answers 404; an existing state variable is never updated, overwritten or deleted, because S3
// is the sole writer of existing state variables).

import { SdlcError } from "./errors.mjs";
import { splitSlug } from "./validators.mjs";

export const APP_CLIENT_ID_VARIABLE = "APP_CLIENT_ID";
export const POLL_STATE_VAR_PREFIX = "SDLC_SYNC_STATE_";
export const MAX_VARIABLE_BYTES = 48 * 1024;

const SLUG = /^[A-Z0-9_]{1,64}$/;
const ACTIONS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** SDLC_SYNC_STATE_<SLUG> for an edge's upstreamSlug. */
export const stateVariableName = (upstreamSlug) => `${POLL_STATE_VAR_PREFIX}${upstreamSlug}`;

/** True for APP_CLIENT_ID and for SDLC_SYNC_STATE_<SLUG> with a valid slug. */
export function isStateVariable(name) {
  return typeof name === "string" && name.startsWith(POLL_STATE_VAR_PREFIX) && SLUG.test(name.slice(POLL_STATE_VAR_PREFIX.length));
}

/**
 * Refuses, before any request, a name outside the allowlist, a name that breaks the Actions naming rules and a value over 48 KB.
 * @throws {SdlcError}
 */
export function assertWritableVariable(name, value) {
  const allowed = name === APP_CLIENT_ID_VARIABLE || isStateVariable(name);
  if (!allowed) {
    throw new SdlcError(
      `refusing to write the variable '${name}': only ${APP_CLIENT_ID_VARIABLE} and ${POLL_STATE_VAR_PREFIX}<SLUG> (a slug of [A-Z0-9_], 1 to 64 characters) are written. ` +
        "In particular no GH_AW_POLICY_ variable is ever set: GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST=\"false\" makes the safe-outputs server refuse to start for every workflow that creates pull requests.",
      { code: "variable-name" },
    );
  }
  if (!ACTIONS_NAME.test(name) || /^github_/i.test(name)) {
    throw new SdlcError(`the variable name '${name}' breaks the Actions naming rules (alphanumerics and underscores, no GITHUB_ prefix, no leading digit)`, { code: "variable-name" });
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_VARIABLE_BYTES) {
    throw new SdlcError(`the value of '${name}' is not a string of at most 48 KB`, { code: "variable-value" });
  }
}

/** The 14-field initial state of a new SDLC_SYNC_STATE_<SLUG> variable (SPEC-03 AC13 owns the shape; S5 seeds it). */
export function initialSyncState(baselineSha, nowIso) {
  return {
    etag: "",
    lastObservedHeadSha: baselineSha,
    lastMergedUpstreamSha: baselineSha,
    portfolioMainSha: null,
    lastNoopHeadSha: null,
    dismissedTargetSha: null,
    failedTargetSha: null,
    failedAttempts: 0,
    blockedTargetSha: null,
    inFlightRunId: null,
    inFlightTargetSha: null,
    openPrTargetSha: null,
    openPrNumber: null,
    updatedAt: nowIso,
  };
}

const variablesPath = (repoSlug) => {
  const { owner, repo } = splitSlug(repoSlug);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables`;
};

function variablesFailure({ api, method, route, response, repo }) {
  const message = typeof response.json?.message === "string" ? ` (${response.json.message})` : "";
  return new SdlcError(
    `${method} ${route} answered ${response.status}${message}: writing Actions variables on ${repo} needs the 'Variables' repository permission (write); ` +
      `the token in use is a ${api.kind}. No later write was made.`,
    { code: "variables-failed" },
  );
}

/**
 * APP_CLIENT_ID: PATCH the named variable first and POST to the collection only when PATCH answers 404.
 * @param {{ api: object, repo: string }} context the API client and the central repository slug
 */
export async function upsertAppClientId(context, value) {
  const name = APP_CLIENT_ID_VARIABLE;
  assertWritableVariable(name, value);
  const { api, repo } = context;
  const base = variablesPath(repo);
  const patch = await api.request("PATCH", `${base}/${name}`, { body: { name, value } });
  if (patch.ok) return { name, outcome: "updated" };
  if (patch.status !== 404) throw variablesFailure({ api, method: "PATCH", route: `${base}/${name}`, response: patch, repo });
  const post = await api.request("POST", base, { body: { name, value } });
  if (post.ok) return { name, outcome: "created" };
  throw variablesFailure({ api, method: "POST", route: base, response: post, repo });
}

/**
 * SDLC_SYNC_STATE_<SLUG>: GET first; POST only on 404. A 200 leaves the variable untouched, a 409 on the POST is treated as
 * "exists" (never a fallback to PATCH), and any other status aborts without writing.
 * @returns {Promise<{ name: string, outcome: "created" | "exists" | "exists-conflict" }>}
 */
export async function createStateVariableIfMissing(context, name, value) {
  if (!isStateVariable(name)) {
    throw new SdlcError(`'${name}' is not a ${POLL_STATE_VAR_PREFIX}<SLUG> variable`, { code: "variable-name" });
  }
  assertWritableVariable(name, value);
  const { api, repo } = context;
  const base = variablesPath(repo);
  const existing = await api.request("GET", `${base}/${name}`);
  if (existing.status === 200) return { name, outcome: "exists" };
  if (existing.status !== 404) throw variablesFailure({ api, method: "GET", route: `${base}/${name}`, response: existing, repo });
  const post = await api.request("POST", base, { body: { name, value } });
  if (post.ok) return { name, outcome: "created" };
  if (post.status === 409) return { name, outcome: "exists-conflict" };
  throw variablesFailure({ api, method: "POST", route: base, response: post, repo });
}

/**
 * The generic entry point: validates the name and value first (so a refused write makes no request), then dispatches
 * by name: APP_CLIENT_ID is upserted, a state variable is created only when missing.
 */
export async function writeVariable(name, value, context) {
  assertWritableVariable(name, value);
  return name === APP_CLIENT_ID_VARIABLE ? upsertAppClientId(context, value) : createStateVariableIfMissing(context, name, value);
}
