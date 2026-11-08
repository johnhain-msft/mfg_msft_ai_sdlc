// Repository secrets on the central orchestrator repository (AC25-AC29): every value is checked for the
// OAuth prefix `gho_` and encrypted locally as a libsodium sealed box before the first PUT, and a
// plaintext value never appears in a request, a URL, a log line or a file.
//
// The API-key secret names of the engines other than copilot are transcribed from gh-aw's
// authentication reference (docs/reference/auth.mdx: ANTHROPIC_API_KEY for claude; OPENAI_API_KEY or
// CODEX_API_KEY for codex; GEMINI_API_KEY for gemini; pi selects by the provider prefix of its model)
// into engine-secrets.json.

import fs from "node:fs";
import { SdlcError } from "./errors.mjs";
import { splitSlug } from "./validators.mjs";

export const APP_PRIVATE_KEY_SECRET = "APP_PRIVATE_KEY";
export const COPILOT_TOKEN_SECRET = "COPILOT_GITHUB_TOKEN";
export const OAUTH_PREFIX = "gho_";

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PUBLIC_KEY_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** API-key secret names accepted for an engine, from engine-secrets.json (primary name first); [] for copilot. */
export function engineSecretNames(engine) {
  const table = JSON.parse(fs.readFileSync(new URL("./engine-secrets.json", import.meta.url), "utf8"));
  return [...(table[engine] ?? [])];
}

/** Aborts when a value contains the OAuth prefix `gho_` (the token `gh auth login` issues); the diagnostic never echoes the value. */
export function assertNotOAuthToken(name, value) {
  if (typeof value === "string" && value.includes(OAUTH_PREFIX)) {
    throw new SdlcError(
      `the value for ${name} contains '${OAUTH_PREFIX}', the prefix of the OAuth token that gh auth login issues; ` +
        "an OAuth token must not be used as a workflow credential. Use a fine-grained personal access token (or the engine's own API key) instead. Nothing was written.",
      { code: "oauth-token" },
    );
  }
}

/** Validates every secret (a usable name, a non-empty string, no `gho_`) before anything is sent. */
export function assertSecretsValid(secrets) {
  for (const { name, value } of secrets) {
    if (!SECRET_NAME.test(name) || /^github_/i.test(name)) {
      throw new SdlcError(`'${name}' is not a valid Actions secret name`, { code: "secret-name" });
    }
    if (typeof value !== "string" || value === "") throw new SdlcError(`the value for ${name} is empty`, { code: "secret-value" });
    assertNotOAuthToken(name, value);
  }
}

const trimToken = (value) => value.trim();

/**
 * Decides the engine authentication mode and collects the engine credentials from the environment or, in an interactive
 * run, from a prompt that does not echo (AC27, AC34). Values are never taken from flags.
 * @returns {Promise<{ engineAuthMode: "copilot-requests" | "copilot-pat" | "api-key", secrets: {name:string, value:string}[] }>}
 */
export async function collectEngineCredentials({ engine, env, prompt, interactive, manifestSecretName, logger }) {
  const ask = async (name, message) => {
    if (!interactive || typeof prompt !== "function") return "";
    const answer = await prompt({ name, message, echo: false });
    return typeof answer === "string" ? answer : "";
  };
  if (engine === "copilot") {
    let token = trimToken(env[COPILOT_TOKEN_SECRET] ?? "");
    if (token === "") {
      token = trimToken(await ask(COPILOT_TOKEN_SECRET, `${COPILOT_TOKEN_SECRET} (a fine-grained personal access token owned by a user account; leave empty to authenticate with the Actions token, copilot-requests)`));
    }
    if (token === "") return { engineAuthMode: "copilot-requests", secrets: [] };
    logger?.addSecret(token);
    return { engineAuthMode: "copilot-pat", secrets: [{ name: COPILOT_TOKEN_SECRET, value: token }] };
  }
  const candidates = [...new Set([...(manifestSecretName ? [manifestSecretName] : []), ...engineSecretNames(engine)])];
  const secrets = [];
  for (const name of candidates) {
    const value = trimToken(env[name] ?? "");
    if (value !== "") secrets.push({ name, value });
  }
  if (secrets.length === 0 && candidates.length > 0) {
    const value = trimToken(await ask(candidates[0], `${candidates[0]} (the API key of the ${engine} engine)`));
    if (value !== "") secrets.push({ name: candidates[0], value });
  }
  if (secrets.length === 0) {
    throw new SdlcError(
      `the ${engine} engine needs an API key: set ${candidates.join(" or ")} in the environment${interactive ? " (or enter it at the prompt)" : ""}`,
      { code: "engine-credential" },
    );
  }
  for (const secret of secrets) logger?.addSecret(secret.value);
  return { engineAuthMode: "api-key", secrets };
}

