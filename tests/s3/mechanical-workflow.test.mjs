// The mechanical cascade workflow as SPEC-01 renders it (.github/workflows/cascade-mechanical-ghec-admin.md and its compiled .lock.yml) and as S3 depends on it
// (SPEC-03 AC3, AC4, AC46, AC49, AC50, AC53-AC55, AC57-AC59, AC61-AC63, AC65, AC70): the concurrency, the pull-request handler, the two custom jobs and the token that
// each of them mints (with the Variables permission that the state write needs, because naming any permission-* input stops the token from inheriting the
// installation's), the checkouts, the pre-agent step run for real in bash, the import command, the post-steps list, and the command lines that the custom jobs
// run — fed to the real poll-state script. The post-steps are run in tests/s3/mechanical-gate.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { BashSandbox } from "../s1/helpers/bash-runtime.mjs";
import { createStubBin } from "./helpers/git-world.mjs";
import { abs, presetEdges, readText, sha } from "./helpers/fixtures.mjs";
import { samePath } from "./helpers/preflight-world.mjs";
import { flagsFor, invoke, world } from "./helpers/poll-state-world.mjs";

const MD = abs(".github", "workflows", "cascade-mechanical-ghec-admin.md");
const LOCK = abs(".github", "workflows", "cascade-mechanical-ghec-admin.lock.yml");
const mdText = readText(MD);
const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(mdText);
const authored = YAML.parse(frontmatterMatch[1]);
const prompt = frontmatterMatch[2];
const lock = YAML.parse(readText(LOCK));
const edge = presetEdges().find((entry) => entry.mode === "mechanical");
const SLUG = edge.upstreamSlug;
const downstreamName = edge.downstreamRepo.split("/")[1];

const APP_TOKEN_INPUTS = {
  "app-id": "${{ vars.APP_CLIENT_ID }}",
  "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
  owner: "${{ github.repository_owner }}",
  repositories: `\${{ github.event.repository.name }},${downstreamName}`,
  "permission-contents": "read",
  "permission-pull-requests": "read",
  // naming any permission-* input stops the token from inheriting the installation's permissions (actions/create-github-app-token, lib/get-permissions-from-inputs.js),
  // so the Variables permission that the state read and write need has to be named too
  "permission-variables": "write",
};
const FINALIZE_RUN = `node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --slug ${SLUG} --branch ${edge.branchName} --provenance-file ${edge.provenanceFile} --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"`;
const FAILURE_RUN = `node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure --slug ${SLUG} --target-sha "$UPSTREAM_SHA" --workflow-id cascade-mechanical-ghec-admin`;
const hex = (label) => sha(label);

const runStepsOf = (steps) => steps.filter((step) => typeof step.run === "string");
const compilerInserted = (step) => step.id === "ghes-host-config";
const authoredSteps = (job) => job.steps.filter((step) => !compilerInserted(step));

// ---- AC3, AC50: concurrency and the two custom jobs ----------------------------------------------------------------------------------------------------

test("AC3 the workflow has the workflow-level concurrency of its upstream, in the source and in the compiled lock", () => {
  const expected = { group: "sdlc-state-gh-admin-msft", "cancel-in-progress": false };
  assert.deepEqual(authored.concurrency, expected);
  assert.deepEqual(lock.concurrency, expected);
});

test("AC3 finalize_poll_state and escalate_failure: needs, if, no job-level concurrency, the App token step first (compiler-inserted host configuration aside)", () => {
  const wanted = {
    finalize_poll_state: "success() && inputs.dry_run != 'true'",
    escalate_failure: "failure() && inputs.dry_run != 'true'",
  };
  for (const [name, condition] of Object.entries(wanted)) {
    const source = authored.jobs[name];
    assert.deepEqual(source.needs, ["agent", "detection", "safe_outputs"], `${name} (source)`);
    assert.equal(source.if, condition, `${name} (source)`);
    assert.equal("concurrency" in source, false, `${name} (source)`);
    assert.equal(source.steps[0].id, "app_token", `${name} begins with the token step`);
    assert.equal(source.steps[0].uses, "actions/create-github-app-token@v2");

    const compiled = lock.jobs[name];
    assert.deepEqual(compiled.needs, ["agent", "detection", "safe_outputs"], `${name} (lock)`);
    assert.ok(String(compiled.if).includes(condition), `${name} (lock): the compiled condition keeps '${condition}': ${compiled.if}`);
    assert.equal("concurrency" in compiled, false, `${name} (lock)`);
    assert.equal(authoredSteps(compiled)[0].id, "app_token", `${name} (lock) begins with the token step`);
    assert.match(authoredSteps(compiled)[0].uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/, "pinned by the compiler to a commit");
  }
});

