// The scaffolding of a src/update-poll-state.mjs run against the local stub, shared by the tests that drive the script in process: a world (the stub with
// the variable, the open pull request and its provenance, the workspace holding sdlc.yaml, the injectable clock), the seven success flags of an edge, and one
// invocation that captures what the script printed.
import { run } from "../../../src/update-poll-state.mjs";
import { createClock } from "../../s2/helpers/stub-server.mjs";
import { createGitHubStub, pullRequest } from "./github-stub.mjs";
import { CENTRAL, createWorkspace, edge, NOW_ISO, sha, state, STUB_API_URL, TOKENS } from "./fixtures.mjs";

export const TARGET = sha("target");
export const BASE = sha("base");
export const HEAD = sha("head");
export const PR_HEAD = sha("pr-head");
export const ETAG = 'W/"etag-after"';

export function world({ edgeValue = edge(), start = state({}, edgeValue), pulls, files, extraRepos = {}, stubOptions = {} } = {}) {
  const [owner] = edgeValue.downstreamRepo.split("/");
  const headKey = `${owner}:${edgeValue.branchName}`;
  const stub = createGitHubStub({
    central: CENTRAL,
    variables: { [edgeValue.stateVariable]: start },
    acceptTokens: [TOKENS.gh, TOKENS.issues],
    apiBase: STUB_API_URL,
    repos: {
      [edgeValue.downstreamRepo]: {
        openPullsByHead: { [headKey]: pulls ?? [pullRequest({ number: 7, headSha: PR_HEAD, headRef: edgeValue.branchName })] },
        filesAtRef: { [PR_HEAD]: { [edgeValue.provenanceFile]: JSON.stringify({ commit: TARGET, build: "x" }) }, ...(files ?? {}) },
      },
      ...extraRepos,
    },
    ...stubOptions,
  });
  const workspace = createWorkspace({ edges: [edgeValue] });
  const clock = createClock(Date.parse(NOW_ISO));
  return { stub, workspace, clock, edgeValue };
}

/** The seven flags of the success path, as an argv. A value of `undefined` in `overrides` leaves that flag out. */
export function flagsFor(edgeValue, overrides = {}) {
  const flags = {
    "--slug": edgeValue.upstreamSlug,
    "--branch": edgeValue.branchName,
    "--provenance-file": edgeValue.provenanceFile,
    "--base-sha": BASE,
    "--head-sha": HEAD,
    "--target-sha": TARGET,
    "--etag": ETAG,
    ...overrides,
  };
  return Object.entries(flags).flatMap(([name, value]) => (value === undefined ? [] : [name, value]));
}

export async function invoke(w, argv, { env = {}, omitEnv = [] } = {}) {
  let stdout = "";
  let stderr = "";
  const base = { GITHUB_WORKSPACE: w.workspace.dir, GITHUB_REPOSITORY: CENTRAL, GITHUB_API_URL: STUB_API_URL, GH_TOKEN: TOKENS.gh, ISSUES_TOKEN: TOKENS.issues, GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", ...env };
  for (const name of omitEnv) delete base[name];
  const code = await run(argv, { env: base, fetch: w.stub.fetch, now: w.clock.now, sleep: w.clock.sleep, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}
