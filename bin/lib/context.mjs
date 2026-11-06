// The dependencies of a run, gathered in one object so that the entry points use the real ones and the
// hermetic tests substitute fakes (a fake GitHub API through GITHUB_API_URL or `fetch`, a recording
// `runGh`, a stub browser opener, prompt and reconciler).

import { createGhRunner } from "./gh-runner.mjs";
import { createLogger } from "./logger.mjs";
import { openInBrowser } from "./browser.mjs";
import { createPrompt } from "./prompt.mjs";
import { FLOW_TIMEOUT_MS } from "./manifest-flow.mjs";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./installations.mjs";
import { EXIT_FAILURE, SdlcError } from "./errors.mjs";

/**
 * @param {object} [overrides] any of env, cwd, stdout, stderr, logger, fetch, runGh, openBrowser, prompt, reconcile,
 *   now, signal and timing ({ flowTimeoutMs, pollIntervalMs, pollTimeoutMs })
 */
export function createContext(overrides = {}) {
  const env = overrides.env ?? process.env;
  const stderr = overrides.stderr ?? process.stderr;
  return {
    env,
    cwd: overrides.cwd ?? process.cwd(),
    stdout: overrides.stdout ?? process.stdout,
    stderr,
    logger: overrides.logger ?? createLogger(stderr),
    fetch: overrides.fetch ?? globalThis.fetch,
    runGh: overrides.runGh ?? createGhRunner({ env }),
    openBrowser: overrides.openBrowser ?? openInBrowser,
    prompt: overrides.prompt ?? createPrompt({ stderr }),
    reconcile: overrides.reconcile,
    fs: overrides.fs,
    now: overrides.now ?? (() => new Date()),
    signal: overrides.signal,
    timing: {
      flowTimeoutMs: FLOW_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollTimeoutMs: POLL_TIMEOUT_MS,
      ...(overrides.timing ?? {}),
    },
  };
}

/** Prints a failure on stderr (redacted) and returns the process exit code. */
export function reportFailure(error, ctx) {
  if (error instanceof SdlcError) {
    ctx.logger.error(error.message);
    return error.exitCode;
  }
  ctx.logger.error(`unexpected failure: ${error?.message ?? error}`);
  return EXIT_FAILURE;
}
