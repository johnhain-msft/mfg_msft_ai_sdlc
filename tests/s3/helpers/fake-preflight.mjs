// A fake of the processes that a preflight starts (src/routing/preflight.mjs `deps`): checkouts that only record what they were asked, and a shell that
// answers from a list. It lets the classification of the reports be tested case by case without starting git or bash; the real processes are exercised by
// tests/s3/router-preflight.test.mjs.

/**
 * @param {Array<{ match: RegExp, code?: number, stdout?: string, stderr?: string, error?: string, timedOut?: boolean, then?: (call: object) => void }>} responses
 */
export function fakePreflight(responses = []) {
  const calls = [];
  const checkouts = [];
  const clones = [];
  return {
    calls,
    checkouts,
    clones,
    deps: {
      async ensureCheckout(input) {
        checkouts.push(input);
        return { dir: input.dir, reused: false };
      },
      async execute(command, args, options) {
        const script = args.at(-1);
        const call = { command, script, cwd: options.cwd, env: options.env };
        calls.push(call);
        const response = responses.find((candidate) => candidate.match.test(script));
        if (response === undefined) return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, error: null };
        response.then?.(call);
        // an answer may depend on how it was called (a command that prints its environment says what the environment held)
        const text = (value) => (typeof value === "function" ? value(call) : value ?? "");
        return { code: response.code ?? 0, signal: null, stdout: text(response.stdout), stderr: text(response.stderr), timedOut: response.timedOut ?? false, error: response.error ?? null };
      },
      async isolatedClone(input) {
        clones.push(input);
        return input.fake ?? { dir: input.source, remove() {} };
      },
      async git() {
        return { code: 1, signal: null, stdout: "", stderr: "", timedOut: false, error: null };
      },
    },
    /** The commands that were run by a shell (the dependency install and the preflight commands), in order. */
    scripts: () => calls.map((call) => call.script),
  };
}