test("AC50 finalize_poll_state has no --record-failure step; escalate_failure needs exactly agent, detection and safe_outputs and gates on the status only", () => {
  for (const jobs of [authored.jobs, lock.jobs]) {
    assert.equal(JSON.stringify(jobs.finalize_poll_state).includes("--record-failure"), false);
    assert.deepEqual(jobs.escalate_failure.needs, ["agent", "detection", "safe_outputs"]);
  }
  assert.equal(authored.jobs.escalate_failure["detection-gate"], "status-only");
  assert.equal(authored.jobs.finalize_poll_state["detection-gate"], undefined, "the success path waits for a clean threat detection");
});

test("AC62 the pull request is only reachable from a successful agent: detection needs the agent and safe_outputs needs detection, and neither runs unless the agent succeeded", () => {
  assert.ok(lock.jobs.detection.needs.includes("agent"));
  assert.ok(lock.jobs.safe_outputs.needs.includes("detection"));
  assert.ok(lock.jobs.safe_outputs.needs.includes("agent"));
  for (const name of ["detection", "safe_outputs"]) {
    assert.equal(authored.jobs[name].if, "needs.agent.result == 'success'", `${name} (source)`);
    const condition = String(lock.jobs[name].if);
    assert.ok(condition.includes("needs.agent.result == 'success'"), `${name}: ${condition}`);
    // the compiler wraps the condition in always() / !cancelled() so that the job is not skipped with a failed dependency; it is a conjunct, never an alternative
    assert.equal(/\|\|/.test(condition), false, `${name}: no alternative that could run it after a failed agent: ${condition}`);
  }
});

// ---- AC4, AC58, AC70: the pull request ----------------------------------------------------------------------------------------------------------------

test("AC4 AC58 the create-pull-request handler is exactly the shape of the spec, plus the two settings of SPEC-01 AC34 (exclude-lock-yml and a blocking protected-files policy)", () => {
  assert.deepEqual(authored["safe-outputs"]["create-pull-request"], {
    "target-repo": edge.downstreamRepo,
    "title-prefix": "chore(cascade): ",
    labels: ["automated", "sdlc-cascade", "needs-review"],
    reviewers: edge.reviewers,
    draft: false,
    "preserve-branch-name": true,
    "recreate-ref": true,
    "close-older-pull-requests": true,
    "close-older-key": edge.closeOlderKey,
    "if-no-changes": "ignore",
    "auto-merge": false,
    "fallback-as-issue": false,
    "allowed-files": ["public/ghec-admin/**"],
    "exclude-lock-yml": true,
    "protected-files": { policy: "blocked", exclude: [] },
    max: 1,
  });
  const handler = authored["safe-outputs"]["create-pull-request"];
  assert.ok(handler.reviewers.length > 0 && handler["allowed-files"].length > 0);
  assert.equal(handler["auto-merge"], false, "the boolean false");
  assert.match(prompt, new RegExp(`exactly the branch \`${edge.branchName}\``));
});

