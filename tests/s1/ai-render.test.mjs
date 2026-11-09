// AC43, AC44, AC45, AC51, AC53 and AC70: the AI adaptation workflows of contract C4.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, edgeOf, fixture, mutate, parseWorkflow, presetManifest, readText, readWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const IDENTITIES = [
  { edgeId: "copilot-lab", upstreamKey: "copilot-lab", branchName: "sdlc/cascade-copilot-lab", closeOlderKey: "sdlc-cascade-copilot-lab", concurrencyGroup: "sdlc-state-copilot-lab", repo: "day-in-the-life-copilot-lab" },
  { edgeId: "pipeline-showcase", upstreamKey: "pipeline-showcase", branchName: "sdlc/cascade-pipeline-showcase", closeOlderKey: "sdlc-cascade-pipeline-showcase", concurrencyGroup: "sdlc-state-pipeline-showcase", repo: "github-pipeline-showcase" },
  { edgeId: "github-intermediate", upstreamKey: "github-intermediate", branchName: "sdlc/cascade-github-intermediate", closeOlderKey: "sdlc-cascade-github-intermediate", concurrencyGroup: "sdlc-state-github-intermediate", repo: "gh-github-intermediate-template" },
];
const fillCheckout = (command) => command.split("<checkout>").join('"$UPSTREAM_DIR"');
const workflowOf = (identity) => readWorkflow(`cascade-ai-${identity.edgeId}.md`);

test("AC43: each AI workflow's four identity values equal the strings of the preset", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const { frontmatter, body } = workflowOf(identity);
    assert.equal(edge.upstreamKey, identity.upstreamKey);
    assert.equal(edge.branchName, identity.branchName);
    assert.equal(edge.closeOlderKey, identity.closeOlderKey);
    assert.equal(frontmatter.concurrency.group, identity.concurrencyGroup);
    assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"], identity.closeOlderKey);
    assert.ok(body.includes(identity.branchName), `${identity.edgeId}: the body names the branch`);
    assert.ok(frontmatter["pre-agent-steps"][1].run.includes(`echo "BRANCH_NAME=${identity.branchName}"`), `${identity.edgeId}: BRANCH_NAME is exported`);
    assert.equal(frontmatter.concurrency["cancel-in-progress"], false);
  }
});

test("AC43: the AI workflows are the only cascade-ai files of the preset and the golden files equal the fresh render", () => {
  const rendered = renderFleet(request);
  const names = [...rendered.files.keys()].filter((file) => /cascade-ai-[^/]+\.md$/.test(file));
  assert.deepEqual(names, IDENTITIES.map((identity) => `${W}/cascade-ai-${identity.edgeId}.md`).sort());
  for (const name of names) {
    const base = name.split("/").pop();
    assert.equal(rendered.files.get(name), readText(fixture("golden", base)), `${base}: golden`);
    assert.equal(readText(abs(name)), rendered.files.get(name), `${base}: committed`);
  }
});

test("AC44: on is workflow_dispatch with the ten string inputs of contract C7, plus on.bots", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter } = workflowOf(identity);
    assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "workflow_dispatch"]);
    assert.deepEqual(frontmatter.on.bots, ["mfg-msft-ai-sdlc[bot]"]);
    const inputs = frontmatter.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs).sort(), [
      "correlation_id", "downstream_repo", "dry_run", "on_commit_only_advance", "previous_sha", "sync_scope", "upstream_etag", "upstream_pr_number", "upstream_repo", "upstream_sha",
    ]);
    for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", `${identity.edgeId}.${name}`);
  }
});

test("AC44: concurrency, engine, permissions and the two checkouts (one current, the upstream pinned with full history)", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter } = workflowOf(identity);
    assert.deepEqual(frontmatter.concurrency, { group: identity.concurrencyGroup, "cancel-in-progress": false });
    assert.ok(frontmatter.engine);
    assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
    const edge = edgeOf(preset, identity.edgeId);
    assert.deepEqual(frontmatter.checkout, [
      { repository: "johnhain-msft/portfolio", path: "portfolio", current: true, "github-app": { ...APP, repositories: ["portfolio"] } },
      { repository: edge.upstreamRepo, path: `upstream/${identity.repo}`, ref: "${{ inputs.upstream_sha }}", "fetch-depth": 0, "github-app": { ...APP, repositories: [identity.repo] } },
    ]);
    assert.equal(frontmatter.checkout.filter((entry) => entry.current === true).length, 1);
  }
});

