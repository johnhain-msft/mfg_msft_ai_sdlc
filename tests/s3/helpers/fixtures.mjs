// Fixtures of the tests/s3 suite: synthetic repositories and keys (the engine names none), a valid sync state, the environment of the callers
// and a throwaway workspace. A SHA is derived from a label, so that a test can say `sha("sha1")` and read it back.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const abs = (...parts) => path.join(REPO_ROOT, ...parts);
export const FIXTURES = path.join(REPO_ROOT, "tests", "s3", "fixtures");
export const fixture = (...parts) => path.join(FIXTURES, ...parts);
export const readText = (file) => fs.readFileSync(file, "utf8");
export const readJson = (file) => JSON.parse(readText(file));

/** A 40-hex object id that a label stands for. */
export const sha = (label) => crypto.createHash("sha1").update(String(label)).digest("hex");

export const CENTRAL = "acme/orchestrator";
/** The API origin that every script of the tests is configured with through GITHUB_API_URL (SPEC-03 AC67): a loopback address that nothing listens on, because the requests never leave the process. */
export const STUB_API_URL = "http://127.0.0.1:45871";
export const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
export const NOW_ISO = new Date(NOW).toISOString();

/** Recognisable credentials: a test asserts that they reach exactly the requests that they belong to and appear nowhere else. */
export const TOKENS = Object.freeze({
  gh: "ghs_fixtureghtoken0123456789abcdef",
  issues: "ghs_fixtureissuestoken0123456789ab",
  privateKeyMarker: "FIXTURE-PRIVATE-KEY-MARKER",
});

/** An edge as a router job receives it (EDGE_JSON): synthetic repositories, an upstream of its own owner and a downstream of the orchestrator's. */
export function edge(overrides = {}) {
  return {
    edgeId: "widgets-to-portal",
    upstreamRepo: "initech/widgets",
    upstreamKey: "widgets",
    upstreamSlug: "WIDGETS",
    upstreamDefaultBranch: "trunk",
    initialBaselineSha: sha("baseline"),
    downstreamRepo: "acme/portal",
    mode: "ai-adaptation",
    schedule: "0 */6 * * *",
    onCommitOnlyAdvance: "noop",
    stateVariable: "SDLC_SYNC_STATE_WIDGETS",
    provenanceFile: "docs/widgets/provenance.json",
    provenanceJsonPointer: "/commit",
    onBots: ["fixture-app[bot]"],
    branchName: "sdlc/cascade-widgets",
    closeOlderKey: "sdlc-cascade-widgets",
    reviewers: ["octocat"],
    importCommands: [],
    preflightCommands: [],
    buildCommands: [],
    verifyCommands: [],
    ...overrides,
  };
}

/** The mechanical counterpart. */
export const mechanicalEdge = (overrides = {}) =>
  edge({
    edgeId: "gadgets-to-portal",
    upstreamRepo: "acme/gadgets",
    upstreamKey: "gadgets",
    upstreamSlug: "GADGETS",
    upstreamDefaultBranch: "main",
    mode: "mechanical",
    stateVariable: "SDLC_SYNC_STATE_GADGETS",
    provenanceFile: "public/gadgets/source.json",
    branchName: "sdlc/cascade-gadgets",
    closeOlderKey: "sdlc-cascade-gadgets",
    importCommands: ["npm run import:gadgets -- <checkout>"],
    buildCommands: ["npm run build"],
    verifyCommands: ["npm test"],
    ...overrides,
  });

/** The state that the bootstrap seeds (SPEC-03 AC13), for an edge. */
export const seedState = (edgeValue = edge(), updatedAt = NOW_ISO) => ({
  etag: "",
  lastObservedHeadSha: edgeValue.initialBaselineSha,
  lastMergedUpstreamSha: edgeValue.initialBaselineSha,
  portfolioMainSha: null,
  lastNoopHeadSha: null,
  dismissedTargetSha: null,
  failedTargetSha: null,
  failedAttempts: 0,
  blockedTargetSha: null,
  inFlightRunId: null,
  inFlightTargetSha: null,
  openPrTargetSha: null,
  openPrNumber: null,
  updatedAt,
});

/** A valid state: the seed of the default edge with the given fields changed. */
export const state = (overrides = {}, edgeValue = edge()) => ({ ...seedState(edgeValue), ...overrides });

/** A throwaway directory with a manifest of the given edges and any other files: { dir, cleanup, path(...) }. */
export function createWorkspace({ edges = [], files = {}, manifestExtra = {}, prefix = "sdlc-s3-" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "sdlc.yaml"), YAML.stringify({ projects: [], dependencyEdges: edges, ...manifestExtra }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { dir, path: (...parts) => path.join(dir, ...parts), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** The edges of the committed preset (sdlc.yaml), parsed. */
export const presetEdges = () => YAML.parse(readText(abs("sdlc.yaml"))).dependencyEdges;

/** What the router receives as EDGE_JSON for a preset edge: the matrix entry of the committed router. */
export function routerMatrixEntries() {
  const router = YAML.parse(readText(abs(".github", "workflows", "cascade-router.yml")));
  return router.jobs.route.strategy.matrix.include;
}

/** An RSA key pair for the App, generated once per process. */
let appKeys = null;
export function appKeyPair() {
  if (appKeys === null) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    appKeys = {
      publicPem: publicKey.export({ type: "spki", format: "pem" }),
      privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    };
  }
  return appKeys;
}
