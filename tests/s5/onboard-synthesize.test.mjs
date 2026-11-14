// AC46 to AC50: the deterministic synthesis of the projects[] and dependencyEdges[] entries and of instructions/<projectKey>.md
// from the inspection and the flags. Goldens: tests/s5/fixtures/onboard/<case>/expected.projects.json for the five inspection
// fixtures, and expected.sdlc.yaml of edge-ok and edge-mechanical for the edges. S5 never invents a command, a reviewer or a path.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { individualOwners } from "../../bin/lib/codeowners.mjs";
import { inspectRepository } from "../../bin/lib/inspect-repo.mjs";
import { DEFAULT_SCHEDULE, projectKeyOf, resolveMode, resolveStrategy, synthesizeEdge, synthesizeProject } from "../../bin/lib/synthesize.mjs";
import { deriveProjectKey, inferWatchKind, isValidCron, parseWatchUrl, PROJECT_KEY, slugOf } from "../../bin/lib/validators.mjs";
import { GENERATED_MARKER } from "../../bin/lib/instructions-file.mjs";
import { FIXTURES, copyFixtureToGitRepo, createScenario, fixtureRepos, readFixture } from "./helpers/harness.mjs";

const CASES = ["node-app", "dotnet-app", "lab-like", "provenance-like", "codeowners-like"];
const IDENTITY = { repo: "example-owner/target", defaultBranch: "main", headSha: "a".repeat(40) };
const EMPTY = readFixture("manifest.empty.yaml");
const REPOS = fixtureRepos({
  "example-owner/node-app": "node-app",
  "example-owner/dotnet-app": "dotnet-app",
  "example-owner/lab-like": "lab-like",
  "example-owner/provenance-like": "provenance-like",
  "example-owner/codeowners-like": "codeowners-like",
  "example-owner/edge-ok": "edge-ok",
  "example-owner/edge-mechanical": "edge-mechanical",
  "example-owner/edge-no-provenance": "edge-no-provenance",
  "example-owner/edge-two-provenance": "edge-two-provenance",
});
const PLAIN = fixtureRepos({ "example-owner/plain": "node-app" }, { "example-owner/plain": { files: { "README.md": "# nothing to detect here\n" } } });

/** Runs bin/sdlc-onboard.mjs in process against the fixtures and hands the scenario, the result and the parsed manifest to `callback`. */
async function onboarded(argv, callback, { repos = REPOS, manifest = "standard", reconcile } = {}) {
  const scenario = await createScenario({ fake: { repos }, workspace: { manifest: manifest === "empty" ? EMPTY : manifest }, reconcile });
  try {
    const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()) });
    return await callback({ scenario, run, manifest: () => YAML.parse(scenario.workspace.read("sdlc.yaml")) });
  } finally {
    await scenario.cleanup();
  }
}
const entryOf = (data, projectKey) => data.projects.find((project) => project.projectKey === projectKey);

// --- AC46: goldens ---------------------------------------------------------------------------------------------------------

for (const name of CASES) {
  const golden = JSON.parse(readFixture("onboard", name, "expected.projects.json"));

  test(`AC46: ${name}: the synthesized entry is the golden expected.projects.json, from a local checkout`, async () => {
    const target = copyFixtureToGitRepo(name, `https://github.com/example-owner/${name}.git`);
    try {
      await onboarded(["--repo", target.dir], ({ run, manifest }) => {
        assert.equal(run.code, 0, run.stderr);
        assert.deepEqual([entryOf(manifest(), name)], golden);
      });
    } finally {
      target.cleanup();
    }
  });

  test(`AC46: ${name}: the same golden results from a remote read of <owner>/<repo>`, async () => {
    await onboarded(["--repo", `example-owner/${name}`], ({ run, manifest }) => {
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual([entryOf(manifest(), name)], golden);
    });
  });

  test(`AC46: ${name}: driftAudit.enabled is true, draft is false and reviewers are the individual owners of CODEOWNERS or [] (never [<owner>])`, () => {
    const [entry] = golden;
    const codeowners = path.join(FIXTURES, "onboard", name, ".github", "CODEOWNERS");
    const expected = fs.existsSync(codeowners) ? individualOwners(fs.readFileSync(codeowners, "utf8")) : [];
    assert.strictEqual(entry.driftAudit.enabled, true);
    assert.strictEqual(entry.driftAudit.draft, false);
    assert.deepEqual(entry.driftAudit.reviewers, expected);
    assert.equal(entry.driftAudit.reviewers.includes("example-owner"), false);
    assert.equal(entry.deconflictInRepoSchedules, "none");
    assert.deepEqual(entry.deconflictWorkflowIds, []);
  });
}

test("AC46: the individual owner of the codeowners-like fixture is its reviewer, the team is not", async () => {
  await onboarded(["--repo", "example-owner/codeowners-like"], ({ manifest }) => {
    assert.deepEqual(entryOf(manifest(), "codeowners-like").driftAudit.reviewers, ["lead-dev"]);
  });
});

