// bin/sdlc-onboard.mjs: points the orchestrator at one more repository (contract C10, form b).
//
// Order of work: the gh-aw gate (AC6); the flags (AC9); the central repository and the same-owner check of
// --downstream (AC4, AC49); the App credentials and GET /app (AC17, AC35); the read-only inspection (AC45); the
// synthesis of the projects[] and dependencyEdges[] entries and of instructions/<projectKey>.md (AC46-AC50); the
// atomic, comment-preserving write of sdlc.yaml (AC51); the create-if-missing state variable (AC52); S1 through C1
// (AC36, AC38, AC39); the readiness checks (AC42); and the BootstrapSummaryReport on stdout (AC43, AC44).

import fs from "node:fs";
import path from "node:path";
import { SdlcError } from "./errors.mjs";
import { createContext, reportFailure } from "./context.mjs";
import { assertGhAwVersion } from "./ghaw-version.mjs";
import { parseOnboardArgs } from "./cli-flags.mjs";
import { resolveCentralRepo } from "./central-repo.mjs";
import { readManifest } from "./manifest-data.mjs";
import { sameOwner, splitSlug } from "./validators.mjs";
import { loadExistingApp, readAppCredentials, selectAppPath } from "./app-identity.mjs";
import { createApi, resolveApiBase, resolveOperatorToken } from "./github-api.mjs";
import { classifyTarget, inspectRepository, localIdentity, localReader, remoteIdentity, remoteReader } from "./inspect-repo.mjs";
import { projectKeyOf, resolveStrategy, synthesizeEdge, synthesizeProject } from "./synthesize.mjs";
import { assertNoCredentials, assertNoCredentialsIn, composeInstructions, generatedSection, operatorTextOf, readOperatorInstructions } from "./instructions-file.mjs";
import { applyDataToText, planManifestUpdate } from "./manifest-edit.mjs";
import { restoreFiles, writeFilesAtomically } from "./atomic-write.mjs";
import { stateVariablePlan, seedStateVariables } from "./state-variables.mjs";
import { buildReconcileRequest, loadReconciler, sendToReconciler } from "./reconcile-client.mjs";
import { runReadinessChecks } from "./readiness.mjs";
import { buildSummaryReport, printSummaryReport } from "./summary.mjs";

/** Runs the onboarding; resolves with the process exit code and never throws. */
export async function runOnboard(argv, overrides = {}) {
  const ctx = createContext(overrides);
  try {
    return await onboard(argv, ctx);
  } catch (error) {
    return reportFailure(error, ctx);
  }
}

/** engineAuthMode of an onboarding run: the PAT when one is supplied, the manifest's API-key secret, else the Actions token. */
function engineAuthModeOf(env, manifest) {
  if (String(env.COPILOT_GITHUB_TOKEN ?? "").trim() !== "") return "copilot-pat";
  if (typeof manifest.engineApiKeySecret === "string") return "api-key";
  return "copilot-requests";
}

/**
 * AC49: the owner of a downstream repository must be the owner of the central orchestrator repository, compared ASCII
 * case-insensitively, because one GitHub App installation token is scoped to a single owner. `requested` is the value of
 * --downstream when `downstream` is the repository that GitHub resolved it to (a renamed or transferred repository
 * resolves to its current owner, which can differ from the one that was typed).
 */
function assertDownstreamOwner(downstream, central, requested = downstream) {
  const { owner } = splitSlug(downstream);
  if (sameOwner(owner, central.owner)) return;
  const subject =
    requested === downstream
      ? `--downstream ${downstream}`
      : `--downstream ${requested} resolves to ${downstream} (the repository was renamed or transferred), and ${downstream}`;
  throw new SdlcError(
    `${subject} (owner '${owner}') is under a different owner than the central orchestrator repository ${central.slug} (owner '${central.owner}'): ` +
      "one GitHub App installation token is scoped to a single owner, so a downstream repository must share the owner of the central repository. Nothing was written.",
    { code: "cross-owner-downstream" },
  );
}

