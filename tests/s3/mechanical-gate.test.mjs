// The gates of the mechanical cascade, run for real (SPEC-03 AC56, AC57, AC62; the import -> commit -> pull request ordering is in mechanical-workflow.test.mjs).
// Every run: step of the rendered workflow runs in its own bash process, in the order of the workflow, against a real git repository of the downstream built from
// tests/s3/fixtures/gate/portfolio-history.json, with the lines that earlier steps appended to GITHUB_ENV as the only variables that carry over, a stub npm and a stub npx that
// record what they were asked to run, and a stand-in for jq. A step that exits non-zero ends the job, as it does on the runner: no later step runs.
//
// A test builds one job and replays scenarios in it: `reset` puts the repository back to the base and runs the pre-agent step again; `rewind` only forgets what the
// post-steps wrote, for scenarios that leave the repository as it is.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { BashSandbox } from "../s1/helpers/bash-runtime.mjs";
import { createStubBin } from "./helpers/git-world.mjs";
import { abs, fixture, presetEdges, readJson, readText, sha } from "./helpers/fixtures.mjs";
import { samePath } from "./helpers/preflight-world.mjs";

const mdText = readText(abs(".github", "workflows", "cascade-mechanical-ghec-admin.md"));
const authored = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(mdText)[1]);
const edge = presetEdges().find((entry) => entry.mode === "mechanical");
const recipe = readJson(fixture("gate", "portfolio-history.json"));
const POST_STEPS = authored["post-steps"];
const PRE_AGENT = authored["pre-agent-steps"][0].run;
const IMPORT_COMMAND = 'npm run import:ghec-admin -- "$UPSTREAM_DIR"';
const IMPORT_CHECK = "Verify the import recorded the upstream revision";
const ALLOWED_CHECK = "Verify changed paths are covered by the allowed files";
const CLEAN_CHECK = "Verify the downstream worktree is clean";
const upstreamName = edge.upstreamRepo.split("/")[1];
const PREVIOUS = sha("previous");
const UPSTREAM = sha("upstream");
const EMPTY = { BASE_SHA: "", AGENT_HEAD_SHA: "", UPSTREAM_SHA: "", PREVIOUS_SHA: "", BRANCH_NAME: "", UPSTREAM_DIR: "" };
// Git for Windows' bash rewrites an environment variable that looks like a POSIX path (a JSON pointer such as /commit) when it starts a native program; the runner of
// the workflow is Linux and does not. The variables of the edge's data are excluded from that conversion so that the host does not change what the step reads.
const HOST = { MSYS2_ENV_CONV_EXCL: "PROVENANCE_POINTER;PROVENANCE_FILE" };
const BUILD_AND_CHECKS = [...edge.buildCommands, ...edge.verifyCommands];
// The seven commands as the stub tools see them: the tool and its arguments. The browser gate is the specification that covers the pages of the import, run by npx: the full suite
// of the portfolio needs the Segoe UI font that the runner does not have (the manifest says why).
const INVOCATIONS = [
  ["npm", "run", "build"], ["npm", "run", "build:catalog"], ["npm", "run", "typecheck"], ["npm", "run", "lint"], ["npm", "test"], ["npm", "run", "test:studio"],
  ["npx", "playwright", "test", "tests/browser/sites.spec.ts"],
];

const fill = (text) => text.replaceAll("{{PREVIOUS_SHA}}", PREVIOUS).replaceAll("{{UPSTREAM_SHA}}", UPSTREAM);
const baseFiles = () => Object.fromEntries(Object.entries(recipe.base).map(([name, content]) => [name, fill(content)]));
const recorded = () => Object.fromEntries(Object.entries(recipe.recordedProvenance).map(([file, content]) => [file, fill(content)]));

