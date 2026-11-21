// AC60-AC66 and AC75: the prompts of the two AI workflows, as the committed files render them: what the agent is told to edit, never to touch, to read, to run in
// what order, and how to finish. The agent is a language model, so the contract is the text it is given; the commands in it are run for real by the other tests.
import assert from "node:assert/strict";
import test from "node:test";
import { AI, edgeOf, promptBlock, workflowOf } from "./helpers/workflows.mjs";

const [LAB, SHOWCASE] = AI;
const bodyOf = (spec) => workflowOf(spec).body;
/** The text of one `## ` section of a prompt. */
function section(body, heading) {
  const start = body.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the prompt has a section '${heading}'`);
  const next = body.indexOf("\n## ", start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}
/** The first index of each needle, which must all exist and be strictly increasing. */
function inOrder(text, needles, label) {
  const positions = needles.map((needle) => text.indexOf(needle));
  needles.forEach((needle, index) => assert.notEqual(positions[index], -1, `${label}: '${needle}' is in the prompt`));
  for (let index = 1; index < positions.length; index += 1) assert.ok(positions[index - 1] < positions[index], `${label}: '${needles[index - 1]}' comes before '${needles[index]}'`);
}
const UPSTREAM = '"$GITHUB_WORKSPACE/upstream/day-in-the-life-copilot-lab"';
const BUMP = 'node "$GITHUB_WORKSPACE/scripts/bump-studio-revision-pins.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --new-sha "$UPSTREAM_SHA"';
const SYNC_ACCEPT = 'npm run sync:workshop-source -- "$UPSTREAM_DIR" --accept';
const DRIFT_ACCEPT = 'node "$GITHUB_WORKSPACE/scripts/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream "$UPSTREAM_DIR" --commit "$UPSTREAM_SHA" --accept';

test("AC60: the copilot-lab prompt has the agent run the revision bump, with exactly those arguments, before the first --accept command", () => {
  const body = bodyOf(LAB);
  assert.ok(body.includes(BUMP));
  assert.ok(body.indexOf(BUMP) < body.indexOf("--accept"), "the bump precedes every --accept");
  assert.equal(body.split(BUMP).length - 1, 1, "the bump is named once");
  // the same command as the spec's, with the checkout variable that the pre-agent-steps export for $GITHUB_WORKSPACE/upstream/<repo>
  assert.equal(SYNC_ACCEPT.replace('"$UPSTREAM_DIR"', UPSTREAM), `npm run sync:workshop-source -- ${UPSTREAM} --accept`);
  assert.equal(edgeOf(LAB).acceptCommands[0].includes("$UPSTREAM_SHA"), true);
});

test("AC61: the copilot-lab prompt lists the workshop pages, notices, README, page and test file as editable and the three locked content files as forbidden, and names the five locked test titles", () => {
  const body = bodyOf(LAB);
  const editable = section(body, "Files you may change");
  for (const file of [
    "experiences/copilot-workshop/content/index.ts",
    "experiences/copilot-workshop/content/interludes.ts",
    "experiences/copilot-workshop/content/lab-pace.ts",
    "experiences/copilot-workshop/content/m*.ts",
    "experiences/copilot-workshop/public/LICENSE",
    "experiences/copilot-workshop/public/NOTICE.txt",
    "README.md",
    "public/copilot-project.html",
    "tests/copilot-workshop.test.ts",
  ]) assert.ok(editable.includes(`\`${file}\``), `editable: ${file}`);
  const forbidden = section(body, "Files you must not change");
  for (const file of ["rules.ts", "source.ts", "types.ts"]) {
    assert.ok(forbidden.includes(`\`experiences/copilot-workshop/content/${file}\``), `forbidden: ${file}`);
    assert.equal(editable.includes(`content/${file}\``), false, `${file} is not editable`);
  }
  const locked = section(body, "Test blocks that stay byte for byte");
  assert.ok(locked.includes("`tests/copilot-workshop.test.ts`"));
  for (const title of [
    "passes every content rule: no errors and no warnings",
    "gives every teaching page a literal script, not notes",
    "can be delivered in the minutes the plan gives it: speech at the app's own rate plus the live cues, on every page and in every module",
    "plans with one speaking rate: the pace band tops out at it, and the speaker view reads it from the rules instead of typing its own",
    "keeps audience pages sparse",
  ]) assert.ok(locked.includes(`it(${JSON.stringify(title)})`), `locked: ${title}`);
  assert.ok(locked.includes("the lines before the first `describe(`") && locked.includes("every `describe(` header line"), "the prelude and the headers are named");
  const rules = body.replace(/\s+/g, " ");
  for (const phrase of ["140 words a minute", "SPEAKING_WPM", "LIVE_SECONDS", "audience-word limits", "hollow cards", "cue discipline", "source links pinned to the new revision", "227 of 240 minute budget"]) {
    assert.ok(rules.includes(phrase), `the content rules: ${phrase}`);
  }
  assert.ok(rules.includes("so update lab-pace.ts, public/LICENSE and the page content yourself"), "the sync command writes none of them");
  assert.ok(rules.includes("keep every source-lab link pointing at the pinned revision"));
});

