// AC2, AC12-AC15 (data), AC24 (scopes), AC51 (provenance files) and AC60-AC68 (commands of the edges): the two ai-adaptation edges of the preset sdlc.yaml.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { engineFile } from "../helpers/instance.mjs";
import { readJson } from "./helpers/fixtures.mjs";
import { AI, ALL_SCOPES, DOWNSTREAM, edgeOf, manifest } from "./helpers/workflows.mjs";

const aiEdges = () => manifest().dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");

const ZERO_DIFF = [
  "experiences/copilot-workshop/content/rules.ts",
  "experiences/copilot-workshop/content/source.ts",
  "experiences/copilot-workshop/content/types.ts",
  "experiences/copilot-workshop/src",
  "src",
  "scripts",
  "tests/auth.test.ts",
  "tests/runtime.test.ts",
  "tests/catalog.test.ts",
  "tests/copilot-workshop-geometry.test.ts",
  "tests/copilot-workshop-runtime.test.ts",
  "apps/lab-studio/server/src/index.ts",
  "apps/lab-studio/server/src/copilot-bridge.ts",
  "apps/lab-studio/server/src/sandbox.ts",
  "apps/lab-studio/server/src/sim-terminal.ts",
  "apps/lab-studio/server/src/skills.ts",
  "apps/lab-studio/server/tests/sandbox.test.ts",
  "apps/lab-studio/client/src/hosted.ts",
  "apps/lab-studio/client/src/components/AccountBar.tsx",
];

const ALLOWED = {
  "copilot-lab": [
    "README.md",
    "public/copilot-project.html",
    "experiences/copilot-workshop/content/index.ts",
    "experiences/copilot-workshop/content/interludes.ts",
    "experiences/copilot-workshop/content/lab-pace.ts",
    "experiences/copilot-workshop/content/m*.ts",
    "experiences/copilot-workshop/provenance.json",
    "experiences/copilot-workshop/source-inputs.json",
    "experiences/copilot-workshop/public/LICENSE",
    "experiences/copilot-workshop/public/NOTICE.txt",
    "public/workshop/**",
    "tests/copilot-workshop.test.ts",
    "apps/lab-studio/lab-sources.json",
    "apps/lab-studio/README.md",
    "apps/lab-studio/client/src/labs/**",
    "apps/lab-studio/client/src/components/Home.tsx",
    "apps/lab-studio/client/src/components/Manual.tsx",
    "apps/lab-studio/client/src/components/Rail.tsx",
    "apps/lab-studio/client/src/styles.css",
    "apps/lab-studio/server/src/verify.ts",
    "apps/lab-studio/server/tests/source.test.ts",
    "apps/lab-studio/server/tests/lab-drift.test.ts",
    "apps/lab-studio/server/tests/lesson-content.test.ts",
  ],
  "pipeline-showcase": [
    "experiences/pipeline-showcase/content/provenance.json",
    "experiences/pipeline-showcase/capture/fetch-run-data.mjs",
    "experiences/pipeline-showcase/content/run-data.json",
    "public/pipeline-showcase/**",
    "tests/pipeline-showcase.test.ts",
  ],
};

const TEN_COMMANDS = [
  "npm run build:workshop",
  "npm run build:experiences",
  'git -C "$GITHUB_WORKSPACE/portfolio" status --porcelain',
  "npm run build",
  "STUDIO_ORIGIN=https://studio.example.com npm run build:catalog",
  "npm run typecheck",
  "npm run lint",
  "npm test",
  "npm run test:studio",
  "npx playwright test tests/browser/sites.spec.ts",
];

const POST_RUN = {
  "copilot-lab": [
    "a dry run must not leave a commit",
    "committed provenance records upstream_sha",
    "Studio UI preserves hosted session and lesson wiring",
    "the upstream checkout stays read-only",
  ],
  "pipeline-showcase": [
    "a dry run must not leave a commit",
    "a changed RUNS list needs a re-captured run-data.json",
    "committed provenance records upstream_sha",
    "the upstream checkout stays read-only",
  ],
};

