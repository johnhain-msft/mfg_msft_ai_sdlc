// AC20, AC66, AC68, AC69, AC72 and AC77: the rendered post-steps of the three AI workflows, executed in bash on local checkouts. Each step runs in its own bash process, fed
// only by the GITHUB_ENV lines of the steps before it, exactly as the runner does; the helper commands are the real ones, npm is a recording stand-in.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, readText, writeFiles } from "./helpers/fixtures.mjs";
import { commitInPortfolio, createRun } from "./helpers/runtime.mjs";
import { AI, edgeOf, workflowOf } from "./helpers/workflows.mjs";

const [LAB, SHOWCASE] = AI;
const postOf = (spec) => workflowOf(spec).frontmatter["post-steps"];
const named = (spec, pattern) => postOf(spec).find((step) => pattern.test(String(step.name ?? "")));
const HELPER = (spec) => `node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow ${spec.id}`;
const TEN = [
  "npm run build:workshop",
  "npm run build:experiences",
  'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain',
  "npm run build",
  "STUDIO_ORIGIN=https://studio.example.com npm run build:catalog",
  "npm run typecheck",
  "npm run lint",
  "npm test",
  "npm run test:studio",
  "npm run test:browser",
];
const PROVENANCE_CHECK = /committed provenance records upstream_sha/;