/** A job: the downstream and the upstream checkouts exist and the pre-agent step has run on them. */
function job({ npmRules = [] } = {}) {
  const sandbox = new BashSandbox();
  const bin = createStubBin({ npm: { rules: [...npmRules, { match: ".*", code: 0 }] }, npx: { rules: [{ match: ".*", code: 0 }] } });
  bin.shim("jq", fixture("..", "helpers", "jq-shim.mjs"));
  const base = sandbox.revision("portfolio", baseFiles());
  const upstreamHead = sandbox.revision(`upstream/${upstreamName}`, { "README.md": "the upstream\n" });
  const pre = sandbox.run(PRE_AGENT, { UPSTREAM_SHA: UPSTREAM, PREVIOUS_SHA: PREVIOUS });
  assert.equal(pre.status, 0, pre.stderr);
  const afterPreAgent = fs.readFileSync(sandbox.envFile, "utf8");
  const j = {
    sandbox,
    bin,
    base,
    upstreamHead,
    files: baseFiles(),
    head: base,
    cleanup() {
      sandbox.cleanup();
      bin.cleanup();
    },
    /** Forgets what the post-steps wrote (the variables they appended, the artifact, the calls of npm); the repository is as it was. */
    rewind() {
      fs.writeFileSync(sandbox.envFile, afterPreAgent);
      fs.rmSync(path.join(sandbox.artifacts, "cascade-shas.json"), { force: true });
      fs.writeFileSync(path.join(sandbox.artifacts, "base-sha.txt"), `${base}\n`);
      bin.clearLog();
    },
    /** The repository as the pre-agent step found it, whatever an earlier scenario did to it, and the pre-agent step run again. */
    reset() {
      sandbox.git("portfolio", "clean", "-fdxq");
      sandbox.revision("portfolio", baseFiles());
      j.files = baseFiles();
      j.head = base;
      j.rewind();
    },
    /** The agent's commit on top of the base: the files of a recipe entry (or of `files`). */
    commit(name) {
      const entry = recipe.agentCommits[name];
      const next = { ...baseFiles(), ...Object.fromEntries(Object.entries(entry.set).map(([file, content]) => [file, fill(content)])) };
      for (const file of entry.remove ?? []) delete next[file];
      if (entry.recordsProvenance) Object.assign(next, recorded());
      return j.commitFiles(next);
    },
    commitFiles(files) {
      j.files = files;
      j.head = sandbox.revision("portfolio", files, base);
      return j.head;
    },
    /** The agent runs the import command of the prompt, from the portfolio, with the variables of the pre-agent step. */
    runImport() {
      return sandbox.run(IMPORT_COMMAND, { ...EMPTY, ...sandbox.environment(), PATH: bin.path() }, "portfolio");
    },
    /** Every step of post-steps, in order, each in its own bash. */
    runPostSteps() {
      const outcomes = [];
      for (const step of POST_STEPS) {
        if (step.uses) {
          // the runner's own action: the artifact has to exist, as if-no-files-found: error says
          const uploaded = fs.existsSync(path.join(sandbox.artifacts, "cascade-shas.json"));
          outcomes.push({ name: step.name, status: uploaded ? 0 : 1, kind: "action" });
          if (!uploaded) break;
          continue;
        }
        const env = { ...EMPTY, ...sandbox.environment(), PATH: bin.path(), ...HOST, ...(step.env ?? {}) };
        const result = sandbox.run(step.run, env, step["working-directory"] ?? "");
        outcomes.push({ name: step.name, status: result.status, stderr: result.stderr, env: sandbox.environment() });
        if (result.status !== 0) break;
      }
      return outcomes;
    },
    /** Every call of the stub npm and the stub npx, in the order in which they were made. */
    toolCalls: () => bin.log().filter((call) => call.tool === "npm" || call.tool === "npx"),
    /** The build and check commands as [tool, ...arguments]: every call but the import. */
    buildCalls: () => j.toolCalls().filter((call) => !(call.tool === "npm" && call.args[0] === "run" && call.args[1] === "import:ghec-admin")),
  };
  return j;
}

const failed = (outcomes) => outcomes.find((outcome) => outcome.status !== 0);
const withJob = (options, body) => async (t) => {
  const j = job(options);
  t.after(() => j.cleanup());
  await body(j, t);
};

// ---- AC56, AC57: the hand-off of the revisions, the gates ahead of the builds, the seven commands ---------------------------------------------------------------