test("AC2: the preset has exactly two ai-adaptation edges, both into johnhain-msft/portfolio, with the keys, slugs and upstream repositories of the spec", () => {
  const edges = aiEdges();
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.map((edge) => edge.edgeId), AI.map((spec) => spec.edgeId));
  for (const spec of AI) {
    const edge = edgeOf(spec);
    assert.equal(edge.downstreamRepo, DOWNSTREAM, spec.id);
    assert.equal(edge.upstreamRepo, spec.upstreamRepo, spec.id);
    assert.equal(edge.upstreamKey, spec.upstreamKey, spec.id);
    assert.equal(edge.upstreamSlug, spec.upstreamSlug, spec.id);
    assert.equal(edge.stateVariable, `SDLC_SYNC_STATE_${spec.upstreamSlug}`, spec.id);
  }
});

test("AC2: every edge carries the data its workflow needs, and none of it is empty", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    for (const field of ["preflightCommands", "acceptCommands", "buildCommands", "verifyCommands", "allowedFiles"]) {
      assert.ok(Array.isArray(edge[field]) && edge[field].length > 0, `${spec.id}.${field}`);
      for (const command of edge[field]) assert.equal(typeof command, "string", `${spec.id}.${field}`), assert.notEqual(command.trim(), "", `${spec.id}.${field}`);
    }
    assert.ok(typeof edge.adaptationInstructions === "string" && edge.adaptationInstructions.trim() !== "", `${spec.id}.adaptationInstructions`);
    const gates = edge.immutableGates;
    assert.ok(gates.zeroDiffPaths.length > 0, `${spec.id}.immutableGates.zeroDiffPaths`);
    assert.ok(Array.isArray(gates.lockedTestBlocks) && gates.lockedTestBlocks.length > 0, `${spec.id}.immutableGates.lockedTestBlocks`);
    assert.ok(gates.inProcessInvariants && Object.keys(gates.inProcessInvariants).length > 0, `${spec.id}.immutableGates.inProcessInvariants`);
    assert.equal(edge.autoMerge, false, spec.id);
  }
});

test("AC2: the workflow identities and the provenance files of the edges are the ones of the spec (AC5, AC51)", () => {
  for (const spec of AI) {
    const edge = edgeOf(spec);
    assert.equal(edge.branchName, spec.branchName, spec.id);
    assert.equal(edge.closeOlderKey, spec.closeOlderKey, spec.id);
    assert.equal(edge.provenanceFile, spec.provenanceFile, spec.id);
    assert.equal(edge.provenanceJsonPointer, "/commit", spec.id);
    assert.deepEqual(edge.reviewers.length > 0, true, spec.id);
  }
});

test("AC12-AC14: the allowed files of each edge are exactly the lists of the spec (order does not matter)", () => {
  for (const spec of AI) {
    assert.deepEqual([...edgeOf(spec).allowedFiles].sort(), [...ALLOWED[spec.edgeId]].sort(), spec.id);
  }
  assert.equal(ALLOWED["copilot-lab"].length, 23);
});

test("AC24: the sync scopes of each edge are the ones that its workflow accepts: ids that the installed engine's schema takes for a scope, and members of this fleet's four", () => {
  // a scope is a free-form id in the engine's schemas (the router dispatches one of the edge's, the workflow refuses any other), so the engine fixes only the shape of one
  const pattern = new RegExp(readJson(engineFile("schemas", "sdlc.schema.json")).definitions.scopeId.pattern);
  for (const spec of AI) {
    const scopes = edgeOf(spec).syncScopes;
    assert.deepEqual(scopes, spec.scopes, spec.id);
    for (const scope of scopes) {
      assert.match(scope, pattern, `${spec.id}: ${scope}`);
      assert.ok(ALL_SCOPES.includes(scope), `${spec.id}: ${scope}`);
    }
  }
  assert.deepEqual([...new Set(AI.flatMap((spec) => edgeOf(spec).syncScopes))].sort(), [...ALL_SCOPES].sort(), "and the fleet uses no other");
});

