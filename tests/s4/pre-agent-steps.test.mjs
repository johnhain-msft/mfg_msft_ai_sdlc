// AC8, AC9, AC24 (the validation step), AC56, AC57, AC58, AC59 and AC64: the rendered pre-agent-steps, executed in bash against local git checkouts with a read-only gh.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { abs, fixture, git, readText } from "./helpers/fixtures.mjs";
import { createRun, dispatchInputs } from "./helpers/runtime.mjs";
import { AI, workflowOf } from "./helpers/workflows.mjs";

const LAB = AI[0];
const SHOWCASE = AI[1];
const INTERMEDIATE = AI[2];
const drift = (name) => readText(fixture("workshop-drift", name));
const FIVE = ["BASE_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"];
const writes = (run) => run.calls().filter((line) => line.startsWith("WRITE"));

test("AC8/AC24: the validation step passes for the dispatch of the run, and exits 2 when the upstream checkout is at the wrong commit or lacks previous_sha (a shallow clone)", () => {
  for (const spec of AI) {
    const run = createRun(spec);
    try {
      const [validate] = run.pre();
      const ok = run.step(validate);
      assert.equal(ok.status, 0, `${spec.id}: ${ok.stderr}`);
      assert.match(run.box.environment().DRY_RUN ?? "x", /^$/, "DRY_RUN is exported, empty for an empty input");
      // the wrong commit
      git(run.upstream, ["checkout", "-q", "--detach", run.previousSha]);
      const wrong = run.step(validate);
      assert.equal(wrong.status, 2, `${spec.id}: ${wrong.stderr}`);
      assert.match(wrong.stderr, /not at upstream_sha/);
      // a shallow clone of the right commit: previous_sha is not in it
      git(run.upstream, ["checkout", "-q", "--detach", run.upstreamSha]);
      const shallow = path.join(path.dirname(run.upstream), "shallow");
      git(path.dirname(run.upstream), ["clone", "-q", "--depth", "1", `file:///${run.upstream.replace(/\\/g, "/")}`, shallow]);
      fs.rmSync(run.upstream, { recursive: true, force: true });
      fs.renameSync(shallow, run.upstream);
      assert.equal(git(run.upstream, ["rev-parse", "HEAD"]).stdout.trim(), run.upstreamSha);
      const missing = run.step(validate);
      assert.equal(missing.status, 2, `${spec.id}: ${missing.stderr}`);
      assert.equal(run.porcelain(), "", "and nothing was written to the portfolio");
    } finally {
      run.cleanup();
    }
  }
});

test("AC9/AC56: the four steps leave the portfolio clean at BASE_SHA, write base-sha.txt and the five GITHUB_ENV lines, and a later bash process sees all five", () => {
  for (const spec of AI) {
    const run = createRun(spec);
    try {
      const results = run.runPre();
      assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0], `${spec.id}: ${JSON.stringify(results.map((result) => result.stderr))}`);
      assert.equal(run.porcelain(), "", `${spec.id}: git status --porcelain prints nothing`);
      assert.equal(run.head(), run.baseSha, `${spec.id}: HEAD is BASE_SHA`);
      assert.equal(run.upstreamPorcelain(), "", `${spec.id}: the upstream checkout is untouched`);
      assert.equal(run.box.readArtifact("base-sha.txt"), `${run.baseSha}\n`, `${spec.id}: base-sha.txt holds the sha alone, newline-terminated`);
      const env = run.box.environment();
      assert.equal(env.BASE_SHA, run.baseSha);
      assert.equal(env.UPSTREAM_SHA, run.upstreamSha);
      assert.equal(env.PREVIOUS_SHA, run.previousSha);
      assert.equal(env.BRANCH_NAME, spec.branchName);
      assert.ok(env.UPSTREAM_DIR.endsWith(`/upstream/${spec.repo}`), env.UPSTREAM_DIR);
      const seen = run.script(FIVE.map((name) => `printf '%s=%s\\n' ${name} "$${name}"`).join("\n"));
      assert.equal(seen.status, 0, seen.stderr);
      for (const name of FIVE) assert.match(seen.stdout, new RegExp(`^${name}=.+$`, "m"), `${spec.id}: ${name} is non-empty in a later bash process`);
    } finally {
      run.cleanup();
    }
  }
});

