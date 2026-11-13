// Deterministic synthesis of the sdlc.yaml entries from the inspections (AC46-AC49). S5 never invents a command,
// a reviewer or a path: every value comes from the inspection, from a flag, or is the empty value of its type
// (and a field that none of them can supply is reported as missing instead).

import { POLL_STATE_VAR_PREFIX } from "./actions-variables.mjs";
import { deriveProjectKey, slugOf } from "./validators.mjs";

/**
 * The upkeep schedule of a project onboarded without --schedule: Mondays at 06:23 UTC. Not on the hour, because GitHub delays scheduled runs when load
 * is high, and most at the start of every hour, and may drop them; GitHub's documentation advises another minute of the hour.
 */
export const DEFAULT_SCHEDULE = "23 6 * * 1";
export const CONTEXT7_SERVER = Object.freeze({ command: "npx", args: Object.freeze(["-y", "@upstash/context7-mcp@latest"]) });
export const MODERNIZATION = "dependency-and-pattern-modernization";

/** `auto` resolves deterministically (AC47); any other value is returned unchanged. */
export function resolveStrategy(requested, { watchUrls, inspection }) {
  if (requested !== "auto") return requested;
  if (watchUrls.length > 0 || inspection.provenanceFiles.length > 0) return "content-and-docs-sync";
  if (inspection.packageManifests.length > 0) return MODERNIZATION;
  return "code-quality-and-improvement-scan";
}

/** The projectKey of a repository slug. */
export const projectKeyOf = (repoSlug) => deriveProjectKey(repoSlug.slice(repoSlug.indexOf("/") + 1));

const mcpServersFor = (strategy) => (strategy === MODERNIZATION ? { context7: { command: CONTEXT7_SERVER.command, args: [...CONTEXT7_SERVER.args] } } : {});

/**
 * One projects[] entry. The inspected repository is enabled; a downstream hub is synthesized with `enabled: false` and no
 * instructions file, so that it does not gain an unrequested drift workflow.
 */
export function synthesizeProject({ inspection, strategy, watchUrls = [], schedule, instructions = "", instructionsFile = null, enabled = true }) {
  const projectKey = projectKeyOf(inspection.repo);
  return {
    projectKey,
    repo: inspection.repo,
    defaultBranch: inspection.defaultBranch,
    deconflictInRepoSchedules: "none",
    deconflictWorkflowIds: [],
    driftAudit: {
      enabled,
      schedule: schedule ?? DEFAULT_SCHEDULE,
      upkeepStrategy: strategy,
      instructions,
      instructionsFile,
      knowledgeSources: {
        watchUrls: watchUrls.map((entry) => ({ url: entry.url, label: entry.label, kind: entry.kind })),
        packageManifests: [...inspection.packageManifests],
        mcpServers: mcpServersFor(strategy),
      },
      buildCommands: [...inspection.buildCommands],
      verifyCommands: [...inspection.verifyCommands],
      draft: false,
      reviewers: inspection.codeowners.individuals.slice(),
    },
  };
}

/** `--mode auto` resolves to mechanical when the downstream manifest has exactly one script named import:*, else to ai-adaptation. */
export function resolveMode(requested, downstream) {
  if (requested !== "auto") return requested;
  return downstream.importScripts.length === 1 ? "mechanical" : "ai-adaptation";
}

/** The glob that bounds what the cascade may edit: the provenance file's directory, or the file itself at the repository root. */
export function allowedFilesFor(provenanceFile) {
  const slash = provenanceFile.lastIndexOf("/");
  return slash === -1 ? [provenanceFile] : [`${provenanceFile.slice(0, slash)}/**`];
}

/**
 * One dependencyEdges[] entry from the inspected (upstream) repository to the downstream repository.
 * @returns {{ edge: object|null, missing: string[], baselineSource: string, notes: string[] }}
 *   `missing` lists the required fields that neither the inspection nor the flags can supply; `edge` is null then.
 */
export function synthesizeEdge({ upstream, downstream, mode: requestedMode }) {
  const upstreamKey = projectKeyOf(upstream.repo);
  const upstreamSlug = slugOf(upstreamKey);
  const missing = [];
  const notes = [];

  const provenance = downstream.provenanceFiles.length === 1 ? downstream.provenanceFiles[0] : null;
  if (downstream.provenanceFiles.length !== 1) {
    missing.push(
      `provenanceFile, provenanceJsonPointer and allowedFiles (${downstream.provenanceFiles.length === 0 ? "no provenance file" : `${downstream.provenanceFiles.length} provenance files`} found in ${downstream.repo}; exactly one is needed)`,
    );
  } else if (provenance.pointer === null) {
    missing.push(`provenanceJsonPointer (${provenance.path} holds no 40-hex "commit" key)`);
  }

  let initialBaselineSha = null;
  let baselineSource = "";
  if (provenance?.commit) {
    initialBaselineSha = provenance.commit;
    baselineSource = `the commit recorded by the downstream provenance file ${provenance.path}`;
  } else if (upstream.headSha) {
    initialBaselineSha = upstream.headSha;
    baselineSource = `the head of ${upstream.repo}@${upstream.defaultBranch} at inspection time`;
  } else {
    missing.push("initialBaselineSha (the downstream provenance file records no commit and the upstream head could not be read)");
  }

  const reviewers = downstream.codeowners.individuals.slice();
  if (reviewers.length === 0) {
    missing.push(`reviewers (no individual owner in .github/CODEOWNERS of ${downstream.repo}; a team cannot be requested as a reviewer)`);
  }
  const mode = resolveMode(requestedMode, downstream);
  if (mode === "mechanical") notes.push("importCommands is empty: add the command that imports the upstream into the downstream to sdlc.yaml");

  if (missing.length > 0) return { edge: null, missing, baselineSource, notes };
  return {
    edge: {
      edgeId: upstreamKey,
      upstreamRepo: upstream.repo,
      upstreamKey,
      upstreamSlug,
      upstreamDefaultBranch: upstream.defaultBranch,
      initialBaselineSha,
      downstreamRepo: downstream.repo,
      mode,
      schedule: null,
      onCommitOnlyAdvance: "noop",
      stateVariable: `${POLL_STATE_VAR_PREFIX}${upstreamSlug}`,
      provenanceFile: provenance.path,
      provenanceJsonPointer: provenance.pointer,
      branchName: `sdlc/cascade-${upstreamKey}`,
      closeOlderKey: `sdlc-cascade-${upstreamKey}`,
      reviewers,
      importCommands: [],
      preflightCommands: [],
      acceptCommands: [],
      buildCommands: [...downstream.buildCommands],
      verifyCommands: [...downstream.verifyCommands],
      adaptationInstructions: "",
      allowedFiles: allowedFilesFor(provenance.path),
      protectedFilesExclude: [],
      autoMerge: false,
      immutableGates: { zeroDiffPaths: [] },
    },
    missing,
    baselineSource,
    notes,
  };
}