// --- AC46: properties ------------------------------------------------------------------------------------------------------

test("AC46: the repository name Example_Repo.Name maps to example-repo-name", async () => {
  assert.equal(projectKeyOf("example-owner/Example_Repo.Name"), "example-repo-name");
  await onboarded(["--repo", "example-owner/Example_Repo.Name"], ({ run, manifest, scenario }) => {
    assert.equal(run.code, 0, run.stderr);
    const entry = entryOf(manifest(), "example-repo-name");
    assert.equal(entry.repo, "example-owner/Example_Repo.Name");
    assert.equal(entry.driftAudit.instructionsFile, "instructions/example-repo-name.md");
    assert.equal(scenario.workspace.exists("instructions/example-repo-name.md"), true);
  }, { repos: fixtureRepos({ "example-owner/Example_Repo.Name": "node-app" }) });
});

test("AC46: projectKey derivation: lower-cased, each run outside [a-z0-9] becomes one -, leading and trailing - removed, cut to 63 characters", () => {
  const cases = [
    ["Example_Repo.Name", "example-repo-name"],
    ["My  Repo!!", "my-repo"],
    ["--a--b--", "a-b"],
    ["UPPER", "upper"],
    ["a.b_c-d", "a-b-c-d"],
    ["9lives", "9lives"],
    ["___", ""],
    ["", ""],
    ["a".repeat(70), "a".repeat(63)],
    [`${"a".repeat(62)}-b`, `${"a".repeat(62)}-`],
  ];
  for (const [name, expected] of cases) assert.equal(deriveProjectKey(name), expected, JSON.stringify(name));
  assert.equal(projectKeyOf("o/Example_Repo.Name"), "example-repo-name");
  for (const name of ["Example_Repo.Name", "a".repeat(70), "x-1", "Z9"]) assert.match(deriveProjectKey(name), PROJECT_KEY);
});

test("AC46: a repository name that leaves no character for a projectKey is refused, and nothing is written", async () => {
  await onboarded(["--repo", "example-owner/___"], ({ run, scenario }) => {
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /no projectKey can be derived from the repository name of example-owner\/___/);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
    assert.equal(scenario.reconcile.calls.length, 0);
  }, { repos: fixtureRepos({ "example-owner/___": "node-app" }) });
});

