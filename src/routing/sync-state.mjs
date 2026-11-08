// The durable per-upstream state, SDLC_SYNC_STATE_<SLUG> (SPEC-03 AC13), as data: its fields, the checks that a value must pass before a script
// relies on it or writes it, and the one transition that both the router and the poll-state script share (AC49, AC50).
//
// Nothing here reads or writes the variable: src/update-poll-state.mjs is the only file that does.

import { assertShape, isRealUtcTimestamp, RoutingDataError } from "./schema.mjs";

/** The 14 fields, in the order in which they are serialised. */
export const SYNC_STATE_FIELDS = Object.freeze([
  "etag",
  "lastObservedHeadSha",
  "lastMergedUpstreamSha",
  "portfolioMainSha",
  "lastNoopHeadSha",
  "dismissedTargetSha",
  "failedTargetSha",
  "failedAttempts",
  "blockedTargetSha",
  "inFlightRunId",
  "inFlightTargetSha",
  "openPrTargetSha",
  "openPrNumber",
  "updatedAt",
]);

/** The limit of one Actions variable [F67]: 48 KB. */
export const MAX_VARIABLE_BYTES = 48 * 1024;

/** The fields that carry no information about the upstream: a write that would change only these is not a change. */
export const BOOKKEEPING_FIELDS = Object.freeze(["updatedAt"]);

const canonical = (state) => Object.fromEntries(SYNC_STATE_FIELDS.map((field) => [field, state[field]]));

/**
 * Checks an object against SyncState and against the pairs of fields that the router's comparisons rely on: a run id without the revision it was
 * dispatched for, or a pull request number without its revision, is a state that no script wrote.
 * @returns {object} the same fields, in the serialisation order
 * @throws {RoutingDataError}
 */
export function validateSyncState(value, label = "the sync state") {
  assertShape("SyncState", value, label);
  if (!isRealUtcTimestamp(value.updatedAt)) throw new RoutingDataError(`${label}.updatedAt '${value.updatedAt}' is not a real UTC timestamp`);
  if ((value.inFlightRunId === null) !== (value.inFlightTargetSha === null)) {
    throw new RoutingDataError(`${label} records inFlightRunId without inFlightTargetSha, or the reverse: the pair is written together`);
  }
  if ((value.openPrNumber === null) !== (value.openPrTargetSha === null)) {
    throw new RoutingDataError(`${label} records openPrNumber without openPrTargetSha, or the reverse: the pair is written together`);
  }
  return canonical(value);
}

/** Parses the text of the variable. @throws {RoutingDataError} */
export function parseSyncState(text, label = "the sync state") {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (error) {
    throw new RoutingDataError(`${label} is not JSON: ${error.message}`);
  }
  return validateSyncState(value, label);
}

/**
 * The text to write: validated, in the serialisation order and within 48 KB. A value that is too large is refused here, before any request.
 * @throws {RoutingDataError}
 */
export function serializeSyncState(state, label = "the sync state") {
  const checked = validateSyncState(state, label);
  const text = JSON.stringify(checked);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_VARIABLE_BYTES) {
    throw new RoutingDataError(`${label} is ${bytes} bytes; refusing to send a value above the 48 KB limit of an Actions variable`, { code: "too-large" });
  }
  return text;
}

/** The fields whose values differ between two states, leaving out the bookkeeping fields. */
export function changedFields(before, after) {
  return SYNC_STATE_FIELDS.filter((field) => !BOOKKEEPING_FIELDS.includes(field) && before[field] !== after[field]);
}

/**
 * The failure transition (AC49, AC50): clears the in-flight pair, counts the failure against the target (a second one in a row for the same
 * target is the second attempt, anything else the first), blocks the target at two attempts and leaves every success cursor alone.
 */
export function failureTransition(state, targetSha, updatedAt) {
  const attempts = state.failedTargetSha === targetSha ? state.failedAttempts + 1 : 1;
  return {
    ...state,
    inFlightRunId: null,
    inFlightTargetSha: null,
    failedAttempts: attempts,
    failedTargetSha: targetSha,
    blockedTargetSha: attempts >= 2 ? targetSha : state.blockedTargetSha,
    updatedAt,
  };
}

/** The success cursors that a failure never moves (AC49). */
export const SUCCESS_CURSORS = Object.freeze(["etag", "lastObservedHeadSha", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha", "openPrNumber"]);