test("AC56 AC57 on a clean commit confined to public/ghec-admin the post-steps all exit 0, cascade-shas.json holds the base and the head, every later step sees the variables, and the stub npm and npx saw exactly the seven commands in order", withJob({}, (j) => {
  const head = j.commit("clean-import");
  assert.equal(j.runImport().status, 0);
  const outcomes = j.runPostSteps();
  assert.equal(failed(outcomes), undefined, JSON.stringify(failed(outcomes)));
  assert.equal(outcomes.length, POST_STEPS.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(j.sandbox.artifacts, "cascade-shas.json"), "utf8")), { baseSha: j.base, headSha: head });

  // the first step appends the revisions; every step after it was handed the five variables of the pre-agent step and the two of the first step, and nothing else of the job
  const first = outcomes[0].env;
  assert.deepEqual(Object.keys(first), ["BASE_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR", "AGENT_HEAD_SHA"]);
  for (const outcome of outcomes.slice(1).filter((entry) => entry.env)) {
    for (const name of ["BASE_SHA", "AGENT_HEAD_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"]) assert.notEqual(outcome.env[name], "", `${outcome.name}: ${name}`);
  }
  assert.equal(first.BASE_SHA, j.base);
  assert.equal(first.AGENT_HEAD_SHA, head);
  assert.equal(first.UPSTREAM_SHA, UPSTREAM);
  assert.equal(first.PREVIOUS_SHA, PREVIOUS);
  assert.equal(first.BRANCH_NAME, edge.branchName);
  assert.ok(samePath(first.UPSTREAM_DIR, j.sandbox.path(`upstream/${upstreamName}`)));
  // a probe in the environment that a later step gets sees them, and a step that is given nothing sees nothing
  const env = { ...EMPTY, ...j.sandbox.environment() };
  assert.equal(j.sandbox.run('test -n "$BASE_SHA" && test -n "$AGENT_HEAD_SHA" && test -n "$UPSTREAM_SHA" && test -n "$PREVIOUS_SHA" && test -n "$BRANCH_NAME" && test -n "$UPSTREAM_DIR"', env).status, 0);
  assert.equal(j.sandbox.run('test -z "$AGENT_HEAD_SHA"', { ...EMPTY }).status, 0, "the empty variables are what a step sees when nothing was appended");

  // AC57: the seven commands, in order, in the portfolio, after the gates
  const calls = j.buildCalls();
  assert.deepEqual(calls.map((call) => [call.tool, ...call.args]), INVOCATIONS);
  for (const call of calls) assert.ok(samePath(call.cwd, j.sandbox.path("portfolio")), `${call.args.join(" ")} runs in the portfolio`);
  assert.equal(calls[1].bound.STUDIO_ORIGIN, "https://studio.example.com", "build:catalog gets the origin of the command");
  assert.deepEqual(calls.filter((call, index) => index !== 1).map((call) => call.bound.STUDIO_ORIGIN), new Array(6).fill(null));
  assert.equal(BUILD_AND_CHECKS.length, 7);
  const names = POST_STEPS.map((step) => step.name);
  assert.deepEqual(names.slice(0, 5), ["Record the base and head revisions", "Upload the cascade revisions", CLEAN_CHECK, ALLOWED_CHECK, IMPORT_CHECK]);
  assert.equal(names.indexOf(BUILD_AND_CHECKS[0]), 5, "the three verifications all come before the first build command");

  // the upstream checkout is immutable: no step of the job touched it, and it is still at the revision that the job was pinned to
  assert.equal(j.sandbox.git(`upstream/${upstreamName}`, "status", "--porcelain"), "");
  assert.equal(j.sandbox.git(`upstream/${upstreamName}`, "rev-parse", "HEAD"), j.upstreamHead);

  // deleting a file inside the allowed paths is allowed
  j.reset();
  j.commit("delete-inside");
  assert.equal(failed(j.runPostSteps()), undefined);
}));

test("AC56 a base-sha.txt that is not 40 lowercase hexadecimal characters ends the first step with exit 1, appends nothing and writes no cascade-shas.json", withJob({}, (j) => {
  j.commit("clean-import");
  for (const damaged of ["", "abc\n", `${"A".repeat(40)}\n`, `${j.base}\nINJECTED=1\n`, `${j.base.slice(0, 39)}\n`, `${j.base}0\n`]) {
    j.rewind();
    fs.writeFileSync(path.join(j.sandbox.artifacts, "base-sha.txt"), damaged);
    const appended = fs.readFileSync(j.sandbox.envFile, "utf8");
    const [first, ...later] = j.runPostSteps();
    assert.equal(first.status, 1, JSON.stringify(damaged));
    assert.equal(later.length, 0, "the job ended at its first step");
    assert.equal(fs.readFileSync(j.sandbox.envFile, "utf8"), appended, `nothing was appended for ${JSON.stringify(damaged)}`);
    assert.equal(fs.existsSync(path.join(j.sandbox.artifacts, "cascade-shas.json")), false);
    assert.equal(j.toolCalls().length, 0);
  }
}));

test("AC56 an uncommitted change in the portfolio (modified, new, outside the allowed paths or deleted) exits 1 at the clean-tree check, and no build or check command runs", withJob({}, (j) => {
  for (const [label, dirty] of [
    ["a modified tracked file", () => fs.writeFileSync(j.sandbox.path("portfolio/public/ghec-admin/index.json"), '{"revision":99}\n')],
    ["a new untracked file", () => fs.writeFileSync(j.sandbox.path("portfolio/public/ghec-admin/new.json"), "{}\n")],
    ["a file outside the allowed paths", () => fs.writeFileSync(j.sandbox.path("portfolio/stray.txt"), "left behind\n")],
    ["a deleted tracked file", () => fs.rmSync(j.sandbox.path("portfolio/keep.txt"))],
  ]) {
    j.reset();
    j.commit("clean-import");
    dirty();
    const outcomes = j.runPostSteps();
    assert.equal(failed(outcomes)?.name, CLEAN_CHECK, label);
    assert.equal(failed(outcomes).status, 1, label);
    assert.match(failed(outcomes).stderr, /worktree is not clean/, label);
    assert.equal(j.toolCalls().length, 0, `${label}: neither the stub npm nor the stub npx was called`);
  }
}));

