// GitHub App registration results and the permission ceiling (AC16, AC17, AC19, AC35): the manifest
// conversion, GET /app, the owner lookup, and the exact check of an App's or an installation's
// `permissions` object against bin/lib/app-permissions.json.

import { SdlcError } from "./errors.mjs";
import { loadPermissionMap } from "./app-manifest.mjs";

const RANK = { read: 1, write: 2, admin: 3 };
const normalize = (key) => {
  const k = String(key).toLowerCase().replace(/-/g, "_");
  return k === "actions_variables" ? "variables" : k;
};
const messageOf = (response) => (typeof response.json?.message === "string" ? ` (${response.json.message})` : "");

/**
 * POST /app-manifests/{code}/conversions, exactly once. Returns the fields S5 uses; client_secret and
 * webhook_secret are discarded (the logger is told to redact them should they ever surface).
 */
export async function convertManifestCode(api, code, logger) {
  const response = await api.request("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, {
    bearer: null,
    accept: "application/vnd.github+json",
  });
  if (response.status === 201 && response.json && typeof response.json === "object") {
    const app = response.json;
    logger?.addSecret(app.pem);
    logger?.addSecret(app.client_secret);
    logger?.addSecret(app.webhook_secret);
    for (const field of ["id", "slug", "client_id", "pem"]) {
      if (app[field] === undefined || app[field] === null || app[field] === "") {
        throw new SdlcError(`the conversion response has no '${field}'; GitHub's manifest flow answered with an unexpected body`, { code: "conversion" });
      }
    }
    return { id: app.id, slug: app.slug, clientId: app.client_id, pem: app.pem, permissions: app.permissions ?? {} };
  }
  if (response.status === 404) {
    throw new SdlcError(
      "GitHub answered 404 to POST /app-manifests/{code}/conversions: the temporary code is unknown or has expired " +
        "(the three manifest steps must all finish within one hour). If the App was created in the browser, its owner can delete it; run the bootstrap again.",
      { code: "conversion" },
    );
  }
  if (response.status === 422) {
    throw new SdlcError(
      "GitHub answered 422 to POST /app-manifests/{code}/conversions (Validation failed, or the endpoint has been spammed): " +
        "the code was rejected or the endpoint is rate limited. Wait a while before running the bootstrap again; an App that was created in the browser can be deleted by its owner.",
      { code: "conversion" },
    );
  }
  throw new SdlcError(`POST /app-manifests/{code}/conversions answered ${response.status}${messageOf(response)}`, { code: "conversion" });
}

/** GET /app with an App JWT: { id, slug, permissions }. */
export async function fetchAuthenticatedApp(api, jwt) {
  const response = await api.request("GET", "/app", { bearer: jwt });
  if (response.status === 200 && response.json && typeof response.json.slug === "string") {
    return { id: response.json.id, slug: response.json.slug, permissions: response.json.permissions ?? {} };
  }
  if (response.status === 401) {
    throw new SdlcError("GET /app answered 401: GitHub rejected the JSON Web Token; check that APP_CLIENT_ID and APP_PRIVATE_KEY belong to the same GitHub App", {
      code: "app-auth",
    });
  }
  throw new SdlcError(`GET /app answered ${response.status}${messageOf(response)}`, { code: "app-auth" });
}

/** The owner's account type from GET /users/{owner}: { type: "User" | "Organization", id }. */
export async function lookupOwner(api, owner) {
  const response = await api.request("GET", `/users/${encodeURIComponent(owner)}`);
  if (response.status === 200 && response.json && typeof response.json.type === "string") {
    return { type: response.json.type, id: response.json.id ?? null };
  }
  if (response.status === 404) throw new SdlcError(`--owner '${owner}' is neither a GitHub user nor an organization`, { code: "owner" });
  throw new SdlcError(`GET /users/${owner} answered ${response.status}${messageOf(response)}`, { code: "owner" });
}

/**
 * Compares a `permissions` object with the map: entries above the map (an extra key, or a level higher than the
 * map's, `admin` included, or a value that is not read, write or admin) and map entries that are not held.
 * @returns {{ excess: {key:string, level:string, reason:string}[], missing: {key:string, required:string, held:string}[] }}
 */
export function comparePermissions(permissions, map = loadPermissionMap()) {
  const held = permissions && typeof permissions === "object" && !Array.isArray(permissions) ? permissions : {};
  const allowed = new Map(Object.entries(map).map(([key, level]) => [normalize(key), level]));
  const excess = [];
  for (const [key, level] of Object.entries(held)) {
    const required = allowed.get(normalize(key));
    if (!(typeof level === "string" && level in RANK)) {
      excess.push({ key, level: JSON.stringify(level), reason: "a value outside read and write" });
    } else if (required === undefined) {
      excess.push({ key, level, reason: "a key that the least-privilege map does not contain" });
    } else if (RANK[level] > RANK[required]) {
      excess.push({ key, level, reason: `a level above ${required}` });
    }
  }
  const missing = [];
  const heldByName = new Map(Object.entries(held).map(([key, level]) => [normalize(key), level]));
  for (const [key, required] of Object.entries(map)) {
    const level = heldByName.get(normalize(key));
    if (!(typeof level === "string" && level in RANK && RANK[level] >= RANK[required])) {
      missing.push({ key, required, held: typeof level === "string" ? level : "none" });
    }
  }
  return { excess, missing };
}

/** Aborts when `permissions` holds a key or level above the ceiling (AC19, AC35). `subject` names the App or the installation's account. */
export function assertWithinCeiling(permissions, subject, map = loadPermissionMap()) {
  const { excess } = comparePermissions(permissions, map);
  if (excess.length > 0) {
    const list = excess.map((entry) => `${entry.key}: ${entry.level} (${entry.reason})`).join("; ");
    throw new SdlcError(
      `${subject} exceeds the least-privilege ceiling of bin/lib/app-permissions.json: ${list}. ` +
        "Reduce the permissions in the App's settings, then run the bootstrap again; nothing has been written.",
      { code: "permission-ceiling" },
    );
  }
}

/** Aborts when a map entry is not held at the level the map specifies; used for the App itself (installations use their own diagnostic, AC20). */
export function assertHoldsRequired(permissions, subject, map = loadPermissionMap()) {
  const { missing } = comparePermissions(permissions, map);
  if (missing.length > 0) {
    const list = missing.map((entry) => `${entry.key}: ${entry.required} (holds ${entry.held})`).join("; ");
    throw new SdlcError(`${subject} lacks required permissions: ${list}. Grant them in the App's settings, then run the bootstrap again; nothing has been written.`, {
      code: "permission-missing",
    });
  }
}

/** The ceiling and the required entries for an App object (conversion response or GET /app). */
export function verifyAppPermissions(app, map = loadPermissionMap()) {
  const subject = `GitHub App '${app.slug}'`;
  assertWithinCeiling(app.permissions, subject, map);
  assertHoldsRequired(app.permissions, subject, map);
}