test("AC44: steps set up Node.js 24, run npm ci --include=dev at the root and in apps/lab-studio in that order, and set up Edge", () => {
  for (const identity of IDENTITIES) {
    const { steps } = workflowOf(identity).frontmatter;
    assert.equal(steps[0].uses, "actions/setup-node@v4");
    assert.equal(steps[0].with["node-version"], "24");
    assert.deepEqual([steps[1].run, steps[1]["working-directory"]], ["npm ci --include=dev", "portfolio"]);
    assert.deepEqual([steps[2].run, steps[2]["working-directory"]], ["npm ci --include=dev", "portfolio/apps/lab-studio"]);
    assert.ok(/msedge/.test(steps[3].run));
    assert.equal(steps.length, 4);
  }
});

test("AC44: pre-agent-steps are, in order, the validation, the BASE_SHA step, the drift-capture hooks and the clean-tree guard", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const steps = workflowOf(identity).frontmatter["pre-agent-steps"];
    assert.equal(steps.length, 4, identity.edgeId);
    const [validate, base, capture, guard] = steps;
    assert.ok(validate.run.includes("^[0-9a-f]{40}$") && validate.run.includes("sync_scope") && validate.run.includes(edge.upstreamRepo), `${identity.edgeId}: validation`);
    assert.ok(validate.run.includes(`git -C "$GITHUB_WORKSPACE/upstream/${identity.repo}" rev-parse HEAD`), "the upstream checkout is verified at upstream_sha");
    const baseRun = base.run;
    assert.ok(baseRun.includes('BASE_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"'));
    assert.ok(baseRun.includes("/tmp/gh-aw/base-sha.txt"));
    assert.ok(
      baseRun.includes(`{ echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=${edge.branchName}"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/${identity.repo}"; } >> "$GITHUB_ENV"`),
      `${identity.edgeId}: the five variables are appended to GITHUB_ENV`,
    );
    for (const artifact of ["upstream-diff.txt", "dispatch-inputs.json", "existing-pr.json"]) assert.ok(baseRun.includes(`/tmp/gh-aw/agent/${artifact}`), artifact);
    assert.equal(base.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}");
    assert.equal(base.env.PREVIOUS_SHA, "${{ inputs.previous_sha }}");
    for (const command of edge.preflightCommands) assert.ok(capture.run.includes(fillCheckout(command).replace(/"\$UPSTREAM_DIR"/g, '"$UPSTREAM_DIR"')) || capture.run.includes(command.split("<checkout>").join('"$UPSTREAM_DIR"')), `${identity.edgeId}: ${command}`);
    const writes = [...capture.run.matchAll(/>\s*(\/[^\s"']+)/g)].map((match) => match[1]);
    assert.ok(writes.length > 0, "the capture hooks write artifacts");
    for (const target of writes) assert.ok(target.startsWith("/tmp/gh-aw/agent/"), `${identity.edgeId}: ${target} is under /tmp/gh-aw/agent/`);
    assert.ok(guard.run.includes('git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain'));
    assert.ok(guard.run.includes("exit 1"));
  }
});

test("AC45: the create-pull-request handler equals the AI shape for the three preset workflows, deep equal", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const expected = {
      "target-repo": edge.downstreamRepo,
      "title-prefix": "feat(cascade): ",
      labels: ["automated", "sdlc-cascade", "ai-adapted", "needs-review"],
      reviewers: edge.reviewers,
      draft: false,
      "preserve-branch-name": true,
      "recreate-ref": true,
      "close-older-pull-requests": true,
      "close-older-key": edge.closeOlderKey,
      "if-no-changes": "ignore",
      "auto-merge": false,
      "fallback-as-issue": false,
      "allowed-files": edge.allowedFiles,
      "exclude-lock-yml": true,
      "protected-files": { policy: "blocked", exclude: edge.protectedFilesExclude },
      max: 1,
    };
    const outputs = workflowOf(identity).frontmatter["safe-outputs"];
    assert.deepEqual(outputs["create-pull-request"], expected, identity.edgeId);
    assert.deepEqual(outputs["github-app"], { ...APP, repositories: ["${{ github.event.repository.name }}", "portfolio"] });
    assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false });
  }
});