/** A small deterministic generator, so that the property check is reproducible. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("AC46: property: every emitted command resolves to a script that exists in the target's package.json (400 generated manifests)", async () => {
  const random = generator(20260504);
  const names = ["build", "test", "lint", "start", "dev", "import:data", "test:unit", "prebuild", "build:prod", "compile", "typecheck"];
  const PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
  for (let round = 0; round < 400; round += 1) {
    const scripts = {};
    for (const name of names) if (random() < 0.4) scripts[name] = name === "test" && random() < 0.25 ? PLACEHOLDER : `node scripts/${name.replace(/\W/g, "-")}.mjs`;
    const text = random() < 0.1 ? "{ broken" : JSON.stringify({ name: "generated", scripts });
    const reader = { list: () => ["package.json"], read: async (file) => (file === "package.json" ? text : null) };
    const inspection = await inspectRepository(reader, IDENTITY);
    const valid = text !== "{ broken";
    const hasTest = valid && "test" in scripts && scripts.test !== PLACEHOLDER;
    for (const command of inspection.buildCommands) assert.ok(valid && /^npm run (\S+)$/.test(command) && command.replace("npm run ", "") in scripts, `${command} has no script (${JSON.stringify(scripts)})`);
    for (const command of inspection.verifyCommands) assert.ok(hasTest && command === "npm test", `${command} has no test script (${JSON.stringify(scripts)})`);
    assert.deepEqual(inspection.buildCommands, valid && "build" in scripts ? ["npm run build"] : []);
    assert.deepEqual(inspection.verifyCommands, hasTest ? ["npm test"] : []);
    const project = synthesizeProject({ inspection, strategy: "custom" });
    assert.deepEqual(project.driftAudit.buildCommands, inspection.buildCommands);
    assert.deepEqual(project.driftAudit.verifyCommands, inspection.verifyCommands);
    assert.equal(inspection.verifyCommands.length === 0, inspection.warnings.some((line) => /verifyCommands is empty/.test(line)), "a target without a test script yields a warning");
  }
});

test("AC46: a target without a test script yields an empty verifyCommands and a warning on stderr, never an invented command", async () => {
  await onboarded(["--repo", "example-owner/dotnet-app"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(entryOf(manifest(), "dotnet-app").driftAudit.verifyCommands, []);
    assert.match(run.stderr, /warning: example-owner\/dotnet-app: .*verifyCommands is empty \(S5 never invents a command\)/);
  });
});

// --- AC47: strategy and schedule -------------------------------------------------------------------------------------------

const STRATEGY_CASES = [
  { label: "auto with a --watch-url (and a package.json)", repo: "node-app", args: ["--watch-url", "https://example.com/changelog"], expected: "content-and-docs-sync", printed: /Upkeep strategy: content-and-docs-sync \(resolved from auto\)/ },
  { label: "auto with a provenance file", repo: "provenance-like", args: [], expected: "content-and-docs-sync", printed: /Upkeep strategy: content-and-docs-sync \(resolved from auto\)/ },
  { label: "auto with only a package.json", repo: "node-app", args: [], expected: "dependency-and-pattern-modernization", printed: /Upkeep strategy: dependency-and-pattern-modernization \(resolved from auto\)/ },
  { label: "auto with only a .csproj", repo: "dotnet-app", args: [], expected: "dependency-and-pattern-modernization", printed: /\(resolved from auto\)/ },
  { label: "auto with nothing to detect", repo: "plain", args: [], expected: "code-quality-and-improvement-scan", printed: /Upkeep strategy: code-quality-and-improvement-scan \(resolved from auto\)/, repos: PLAIN },
  { label: "an explicit custom", repo: "node-app", args: ["--strategy", "custom"], expected: "custom", printed: /Upkeep strategy: custom\n/ },
  { label: "an explicit content-and-docs-sync", repo: "node-app", args: ["--strategy", "content-and-docs-sync"], expected: "content-and-docs-sync", printed: /Upkeep strategy: content-and-docs-sync\n/ },
  { label: "an explicit dependency-and-pattern-modernization on a repository without a manifest", repo: "plain", args: ["--strategy", "dependency-and-pattern-modernization"], expected: "dependency-and-pattern-modernization", printed: /Upkeep strategy: dependency-and-pattern-modernization\n/, repos: PLAIN },
  { label: "an explicit code-quality-and-improvement-scan", repo: "node-app", args: ["--strategy", "code-quality-and-improvement-scan"], expected: "code-quality-and-improvement-scan", printed: /Upkeep strategy: code-quality-and-improvement-scan\n/ },
];

for (const { label, repo, args, expected, printed, repos } of STRATEGY_CASES) {
  test(`AC47: ${label}: upkeepStrategy ${expected}, printed, and context7 only for the modernization strategy`, async () => {
    await onboarded(["--repo", `example-owner/${repo}`, ...args], ({ run, manifest }) => {
      assert.equal(run.code, 0, run.stderr);
      const entry = entryOf(manifest(), repo);
      assert.equal(entry.driftAudit.upkeepStrategy, expected);
      assert.match(run.stderr, printed);
      const servers = entry.driftAudit.knowledgeSources.mcpServers;
      if (expected === "dependency-and-pattern-modernization") assert.deepEqual(servers, { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } });
      else assert.deepEqual(servers, {});
    }, { repos: repos ?? REPOS });
  });
}

test("AC47: resolveStrategy is a pure rule: watch URL or provenance first, then a manifest, then the scan; a given strategy is returned unchanged", () => {
  const bare = { provenanceFiles: [], packageManifests: [] };
  assert.equal(resolveStrategy("auto", { watchUrls: [{ url: "https://example.com" }], inspection: { ...bare, packageManifests: ["package.json"] } }), "content-and-docs-sync");
  assert.equal(resolveStrategy("auto", { watchUrls: [], inspection: { ...bare, provenanceFiles: [{ path: "source.json" }], packageManifests: ["package.json"] } }), "content-and-docs-sync");
  assert.equal(resolveStrategy("auto", { watchUrls: [], inspection: { ...bare, packageManifests: ["package.json"] } }), "dependency-and-pattern-modernization");
  assert.equal(resolveStrategy("auto", { watchUrls: [], inspection: bare }), "code-quality-and-improvement-scan");
  for (const strategy of ["custom", "content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan"]) {
    assert.equal(resolveStrategy(strategy, { watchUrls: [{ url: "x" }], inspection: { ...bare, packageManifests: ["package.json"] } }), strategy);
  }
});

test("AC47: --schedule is validated as a five-field cron expression and written to driftAudit.schedule; the default is 23 6 * * 1, off the hour", async () => {
  assert.equal(DEFAULT_SCHEDULE, "23 6 * * 1");
  await onboarded(["--repo", "example-owner/node-app", "--schedule", "0 5 * * 0"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(manifest(), "node-app").driftAudit.schedule, "0 5 * * 0");
    assert.match(scenario.workspace.read("sdlc.yaml"), /^ {6}schedule: "0 5 \* \* 0"$/m, "written as a quoted string");
  });
  await onboarded(["--repo", "example-owner/node-app"], ({ manifest }) => assert.equal(entryOf(manifest(), "node-app").driftAudit.schedule, "23 6 * * 1"));
});

for (const schedule of ["every day", "0 6 * * 1 *", "* * * *", "61 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 7", "@daily", "0  6 * * 1", " 0 6 * * 1", "0 6 * * 1 ", "5-1 * * * *", "*/0 * * * *", "a b c d e"]) {
  test(`AC47: --schedule ${JSON.stringify(schedule)} is rejected with a non-zero exit before anything is read or written`, async () => {
    await onboarded(["--repo", "example-owner/node-app", "--schedule", schedule], ({ run, scenario }) => {
      assert.equal(run.code, 2, run.stderr);
      assert.match(run.stderr, /is not a five-field cron expression/);
      assert.deepEqual(scenario.fake.log, []);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
    });
  });
}

