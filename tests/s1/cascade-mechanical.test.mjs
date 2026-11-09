// AC32 and AC34: the mechanical cascade workflow .github/workflows/cascade-mechanical-ghec-admin.md.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, customJobsOf, edgeOf, fixture, mutate, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const NAME = "cascade-mechanical-ghec-admin.md";
const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const edge = edgeOf(preset, "ghec-admin");
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const scoped = (...repositories) => ({ ...APP, repositories });

const committed = readWorkflow(NAME);
const fresh = parseWorkflow(renderFleet(request).files.get(`${W}/${NAME}`));
const { frontmatter } = committed;

test("AC32: the committed file and the golden file equal the fresh render byte for byte", () => {
  const text = renderFleet(request).files.get(`${W}/${NAME}`);
  assert.equal(readText(abs(W, NAME)), text);
  assert.equal(readText(fixture("golden", NAME)), text);
});

test("AC32: the second mechanical workflow of the preset, the self-cascade of this repository into the portfolio, equals its golden file and its fresh render", () => {
  const name = "cascade-mechanical-ai-sdlc.md";
  const text = renderFleet(request).files.get(`${W}/${name}`);
  assert.equal(readText(abs(W, name)), text);
  assert.equal(readText(fixture("golden", name)), text);
  const self = readWorkflow(name);
  assert.equal(self.frontmatter.concurrency.group, "sdlc-state-ai-sdlc");
  assert.deepEqual(self.frontmatter.checkout.map((entry) => entry.repository), ["johnhain-msft/portfolio", "johnhain-msft/mfg_msft_ai_sdlc"]);
  assert.deepEqual(self.frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], ["public/ai-sdlc/**"]);
  assert.ok(self.body.includes('npm run import:ai-sdlc -- "$UPSTREAM_DIR"'));
  assert.ok(self.body.includes("sdlc/cascade-ai-sdlc"));
});

test("AC32: concurrency is the workflow-level sdlc-state group of the upstream key", () => {
  assert.deepEqual(frontmatter.concurrency, { group: "sdlc-state-gh-admin-msft", "cancel-in-progress": false });
});

test("AC32: on carries on.bots and exactly the eight string workflow_dispatch inputs of the mechanical dispatch", () => {
  assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "workflow_dispatch"]);
  assert.deepEqual(frontmatter.on.bots, ["mfg-msft-ai-sdlc[bot]"]);
  const inputs = frontmatter.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), [
    "correlation_id", "downstream_repo", "dry_run", "previous_sha", "upstream_etag", "upstream_pr_number", "upstream_repo", "upstream_sha",
  ]);
  for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", name);
});

test("AC32: permissions are the read-only set of AC22 and an engine key is rendered", () => {
  assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.ok(frontmatter.engine);
  assert.deepEqual(frontmatter.network, { allowed: [] });
});

test("AC32: checkout holds the downstream (current) and the upstream pinned to upstream_sha, each with github-app credentials scoped to its own repository", () => {
  assert.deepEqual(frontmatter.checkout, [
    { repository: "johnhain-msft/portfolio", path: "portfolio", current: true, "github-app": scoped("portfolio") },
    { repository: "johnhain-msft/gh-admin-msft", path: "upstream/gh-admin-msft", ref: "${{ inputs.upstream_sha }}", "github-app": scoped("gh-admin-msft") },
  ]);
  assert.equal(frontmatter.checkout.filter((entry) => entry.current === true).length, 1);
});

test("AC32: steps set up Node.js 24, run npm ci --include=dev in portfolio and portfolio/apps/lab-studio, and set up Microsoft Edge", () => {
  const steps = frontmatter.steps;
  assert.equal(steps[0].uses, "actions/setup-node@v4");
  assert.equal(steps[0].with["node-version"], "24");
  assert.deepEqual([steps[1].run, steps[1]["working-directory"]], ["npm ci --include=dev", "portfolio"]);
  assert.deepEqual([steps[2].run, steps[2]["working-directory"]], ["npm ci --include=dev", "portfolio/apps/lab-studio"]);
  assert.ok(/msedge/.test(steps[3].run) && /Edge/.test(steps[3].name));
  assert.equal(steps.length, 4);
});