/** A run whose pre-agent-steps have run and whose agent has done the deterministic sequence of its prompt: a provenance bump, committed. */
function bumped(spec, options = {}) {
  const run = createRun(spec, { labChanged: false, inputs: { on_commit_only_advance: "bump-provenance" }, ...options });
  assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], `${spec.id}: the pre-agent-steps`);
  const agent = run.agentRuns();
  assert.equal(agent.status, 0, `${spec.id}: ${agent.stdout}${agent.stderr}`);
  return run;
}
/** A run whose agent has done nothing: the pre-agent-steps only. */
function idle(spec, options = {}) {
  const run = createRun(spec, { labChanged: false, ...options });
  assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], `${spec.id}: the pre-agent-steps`);
  return run;
}
/** The first post-step (the revision hand-off), which a later step needs; it records the head of the moment. */
function handOff(run) {
  const result = run.step(run.post()[0]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
/** One named post-step, run after the hand-off (so that it sees the head as it is now). */
function check(run, spec, pattern, extra = {}) {
  handOff(run);
  const step = named(spec, pattern);
  assert.ok(step, `${spec.id}: a post-step named ${pattern}`);
  return run.step(step, extra);
}
const showJson = (run, file) => JSON.parse(git(run.portfolio, ["show", `HEAD:${file}`]).stdout);

test("AC68: the post-steps are the hand-off step, the artifact upload, the helper, the ten commands and then the post-run checks, in that order, for every workflow", () => {
  for (const spec of AI) {
    const steps = postOf(spec);
    const [first, upload, helper, ...rest] = steps;
    assert.ok(first.run.includes('BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"'), spec.id);
    assert.ok(first.run.includes('[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]') && first.run.includes("exit 1"), `${spec.id}: BASE_SHA must be 40 lowercase hex before it is appended`);
    assert.ok(first.run.includes(`AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"`), spec.id);
    assert.ok(first.run.includes('{"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}'), spec.id);
    assert.ok(first.run.includes('{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"'), spec.id);
    assert.deepEqual(upload, { name: "Upload the cascade revisions", uses: "actions/upload-artifact@v4", with: { name: "sdlc-cascade-shas-${{ github.run_id }}", path: "/tmp/gh-aw/cascade-shas.json", "if-no-files-found": "error" } }, spec.id);
    assert.equal(helper.run, HELPER(spec), `${spec.id}: the helper, with the workflow's id`);
    rest.slice(0, 10).forEach((step, index) => {
      if (TEN[index].includes("status --porcelain")) assert.ok(step.run.includes(TEN[index]) && step.run.includes("exit 1"), `${spec.id}: the clean-tree check`);
      else assert.equal(step.run, TEN[index], `${spec.id}: command ${index + 1}`);
    });
    const checks = rest.slice(10);
    assert.equal(checks.length, edgeOf(spec).verifyCommands.length - 10, `${spec.id}: the post-run checks follow the thirteenth`);
    for (const step of checks) assert.match(step.name, /^post-run check: /);
    assert.match(checks.at(-1).name, /the upstream checkout stays read-only/, `${spec.id}: the upstream check is the last (AC77)`);
  }
});

test("AC68: a full run: every post-step passes after a provenance bump, each one in its own bash process, and the six variables are set in every step after the first without being ambient", () => {
  for (const spec of AI) {
    const run = bumped(spec);
    try {
      const results = run.runPost();
      assert.deepEqual(results.map((result) => result.status), results.map(() => 0), `${spec.id}: ${JSON.stringify(results.filter((result) => result.status !== 0))}`);
      assert.equal(results.length, postOf(spec).length, `${spec.id}: every step ran`);
      const env = run.box.environment();
      for (const name of ["BASE_SHA", "AGENT_HEAD_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"]) assert.ok(env[name], `${spec.id}: ${name} is in the GITHUB_ENV lines`);
      assert.equal(env.AGENT_HEAD_SHA, run.head());
      assert.notEqual(env.AGENT_HEAD_SHA, env.BASE_SHA);
      assert.deepEqual(JSON.parse(readText(path.join(run.box.artifacts, "cascade-shas.json"))), { baseSha: run.baseSha, headSha: run.head() }, `${spec.id}: cascade-shas.json`);
      const npm = run.calls().filter((line) => line.startsWith("npm "));
      for (const expected of ["npm run test:browser", "npm run typecheck", "npm run lint", "npm test", "npm run test:studio", "npm run build:catalog"]) assert.ok(npm.includes(expected), `${spec.id}: ${expected} ran`);
    } finally {
      run.cleanup();
    }
  }
  // not ambient: a process that is not fed the GITHUB_ENV lines does not see them (the rendered steps would fail on an unbound variable)
  const run = idle(LAB);
  try {
    const names = ["BASE_SHA", "AGENT_HEAD_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"];
    const bare = run.script(names.map((name) => `printf '%s=[%s]\\n' ${name} "\${${name}-unset}"`).join("\n"), Object.fromEntries(names.map((name) => [name, undefined])));
    assert.equal(bare.status, 0, bare.stderr);
    const check = run.box.environment();
    assert.ok(names.filter((name) => name !== "AGENT_HEAD_SHA").every((name) => check[name]), "the pre-agent-steps exported what the later steps read");
    assert.equal(check.AGENT_HEAD_SHA, undefined, "AGENT_HEAD_SHA exists only after the hand-off step");
  } finally {
    run.cleanup();
  }
});

test("AC68: a base-sha.txt that is not 40 lowercase hexadecimal characters exits 1 and appends nothing to GITHUB_ENV", () => {
  const run = idle(LAB);
  try {
    const before = fs.readFileSync(run.box.envFile, "utf8");
    for (const damaged of ["abc123\n", `${run.baseSha.toUpperCase()}\n`, `${run.baseSha}\nINJECTED=yes\n`, ""]) {
      fs.writeFileSync(path.join(run.box.artifacts, "base-sha.txt"), damaged);
      const result = run.step(run.post()[0]);
      assert.equal(result.status, 1, JSON.stringify(damaged));
      assert.match(result.stderr, /base-sha\.txt must hold 40 lowercase hexadecimal characters/);
      assert.equal(fs.readFileSync(run.box.envFile, "utf8"), before, `${JSON.stringify(damaged)}: nothing was appended`);
      assert.equal(fs.existsSync(path.join(run.box.artifacts, "cascade-shas.json")), false, "and no hand-off file was written");
    }
  } finally {
    run.cleanup();
  }
});

test("AC68/AC72: a stale bundle (a provenance bump committed without the rebuilt public files) fails the clean-tree check that follows the rebuild", () => {
  const run = idle(LAB);
  try {
    const provenance = showJson(run, "experiences/copilot-workshop/provenance.json");
    commitInPortfolio(run, { "experiences/copilot-workshop/provenance.json": `${JSON.stringify({ ...provenance, commit: run.upstreamSha, documentCommit: run.upstreamSha }, null, 2)}\n` });
    const results = run.runPost();
    const failed = results.at(-1);
    assert.equal(failed.status, 1, JSON.stringify(results.map((result) => [result.name, result.status])));
    assert.match(failed.name, /status --porcelain/);
    assert.match(failed.stderr, /worktree is not clean:\n M public\/workshop\/source\.json/);
  } finally {
    run.cleanup();
  }
});

test("AC20: the helper step is the exact command of each workflow, and an edit to a locked file makes it exit 1, names the file and stops the post-steps there", () => {
  for (const spec of AI) {
    assert.equal(named(spec, /verify-immutable-gates/).run, HELPER(spec), spec.id);
    const dirty = bumped(spec);
    try {
      commitInPortfolio(dirty, { "src/server.ts": `${readText(path.join(dirty.portfolio, "src", "server.ts"))}\n// an agent edit\n` });
      const results = dirty.runPost();
      const last = results.at(-1);
      assert.equal(last.status, 1, JSON.stringify(results.map((result) => [result.name, result.status])));
      assert.match(last.name, /verify-immutable-gates/);
      assert.match(last.stdout, /"status":"violation"/);
      assert.match(last.stdout, /"src\/server\.ts"/);
      assert.equal(results.length, 3, `${spec.id}: the hand-off, the upload and the helper ran, and nothing after the failed helper`);
    } finally {
      dirty.cleanup();
    }
  }
});

test("AC72: every trigger of a gate failure exits non-zero in post-steps: a failing typecheck, lint, test, test:studio or test:browser, and a dirty worktree", () => {
  const run = bumped(LAB);
  try {
    handOff(run);
    for (const command of ["run typecheck", "run lint", "test", "run test:studio", "run test:browser"]) {
      const step = postOf(LAB).find((candidate) => candidate.run === `npm ${command}`);
      assert.ok(step, command);
      assert.equal(run.step(step).status, 0, `${command} passes when nothing fails`);
      const result = run.step(step, { STUB_NPM_FAIL: command, STUB_NPM_FAIL_RC: "3" });
      assert.equal(result.status, 3, `${command}: ${result.stderr}`);
    }
    fs.writeFileSync(path.join(run.portfolio, "README.md"), "uncommitted\n");
    const status = postOf(LAB).find((step) => String(step.run ?? "").includes("status --porcelain") && String(step.run).includes("exit 1"));
    assert.equal(run.step(status).status, 1);
  } finally {
    run.cleanup();
  }
});

test("AC66: the showcase workflow exits 1 when the ids of RUNS changed but run-data.json is identical to its base version, and 0 when both changed (and when neither did)", () => {
  const edit = (text) => text.replace("id: 39781079785", "id: 39781079999");
  const script = "experiences/pipeline-showcase/capture/fetch-run-data.mjs";
  const data = "experiences/pipeline-showcase/content/run-data.json";
  const step = /a changed RUNS list needs a re-captured run-data\.json/;
  const run = bumped(SHOWCASE);
  try {
    assert.equal(check(run, SHOWCASE, step).status, 0, "no change of RUNS");
    commitInPortfolio(run, { [script]: edit(readText(path.join(run.portfolio, script))) });
    const stale = check(run, SHOWCASE, step);
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /RUNS ids changed but run-data\.json was not re-captured/);
    commitInPortfolio(run, { [data]: `${JSON.stringify({ runs: [{ key: "ci", id: 39781079999 }] }, null, 2)}\n` });
    assert.equal(check(run, SHOWCASE, step).status, 0, "both changed");
  } finally {
    run.cleanup();
  }
});

test("AC69: the copilot-lab check exits 1 for an unparseable provenance.json, a commit left at the old revision, a stale _provenance.commit and a Studio manifest that has drifted, and 0 for a complete bump", () => {
  const run = bumped(LAB);
  try {
    assert.equal(check(run, LAB, PROVENANCE_CHECK).status, 0, "a complete bump");
    const good = showJson(run, "experiences/copilot-workshop/provenance.json");

    commitInPortfolio(run, { "experiences/copilot-workshop/provenance.json": "{ not json" });
    const unparseable = check(run, LAB, PROVENANCE_CHECK);
    assert.equal(unparseable.status, 1);
    assert.match(unparseable.stderr, /provenance file is missing or unparseable/);

    commitInPortfolio(run, { "experiences/copilot-workshop/provenance.json": `${JSON.stringify({ ...good, commit: run.previousSha, documentCommit: run.previousSha }, null, 2)}\n` });
    const old = check(run, LAB, PROVENANCE_CHECK);
    assert.equal(old.status, 1);
    assert.match(old.stderr, /stale provenance: provenance\.json commit, provenance\.json documentCommit/);

    commitInPortfolio(run, { "experiences/copilot-workshop/provenance.json": `${JSON.stringify(good, null, 2)}\n` });
    assert.equal(check(run, LAB, PROVENANCE_CHECK).status, 0, "restored");
    const manifest = showJson(run, "apps/lab-studio/lab-sources.json");
    commitInPortfolio(run, { "apps/lab-studio/lab-sources.json": `${JSON.stringify({ ...manifest, _provenance: { ...manifest._provenance, commit: run.previousSha } }, null, 2)}\n` });
    const stale = check(run, LAB, PROVENANCE_CHECK);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale provenance: lab-sources\.json _provenance\.commit/);

    commitInPortfolio(run, { "apps/lab-studio/lab-sources.json": `${JSON.stringify(manifest, null, 2)}\n` });
    assert.equal(check(run, LAB, PROVENANCE_CHECK).status, 0, "restored again");
    // the labs moved on after the manifest was accepted: the studio drift command exits 1, so the check does
    writeFiles(run.upstream, { "labs/lab07.md": `${readText(path.join(run.upstream, "labs", "lab07.md"))}\nChanged after the accept.\n` });
    const drifted = check(run, LAB, PROVENANCE_CHECK);
    assert.equal(drifted.status, 1, drifted.stdout + drifted.stderr);
    assert.match(drifted.stdout, /"status":"drift"/);
  } finally {
    run.cleanup();
  }
});

