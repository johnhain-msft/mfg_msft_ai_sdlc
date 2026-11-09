// Installation targets, the browser guidance and the verification poll (AC11, AC18-AC20, AC35).
//
//   * Required repositories are the central orchestrator repository, every project repository whose
//     entry has driftAudit.enabled == true and every downstream repository of dependencyEdges[];
//     an upstream-only repository on an account that has an installation (or is a target account) must
//     also be covered by that installation, while one on an account without an installation is a warning.
//   * The poll lists GET /app/installations (JWT, every page) every five seconds for at most ten
//     minutes until each required repository is covered by an installation that holds every entry of
//     the least-privilege map; every installation it sees must also stay within that map.

import { SdlcError } from "./errors.mjs";
import { assertWithinCeiling, comparePermissions } from "./github-app.mjs";
import { loadPermissionMap } from "./app-manifest.mjs";
import { sameOwner, splitSlug, isRepoSlug } from "./validators.mjs";

export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 600000;
export const MAX_PRESELECTED_REPOSITORIES = 100;

const uniqueBy = (values, key = (value) => value.toLowerCase()) => {
  const seen = new Set();
  return values.filter((value) => {
    const k = key(value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * The same-owner precondition of the cascade tokens (SPEC-01 AC35): one installation token is scoped to a single
 * owner, so every dependencyEdges[].downstreamRepo must share the central repository's owner (ASCII case-insensitive).
 * Runs in the preflight, before any listener, browser or API request.
 */
export function assertDownstreamsShareOwner(manifest, centralSlug) {
  const { owner: centralOwner } = splitSlug(centralSlug);
  for (const edge of manifest.dependencyEdges ?? []) {
    if (!isRepoSlug(edge?.downstreamRepo)) {
      throw new SdlcError(`dependencyEdges entry '${edge?.edgeId ?? "?"}' has no valid downstreamRepo (<owner>/<repo>)`, { code: "downstream-invalid" });
    }
    const { owner } = splitSlug(edge.downstreamRepo);
    if (!sameOwner(owner, centralOwner)) {
      throw new SdlcError(
        `downstreamRepo '${edge.downstreamRepo}' (owner '${owner}') is under a different owner than the central orchestrator repository '${centralSlug}' ` +
          `(owner '${centralOwner}'): one GitHub App installation token is scoped to a single owner, so every downstream repository must share the owner of the central repository`,
        { code: "cross-owner-downstream" },
      );
    }
  }
}

/** Required repositories, upstream-only repositories (warn only) and the target accounts, in installation order. */
export function installationTargets(manifest, centralSlug) {
  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const edges = Array.isArray(manifest.dependencyEdges) ? manifest.dependencyEdges : [];
  const required = uniqueBy([
    centralSlug,
    ...projects.filter((project) => project?.driftAudit?.enabled === true).map((project) => project.repo),
    ...edges.map((edge) => edge.downstreamRepo),
  ]);
  const optional = uniqueBy(edges.map((edge) => edge.upstreamRepo).filter((repo) => typeof repo === "string")).filter(
    (repo) => !required.some((entry) => entry.toLowerCase() === repo.toLowerCase()),
  );
  const accounts = uniqueBy(required.map((slug) => splitSlug(slug).owner));
  return { required, optional, accounts };
}

/** https://github.com/apps/<slug>/installations/new, or the /permissions form when the account and repository IDs are known (AC18). */
export function installationUrl(slug, { accountId = null, repositoryIds = [] } = {}) {
  const plain = `https://github.com/apps/${slug}/installations/new`;
  if (accountId === null || repositoryIds.length === 0 || repositoryIds.length > MAX_PRESELECTED_REPOSITORIES) return plain;
  const ids = repositoryIds.map((id) => `repository_ids[]=${id}`).join("&");
  return `${plain}/permissions?suggested_target_id=${accountId}&${ids}`;
}

/** Looks up the numeric IDs of an account and its required repositories; null when any lookup fails. */
async function lookupIds(api, account, repositories) {
  if (repositories.length > MAX_PRESELECTED_REPOSITORIES) return null;
  const user = await api.request("GET", `/users/${encodeURIComponent(account)}`);
  if (user.status !== 200 || !Number.isInteger(user.json?.id)) return null;
  const repositoryIds = [];
  for (const slug of repositories) {
    const { owner, repo } = splitSlug(slug);
    const response = await api.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (response.status !== 200 || !Number.isInteger(response.json?.id)) return null;
    repositoryIds.push(response.json.id);
  }
  return { accountId: user.json.id, repositoryIds };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * One evaluation of the installations against the required repositories.
 * @returns {{ done: boolean, missing: {repository:string, account:string, reason:string, permissions:string[]}[],
 *   verifiedAccounts: string[], uncoveredOptional: string[] }}
 */
export async function evaluateInstallations({ api, jwt, slug, required, optional, map }) {
  const listing = await api.paginate("/app/installations?per_page=100", { bearer: jwt });
  if (!listing.ok) {
    throw new SdlcError(`GET /app/installations answered ${listing.status}${typeof listing.json?.message === "string" ? ` (${listing.json.message})` : ""}`, { code: "installations" });
  }
  const installations = listing.items;
  for (const installation of installations) {
    assertWithinCeiling(installation.permissions, `the installation of GitHub App '${slug}' on account '${installation.account?.login ?? installation.id}'`, map);
  }
  const requiredNames = Object.entries(map).map(([key, level]) => `${key}: ${level}`);

  async function coverage(repository) {
    const { owner, repo } = splitSlug(repository);
    const installation = installations.find((candidate) => !candidate.suspended_at && sameOwner(String(candidate.account?.login ?? ""), owner));
    if (!installation) return { covered: false, reason: `no installation of the App exists on account '${owner}'`, permissions: requiredNames };
    if (installation.repository_selection === "selected") {
      const response = await api.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { bearer: jwt });
      if (response.status !== 200 || response.json?.id !== installation.id) {
        return { covered: false, reason: `the installation on account '${owner}' does not include the repository`, permissions: [] };
      }
    }
    const { missing } = comparePermissions(installation.permissions, map);
    if (missing.length > 0) {
      return {
        covered: false,
        reason: "the installation lacks required permissions",
        permissions: missing.map((entry) => `${entry.key}: ${entry.required}`),
      };
    }
    return { covered: true, account: String(installation.account?.login ?? owner) };
  }

  const missing = [];
  const verified = new Set();
  for (const repository of required) {
    const result = await coverage(repository);
    if (result.covered) {
      verified.add(result.account);
    } else {
      missing.push({ repository, account: splitSlug(repository).owner, reason: result.reason, permissions: result.permissions });
    }
  }
  const uncoveredOptional = [];
  for (const repository of optional) {
    const result = await coverage(repository);
    if (result.covered) {
      verified.add(result.account);
      continue;
    }
    const { owner } = splitSlug(repository);
    const hasAccountInstallation =
      installations.some((candidate) => !candidate.suspended_at && sameOwner(String(candidate.account?.login ?? ""), owner)) ||
      required.some((entry) => sameOwner(splitSlug(entry).owner, owner));
    if (hasAccountInstallation) {
      missing.push({ repository, account: owner, reason: result.reason, permissions: result.permissions });
    } else if (missing.length === 0) {
      uncoveredOptional.push(repository);
    }
  }
  return { done: missing.length === 0, missing, verifiedAccounts: [...verified].sort(), uncoveredOptional };
}

function timeoutDiagnostic({ slug, missing, privateKeyInMemoryOnly }) {
  const lines = missing.map(
    (entry) =>
      `  - ${entry.repository}: ${entry.reason}${entry.permissions.length > 0 ? ` (required permissions: ${entry.permissions.join(", ")})` : ""}; ` +
      `install the App on '${entry.account}' at ${installationUrl(slug)}`,
  );
  const followUp = privateKeyInMemoryOnly
    ? `The GitHub App '${slug}' exists, but its private key was not stored (it only lived in memory): generate a new private key from the App's settings ` +
      "and run the bootstrap again with APP_CLIENT_ID and APP_PRIVATE_KEY in the environment."
    : "Install the App where listed, then run the bootstrap again.";
  const sharing =
    "If an account differs from the App owner's, the App must allow installation on any account (the App's settings, 'Where can this GitHub App be installed?').";
  return `the GitHub App '${slug}' is not installed with the required permissions on every target:\n${lines.join("\n")}\n${sharing}\nNothing was written. ${followUp}`;
}

/**
 * Guides the installation (when `openForInstall`) and polls until every required repository is covered.
 * @returns {Promise<{ installationsVerified: string[], warnings: string[] }>}
 */
export async function ensureInstallations({
  api,
  slug,
  signJwt,
  targets,
  openBrowser,
  openForInstall,
  noOpenBrowser = false,
  logger,
  signal,
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  privateKeyInMemoryOnly = false,
  map = loadPermissionMap(),
  hooks = {},
}) {
  const allRepositories = uniqueBy([...targets.required, ...(targets.optional ?? [])]);
  const reposOf = (account) => allRepositories.filter((repository) => sameOwner(splitSlug(repository).owner, account));
  if (openForInstall) {
    // After a registration the browser is sent to the installation page of each target account in turn (AC18).
    for (const account of targets.accounts) {
      const repositories = reposOf(account);
      const ids = await lookupIds(api, account, repositories);
      const url = installationUrl(slug, ids ?? {});
      logger.info(`Install the GitHub App '${slug}' on '${account}': ${url}`);
      if (repositories.length > MAX_PRESELECTED_REPOSITORIES) {
        logger.info(
          `This account needs more than ${MAX_PRESELECTED_REPOSITORIES} repositories, so the plain installation page is used; select these repositories there:\n` +
            repositories.map((entry) => `  ${entry}`).join("\n"),
        );
      }
      if (!noOpenBrowser) {
        try {
          await openBrowser(url);
        } catch (error) {
          logger.warn(`the browser could not be opened (${error.message}); open the URL above yourself`);
        }
      }
    }
  }

  let timedOut = false;
  let wake = () => {};
  const deadline = new Promise((resolve) => {
    wake = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    wake();
  }, timeoutMs);
  try {
    let announced = false;
    let polls = 0;
    for (;;) {
      const last = await evaluateInstallations({ api, jwt: signJwt(), slug, required: targets.required, optional: targets.optional, map });
      polls += 1;
      if (last.done) {
        for (const repository of last.uncoveredOptional) {
          logger.warn(`the upstream-only repository ${repository} is not covered by an installation of '${slug}'; it cannot be read with an installation token`);
        }
        return { installationsVerified: last.verifiedAccounts, warnings: last.uncoveredOptional };
      }
      if (!announced) {
        logger.info(`Waiting for '${slug}' to be installed with the required permissions on: ${last.missing.map((entry) => entry.repository).join(", ")}`);
        announced = true;
      }
      if (signal?.aborted) throw new SdlcError("interrupted while waiting for the GitHub App installation", { exitCode: 130, code: "interrupted" });
      const sleeping = sleep(pollIntervalMs, signal);
      hooks.onWaiting?.(polls);
      await Promise.race([sleeping, deadline]);
      if (signal?.aborted) throw new SdlcError("interrupted while waiting for the GitHub App installation", { exitCode: 130, code: "interrupted" });
      if (timedOut) throw new SdlcError(timeoutDiagnostic({ slug, missing: last.missing, privateKeyInMemoryOnly }), { code: "installation-incomplete" });
    }
  } finally {
    clearTimeout(timer);
  }
}