test("AC32: pre-agent-steps is one read-only step that validates the two revisions, records the base and exports five variables", () => {
  const steps = frontmatter["pre-agent-steps"];
  assert.equal(steps.length, 1);
  const [step] = steps;
  assert.deepEqual(step.env, { UPSTREAM_SHA: "${{ inputs.upstream_sha }}", PREVIOUS_SHA: "${{ inputs.previous_sha }}" });
  const run = step.run;
  const append = '{ echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=sdlc/cascade-ghec-admin"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/gh-admin-msft"; } >> "$GITHUB_ENV"';
  for (const text of [
    '^[0-9a-f]{40}$',
    '"$UPSTREAM_SHA"',
    '"$PREVIOUS_SHA"',
    "exit 2",
    'BASE_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"',
    "/tmp/gh-aw/base-sha.txt",
    append,
  ]) {
    assert.ok(run.includes(text), `the step contains ${text}`);
  }
  assert.ok(run.indexOf("exit 2") < run.indexOf(append), "the hexadecimal check precedes the append");
  assert.ok(run.indexOf("exit 2") < run.indexOf("rev-parse HEAD"), "the checks precede the recording");
  assert.equal(/git[^\n]*(checkout|reset|clean|commit|apply|merge|rebase|add )/.test(run), false, "nothing in portfolio is modified");
  assert.equal(/\bgit -C "\$GITHUB_WORKSPACE\/portfolio" (checkout|reset|clean|commit)/.test(run), false);
});

