// Contract C1 on the sender's side (AC33-AC38): S5 builds the nine-field BootstrapReconcileRequest, hands it
// to src/reconcile.mjs (S1) through the named export reconcile(request) and validates the ReconcileResult
// that comes back. S5 sends no field beyond the nine and never writes what S1 owns.

import { SdlcError } from "./errors.mjs";
import { loadPermissionMap } from "./app-manifest.mjs";
import { POLL_STATE_VAR_PREFIX } from "./actions-variables.mjs";

const ENGINE_AUTH_MODES = ["copilot-requests", "copilot-pat", "api-key"];
const RESULT_KEYS = ["status", "generatedWorkflows", "repoConfigPath", "validationResults"];

/** Fixed in code (AC35): no flag, environment variable or sdlc.yaml value changes them. */
export const SECURITY_BASELINE_CONSTANTS = Object.freeze({
  minGhAwVersion: "1.0.1",
  requireStrictMode: true,
  requireThreatDetection: true,
  forbidAutoMerge: true,
});

/**
 * @param {{ manifestPath: string, appSlug: string, engineAuthMode: string, ghAwVersionPin: string, dryRun?: boolean }} input
 *   `dryRun` is false for every operator run; only S5's own offline tests pass true
 * @returns BootstrapReconcileRequest with exactly the nine keys of C1, in order
 */
export function buildReconcileRequest({ manifestPath, appSlug, engineAuthMode, ghAwVersionPin, dryRun = false }) {
  if (!ENGINE_AUTH_MODES.includes(engineAuthMode)) throw new SdlcError(`engineAuthMode '${engineAuthMode}' is not one of ${ENGINE_AUTH_MODES.join(", ")}`, { code: "c1-request" });
  return {
    manifestPath,
    appSlug,
    appClientIdVar: "APP_CLIENT_ID",
    appPrivateKeySecret: "APP_PRIVATE_KEY",
    pollStateVarPrefix: POLL_STATE_VAR_PREFIX,
    engineAuthMode,
    ghAwVersionPin,
    securityBaseline: {
      minGhAwVersion: SECURITY_BASELINE_CONSTANTS.minGhAwVersion,
      grantedAppPermissions: loadPermissionMap(),
      requireStrictMode: SECURITY_BASELINE_CONSTANTS.requireStrictMode,
      requireThreatDetection: SECURITY_BASELINE_CONSTANTS.requireThreatDetection,
      forbidAutoMerge: SECURITY_BASELINE_CONSTANTS.forbidAutoMerge,
    },
    dryRun: dryRun === true,
  };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Checks a ReconcileResult against its contract shape; returns the list of problems (empty when it is well formed). */
export function reconcileResultProblems(result) {
  if (!isObject(result)) return ["the response is not an object"];
  const problems = [];
  for (const key of RESULT_KEYS) if (!(key in result)) problems.push(`the response has no '${key}'`);
  for (const key of Object.keys(result)) if (!RESULT_KEYS.includes(key)) problems.push(`the response has the unexpected key '${key}'`);
  if ("status" in result && result.status !== "ok" && result.status !== "error") problems.push(`status '${result.status}' is not "ok" or "error"`);
  if ("generatedWorkflows" in result) {
    const valid =
      Array.isArray(result.generatedWorkflows) &&
      result.generatedWorkflows.every((entry) => isObject(entry) && typeof entry.sourceMd === "string" && typeof entry.lockYml === "string");
    if (!valid) problems.push("generatedWorkflows is not an array of { sourceMd, lockYml } strings");
  }
  if ("repoConfigPath" in result && typeof result.repoConfigPath !== "string") problems.push("repoConfigPath is not a string");
  if ("validationResults" in result) {
    const valid =
      Array.isArray(result.validationResults) &&
      result.validationResults.every((entry) => isObject(entry) && typeof entry.file === "string" && typeof entry.valid === "boolean" && isStringArray(entry.errors));
    if (!valid) problems.push("validationResults is not an array of { file, valid, errors } entries");
  }
  return problems;
}

/**
 * Sends the request to S1 and validates the answer. Returns { result, compiledWorkflows } on success and throws an
 * SdlcError that lists every S1 error with its file, followed by a Remediation section, on any failure.
 * @param {{ request: object, reconcile: Function, cwd: string, env: object, logger: object, restored: string }} input
 *   `restored` says what S5 itself put back (for the operator's remediation text)
 */
export async function sendToReconciler({ request, reconcile, cwd, env, logger, restored }) {
  let result;
  try {
    result = await reconcile(request, { cwd, env, log: (line) => logger.info(line) });
  } catch (error) {
    throw new SdlcError(`src/reconcile.mjs failed unexpectedly: ${error?.message ?? error}`, { code: "c1-failed" });
  }
  const problems = reconcileResultProblems(result);
  if (problems.length > 0) {
    throw new SdlcError(`src/reconcile.mjs returned a malformed ReconcileResult: ${problems.join("; ")}`, { code: "c1-malformed" });
  }
  const failed = result.validationResults.filter((entry) => !entry.valid);
  if (result.status === "error" || failed.length > 0) {
    const lines = result.validationResults.flatMap((entry) => entry.errors.map((error) => `  ${entry.file}: ${error}`));
    if (lines.length === 0) lines.push("  (src/reconcile.mjs reported an error without a diagnostic)");
    if (result.status === "ok") lines.unshift("  src/reconcile.mjs reported status ok with an invalid validation result");
    throw new SdlcError(
      `src/reconcile.mjs (S1) rejected the manifest; no workflow was compiled:\n${lines.join("\n")}\n` +
        "Remediation (external:operator): fix what the lines above name — an sdlc.yaml schema error, a permission above the granted App permissions, " +
        "an enabled auto-merge or a gh aw compile --strict error — and run the command again. " +
        `S1 rolled back its workflow edits, so .github/workflows/ and schemas/ are as they were before this run${restored ? `; ${restored}` : ""}.`,
      { code: "c1-error" },
    );
  }
  return { result, compiledWorkflows: result.generatedWorkflows.map((entry) => entry.lockYml) };
}

/** The real reconciler: the named export of src/reconcile.mjs. */
export async function loadReconciler() {
  const module = await import("../../src/reconcile.mjs");
  return module.reconcile;
}
