#!/usr/bin/env node
// The classifier of the workshop source check (design E2; SPEC-03 AC20): the router runs it right after `npm run sync:workshop-source -- <checkout>`, from the
// downstream checkout, with the two streams of the check in files and its exit code in the environment.
//
//   SDLC_PREFLIGHT_STDOUT_FILE   the standard output of the check (the report)
//   SDLC_PREFLIGHT_STDERR_FILE   its standard error (read only to carry its tail into a message)
//   SDLC_PREFLIGHT_EXIT_CODE     its exit code
//   SDLC_PREFLIGHT_COMMAND       the command as the manifest declares it (named in a message)
//
// The check exits 1 whenever the commit that it ran against differs from the one that is recorded, even when no input changed [F30], so its exit code alone
// decides nothing. The report decides: the line `Inputs checked: <n>; changed <x>, new <y>, gone <z>` and the ` PROBLEM <text>` lines.
//
//   exit 0  no drift: nothing changed, nothing is new or gone, and the report names no problem
//   exit 1  drift
//   exit 2  the report cannot be judged: the check exited with something other than 0 or 1, or the summary line is missing or appears twice. The router fails
//           the job on it and writes nothing: a report that cannot be read is never a drift and never a clean result. EVERY other failure is a 2 as well,
//           including a bug of this script: a crash that left node's own exit code 1 would be read as a drift.
//
// This script belongs to the orchestrator repository. It imports the engine only through its public API, ai-sdlc-factory/script-kit.

import { resolveIo, runAsMain } from "ai-sdlc-factory/script-kit";

/** A report that cannot be judged: the verdict is 2. */
export class ReportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportError";
  }
}

/** The report of the workshop source check: { checked, changed, added, removed, problems }. @throws {ReportError} when its summary line is absent or appears twice */
export function parseWorkshopReport(stdout) {
  const summary = [...String(stdout).matchAll(/^Inputs checked: (\d+); changed (\d+), new (\d+), gone (\d+)[ \t]*$/gm)];
  if (summary.length === 0) throw new ReportError("the workshop source check printed no 'Inputs checked: <n>; changed <x>, new <y>, gone <z>' line, so its result cannot be classified");
  if (summary.length > 1) throw new ReportError("the workshop source check printed more than one 'Inputs checked' line, so its result is ambiguous");
  const [, checked, changed, added, removed] = summary[0].map(Number);
  const problems = [...String(stdout).matchAll(/^[ \t]*PROBLEM[ \t]+(.*\S)[ \t]*$/gm)].map((match) => match[1]);
  return { checked, changed, added, removed, problems };
}

const tailOf = ({ stdout, stderr }) => `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");

/**
 * The verdict of one report.
 * @param {{ exitCode: number, stdout: string, stderr?: string, command: string }} check what the router ran and what it printed
 * @returns {{ drift: boolean, summary: string }}
 * @throws {ReportError} when the exit code is not 0 or 1, or the report has no single summary line
 */
export function classify({ exitCode, stdout, stderr = "", command }) {
  if (exitCode !== 0 && exitCode !== 1) throw new ReportError(`'${command}' exited with ${exitCode}: ${tailOf({ stdout, stderr })}`);
  const report = parseWorkshopReport(stdout);
  const drift = report.changed + report.added + report.removed + report.problems.length > 0;
  return {
    drift,
    summary: `workshop source check: ${report.checked} inputs, changed ${report.changed}, new ${report.added}, gone ${report.removed}, ${report.problems.length} problems (exit ${exitCode})`,
  };
}

/**
 * @param {string[]} _argv none: everything comes from the environment that the router sets for a classifier
 * @param {object} [ioInput] `env`, `fs`, `stdout`, `stderr`; a test passes fakes
 * @returns {Promise<number>} 0 no drift, 1 drift, 2 the report cannot be judged
 */
export async function run(_argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const stdoutFile = io.env.SDLC_PREFLIGHT_STDOUT_FILE;
    const stderrFile = io.env.SDLC_PREFLIGHT_STDERR_FILE;
    const exitText = io.env.SDLC_PREFLIGHT_EXIT_CODE;
    if (!stdoutFile || exitText === undefined) throw new ReportError("SDLC_PREFLIGHT_STDOUT_FILE and SDLC_PREFLIGHT_EXIT_CODE are set by the router for a classifier; they are not set");
    if (!/^\d+$/.test(exitText)) throw new ReportError(`SDLC_PREFLIGHT_EXIT_CODE is '${exitText}', not an exit code`);
    let stdout;
    try {
      stdout = io.fs.readFileSync(stdoutFile, "utf8");
    } catch (error) {
      throw new ReportError(`the report of the check cannot be read: ${error.message}`);
    }
    let stderr = "";
    try {
      if (stderrFile) stderr = io.fs.readFileSync(stderrFile, "utf8");
    } catch {
      // only the tail of a message comes from it
    }
    const { drift, summary } = classify({ exitCode: Number(exitText), stdout, stderr, command: io.env.SDLC_PREFLIGHT_COMMAND || "the workshop source check" });
    io.stdout(`${summary}: ${drift ? "drift" : "no drift"}\n`);
    return drift ? 1 : 0;
  } catch (error) {
    // exit 1 is a drift: whatever goes wrong here, and whatever kind of error it is, the verdict is 2
    io.stderr(`classify-workshop-report: ${error instanceof ReportError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
