// bin/sdlc-bootstrap.mjs: one command that turns a fork or copy of this repository into a running,
// self-reconciling orchestrator (contract C10, form a).
//
// Order of work: the gh-aw gate (AC6); the flags (AC8); the manifest, the central repository and the same-owner
// preflight (AC4, AC19); the credentials (AC10, AC17, AC27, AC28); the App (existing credentials or the loopback
// manifest flow, AC11-AC17) and the permission ceiling (AC35); the installations (AC18-AC20); the variables
// (AC21-AC24); the secrets (AC25-AC29); the opt-in deconfliction (AC30-AC32); S1 through C1 (AC33-AC39); the
// readiness checks (AC42); and the BootstrapSummaryReport on stdout (AC43, AC44).

import { SdlcError } from "./errors.mjs";
import { createContext, reportFailure } from "./context.mjs";
import { assertGhAwVersion } from "./ghaw-version.mjs";
import { parseBootstrapArgs } from "./cli-flags.mjs";
import { resolveCentralRepo } from "./central-repo.mjs";
import { readManifest, stateEdges } from "./manifest-data.mjs";
import { assertDownstreamsShareOwner, ensureInstallations, installationTargets } from "./installations.mjs";
import { loadExistingApp, readAppCredentials, selectAppPath } from "./app-identity.mjs";
import { createApi, resolveApiBase, resolveOperatorToken } from "./github-api.mjs";
import { signAppJwt } from "./app-jwt.mjs";
import { buildManifest, defaultAppName, registrationUrl } from "./app-manifest.mjs";
import { runManifestFlow } from "./manifest-flow.mjs";
import { convertManifestCode, lookupOwner, verifyAppPermissions } from "./github-app.mjs";
import {
  APP_CLIENT_ID_VARIABLE,
  upsertAppClientId,
} from "./actions-variables.mjs";
import { seedStateVariables, stateVariablePlan } from "./state-variables.mjs";
import { APP_PRIVATE_KEY_SECRET, assertSecretsValid, collectEngineCredentials, uploadSecrets } from "./actions-secrets.mjs";
import { deconflictTargets, deconflictUpstreamSchedules } from "./deconflict.mjs";
import { buildReconcileRequest, loadReconciler, sendToReconciler } from "./reconcile-client.mjs";
import { runReadinessChecks } from "./readiness.mjs";
import { buildSummaryReport, printSummaryReport } from "./summary.mjs";

const NOT_STORED = (slug) =>
  `The GitHub App '${slug}' exists, but its private key was not stored (it only lived in memory): generate a new private key from the App's settings ` +
  "and run the bootstrap again with APP_CLIENT_ID and APP_PRIVATE_KEY in the environment.";

/** Runs the bootstrap; resolves with the process exit code and never throws. */
export async function runBootstrap(argv, overrides = {}) {
  const ctx = createContext(overrides);
  try {
    return await bootstrap(argv, ctx);
  } catch (error) {
    return reportFailure(error, ctx);
  }
}

