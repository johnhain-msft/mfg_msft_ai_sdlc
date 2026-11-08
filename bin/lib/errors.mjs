// Error type shared by the bootstrap and onboarding entry points: a message for the operator and
// the process exit code to use. Anything else that is thrown is a bug and exits with code 1 too.

export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export class SdlcError extends Error {
  /**
   * @param {string} message diagnostic for the operator; it must never contain a secret value
   * @param {{ exitCode?: number, code?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "SdlcError";
    this.exitCode = options.exitCode ?? EXIT_FAILURE;
    this.code = options.code ?? "sdlc-error";
  }
}

export const usageError = (message) => new SdlcError(message, { exitCode: EXIT_USAGE, code: "usage" });
