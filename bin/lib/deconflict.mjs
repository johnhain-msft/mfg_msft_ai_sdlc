// Opt-in schedule deconfliction (AC30-AC32): S5 disables only the workflow IDs that sdlc.yaml lists for a
// project whose deconflictInRepoSchedules is "disable-workflow-schedules", only when
// --deconflict-upstream-schedules is passed, and through `gh workflow disable` with the operator's own
// credentials (never the App's). Nothing else is sent to an upstream repository: no file, branch,
// commit or pull request.

import { SdlcError } from "./errors.mjs";
import { isRepoSlug } from "./validators.mjs";

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The upstreams to act on: [{ repo, workflowIds }] from projects whose option is "disable-workflow-schedules". */
export function deconflictTargets(manifest) {
  const byRepo = new Map();
  for (const project of Array.isArray(manifest.projects) ? manifest.projects : []) {
    if (project?.deconflictInRepoSchedules !== "disable-workflow-schedules") continue;
    if (!isRepoSlug(project.repo)) continue;
    const key = project.repo.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: project.repo, workflowIds: [] };
    for (const id of Array.isArray(project.deconflictWorkflowIds) ? project.deconflictWorkflowIds : []) {
      if (typeof id !== "string" || !WORKFLOW_ID.test(id)) {
        throw new SdlcError(`deconflictWorkflowIds of project '${project.projectKey}' holds '${id}', which is not a workflow file name or ID`, { code: "deconflict-id" });
      }
      if (!entry.workflowIds.includes(id)) entry.workflowIds.push(id);
    }
    byRepo.set(key, entry);
  }
  return [...byRepo.values()];
}

/**
 * @param {{ manifest: object, enabled: boolean, runGh: Function, logger: object, cwd?: string }} input
 * @returns {Promise<{ deconflicted: string[], skippedReadOnly: string[] }>} `<owner>/<repo>:<workflow-id>` strings and `<owner>/<repo>` strings, each sorted
 */
export async function deconflictUpstreamSchedules({ manifest, enabled, runGh, logger, cwd }) {
  const deconflicted = [];
  const skippedReadOnly = [];
  if (!enabled) return { deconflicted, skippedReadOnly };
  const targets = deconflictTargets(manifest);
  for (const { repo, workflowIds } of targets) {
    for (const id of workflowIds) {
      const outcome = await runGh(["workflow", "disable", id, "--repo", repo], { cwd, timeoutMs: 120000 });
      if (outcome.code === 0) {
        deconflicted.push(`${repo}:${id}`);
        logger.info(`Disabled the schedule workflow ${id} on ${repo}.`);
        continue;
      }
      const status = Number(/HTTP (\d{3})/.exec(`${outcome.stderr}\n${outcome.stdout}`)?.[1] ?? NaN);
      if (status === 403 || status === 404) {
        skippedReadOnly.push(repo);
        logger.warn(
          `could not disable ${id} on ${repo} (HTTP ${status}): the operator lacks Actions: write there, so its duplicate in-repo schedules remain active; ` +
            "the open-pull-request deduplication of S2 (C5) is relied on instead.",
        );
        break;
      }
      throw new SdlcError(
        `gh workflow disable ${id} --repo ${repo} failed${Number.isNaN(status) ? "" : ` (HTTP ${status})`}: ${(outcome.error ?? outcome.stderr).trim().slice(0, 300)}`,
        { code: "deconflict-failed" },
      );
    }
  }
  return { deconflicted: deconflicted.sort(), skippedReadOnly: [...new Set(skippedReadOnly)].sort() };
}
