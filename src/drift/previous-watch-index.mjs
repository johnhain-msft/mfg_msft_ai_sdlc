#!/usr/bin/env node
// Pre-agent step of every drift workflow, before the snapshot: the watch index of the previous run (SPEC-02 AC41).
//
//   node src/drift/previous-watch-index.mjs --out /tmp/gh-aw/agent --workflow drift-<projectKey>.lock.yml --artifact sdlc-watch-index-<projectKey>
//
// The snapshot step uploads its watch index (sources/watch-index.json) as the artifact --artifact of every run that is not a dry run. This step
// finds the newest successful run of --workflow other than the current one (GITHUB_RUN_ID) that still holds that artifact, unexpired, downloads
// it and writes <out>/previous/watch-index.json and <out>/previous/baseline.json (which run it is). A run that failed, was cancelled or was a dry
// run is never a baseline: what its agent saw was not reviewed, so the next run sees it again. The snapshot step compares the new snapshots with
// that index and lists only what changed since.
//
// It reads with the job's GITHUB_TOKEN (GH_TOKEN or GITHUB_TOKEN, an installation token with actions: read) and accepts no other credential
// (SPEC-02 AC9). The download URL that the artifact endpoint redirects to is signed: it is fetched without the token and never printed.
// A missing baseline never fails the job: no earlier run, an expired artifact, an API error or an index of another version are all written to
// baseline.json as { found: false, reason }, printed as a warning, and the snapshot step reports them as the reason why everything is new.
// Only a usage error (a missing option or repository) exits non-zero, because that is a defect of the workflow and not of the run.

import path from "node:path";
import { parseFlags, requireSlug, UsageError } from "./lib/args.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { outDirectory, resolveIo, runAsMain, stableJson } from "./lib/cli.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, resolveApiBase } from "./lib/github-client.mjs";
import { usableIndex } from "./lib/watch-digest.mjs";
import { readZipEntry } from "./lib/zip.mjs";

const OPTIONS = {
  out: { type: "string" },
  workflow: { type: "string" },
  artifact: { type: "string" },
  "max-runs": { type: "string" },
};

export const INDEX_FILE = "watch-index.json";
export const BASELINE_FILE = "baseline.json";
export const PREVIOUS_DIRECTORY = "previous";
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_RUNS = 20;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

class BaselineMissing extends Error {}

async function download(client, io, repo, artifact) {
  const response = await client.request("GET", `/repos/${repo}/actions/artifacts/${artifact.id}/zip`);
  const location = response.headers.get("location");
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
    throw new GitHubApiError(`GET /repos/${repo}/actions/artifacts/${artifact.id}/zip returned HTTP ${response.status} without a download location`);
  }
  // the location is a signed URL of the artifact storage: no credential goes there, and the URL is not repeated in any message
  const blob = await io.fetch(location, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!blob.ok) throw new GitHubApiError(`the download of artifact ${artifact.id} returned HTTP ${blob.status}`);
  const length = Number(blob.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) throw new GitHubApiError(`artifact ${artifact.id} is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new GitHubApiError(`artifact ${artifact.id} is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  return bytes;
}

async function findBaseline({ client, io, repo, workflow, artifactName, maxRuns, currentRunId }) {
  const runs = await client.requestJson("GET", `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=${maxRuns}`);
  const candidates = (Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : []).filter((candidate) => Number.isInteger(candidate?.id) && String(candidate.id) !== currentRunId);
  for (const candidate of candidates) {
    const listing = await client.requestJson("GET", `/repos/${repo}/actions/runs/${candidate.id}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=10`);
    const artifact = (Array.isArray(listing?.artifacts) ? listing.artifacts : []).find((item) => item?.name === artifactName && item?.expired !== true && Number.isInteger(item?.id));
    if (!artifact) continue;
    const bytes = await download(client, io, repo, artifact);
    const entry = readZipEntry(bytes, INDEX_FILE);
    if (entry === null) throw new BaselineMissing(`artifact ${artifact.id} of run ${candidate.id} holds no ${INDEX_FILE}`);
    let index;
    try {
      index = JSON.parse(entry.toString("utf8"));
    } catch (error) {
      throw new BaselineMissing(`the ${INDEX_FILE} of run ${candidate.id} is not JSON: ${error.message}`);
    }
    if (usableIndex(index) === null) throw new BaselineMissing(`run ${candidate.id} holds a watch index that this version cannot compare with`);
    return {
      index,
      baseline: { found: true, runId: candidate.id, runUrl: String(candidate.html_url ?? ""), createdAt: String(candidate.created_at ?? ""), artifactId: artifact.id, workflow, artifact: artifactName },
    };
  }
  throw new BaselineMissing(`no successful run of ${workflow} among the last ${maxRuns} has an unexpired artifact named ${artifactName}`);
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  let flags;
  let out;
  let workflow;
  let artifactName;
  let repo;
  let maxRuns;
  try {
    flags = parseFlags(argv, OPTIONS);
    out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    workflow = String(flags.workflow ?? "").trim();
    if (!WORKFLOW_FILE.test(workflow)) throw new UsageError("--workflow must be the file name of the workflow (for example drift-<projectKey>.lock.yml)");
    artifactName = String(flags.artifact ?? "").trim();
    if (!ARTIFACT_NAME.test(artifactName)) throw new UsageError("--artifact must be the name of the watch-index artifact");
    repo = requireSlug(io.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
    maxRuns = flags["max-runs"] === undefined ? DEFAULT_MAX_RUNS : Number(flags["max-runs"]);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) throw new UsageError("--max-runs must be a whole number from 1 to 100");
  } catch (error) {
    io.stderr(`previous-watch-index: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
  const directory = path.join(out, PREVIOUS_DIRECTORY);
  const indexPath = path.join(directory, INDEX_FILE);
  let result;
  try {
    const token = String(io.env.GH_TOKEN ?? io.env.GITHUB_TOKEN ?? "").trim();
    if (token === "") throw new BaselineMissing("no token: GH_TOKEN (the job's GITHUB_TOKEN) is not set");
    assertInstallationToken(token, "GH_TOKEN");
    const client = createGitHubClient({ baseUrl: resolveApiBase(io.env), token, fetch: io.fetch, sleep: io.sleep, now: io.now, userAgent: "sdlc-orchestrator-drift" });
    result = await findBaseline({ client, io, repo, workflow, artifactName, maxRuns, currentRunId: String(io.env.GITHUB_RUN_ID ?? "").trim() });
  } catch (error) {
    const reason = error instanceof BaselineMissing ? error.message : `the previous watch index could not be read: ${String(error?.message ?? error).split("\n")[0]}`;
    result = { index: null, baseline: { found: false, reason, workflow, artifact: artifactName } };
  }
  try {
    if (result.index === null && io.fs.existsSync(indexPath)) io.fs.rmSync(indexPath, { force: true });
    const files = [{ path: path.join(directory, BASELINE_FILE), data: stableJson(result.baseline) }];
    if (result.index !== null) files.unshift({ path: indexPath, data: stableJson(result.index) });
    writeFilesAtomically(files, { fs: io.fs });
  } catch (error) {
    io.stderr(`previous-watch-index: ${error.message}\n`);
    return 1;
  }
  if (result.baseline.found) {
    io.stdout(`previous-watch-index: baseline is run ${result.baseline.runId} (${result.baseline.runUrl}), artifact ${result.baseline.artifactId}\n`);
  } else {
    io.stdout(`::warning::No previous watch index: ${result.baseline.reason}. Every watched entry is new to this run.\n`);
  }
  return 0;
}

await runAsMain(import.meta.url, run);