test("AC47: the cron expressions that GitHub Actions accepts are accepted", () => {
  for (const schedule of ["0 6 * * 1", "*/15 * * * *", "0 0 1,15 * *", "0 9 * * MON-FRI", "0 0 1 JAN *", "30 4 1-7 * 1", "0 0 * * 0", "59 23 31 12 6"]) assert.equal(isValidCron(schedule), true, schedule);
});

// --- AC48: watch URLs ------------------------------------------------------------------------------------------------------

const WATCH_CASES = [
  ["https://example.com/changelog", { url: "https://example.com/changelog", label: "example.com/changelog", kind: "changelog" }],
  ["https://example.com/blog/feed.xml", { url: "https://example.com/blog/feed.xml", label: "example.com/blog/feed.xml", kind: "blog" }],
  ["https://example.com/feed.xml", { url: "https://example.com/feed.xml", label: "example.com/feed.xml", kind: "feed" }],
  ["https://example.com/guide", { url: "https://example.com/guide", label: "example.com/guide", kind: "docs" }],
  ["https://example.com/Release-Notes/v2", { url: "https://example.com/Release-Notes/v2", label: "example.com/Release-Notes/v2", kind: "changelog" }],
  ["https://github.com/org/repo/releases", { url: "https://github.com/org/repo/releases", label: "github.com/org/repo/releases", kind: "changelog" }],
  ["https://example.com/atom.atom", { url: "https://example.com/atom.atom", label: "example.com/atom.atom", kind: "feed" }],
  ["https://docs.example.com", { url: "https://docs.example.com", label: "docs.example.com/", kind: "docs" }],
  ["https://example.com/news?page=2", { url: "https://example.com/news?page=2", label: "example.com/news", kind: "docs" }],
];

for (const [url, expected] of WATCH_CASES) {
  test(`AC48: ${url} yields ${expected.kind} with the label ${expected.label}`, async () => {
    assert.deepEqual(parseWatchUrl(url), expected);
    await onboarded(["--repo", "example-owner/node-app", "--watch-url", url], ({ run, manifest }) => {
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(entryOf(manifest(), "node-app").driftAudit.knowledgeSources.watchUrls, [expected]);
    });
  });
}

for (const url of ["http://example.com", "https://*.example.com", "https://user:pw@example.com", "https://127.0.0.1/x", "https://10.0.0.1", "https://[::1]/x", "ftp://example.com/x", "example.com/changelog", "https://", "https://exa mple.com", "", "https://%2A.example.com/x", "https://example.*.com/x", "file:///etc/passwd"]) {
  test(`AC48: --watch-url ${JSON.stringify(url)} is rejected with a non-zero exit, before anything is read or written`, async () => {
    await onboarded(["--repo", "example-owner/node-app", "--watch-url", url], ({ run, scenario }) => {
      assert.equal(run.code, 2, run.stderr);
      assert.match(run.stderr, /--watch-url:/);
      assert.deepEqual(scenario.fake.log, []);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    });
  });
}

test("AC48: several --watch-url values become several entries in order, and a repeated URL is kept once", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--watch-url", "https://example.com/guide", "--watch-url", "https://example.com/changelog", "--watch-url", "https://example.com/guide"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(entryOf(manifest(), "node-app").driftAudit.knowledgeSources.watchUrls.map((entry) => [entry.url, entry.kind]), [
      ["https://example.com/guide", "docs"],
      ["https://example.com/changelog", "changelog"],
    ]);
  });
});

test("AC48: the kind rules are applied in order: changelog, then blog, then feed, then docs", () => {
  assert.equal(inferWatchKind("https://x.example/blog/changelog"), "changelog");
  assert.equal(inferWatchKind("https://x.example/blog/feed.xml"), "blog");
  assert.equal(inferWatchKind("https://x.example/feed.rss"), "feed");
  assert.equal(inferWatchKind("https://x.example/feed.atom"), "feed");
  assert.equal(inferWatchKind("https://x.example/feed.xml/"), "docs");
  assert.equal(inferWatchKind("https://x.example/"), "docs");
});

// --- AC49: the edge --------------------------------------------------------------------------------------------------------

test("AC49: edge-ok: the written sdlc.yaml is exactly the golden expected.sdlc.yaml, comment included", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], ({ run, scenario }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("onboard", "edge-ok", "expected.sdlc.yaml"));
  }, { manifest: "empty" });
});