test("AC56 a committed file outside public/ghec-admin exits 1 at the allowed-paths check and names the path; no build or check command runs", withJob({}, (j) => {
  for (const [commit, named] of [["outside-path", "src/app.ts"], ["lookalike-directory", "public/ghec-admin-evil/index.json"], ["lookalike-file", "public/ghec-admin.txt"], ["delete-outside", "src/app.ts"]]) {
    j.reset();
    j.commit(commit);
    const outcomes = j.runPostSteps();
    assert.equal(failed(outcomes)?.name, ALLOWED_CHECK, commit);
    assert.equal(failed(outcomes).status, 1, commit);
    assert.ok(failed(outcomes).stderr.includes(`path outside the allowed files: ${named}`), `${commit}: ${failed(outcomes).stderr}`);
    assert.equal(j.toolCalls().length, 0, `${commit}: neither the stub npm nor the stub npx was called`);
  }
}));

test("AC56 a file moved from outside the allowed paths into them is still a change outside them: git names only the destination of a rename unless renames are switched off", withJob({}, (j) => {
  j.commit("move-into-allowed");
  assert.equal(j.sandbox.git("portfolio", "status", "--porcelain"), "", "the move is committed");
  // the default of git: the diff names the destination only, which is allowed
  assert.equal(j.sandbox.git("portfolio", "diff", "--name-only", j.base, "HEAD").split("\n").includes("keep.txt"), false);
  const outcomes = j.runPostSteps();
  assert.equal(failed(outcomes)?.name, ALLOWED_CHECK);
  assert.ok(failed(outcomes).stderr.includes("path outside the allowed files: keep.txt"), failed(outcomes).stderr);
  assert.equal(j.toolCalls().length, 0);
}));

test("AC57 AC62 a build or check command that fails ends the post-steps with exit 1 at that command and no later command runs", withJob({}, (j) => {
  // the first build command, a check in the middle and the last check (the one that npx runs): every step is its own process, so the mechanism is the same for each of the seven
  for (const index of [0, 3, 6]) {
    const [tool, ...args] = INVOCATIONS[index];
    const invocation = INVOCATIONS[index].join(" ");
    j.reset();
    // a tool that an earlier iteration made fail answers 0 again: only this command fails
    for (const name of ["npm", "npx"]) j.bin.set(name, [{ match: ".*", code: 0 }]);
    j.bin.set(tool, [{ match: `^${args.join(" ")}$`, code: 1, stderr: "the command failed\n" }, { match: ".*", code: 0 }]);
    j.commit("clean-import");
    const outcomes = j.runPostSteps();
    assert.equal(failed(outcomes)?.name, BUILD_AND_CHECKS[index], invocation);
    assert.equal(failed(outcomes).status, 1);
    assert.deepEqual(j.buildCalls().map((call) => [call.tool, ...call.args]), INVOCATIONS.slice(0, index + 1), `${invocation}: nothing runs after it`);
  }
}));

// ---- AC62: a failed import fails the job ---------------------------------------------------------------------------------------------------------------

test("AC62 an importer that throws leaves a clean worktree and no commit; post-steps still exit 1 for each trigger, because the import recorded no upstream revision, so detection and safe_outputs do not run", withJob({}, (j) => {
  for (const failure of recipe.importerFailures) {
    j.rewind();
    j.bin.set("npm", [{ match: "^run import:ghec-admin", code: 1, stderr: failure.stderr }, { match: ".*", code: 0 }]);
    const attempt = j.runImport();
    assert.equal(attempt.status, 1, `${failure.trigger} (${failure.lines})`);
    assert.ok(attempt.stderr.includes(failure.stderr.trim()), failure.trigger);
    assert.equal(j.sandbox.git("portfolio", "status", "--porcelain"), "", `${failure.trigger}: the importer throws before its first write, so the worktree is clean`);
    assert.equal(j.sandbox.git("portfolio", "rev-parse", "HEAD"), j.base, `${failure.trigger}: and nothing was committed`);
    const outcomes = j.runPostSteps();
    assert.equal(failed(outcomes)?.status, 1, `${failure.trigger}: post-steps exit 1`);
    assert.equal(failed(outcomes).name, IMPORT_CHECK, failure.trigger);
    assert.match(failed(outcomes).stderr, new RegExp(`did not record ${UPSTREAM}`), failure.trigger);
    assert.deepEqual(j.buildCalls(), [], `${failure.trigger}: no build or check command ran`);
  }
}));