test("AC69: the showcase and intermediate checks require the exact provenance object, and pass for it", () => {
  for (const spec of AI.slice(1)) {
    const run = bumped(spec);
    try {
      assert.equal(check(run, spec, PROVENANCE_CHECK).status, 0, `${spec.id}: the exact object`);
      for (const [label, content] of [
        ["an unparseable file", "{ nope"],
        ["the old commit", JSON.stringify({ repository: spec.upstreamRepo, commit: run.previousSha }, null, 2)],
        ["an extra key", JSON.stringify({ repository: spec.upstreamRepo, commit: run.upstreamSha, extra: true }, null, 2)],
        ["another repository", JSON.stringify({ repository: "someone/else", commit: run.upstreamSha }, null, 2)],
      ]) {
        commitInPortfolio(run, { [spec.provenanceFile]: `${content}\n` });
        assert.equal(check(run, spec, PROVENANCE_CHECK).status, 1, `${spec.id}: ${label}`);
      }
      commitInPortfolio(run, { [spec.provenanceFile]: `${JSON.stringify({ repository: spec.upstreamRepo, commit: run.upstreamSha }, null, 2)}\n` });
      assert.equal(check(run, spec, PROVENANCE_CHECK).status, 0, `${spec.id}: restored`);
    } finally {
      run.cleanup();
    }
  }
});

