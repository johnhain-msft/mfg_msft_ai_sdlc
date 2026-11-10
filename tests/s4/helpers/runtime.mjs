// A dispatched run of one AI adaptation workflow, executed for real in bash against local git checkouts: the rendered pre-agent-steps, the commands of the prompt (what
// the agent is told to run) and the rendered post-steps. `gh` and `npm` are stand-ins on PATH (a read-only gh that answers the GETs of the workflows from files, an npm that
// records the commands and does what the portfolio's scripts do to the files that matter); everything else is the real thing: bash, git, node and the helper commands.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BashSandbox } from "../../s1/helpers/bash-runtime.mjs";
import { abs, commitAll, git, installVitestStub, labUpstream, passingReport, portfolioMin, readText, tempDir, writeFiles } from "./fixtures.mjs";
import { DOWNSTREAM, edgeOf, workflowOf } from "./workflows.mjs";

const forward = (value) => value.replace(/\\/g, "/");
const WINDOWS = process.platform === "win32";
export const IDENTITY = { GIT_AUTHOR_NAME: "S4 Agent", GIT_AUTHOR_EMAIL: "agent@example.invalid", GIT_COMMITTER_NAME: "S4 Agent", GIT_COMMITTER_EMAIL: "agent@example.invalid" };

const GH = `#!/usr/bin/env bash
# a read-only gh for the runtime tests: it logs every call, refuses every write, and answers the GETs that the workflows make from files that the test supplies
printf '%s\\n' "gh $*" >> "$STUB_LOG"
if [ "\${1:-}" != "api" ]; then echo "stub gh: not available: $*" >&2; exit 97; fi
for argument in "$@"; do
  case "$argument" in
    -X|--method|--method=*|-f|-F|--field|--raw-field|--input) echo "WRITE gh $*" >> "$STUB_LOG"; echo "stub gh: a write is refused" >&2; exit 98 ;;
  esac
done
case "\${2:-}" in
  repos/*/pulls\\?*) cat "$STUB_PULL" ;;
  repos/*/actions/runs\\?*) cat "$STUB_RUNS" ;;
  *) echo "stub gh: unexpected request \${2:-}" >&2; exit 97 ;;
esac
`;

const NPM = `#!/usr/bin/env bash
# an npm for the runtime tests: it logs the command, can be told to fail one, and does to the files what the portfolio's scripts do
printf '%s\\n' "npm $*" >> "$STUB_LOG"
if [ -n "\${STUB_NPM_FAIL:-}" ] && [ "$*" = "$STUB_NPM_FAIL" ]; then echo "stub npm: $* fails on purpose" >&2; exit "\${STUB_NPM_FAIL_RC:-1}"; fi
case "$*" in
  "run sync:workshop-source -- "*" --accept") node "$STUB_DIR/accept.mjs" ;;
  "run sync:workshop-source -- "*) cat "$STUB_WORKSHOP_REPORT"; exit "\${STUB_WORKSHOP_RC:-0}" ;;
  "run build:workshop") node "$STUB_DIR/build-workshop.mjs" ;;
  "run build:experiences"|"run build"|"run build:catalog"|"run typecheck"|"run lint"|"test"|"run test:studio"|"run test:browser") : ;;
  *) echo "stub npm: unexpected command: $*" >&2; exit 97 ;;
esac
`;

const NPX = `#!/usr/bin/env bash
# an npx for the runtime tests: it logs the command and can be told to fail one
printf '%s\\n' "npx $*" >> "$STUB_LOG"
if [ -n "\${STUB_NPX_FAIL:-}" ] && [ "$*" = "$STUB_NPX_FAIL" ]; then echo "stub npx: $* fails on purpose" >&2; exit "\${STUB_NPX_FAIL_RC:-1}"; fi
case "$*" in
  "playwright test tests/browser/sites.spec.ts") : ;;
  *) echo "stub npx: unexpected command: $*" >&2; exit 97 ;;
esac
`;

const ACCEPT = `import fs from "node:fs";
const sha = process.env.UPSTREAM_SHA;
for (const [file, fields] of [["experiences/copilot-workshop/provenance.json", ["commit", "documentCommit"]], ["experiences/copilot-workshop/source-inputs.json", ["commit"]]]) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of fields) document[field] = sha;
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + "\\n");
}
`;