test("AC62 an import that committed something but did not record the upstream revision, or recorded another one, fails the same way", withJob({}, (j) => {
  for (const [label, provenance] of [
    ["the provenance file still names the previous revision", `{"commit":"${PREVIOUS}"}\n`],
    ["the provenance file names another revision", `{"commit":"${sha("another")}"}\n`],
    ["the provenance file has no commit", "{}\n"],
    ["the provenance file is not JSON", "not json\n"],
    ["the commit is the upstream revision in upper case", `{"commit":"${UPSTREAM.toUpperCase()}"}\n`],
  ]) {
    j.rewind();
    j.commitFiles({ ...baseFiles(), "public/ghec-admin/index.json": '{"revision":2}\n', "public/ghec-admin/source.json": provenance });
    const outcomes = j.runPostSteps();
    assert.equal(failed(outcomes)?.name, IMPORT_CHECK, label);
    assert.equal(failed(outcomes).status, 1, label);
    assert.deepEqual(j.buildCalls(), [], label);
  }
}));

test("AC62 a pointer that is not /commit selects the value that it names, and an escaped key is decoded", withJob({}, (j) => {
  // the step reads the edge's pointer from its environment: run the rendered step with another file and pointer
  const step = POST_STEPS.find((candidate) => candidate.name === IMPORT_CHECK);
  j.commitFiles({ ...baseFiles(), "public/ghec-admin/source.json": JSON.stringify({ "a/b": { "c~d": [UPSTREAM] } }) });
  const env = { ...EMPTY, ...j.sandbox.environment(), PATH: j.bin.path(), ...HOST };
  const run = (pointer) => j.sandbox.run(step.run, { ...env, PROVENANCE_FILE: "public/ghec-admin/source.json", PROVENANCE_POINTER: pointer });
  assert.equal(run("/a~1b/c~0d/0").status, 0, "an escaped key and an array index");
  assert.equal(run("/a~1b/c~0d/1").status, 1);
  assert.equal(run("/a/b").status, 1);
}));

test("AC62 no commit and an import that recorded the revision already is a success with nothing to do: the gates pass and the two revisions are equal", withJob({}, (j) => {
  // the provenance of the base already names the dispatched revision, so the import changed nothing and the agent committed nothing
  j.files = { ...baseFiles(), ...recorded() };
  j.base = j.sandbox.revision("portfolio", j.files);
  assert.equal(j.sandbox.run(PRE_AGENT, { UPSTREAM_SHA: UPSTREAM, PREVIOUS_SHA: PREVIOUS }).status, 0);
  const outcomes = j.runPostSteps();
  assert.equal(failed(outcomes), undefined, JSON.stringify(failed(outcomes)));
  const shas = JSON.parse(fs.readFileSync(path.join(j.sandbox.artifacts, "cascade-shas.json"), "utf8"));
  assert.equal(shas.baseSha, shas.headSha);
}));

// ---- AC46: what finalize_poll_state does with the artifact -----------------------------------------------------------------------------------------

test("AC46 the finalize job reads the base and the head from the artifact that the post-steps uploaded and appends them to GITHUB_ENV, and refuses a malformed one", withJob({}, (j) => {
  const head = j.commit("clean-import");
  assert.equal(failed(j.runPostSteps()), undefined);
  const exportStep = authored.jobs.finalize_poll_state.steps.find((step) => step.name === "Export the base and head revisions");
  j.sandbox.writeEnv("");
  const env = { PATH: j.bin.path() };
  const ok = j.sandbox.run(exportStep.run, env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(j.sandbox.environment(), { BASE_SHA: j.base, AGENT_HEAD_SHA: head });
  for (const damaged of [{ baseSha: "nope", headSha: head }, { baseSha: j.base, headSha: "A".repeat(40) }, { baseSha: j.base }, {}]) {
    j.sandbox.writeEnv("");
    fs.writeFileSync(path.join(j.sandbox.artifacts, "cascade-shas.json"), JSON.stringify(damaged));
    const result = j.sandbox.run(exportStep.run, env);
    assert.equal(result.status === 0, false, JSON.stringify(damaged));
    assert.equal(fs.readFileSync(j.sandbox.envFile, "utf8"), "", `nothing was appended for ${JSON.stringify(damaged)}`);
  }
}));