test("AC69: when the agent committed nothing (AGENT_HEAD_SHA == BASE_SHA) the provenance check does not run its comparison", () => {
  for (const spec of AI) {
    const run = idle(spec);
    try {
      assert.equal(check(run, spec, PROVENANCE_CHECK).status, 0, spec.id);
    } finally {
      run.cleanup();
    }
  }
});

test("AC77: the upstream checkout must print nothing for git status at the end: a dirtied checkout exits 1, a clean one exits 0, and the check is the last step", () => {
  for (const spec of AI) {
    assert.match(postOf(spec).at(-1).name, /the upstream checkout stays read-only/, spec.id);
    const run = idle(spec);
    try {
      handOff(run);
      const step = postOf(spec).at(-1);
      assert.equal(run.step(step).status, 0, `${spec.id}: clean`);
      fs.writeFileSync(path.join(run.upstream, "labs", "lab01.md"), "an edit in the upstream checkout\n");
      assert.equal(run.step(step).status, 1, `${spec.id}: an edited file`);
      git(run.upstream, ["checkout", "--", "labs/lab01.md"]);
      fs.writeFileSync(path.join(run.upstream, "stray.txt"), "an untracked file\n");
      assert.equal(run.step(step).status, 1, `${spec.id}: an untracked file`);
      fs.rmSync(path.join(run.upstream, "stray.txt"));
      writeFiles(run.upstream, { ".github/workflows/x.lock.yml": "recompiled: true\n" });
      assert.equal(run.step(step).status, 1, `${spec.id}: a recompiled lock file`);
    } finally {
      run.cleanup();
    }
  }
});
