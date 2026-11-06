// RS256 JSON Web Token for the GitHub App endpoints that require one (GET /app, GET /app/installations,
// GET /repos/{owner}/{repo}/installation). The private key is used in memory only.

import crypto from "node:crypto";
import { SdlcError } from "./errors.mjs";

const encode = (value) => Buffer.from(value).toString("base64url");

/**
 * @param {{ privateKeyPem: string, issuer: string, nowMs?: number }} input `issuer` is the App's client ID
 * @returns {string} header.payload.signature
 */
export function signAppJwt({ privateKeyPem, issuer, nowMs = Date.now() }) {
  let key;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new SdlcError("APP_PRIVATE_KEY is not a valid PEM private key", { code: "app-key" });
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new SdlcError("APP_PRIVATE_KEY is not an RSA private key, which GitHub Apps use to sign tokens", { code: "app-key" });
  }
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 60 + 9 * 60, iss: String(issuer) }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${encode(signature)}`;
}