test("AC62: the copilot-lab prompt lists the Studio labs, UI components, styles, README, verify.ts and three Studio tests as editable, the authentication, runtime and sandbox files as forbidden, and requires them to be preserved", () => {
  const body = bodyOf(LAB);
  const editable = section(body, "Files you may change");
  for (const file of [
    "apps/lab-studio/client/src/labs/**",
    "apps/lab-studio/client/src/components/Home.tsx",
    "apps/lab-studio/client/src/components/Manual.tsx",
    "apps/lab-studio/client/src/components/Rail.tsx",
    "apps/lab-studio/client/src/styles.css",
    "apps/lab-studio/README.md",
    "apps/lab-studio/server/src/verify.ts",
    "apps/lab-studio/server/tests/source.test.ts",
    "apps/lab-studio/server/tests/lab-drift.test.ts",
    "apps/lab-studio/server/tests/lesson-content.test.ts",
  ]) assert.ok(editable.includes(`\`${file}\``), `editable: ${file}`);
  assert.equal(editable.includes("sandbox.test.ts"), false, "sandbox.test.ts is not editable");
  const forbidden = section(body, "Files you must not change");
  for (const file of [
    "tests/auth.test.ts",
    "tests/runtime.test.ts",
    "apps/lab-studio/server/src/index.ts",
    "apps/lab-studio/server/src/copilot-bridge.ts",
    "apps/lab-studio/server/src/sandbox.ts",
    "apps/lab-studio/server/src/sim-terminal.ts",
    "apps/lab-studio/server/src/skills.ts",
    "apps/lab-studio/server/tests/sandbox.test.ts",
    "apps/lab-studio/client/src/hosted.ts",
    "apps/lab-studio/client/src/components/AccountBar.tsx",
  ]) assert.ok(forbidden.includes(`\`${file}\``), `forbidden: ${file}`);
  const flat = body.replace(/\s+/g, " ");
  assert.match(flat, /Hosted authentication and sandbox isolation must be preserved/);
  for (const phrase of [
    "loadWebsiteSession()",
    "/workspace/status",
    "resumePlace()",
    "sourceRevisionUrl()",
    "SOURCE_ONLY_EXERCISES",
    "setupGuideUrl()",
    "SETUP_GUIDE.note",
    "MarkReadCard",
    "sourceLabUrl()",
    "sourceLabPath()",
    "consolidate-lessons skill",
    "It is a command skill",
    "/consolidate-lessons",
    "(Lab 10, step 5)",
    "Pinned to <sha>",
    "unreplaced-short-sha",
  ]) assert.ok(flat.includes(phrase), `Studio preservation rule: ${phrase}`);
});

