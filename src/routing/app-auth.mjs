// The tokens of the router (SPEC-03 AC30, AC32). The router job is given the App's client ID and private key (APP_CLIENT_ID, APP_PRIVATE_KEY) and no
// token, so it signs a short-lived JSON Web Token (RS256) and exchanges it for installation access tokens of two kinds:
//
//  - the write token: the installation of the orchestrator's owner, limited to the orchestrator repository and to variables: write (the state
//    variable) and actions: write (the dispatch and the run status). It authenticates nothing but requests to the orchestrator repository.
//  - read tokens: contents: read, pull-requests: read and actions: read on the downstream and upstream repositories, one per owner. They
//    authenticate every read of the upstream and of the downstream repository and the checkouts, and they are the only token that a preflight
//    command can see (its GH_TOKEN), so that code of a downstream repository cannot write the state or dispatch a workflow.
//
// The private key stays in memory. An upstream that belongs to an owner without an installation of the App is read with the read token of the
// orchestrator's owner, which suffices for a public repository and fails (404) for a private one; no other credential takes its place.

import { signAppJwt } from "../drift/lib/app-token.mjs";
import { assertInstallationToken, RestError } from "./rest.mjs";

export const WRITE_PERMISSIONS = Object.freeze({ variables: "write", actions: "write" });
export const READ_PERMISSIONS = Object.freeze({ contents: "read", pull_requests: "read", actions: "read" });

const ownerOf = (slug) => String(slug).split("/")[0];
const nameOf = (slug) => String(slug).slice(String(slug).indexOf("/") + 1);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {object} input
 * @param {ReturnType<import("./rest.mjs").createRestClient>} input.client
 * @param {string} input.clientId the App's client ID (the issuer of the JWT)
 * @param {string} input.privateKeyPem
 * @param {string} input.centralSlug the orchestrator repository, <owner>/<repo>
 * @param {string[]} input.requiredReadSlugs repositories that must be readable (the downstream)
 * @param {string[]} [input.optionalReadSlugs] repositories that are read with the read token of the orchestrator's owner when their owner has no installation (the upstream)
 * @param {number} [input.nowMs]
 * @param {(secret: string) => void} [input.onSecret] called with the signed JWT and with every token, the moment the script holds it
 * @returns {Promise<{ write: string, readTokenFor: (slug: string) => string, notes: string[] }>}
 */
export async function mintRouterTokens({ client, clientId, privateKeyPem, centralSlug, requiredReadSlugs, optionalReadSlugs = [], nowMs = Date.now(), onSecret = () => {} }) {
  const jwt = signAppJwt({ privateKeyPem, issuer: clientId, nowMs });
  onSecret(jwt);
  const { items } = await client.paginate("/app/installations?per_page=100", { bearer: jwt });
  const installationOf = (owner) => items.find((entry) => !entry?.suspended_at && same(entry?.account?.login ?? "", owner));

  const mint = async (installation, repositories, permissions, label) => {
    const response = await client.requestJson("POST", `/app/installations/${installation.id}/access_tokens`, {
      bearer: jwt,
      body: { repositories, permissions: { ...permissions } },
      expect: [201],
    });
    const token = response.json?.token;
    if (typeof token !== "string" || token === "") throw new RestError(`the installation token response for ${label} held no token`, { kind: "http", status: response.status });
    // registered before anything else is done with it, so that no later message can carry it
    onSecret(token);
    return assertInstallationToken(token, `the installation token for ${label}`);
  };

  const centralOwner = ownerOf(centralSlug);
  const centralInstallation = installationOf(centralOwner);
  if (!centralInstallation) throw new RestError(`the GitHub App is not installed on '${centralOwner}', the owner of the orchestrator repository`, { kind: "permission" });
  const write = await mint(centralInstallation, [nameOf(centralSlug)], WRITE_PERMISSIONS, `the orchestrator repository ${centralSlug}`);

  // one read token per owner; the orchestrator's owner first, because its token is also the read token of an owner without an installation
  const required = [...new Set(requiredReadSlugs)];
  const optional = [...new Set(optionalReadSlugs)].filter((slug) => !required.includes(slug));
  const owners = [];
  for (const slug of [...required, ...optional]) if (!owners.some((owner) => same(owner, ownerOf(slug)))) owners.push(ownerOf(slug));
  owners.sort((a, b) => Number(same(b, centralOwner)) - Number(same(a, centralOwner)));

  const readByOwner = new Map();
  const notes = [];
  let centralRead = null;
  for (const owner of owners) {
    const slugs = [...required, ...optional].filter((slug) => same(ownerOf(slug), owner));
    const installation = installationOf(owner);
    if (installation) {
      const token = await mint(installation, [...new Set(slugs.map(nameOf))], READ_PERMISSIONS, `reading ${slugs.join(", ")}`);
      readByOwner.set(owner.toLowerCase(), token);
      if (same(owner, centralOwner)) centralRead = token;
      continue;
    }
    if (slugs.every((slug) => optional.includes(slug)) && centralRead !== null) {
      readByOwner.set(owner.toLowerCase(), centralRead);
      notes.push(`the GitHub App is not installed on '${owner}'; ${slugs.join(", ")} is read with the read token of '${centralOwner}', which works for a public repository only`);
      continue;
    }
    throw new RestError(`the GitHub App is not installed on '${owner}', the owner of ${slugs.join(", ")}`, { kind: "permission" });
  }

  return {
    write,
    notes,
    readTokenFor(slug) {
      const token = readByOwner.get(ownerOf(slug).toLowerCase());
      if (token === undefined) throw new RestError(`no read token was minted for '${slug}'`, { kind: "permission" });
      return token;
    },
  };
}