test("AC49: edge-ok: every field that the schema requires is present with the value that the inspection supplies", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    const data = manifest();
    const [edge] = data.dependencyEdges;
    assert.deepEqual(Object.keys(edge), [
      "edgeId", "upstreamRepo", "upstreamKey", "upstreamSlug", "upstreamDefaultBranch", "initialBaselineSha", "downstreamRepo", "mode", "schedule", "onCommitOnlyAdvance",
      "stateVariable", "provenanceFile", "provenanceJsonPointer", "branchName", "closeOlderKey", "reviewers", "importCommands", "preflightCommands", "acceptCommands",
      "buildCommands", "verifyCommands", "adaptationInstructions", "allowedFiles", "protectedFilesExclude", "autoMerge", "immutableGates",
    ]);
    assert.equal(edge.edgeId, "node-app");
    assert.equal(edge.upstreamKey, "node-app");
    assert.equal(edge.upstreamSlug, "NODE_APP");
    assert.match(edge.upstreamSlug, /^[A-Z0-9_]{1,64}$/);
    assert.equal(edge.stateVariable, "SDLC_SYNC_STATE_NODE_APP");
    assert.equal(edge.mode, "ai-adaptation");
    assert.equal(edge.onCommitOnlyAdvance, "noop");
    assert.equal(edge.initialBaselineSha, "2222222222222222222222222222222222222222");
    assert.equal(edge.branchName, "sdlc/cascade-node-app");
    assert.equal(edge.closeOlderKey, "sdlc-cascade-node-app");
    assert.equal(edge.provenanceFile, "public/imported/source.json");
    assert.equal(edge.provenanceJsonPointer, "/commit");
    assert.deepEqual(edge.reviewers, ["hub-reviewer"], "the individual owner of the downstream's CODEOWNERS; the team is not a reviewer");
    assert.deepEqual(edge.allowedFiles, ["public/imported/**"]);
    assert.strictEqual(edge.autoMerge, false);
    assert.deepEqual(edge.immutableGates, { zeroDiffPaths: [] });
    assert.equal("lockedTestBlocks" in edge.immutableGates || "inProcessInvariants" in edge.immutableGates, false);
    assert.equal(edge.adaptationInstructions, "");
    assert.equal(edge.schedule, null);
    assert.deepEqual([edge.importCommands, edge.preflightCommands, edge.acceptCommands, edge.protectedFilesExclude], [[], [], [], []]);
    const downstream = entryOf(data, "edge-ok");
    assert.strictEqual(downstream.driftAudit.enabled, false, "a downstream hub does not gain an unrequested drift workflow");
    assert.deepEqual(downstream.driftAudit.reviewers, ["hub-reviewer"]);
    assert.equal(entryOf(data, "node-app").driftAudit.enabled, true);
  }, { manifest: "empty" });
});

test("AC49: edge-mechanical: a downstream with exactly one import:* script resolves --mode auto to mechanical, with a note about importCommands", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-mechanical"], ({ run, scenario }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("onboard", "edge-mechanical", "expected.sdlc.yaml"));
    assert.match(run.stderr, /warning: importCommands is empty: add the command that imports the upstream into the downstream to sdlc\.yaml/);
  }, { manifest: "empty" });
});

for (const [downstream, mode, expected] of [
  ["edge-ok", "mechanical", "mechanical"],
  ["edge-mechanical", "ai-adaptation", "ai-adaptation"],
  ["edge-ok", "auto", "ai-adaptation"],
  ["edge-mechanical", "auto", "mechanical"],
]) {
  test(`AC49: --mode ${mode} on ${downstream} yields mode ${expected}`, async () => {
    await onboarded(["--repo", "example-owner/node-app", "--downstream", `example-owner/${downstream}`, "--mode", mode], ({ run, manifest }) => {
      assert.equal(run.code, 0, run.stderr);
      assert.equal(manifest().dependencyEdges.at(-1).mode, expected);
    });
  });
}

test("AC49: resolveMode: exactly one import:* script is mechanical, none or several are ai-adaptation, an explicit mode wins", () => {
  assert.equal(resolveMode("auto", { importScripts: ["import:a"] }), "mechanical");
  assert.equal(resolveMode("auto", { importScripts: [] }), "ai-adaptation");
  assert.equal(resolveMode("auto", { importScripts: ["import:a", "import:b"] }), "ai-adaptation");
  assert.equal(resolveMode("mechanical", { importScripts: [] }), "mechanical");
  assert.equal(resolveMode("ai-adaptation", { importScripts: ["import:a"] }), "ai-adaptation");
});

test("AC49: --mode without --downstream is a usage error", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--mode", "mechanical"], ({ run, scenario }) => {
    assert.equal(run.code, 2);
    assert.match(run.stderr, /--mode mechanical needs --downstream/);
    assert.deepEqual(scenario.fake.log, []);
  });
});

