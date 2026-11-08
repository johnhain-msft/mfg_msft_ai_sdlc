// The world of a preflight test: real git remotes for the upstream and the downstream, the stub executables that the edge's commands call, the stub studio
// helper in the workspace, and the router wired to the in-process REST stub whose heads are the real commits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitWorld, createStubBin, findBash, hostEnvironment } from "./git-world.mjs";
import { routerWorld } from "./harness.mjs";
import { edge as edgeFixture, fixture, readJson, readText, sha, state } from "./fixtures.mjs";

const comparable = (value) => {
  let text = String(value).replace(/\\/g, "/");
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(text);
  if (drive) text = `${drive[1]}:/${drive[2]}`;
  text = text.replace(/\/+$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
};
/** True when two spellings (C:\x, c:/x, /c/x) name the same path. */
export const samePath = (a, b) => comparable(a) === comparable(b);

export const LAB_COMMANDS = [
  "npm run sync:workshop-source -- <checkout>",
  'node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream <checkout> --commit "$TARGET_SHA"',
];

export const CLEAN_REPORT = "Source revision: abc\nInputs checked: 25; changed 0, new 0, gone 0\nThe content matches the inputs.\n";
export const CHANGED_REPORT = "Source revision: abc\nInputs checked: 25; changed 2, new 0, gone 1\n changed: labs/lab03.md -> re-read M3\nThe content was written against different inputs.\n";
export const PROBLEM_REPORT = "Source revision: abc\nInputs checked: 25; changed 0, new 0, gone 0\n PROBLEM anchor: lab07 cites a heading that is gone\n";
export const IN_SYNC = { status: "in-sync", previousCommit: "a".repeat(40), targetCommit: "b".repeat(40), changedLabs: [] };
export const DRIFT = { status: "drift", previousCommit: "a".repeat(40), targetCommit: "b".repeat(40), changedLabs: ["lab03", "lab07"] };

/**
 * What the stub studio helper does. A result of contract C7 (2)(a) ({ status, previousCommit, targetCommit, changedLabs }) is printed as it is and the exit code is
 * the contract's (1 for drift, 0 otherwise); an object with `code`, `stdout` or `stderr` says exactly what to do, for the helper that misbehaves.
 */
export function helperScript(drift) {
  if (["code", "stdout", "stderr"].some((key) => Object.hasOwn(drift, key))) return drift;
  return { code: drift.status === "drift" ? 1 : 0, stdout: drift };
}

/**
 * @param {object} spec
 * @param {object} spec.edge the router edge (its repositories name the git remotes)
 * @param {Record<string, string>[]} spec.upstreamCommits the file sets of the upstream's commits, in order; the first is the merge cursor, the last the head
 * @param {Record<string, string>} [spec.downstreamFiles] the files of the downstream's head commit
 * @param {(shas: string[]) => object} [spec.stateOverrides]
 * @param {object[]} [spec.npm] rules of the stub npm (default: a clean workshop report for `run sync:workshop-source`, success for `ci`)
 * @param {object | null} [spec.drift] what the stub studio helper answers; null leaves the workspace without the helper
 * @param {object} [spec.rest] fields for the REST stub's upstream repository (runList, runs)
 * @param {object} [spec.downstreamRest] fields for the REST stub's downstream repository (files)
 * @param {number} [spec.headIndex] which of the upstream commits the REST side reports as the head (default: the last)
 * @param {string} [spec.workspacePrefix]
 */
export function createPreflightWorld(spec) {
  const git = createGitWorld();
  const edge = spec.edge;
  const upstreamShas = spec.upstreamCommits.map((files, index) => git.commit(edge.upstreamRepo, files, `upstream ${index}`));
  const upstreamHead = upstreamShas[spec.headIndex ?? upstreamShas.length - 1];
  const downstreamSha = git.commit(edge.downstreamRepo, spec.downstreamFiles ?? { "README.md": "the downstream\n" }, "downstream main");
  const bin = createStubBin({
    npm: {
      rules: spec.npm ?? [
        { match: "^ci", code: 0 },
        { match: "^run sync:workshop-source", code: 0, stdout: CLEAN_REPORT },
      ],
    },
  });
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-runner-temp-"));
  const state0 = state({ lastMergedUpstreamSha: upstreamShas[0], lastObservedHeadSha: upstreamShas[0], portfolioMainSha: downstreamSha, ...(spec.stateOverrides?.(upstreamShas) ?? {}) }, edge);
  const w = routerWorld({
    edge,
    state: state0,
    upstream: { head: upstreamHead, defaultBranch: edge.upstreamDefaultBranch, ...(spec.rest ?? {}) },
    downstream: { head: downstreamSha, ...(spec.downstreamRest ?? {}) },
    workspacePrefix: spec.workspacePrefix,
    env: { ...hostEnvironment(), ...git.environment(), PATH: bin.path(), RUNNER_TEMP: runnerTemp },
    ...(spec.worldOptions ?? {}),
  });
  const driftDir = path.join(w.workspace.dir, "src");
  if (spec.drift !== null && spec.drift !== undefined) {
    fs.mkdirSync(driftDir, { recursive: true });
    fs.copyFileSync(fixture("helpers", "lab-studio-drift.stub.mjs"), path.join(driftDir, "lab-studio-drift.mjs"));
    fs.writeFileSync(path.join(driftDir, "lab-studio-drift.stub.json"), JSON.stringify(helperScript(spec.drift)));
  }
  const bash = findBash();
  const world = {
    w,
    git,
    bin,
    edge,
    upstreamShas,
    upstreamHead,
    downstreamSha,
    runnerTemp,
    bash,
    upstreamDir: path.join(w.workspace.dir, "upstream", edge.upstreamRepo.split("/")[1]),
    portfolioDir: path.join(w.workspace.dir, edge.downstreamRepo.split("/")[1]),
    go: (extra = {}) => w.go({ bash, ...extra }),
    driftCalls() {
      const file = path.join(driftDir, "lab-studio-drift.log.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    leftoverClones: () => fs.readdirSync(runnerTemp).filter((name) => name.startsWith("sdlc-showcase-")),
    cleanup() {
      w.cleanup();
      git.cleanup();
      bin.cleanup();
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    },
  };
  return world;
}

/** A synthetic edge for a preflight test: the downstream is named `portfolio` as the commands of the preset expect. */
export const preflightEdge = (overrides = {}) =>
  edgeFixture({
    edgeId: "lab",
    upstreamRepo: "initech/lab",
    upstreamKey: "lab",
    upstreamSlug: "LAB",
    upstreamDefaultBranch: "main",
    downstreamRepo: "acme/portfolio",
    stateVariable: "SDLC_SYNC_STATE_LAB",
    provenanceFile: "experiences/copilot-workshop/source-inputs.json",
    branchName: "sdlc/cascade-lab",
    closeOlderKey: "sdlc-cascade-lab",
    preflightCommands: LAB_COMMANDS,
    ...overrides,
  });

export const labFiles = (n) => ({ "labs/lab01.md": `lab 1 revision ${n}\n`, "README.md": `readme ${n}\n` });

// ---- the showcase edge: the runs listing, the capture script and the committed snapshot of the downstream ------------------------------------------

export const SHOWCASE_SCRIPT = "experiences/pipeline-showcase/capture/fetch-run-data.mjs";
export const SHOWCASE_ANSWER = "experiences/pipeline-showcase/capture/answer.json";
export const SHOWCASE_DATA = "experiences/pipeline-showcase/content/run-data.json";
/** The eleven run ids of the capture script (SPEC-03 F24); the largest is the newest that the downstream records. */
export const RECORDED_RUN_IDS = [39781079785, 39781079636, 39780778851, 39780778886, 40446543496, 40573274820, 39443641702, 39440423127, 39445050929, 39449984245, 39781079595];
export const NEWEST_RECORDED_RUN = Math.max(...RECORDED_RUN_IDS);
export const actionsRun = (id, status = "completed") => ({ id, status, conclusion: status === "completed" ? "success" : null, name: "ci" });

export const showcaseEdge = (overrides = {}) =>
  preflightEdge({
    edgeId: "pipeline-showcase",
    upstreamRepo: "initech/showcase",
    upstreamKey: "pipeline-showcase",
    upstreamSlug: "PIPELINE_SHOWCASE",
    stateVariable: "SDLC_SYNC_STATE_PIPELINE_SHOWCASE",
    provenanceFile: "experiences/pipeline-showcase/content/provenance.json",
    branchName: "sdlc/cascade-pipeline-showcase",
    closeOlderKey: "sdlc-cascade-pipeline-showcase",
    preflightCommands: ['gh api "repos/initech/showcase/actions/runs?per_page=100"'],
    buildCommands: [`node ${SHOWCASE_SCRIPT}`, "npm run build:experiences"],
    ...overrides,
  });

const asJsonText = (value) => (typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);

/**
 * @param {object} [spec]
 * @param {object | string} [spec.answer] what the capture writes (default: tests/s3/fixtures/showcase/answer.json)
 * @param {object | string | null} [spec.committed] the committed run-data.json of the downstream (null: there is none)
 * @param {object[]} [spec.runList] the completed and running runs that the upstream lists (default: the eleven recorded ones)
 * @param {object} [spec.edge] overrides of the edge
 * @param {string} [spec.script] the capture script (default: the fixture)
 * @param {object} [spec.extra] more of createPreflightWorld's fields
 */
export function createShowcaseWorld(spec = {}) {
  const edge = showcaseEdge(spec.edge ?? {});
  const script = spec.script ?? readText(fixture("showcase", "fetch-run-data.fixture.mjs"));
  const files = {
    [SHOWCASE_SCRIPT]: script,
    [SHOWCASE_ANSWER]: asJsonText(spec.answer ?? readText(fixture("showcase", "answer.json"))),
    // the real downstream's content directory also holds provenance.json, so it exists whether or not run-data.json has been committed
    "experiences/pipeline-showcase/content/README.md": "the content of the showcase\n",
  };
  if (spec.committed !== null) files[SHOWCASE_DATA] = asJsonText(spec.committed ?? readText(fixture("showcase", "run-data.json")));
  return createPreflightWorld({
    edge,
    upstreamCommits: [{ "README.md": "showcase 1\n" }, { "README.md": "showcase 2\n" }],
    downstreamFiles: files,
    downstreamRest: { files: { [SHOWCASE_SCRIPT]: script } },
    rest: { runList: spec.runList ?? RECORDED_RUN_IDS.map((id) => actionsRun(id)) },
    worldOptions: { manifestEdges: [{ ...edge, syncScopes: ["showcase-runs"] }] },
    ...(spec.extra ?? {}),
  });
}

// ---- the intermediate edge: a git diff of the curriculum paths between the merge cursor and the target ----------------------------------------------

export const intermediateEdge = (overrides = {}) =>
  preflightEdge({
    edgeId: "github-intermediate",
    upstreamRepo: "initech/template",
    upstreamKey: "github-intermediate",
    upstreamSlug: "GITHUB_INTERMEDIATE",
    stateVariable: "SDLC_SYNC_STATE_GITHUB_INTERMEDIATE",
    provenanceFile: "experiences/github-intermediate-labs/provenance.json",
    branchName: "sdlc/cascade-github-intermediate",
    closeOlderKey: "sdlc-cascade-github-intermediate",
    preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- labs solutions src style index.html README.md'],
    buildCommands: ["npm run build:experiences"],
    ...overrides,
  });

/** The commits of tests/s3/fixtures/git/intermediate-history.json by name, in order. */
export const INTERMEDIATE_COMMITS = readJson(fixture("git", "intermediate-history.json")).commits.map((commit) => commit.name);

/**
 * @param {object} [spec]
 * @param {string} [spec.lastMerged] the commit (by name) that the merge cursor is at (default: baseline)
 * @param {string} [spec.target] the commit (by name) that the upstream's head is at
 * @param {object} [spec.edge] overrides of the edge
 * @param {object} [spec.extra] more of createPreflightWorld's fields
 */
export function createIntermediateWorld(spec = {}) {
  const history = readJson(fixture("git", "intermediate-history.json"));
  const names = history.commits.map((commit) => commit.name);
  const edge = intermediateEdge(spec.edge ?? {});
  const at = (name) => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`no commit named ${name} in the history fixture`);
    return index;
  };
  return createPreflightWorld({
    edge,
    upstreamCommits: history.commits.map((commit) => commit.files),
    headIndex: at(spec.target ?? names.at(-1)),
    stateOverrides: (shas) => ({ lastMergedUpstreamSha: shas[at(spec.lastMerged ?? "baseline")], lastObservedHeadSha: shas[at(spec.lastMerged ?? "baseline")] }),
    worldOptions: { manifestEdges: [{ ...edge, syncScopes: ["github-intermediate"] }] },
    ...(spec.extra ?? {}),
  });
}
export { sha };
