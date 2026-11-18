#!/usr/bin/env node
// The classifier of the showcase runs (design E2; SPEC-03 AC22): the router runs it right after `gh api "repos/<upstream>/actions/runs?per_page=100"`, from the
// downstream checkout, with the listing in a file. It is the snapshot check that the router used to make itself, and it makes it the same way:
//
//   (1) newer completed runs than the ones that the capture script records, workflow by workflow. A run is new when it is completed and newer than the newest
//       recorded run of ITS OWN workflow, whose workflow_id is read from the recorded run itself (GET /repos/{owner}/{repo}/actions/runs/{id}, with the read token
//       of the router). Run ids grow with time across all workflows, so the largest recorded id of all workflows is the wrong bar. A run of a workflow that no
//       recorded run belongs to is not one of the runs that the script records, and does not count.
//   (2) when none is new, the capture script runs in an isolated clone of the downstream checkout, and what it wrote is compared with the committed
//       run-data.json, snapshotAt stripped. The checkout of the router is never written.
//
//   SDLC_PREFLIGHT_STDOUT_FILE   the standard output of `gh api`: the JSON listing
//   SDLC_PREFLIGHT_EXIT_CODE     its exit code (anything but 0 is a failure)
//   SDLC_PREFLIGHT_COMMAND       the command as the manifest declares it: it names the edge, its upstream and (through the edge's commands) the capture script
//   GH_TOKEN                     the read-only installation token of the router, the only credential that a preflight sees
//   GITHUB_WORKSPACE             where the manifest is
//
//   exit 0  the snapshot is unchanged (the edge declares what that is recorded as: noopAction noop-unchanged-snapshot)
//   exit 1  drift: a newer run, or a capture that differs from the committed file
//   exit 2  it cannot be judged: the router fails the job on it. EVERY other failure is a 2 as well, including a bug of this script: a crash that left node's
//           own exit code 1 would be read as a drift, and the router would dispatch a cascade for it.
//
// This script belongs to the orchestrator repository. It imports the engine only through its public API, ai-sdlc-factory/script-kit.

import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { aiEdges, assertInstallationToken, childEnvironment, createRestClient, execute, git, isolatedClone, readManifest, repoPath, resolveApiBase, resolveIo, runAsMain } from "ai-sdlc-factory/script-kit";

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const GH_API = /^\s*gh\s+api\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;
const RUNS_PATH = /^\/?repos\/([^/\s?]+)\/([^/\s?]+)\/actions\/runs(?:\?\S*)?$/;
const CAPTURE = /(?:^|[\s;&|])node\s+("?)(\S*capture\/fetch-run-data\.mjs)\1(?=\s|$|;|&|\|)/;

/** A snapshot that cannot be judged: the verdict is 2. */
export class ClassifyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClassifyError";
  }
}

/** The ids of the `RUNS` array of a capture script: `id: <digits>` inside `const RUNS = [ ... ];`. */
export function parseRunIds(source) {
  const block = /const RUNS = \[([\s\S]*?)\n\];/.exec(String(source));
  if (!block) return [];
  return [...block[1].matchAll(/\bid:\s*(\d+)/g)].map((match) => Number(match[1]));
}