test("AC49: the key gh-admin-msft yields the slug GH_ADMIN_MSFT, the state variable name and the created variable", async () => {
  assert.equal(slugOf("gh-admin-msft"), "GH_ADMIN_MSFT");
  assert.equal(slugOf("a-b-c1"), "A_B_C1");
  await onboarded(["--repo", "example-owner/gh-admin-msft", "--downstream", "example-owner/edge-ok"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    const edge = manifest().dependencyEdges.at(-1);
    assert.deepEqual([edge.edgeId, edge.upstreamKey, edge.upstreamSlug, edge.stateVariable], ["gh-admin-msft", "gh-admin-msft", "GH_ADMIN_MSFT", "SDLC_SYNC_STATE_GH_ADMIN_MSFT"]);
    assert.deepEqual(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").map((entry) => entry.body.name), ["SDLC_SYNC_STATE_GH_ADMIN_MSFT"]);
  }, { repos: { ...REPOS, ...fixtureRepos({ "example-owner/gh-admin-msft": "node-app" }) } });
});

const DOWNSTREAM_REPOS = { ...REPOS, ...fixtureRepos({ "example-owner/example-downstream": "edge-ok" }, { "example-owner/example-downstream": { fullName: "example-owner/example-downstream" } }), ...fixtureRepos({ "other-owner/example-downstream": "edge-ok" }) };

test("AC49: cross-owner-downstream-rejected: a downstream under another owner exits non-zero naming it and both owners, with no file written and no request at all", async () => {
  const scenario = await createScenario({ fake: { repos: DOWNSTREAM_REPOS } });
  try {
    scenario.workspace.commitAll();
    const run = await scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "other-owner/example-downstream"], { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0);
    assert.ok(run.stderr.includes("other-owner/example-downstream"), run.stderr);
    assert.ok(run.stderr.includes("'other-owner'"), "the downstream owner");
    assert.ok(run.stderr.includes("'example-owner'"), "the owner of the central repository");
    assert.equal(scenario.workspace.status(), "", "no file was written in the working copy");
    assert.deepEqual(scenario.fake.log, [], "no request, so no state-variable request either");
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.equal(run.stdout, "");
  } finally {
    await scenario.cleanup();
  }
});

test("AC49: the same run with --downstream example-owner/example-downstream is accepted", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/example-downstream"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(manifest().dependencyEdges.at(-1).downstreamRepo, "example-owner/example-downstream");
  }, { repos: DOWNSTREAM_REPOS });
});

test("AC49: mixed-case-owner-accepted: --downstream Example-Owner/example-downstream differs from example-owner only in letter case and is accepted", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "Example-Owner/example-downstream"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /different owner/);
    assert.equal(manifest().dependencyEdges.at(-1).downstreamRepo, "example-owner/example-downstream", "written in the spelling that GitHub reports");
  }, { repos: DOWNSTREAM_REPOS });
});

const RENAMED_REPOS = {
  ...REPOS,
  ...fixtureRepos({ "other-owner/edge-ok": "edge-ok" }),
  ...fixtureRepos({ "example-owner/edge-ok": "edge-ok" }, { "example-owner/edge-ok": { fullName: "other-owner/edge-ok" } }),
};

for (const typed of ["example-owner/edge-ok", "Example-Owner/edge-ok"]) {
  test(`AC49: resolved-owner-rejected: --downstream ${typed} is under the orchestrator's owner as typed but GitHub resolves it to other-owner/edge-ok (transferred or renamed): rejected before any file write, variable request or S1 call`, async () => {
    await onboarded(["--repo", "example-owner/node-app", "--downstream", typed], ({ run, scenario }) => {
      assert.notEqual(run.code, 0);
      for (const named of [typed, "other-owner/edge-ok", "'other-owner'", "'example-owner'"]) assert.ok(run.stderr.includes(named), `${named} in: ${run.stderr}`);
      assert.match(run.stderr, /is under a different owner than the central orchestrator repository/);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"), "sdlc.yaml is untouched");
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.deepEqual(scenario.fake.requests("* /repos/:owner/:repo/actions/variables", "* /repos/:owner/:repo/actions/variables/:name"), [], "no state-variable request");
      assert.deepEqual(scenario.fake.nonGet(), [], "no write of any kind");
      assert.equal(scenario.reconcile.calls.length, 0);
      assert.equal(run.stdout, "");
    }, { repos: RENAMED_REPOS });
  });
}

test("AC49: a downstream that GitHub resolves to the same owner in another letter case is still accepted, and the edge records the resolved spelling", async () => {
  const repos = { ...REPOS, ...fixtureRepos({ "example-owner/edge-ok": "edge-ok" }, { "example-owner/edge-ok": { fullName: "Example-Owner/edge-ok" } }) };
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], ({ run, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(manifest().dependencyEdges.at(-1).downstreamRepo, "Example-Owner/edge-ok");
  }, { repos });
});

for (const downstream of ["example-owner2/example-downstream", "example/example-downstream", "example-owner-/example-downstream", "xexample-owner/example-downstream"]) {
  test(`AC49: ${downstream} is a different owner, even though it contains the orchestrator's owner`, async () => {
    await onboarded(["--repo", "example-owner/node-app", "--downstream", downstream], ({ run, scenario }) => {
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /is under a different owner than the central orchestrator repository/);
      assert.deepEqual(scenario.fake.log, []);
    });
  });
}