test("AC63: the copilot-lab prompt has the commands in the order bump, sync accept, studio accept, build:workshop, git commit and only then create_pull_request, and a failed command ends the run", () => {
  const body = bodyOf(LAB);
  inOrder(body, [BUMP, SYNC_ACCEPT, DRIFT_ACCEPT, "npm run build:workshop", "git commit", "create_pull_request"], "AC63");
  const block = promptBlock(body);
  inOrder(block, [BUMP, SYNC_ACCEPT, DRIFT_ACCEPT, "npm run build:workshop", "git add", "git commit"], "the fenced block");
  assert.match(section(body, "Deterministic commands"), /A non-zero exit of any command is a failed run: stop, do not commit, and do not open the pull request\./);
  assert.ok(body.indexOf("create_pull_request") > body.indexOf("git commit"), "the first mention of the pull request is after the commit");
});

test("AC64: the showcase prompt has the agent read the saved upstream runs, update RUNS and the showcase test, and write the exact provenance object", () => {
  const body = bodyOf(SHOWCASE).replace(/\s+/g, " ");
  assert.ok(body.includes("GET /repos/ms-mfg-community/github-pipeline-showcase/actions/runs"));
  assert.ok(body.includes("/tmp/gh-aw/agent/upstream-runs.json"));
  assert.ok(body.includes("update RUNS (the id and story of each entry, lines 15 to 27 of experiences/pipeline-showcase/capture/fetch-run-data.mjs)"));
  assert.ok(body.includes("tests/pipeline-showcase.test.ts, keeping the lines before the first describe(, every describe( header and the two locked describe blocks"));
  assert.ok(body.includes('write { "repository": "ms-mfg-community/github-pipeline-showcase", "commit": "$UPSTREAM_SHA" } to experiences/pipeline-showcase/content/provenance.json'));
  assert.ok(body.includes("Note any RUNS id change in the pull request body so that pipeline-demo.svg can be re-stitched by hand"));
  const locked = section(bodyOf(SHOWCASE), "Test blocks that stay byte for byte");
  assert.ok(locked.includes('`describe("pipeline-showcase animated SVG")`') && locked.includes('`describe("pipeline-showcase sanitization")`'));
  assert.ok(locked.includes("`findCustomerTerms`"), "the import of the sanitiser is named as locked");
});

test("AC65: the showcase prompt runs the capture script with GH_TOKEN, then build:experiences, and commits the five paths before the pull request; api.github.com is allowed", () => {
  const body = bodyOf(SHOWCASE);
  const flat = body.replace(/\s+/g, " ");
  assert.ok(flat.includes("run node experiences/pipeline-showcase/capture/fetch-run-data.mjs from the repository root with GH_TOKEN set to the GitHub App installation token in the environment"));
  const block = promptBlock(body);
  inOrder(block, ["provenance.json", "node experiences/pipeline-showcase/capture/fetch-run-data.mjs", "npm run build:experiences", "git add", "git commit"], "the fenced block");
  inOrder(body, ["node experiences/pipeline-showcase/capture/fetch-run-data.mjs", "npm run build:experiences", "git commit", "create_pull_request"], "AC65");
  const add = block.split("\n").find((line) => line.startsWith("git add"));
  for (const path of [
    "experiences/pipeline-showcase/content/provenance.json",
    "experiences/pipeline-showcase/capture/fetch-run-data.mjs",
    "experiences/pipeline-showcase/content/run-data.json",
    "public/pipeline-showcase",
    "tests/pipeline-showcase.test.ts",
  ]) assert.ok(add.includes(path), `the commit stages ${path}`);
  assert.deepEqual(workflowOf(SHOWCASE).frontmatter.network.allowed, ["api.github.com"]);
});

test("AC66: the showcase prompt makes a failed capture a failed run and forbids committing run-data.json from it", () => {
  const body = bodyOf(SHOWCASE).replace(/\s+/g, " ");
  assert.ok(body.includes("Any non-zero exit of the capture script is a failed run: never commit run-data.json from a run that did not exit 0 (its sanitisation guard exits 1 before it writes)"));
  assert.match(section(bodyOf(SHOWCASE), "Deterministic commands"), /A non-zero exit of any command is a failed run/);
});

