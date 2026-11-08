// The edge-declared preflights of the router (SPEC-03 AC20-AC23, AC40): the checks that decide, before a cascade is dispatched, whether an upstream
// advance changed anything that the downstream depends on. They are data of the edge (preflightCommands), run with the downstream checkout as the
// working directory and the upstream checkout (at the target) bound as "$UPSTREAM_DIR"; none is run with --accept. The edge's commands are read by
// their shape:
//
//   - a command that runs the workshop source check (sync:workshop-source) prints a report. Its exit status alone decides nothing, because it exits 1
//     whenever the checked commit differs from the recorded one even when no input changed [F30]: the line `Inputs checked: <n>; changed <x>, new <y>,
//     gone <z>` and the ` PROBLEM <text>` lines decide, and a report without that line is a failure.
//   - a command that runs lab-studio-drift.mjs (contract C7 (2)(a), implemented by SPEC-04): exit 0 and no changed lab is no drift, exit 1 is drift,
//     exit 2 and anything else a failure, and a result that does not match the helper's JSON is a failure too. A missing helper is a failure, never
//     a drift or a clean result.
//   - a `gh api repos/<upstream>/actions/runs...` listing is the first half of the snapshot check: it is read by the router itself with the read
//     token (a GET), and compared with the runs that the capture script of the downstream records. The second half runs the edge's capture command
//     (fetch-run-data.mjs) in an isolated clone of the downstream checkout and compares what it wrote with the committed file, snapshotAt stripped.
//   - any other command is a plain check by its exit status: 0 no difference, 1 a difference, anything else a failure (git diff --quiet).
//
// The router never changes the downstream checkout that it made: the capture runs in a temporary clone, and only the file that it owns is restored there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { childEnvironment, ensureCheckout, execute, git, isolatedClone, toShellPath } from "./git.mjs";
import { encodePath, repoPath } from "./rest.mjs";
import { splitSlug } from "./edges.mjs";

/** The file that the studio helper's contract names: its provenance is logged beside the edge's own (AC14) and never decides. */
export const STUDIO_PROVENANCE = Object.freeze({ file: "apps/lab-studio/lab-sources.json", pointer: "/_provenance/commit" });

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

/** A preflight that cannot decide: the router job fails and writes nothing (AC20, AC23, AC28). */
export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightError";
  }
}

/** `<checkout>` in a command is the absolute path of the upstream checkout. */
export const fillCheckout = (command) => String(command).split("<checkout>").join('"$UPSTREAM_DIR"');

