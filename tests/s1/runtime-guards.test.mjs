// Rendered hooks are executable product code: run them, rather than only matching their text or parsing bash.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { minimalManifest, parseWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { BashSandbox } from "./helpers/bash-runtime.mjs";

function rendered(mode = "mechanical", change = () => {}) {
  const manifest = minimalManifest();
  const edge = manifest.dependencyEdges[0];
  edge.mode = mode;
  change(edge);
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const result = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const id = mode === "mechanical" ? "cascade-mechanical-alpha-to-beta" : "cascade-ai-alpha-to-beta";
    return { edge, ...parseWorkflow(result.files.get(`.github/workflows/${id}.md`)) };
  } finally {
    workspace.cleanup();
  }
}

function sandbox(t) {
  const box = new BashSandbox();
  t.after(() => box.cleanup());
  return box;
}

function success(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.error?.message ?? result.stderr}`);
}

const HEX_A = "a".repeat(40);
const HEX_B = "b".repeat(40);

test("AC32 runtime: mechanical revision validation rejects hostile and boundary inputs before any artifact or env export", (t) => {
  const box = sandbox(t);
  const script = rendered().frontmatter["pre-agent-steps"][0].run;
  for (const key of ["UPSTREAM_SHA", "PREVIOUS_SHA"]) {
    for (const bad of ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), `${HEX_A}\nINJECTED=yes`, "$(touch PWNED)"]) {
      const result = box.run(script, { UPSTREAM_SHA: HEX_A, PREVIOUS_SHA: HEX_B, [key]: bad });
      assert.equal(result.status, 2, `${key}=${JSON.stringify(bad)}: ${result.stderr}`);
      assert.equal(fs.readFileSync(box.envFile, "utf8"), "", "rejected revisions cannot export environment variables");
      assert.equal(fs.existsSync(path.join(box.artifacts, "base-sha.txt")), false);
      assert.equal(fs.existsSync(box.path("PWNED")), false, "input is not evaluated as shell code");
    }
  }
});

test("AC32/AC53 runtime: base and head artifacts record real Git revisions and survive independent shells", (t) => {
  const box = sandbox(t);
  const { frontmatter, edge } = rendered();
  fs.mkdirSync(box.path("upstream/alpha-service"), { recursive: true });
  const base = box.revision("beta-docs", { "docs/imported/source.json": '{"revision":1}\n' });
  success(box.run(frontmatter["pre-agent-steps"][0].run, { UPSTREAM_SHA: HEX_A, PREVIOUS_SHA: HEX_B }), "pre-agent");
  assert.equal(box.readArtifact("base-sha.txt"), `${base}\n`);
  assert.deepEqual(box.environment(), {
    BASE_SHA: base,
    UPSTREAM_SHA: HEX_A,
    PREVIOUS_SHA: HEX_B,
    BRANCH_NAME: edge.branchName,
    UPSTREAM_DIR: `${box.run('printf "%s" "$GITHUB_WORKSPACE"').stdout}/upstream/alpha-service`,
  });
  const head = box.revision("beta-docs", { "docs/imported/source.json": '{"revision":2}\n' }, base);
  success(box.run(frontmatter["post-steps"][0].run, box.environment()), "post-agent handoff");
  assert.deepEqual(JSON.parse(box.readArtifact("cascade-shas.json")), { baseSha: base, headSha: head });
  const env = box.environment();
  assert.equal(env.BASE_SHA, base);
  assert.equal(env.AGENT_HEAD_SHA, head);
  success(box.run('test "$BASE_SHA" != "$AGENT_HEAD_SHA" && test -d "$UPSTREAM_DIR/../"', env), "next shell sees exported revisions");
});

test("AC32/AC53 runtime: a corrupted base artifact cannot inject GITHUB_ENV or replace the handoff JSON", (t) => {
  const box = sandbox(t);
  box.revision("beta-docs", { "docs/imported/source.json": "{}\n" });
  const script = rendered().frontmatter["post-steps"][0].run;
  for (const bad of ["", "a".repeat(39), "A".repeat(40), `${HEX_A}\nINJECTED=yes`, "$(touch PWNED)"]) {
    box.writeEnv("EXISTING=keep\n");
    box.writeArtifact("base-sha.txt", bad);
    box.writeArtifact("cascade-shas.json", '{"previous":"keep"}\n');
    const result = box.run(script);
    assert.equal(result.status, 1, `${JSON.stringify(bad)}: ${result.stderr}`);
    assert.equal(fs.readFileSync(box.envFile, "utf8"), "EXISTING=keep\n");
    assert.equal(box.readArtifact("cascade-shas.json"), '{"previous":"keep"}\n');
    assert.equal(fs.existsSync(box.path("PWNED")), false);
  }
});

test("AC32/AC53 runtime: the generated clean-tree gate fails on actual modified and untracked files without changing them", (t) => {
  const box = sandbox(t);
  box.revision("beta-docs", { "docs/imported/source.json": "{}\n" });
  const script = rendered().frontmatter["post-steps"].find((step) => step.name === "Verify the downstream worktree is clean").run;
  success(box.run(script), "a clean checkout");
  fs.writeFileSync(box.path("beta-docs/docs/imported/source.json"), '{"dirty":true}\n');
  assert.equal(box.run(script).status, 1, "a tracked modification must fail the step");
  assert.equal(fs.readFileSync(box.path("beta-docs/docs/imported/source.json"), "utf8"), '{"dirty":true}\n');
  fs.writeFileSync(box.path("beta-docs/docs/imported/source.json"), "{}\n");
  fs.writeFileSync(box.path("beta-docs/untracked.txt"), "keep this evidence\n");
  assert.equal(box.run(script).status, 1, "an untracked file must also fail the step");
  assert.equal(fs.readFileSync(box.path("beta-docs/untracked.txt"), "utf8"), "keep this evidence\n");
});

test("AC32 runtime: the path gate accepts real allowed changes and rejects a mixed patch with a forbidden path", (t) => {
  const box = sandbox(t);
  const script = rendered().frontmatter["post-steps"].find((step) => step.name === "Verify changed paths are covered by the allowed files").run;
  const base = box.revision("beta-docs", { "docs/imported/source.json": "{}\n" });
  success(box.run(script, { BASE_SHA: base }), "no changes");
  const allowed = box.revision("beta-docs", {
    "docs/imported/source.json": '{"updated":true}\n',
    "docs/imported/nested/page.md": "an allowed nested file\n",
  }, base);
  success(box.run(script, { BASE_SHA: base }), "recursive allowed changes");
  box.revision("beta-docs", {
    "docs/imported/source.json": '{"updated":true}\n',
    "docs/imported/nested/page.md": "an allowed nested file\n",
    "outside.txt": "not permitted\n",
  }, allowed);
  assert.equal(box.run(script, { BASE_SHA: base }).status, 1, "one forbidden path must reject the entire patch");
  assert.equal(fs.readFileSync(box.path("beta-docs/outside.txt"), "utf8"), "not permitted\n", "a gate must not silently erase the evidence");
});

/**
 * The `allowed-files` matching of gh-aw v1.0.1 (actions/setup/js/glob_pattern_helpers.cjs, path mode, case-sensitive), written
 * out here as the oracle for the shell gate: `*` matches any characters except `/`, `**` matches any characters including `/`.
 */
function ghAwAllows(patterns, file) {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/[+?^${}()|[\]]/g, "\\$&");
    const source = escaped.replace(/\*\*/g, "<!DOUBLESTAR>").replace(/\*/g, "[^/]*").replace(/<!DOUBLESTAR>/g, ".*");
    return new RegExp(`^${source}$`).test(file);
  });
}

const PATH_GATE = "Verify changed paths are covered by the allowed files";

// The explicit cases pin the oracle itself. The single-star rows are the regression of the first gate, a shell case pattern
// whose `*` also crossed directories; `docs/**/*.md` shows that gh-aw turns `**/` into `.*/`, which needs one directory.
const PATH_GATE_CRITICAL = [
  [["docs/*.md"], "docs/guide.md", true],
  [["docs/*.md"], "docs/nested/forbidden.md", false],
  [["docs/*.md"], "docs/a/b/guide.md", false],
  [["docs/*.md"], "docs/guide.txt", false],
  [["docs/*/*.md"], "docs/a/guide.md", true],
  [["docs/*/*.md"], "docs/a/b/guide.md", false],
  [["*.md"], "README.md", true],
  [["*.md"], "docs/README.md", false],
  [["docs/**"], "docs/a/b/guide.md", true],
  [["docs/**"], "docs-extra/guide.md", false],
  [["docs/**/*.md"], "docs/a/guide.md", true],
  [["docs/**/*.md"], "docs/guide.md", false],
  [["src/a.b+c.js"], "src/a.b+c.js", true],
  [["src/a.b+c.js"], "src/aXb+c.js", false],
  [["src/a.b+c.js"], "src/a.bbc.js", false],
  [["README.md", "docs/*.md", "assets/**"], "assets/img/logo.svg", true],
  [["README.md", "docs/*.md", "assets/**"], "docs/img/x.md", false],
];

// Every pattern set meets every path, so the gate is compared with the oracle on shapes that nobody listed one by one.
const PATH_GATE_SETS = [
  ...PATH_GATE_CRITICAL.map(([patterns]) => patterns),
  ["**"], ["*"], ["**/*"], ["**/*.md"], ["**/guide.md"], ["docs/**/guide.md"], ["src/*.js"], ["src/**/*.js"], ["assets/**", "README.md"],
  [".github/**"], [".github/workflows/*.yml"], ["public/ghec-admin/**"], ["a@b/*"], ["a*"], ["a.md", "a/*.md"], ["*.y"], ["x.*"], ["x*y"],
].filter((patterns, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(patterns)) === index);

const PATH_GATE_PATHS = [
  "README.md", "LICENSE", "package.json", "a.md", "ab.md", "a/b.md", "x.y", "xzy", "a@b/c-d_e.txt",
  "docs/guide.md", "docs/guide.txt", "docs/README.md", "docs/a/guide.md", "docs/a/b/guide.md", "docs/a/b/c/d.md", "docs/nested/forbidden.md", "docs/img/x.md",
  "documents/guide.md", "docs-extra/guide.md", "other/docs/guide.md",
  "src/a.b+c.js", "src/aXb+c.js", "src/a.bbc.js", "src/a.b+cXjs", "src/app.js", "src/lib/app.js",
  "assets/logo.svg", "assets/img/logo.svg", "assets/img/deep/logo.svg",
  ".github/workflows/ci.yml", ".github/CODEOWNERS",
  "public/ghec-admin/index.html", "public/ghec-admin/a/b.html", "public/ghec-admin-extra/index.html", "public/other/index.html",
];

/** One manifest with an edge per allowed-files set, rendered once: the path gate of every set, in set order. */
function gateScripts(sets) {
  const manifest = minimalManifest();
  const template = manifest.dependencyEdges[0];
  manifest.dependencyEdges = sets.map((allowedFiles, index) => ({
    ...structuredClone(template),
    edgeId: `gate-${index}`,
    upstreamKey: `gate-${index}`,
    upstreamSlug: `GATE_${index}`,
    stateVariable: `SDLC_SYNC_STATE_GATE_${index}`,
    branchName: `sdlc/cascade-gate-${index}`,
    closeOlderKey: `sdlc-cascade-gate-${index}`,
    allowedFiles,
  }));
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const result = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    return sets.map((_, index) => {
      const { frontmatter } = parseWorkflow(result.files.get(`.github/workflows/cascade-mechanical-gate-${index}.md`));
      return frontmatter["post-steps"].find((step) => step.name === PATH_GATE).run;
    });
  } finally {
    workspace.cleanup();
  }
}

test("AC32 runtime: for many pattern shapes bash's own matching of the rendered gate pattern covers exactly the paths that gh-aw's allowed-files matching covers", (t) => {
  const box = sandbox(t);
  const scripts = gateScripts(PATH_GATE_SETS);
  // Only bash builtins run here (no fork, which is very slow on Windows): the rendered `allowed=` pattern and the rendered
  // `[[ ... =~ ... ]]` test, taken from each gate, meet every path. The end-to-end gate runs in the tests that use real Git.
  const condition = (script) => /\[\[ "\$file" =~ \$allowed \]\]/.exec(script)?.[0];
  const pattern = (script) => script.split("\n").find((line) => line.startsWith("allowed="));
  for (const script of scripts) assert.ok(condition(script) && pattern(script), `the gate keeps its pattern in allowed= and tests it with =~:\n${script}`);
  const program = scripts
    .map((script) => [
      pattern(script),
      `while IFS= read -r file; do if ${condition(script)}; then printf 1; else printf 0; fi; done <<'END_OF_PATHS'`,
      PATH_GATE_PATHS.join("\n"),
      "END_OF_PATHS",
      "echo",
    ].join("\n"))
    .join("\n");
  const outcome = box.run(program);
  success(outcome, "the pattern matching");
  const decisions = outcome.stdout.trim().split(/\r?\n/);
  assert.equal(decisions.length, PATH_GATE_SETS.length);
  let covered = 0;
  PATH_GATE_SETS.forEach((patterns, index) => {
    const expected = PATH_GATE_PATHS.map((file) => (ghAwAllows(patterns, file) ? "1" : "0")).join("");
    covered += [...expected].filter((digit) => digit === "1").length;
    assert.equal(decisions[index], expected, `${JSON.stringify(patterns)}: 1 is a covered path, in the order of PATH_GATE_PATHS`);
  });
  const total = PATH_GATE_SETS.length * PATH_GATE_PATHS.length;
  assert.ok(covered > 50 && covered < total - 50, `the comparison has both outcomes in quantity (${covered} of ${total} covered)`);
  for (const [patterns, file, isCovered] of PATH_GATE_CRITICAL) {
    const label = `${JSON.stringify(patterns)} vs ${file}`;
    const index = PATH_GATE_SETS.findIndex((set) => JSON.stringify(set) === JSON.stringify(patterns));
    assert.equal(ghAwAllows(patterns, file), isCovered, `${label}: the oracle`);
    assert.ok(PATH_GATE_PATHS.includes(file), `${label}: the path is among those the gates saw`);
    assert.equal(decisions[index][PATH_GATE_PATHS.indexOf(file)], isCovered ? "1" : "0", `${label}: the gate pattern`);
  }
});

test("AC32 runtime: the committed preset gate admits everything beneath public/ghec-admin/ and nothing else", (t) => {
  const box = sandbox(t);
  const { frontmatter } = parseWorkflow(fs.readFileSync(new URL("../../.github/workflows/cascade-mechanical-ghec-admin.md", import.meta.url), "utf8"));
  const script = frontmatter["post-steps"].find((step) => step.name === PATH_GATE).run;
  const base = box.revision("portfolio", { "package.json": "{}\n" });
  box.revision("portfolio", { "package.json": "{}\n", "public/ghec-admin/index.html": "a\n", "public/ghec-admin/assets/deep/app.js": "b\n" }, base);
  success(box.run(script, { BASE_SHA: base }), "nested files beneath the allowed directory");
  const outside = ["public/other/index.html", "public/ghec-admin-extra/index.html", "package.json"];
  box.revision("portfolio", { "package.json": "changed\n", "public/other/index.html": "x\n", "public/ghec-admin-extra/index.html": "y\n" }, base);
  const outcome = box.run(script, { BASE_SHA: base });
  assert.equal(outcome.status, 1);
  for (const file of outside) assert.ok(outcome.stderr.includes(`path outside the allowed files: ${file}`), `${file}: ${outcome.stderr}`);
});

test("AC44 runtime: AI dispatch validation accepts the supported values and rejects every invalid field before exporting state", (t) => {
  const box = sandbox(t);
  const { frontmatter, edge } = rendered("ai-adaptation");
  const previous = box.revision("upstream/alpha-service", { "source.txt": "old\n" });
  const upstream = box.revision("upstream/alpha-service", { "source.txt": "new\n" }, previous);
  const env = {
    UPSTREAM_SHA: upstream,
    PREVIOUS_SHA: previous,
    UPSTREAM_REPO_INPUT: edge.upstreamRepo,
    DOWNSTREAM_REPO_INPUT: edge.downstreamRepo,
    SYNC_SCOPE: "both",
    ON_COMMIT_ONLY_ADVANCE: "noop",
    DRY_RUN: "false",
  };
  const script = frontmatter["pre-agent-steps"][0].run;
  for (const scope of ["both", "workshop-only", "studio-only", "showcase-runs", "github-intermediate"]) {
    for (const dryRun of ["", "true", "false"]) {
      box.writeEnv();
      success(box.run(script, { ...env, SYNC_SCOPE: scope, DRY_RUN: dryRun, ON_COMMIT_ONLY_ADVANCE: "bump-provenance" }), `${scope}/${dryRun}`);
      assert.deepEqual(box.environment(), { DRY_RUN: dryRun });
    }
  }
  const badCases = [
    { UPSTREAM_SHA: "a".repeat(39) }, { PREVIOUS_SHA: "A".repeat(40) },
    { UPSTREAM_SHA: previous }, { PREVIOUS_SHA: "f".repeat(40) },
    { UPSTREAM_REPO_INPUT: "other/source" }, { DOWNSTREAM_REPO_INPUT: "other/target" },
    { SYNC_SCOPE: "" }, { SYNC_SCOPE: "all" }, { ON_COMMIT_ONLY_ADVANCE: "ignore" },
    { DRY_RUN: "yes" }, { DRY_RUN: "$(touch PWNED)" },
  ];
  for (const patch of badCases) {
    box.writeEnv("EXISTING=keep\n");
    const result = box.run(script, { ...env, ...patch });
    assert.equal(result.status, 2, `${JSON.stringify(patch)}: ${result.stderr}`);
    assert.equal(fs.readFileSync(box.envFile, "utf8"), "EXISTING=keep\n");
    assert.equal(fs.existsSync(box.path("PWNED")), false);
  }
});

test("AC44 runtime: AI preflights preserve 0/1 evidence, reject errors, and resolve checkout outside the current directory", (t) => {
  const box = sandbox(t);
  box.revision("beta-docs", { "docs/imported/source.json": "{}\n" });
  const env = { UPSTREAM_SHA: HEX_A, PREVIOUS_SHA: HEX_B, UPSTREAM_DIR: "/absolute/upstream with spaces" };
  for (const code of [0, 1, 2, 127]) {
    const { frontmatter } = rendered("ai-adaptation", (edge) => {
      edge.preflightCommands = [
        `printf '%s\\n' <checkout> "$TARGET_SHA" "$LAST_MERGED_SHA"; exit ${code}`,
        "printf 'second command still captured\\n'",
      ];
    });
    const step = frontmatter["pre-agent-steps"].find((item) => item.name === "Capture the drift reports");
    const result = box.run(step.run, env, "beta-docs");
    assert.equal(result.status, code < 2 ? 0 : 2, `preflight returned ${code}: ${result.stderr}`);
    assert.equal(box.readArtifact("agent/preflight-1.txt"), `${env.UPSTREAM_DIR}\n${HEX_A}\n${HEX_B}\n`);
    assert.equal(box.readArtifact("agent/preflight-2.txt"), "second command still captured\n");
    assert.equal(box.readArtifact("agent/preflight-exit-codes.txt"), `preflight exit codes: ${code} 0\n`);
    assert.equal(box.git("beta-docs", "status", "--porcelain"), "", "capturing evidence must not edit the downstream checkout");
  }
});

test("AC44 runtime: the AI read-only guard rejects a dirty preflight and a clean checkout whose HEAD moved", (t) => {
  const box = sandbox(t);
  const base = box.revision("beta-docs", { "docs/imported/source.json": "{}\n" });
  const { frontmatter } = rendered("ai-adaptation", (edge) => {
    edge.preflightCommands = ["printf 'forbidden preflight edit\\n' > touched.txt"];
  });
  const guard = frontmatter["pre-agent-steps"].at(-1).run;
  success(box.run(guard, { BASE_SHA: base }), "the initial checkout");
  const capture = frontmatter["pre-agent-steps"].find((item) => item.name === "Capture the drift reports");
  success(box.run(capture.run, { UPSTREAM_SHA: HEX_A, PREVIOUS_SHA: HEX_B }, "beta-docs"), "capture the dirty preflight");
  assert.equal(box.run(guard, { BASE_SHA: base }).status, 1, "a preflight edit must prevent agent execution");
  assert.equal(fs.readFileSync(box.path("beta-docs/touched.txt"), "utf8"), "forbidden preflight edit\n");
  fs.rmSync(box.path("beta-docs/touched.txt"));
  const moved = box.revision("beta-docs", { "docs/imported/source.json": '{"moved":true}\n' }, base);
  assert.notEqual(moved, base);
  assert.equal(box.git("beta-docs", "status", "--porcelain"), "");
  assert.equal(box.run(guard, { BASE_SHA: base }).status, 1, "even an otherwise clean checkout must not advance before the agent");
});

test("AC56 runtime: onboarding inputs round-trip as JSON without evaluating hostile shell or Actions text", (t) => {
  const box = sandbox(t);
  const result = renderFleet(referenceRequest());
  const { frontmatter } = parseWorkflow(result.files.get(".github/workflows/sdlc-onboard.md"));
  const values = {
    repo: "example-owner/repository",
    downstream: "example-owner/hub",
    strategy: "custom",
    watch_url: "https://example.org/a?x=1&y=two",
    schedule: "0 6 * * 1",
    mode: "ai-adaptation",
    instructions: "---\n- run: x\n`backticks` \"quotes\" $(touch PWNED) ${{ secrets.X }}\nUnicode café",
    manifest: "configuration/fleet.yaml",
  };
  const env = Object.fromEntries(Object.entries(values).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]));
  success(box.run(frontmatter["pre-agent-steps"][0].run, env), "record inputs");
  assert.deepEqual(JSON.parse(box.readArtifact("agent/onboard-inputs.json")), values);
  assert.equal(fs.existsSync(box.path("PWNED")), false);
});
