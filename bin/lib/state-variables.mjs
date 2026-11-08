// The per-edge state variables SDLC_SYNC_STATE_<SLUG> (AC23, AC24, AC52): planned from the edges before anything is
// written, created only when GET answers 404, and never updated, overwritten or deleted afterwards.

import { SdlcError } from "./errors.mjs";
import { createStateVariableIfMissing, initialSyncState, stateVariableName } from "./actions-variables.mjs";

const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Z0-9_]{1,64}$/;

/** variable name -> initialBaselineSha; refuses an edge that cannot be seeded, before anything is written. */
export function stateVariablePlan(edges) {
  const plan = new Map();
  for (const edge of edges) {
    if (typeof edge.upstreamSlug !== "string" || !SLUG.test(edge.upstreamSlug)) {
      throw new SdlcError(`edge '${edge.edgeId ?? "?"}' has no valid upstreamSlug (/^[A-Z0-9_]{1,64}$/)`, { code: "state-variable" });
    }
    if (typeof edge.initialBaselineSha !== "string" || !SHA.test(edge.initialBaselineSha)) {
      throw new SdlcError(`edge '${edge.edgeId ?? "?"}' has no valid initialBaselineSha (40 lowercase hexadecimal characters)`, { code: "state-variable" });
    }
    const name = stateVariableName(edge.upstreamSlug);
    if (!plan.has(name)) plan.set(name, edge.initialBaselineSha);
  }
  return plan;
}

/** Creates every missing state variable (404 only) and says what was left alone. Returns the names created. */
export async function seedStateVariables({ api, repo, plan, nowIso, logger }) {
  const created = [];
  const existing = [];
  for (const [name, baselineSha] of plan) {
    const outcome = await createStateVariableIfMissing({ api, repo }, name, JSON.stringify(initialSyncState(baselineSha, nowIso)));
    if (outcome.outcome === "created") created.push(name);
    else existing.push(name);
    if (outcome.outcome === "exists-conflict") logger.warn(`${name} was created concurrently (HTTP 409); it is treated as existing and left unchanged`);
  }
  if (existing.length > 0) {
    logger.info(
      `Existing state variables were left unchanged: ${existing.join(", ")}. S3 is their only writer; an operator reset goes through ` +
        "cascade-router.yml workflow_dispatch with reset_blocked: true, inside the sdlc-state-<upstreamKey> concurrency lock.",
    );
  }
  return created;
}