async function inspectTarget({ target, api, ctx }) {
  if (target.kind === "local") {
    const identity = localIdentity(target.directory);
    return { identity, inspection: await inspectRepository(localReader(target.directory), identity) };
  }
  const identity = await remoteIdentity({ api, slug: target.slug });
  const reader = await remoteReader({ api, slug: identity.repo, ref: identity.defaultBranch });
  const inspection = await inspectRepository(reader, identity);
  if (reader.truncated) inspection.warnings.push(`the file list of ${identity.repo} was truncated by GitHub; some files may not have been inspected`);
  return { identity, inspection };
}

/**
 * AC50: the names and paths that the inspection found, and the keys of a provenance file, end up in sdlc.yaml and in
 * instructions/<projectKey>.md (or in a warning or a diagnostic of this run), so they are held to the guard of the operator's text,
 * and a repository that holds a credential in one of them is refused as soon as it is read, before anything can print or write it.
 * Only what S5 prints or writes is looked at: the path of a workflow without a schedule is neither.
 */
function assertDetectedFactsHaveNoCredentials(inspection) {
  assertNoCredentialsIn(
    [
      inspection.repo,
      inspection.defaultBranch,
      inspection.packageManifests,
      inspection.workflows.filter((workflow) => workflow.scheduled).map((workflow) => workflow.path),
      inspection.provenanceFiles.map((file) => [file.path, file.pointer]),
      inspection.warnings,
    ],
    "a name or a path detected in the inspected repository",
  );
}

