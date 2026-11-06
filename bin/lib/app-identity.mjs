// App credentials from the environment (AC10, AC17): APP_CLIENT_ID and APP_PRIVATE_KEY together select the
// existing-App path, which skips registration and resolves appId and appSlug through GET /app with a JSON Web Token.

import { SdlcError } from "./errors.mjs";
import { signAppJwt } from "./app-jwt.mjs";
import { fetchAuthenticatedApp, verifyAppPermissions } from "./github-app.mjs";

export const NEW_APP_REQUIRES_BROWSER = "creating a new GitHub App requires an interactive browser flow";

/** The two values as the environment supplies them; the private key is kept exactly as given. */
export function readAppCredentials(env) {
  const clientId = String(env.APP_CLIENT_ID ?? "").trim();
  const rawKey = String(env.APP_PRIVATE_KEY ?? "");
  return { clientId, privateKey: rawKey.trim() === "" ? "" : rawKey };
}

/**
 * Decides how the run obtains its App.
 * @returns {"existing" | "register"}
 * @throws {SdlcError} for a half-supplied pair, for --non-interactive without the pair, and (onboarding) without the pair
 */
export function selectAppPath({ clientId, privateKey }, { nonInteractive = false, onboarding = false } = {}) {
  const missing = [clientId === "" ? "APP_CLIENT_ID" : null, privateKey === "" ? "APP_PRIVATE_KEY" : null].filter(Boolean);
  if (missing.length === 0) return "existing";
  if (onboarding) {
    throw new SdlcError(
      `App credentials are required to resolve appSlug for contract C1: set APP_CLIENT_ID and APP_PRIVATE_KEY in the environment (missing: ${missing.join(", ")})`,
      { code: "app-credentials" },
    );
  }
  const half = missing.length === 1;
  if (half || nonInteractive) {
    throw new SdlcError(
      `${nonInteractive ? `${NEW_APP_REQUIRES_BROWSER}. ` : ""}` +
        (half
          ? `${missing[0]} is missing: set both APP_CLIENT_ID and APP_PRIVATE_KEY to use an existing GitHub App, or neither to register a new one in the browser.`
          : "Set APP_CLIENT_ID and APP_PRIVATE_KEY in the environment to use an existing GitHub App."),
      { code: "app-credentials" },
    );
  }
  return "register";
}

/** GET /app with a JWT signed by the private key; checks the permission ceiling. clientId comes from APP_CLIENT_ID. */
export async function loadExistingApp({ api, credentials, logger }) {
  logger.addSecret(credentials.privateKey);
  const jwt = signAppJwt({ privateKeyPem: credentials.privateKey, issuer: credentials.clientId });
  logger.addSecret(jwt);
  const app = await fetchAuthenticatedApp(api, jwt);
  const identity = { id: app.id, slug: app.slug, clientId: credentials.clientId, permissions: app.permissions };
  verifyAppPermissions(identity);
  return identity;
}
