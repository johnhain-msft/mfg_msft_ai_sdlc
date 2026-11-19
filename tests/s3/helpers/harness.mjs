// The router, wired to the local stub: a world (the orchestrator, one upstream, one downstream, the App), the environment that the router workflow gives
// the script, and the run. A test states what differs from the quiet default and asserts what was persisted and what was refused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importEngine } from "../../helpers/instance.mjs";
import { createClock } from "../../s2/helpers/stub-server.mjs";
import { createGitHubStub } from "./github-stub.mjs";
import { appKeyPair, CENTRAL, createWorkspace, edge as edgeFixture, NOW, seedState, sha, STUB_API_URL, TOKENS } from "./fixtures.mjs";

// the router of the installed engine, a deep import: its command is what the router workflow runs, and a change of it is what these tests are to notice
const { run } = await importEngine("src/route-upstream.mjs");

export const CLIENT_ID = "Iv1.fixtureclientid";

/**
 * @param {object} [options]
 * @param {object} [options.edge] the router edge (default: the synthetic ai-adaptation edge)
 * @param {object} [options.state] the stored state (default: the seed of the edge)
 * @param {"schedule" | "workflow_dispatch" | "repository_dispatch"} [options.event]
 * @param {object | string} [options.payload] the client_payload (an object is sent as its JSON)
 * @param {boolean | string} [options.resetBlocked]
 * @param {object} [options.upstream] repository fields: head, etag, pullsEtag, closedPulls, runs, runList, files
 * @param {object} [options.downstream] repository fields: head, defaultBranch, files, pulls
 * @param {object[]} [options.manifestEdges] the edges of sdlc.yaml (default: the edge)
 * @param {object} [options.manifestExtra] more top-level keys of sdlc.yaml (for example `{ factory: { package: "ai-sdlc-factory", private: true } }`)
 * @param {Record<string, string>} [options.workspaceFiles] files of the workspace besides sdlc.yaml, by workspace-relative path (the scripts that the edge's commands name)
 * @param {string} [options.central] the orchestrator repository, <owner>/<repository> (default: acme/orchestrator)
 * @param {Record<string, string>} [options.env] environment overrides ("" or undefined removes a variable)
 * @param {object[]} [options.installations]
 * @param {object} [options.stubOptions]
 */
export function routerWorld(options = {}) {
  const edge = options.edge ?? edgeFixture();
  const keys = appKeyPair();
  const central = options.central ?? CENTRAL;
  const upstreamOwner = edge.upstreamRepo.split("/")[0];
  const centralOwner = central.split("/")[0];
  const installations = options.installations ?? [
    { id: 11, account: { login: centralOwner } },
    ...(upstreamOwner.toLowerCase() === centralOwner.toLowerCase() ? [] : [{ id: 12, account: { login: upstreamOwner } }]),
  ];
  const upstreamHead = options.upstream?.head ?? sha("head-1");
  const downstreamHead = options.downstream?.head ?? sha("main-1");
  const stub = createGitHubStub({
    central,
    variables: options.state === null ? {} : { [edge.stateVariable]: options.state ?? seedState(edge) },
    installations,
    appPublicKey: keys.publicPem,
    clientId: CLIENT_ID,
    acceptTokens: [TOKENS.issues],
    apiBase: STUB_API_URL,
    repos: {
      [edge.upstreamRepo]: { defaultBranch: edge.upstreamDefaultBranch, head: upstreamHead, etag: 'W/"upstream-etag-1"', pullsEtag: 'W/"upstream-pulls-etag-1"', ...(options.upstream ?? {}) },
      [edge.downstreamRepo]: { defaultBranch: "main", head: downstreamHead, ...(options.downstream ?? {}) },
    },
    ...(options.stubOptions ?? {}),
  });
  const workspace = createWorkspace({
    edges: options.manifestEdges ?? [edge],
    ...(options.manifestExtra ? { manifestExtra: options.manifestExtra } : {}),
    ...(options.workspacePrefix ? { prefix: options.workspacePrefix } : {}),
    ...(options.workspaceFiles ? { files: options.workspaceFiles } : {}),
  });
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-summary-"));
  const summaryFile = path.join(summaryDir, "step-summary.md");
  const clock = createClock(options.now ?? NOW);
  const event = options.event ?? "schedule";
  const payload = options.payload === undefined ? "null" : typeof options.payload === "string" ? options.payload : JSON.stringify(options.payload);
  const env = {
    EVENT_NAME: event,
    UPSTREAM_KEY: edge.upstreamKey,
    EDGE_JSON: JSON.stringify(edge),
    CLIENT_PAYLOAD: payload,
    RESET_BLOCKED: options.resetBlocked === undefined ? (event === "workflow_dispatch" ? "false" : "") : String(options.resetBlocked),
    APP_CLIENT_ID: CLIENT_ID,
    APP_PRIVATE_KEY: keys.privatePem,
    ISSUES_TOKEN: TOKENS.issues,
    GITHUB_REPOSITORY: central,
    GITHUB_WORKSPACE: workspace.dir,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_RUN_ID: "5001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: STUB_API_URL,
    PATH: process.env.PATH ?? process.env.Path ?? "",
    ...(options.env ?? {}),
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];

  const world = {
    edge,
    central,
    stub,
    clock,
    workspace,
    env,
    summaryFile,
    keys,
    upstreamHead,
    downstreamHead,
    /** Runs the router once. */
    async go(extra = {}) {
      let stdout = "";
      let stderr = "";
      const code = await run([], {
        env: { ...env, ...(extra.env ?? {}) },
        fetch: stub.fetch,
        now: clock.now,
        sleep: clock.sleep,
        fs: extra.fs,
        bash: extra.bash,
        preflightDeps: extra.preflightDeps,
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      });
      return { code, stdout, stderr };
    },
    summaryLines() {
      return fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8").split("\n").filter(Boolean) : [];
    },
    decisions() {
      return world.summaryLines().map((line) => JSON.parse(line));
    },
    /** The stored state, parsed. */
    state() {
      return stub.variable(edge.stateVariable);
    },
    patches() {
      return stub.calls("PATCH", "/actions/variables/");
    },
    cleanup() {
      workspace.cleanup();
      fs.rmSync(summaryDir, { recursive: true, force: true });
    },
  };
  return world;
}

/** Every request that is not a GET, with the method and path, for the single-writer assertions. */
export const writesOf = (stub) => stub.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`);