const BUILD_WORKSHOP = `import fs from "node:fs";
const { commit, documentCommit } = JSON.parse(fs.readFileSync("experiences/copilot-workshop/provenance.json", "utf8"));
const file = "public/workshop/source.json";
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.mkdirSync("public/workshop", { recursive: true });
fs.writeFileSync(file, JSON.stringify({ ...existing, commit, documentCommit }, null, 2) + "\\n");
`;

/** The ten dispatch inputs of a run (strings, as the dispatch API carries them), with the values that a test overrides. */
export function dispatchInputs(spec, overrides = {}) {
  return {
    correlation_id: "run-5001-1",
    upstream_repo: spec.upstreamRepo,
    previous_sha: "",
    upstream_sha: "",
    upstream_etag: '"etag-1"',
    upstream_pr_number: "86",
    downstream_repo: DOWNSTREAM,
    sync_scope: spec.scopes[0],
    on_commit_only_advance: "noop",
    dry_run: "",
    ...overrides,
  };
}

/** Replaces the `${{ inputs.x }}`, `${{ github.token }}` and `${{ secrets.x }}` of a step's env with the values of the run. */
function resolveEnv(env, inputs) {
  const resolved = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    resolved[name] = String(value).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression) => {
      if (expression.startsWith("inputs.")) {
        const key = expression.slice("inputs.".length);
        if (!Object.hasOwn(inputs, key)) throw new Error(`the dispatch carries no input ${key}`);
        return inputs[key];
      }
      if (expression === "github.token" || expression.startsWith("secrets.") || expression === "steps.app_token.outputs.token") return "stub-token";
      throw new Error(`this runtime cannot resolve \${{ ${expression} }}`);
    });
  }
  return resolved;
}

/**
 * Brings the portfolio to the state that the last merged cascade leaves: every literal of the fixture's revision, in its long and its short form, is `previousSha`, and the
 * studio manifest records the labs of the upstream checkout (which is at `previousSha`), as the studio's own accept command writes it. The result is committed.
 */
function alignPortfolio(portfolio, upstream, previousSha) {
  const recorded = "2108ac9a1e9eff96e97b500117b0de4a546768c3";
  for (const file of git(portfolio, ["ls-files"]).stdout.split("\n").filter(Boolean)) {
    const target = path.join(portfolio, ...file.split("/"));
    const text = fs.readFileSync(target, "utf8");
    const next = text.split(recorded).join(previousSha).split(recorded.slice(0, 7)).join(previousSha.slice(0, 7));
    if (next !== text) fs.writeFileSync(target, next);
  }
  const accepted = spawnSync(process.execPath, [abs("src", "lab-studio-drift.mjs"), "--portfolio", portfolio, "--upstream", upstream, "--commit", previousSha, "--accept"], {
    cwd: abs("."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: abs(".") },
  });
  if (accepted.status !== 0) throw new Error(`the studio manifest of the fixture could not be accepted: ${accepted.stdout}${accepted.stderr}`);
  git(portfolio, ["config", "user.email", "fixture@example.invalid"]);
  git(portfolio, ["config", "user.name", "S4 Fixture"]);
  commitAll(portfolio, "the portfolio at the last merged revision");
}

const templates = new Map();
/**
 * The two checkouts of a run, built once for each kind of upstream change and copied for every run (a copy of a copy is cheap; starting git and node is not): the
 * portfolio at the last merged revision (a git work tree, with a Vitest stand-in under node_modules, which git ignores) and the upstream checkout with the previous
 * and the target commit.
 */