test("AC32: the first post-step records the revisions in one shell, writes cascade-shas.json and appends both values to GITHUB_ENV", () => {
  const first = frontmatter["post-steps"][0];
  assert.equal(typeof first.run, "string");
  const run = first.run;
  const at = (text) => {
    const index = run.indexOf(text);
    assert.ok(index >= 0, `the first post-step contains ${text}`);
    return index;
  };
  const order = [
    at('BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"'),
    at("exit 1"),
    at('AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"'),
    at("/tmp/gh-aw/cascade-shas.json"),
    at('{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"'),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the parts appear in the specified order");
  assert.ok(run.includes('{"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}'));
  const json = JSON.parse(run.match(/(\{"baseSha":[^\n]*\})/)[1].replace(/\$[A-Z_]+/g, "x"));
  assert.deepEqual(Object.keys(json).sort(), ["baseSha", "headSha"]);
  assert.ok(run.includes("^[0-9a-f]{40}$"), "a damaged base-sha.txt cannot add a line to GITHUB_ENV");
});

test("AC32: then the artifact upload, the clean-tree check, the changed-paths check, the import check, buildCommands and verifyCommands, in that order", () => {
  const steps = frontmatter["post-steps"];
  assert.equal(steps[1].uses, "actions/upload-artifact@v4");
  assert.equal(steps[1].with.name, "sdlc-cascade-shas-${{ github.run_id }}");
  assert.equal(steps[1].with.path, "/tmp/gh-aw/cascade-shas.json");
  assert.ok(steps[2].run.includes('git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain'));
  assert.ok(steps[2].run.includes("exit 1"), "a dirty tree fails the step");
  assert.ok(steps[3].run.includes('git -C "$GITHUB_WORKSPACE/portfolio" diff --name-only --no-renames "$BASE_SHA" HEAD'), "renames are not detected, so that the deletion of a file outside the allowed files cannot hide behind the move of it into them");
  assert.ok(steps[3].run.includes("allowed='^(public/ghec-admin/.*)$'"), "only paths covered by allowedFiles pass: the entry's `**` is `.*`");
  assert.equal(/\bcase\b/.test(steps[3].run), false, "no shell case pattern, whose `*` would also cross directories");
  // the importer throws before its first write, so a failed import leaves a clean tree and no commit: the check that comes next is what fails the job (SPEC-03 AC62)
  assert.equal(steps[4].name, "Verify the import recorded the upstream revision");
  assert.deepEqual(steps[4].env, { PROVENANCE_FILE: edge.provenanceFile, PROVENANCE_POINTER: edge.provenanceJsonPointer }, "the edge's data reaches the script through the environment, never through its text");
  assert.equal(steps[4].run.includes(edge.provenanceFile), false);
  assert.ok(steps[4].run.includes("process.env.UPSTREAM_SHA"));
  assert.deepEqual(steps.slice(5).map((step) => step.run), [...edge.buildCommands, ...edge.verifyCommands]);
  for (const step of steps.slice(5)) {
    assert.equal(step["working-directory"], "portfolio");
    assert.equal("continue-on-error" in step, false);
    assert.equal("if" in step, false);
  }
});

test("AC32: the prompt body lists the importCommands with \"$UPSTREAM_DIR\" and no relative upstream/ path", () => {
  const { body } = committed;
  assert.ok(body.includes('npm run import:ghec-admin -- "$UPSTREAM_DIR"'));
  assert.equal(body.includes("<checkout>"), false);
  assert.equal(/(^|[^/$\w])upstream\//.test(body), false, "no relative upstream/ path");
  const commands = [...body.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]).join("\n");
  assert.equal(/upstream\//.test(commands), false);
  assert.ok(body.includes("sdlc/cascade-ghec-admin"), "the body names the branch");
});

test("AC32: jobs holds exactly finalize_poll_state and escalate_failure and permissions equal the AC22 set", () => {
  assert.deepEqual(Object.keys(customJobsOf(frontmatter.jobs)).sort(), ["escalate_failure", "finalize_poll_state"]);
  assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
});

test("AC32: a fresh render in a different repository has the same shape with its own values", () => {
  const manifest = mutate(presetManifest(), (copy) => {
    const ghec = edgeOf(copy, "ghec-admin");
    ghec.upstreamRepo = "acme-labs/other-source";
    ghec.upstreamKey = "other-source";
    ghec.upstreamSlug = "OTHER_SOURCE";
    ghec.stateVariable = "SDLC_SYNC_STATE_OTHER_SOURCE";
    copy.projects.find((project) => project.projectKey === "gh-admin-msft").repo = "acme-labs/other-source";
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const { frontmatter: other, body } = parseWorkflow(result.files.get(`${W}/${NAME}`));
    assert.equal(other.concurrency.group, "sdlc-state-other-source");
    assert.equal(other.checkout[1].path, "upstream/other-source");
    assert.ok(other["pre-agent-steps"][0].run.includes("UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/other-source"));
    assert.ok(body.includes("acme-labs/other-source"));
    assert.equal(JSON.stringify(other).includes("gh-admin-msft"), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC34: the create-pull-request handler equals the mechanical shape, deep equal", () => {
  const expected = {
    "target-repo": "johnhain-msft/portfolio",
    "title-prefix": "chore(cascade): ",
    labels: ["automated", "sdlc-cascade", "needs-review"],
    reviewers: ["johnhain-msft"],
    draft: false,
    "preserve-branch-name": true,
    "recreate-ref": true,
    "close-older-pull-requests": true,
    "close-older-key": "sdlc-cascade-ghec-admin",
    "if-no-changes": "ignore",
    "auto-merge": false,
    "fallback-as-issue": false,
    "allowed-files": ["public/ghec-admin/**"],
    "exclude-lock-yml": true,
    "protected-files": { policy: "blocked", exclude: [] },
    max: 1,
    "max-patch-size": 10240,
  };
  for (const { frontmatter: candidate } of [committed, fresh]) {
    assert.deepEqual(candidate["safe-outputs"]["create-pull-request"], expected);
    assert.deepEqual(candidate["safe-outputs"]["github-app"], scoped("${{ github.event.repository.name }}", "portfolio"));
    assert.deepEqual(candidate["safe-outputs"]["threat-detection"], { "continue-on-error": false });
    assert.deepEqual(Object.keys(candidate["safe-outputs"]).sort(), ["create-pull-request", "github-app", "threat-detection"]);
  }
});

test("AC34: target-repo, reviewers, close-older-key and allowed-files come from the edge", () => {
  const manifest = mutate(presetManifest(), (copy) => {
    const ghec = edgeOf(copy, "ghec-admin");
    ghec.reviewers = ["reviewer-one", "reviewer-two"];
    ghec.closeOlderKey = "custom-close-key";
    ghec.allowedFiles = ["public/ghec-admin/**", "public/extra.json"];
    ghec.protectedFilesExclude = ["/CHANGELOG.md"];
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const handler = parseWorkflow(result.files.get(`${W}/${NAME}`)).frontmatter["safe-outputs"]["create-pull-request"];
    assert.deepEqual(handler.reviewers, ["reviewer-one", "reviewer-two"]);
    assert.equal(handler["close-older-key"], "custom-close-key");
    assert.deepEqual(handler["allowed-files"], ["public/ghec-admin/**", "public/extra.json"]);
    assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: ["/CHANGELOG.md"] });
  } finally {
    workspace.cleanup();
  }
});

test("AC34: a mechanical handler raises the patch size limit to 10240 KB for the generated bundles that an import commits; an AI adaptation handler keeps the default", () => {
  for (const { frontmatter: candidate } of [committed, fresh]) {
    assert.equal(candidate["safe-outputs"]["create-pull-request"]["max-patch-size"], 10240);
  }
  const rendered = renderFleet(request).files;
  for (const edgeId of ["copilot-lab", "pipeline-showcase", "github-intermediate"]) {
    const handler = parseWorkflow(rendered.get(`${W}/cascade-ai-${edgeId}.md`)).frontmatter["safe-outputs"]["create-pull-request"];
    assert.equal(Object.hasOwn(handler, "max-patch-size"), false, edgeId);
  }
});

test("AC32: the agent may cd into the downstream checkout, as the prompt tells it to, and run echo, git, node and the first word of every import and build command", () => {
  assert.deepEqual(frontmatter.tools.bash, ["cat", "cd", "date", "echo", "find", "git", "grep", "head", "ls", "node", "npm", "tail", "wc"]);
  assert.ok(committed.body.includes('cd "$GITHUB_WORKSPACE/portfolio"'), "the prompt begins with the cd that the allowlist has to permit");
  for (const tool of ["gh", "curl", "wget"]) assert.equal(frontmatter.tools.bash.includes(tool), false, tool);
});
