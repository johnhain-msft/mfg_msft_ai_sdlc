// The correlation id of a run of a drift workflow (SPEC-02 AC8, AC30).
//
// A dispatch can give one (`correlation_id`, which `prepare-run` records in run-context.json and the failure escalation writes into the
// `sdlc-gate-failure` issue). A scheduled run has no dispatch input, so both scripts derive the same id from the Actions run itself,
// `run-<run id>-<run attempt>`, and a failure issue and the run context of one run therefore name the same id.

/** What a correlation id may look like: 1 to 128 characters of letters, digits and . _ : / + = -, starting with a letter or a digit. */
export const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,127}$/;

/**
 * The id that the Actions run implies: `run-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`, the attempt being 1 when the variable is not set. When
 * GITHUB_RUN_ID is not set either, the run id (and the attempt, if it has one) is taken from `runUrl`, the address of the run
 * (`.../actions/runs/<id>` and, for a re-run, `.../attempts/<n>`). Returns null when no run is named, or when the id that it names cannot be an id.
 * @param {Record<string, string | undefined>} env
 * @param {string} [runUrl]
 * @returns {string | null}
 */
export function runCorrelationId(env, runUrl = "") {
  const url = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?/.exec(String(runUrl));
  const fromEnv = String(env.GITHUB_RUN_ID ?? "").trim();
  const runId = fromEnv || (url?.[1] ?? "");
  if (runId === "") return null;
  // the attempt of the URL belongs to the run of the URL, so it is not mixed with a run id that came from the environment
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim() || (fromEnv === "" ? url?.[2] : undefined) || "1";
  const derived = `run-${runId}-${attempt}`;
  return CORRELATION_ID.test(derived) ? derived : null;
}