test("AC75: every prompt states the branch, the editable and the forbidden paths, the evidence, the order of the commands, the commit before the pull request, what to leave alone, and what the pull request body lists", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    const body = bodyOf(spec);
    assert.match(body, new RegExp(`call \`create_pull_request\` with exactly the branch \`${spec.branchName}\``), `${spec.id}: the branch for create_pull_request`);
    for (const file of edge.allowedFiles) assert.ok(section(body, "Files you may change").includes(`\`${file}\``), `${spec.id}: editable ${file}`);
    for (const file of edge.immutableGates.zeroDiffPaths) assert.ok(section(body, "Files you must not change").includes(`\`${file}\``), `${spec.id}: forbidden ${file}`);
    const evidence = section(body, "Evidence");
    for (const name of ["dispatch-inputs.json", "upstream-diff.txt", "existing-pr.json", "preflight-exit-codes.txt"]) assert.ok(evidence.includes(`\`${name}\``), `${spec.id}: evidence ${name}`);
    assert.ok(evidence.includes("`/tmp/gh-aw/agent/`"), `${spec.id}: the artifact directory`);
    for (const report of edge.adaptation?.preflightReports ?? []) assert.ok(evidence.includes(`\`${report}\``), `${spec.id}: report ${report}`);
    const flat = body.replace(/\s+/g, " ");
    assert.ok(flat.includes("Run these from `$GITHUB_WORKSPACE/portfolio`, in this order, after your edits"), `${spec.id}: the order of the commands`);
    assert.ok(body.indexOf("git commit") < body.indexOf("create_pull_request"), `${spec.id}: the commit comes first`);
    assert.ok(flat.includes("leave the worktree clean and make no commit"), `${spec.id}: nothing to adapt`);
    assert.ok(flat.includes("leave the worktree exactly as it is"), `${spec.id}: noop leaves the worktree as it is`);
    assert.ok(flat.includes("Its body lists `previous_sha..upstream_sha`, the `correlation_id` of `dispatch-inputs.json`, the adapted modules and Studio labs, and anything a reviewer must check by hand"), `${spec.id}: the pull-request body`);
  }
  assert.ok(bodyOf(SHOWCASE).replace(/\s+/g, " ").includes("Note any RUNS id change in the pull request body so that pipeline-demo.svg can be re-stitched by hand"));
});

test("AC75: no prompt tells the agent to merge, to push or to write anything under upstream/ (they say the opposite), and no command of a prompt touches the upstream checkout except to read it", () => {
  for (const spec of AI) {
    const body = bodyOf(spec);
    for (const banned of ["git push", "gh pr merge", "--force", "auto-merge", "--no-verify"]) assert.equal(body.includes(banned), false, `${spec.id}: ${banned}`);
    assert.ok(body.includes("Do not edit anything under `upstream/`"), spec.id);
    assert.ok(body.includes("do not publish branches yourself"), spec.id);
    const block = promptBlock(body);
    for (const line of block.split("\n")) {
      assert.equal(/(>|>>)\s*\S*upstream/.test(line), false, `${spec.id}: a redirect into the upstream checkout: ${line}`);
      assert.equal(/^(?:git\s+-C\s+\S*upstream|rm\b|mv\b|cp\b|touch\b|sed\s+-i)/.test(line.trim()) && /upstream/.test(line), false, `${spec.id}: ${line}`);
    }
    // $UPSTREAM_DIR is only ever an argument of the checks and the helpers, which read it
    for (const line of block.split("\n").filter((candidate) => candidate.includes("$UPSTREAM_DIR"))) {
      assert.match(line, /^(?:npm run sync:workshop-source -- |node "\$GITHUB_WORKSPACE\/scripts\/lab-studio-drift\.mjs" )/, `${spec.id}: ${line}`);
    }
  }
});