test("AC45: no AI workflow can fall back to an issue and none has staging or allow-workflows", () => {
  for (const identity of IDENTITIES) {
    const text = readText(abs(W, `cascade-ai-${identity.edgeId}.md`));
    assert.equal(text.includes("fallback-as-issue: true"), false);
    assert.equal(/staged|allow-workflows/.test(text), false);
  }
});

test("AC53: the first post-step reads the base, records the head, writes cascade-shas.json and appends both values", () => {
  for (const identity of IDENTITIES) {
    const run = workflowOf(identity).frontmatter["post-steps"][0].run;
    const parts = [
      'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
      "exit 1",
      'AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/portfolio" rev-parse HEAD)"',
      "/tmp/gh-aw/cascade-shas.json",
      '{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"',
    ];
    const positions = parts.map((part) => run.indexOf(part));
    assert.ok(positions.every((position) => position >= 0), `${identity.edgeId}: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(run.includes('{"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}'));
    assert.ok(run.includes("^[0-9a-f]{40}$"));
  }
});

test("AC53: then the artifact upload, the helper with the workflow's own id and $BASE_SHA, then the edge's verifyCommands in order", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const steps = workflowOf(identity).frontmatter["post-steps"];
    assert.equal(steps[1].uses, "actions/upload-artifact@v4");
    assert.equal(steps[1].with.name, "sdlc-cascade-shas-${{ github.run_id }}");
    assert.equal(
      steps[2].run,
      `node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --base "$BASE_SHA" --workflow cascade-ai-${identity.edgeId}`,
    );
    const after = steps.slice(3);
    assert.equal(after.length, edge.verifyCommands.length, identity.edgeId);
    edge.verifyCommands.forEach((command, index) => {
      const step = after[index];
      if (command.trimStart().startsWith("#")) assert.equal(step.run.trim(), fillCheckout(command).trim(), `${identity.edgeId}: post-run check ${index}`);
      else if (command === 'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain') {
        assert.equal(step.name, command);
        assert.ok(step.run.includes("status --porcelain") && step.run.includes("exit 1"));
      } else assert.equal(step.run, command, `${identity.edgeId}: ${command}`);
      assert.equal("continue-on-error" in step, false);
      assert.equal("if" in step, false);
    });
  }
});

test("AC53: verifyCommands are rendered verbatim and in manifest order wherever a post-run check sits among them", () => {
  const isPostRunCheck = (command) => command.trimStart().startsWith("#");
  const cleanTreeCheck = 'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain';
  const reordered = mutate(preset, (copy) => {
    const edge = edgeOf(copy, "github-intermediate");
    const checks = edge.verifyCommands.filter(isPostRunCheck);
    const gates = edge.verifyCommands.filter((command) => !isPostRunCheck(command));
    assert.equal(checks.length, 3, "the preset edge has three post-run checks to move around");
    // one check first, one between the build commands and the lint, and the last one at the end
    edge.verifyCommands = [checks[0], ...gates.slice(0, 4), checks[1], ...gates.slice(4), checks[2]];
  });
  const edge = edgeOf(reordered, "github-intermediate");
  assert.ok(isPostRunCheck(edge.verifyCommands[0]) && isPostRunCheck(edge.verifyCommands[5]) && isPostRunCheck(edge.verifyCommands.at(-1)));
  const workspace = createWorkspace({ manifestText: toYaml(reordered), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const steps = parseWorkflow(result.files.get(`${W}/cascade-ai-github-intermediate.md`)).frontmatter["post-steps"].slice(3);
    assert.equal(steps.length, edge.verifyCommands.length);
    edge.verifyCommands.forEach((command, index) => {
      const step = steps[index];
      if (command === cleanTreeCheck) {
        assert.equal(step.name, command, `position ${index}`);
        assert.ok(step.run.includes("status --porcelain") && step.run.includes("exit 1"), `position ${index}`);
      } else {
        assert.equal(step.run.trim(), fillCheckout(command).trim(), `position ${index}: ${command.split("\n")[0]}`);
      }
    });
    assert.ok(steps[0].run.includes("# post-run check: a dry run must not leave a commit"), "the check that the manifest lists first runs first");
  } finally {
    workspace.cleanup();
  }
});

test("AC53: the helper carries the downstream checkout path when the downstream repository has another name", () => {
  const manifest = mutate(preset, (copy) => {
    for (const edge of copy.dependencyEdges) edge.downstreamRepo = "johnhain-msft/site";
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const { frontmatter } = parseWorkflow(result.files.get(`${W}/cascade-ai-copilot-lab.md`));
    assert.ok(frontmatter["post-steps"][2].run.includes('--portfolio "$GITHUB_WORKSPACE/site"'));
    assert.equal(frontmatter.checkout[0].path, "site");
    assert.ok(frontmatter["post-steps"][0].run.includes('git -C "$GITHUB_WORKSPACE/site" rev-parse HEAD'));
  } finally {
    workspace.cleanup();
  }
});

test("AC70: each body carries the instructions, accept and build commands, the range, allowed and locked paths and the branch", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const { body } = workflowOf(identity);
    assert.ok(body.includes(edge.adaptationInstructions.replace(/\s+/g, " ").trim()), `${identity.edgeId}: adaptationInstructions`);
    for (const command of [...edge.acceptCommands, ...edge.buildCommands]) assert.ok(body.includes(fillCheckout(command).trim()), `${identity.edgeId}: ${command}`);
    assert.ok(body.includes("previous_sha..upstream_sha"));
    for (const entry of edge.allowedFiles) assert.ok(body.includes(`\`${entry}\``), `${identity.edgeId}: allowed ${entry}`);
    for (const entry of edge.immutableGates.zeroDiffPaths) assert.ok(body.includes(`\`${entry}\``), `${identity.edgeId}: locked ${entry}`);
    assert.ok(body.includes(edge.branchName));
    assert.equal(body.includes("<checkout>"), false);
  }
});

