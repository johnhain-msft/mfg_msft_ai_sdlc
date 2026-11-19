// A fake of the processes that a preflight starts (the engine's src/routing/preflight.mjs `deps`): checkouts that only record what they were asked, and a shell that
// answers from a list. It lets the preflight of an edge be tested case by case without starting git or bash; what the real processes do is the engine's own tests.
//
// This repository declares its checks the way a manifest does: each edge lists `preflightCommands` and, next to them, `preflightChecks` (the scope that a drift of a
// command asks for, and the classifier that judges a report-shaped command). `declaredPreflight` answers for the commands and the classifiers of one such edge, so that a
// test routes the edge exactly as the manifest declares it.
import assert from "node:assert/strict";
import fs from "node:fs";

/** A path as a native program names it: the router gives bash `/c/x` on Windows, which node cannot open. */
export const nativePath = (value) => (process.platform === "win32" ? String(value).replace(/\\/g, "/").replace(/^\/([A-Za-z])\//, (_, drive) => `${drive.toUpperCase()}:/`) : String(value));

/** What `npm run sync:workshop-source` prints when nothing changed, and when something did (the input of classify-workshop-report). */
export const CLEAN_REPORT = "Source revision: abc\nInputs checked: 25; changed 0, new 0, gone 0\nThe content matches the inputs.\n";
export const CHANGED_REPORT = "Source revision: abc\nInputs checked: 25; changed 2, new 0, gone 1\n changed: labs/lab03.md -> re-read M3\nThe content was written against different inputs.\n";
/** What lab-studio-drift prints (its own exit code is the verdict: 0 in sync, 1 drift). */
export const IN_SYNC = { status: "in-sync", previousCommit: "a".repeat(40), targetCommit: "b".repeat(40), changedLabs: [] };
export const DRIFT = { status: "drift", previousCommit: "a".repeat(40), targetCommit: "b".repeat(40), changedLabs: ["lab03", "lab07"] };

/**
 * @param {Array<{ match: RegExp, code?: number | null, stdout?: string, stderr?: string, error?: string, timedOut?: boolean, then?: (call: object) => void }>} responses
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
        // a `code` of null is a process that did not start or was killed, and stays null
        return { code: Object.hasOwn(response, "code") ? response.code : 0, signal: null, stdout: text(response.stdout), stderr: text(response.stderr), timedOut: response.timedOut ?? false, error: response.error ?? null };
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

/** A command as the router hands it to the shell: `<checkout>` is the quoted $UPSTREAM_DIR. */
export const expanded = (command) => command.replaceAll("<checkout>", '"$UPSTREAM_DIR"');
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** What the first output of each kind of command of this fleet's edges looks like when it reports a change and when it does not. */
function answerOf(command, changed) {
  if (/sync:workshop-source/.test(command)) return { code: 1, stdout: changed ? CHANGED_REPORT : CLEAN_REPORT }; // a report-shaped command: a classifier reads it
  if (/lab-studio-drift\.mjs/.test(command)) return { code: Number(changed), stdout: `${JSON.stringify(changed ? DRIFT : IN_SYNC)}\n` }; // a helper whose exit code is the verdict
  if (/^gh api /.test(command)) return { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{ id: changed ? 41 : 40, name: "build", status: "completed", conclusion: "success" }] }) }; // a listing for a classifier
  if (/^git /.test(command)) return { code: Number(changed), stdout: "" }; // a plain command whose exit code is the verdict
  throw new Error(`the fake has no answer for the command ${command}`);
}

/**
 * The fake shell for the edge as the manifest declares it. `changes[i]` says whether command i reports a change. A command that a check declares a classifier for
 * is answered with its own output and exit code, and then the classifier is answered with the verdict (1 drift, 0 none), after it has been checked for the
 * environment that the router promises it (SDLC_PREFLIGHT_*) and for the report files that the router wrote for it.
 * @param {object} declared the edge of the manifest (preflightCommands, preflightChecks)
 * @param {boolean[]} [changes]
 */
export function declaredPreflight(declared, changes = declared.preflightCommands.map(() => true)) {
  const answers = declared.preflightCommands.map((command, index) => ({ command, ...answerOf(command, changes[index]) }));
  const commandResponses = answers.map((answer) => ({ match: exact(expanded(answer.command)), code: answer.code, stdout: answer.stdout }));
  const classifierResponses = (declared.preflightChecks ?? []).flatMap((check, index) =>
    check.classifier
      ? [
          {
            match: exact(expanded(check.classifier)),
            code: Number(changes[index]),
            then: ({ env }) => {
              assert.equal(env.SDLC_PREFLIGHT_INDEX, String(index));
              assert.equal(env.SDLC_PREFLIGHT_COMMAND, declared.preflightCommands[index]);
              assert.equal(env.SDLC_PREFLIGHT_EXIT_CODE, String(answers[index].code));
              assert.equal(fs.readFileSync(nativePath(env.SDLC_PREFLIGHT_STDOUT_FILE), "utf8"), answers[index].stdout, "the classifier is given the output of its command");
              assert.equal(fs.readFileSync(nativePath(env.SDLC_PREFLIGHT_STDERR_FILE), "utf8"), "");
            },
          },
        ]
      : [],
  );
  return fakePreflight([...commandResponses, ...classifierResponses]);
}