function template(labChanged) {
  if (!templates.has(labChanged)) {
    const root = tempDir("sdlc-s4-run-template-");
    const portfolio = path.join(root, "portfolio");
    fs.cpSync(portfolioMin().dir, portfolio, { recursive: true });
    const upstream = path.join(root, "upstream");
    fs.cpSync(labUpstream(), upstream, { recursive: true });
    git(upstream, ["init", "-q"]);
    git(upstream, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(upstream, ["config", "core.autocrlf", "false"]);
    const previousSha = commitAll(upstream, "previous");
    // the portfolio as the last merged cascade left it: every pin of the revision is previous_sha, and the studio manifest records the labs as they are at previous_sha
    alignPortfolio(portfolio, upstream, previousSha);
    const baseSha = git(portfolio, ["rev-parse", "HEAD"]).stdout.trim();
    const labs = path.join(upstream, "labs", "lab05.md");
    if (labChanged) fs.writeFileSync(labs, `${fs.readFileSync(labs, "utf8")}\nA new paragraph in lab 5.\n`);
    else {
      fs.mkdirSync(path.join(upstream, "docs"), { recursive: true });
      fs.writeFileSync(path.join(upstream, "docs", "changelog.md"), "Only the changelog changed.\n");
    }
    const upstreamSha = commitAll(upstream, "target");
    templates.set(labChanged, { portfolio, upstream, previousSha, baseSha, upstreamSha });
  }
  return templates.get(labChanged);
}

/**
 * @param {object} spec one of AI of helpers/workflows.mjs
 * @param {object} [options]
 * @param {boolean} [options.labChanged] the upstream change touches labs/lab05.md (a drift for the Studio manifest); false: only docs/changelog.md changes
 * @param {object} [options.inputs] overrides of the dispatch inputs
 * @param {string} [options.pull] the first open pull request for the branch as the stub gh answers it (JSON text), default null
 * @param {string} [options.runs] the actions runs response of the stub gh
 * @param {string} [options.workshopReport] the text that the stub npm prints for the workshop source check
 * @param {number} [options.workshopRc] its exit code
 */
export function createRun(spec, options = {}) {
  const box = new BashSandbox();
  const stubs = path.join(box.root, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  const log = path.join(box.root, "stub-log.txt");
  fs.writeFileSync(log, "");
  for (const [name, text] of [["gh", GH], ["npm", NPM], ["npx", NPX]]) {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, text);
    if (!WINDOWS) fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(stubs, "accept.mjs"), ACCEPT);
  fs.writeFileSync(path.join(stubs, "build-workshop.mjs"), BUILD_WORKSHOP);
  fs.writeFileSync(path.join(box.root, "pull.json"), options.pull ?? "null\n");
  fs.writeFileSync(path.join(box.root, "runs.json"), options.runs ?? '{"total_count":2,"workflow_runs":[{"id":39781079785},{"id":39781079636}]}\n');
  fs.writeFileSync(path.join(box.root, "workshop-report.txt"), options.workshopReport ?? "Source revision: stub\nInputs checked: 3; changed 0, new 0, gone 0\n");

  // the orchestrator checkout at $GITHUB_WORKSPACE: the preset and the commands that the steps run from src/
  fs.cpSync(abs("src"), path.join(box.work, "src"), { recursive: true });
  fs.copyFileSync(abs("sdlc.yaml"), path.join(box.work, "sdlc.yaml"));

  // the downstream checkout and the upstream checkout (full history, at upstream_sha, containing previous_sha)
  const { portfolio: portfolioTemplate, upstream: upstreamTemplate, previousSha, baseSha, upstreamSha } = template(options.labChanged ?? true);
  const portfolio = path.join(box.work, "portfolio");
  fs.cpSync(portfolioTemplate, portfolio, { recursive: true });
  installVitestStub(portfolio, passingReport(edgeOf(spec).immutableGates.lockedTestBlocks));
  const upstream = path.join(box.work, "upstream", spec.repo);
  fs.mkdirSync(path.dirname(upstream), { recursive: true });
  fs.cpSync(upstreamTemplate, upstream, { recursive: true });

  const inputs = dispatchInputs(spec, { previous_sha: previousSha, upstream_sha: upstreamSha, ...(options.inputs ?? {}) });
  const frontmatter = workflowOf(spec).frontmatter;
  const edge = edgeOf(spec);

  const run = {
    spec,
    edge,
    box,
    inputs,
    frontmatter,
    portfolio,
    upstream,
    baseSha,
    previousSha,
    upstreamSha,
    workspace: box.work,
    log,
    /** The environment of a step: the run's own, the stand-ins, the lines that earlier steps appended to GITHUB_ENV, then the step's. */
    env(step = {}, extra = {}) {
      return {
        PATH: `${forward(stubs)}${WINDOWS ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`,
        Path: `${forward(stubs)}${WINDOWS ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`,
        STUB_DIR: forward(stubs),
        STUB_LOG: forward(log),
        STUB_PULL: forward(path.join(box.root, "pull.json")),
        STUB_RUNS: forward(path.join(box.root, "runs.json")),
        STUB_WORKSHOP_REPORT: forward(path.join(box.root, "workshop-report.txt")),
        STUB_WORKSHOP_RC: String(options.workshopRc ?? 0),
        GH_TOKEN: "stub-token",
        ...IDENTITY,
        ...box.environment(),
        ...resolveEnv(step.env, inputs),
        ...extra,
      };
    },
    /** Runs one rendered step (a `run:` step of the frontmatter) in its own bash process, in its working directory. */
    step(step, extra = {}) {
      if (typeof step.run !== "string") throw new Error(`step '${step.name}' has no run`);
      return box.run(step.run, run.env(step, extra), step["working-directory"] ?? "");
    },
    /** Runs a script (not a step) from a directory of the workspace. */
    script(text, extra = {}, directory = "") {
      return box.run(text, run.env({}, extra), directory);
    },
    pre: () => frontmatter["pre-agent-steps"],
    post: () => frontmatter["post-steps"],
    /** The post-steps in order, each in its own bash process fed only by the GITHUB_ENV lines of the earlier steps; an action (a `uses:` step) is skipped; stops at the first failure. */
    runPost(extra = {}) {
      const results = [];
      for (const step of run.post()) {
        if (typeof step.run !== "string") {
          results.push({ name: step.name ?? step.uses, skipped: true, status: 0, stdout: "", stderr: "" });
          continue;
        }
        const result = run.step(step, extra);
        results.push({ name: step.name, status: result.status, stdout: result.stdout, stderr: result.stderr });
        if (result.status !== 0) break;
      }
      return results;
    },
    /** What the agent does after reading the evidence: the commands of its prompt, run from the workspace with the environment that the pre-agent-steps exported. */
    agentRuns(extra = {}) {
      return run.script(promptBlock(workflowOf(spec).body), extra);
    },
    /** The four pre-agent steps in order; stops at the first one that fails. @returns {{ name: string, status: number, stderr: string }[]} */
    runPre(extra = {}) {
      const results = [];
      for (const step of run.pre()) {
        const result = run.step(step, extra);
        results.push({ name: step.name, status: result.status, stdout: result.stdout, stderr: result.stderr });
        if (result.status !== 0) break;
      }
      return results;
    },
    artifact: (name) => box.readArtifact(`agent/${name}`),
    hasArtifact: (name) => fs.existsSync(path.join(box.artifacts, "agent", name)),
    porcelain: () => git(portfolio, ["status", "--porcelain", "--untracked-files=all"]).stdout,
    upstreamPorcelain: () => git(upstream, ["status", "--porcelain", "--untracked-files=all"]).stdout,
    head: () => git(portfolio, ["rev-parse", "HEAD"]).stdout.trim(),
    /** What the stand-ins were asked, one line per call. */
    calls: () => readText(log).split("\n").filter((line) => line !== ""),
    /** The commands of the prompt's fenced bash block: what the agent is told to run, in order. */
    promptCommands: () => promptBlock(workflowOf(spec).body),
    cleanup: () => box.cleanup(),
  };
  return run;
}

/** The commands of the first fenced bash block of a prompt, as one script. */
export function promptBlock(body) {
  const match = /```bash\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("the prompt has no fenced bash block");
  return match[1];
}

/** A file written into the portfolio checkout of a run and committed: the state that an agent's commit leaves. */
export function commitInPortfolio(run, files, message = "the agent's commit") {
  writeFiles(run.portfolio, files);
  git(run.portfolio, ["config", "user.email", "agent@example.invalid"]);
  git(run.portfolio, ["config", "user.name", "S4 Agent"]);
  return commitAll(run.portfolio, message);
}

/** The environment lines that a step appended to GITHUB_ENV, as an object. */
export const exported = (run) => run.box.environment();

export { spawnSync };