const secretsPath = (repoSlug) => {
  const { owner, repo } = splitSlug(repoSlug);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`;
};

function secretsFailure({ api, method, route, response, repo }) {
  const message = typeof response.json?.message === "string" ? ` (${response.json.message})` : "";
  const grant =
    "a fine-grained or GitHub App token needs the 'Secrets' repository permission (read for the public key, write to create or update a secret); " +
    "for other token kinds see the scopes that the REST reference lists for this route";
  return new SdlcError(
    `${method} ${route} answered ${response.status}${message}: the token in use is a ${api.kind} and cannot manage secrets on ${repo} — ${grant}. No further request was made.`,
    { code: "secrets-failed" },
  );
}

async function loadSodium() {
  const module = await import("libsodium-wrappers");
  const sodium = module.default ?? module;
  await sodium.ready;
  return sodium;
}

/** Fetches the repository public key and seals one value: { encrypted_value, key_id }. */
async function sealSecret({ api, repo, sodium, name, value }) {
  const route = `${secretsPath(repo)}/public-key`;
  const response = await api.request("GET", route);
  if (response.status !== 200) throw secretsFailure({ api, method: "GET", route, response, repo });
  const { key_id: keyId, key } = response.json ?? {};
  if (typeof keyId !== "string" || keyId === "" || typeof key !== "string") {
    throw new SdlcError(`the public key of ${repo} has no key_id or key; ${name} was not encrypted and nothing was written`, { code: "secrets-failed" });
  }
  const decoded = BASE64.test(key) ? Buffer.from(key, "base64") : Buffer.alloc(0);
  if (decoded.length !== PUBLIC_KEY_BYTES) {
    throw new SdlcError(`the public key of ${repo} is not ${PUBLIC_KEY_BYTES} bytes (got ${decoded.length}); ${name} was not encrypted and nothing was written`, { code: "secrets-failed" });
  }
  const sealed = sodium.crypto_box_seal(Buffer.from(value, "utf8"), decoded);
  return { encrypted_value: Buffer.from(sealed).toString("base64"), key_id: keyId };
}

/**
 * Validates, fetches the public key for and encrypts every secret, and only then PUTs each one.
 * @param {{ api: object, repo: string, secrets: {name:string, value:string}[], onStored?: (name: string) => void }} input
 * @returns {Promise<string[]>} the names uploaded, in upload order
 */
export async function uploadSecrets({ api, repo, secrets, onStored }) {
  assertSecretsValid(secrets);
  const sodium = await loadSodium();
  const sealed = [];
  for (const { name, value } of secrets) sealed.push({ name, ...(await sealSecret({ api, repo, sodium, name, value })) });
  const stored = [];
  for (const { name, encrypted_value, key_id } of sealed) {
    const route = `${secretsPath(repo)}/${encodeURIComponent(name)}`;
    const response = await api.request("PUT", route, { body: { encrypted_value, key_id } });
    if (!response.ok) throw secretsFailure({ api, method: "PUT", route, response, repo });
    stored.push(name);
    onStored?.(name);
  }
  return stored;
}