test("AC56/AC29: upstream-diff.txt, dispatch-inputs.json (the ten inputs verbatim) and existing-pr.json are written for the agent, and the only gh request is a GET", () => {
  for (const spec of AI) {
    const open = { number: 42, html_url: "https://example.invalid/pull/42", head: { sha: "f".repeat(40) } };
    for (const pull of [undefined, JSON.stringify(open)]) {
      const run = createRun(spec, { pull });
      try {
        assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
        const diff = git(run.upstream, ["diff", "--name-status", run.previousSha, run.upstreamSha]).stdout;
        assert.equal(run.artifact("upstream-diff.txt"), diff, `${spec.id}: the name-status diff of previous_sha..upstream_sha`);
        assert.ok(diff.includes("labs/lab05.md"));
        assert.deepEqual(JSON.parse(run.artifact("dispatch-inputs.json")), run.inputs, `${spec.id}: the ten inputs, verbatim`);
        assert.equal(Object.keys(JSON.parse(run.artifact("dispatch-inputs.json"))).length, 10);
        assert.deepEqual(JSON.parse(run.artifact("existing-pr.json")), pull === undefined ? null : open, `${spec.id}: the open pull request, or null`);
        const calls = run.calls().filter((line) => line.startsWith("gh "));
        assert.ok(calls.some((line) => line.includes(`pulls?state=open&head=johnhain-msft:${spec.branchName}`)), `${spec.id}: ${calls.join(" | ")}`);
        assert.deepEqual(writes(run), [], `${spec.id}: no write request`);
      } finally {
        run.cleanup();
      }
    }
  }
});

test("AC57: the capture hook of the copilot-lab workflow runs the workshop source check and the studio drift command against the upstream checkout, and both reports land in the artifact directory", () => {
  const run = createRun(LAB, { workshopReport: drift("drift.txt"), workshopRc: 1 });
  try {
    assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], "an expected drift report passes through");
    assert.equal(run.artifact("workshop-drift.txt"), drift("drift.txt"));
    assert.equal(run.artifact("preflight-1.txt"), drift("drift.txt"));
    const studio = JSON.parse(run.artifact("lab-studio-drift.txt"));
    assert.deepEqual({ status: studio.status, changedLabs: studio.changedLabs }, { status: "drift", changedLabs: ["lab05"] });
    assert.equal(run.artifact("lab-studio-drift.txt"), run.artifact("preflight-2.txt"));
    assert.equal(run.artifact("preflight-exit-codes.txt"), "preflight exit codes: 1 1\n");
    assert.equal(run.porcelain(), "", "neither command wrote into the portfolio");
    assert.equal(run.upstreamPorcelain(), "", "nor into the upstream checkout");
    assert.ok(run.calls().some((line) => line.startsWith("npm run sync:workshop-source -- ") && !line.includes("--accept")), "the workshop script ran without --accept");
  } finally {
    run.cleanup();
  }
});

test("AC57: the hook is the spec's command up to the documented equivalence: <checkout> is $UPSTREAM_DIR (the upstream checkout), the working directory is the portfolio, and TARGET_SHA is upstream_sha", () => {
  const capture = workflowStep(LAB, "Capture the drift reports");
  assert.equal(capture["working-directory"], "portfolio", "npm --prefix \"$GITHUB_WORKSPACE/portfolio\" is the working directory");
  const upstream = '"$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab"';
  const text = capture.run.split('"$UPSTREAM_DIR"').join(upstream);
  assert.ok(text.includes('TARGET_SHA="$UPSTREAM_SHA"'));
  assert.ok(text.includes(`( npm run sync:workshop-source -- ${upstream} ) > /tmp/gh-aw/agent/preflight-1.txt 2>&1`));
  assert.ok(text.includes(`( node "$GITHUB_WORKSPACE/src/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream ${upstream} --commit "$TARGET_SHA" ) > /tmp/gh-aw/agent/preflight-2.txt 2>&1`));
  assert.ok(text.includes("rc1=$?") && text.includes("rc2=$?"));
  assert.ok(text.includes("cp /tmp/gh-aw/agent/preflight-1.txt /tmp/gh-aw/agent/workshop-drift.txt"));
  assert.ok(text.includes("cp /tmp/gh-aw/agent/preflight-2.txt /tmp/gh-aw/agent/lab-studio-drift.txt"));
  assert.ok(text.indexOf("set +e") < text.indexOf("rc1=$?") && text.indexOf("rc2=$?") < text.indexOf("set -e"), "set +e ... set -e around the two commands");
  assert.equal(capture.env, undefined, "the copilot-lab hook calls no gh");
});