test("AC70: editing only adaptationInstructions in a fixture manifest changes only the body of that workflow", () => {
  const edited = mutate(preset, (copy) => {
    edgeOf(copy, "copilot-lab").adaptationInstructions = "A different instruction text for the Copilot lab edge.";
  });
  const workspaceA = createWorkspace({ manifestText: toYaml(preset), instructions: true });
  const workspaceB = createWorkspace({ manifestText: toYaml(edited), instructions: true });
  try {
    const before = renderFleet(request, { cwd: workspaceA.dir });
    const after = renderFleet(request, { cwd: workspaceB.dir });
    assert.ok(before.ok && after.ok);
    const changed = [...before.files.keys()].filter((name) => before.files.get(name) !== after.files.get(name));
    assert.deepEqual(changed, [`${W}/cascade-ai-copilot-lab.md`]);
    const a = parseWorkflow(before.files.get(changed[0]));
    const b = parseWorkflow(after.files.get(changed[0]));
    assert.equal(a.frontmatterText, b.frontmatterText, "the frontmatter is unchanged");
    assert.notEqual(a.body, b.body);
    assert.ok(b.body.includes("A different instruction text for the Copilot lab edge."));
  } finally {
    workspaceA.cleanup();
    workspaceB.cleanup();
  }
});

test("AC51: reconcile never creates, modifies or deletes the three S4 scripts and only references them from rendered steps and the body", async () => {
  const scripts = ["src/lab-studio-drift.mjs", "src/bump-studio-revision-pins.mjs", "src/verify-immutable-gates.mjs"];
  const files = Object.fromEntries(scripts.map((script) => [script, `// sentinel for ${script}\n`]));
  const workspace = createWorkspace({ files });
  try {
    const before = workspace.hash(["src"]);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(workspace.hash(["src"]), before);
    for (const script of scripts) assert.equal(workspace.read(script), files[script]);
    for (const identity of IDENTITIES) {
      const { frontmatter } = parseWorkflow(workspace.read(`${W}/cascade-ai-${identity.edgeId}.md`));
      const { "pre-agent-steps": pre, "post-steps": post, ...rest } = frontmatter;
      assert.equal(/lab-studio-drift|bump-studio-revision-pins|verify-immutable-gates/.test(JSON.stringify(rest)), false, `${identity.edgeId}: referenced only from pre-agent-steps and post-steps`);
      assert.ok(JSON.stringify(post).includes("verify-immutable-gates.mjs"));
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC51: the AI workflows render no write to SDLC_SYNC_STATE outside the two jobs of AC49", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter, body } = workflowOf(identity);
    const { jobs, ...outside } = frontmatter;
    assert.equal(/SDLC_SYNC_STATE|update-poll-state|gh variable/.test(JSON.stringify(outside) + body), false, identity.edgeId);
  }
});