test("AC41/AC15: the nineteen locked paths are the same, in order, for the two edges", () => {
  for (const spec of AI) assert.deepEqual(edgeOf(spec).immutableGates.zeroDiffPaths, ZERO_DIFF, spec.id);
  assert.equal(ZERO_DIFF.length, 19);
});

test("AC68: each edge's verifyCommands are the ten commands that follow the helper, then the post-run checks of AC28, AC66 (showcase only), AC69 and AC77", () => {
  for (const spec of AI) {
    const { verifyCommands } = edgeOf(spec);
    assert.deepEqual(verifyCommands.slice(0, 10), TEN_COMMANDS, spec.id);
    const checks = verifyCommands.slice(10);
    assert.deepEqual(
      checks.map((command) => command.split("\n")[0].replace(/^#\s*post-run check:\s*/, "")),
      POST_RUN[spec.edgeId],
      `${spec.id}: the post-run checks, in order`,
    );
    for (const command of checks) assert.match(command, /^# post-run check: /, spec.id);
  }
  assert.equal(edgeOf(AI[0]).verifyCommands.length, 14);
  assert.equal(edgeOf(AI[1]).verifyCommands.length, 14);
});

test("AC62/AC68: the copilot-lab Studio UI post-run check executes and fails when hosted session or lesson wiring is dropped", () => {
  const step = edgeOf(AI[0]).verifyCommands.find((cmd) => cmd.startsWith("# post-run check: Studio UI preserves hosted session and lesson wiring"));
  assert.ok(step, "the Studio UI post-run check exists in copilot-lab.verifyCommands");
  const scriptMatch = step.match(/node --input-type=module -e '([\s\S]*?)'/);
  assert.ok(scriptMatch, "extracts the inline node script");
  const script = scriptMatch[1];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-studio-wiring-"));
  try {
    const portfolio = path.join(scratch, "portfolio");
    const writeFile = (rel, content) => {
      const full = path.join(portfolio, ...rel.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    const homeGood = 'loadWebsiteSession(); fetch("/workspace/status"); resumePlace(labs); sourceRevisionUrl(); SOURCE_ONLY_EXERCISES; setupGuideUrl(); SETUP_GUIDE.note;';
    const manualGood = "MarkReadCard; sourceLabUrl(lab.number); sourceLabPath(lab.number);";
    const lab05Good = '<code>consolidate-lessons</code>{" "}skill. It is a command skill, <code>/consolidate-lessons</code> (Lab 10, step 5) compares this wiki with GitHub Copilot Memory and a custom memory service.';
    writeFile("apps/lab-studio/client/src/components/Home.tsx", homeGood);
    writeFile("apps/lab-studio/client/src/components/Manual.tsx", manualGood);
    writeFile("apps/lab-studio/client/src/labs/lab05.tsx", lab05Good);

    const runCheck = () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, GITHUB_WORKSPACE: scratch },
        encoding: "utf8",
      });

    const passRun = runCheck();
    assert.equal(passRun.status, 0, passRun.stderr);

    // Negative controls across all three guarded files
    for (const [rel, good, broken, expected] of [
      ["apps/lab-studio/client/src/components/Home.tsx", homeGood, homeGood.replace("loadWebsiteSession()", "void 0"), /Home\.tsx: loadWebsiteSession\(\)/],
      ["apps/lab-studio/client/src/components/Manual.tsx", manualGood, manualGood.replace("MarkReadCard", "div"), /Manual\.tsx: MarkReadCard/],
      ["apps/lab-studio/client/src/labs/lab05.tsx", lab05Good, lab05Good.replace("skill.", "pack."), /lab05\.tsx: consolidate-lessons skill/],
    ]) {
      writeFile(rel, broken);
      const failRun = runCheck();
      assert.equal(failRun.status, 1, `dropping token in ${rel} must fail the post-run check`);
      assert.match(failRun.stderr, expected);
      writeFile(rel, good);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("AC60/AC63: the copilot-lab accept commands run the revision bump first, then the two --accept commands, then the build", () => {
  const edge = edgeOf(AI[0]);
  assert.deepEqual(edge.acceptCommands, [
    'node "$GITHUB_WORKSPACE/scripts/bump-studio-revision-pins.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --new-sha "$UPSTREAM_SHA"',
    "npm run sync:workshop-source -- <checkout> --accept",
    'node "$GITHUB_WORKSPACE/scripts/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream <checkout> --commit "$UPSTREAM_SHA" --accept',
  ]);
  assert.deepEqual(edge.buildCommands, ["npm run build:workshop"]);
  assert.deepEqual(edge.preflightCommands, [
    "npm run sync:workshop-source -- <checkout>",
    'node "$GITHUB_WORKSPACE/scripts/lab-studio-drift.mjs" --portfolio "$GITHUB_WORKSPACE/portfolio" --upstream <checkout> --commit "$TARGET_SHA"',
  ]);
});

test("AC64-AC66: the showcase edge writes the exact provenance object, captures run data and builds", () => {
  const showcase = edgeOf(AI[1]);
  assert.equal(showcase.acceptCommands.length, 1);
  assert.ok(showcase.acceptCommands[0].includes('JSON.stringify({ repository: "ms-mfg-community/github-pipeline-showcase", commit: process.env.UPSTREAM_SHA }, null, 2)'));
  assert.ok(showcase.acceptCommands[0].includes('"experiences/pipeline-showcase/content/provenance.json"'));
  assert.deepEqual(showcase.buildCommands, ["node experiences/pipeline-showcase/capture/fetch-run-data.mjs", "npm run build:experiences"]);
  assert.deepEqual(showcase.preflightCommands, ['gh api "repos/ms-mfg-community/github-pipeline-showcase/actions/runs?per_page=100"']);
});

test("AC2: the adaptation data of the edges is the data that the helpers and the run report read (SPEC-04 schema field): the engine's own keys, and the data of the helpers under adaptation.helpers", () => {
  const lab = edgeOf(AI[0]).adaptation;
  assert.deepEqual(Object.keys(lab), ["preflightReports", "helpers", "pullRequestResult"], "the keys of the engine, and one place for the helpers' data that the engine does not read");
  assert.deepEqual(lab.preflightReports, ["workshop-drift.txt", "lab-studio-drift.txt"]);
  assert.deepEqual(Object.keys(lab.helpers), ["labStudioDrift", "revisionPins"], "the two helpers that read their data through helperSection");
  assert.equal(lab.helpers.labStudioDrift.manifest, "apps/lab-studio/lab-sources.json");
  assert.deepEqual(lab.helpers.revisionPins.provenance, [
    { file: "apps/lab-studio/lab-sources.json", pointer: "/_provenance/commit" },
    { file: "experiences/copilot-workshop/provenance.json", pointer: "/commit" },
  ]);
  assert.deepEqual(lab.helpers.revisionPins.files, [
    "apps/lab-studio/client/src/labs/source.ts",
    "apps/lab-studio/server/tests/source.test.ts",
    "apps/lab-studio/server/tests/lab-drift.test.ts",
    "README.md",
    "experiences/copilot-workshop/public/NOTICE.txt",
    "public/copilot-project.html",
  ]);
  assert.deepEqual(lab.helpers.revisionPins.constant, { file: "apps/lab-studio/client/src/labs/source.ts", name: "SOURCE_COMMIT" });
  assert.equal("labStudioDrift" in lab || "revisionPins" in lab, false, "and neither is a key of adaptation any more: the engine's schema does not know them");
  assert.deepEqual(lab.pullRequestResult, { adaptedModules: "experiences/copilot-workshop/content/m*.ts", adaptedStudioLabs: "apps/lab-studio/client/src/labs/lab*.tsx" });
  assert.deepEqual(edgeOf(AI[1]).adaptation, { preflightReports: ["upstream-runs.json"] });
});