async function onboard(argv, ctx) {
  const { logger, env } = ctx;

  // AC6 and AC9.
  const ghAwVersion = await assertGhAwVersion(ctx.runGh);
  const options = parseOnboardArgs(argv);

  // AC4 and AC49: the central repository, and the same-owner check before any file write or state-variable request.
  const central = resolveCentralRepo(options.manifest, { cwd: ctx.cwd, env });
  if (options.downstream !== undefined) assertDownstreamOwner(options.downstream, central);
  const { text: manifestText, data: manifestData } = readManifest(central.manifestPath, options.manifest);

  // AC17: App credentials are always required to resolve appSlug for contract C1.
  const credentials = readAppCredentials(env);
  selectAppPath(credentials, { onboarding: true });
  const token = await resolveOperatorToken({ env, runGh: ctx.runGh });
  logger.addSecret(token);
  const api = createApi({ baseUrl: resolveApiBase(env), fetch: ctx.fetch, token });
  const app = await loadExistingApp({ api, credentials, logger });

  // AC45: the read-only inspection of the target (and of the downstream repository).
  const operator = readOperatorInstructions(options.instructions, ctx.cwd, central.workingCopy);
  const target = classifyTarget(options.repo, ctx.cwd);
  const { inspection: upstream } = await inspectTarget({ target, api, ctx });
  assertDetectedFactsHaveNoCredentials(upstream);
  for (const warning of upstream.warnings) logger.warn(`${upstream.repo}: ${warning}`);
  let downstream = null;
  if (options.downstream !== undefined) {
    ({ inspection: downstream } = await inspectTarget({ target: { kind: "remote", slug: options.downstream }, api, ctx }));
    // AC49: GitHub reports the repository under its current name, which names another owner when it was transferred or renamed.
    assertDownstreamOwner(downstream.repo, central, options.downstream);
    assertDetectedFactsHaveNoCredentials(downstream);
    for (const warning of downstream.warnings) logger.warn(`${downstream.repo}: ${warning}`);
  }

  // AC46-AC49: the entries.
  const projectKey = projectKeyOf(upstream.repo);
  if (projectKey === "") throw new SdlcError(`no projectKey can be derived from the repository name of ${upstream.repo}`, { code: "synthesis" });
  const existingProject = manifestData.projects.find((candidate) => candidate.projectKey === projectKey);
  const resolvedStrategy = resolveStrategy(options.strategy, { watchUrls: options.watchUrl, inspection: upstream });
  const keepsStrategy = existingProject !== undefined && !options.explicit.has("strategy") && typeof existingProject.driftAudit?.upkeepStrategy === "string";
  const strategy = keepsStrategy ? existingProject.driftAudit.upkeepStrategy : resolvedStrategy;
  logger.info(
    `Upkeep strategy: ${strategy}${keepsStrategy ? " (kept from the existing project entry)" : options.strategy === "auto" ? " (resolved from auto)" : ""}`,
  );

  const instructionsRelative = (typeof existingProject?.driftAudit?.instructionsFile === "string" ? existingProject.driftAudit.instructionsFile : null) ?? `instructions/${projectKey}.md`;
  const instructionsPath = path.resolve(central.workingCopy, ...instructionsRelative.split("/"));
  const inside = path.relative(central.workingCopy, instructionsPath);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new SdlcError(`the instructions file ${instructionsRelative} of project ${projectKey} resolves outside the repository`, { code: "instructions-path" });
  }
  const project = synthesizeProject({
    inspection: upstream,
    strategy,
    watchUrls: options.watchUrl,
    schedule: options.schedule,
    instructions: operator?.literal ?? "",
    instructionsFile: instructionsRelative,
  });
  const explicitProject = new Set();
  if (options.explicit.has("strategy")) explicitProject.add("driftAudit.upkeepStrategy");
  if (options.explicit.has("schedule")) explicitProject.add("driftAudit.schedule");
  if (options.explicit.has("watch-url")) explicitProject.add("driftAudit.knowledgeSources.watchUrls");
  if (options.explicit.has("instructions")) explicitProject.add("driftAudit.instructions");

  let downstreamProject;
  let edge;
  let explicitEdge = new Set();
  if (downstream !== null) {
    downstreamProject = synthesizeProject({
      inspection: downstream,
      strategy: resolveStrategy("auto", { watchUrls: [], inspection: downstream }),
      enabled: false,
    });
    const synthesized = synthesizeEdge({ upstream, downstream, mode: options.mode });
    const existingEdge = (manifestData.dependencyEdges ?? []).find((candidate) => candidate.edgeId === projectKey);
    if (synthesized.edge === null) {
      if (existingEdge === undefined || String(existingEdge.downstreamRepo).toLowerCase() !== downstream.repo.toLowerCase()) {
        throw new SdlcError(
          `the dependency edge ${upstream.repo} -> ${downstream.repo} cannot be synthesized: S5 never invents a field, and none of the inspection or the flags supplies:\n` +
            synthesized.missing.map((entry) => `  - ${entry}`).join("\n") +
            "\nAdd the missing files to the repository or write the edge in sdlc.yaml by hand. Nothing was written.",
          { code: "edge-missing-fields" },
        );
      }
      logger.warn(`the edge ${projectKey} exists and is kept as it is: ${synthesized.missing.join("; ")}`);
    } else {
      edge = synthesized.edge;
      logger.info(`Edge ${edge.edgeId}: ${edge.upstreamRepo} -> ${edge.downstreamRepo} (${edge.mode}); initialBaselineSha is ${synthesized.baselineSource}.`);
      for (const note of synthesized.notes) logger.warn(note);
      if (options.explicit.has("mode")) explicitEdge = new Set(["mode"]);
    }
  }

  const plan = planManifestUpdate(manifestData, { project, explicitProject, downstreamProject, edge, explicitEdge });
  if (plan.keyCollision) throw new SdlcError(`${plan.keyCollision}. Nothing was written.`, { code: "key-collision" });
  // AC49 once more, on the repositories that this run is about to write: the same-owner check precedes every file write and every variable request.
  for (const written of [downstreamProject?.repo, edge?.downstreamRepo]) {
    if (written !== undefined) assertDownstreamOwner(written, central, options.downstream);
  }
  for (const other of manifestData.projects) {
    if (other.projectKey !== projectKey && String(other.repo).toLowerCase() === upstream.repo.toLowerCase()) {
      logger.warn(`${upstream.repo} is already managed by the project '${other.projectKey}'; the new entry '${projectKey}' is a second entry for the same repository`);
    }
  }

  // AC50 and AC51: instructions/<projectKey>.md and sdlc.yaml, written atomically.
  const existingInstructions = fs.existsSync(instructionsPath) ? fs.readFileSync(instructionsPath, "utf8") : null;
  const operatorText = operator ? operator.text : existingInstructions !== null ? operatorTextOf(existingInstructions) : "";
  const instructionsText = composeInstructions(operatorText, generatedSection(upstream));
  // AC50, before anything is written: neither the file nor the entries of sdlc.yaml may hold a credential, whatever their source (the
  // operator's text, the inspected paths, the keys of a provenance file or a flag).
  assertNoCredentials(instructionsText, `the instructions file ${instructionsRelative}`);
  assertNoCredentialsIn([project, downstreamProject, edge], "the entries of sdlc.yaml that this run writes");
  const manifestOut = applyDataToText(manifestText, manifestData, plan.data, { label: options.manifest });
  const written = writeFilesAtomically(
    [
      { path: central.manifestPath, text: manifestOut },
      { path: instructionsPath, text: instructionsText },
    ],
    ctx.fs,
  );
  const rollBack = () => restoreFiles(written.originals);
  logger.info(`Wrote ${path.relative(central.workingCopy, central.manifestPath).split(path.sep).join("/")} and ${instructionsRelative}${written.changed.length === 0 ? " (already up to date)" : ""}.`);

  try {
    // AC52: the state variable of the edge, created only on 404, and only then S1.
    const variablesSet = [];
    const stateEdge = downstream === null ? null : plan.data.dependencyEdges?.find((candidate) => candidate.edgeId === projectKey);
    if (stateEdge) {
      variablesSet.push(
        ...(await seedStateVariables({
          api,
          repo: central.slug,
          plan: stateVariablePlan([stateEdge]),
          nowIso: ctx.now().toISOString(),
          logger,
        })),
      );
    }

    const request = buildReconcileRequest({
      manifestPath: central.manifestPath,
      appSlug: app.slug,
      engineAuthMode: engineAuthModeOf(env, plan.data),
      ghAwVersionPin: ghAwVersion,
    });
    const { compiledWorkflows } = await sendToReconciler({
      request,
      reconcile: ctx.reconcile ?? (await loadReconciler()),
      cwd: central.workingCopy,
      env,
      logger,
      restored: `${path.relative(central.workingCopy, central.manifestPath).split(path.sep).join("/")} and ${instructionsRelative} were restored to their previous bytes`,
    });

    const readiness = await runReadinessChecks({ runGh: ctx.runGh, cwd: central.workingCopy, logger });
    const onboarded = new Set(plan.touched);
    if (written.changed.includes(instructionsPath)) onboarded.add(projectKey);
    printSummaryReport(
      ctx.stdout,
      buildSummaryReport({
        appId: app.id,
        appSlug: app.slug,
        clientId: app.clientId,
        installationsVerified: [],
        onboardedProjects: [...onboarded],
        deconflictedTargetWorkflows: [],
        skippedReadOnlyUpstreams: [],
        variablesSet,
        secretsSet: [],
        compiledWorkflows,
        doctorStatus: readiness.doctorStatus,
      }),
    );
    return readiness.doctorStatus === "pass" ? 0 : 1;
  } catch (error) {
    try {
      rollBack();
      logger.info(`${path.basename(central.manifestPath)} and ${instructionsRelative} were restored to their previous bytes.`);
    } catch (restoreError) {
      logger.error(`the previous bytes of ${path.basename(central.manifestPath)} could not be restored: ${restoreError.message}`);
    }
    throw error;
  }
}