test("AC58: rc 2 of the studio drift command, an exit code of 2 or more of the workshop script, and an uncaught-exception stack trace in the workshop report each exit 2; a drift report with rc 1 and rc 1 exits 0 and leaves both files", () => {
  // rc2 == 2: a source file of the manifest is absent from the upstream checkout (the studio command fails closed)
  const fatal = createRun(LAB, { workshopReport: drift("clean.txt"), workshopRc: 0 });
  try {
    fs.rmSync(path.join(fatal.upstream, "labs", "lab05.md"));
    const results = fatal.runPre();
    assert.deepEqual(results.map((result) => result.status), [0, 0, 2], "the capture step is the third and exits 2");
    assert.match(results[2].stderr, /exit code 2/);
    assert.equal(fatal.hasArtifact("lab-studio-drift.txt"), true, "the report is still there for whoever reads the failure");
  } finally {
    fatal.cleanup();
  }
  // a stack trace in the workshop report, with the exit code 1 that a crash and a drift report share
  const crash = createRun(LAB, { workshopReport: drift("crash.txt"), workshopRc: 1, labChanged: false });
  try {
    const results = crash.runPre();
    assert.deepEqual(results.map((result) => result.status), [0, 0, 2]);
    assert.match(results[2].stderr, /stack trace/);
  } finally {
    crash.cleanup();
  }
  // an exit code of 2 of the workshop script
  const rc2 = createRun(LAB, { workshopReport: "something went wrong\n", workshopRc: 2, labChanged: false });
  try {
    assert.deepEqual(rc2.runPre().map((result) => result.status), [0, 0, 2]);
  } finally {
    rc2.cleanup();
  }
  // a clean report, and a drift report: exit 0, both files left for the agent
  for (const [report, rc, changed] of [["clean.txt", 0, false], ["drift.txt", 1, true]]) {
    const run = createRun(LAB, { workshopReport: drift(report), workshopRc: rc, labChanged: changed });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], report);
      assert.ok(run.hasArtifact("workshop-drift.txt") && run.hasArtifact("lab-studio-drift.txt"), report);
      assert.equal(JSON.parse(run.artifact("lab-studio-drift.txt")).status, changed ? "drift" : "in-sync");
    } finally {
      run.cleanup();
    }
  }
});

test("AC59: the hook treats the workshop report as opaque text: its only reader is the stack-trace check, and no helper names the registry file or the pace field", () => {
  const capture = workflowStep(LAB, "Capture the drift reports").run;
  const readers = capture.split("\n").filter((line) => /\b(?:cat|jq|sed|awk|head|tail|grep|readFileSync)\b/.test(line));
  assert.equal(readers.length, 1, readers.join("\n"));
  assert.match(readers[0], /grep -Eq '\^\[\[:space:\]\]\+at\[\[:space:\]\]\+\[\^\[:space:\]\]'/);
  for (const file of ["lab-studio-drift.mjs", "bump-studio-revision-pins.mjs", "verify-immutable-gates.mjs"]) {
    const text = readText(abs("src", file));
    for (const banned of ["registry.yaml", "pace_workshop_minutes"]) assert.equal(text.includes(banned), false, `${file}: ${banned}`);
  }
});

test("AC64: the showcase hook saves the response of GET .../actions/runs as upstream-runs.json with a read-only request", () => {
  const body = '{"total_count":1,"workflow_runs":[{"id":777,"head_sha":"abc"}]}\n';
  const run = createRun(SHOWCASE, { runs: body });
  try {
    assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0]);
    assert.equal(run.artifact("upstream-runs.json"), body);
    assert.equal(run.artifact("preflight-1.txt"), body);
    const calls = run.calls().filter((line) => line.includes("actions/runs"));
    assert.deepEqual(calls, ['gh api repos/ms-mfg-community/github-pipeline-showcase/actions/runs?per_page=100'], "one GET, no method flag");
    assert.deepEqual(writes(run), []);
    assert.equal(run.porcelain(), "");
  } finally {
    run.cleanup();
  }
});

test("AC9: the github-intermediate hook records the exit code of its diff (1 when the cumulative range touches the lab sources, 0 when it does not) and never fails on it", () => {
  for (const [labChanged, expected] of [[true, "1"], [false, "0"]]) {
    const run = createRun(INTERMEDIATE, { labChanged });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], `labChanged=${labChanged}`);
      assert.equal(run.artifact("preflight-exit-codes.txt"), `preflight exit codes: ${expected}\n`);
      assert.equal(run.hasArtifact("workshop-drift.txt"), false, "no named report for an edge that names none");
      assert.equal(run.porcelain(), "");
    } finally {
      run.cleanup();
    }
  }
});

test("AC24: the inputs of the run reach the steps as the dispatch carries them; an input is never taken from the environment of the runner", () => {
  const inputs = dispatchInputs(LAB, { previous_sha: "a".repeat(40), upstream_sha: "b".repeat(40) });
  assert.equal(Object.keys(inputs).length, 10);
  const [validate, base] = preSteps(LAB);
  for (const step of [validate, base]) {
    assert.equal(step.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}");
    assert.equal(step.env.PREVIOUS_SHA, "${{ inputs.previous_sha }}");
  }
});

const preSteps = (spec) => workflowOf(spec).frontmatter["pre-agent-steps"];
const workflowStep = (spec, name) => preSteps(spec).find((step) => step.name === name);