test("AC49: a downstream whose inspection lacks a required field exits non-zero, lists that field, writes nothing and creates no variable", async () => {
  for (const [downstream, field] of [
    ["edge-no-provenance", /provenanceFile, provenanceJsonPointer and allowedFiles \(no provenance file found in example-owner\/edge-no-provenance; exactly one is needed\)/],
    ["edge-two-provenance", /provenanceFile, provenanceJsonPointer and allowedFiles \(2 provenance files found in example-owner\/edge-two-provenance; exactly one is needed\)/],
    ["lab-like", /provenanceJsonPointer \(docs\/_meta\/registry\.yaml holds no 40-hex "commit" key\)[\s\S]*reviewers \(no individual owner in \.github\/CODEOWNERS of example-owner\/lab-like/],
  ]) {
    await onboarded(["--repo", "example-owner/node-app", "--downstream", `example-owner/${downstream}`], ({ run, scenario }) => {
      assert.notEqual(run.code, 0, downstream);
      assert.match(run.stderr, /S5 never invents a field/);
      assert.match(run.stderr, field);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.deepEqual(scenario.fake.requests("* /repos/:owner/:repo/actions/variables", "* /repos/:owner/:repo/actions/variables/:name"), []);
      assert.equal(scenario.reconcile.calls.length, 0);
    }, { manifest: "standard" });
  }
});

test("AC49: synthesizeEdge: the downstream's provenance commit is the baseline, the reviewers are its individual owners and the allowedFiles bound the cascade", () => {
  const inspect = (overrides) => ({
    repo: "o/down", defaultBranch: "main", headSha: "9".repeat(40), packageManifests: [], scriptNames: [], buildCommands: [], verifyCommands: [], importScripts: [], workflows: [],
    provenanceFiles: [], codeowners: { present: true, individuals: ["rev"], teams: [] }, warnings: [], ...overrides,
  });
  const upstream = inspect({ repo: "o/Up_Stream.Repo", headSha: "8".repeat(40) });
  const root = synthesizeEdge({ upstream, downstream: inspect({ provenanceFiles: [{ path: "source.json", commit: "1".repeat(40), pointer: "/commit" }] }), mode: "auto" });
  assert.equal(root.edge.allowedFiles[0], "source.json", "a provenance file at the repository root bounds the cascade to that file");
  assert.equal(root.edge.edgeId, "up-stream-repo");
  assert.equal(root.edge.upstreamSlug, "UP_STREAM_REPO");
  assert.equal(root.edge.initialBaselineSha, "1".repeat(40));
  const nested = synthesizeEdge({ upstream, downstream: inspect({ provenanceFiles: [{ path: "a/b/source.json", commit: "1".repeat(40), pointer: "/x/commit" }] }), mode: "auto" });
  assert.deepEqual([nested.edge.allowedFiles, nested.edge.provenanceJsonPointer], [["a/b/**"], "/x/commit"]);
  const teamsOnly = synthesizeEdge({ upstream, downstream: inspect({ codeowners: { present: true, individuals: [], teams: ["@o/team"] }, provenanceFiles: [{ path: "source.json", commit: "1".repeat(40), pointer: "/commit" }] }), mode: "auto" });
  assert.equal(teamsOnly.edge, null);
  assert.match(teamsOnly.missing[0], /reviewers \(no individual owner in \.github\/CODEOWNERS of o\/down; a team cannot be requested as a reviewer\)/);
});

// --- AC50: instructions/<projectKey>.md ------------------------------------------------------------------------------------

const HEADINGS = ["## Detected repository facts", "### Package manifests", "### Commands", "### Scheduled workflows", "### Provenance files"];

test("AC50: a literal --instructions text starts the file, the generated section follows, and the entry carries the file path and the literal text", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--instructions", "Keep docs current"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    const text = scenario.workspace.read("instructions/node-app.md");
    assert.ok(text.startsWith("Keep docs current\n\n<!-- sdlc-onboard:generated -->\n"), JSON.stringify(text.slice(0, 80)));
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "exactly one trailing newline");
    for (const heading of HEADINGS) assert.ok(text.includes(heading), heading);
    const entry = entryOf(manifest(), "node-app");
    assert.equal(entry.driftAudit.instructionsFile, "instructions/node-app.md");
    assert.equal(entry.driftAudit.instructions, "Keep docs current");
  });
});