test("AC70 auto-merge appears once in the workflow, as false, and no S3 code calls a merge or auto-merge endpoint", () => {
  const lines = mdText.split(/\r?\n/).filter((line) => line.includes("auto-merge"));
  assert.deepEqual(lines.map((line) => line.trim()), ["auto-merge: false"]);
  const files = [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
  for (const file of files) assert.equal(/\/merge|enableAutoMerge|auto_merge/.test(readText(file)), false, `${path.basename(file)} names a merge endpoint`);
});

test("AC61 the downstream is never pushed to, merged, closed or relabelled by a command of the workflow, and only the compiler's own jobs hold a write permission on contents or pull requests", () => {
  assert.equal(/git push|gh pr /.test(mdText), false, "no git push and no gh pr command");
  const holders = Object.entries(lock.jobs).filter(([, entry]) => entry.permissions?.contents === "write" || entry.permissions?.["pull-requests"] === "write").map(([name]) => name).sort();
  // safe_outputs creates the pull request; conclusion is the compiler's job that reports on the run. No job that this repository authors holds either permission.
  assert.deepEqual(holders, ["conclusion", "safe_outputs"]);
  for (const name of ["activation", "agent", "detection", "finalize_poll_state", "escalate_failure"]) {
    assert.notEqual(lock.jobs[name].permissions?.contents, "write", name);
    assert.notEqual(lock.jobs[name].permissions?.["pull-requests"], "write", name);
  }
});

// ---- AC46, AC49, AC59, AC63: the tokens and the command lines of the custom jobs --------------------------------------------------------------------

test("AC46 AC59 finalize_poll_state: token, sparse checkout of src and schemas, npm ci, artifact download, the exported revisions and the script step, in that order", () => {
  const steps = authored.jobs.finalize_poll_state.steps;
  assert.deepEqual(steps[0], { id: "app_token", uses: "actions/create-github-app-token@v2", with: APP_TOKEN_INPUTS });
  assert.deepEqual(steps[1], { uses: "actions/checkout@v4", with: { token: "${{ steps.app_token.outputs.token }}", "sparse-checkout": "src\nschemas", "persist-credentials": false } });
  assert.deepEqual(steps[2], { run: "npm ci --ignore-scripts" });
  assert.deepEqual(steps[3], { uses: "actions/download-artifact@v4", with: { name: "sdlc-cascade-shas-${{ github.run_id }}", path: "/tmp/gh-aw" } });
  assert.match(steps[4].run, /jq -r \.baseSha \/tmp\/gh-aw\/cascade-shas\.json/);
  assert.match(steps[4].run, /jq -r \.headSha \/tmp\/gh-aw\/cascade-shas\.json/);
  assert.match(steps[4].run, /\{ echo "BASE_SHA=\$BASE_SHA"; echo "AGENT_HEAD_SHA=\$AGENT_HEAD_SHA"; \} >> "\$GITHUB_ENV"/);
  const script = steps[5];
  assert.equal(script.if, "inputs.dry_run != 'true'");
  assert.deepEqual(script.env, {
    GH_TOKEN: "${{ steps.app_token.outputs.token }}",
    ISSUES_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    UPSTREAM_SHA: "${{ inputs.upstream_sha }}",
    UPSTREAM_ETAG: "${{ inputs.upstream_etag }}",
  });
  assert.equal(script.run, FINALIZE_RUN);
  assert.equal(steps.length, 6);
  assert.deepEqual(authored.jobs.finalize_poll_state.permissions, { issues: "write" });
});

test("AC46 AC59 the compiled finalize_poll_state keeps the order, names the Variables permission, and pins every action to a commit", () => {
  const steps = authoredSteps(lock.jobs.finalize_poll_state);
  assert.deepEqual(steps.slice(0, 4).map((step) => step.id ?? step.run ?? step.uses.replace(/@.*/, "")), ["app_token", "actions/checkout", "npm ci --ignore-scripts", "actions/download-artifact"]);
  assert.equal(steps[0].with["permission-variables"], "write");
  assert.equal(steps[0].with["permission-contents"], "read");
  assert.equal(steps[0].with["permission-pull-requests"], "read");
  assert.equal(steps[0].with.repositories, APP_TOKEN_INPUTS.repositories);
  assert.deepEqual(steps[1].with, { token: "${{ steps.app_token.outputs.token }}", "sparse-checkout": "src\nschemas", "persist-credentials": false });
  for (const step of steps.filter((candidate) => candidate.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
  const script = runStepsOf(steps).find((step) => step.run.includes("update-poll-state.mjs"));
  assert.equal(script.run, FINALIZE_RUN);
  assert.equal(script.if, "inputs.dry_run != 'true'");
  assert.equal(steps.indexOf(script) > steps.findIndex((step) => String(step.uses).startsWith("actions/download-artifact")), true);
});

test("AC49 AC63 escalate_failure: token, checkout, npm ci, then the --record-failure step with the two tokens, in the source and in the lock", () => {
  const source = authored.jobs.escalate_failure;
  assert.equal(source.if, "failure() && inputs.dry_run != 'true'");
  assert.deepEqual(source.permissions, { issues: "write" });
  assert.deepEqual(source.steps[0], { id: "app_token", uses: "actions/create-github-app-token@v2", with: APP_TOKEN_INPUTS });
  assert.deepEqual(source.steps[1], { uses: "actions/checkout@v4", with: { token: "${{ steps.app_token.outputs.token }}", "sparse-checkout": "src\nschemas", "persist-credentials": false } });
  assert.deepEqual(source.steps[2], { run: "npm ci --ignore-scripts" });
  const record = source.steps[3];
  assert.equal(record.if, "inputs.dry_run != 'true'");
  assert.equal(record.env.GH_TOKEN, "${{ steps.app_token.outputs.token }}");
  assert.equal(record.env.ISSUES_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(record.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}");
  assert.equal(record.run, FAILURE_RUN);

  const compiled = authoredSteps(lock.jobs.escalate_failure);
  assert.equal(compiled[0].with["permission-variables"], "write");
  assert.equal(compiled[1].with["sparse-checkout"], "src\nschemas");
  assert.equal(compiled[2].run, "npm ci --ignore-scripts");
  assert.equal(compiled[3].run, FAILURE_RUN);
  assert.equal(lock.jobs.escalate_failure.permissions.issues, "write");
});

test("AC46 AC49 the token of both custom jobs names the three permissions of the state path, because naming any permission-* input drops the inheritance of the others", () => {
  for (const [label, steps] of [["finalize (source)", authored.jobs.finalize_poll_state.steps], ["escalate (source)", authored.jobs.escalate_failure.steps], ["finalize (lock)", authoredSteps(lock.jobs.finalize_poll_state)], ["escalate (lock)", authoredSteps(lock.jobs.escalate_failure)]]) {
    const inputs = Object.keys(steps[0].with).filter((name) => name.startsWith("permission-")).sort();
    assert.deepEqual(inputs, ["permission-contents", "permission-pull-requests", "permission-variables"], label);
    assert.equal(steps[0].with["permission-variables"], "write", label);
  }
});

test("AC46 AC59 the command line of the success step, run by bash with the variables of the job, hands the real script exactly the seven flags, and the script accepts them", async (t) => {
  const sandbox = new BashSandbox();
  t.after(() => sandbox.cleanup());
  const recorder = path.join(sandbox.work, "src", "update-poll-state.mjs");
  fs.mkdirSync(path.dirname(recorder), { recursive: true });
  fs.writeFileSync(recorder, 'import fs from "node:fs";\nfs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\n');
  const argvFile = path.join(sandbox.root, "argv.json");
  const base = hex("base");
  const head = hex("head");
  const target = hex("target");
  const result = sandbox.run(FINALIZE_RUN, { BASE_SHA: base, AGENT_HEAD_SHA: head, UPSTREAM_SHA: target, UPSTREAM_ETAG: 'W/"the etag"', ARGV_FILE: argvFile.replace(/\\/g, "/") });
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv, ["--slug", SLUG, "--branch", edge.branchName, "--provenance-file", edge.provenanceFile, "--base-sha", base, "--head-sha", head, "--target-sha", target, "--etag", 'W/"the etag"']);

  // and the real script takes that argv, for the real manifest: a verified pull request is recorded in the variable of the edge
  const w = world({ edgeValue: { ...edge, upstreamSlug: SLUG } });
  t.after(() => w.workspace.cleanup());
  const [owner] = edge.downstreamRepo.split("/");
  w.stub.repo(edge.downstreamRepo, {
    openPullsByHead: { [`${owner}:${edge.branchName}`]: [{ number: 21, state: "open", merged: false, html_url: "https://github.com/x/y/pull/21", head: { ref: edge.branchName, sha: hex("pr-head") } }] },
    filesAtRef: { [hex("pr-head")]: { [edge.provenanceFile]: JSON.stringify({ commit: target }) } },
  });
  const run = await invoke(w, argv, { env: { GITHUB_WORKSPACE: abs(".") } });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(w.stub.calls("PATCH")[0].path, `/repos/acme/orchestrator/actions/variables/${edge.stateVariable}`);
  assert.equal(w.stub.variable(edge.stateVariable).openPrNumber, 21);
  void flagsFor;
});

test("AC49 AC63 the command line of the failure step hands the real script --record-failure with the slug, the target and the workflow, and the script records one failure", async (t) => {
  const sandbox = new BashSandbox();
  t.after(() => sandbox.cleanup());
  const recorder = path.join(sandbox.work, "src", "update-poll-state.mjs");
  fs.mkdirSync(path.dirname(recorder), { recursive: true });
  fs.writeFileSync(recorder, 'import fs from "node:fs";\nfs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\n');
  const argvFile = path.join(sandbox.root, "argv.json");
  const target = hex("target");
  const result = sandbox.run(FAILURE_RUN, { UPSTREAM_SHA: target, ARGV_FILE: argvFile.replace(/\\/g, "/") });
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv, ["--record-failure", "--slug", SLUG, "--target-sha", target, "--workflow-id", "cascade-mechanical-ghec-admin"]);

  const w = world({ edgeValue: { ...edge, upstreamSlug: SLUG } });
  t.after(() => w.workspace.cleanup());
  const run = await invoke(w, argv, { env: { GITHUB_WORKSPACE: abs(".") } });
  assert.equal(run.code, 0, run.stderr);
  const after = w.stub.variable(edge.stateVariable);
  assert.equal(after.failedTargetSha, target);
  assert.equal(after.failedAttempts, 1);
  assert.equal(w.stub.issues[0].title, `[sdlc-failure] cascade-mechanical-ghec-admin (${edge.downstreamRepo})`);
});

// ---- AC46 (the artifact), AC53, AC57, AC65: the agent job ----------------------------------------------------------------------------------------------

test("AC46 AC56 post-steps record the revisions, upload cascade-shas.json as sdlc-cascade-shas-<run id> between the record and the clean-tree check", () => {
  const steps = authored["post-steps"];
  const record = steps.findIndex((step) => String(step.run ?? "").includes("cascade-shas.json"));
  const upload = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@v4"));
  const clean = steps.findIndex((step) => String(step.run ?? "").includes("status --porcelain"));
  assert.ok(record === 0 && upload === 1 && clean === 2, `record ${record}, upload ${upload}, clean-tree check ${clean}`);
  assert.deepEqual(steps[upload].with, { name: "sdlc-cascade-shas-${{ github.run_id }}", path: "/tmp/gh-aw/cascade-shas.json", "if-no-files-found": "error" });
  assert.match(steps[record].run, /\{"baseSha":"\$BASE_SHA","headSha":"\$AGENT_HEAD_SHA"\}/);
});

test("AC53 the portfolio and the pinned upstream are checked out by path, Node.js 24 is set up and both package trees are installed", () => {
  assert.deepEqual(authored.checkout.map((entry) => [entry.repository, entry.path, entry.current ?? false, entry.ref ?? null]), [
    [edge.downstreamRepo, "portfolio", true, null],
    [edge.upstreamRepo, `upstream/${edge.upstreamRepo.split("/")[1]}`, false, "${{ inputs.upstream_sha }}"],
  ]);
  assert.equal(authored.steps[0].uses, "actions/setup-node@v4");
  assert.equal(authored.steps[0].with["node-version"], "24");
  const installs = authored.steps.filter((step) => step.run === "npm ci --include=dev");
  assert.equal(installs.length, 2);
  assert.deepEqual(installs.map((step) => step["working-directory"]), ["portfolio", "portfolio/apps/lab-studio"]);
});

test("AC57 Microsoft Edge is installed before the post-steps, and the build and check commands are the edge's buildCommands then verifyCommands, in order, with nothing else", () => {
  assert.ok(authored.steps.some((step) => step.run === "npx playwright install --with-deps msedge"));
  const checks = authored["post-steps"].filter((step) => step["working-directory"] === "portfolio").map((step) => step.run);
  assert.deepEqual(checks, [...edge.buildCommands, ...edge.verifyCommands]);
  assert.equal(checks.length, 7);
});

test("AC65 AC46 the dispatch inputs are the eight of C7, as strings, and the script steps bind the upstream sha and etag to them", () => {
  const inputs = authored.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["correlation_id", "upstream_repo", "previous_sha", "upstream_sha", "upstream_etag", "upstream_pr_number", "downstream_repo", "dry_run"]);
  for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", name);
  assert.deepEqual(Object.keys(lock.on.workflow_dispatch.inputs).sort(), [...Object.keys(inputs), "aw_context"].sort(), "the compiler adds only its own aw_context");
  const prep = authored["pre-agent-steps"][0];
  assert.deepEqual(prep.env, { UPSTREAM_SHA: "${{ inputs.upstream_sha }}", PREVIOUS_SHA: "${{ inputs.previous_sha }}" });
});

// ---- AC54, AC55: the pre-agent step and the import command, run for real ---------------------------------------------------------------------------------

function fixtureCheckouts(sandbox) {
  const portfolio = sandbox.revision("portfolio", { "package.json": "{}\n", "public/ghec-admin/source.json": '{"commit":"old"}\n' });
  const upstream = sandbox.revision(`upstream/${edge.upstreamRepo.split("/")[1]}`, { "README.md": "the upstream\n" });
  return { portfolio, upstream };
}
const preAgent = authored["pre-agent-steps"][0].run;

test("AC54 the pre-agent step records the base revision to base-sha.txt and appends BASE_SHA, UPSTREAM_SHA, PREVIOUS_SHA, BRANCH_NAME and UPSTREAM_DIR to GITHUB_ENV, and changes nothing in the portfolio", (t) => {
  const sandbox = new BashSandbox();
  t.after(() => sandbox.cleanup());
  const { portfolio, upstream } = fixtureCheckouts(sandbox);
  const result = sandbox.run(preAgent, { UPSTREAM_SHA: hex("upstream"), PREVIOUS_SHA: hex("previous") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sandbox.readArtifact("base-sha.txt").trim(), portfolio);
  const appended = sandbox.environment();
  assert.deepEqual(Object.keys(appended), ["BASE_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"]);
  assert.equal(appended.BASE_SHA, portfolio);
  assert.equal(appended.UPSTREAM_SHA, hex("upstream"));
  assert.equal(appended.PREVIOUS_SHA, hex("previous"));
  assert.equal(appended.BRANCH_NAME, edge.branchName);
  assert.ok(samePath(appended.UPSTREAM_DIR, sandbox.path(`upstream/${edge.upstreamRepo.split("/")[1]}`)), `${appended.UPSTREAM_DIR} is the upstream checkout, expanded when the line was written`);
  assert.equal(sandbox.git("portfolio", "rev-parse", "HEAD"), portfolio);
  assert.equal(sandbox.git("portfolio", "status", "--porcelain"), "", "the portfolio is untouched");
  const upstreamDir = `upstream/${edge.upstreamRepo.split("/")[1]}`;
  assert.equal(sandbox.git(upstreamDir, "rev-parse", "HEAD"), upstream, "the upstream checkout stays at the revision it was pinned to");
  assert.equal(sandbox.git(upstreamDir, "status", "--porcelain"), "", "and nothing in it is touched");
  // the only reference to the portfolio in the step is the read of its HEAD
  const references = preAgent.split("\n").filter((line) => line.includes("portfolio"));
  assert.deepEqual(references.map((line) => line.trim()), ['BASE_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"']);
});

test("AC54 a revision that is not 40 lowercase hexadecimal characters (or has a second line) exits 2 and appends nothing", (t) => {
  const bad = ["", "abc", "A".repeat(40), "g".repeat(40), "a".repeat(39), "a".repeat(41), `${"a".repeat(40)}\nINJECTED=1`, `${"a".repeat(40)} `, "$(id)", "a".repeat(40) + "\r"];
  const sandbox = new BashSandbox();
  t.after(() => sandbox.cleanup());
  fixtureCheckouts(sandbox);
  for (const [name, mutate] of [["UPSTREAM_SHA", (value) => ({ UPSTREAM_SHA: value, PREVIOUS_SHA: hex("previous") })], ["PREVIOUS_SHA", (value) => ({ UPSTREAM_SHA: hex("upstream"), PREVIOUS_SHA: value })]]) {
    for (const value of bad) {
      sandbox.writeEnv("");
      const result = sandbox.run(preAgent, mutate(value));
      assert.equal(result.status, 2, `${name}=${JSON.stringify(value)}: ${result.stderr}`);
      assert.equal(fs.readFileSync(sandbox.envFile, "utf8"), "", `${name}=${JSON.stringify(value)}: nothing was appended`);
      assert.equal(fs.existsSync(path.join(sandbox.artifacts, "base-sha.txt")), false, "and no base revision was recorded");
    }
  }
  // the same step still works afterwards with valid revisions: the refusals left no state behind
  assert.equal(sandbox.run(preAgent, { UPSTREAM_SHA: hex("upstream"), PREVIOUS_SHA: hex("previous") }).status, 0);
});

test("AC55 the prompt lists the three actions in order and nothing else: the import, the commit of the allowed paths, then create_pull_request with the branch", () => {
  const items = [...prompt.matchAll(/^(\d+)\.\s/gm)].map((match) => Number(match[1]));
  assert.deepEqual(items, [1, 2, 3]);
  const blocks = [...prompt.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((match) => match[1].trim().split(/\r?\n/));
  assert.deepEqual(blocks, [['cd "$GITHUB_WORKSPACE/portfolio"', 'npm run import:ghec-admin -- "$UPSTREAM_DIR"'], ["git add public/ghec-admin", 'git commit -m "chore(cascade): import gh-admin-msft $UPSTREAM_SHA"']]);
  assert.equal(prompt.match(/```/g).length, 4, "two fenced blocks and no other");
  assert.match(prompt, /3\. Call `create_pull_request` with exactly the branch `sdlc\/cascade-ghec-admin`\./);
  assert.equal(prompt.includes("upstream/gh-admin-msft"), false, "no relative path to the upstream");
  assert.deepEqual(edge.importCommands, ["npm run import:ghec-admin -- <checkout>"]);
  assert.deepEqual(authored["safe-outputs"]["create-pull-request"]["allowed-files"], ["public/ghec-admin/**"]);
  assert.equal(/allowed-files: \["public\/ghec-admin\/\*\*"\]|allowed-files:\r?\n\s+- public\/ghec-admin\/\*\*/.test(mdText), true);
});

test("AC55 with the variables of the pre-agent step, UPSTREAM_DIR is the absolute path of the upstream checkout, from the workspace and from the portfolio alike", (t) => {
  const sandbox = new BashSandbox();
  const bin = createStubBin({ npm: { rules: [{ match: ".*", code: 0 }] } });
  t.after(() => {
    sandbox.cleanup();
    bin.cleanup();
  });
  fixtureCheckouts(sandbox);
  assert.equal(sandbox.run(preAgent, { UPSTREAM_SHA: hex("upstream"), PREVIOUS_SHA: hex("previous") }).status, 0);
  const environment = sandbox.environment();
  const importCommand = 'npm run import:ghec-admin -- "$UPSTREAM_DIR"';
  for (const cwd of ["", "portfolio"]) {
    const result = sandbox.run(importCommand, { ...environment, PATH: bin.path() }, cwd);
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = bin.calls("npm");
  assert.equal(calls.length, 2);
  const expected = sandbox.path(`upstream/${edge.upstreamRepo.split("/")[1]}`);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 3), ["run", "import:ghec-admin", "--"]);
    assert.ok(samePath(call.args[3], expected), `${call.args[3]} is ${expected}`);
    assert.equal(/^(\/|[A-Za-z]:)/.test(call.args[3]), true, "absolute");
  }
  assert.equal(calls[0].args[3], calls[1].args[3], "it resolves identically from both directories");
  assert.ok(samePath(calls[1].cwd, sandbox.path("portfolio")));
});

// ---- the real compiler ----------------------------------------------------------------------------------------------------------------------------------

const requested = process.env.SDLC_REAL_GH_AW === "1";
test("AC3 AC4 AC58 gh aw compile --strict --json accepts the mechanical workflow and reproduces the committed lock", { skip: requested ? false : "set SDLC_REAL_GH_AW=1 (and XDG_DATA_HOME for an isolated gh-aw v1.0.1) to run the real compiler" }, async () => {
  const { ghAwEnvironment } = await import("../../src/reconcile.mjs");
  const os = await import("node:os");
  const env = ghAwEnvironment(process.env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-compile-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: directory });
    fs.cpSync(abs(".github"), path.join(directory, ".github"), { recursive: true });
    fs.copyFileSync(abs(".gitattributes"), path.join(directory, ".gitattributes"));
    const outcome = spawnSync("gh", ["aw", "compile", "cascade-mechanical-ghec-admin", "--strict", "--json"], { cwd: directory, env, encoding: "utf8", timeout: 600000 });
    assert.equal(outcome.status, 0, outcome.stderr);
    const [element] = JSON.parse(outcome.stdout);
    assert.equal(element.valid, true, JSON.stringify(element.errors));
    assert.deepEqual(element.errors, []);
    const rebuilt = fs.readFileSync(path.join(directory, ".github", "workflows", "cascade-mechanical-ghec-admin.lock.yml"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(rebuilt, readText(LOCK).replace(/\r\n/g, "\n"), "the committed lock is what the compiler produces");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