/** The JSON of a run-data file without its wall-clock timestamp. @throws {ClassifyError} */
function snapshotOf(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ClassifyError(`${label} is not JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ClassifyError(`${label} is not a JSON object`);
  const { snapshotAt, ...rest } = value;
  return rest;
}

const tailOf = ({ stdout = "", stderr = "" }) => `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");

/**
 * What the command stands for in the manifest: the AI edge that declares it, that edge's upstream, and its capture command.
 * @param {{ command: string, workspace: string, env: Record<string, string | undefined>, avoid: string[] }} input `workspace` is where the manifest is looked for first,
 *   `avoid` the directories whose own sdlc.yaml is not the orchestrator's (the downstream checkout)
 * @returns {Promise<{ edge: object, upstream: string, listing: { owner: string, name: string, apiPath: string }, capture: { command: string, script: string, dataFile: string } }>}
 * @throws {ClassifyError}
 */
export async function planSnapshot({ command, workspace, env, avoid }) {
  const ghApi = GH_API.exec(command);
  const apiPath = ghApi ? (ghApi[1] ?? ghApi[2] ?? ghApi[3]) : null;
  const named = apiPath === null ? null : RUNS_PATH.exec(apiPath);
  if (named === null) throw new ClassifyError(`'${command}' is not a listing of the workflow runs (gh api repos/<owner>/<repository>/actions/runs...), so it is not the first half of the snapshot check`);
  const [, owner, name] = named;
  const { document } = await readManifest({ cwd: workspace, env, avoid });
  const edge = aiEdges(document).find((candidate) => (candidate.preflightCommands ?? []).includes(command));
  if (edge === undefined) throw new ClassifyError(`no AI edge of the manifest declares the preflight command '${command}', so its capture script is not known`);
  if (`${owner}/${name}`.toLowerCase() !== String(edge.upstreamRepo).toLowerCase()) {
    throw new ClassifyError(`the runs listing '${command}' names ${owner}/${name}, not the upstream ${edge.upstreamRepo}`);
  }
  let capture = null;
  for (const text of [...(edge.preflightCommands ?? []), ...(edge.buildCommands ?? [])]) {
    const match = CAPTURE.exec(text);
    if (match) {
      const script = match[2].replace(/^\.\//, "");
      capture = { command: text.trim(), script, dataFile: script.replace(/capture\/fetch-run-data\.mjs$/, "content/run-data.json") };
      break;
    }
  }
  if (capture === null) throw new ClassifyError("the edge lists a runs listing but no capture command (fetch-run-data.mjs), so the recorded runs are not known");
  return { edge, upstream: edge.upstreamRepo, listing: { owner, name, apiPath }, capture };
}

/**
 * The workflow of each recorded run, and the newest recorded run of each workflow. The workflow of a run is the `workflow_id` of the run itself
 * (`GET /repos/{owner}/{repo}/actions/runs/{run_id}`, readable with the Actions read permission [F27]): the recorded runs are old, so the listing of the upstream's
 * latest runs need not hold them. The five `cd` entries of the capture script are runs of one workflow, so the bar for a `cd` run is the newest of the five.
 * @returns {Promise<Map<number, number>>} workflow_id -> the largest recorded run id of that workflow
 * @throws {ClassifyError} when a recorded run cannot be read or names no workflow: an error is never read as "no newer run"
 */
export async function newestRecordedByWorkflow({ client, upstream, recorded }) {
  const newest = new Map();
  for (const id of new Set(recorded)) {
    const response = await client.requestJson("GET", `${repoPath(upstream)}/actions/runs/${id}`, { expect: [200, 404] });
    if (response.status === 404) {
      throw new ClassifyError(`the run ${id} that the capture script records does not exist in ${upstream} (404), or the read token cannot see it, so the workflow that it belongs to is not known and newer runs cannot be told from older ones`);
    }
    const found = response.json;
    if (Number(found?.id) !== id) throw new ClassifyError(`the run ${id} of ${upstream} answered as another run (id ${found?.id ?? "none"})`);
    if (!Number.isInteger(found.workflow_id)) throw new ClassifyError(`the run ${id} of ${upstream} has no workflow_id, so the workflow that it belongs to is not known`);
    newest.set(found.workflow_id, Math.max(newest.get(found.workflow_id) ?? 0, id));
  }
  return newest;
}

/**
 * The completed runs of a listing that are newer than the newest recorded run of their own workflow. A run of a workflow that has no recorded run has no bar and is
 * not one of the runs of the script: it does not count, and the capture decides what else changed.
 * @param {object[]} runs the `workflow_runs` of the listing
 * @param {Map<number, number>} barOf workflow_id -> the largest recorded run id
 * @param {string} [upstream] named in a message
 * @returns {{ id: number, workflow: number, bar: number }[]}
 * @throws {ClassifyError} when a completed run has no integer id or no workflow_id
 */
export function newerRuns(runs, barOf, upstream = "the upstream") {
  const newer = [];
  for (const entry of runs) {
    if (entry?.status !== "completed") continue;
    if (!Number.isInteger(entry.id)) throw new ClassifyError(`a completed run in the listing of ${upstream} has no integer id`);
    if (!Number.isInteger(entry.workflow_id)) throw new ClassifyError(`a completed run ${entry.id} of ${upstream} has no workflow_id, so it cannot be compared with the recorded runs of its workflow`);
    const bar = barOf.get(entry.workflow_id);
    if (bar !== undefined && entry.id > bar) newer.push({ id: entry.id, workflow: entry.workflow_id, bar });
  }
  return newer;
}

/** The variables that a command of a preflight is bound to, beside the allowlisted ones: what the router set for the check. */
const PREFLIGHT_VARIABLES = ["GITHUB_WORKSPACE", "UPSTREAM_DIR", "TARGET_SHA", "LAST_MERGED_SHA", "GH_TOKEN"];

/**
 * @param {string[]} _argv none: everything comes from the environment that the router sets for a classifier
 * @param {object} [ioInput] `env`, `cwd` (the downstream checkout), `fs`, `fetch`, `stdout`, `stderr`, `bash` (the shell that runs the capture), `deps` (the
 *   processes that the check starts: `execute`, `isolatedClone`, `git`); a test passes fakes
 * @returns {Promise<number>} 0 the snapshot is unchanged, 1 drift, 2 it cannot be judged
 */
export async function run(_argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  const deps = { execute, isolatedClone, git, ...(ioInput.deps ?? {}) };
  const bash = ioInput.bash ?? "bash";
  try {
    const { env } = io;
    const listingFile = env.SDLC_PREFLIGHT_STDOUT_FILE;
    const command = env.SDLC_PREFLIGHT_COMMAND;
    if (!listingFile || !command || env.SDLC_PREFLIGHT_EXIT_CODE === undefined) {
      throw new ClassifyError("SDLC_PREFLIGHT_STDOUT_FILE, SDLC_PREFLIGHT_COMMAND and SDLC_PREFLIGHT_EXIT_CODE are set by the router for a classifier; they are not all set");
    }
    if (env.SDLC_PREFLIGHT_EXIT_CODE !== "0") {
      let tail = "";
      try {
        tail = env.SDLC_PREFLIGHT_STDERR_FILE ? `: ${tailOf({ stderr: io.fs.readFileSync(env.SDLC_PREFLIGHT_STDERR_FILE, "utf8") })}` : "";
      } catch {
        // only the tail of a message comes from it
      }
      throw new ClassifyError(`the runs listing '${command}' exited with ${env.SDLC_PREFLIGHT_EXIT_CODE}${tail}`);
    }
    const token = assertInstallationToken(env.GH_TOKEN ?? "", "GH_TOKEN (the read token of the router)");

    const plan = await planSnapshot({ command, workspace: io.cwd, env, avoid: [io.cwd] });
    const { upstream, capture } = plan;
    const client = createRestClient({ baseUrl: resolveApiBase(env), token, fetch: io.fetch, sleep: io.sleep, now: io.now });

    // (1) newer completed runs than the ones that the capture script records, workflow by workflow
    const scriptFile = path.join(io.cwd, ...capture.script.split("/"));
    if (!io.fs.existsSync(scriptFile)) throw new ClassifyError(`${capture.script} does not exist in the downstream checkout`);
    const recorded = parseRunIds(io.fs.readFileSync(scriptFile, "utf8"));
    if (recorded.length === 0) throw new ClassifyError(`${capture.script} records no runs (a RUNS array with ids), so newer runs cannot be told from older ones`);
    const barOf = await newestRecordedByWorkflow({ client, upstream, recorded });
    let listing;
    try {
      listing = JSON.parse(io.fs.readFileSync(listingFile, "utf8"));
    } catch (error) {
      throw new ClassifyError(`the listing of the runs of ${upstream} is not JSON: ${error.message}`);
    }
    if (!Array.isArray(listing?.workflow_runs)) throw new ClassifyError(`the runs of ${upstream} are not a list`);
    const newer = newerRuns(listing.workflow_runs, barOf, upstream);
    if (newer.length > 0) {
      const examples = newer.slice(0, 3).map((entry) => `run ${entry.id} of workflow ${entry.workflow} is newer than ${entry.bar}`).join(", ");
      io.stdout(`snapshot: ${newer.length} completed run(s) of ${upstream} are newer than the newest recorded run of their workflow (${examples}${newer.length > 3 ? ", ..." : ""})\n`);
      return 1;
    }

    // (2) the capture, in an isolated clone: the downstream checkout of the router is never written
    const clone = await deps.isolatedClone({ source: io.cwd, parent: env.RUNNER_TEMP || os.tmpdir(), environment: env, prefix: "sdlc-showcase-" });
    try {
      const bound = Object.fromEntries(PREFLIGHT_VARIABLES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
      const result = await deps.execute(bash, ["--noprofile", "--norc", "-c", capture.command], { cwd: clone.dir, env: childEnvironment(env, bound), timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.error !== null || result.code !== 0) throw new ClassifyError(`the capture '${capture.command}' failed (exit ${result.code}): ${tailOf(result)}`);
      const dataPath = path.join(clone.dir, ...capture.dataFile.split("/"));
      if (!io.fs.existsSync(dataPath)) throw new ClassifyError(`the capture wrote no ${capture.dataFile}`);
      const captured = snapshotOf(io.fs.readFileSync(dataPath, "utf8"), `the captured ${capture.dataFile}`);
      const committedText = await deps.git(["show", `HEAD:${capture.dataFile}`], { cwd: clone.dir, env: childEnvironment(env), tolerate: true });
      const committed = committedText.code === 0 ? snapshotOf(committedText.stdout, `the committed ${capture.dataFile}`) : null;
      // only the file that the capture owns is put back, and only in the clone
      await deps.git(["checkout", "--quiet", "--", capture.dataFile], { cwd: clone.dir, env: childEnvironment(env), tolerate: true });
      if (committed === null || !isDeepStrictEqual(captured, committed)) {
        io.stdout(`snapshot: ${capture.dataFile} differs from the committed file (snapshotAt aside)\n`);
        return 1;
      }
      io.stdout(`snapshot: no completed run is newer than the newest recorded run of its workflow, and ${capture.dataFile} differs only in snapshotAt\n`);
      return 0;
    } finally {
      clone.remove();
    }
  } catch (error) {
    // exit 1 is a drift: whatever goes wrong here, and whatever kind of error it is, the verdict is 2
    io.stderr(`classify-showcase-runs: ${error instanceof ClassifyError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
