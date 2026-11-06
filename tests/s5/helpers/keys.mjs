// Fixture key material: an RSA key pair for the GitHub App (PKCS#1 PEM, as the manifest conversion returns it)
// and a libsodium key pair for the repository secrets public key. Generated once per test process.

import crypto from "node:crypto";
import sodium from "libsodium-wrappers";

let appKey = null;

/** { privateKeyPem, publicKeyPem }: the App private key starts with -----BEGIN RSA PRIVATE KEY-----. */
export function fixtureAppKey() {
  if (appKey === null) {
    const pair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    appKey = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
  }
  return appKey;
}

/** Verifies an RS256 token against a public key: { valid, header, payload }. */
export function verifyJwt(token, publicKeyPem) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return { valid: false };
  try {
    const [header, payload, signature] = parts;
    const valid = crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKeyPem, Buffer.from(signature, "base64url"));
    return {
      valid,
      header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    };
  } catch {
    return { valid: false };
  }
}

/** A libsodium key pair serving as the repository secrets public key: { keyId, publicKeyBase64, publicKey, privateKey }. */
export async function sodiumKeyPair(keyId = "012345678912345678") {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { keyId, publicKey: pair.publicKey, privateKey: pair.privateKey, publicKeyBase64: Buffer.from(pair.publicKey).toString("base64") };
}

/** Decrypts a Base64 sealed box with a fixture key pair. */
export async function openSealedBox(encryptedBase64, pair) {
  await sodium.ready;
  const opened = sodium.crypto_box_seal_open(Buffer.from(encryptedBase64, "base64"), pair.publicKey, pair.privateKey);
  return Buffer.from(opened).toString("utf8");
}
