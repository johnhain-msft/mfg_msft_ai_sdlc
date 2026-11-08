// Readiness checks after a successful ReconcileResult (AC42): `gh aw validate` (documented as equivalent to
// `gh aw compile --validate --no-emit --zizmor --actionlint --poutine`) and `gh aw doctor` (which, per
// `gh aw doctor --help`, checks the GitHub CLI authentication and, with --repo, the repository). Both run;
// doctorStatus is "pass" only when both exit with status 0.

export const READINESS_COMMANDS = Object.freeze([Object.freeze(["aw", "validate"]), Object.freeze(["aw", "doctor"])]);

/**
 * @returns {Promise<{ doctorStatus: "pass" | "fail", results: {command: string, code: number|null}[] }>}
 */
export async function runReadinessChecks({ runGh, cwd, logger }) {
  const results = [];
  for (const args of READINESS_COMMANDS) {
    const command = `gh ${args.join(" ")}`;
    logger.info(`Running ${command}`);
    const outcome = await runGh([...args], { cwd });
    logger.raw(outcome.stdout ?? "");
    logger.raw(outcome.stderr ?? "");
    if (outcome.error) logger.error(`${command} could not be run: ${outcome.error}`);
    results.push({ command, code: outcome.code });
  }
  const pass = results.every((entry) => entry.code === 0);
  if (!pass) {
    for (const entry of results.filter((item) => item.code !== 0)) logger.error(`${entry.command} did not succeed (exit ${entry.code ?? "none"})`);
  }
  return { doctorStatus: pass ? "pass" : "fail", results };
}
