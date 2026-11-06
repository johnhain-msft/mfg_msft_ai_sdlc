// GitHub App authentication for the drift scripts (SPEC-02 AC9, AC10).
//
// The pre-agent steps receive the App's client ID and private key. They sign a short-lived JSON Web Token (RS256), find
// the installation on the owner of the target repository, and exchange the token for an installation access token that
// is limited to that one repository and to the permissions the call needs. The private key stays in memory.

import crypto from "node:crypto";
import { GitHubApiError } from "./github-client.mjs";

const encode = (value) => Buffer.from(value).toString("base64url");

/** The PEM of a secret that was stored with literal \n sequences instead of line breaks. */
export function normalizePem(value) {
  const text = String(value ?? "").trim();
  return text.includes("\n") || !text.includes("\\n") ? text : text.replace(/\\n/g, "\n");
}

/**
 * @param {{ privateKeyPem: string, issuer: string, nowMs?: number }} input `issuer` is the App's client ID
 * @returns {string} header.payload.signature
 */
export function signAppJwt({ privateKeyPem, issuer, nowMs = Date.now() }) {
  let key;
  try {
    key = crypto.createPrivateKey(normalizePem(privateKeyPem));
  } catch {
    throw new GitHubApiError("APP_PRIVATE_KEY is not a valid PEM private key");
  }
  if (key.asymmetricKeyType !== "rsa") throw new GitHubApiError("APP_PRIVATE_KEY is not an RSA private key, which GitHub Apps use to sign tokens");
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 60 + 9 * 60, iss: String(issuer) }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${encode(signature)}`;
}

/**
 * An installation access token for one repository.
 * The installation is found through GET /app/installations (the account whose login is the repository owner), so that
 * the only request addressed to the target repository's own path is the pull request listing of the caller.
 * @returns {Promise<string>} the token
 */
export async function mintInstallationToken({ client, clientId, privateKeyPem, owner, repo, permissions, nowMs = Date.now() }) {
  const jwt = signAppJwt({ privateKeyPem, issuer: clientId, nowMs });
  const { items } = await client.paginate("/app/installations?per_page=100", { bearer: jwt });
  const installation = items.find((entry) => String(entry?.account?.login ?? "").toLowerCase() === owner.toLowerCase());
  if (!installation) throw new GitHubApiError(`the GitHub App is not installed on '${owner}'`);
  const minted = await client.requestJson("POST", `/app/installations/${installation.id}/access_tokens`, {
    bearer: jwt,
    body: { repositories: [repo], permissions },
    expect: [201],
  });
  if (typeof minted?.token !== "string" || minted.token === "") throw new GitHubApiError("the installation token response held no token");
  return minted.token;
}