test("AC50: an existing file path is copied byte for byte (CRLF and non-ASCII text included) and the entry's instructions field is empty", async () => {
  const operator = "# Operator notes\r\n\r\nPrüfe die Änderungen — keep 日本語 intact.\r\nLast line without a trailing newline";
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    scenario.workspace.write("notes/instructions.md", operator);
    const run = await scenario.onboard(["--repo", "example-owner/node-app", "--instructions", "notes/instructions.md"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    const bytes = fs.readFileSync(scenario.workspace.path("instructions/node-app.md"));
    assert.ok(bytes.subarray(0, Buffer.byteLength(operator)).equals(Buffer.from(operator)), "the operator's bytes come first, unchanged");
    const text = bytes.toString("utf8");
    assert.ok(text.slice(operator.length).startsWith("\n\n<!-- sdlc-onboard:generated -->"));
    assert.equal(YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((project) => project.projectKey === "node-app").driftAudit.instructions, "");
  } finally {
    await scenario.cleanup();
  }
});

test("AC50: without --instructions the file holds the generated section only and the entry's instructions field is empty", async () => {
  await onboarded(["--repo", "example-owner/lab-like"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    const text = scenario.workspace.read("instructions/lab-like.md");
    assert.ok(text.startsWith(`${GENERATED_MARKER}\n## Detected repository facts\n`));
    assert.ok(text.endsWith("\n"));
    assert.equal(entryOf(manifest(), "lab-like").driftAudit.instructions, "");
    assert.equal(entryOf(manifest(), "lab-like").driftAudit.instructionsFile, "instructions/lab-like.md");
  });
});

test("AC50: the generated section lists the detected manifests, commands, scheduled workflows and provenance files", async () => {
  await onboarded(["--repo", "example-owner/lab-like"], ({ scenario }) => {
    const text = scenario.workspace.read("instructions/lab-like.md");
    assert.match(text, /### Scheduled workflows\n\n- `\.github\/workflows\/weekly-sweep\.yml`/);
    assert.match(text, /### Provenance files\n\n- `docs\/_meta\/registry\.yaml`/);
    assert.match(text, /### Package manifests\n\nNone detected\./);
  });
  await onboarded(["--repo", "example-owner/node-app"], ({ scenario }) => {
    const text = scenario.workspace.read("instructions/node-app.md");
    assert.match(text, /### Package manifests\n\n- `package\.json`/);
    assert.match(text, /### Commands\n\n- Build: `npm run build`\n- Verify: `npm test`/);
    assert.match(text, /### Scheduled workflows\n\nNone detected\./);
    assert.ok(text.includes("Repository `example-owner/node-app`, default branch `main`."));
  });
});

test("AC50: the file is valid UTF-8 without a byte order mark and ends with exactly one newline", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--instructions", "Ünïcödé — ✓"], ({ scenario }) => {
    const bytes = fs.readFileSync(scenario.workspace.path("instructions/node-app.md"));
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.at(-1), 0x0a);
    assert.notEqual(bytes.at(-2), 0x0a);
    assert.ok(bytes.toString("utf8").startsWith("Ünïcödé — ✓\n\n"));
  });
});

test("AC50: a multi-line literal --instructions text is kept as written in the file and round-trips through sdlc.yaml", async () => {
  const text = "First line\nSecond line: with a colon\n  - indented item\n";
  await onboarded(["--repo", "example-owner/node-app", "--instructions", text], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(manifest(), "node-app").driftAudit.instructions, text);
    assert.ok(scenario.workspace.read("instructions/node-app.md").startsWith(`${text}\n<!-- sdlc-onboard:generated -->`));
  });
});

test("AC50: a value that looks like a path but names no file is literal text", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--instructions", "notes/missing.md"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(manifest(), "node-app").driftAudit.instructions, "notes/missing.md");
    assert.ok(scenario.workspace.read("instructions/node-app.md").startsWith("notes/missing.md\n\n"));
  });
});

for (const [label, text] of [
  ["a PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfixture\n-----END RSA PRIVATE KEY-----"],
  ["a classic personal access token", `use ghp_${"A1b2C3d4E5".repeat(4)} for the checks`],
  ["a fine-grained personal access token", `github_pat_${"A1b2C3d4E5_".repeat(5)}`],
  ["an OAuth token", "gho_fixturevalue0123456789"],
]) {
  test(`AC50: --instructions holding ${label} is refused with a diagnostic that does not echo it, and nothing is written`, async () => {
    await onboarded(["--repo", "example-owner/node-app", `--instructions=${text}`], ({ run, scenario }) => {
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /--instructions appears to contain a credential/);
      assert.equal(run.stderr.includes(text.slice(0, 30)), false);
      assert.equal(scenario.workspace.read("sdlc.yaml"), readFixture("manifest.standard.yaml"));
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.equal(scenario.reconcile.calls.length, 0);
    });

    const scenario = await createScenario({ fake: { repos: REPOS } });
    try {
      scenario.workspace.write("notes/secret-notes.md", `Notes\n${text}\n`);
      const run = await scenario.onboard(["--repo", "example-owner/node-app", "--instructions", "notes/secret-notes.md"], { env: scenario.env(scenario.appCredentials()) });
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /the instructions file notes\/secret-notes\.md appears to contain a credential/);
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC50: neither the instructions file nor sdlc.yaml holds a credential after a normal run", async () => {
  await onboarded(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], ({ run, scenario }) => {
    assert.equal(run.code, 0, run.stderr);
    for (const text of [scenario.workspace.read("sdlc.yaml"), scenario.workspace.read("instructions/node-app.md")]) {
      assert.equal(/-----BEGIN|gh[pousr]_|github_pat_|gho_|client_secret|webhook_secret/.test(text), false);
    }
  });
});