const GH_API = /^\s*gh\s+api\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;
const RUNS_PATH = /^\/?repos\/([^/\s?]+)\/([^/\s?]+)\/actions\/runs(?:\?\S*)?$/;
const CAPTURE = /(?:^|[\s;&|])node\s+("?)(\S*capture\/fetch-run-data\.mjs)\1(?=\s|$|;|&|\|)/;

/** How the commands of an edge's preflight are read. */
export function planPreflight(edge) {
  const commands = edge.preflightCommands.map((text, index) => {
    const ghApi = GH_API.exec(text);
    const apiPath = ghApi ? (ghApi[1] ?? ghApi[2] ?? ghApi[3]) : null;
    let kind = "plain";
    if (/\bsync:workshop-source\b/.test(text)) kind = "workshop-report";
    else if (/\blab-studio-drift\.mjs\b/.test(text)) kind = "studio-drift";
    else if (apiPath !== null && RUNS_PATH.test(apiPath)) kind = "runs-list";
    return { index, text, kind, apiPath: kind === "runs-list" ? apiPath : null };
  });
  let capture = null;
  for (const text of [...edge.preflightCommands, ...edge.buildCommands]) {
    const match = CAPTURE.exec(text);
    if (match) {
      const script = match[2].replace(/^\.\//, "");
      capture = { command: text.trim(), script, dataFile: script.replace(/capture\/fetch-run-data\.mjs$/, "content/run-data.json") };
      break;
    }
  }
  return {
    commands,
    capture,
    lab: commands.some((entry) => entry.kind === "workshop-report" || entry.kind === "studio-drift"),
    runs: commands.some((entry) => entry.kind === "runs-list"),
  };
}

/** The report of the workshop source check: { checked, changed, added, removed, problems }. @throws {PreflightError} when its summary line is absent */
export function parseWorkshopReport(stdout) {
  const summary = [...String(stdout).matchAll(/^Inputs checked: (\d+); changed (\d+), new (\d+), gone (\d+)[ \t]*$/gm)];
  if (summary.length === 0) throw new PreflightError("the workshop source check printed no 'Inputs checked: <n>; changed <x>, new <y>, gone <z>' line, so its result cannot be classified");
  if (summary.length > 1) throw new PreflightError("the workshop source check printed more than one 'Inputs checked' line, so its result is ambiguous");
  const [, checked, changed, added, removed] = summary[0].map(Number);
  const problems = [...String(stdout).matchAll(/^[ \t]*PROBLEM[ \t]+(.*\S)[ \t]*$/gm)].map((match) => match[1]);
  return { checked, changed, added, removed, problems };
}

/** The JSON of the studio helper: { status, previousCommit, targetCommit, changedLabs }. @throws {PreflightError} when it is not that */
export function parseStudioResult(stdout) {
  const text = String(stdout).trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    for (let start = lines.length - 1; start >= 0 && value === undefined; start -= 1) {
      if (!lines[start].trimStart().startsWith("{")) continue;
      try {
        value = JSON.parse(lines.slice(start).join("\n"));
      } catch {
        value = undefined;
      }
    }
  }
  const ok =
    value !== null &&
    typeof value === "object" &&
    ["in-sync", "drift", "accepted"].includes(value.status) &&
    typeof value.previousCommit === "string" &&
    typeof value.targetCommit === "string" &&
    Array.isArray(value.changedLabs) &&
    value.changedLabs.every((lab) => typeof lab === "string");
  if (!ok) throw new PreflightError("the studio drift helper did not print the JSON { status, previousCommit, targetCommit, changedLabs }");
  return value;
}

/** The ids of the `RUNS` array of a capture script: `id: <digits>` inside `const RUNS = [ ... ];`. */
export function parseRunIds(source) {
  const block = /const RUNS = \[([\s\S]*?)\n\];/.exec(String(source));
  if (!block) return [];
  return [...block[1].matchAll(/\bid:\s*(\d+)/g)].map((match) => Number(match[1]));
}

/** The JSON of a run-data file without its wall-clock timestamp. @throws {PreflightError} */
function snapshotOf(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PreflightError(`${label} is not JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PreflightError(`${label} is not a JSON object`);
  const { snapshotAt, ...rest } = value;
  return rest;
}

const tailOf = (result) => `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");

/**
 * The sync_scope that a dispatch carries, within what the edge's workflow accepts.
 * @param {string | null} wanted the scope that the preflight outcome names
 * @param {string[] | undefined} allowed the edge's syncScopes (undefined: every scope is accepted)
 */
export function chooseSyncScope(wanted, allowed) {
  const scope = wanted ?? "both";
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(scope)) return scope;
  return allowed.includes("both") ? "both" : allowed[0];
}

/**
 * @param {object} ctx
 * @param {object} ctx.edge the router edge
 * @param {object | undefined} ctx.manifestEdge the same edge as sdlc.yaml has it (syncScopes), when there is one
 * @param {string} ctx.targetSha
 * @param {string} ctx.lastMergedSha
 * @param {string} ctx.downstreamSha the head of the downstream's default branch that was read
 * @param {string} ctx.workspace GITHUB_WORKSPACE
 * @param {string} ctx.serverUrl
 * @param {Record<string, string | undefined>} ctx.environment the environment of the router (only allowlisted variables reach a child)
 * @param {(slug: string) => string} ctx.readTokenFor
 * @param {(slug: string) => ReturnType<typeof import("./rest.mjs").createRestClient>} ctx.readClientFor
 * @param {string} [ctx.bash]
 * @param {(line: string) => void} ctx.log
 * @returns {Promise<{ drift: boolean, scope: string | null, noopAction: string | null, summary: string }>}
 * @throws {PreflightError | import("./git.mjs").CheckoutError | RoutingDataError}
 */
export async function runPreflight(ctx) {
  const { edge, log } = ctx;
  // the processes that a preflight starts; a test may replace them to exercise the classification without a shell
  const deps = { ensureCheckout, execute, isolatedClone, git, ...(ctx.deps ?? {}) };
  const plan = planPreflight(edge);
  if (plan.commands.length === 0) {
    return { drift: true, scope: chooseSyncScope(null, ctx.manifestEdge?.syncScopes), noopAction: null, summary: "the edge declares no preflight" };
  }
  const downstreamName = splitSlug(edge.downstreamRepo).repo;
  const upstreamName = splitSlug(edge.upstreamRepo).repo;
  const downstreamDir = path.join(ctx.workspace, downstreamName);
  const upstreamDir = path.join(ctx.workspace, "upstream", upstreamName);
  const bash = ctx.bash ?? "bash";
  const readToken = ctx.readTokenFor(edge.upstreamRepo);

  let upstreamReady = false;
  const referencesLastMerged = plan.commands.some((entry) => entry.text.includes("LAST_MERGED_SHA"));
  const prepareUpstream = async () => {
    if (upstreamReady) return;
    await deps.ensureCheckout({
      dir: upstreamDir,
      serverUrl: ctx.serverUrl,
      slug: edge.upstreamRepo,
      sha: ctx.targetSha,
      branch: edge.upstreamDefaultBranch,
      // a command that compares two commits needs the history that holds both; the others read the tree of the target
      history: referencesLastMerged ? "full" : "shallow",
      mustContain: referencesLastMerged ? [ctx.lastMergedSha] : [],
      token: readToken,
      environment: ctx.environment,
    });
    upstreamReady = true;
  };
  let downstreamReady = false;
  const prepareDownstream = async () => {
    if (downstreamReady) return;
    await deps.ensureCheckout({
      dir: downstreamDir,
      serverUrl: ctx.serverUrl,
      slug: edge.downstreamRepo,
      sha: ctx.downstreamSha,
      token: ctx.readTokenFor(edge.downstreamRepo),
      environment: ctx.environment,
    });
    downstreamReady = true;
    if (plan.commands.some((entry) => /^\s*(npm|npx)\s/.test(entry.text))) {
      // the downstream's own scripts need its dependencies; lifecycle scripts of a dependency never run in the router
      const install = await deps.execute(bash, ["--noprofile", "--norc", "-c", "npm ci --include=dev --ignore-scripts"], {
        cwd: downstreamDir,
        env: commandEnvironment(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (install.error !== null || install.code !== 0) throw new PreflightError(`installing the dependencies of ${edge.downstreamRepo} failed (exit ${install.code}): ${tailOf(install)}`);
    }
  };
  const commandEnvironment = () =>
    childEnvironment(ctx.environment, {
      GITHUB_WORKSPACE: toShellPath(ctx.workspace),
      UPSTREAM_DIR: toShellPath(upstreamDir),
      TARGET_SHA: ctx.targetSha,
      LAST_MERGED_SHA: ctx.lastMergedSha,
      GH_TOKEN: readToken,
    });
  const runShell = (command, cwd) => deps.execute(bash, ["--noprofile", "--norc", "-c", fillCheckout(command)], { cwd, env: commandEnvironment(), timeoutMs: COMMAND_TIMEOUT_MS });

  const findings = [];
  let drift = false;
  let workshopDirty = false;
  let studioDirty = false;
  let snapshotDrift = false;

  // the commands that run in the downstream checkout run first, in the order that the edge lists them, all of them before any is judged;
  // a git command compares commits of the upstream checkout and runs in the workspace, every other command in the downstream checkout
  const runsInWorkspace = (entry) => /^\s*git\s/.test(entry.text);
  const checked = plan.commands.filter((entry) => entry.kind !== "runs-list");
  if (checked.length > 0) await prepareUpstream();
  if (checked.some((entry) => !runsInWorkspace(entry))) await prepareDownstream();
  const outcomes = [];
  for (const entry of checked) {
    log(`preflight: ${entry.text}`);
    const result = await runShell(entry.text, runsInWorkspace(entry) ? ctx.workspace : downstreamDir);
    outcomes.push({ entry, result });
  }

  for (const { entry, result } of outcomes) {
    if (result.error !== null && result.code === null) throw new PreflightError(`the preflight command '${entry.text}' could not be run: ${result.error}`);
    if (result.timedOut) throw new PreflightError(`the preflight command '${entry.text}' did not finish in ${COMMAND_TIMEOUT_MS / 60000} minutes`);
    if (entry.kind === "workshop-report") {
      if (result.code !== 0 && result.code !== 1) throw new PreflightError(`'${entry.text}' exited with ${result.code}: ${tailOf(result)}`);
      const report = parseWorkshopReport(result.stdout);
      workshopDirty = report.changed + report.added + report.removed + report.problems.length > 0;
      findings.push(`workshop source check: ${report.checked} inputs, changed ${report.changed}, new ${report.added}, gone ${report.removed}, ${report.problems.length} problems (exit ${result.code})`);
    } else if (entry.kind === "studio-drift") {
      if (result.code === 2) throw new PreflightError(`'${entry.text}' exited with 2, a fatal error of the studio drift helper: ${tailOf(result)}`);
      if (result.code !== 0 && result.code !== 1) throw new PreflightError(`'${entry.text}' exited with ${result.code}: ${tailOf(result)}`);
      const studio = parseStudioResult(result.stdout);
      if (result.code === 0 && (studio.status !== "in-sync" || studio.changedLabs.length > 0)) {
        throw new PreflightError(`the studio drift helper exited 0 but reported status '${studio.status}' and ${studio.changedLabs.length} changed labs`);
      }
      if (result.code === 1 && studio.status !== "drift") throw new PreflightError(`the studio drift helper exited 1 but reported status '${studio.status}'`);
      studioDirty = result.code === 1;
      findings.push(`studio drift helper: ${studio.status}, ${studio.changedLabs.length} changed labs (exit ${result.code})`);
    } else {
      if (result.code !== 0 && result.code !== 1) throw new PreflightError(`'${entry.text}' exited with ${result.code}: ${tailOf(result)}`);
      if (result.code === 1) drift = true;
      findings.push(`check '${entry.text}': exit ${result.code}`);
    }
  }

  if (plan.runs) {
    const verdict = await snapshotCheck({ ctx, deps, plan, downstreamDir, runShell, prepareDownstreamClone: prepareDownstream });
    snapshotDrift = verdict.drift;
    findings.push(verdict.summary);
  }

  const anyDrift = drift || workshopDirty || studioDirty || snapshotDrift;
  const labScope = workshopDirty && studioDirty ? "both" : workshopDirty ? "workshop-only" : studioDirty ? "studio-only" : null;
  const wanted = plan.lab ? labScope : plan.runs ? "showcase-runs" : "github-intermediate";
  const summary = findings.join("; ");
  if (anyDrift) return { drift: true, scope: chooseSyncScope(wanted, ctx.manifestEdge?.syncScopes), noopAction: null, summary };
  if (edge.onCommitOnlyAdvance === "bump-provenance") {
    return { drift: true, scope: chooseSyncScope(plan.lab ? "both" : wanted, ctx.manifestEdge?.syncScopes), noopAction: null, summary: `${summary}; a commit-only advance is bumped into the provenance (onCommitOnlyAdvance)` };
  }
  return { drift: false, scope: null, noopAction: plan.runs ? "noop-unchanged-snapshot" : "noop-no-material-drift", summary };
}

/**
 * The snapshot check of the showcase edge: newer completed runs than the ones that the capture script records, then the capture itself.
 * @returns {Promise<{ drift: boolean, summary: string }>}
 */
async function snapshotCheck({ ctx, deps, plan, downstreamDir, runShell, prepareDownstreamClone }) {
  const { edge, log } = ctx;
  const listing = plan.commands.find((entry) => entry.kind === "runs-list");
  const [, owner, name] = RUNS_PATH.exec(listing.apiPath);
  if (`${owner}/${name}`.toLowerCase() !== edge.upstreamRepo.toLowerCase()) {
    throw new PreflightError(`the runs listing '${listing.text}' names ${owner}/${name}, not the upstream ${edge.upstreamRepo}`);
  }
  const upstreamClient = ctx.readClientFor(edge.upstreamRepo);
  const downstreamClient = ctx.readClientFor(edge.downstreamRepo);

  // (1) newer completed runs than the ones that the capture script records
  if (plan.capture === null) throw new PreflightError("the edge lists a runs listing but no capture command (fetch-run-data.mjs), so the recorded runs are not known");
  const scriptResponse = await downstreamClient.requestJson("GET", `${repoPath(edge.downstreamRepo)}/contents/${encodePath(plan.capture.script)}?ref=${ctx.downstreamSha}`, { expect: [200, 404] });
  if (scriptResponse.status === 404) throw new PreflightError(`${plan.capture.script} does not exist in ${edge.downstreamRepo} at ${ctx.downstreamSha}`);
  const scriptJson = scriptResponse.json;
  if (scriptJson?.type !== "file" || scriptJson?.encoding !== "base64" || typeof scriptJson?.content !== "string") {
    throw new PreflightError(`${plan.capture.script} is not a file that the contents API returned as base64`);
  }
  const recorded = parseRunIds(Buffer.from(scriptJson.content.replace(/\s+/g, ""), "base64").toString("utf8"));
  if (recorded.length === 0) throw new PreflightError(`${plan.capture.script} records no runs (a RUNS array with ids), so newer runs cannot be told from older ones`);
  const newest = Math.max(...recorded);
  const runsResponse = await upstreamClient.requestJson("GET", `/${listing.apiPath.replace(/^\//, "")}`, { expect: [200] });
  const runs = runsResponse.json?.workflow_runs;
  if (!Array.isArray(runs)) throw new PreflightError(`the runs of ${edge.upstreamRepo} are not a list`);
  const newer = runs.filter((run) => run?.status === "completed" && Number(run?.id) > newest);
  if (newer.length > 0) {
    return { drift: true, summary: `snapshot: ${newer.length} completed run(s) of ${edge.upstreamRepo} are newer than the ${recorded.length} recorded (newest recorded ${newest})` };
  }

  // (2) the capture, in an isolated clone: the downstream checkout of the router is never written
  await prepareDownstreamClone();
  const clone = await deps.isolatedClone({ source: downstreamDir, parent: ctx.environment.RUNNER_TEMP || os.tmpdir(), environment: ctx.environment, prefix: "sdlc-showcase-" });
  try {
    log(`preflight: ${plan.capture.command}`);
    const result = await runShell(plan.capture.command, clone.dir);
    if (result.error !== null || result.code !== 0) throw new PreflightError(`the capture '${plan.capture.command}' failed (exit ${result.code}): ${tailOf(result)}`);
    const dataPath = path.join(clone.dir, ...plan.capture.dataFile.split("/"));
    if (!fs.existsSync(dataPath)) throw new PreflightError(`the capture wrote no ${plan.capture.dataFile}`);
    const captured = snapshotOf(fs.readFileSync(dataPath, "utf8"), `the captured ${plan.capture.dataFile}`);
    const committedText = await deps.git(["show", `HEAD:${plan.capture.dataFile}`], { cwd: clone.dir, env: childEnvironment(ctx.environment), tolerate: true });
    const committed = committedText.code === 0 ? snapshotOf(committedText.stdout, `the committed ${plan.capture.dataFile}`) : null;
    // only the file that the capture owns is put back, and only in the clone
    await deps.git(["checkout", "--quiet", "--", plan.capture.dataFile], { cwd: clone.dir, env: childEnvironment(ctx.environment), tolerate: true });
    if (committed === null || !isDeepStrictEqual(captured, committed)) {
      return { drift: true, summary: `snapshot: ${plan.capture.dataFile} differs from the committed file (snapshotAt aside)` };
    }
    return { drift: false, summary: `snapshot: no newer completed run and ${plan.capture.dataFile} differs only in snapshotAt` };
  } finally {
    clone.remove();
  }
}