async function bootstrap(argv, ctx) {
  const { logger, env } = ctx;

  // AC6: before any other action.
  const ghAwVersion = await assertGhAwVersion(ctx.runGh);

  // AC8: exactly the documented flags.
  const options = parseBootstrapArgs(argv);
  if (options.engine === "gemini") logger.warn("gh-aw labels the gemini engine as deprecated; prefer copilot, claude or codex");

  // The manifest, the central repository and the same-owner preflight (AC4, AC19), before any listener, browser or request.
  const central = resolveCentralRepo(options.manifest, { cwd: ctx.cwd, env });
  const { data: manifest } = readManifest(central.manifestPath, options.manifest);
  const edges = stateEdges(manifest);
  assertDownstreamsShareOwner(manifest, central.slug);
  deconflictTargets(manifest);
  const statePlan = stateVariablePlan(edges);

  // The App path (AC10, AC17) and every credential value, validated before anything is registered or written (AC28).
  const credentials = readAppCredentials(env);
  const path = selectAppPath(credentials, { nonInteractive: options.nonInteractive });
  if (path === "existing" && options.owner !== undefined) logger.info("--owner is ignored: App registration is skipped because APP_CLIENT_ID and APP_PRIVATE_KEY are set");
  const engine = await collectEngineCredentials({
    engine: options.engine,
    env,
    prompt: ctx.prompt,
    interactive: !options.nonInteractive,
    manifestSecretName: typeof manifest.engineApiKeySecret === "string" ? manifest.engineApiKeySecret : undefined,
    logger,
  });
  assertSecretsValid([...engine.secrets, ...(path === "existing" ? [{ name: APP_PRIVATE_KEY_SECRET, value: credentials.privateKey }] : [])]);
  if (options.engine !== "copilot" && manifest.engineApiKeySecret === undefined) {
    logger.warn(`${options.manifest} sets no engineApiKeySecret, which src/reconcile.mjs requires for the api-key authentication of the ${options.engine} engine; add it before this run reaches the compile step`);
  }

  const token = await resolveOperatorToken({ env, runGh: ctx.runGh });
  logger.addSecret(token);
  const api = createApi({ baseUrl: resolveApiBase(env), fetch: ctx.fetch, token });

  let registeredSlug = null;
  let keyStored = false;
  try {
    let app;
    let privateKey;
    if (path === "existing") {
      logger.info("Using the GitHub App of APP_CLIENT_ID and APP_PRIVATE_KEY (no registration).");
      app = await loadExistingApp({ api, credentials, logger });
      privateKey = credentials.privateKey;
    } else {
      const owner = options.owner ?? central.owner;
      const ownerInfo = await lookupOwner(api, owner);
      if (ownerInfo.type !== "Organization") {
        logger.info(`'${owner}' is a user account: GitHub registers the App under the account that is signed in to the browser.`);
      }
      const name = options.appName ?? defaultAppName(central.slug);
      const flow = await runManifestFlow({
        buildManifest: (redirectUrl) => buildManifest({ name, homepage: `https://github.com/${central.slug}`, redirectUrl }),
        registrationBase: registrationUrl(ownerInfo.type, owner),
        convert: (code) => convertManifestCode(api, code, logger),
        openBrowser: ctx.openBrowser,
        logger,
        env,
        timeoutMs: ctx.timing.flowTimeoutMs,
        signal: ctx.signal,
      });
      registeredSlug = flow.slug;
      privateKey = flow.pem;
      logger.addSecret(privateKey);
      app = { id: flow.id, slug: flow.slug, clientId: flow.clientId, permissions: flow.permissions };
      logger.info(`Registered the GitHub App '${app.slug}'. Its private key is held in memory only and is stored only as the ${APP_PRIVATE_KEY_SECRET} secret.`);
      verifyAppPermissions(app);
      assertSecretsValid([{ name: APP_PRIVATE_KEY_SECRET, value: privateKey }]);
    }

    // AC18-AC20: installations, with the permission ceiling, before any variable or secret is written.
    const targets = installationTargets(manifest, central.slug);
    const installed = await ensureInstallations({
      api,
      slug: app.slug,
      signJwt: () => {
        const jwt = signAppJwt({ privateKeyPem: privateKey, issuer: app.clientId });
        logger.addSecret(jwt);
        return jwt;
      },
      targets,
      openBrowser: ctx.openBrowser,
      openForInstall: path === "register",
      noOpenBrowser: (env.SDLC_BOOTSTRAP_NO_OPEN_BROWSER ?? "") !== "",
      logger,
      signal: ctx.signal,
      pollIntervalMs: ctx.timing.pollIntervalMs,
      timeoutMs: ctx.timing.pollTimeoutMs,
      privateKeyInMemoryOnly: path === "register",
    });

    // AC21-AC24: variables on the central repository.
    const variablesSet = [];
    const clientIdWrite = await upsertAppClientId({ api, repo: central.slug }, app.clientId);
    variablesSet.push(clientIdWrite.name);
    variablesSet.push(...(await seedStateVariables({ api, repo: central.slug, plan: statePlan, nowIso: ctx.now().toISOString(), logger })));

    // AC25-AC29: secrets, each validated and encrypted before the first PUT.
    const secretsSet = await uploadSecrets({
      api,
      repo: central.slug,
      secrets: [{ name: APP_PRIVATE_KEY_SECRET, value: privateKey }, ...engine.secrets],
      onStored: (name) => {
        if (name === APP_PRIVATE_KEY_SECRET) keyStored = true;
      },
    });

    // AC30-AC32: opt-in deconfliction.
    if (options.deconflictUpstreamSchedules && deconflictTargets(manifest).length === 0) {
      logger.info("--deconflict-upstream-schedules was passed, but no project sets deconflictInRepoSchedules to disable-workflow-schedules; no upstream is touched");
    }
    const deconflict = await deconflictUpstreamSchedules({
      manifest,
      enabled: options.deconflictUpstreamSchedules,
      runGh: ctx.runGh,
      logger,
      cwd: central.workingCopy,
    });

    // AC33-AC39: S1 through C1.
    const request = buildReconcileRequest({
      manifestPath: central.manifestPath,
      appSlug: app.slug,
      engineAuthMode: engine.engineAuthMode,
      ghAwVersionPin: ghAwVersion,
    });
    const { compiledWorkflows } = await sendToReconciler({
      request,
      reconcile: ctx.reconcile ?? (await loadReconciler()),
      cwd: central.workingCopy,
      env,
      logger,
      restored: "",
    });

    // AC42-AC44: readiness checks and the report.
    const readiness = await runReadinessChecks({ runGh: ctx.runGh, cwd: central.workingCopy, logger });
    const report = buildSummaryReport({
      appId: app.id,
      appSlug: app.slug,
      clientId: app.clientId,
      installationsVerified: installed.installationsVerified,
      onboardedProjects: [],
      deconflictedTargetWorkflows: deconflict.deconflicted,
      skippedReadOnlyUpstreams: deconflict.skippedReadOnly,
      variablesSet,
      secretsSet,
      compiledWorkflows,
      doctorStatus: readiness.doctorStatus,
    });
    printSummaryReport(ctx.stdout, report);
    return readiness.doctorStatus === "pass" ? 0 : 1;
  } catch (error) {
    if (registeredSlug !== null && !keyStored) {
      const failure = error instanceof SdlcError ? error : new SdlcError(`unexpected failure: ${error?.message ?? error}`);
      if (failure.message.includes("private key was not stored")) throw failure;
      throw new SdlcError(`${failure.message}\n${NOT_STORED(registeredSlug)}`, { exitCode: failure.exitCode, code: failure.code });
    }
    throw error;
  }
}

export { APP_CLIENT_ID_VARIABLE };
