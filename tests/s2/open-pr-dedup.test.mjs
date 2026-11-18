// AC10 and the equivalence of design E3. Open pull request deduplication (the second pre-agent step of every drift workflow, the third of every implementation
// workflow) used to carry this fleet's own conventions inside the script: the branch prefixes automation/weekly-audit-* and automation/self-improve-* (and the
// orchestrator's sdlc/*), the labels content-audit and self-improving-agents, the upkeep that each stands for, and which upkeep each strategy does. The script is the
// engine's now, and the conventions are the `dedupe` block of sdlc.yaml, which the step reads through `--project <projectKey>`.
//
// The engine's own tests prove the script on a neutral block (tests/dedupe-config of the package). What only this repository can prove is here, in three parts:
//   1. the data: the block says what the script used to say, and the committed steps hand the project key to the script;
//   2. the table (E3): for every pull request that the old script could have matched, under every kind of workflow and every strategy, the decisions of the engine
//      with THIS block equal those of the old script, kept below verbatim as the reference; the one reading that the data cannot carry over is pinned by name;
//   3. the script run as a command against a fake GitHub on the real manifest: the records that AC10 requires (the reasons, whose pull request it is, what the
//      workflow does about it), for each of the three drift projects.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importEngine, INSTANCE_ROOT } from "../helpers/instance.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, implementWorkflow, listTree, presetManifest, tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./helpers/stub-server.mjs";

// the script and the manifest reader of the installed engine: deep imports, so that a change of either is noticed here
const { belongsToWorkflow, decide, matchReasons, normalizeCloseOlderKey, run, upkeepOf, upkeepOfStrategy } = await importEngine("src/drift/dedupe-open-prs.mjs");
const { readProjectDedupe } = await importEngine("src/drift/lib/manifest.mjs");

/** What the engine hands to the script for this fleet: the block of sdlc.yaml as the reader behind `--project` returns it. The table of part 2 runs on this, not on a copy of it. */
const BLOCK = await readProjectDedupe({ manifestPath: abs("sdlc.yaml"), projectKey: "copilot-lab" });

// ---- 1. the data -----------------------------------------------------------------------------------------------------------------------------

/** What the old script said, as data: two upkeeps of the target's own schedules (the branch families of each: the lab's own and the orchestrator's), and the strategy of each. */
const CONVENTIONS = {
  upkeeps: [
    { id: "weekly-audit", branchPrefixes: ["automation/weekly-audit-", "sdlc/weekly-audit-"], labels: ["content-audit"] },
    { id: "self-improve", branchPrefixes: ["automation/self-improve-", "sdlc/self-improve-"], labels: ["self-improving-agents"] },
  ],
  strategyUpkeep: { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" },
};
const IMPLEMENT_KEYS = ["gh-admin-msft", "copilot-lab", "self-improving-agents"];
const STEP = "Deduplicate open pull requests";

test("E3: sdlc.yaml carries the conventions once, at the top level of the fleet, and no project overrides them", () => {
  const manifest = presetManifest();
  assert.deepEqual(manifest.dedupe, CONVENTIONS);
  for (const project of manifest.projects) assert.equal("dedupe" in project.driftAudit, false, `${project.projectKey} has no block of its own, so the fleet's applies`);
});

test("E3: the engine's reader gives every drift project that block, which is what the dedupe step reads through --project", async () => {
  for (const key of DRIFT_KEYS) assert.deepEqual(await readProjectDedupe({ manifestPath: abs("sdlc.yaml"), projectKey: key }), CONVENTIONS, key);
});

for (const key of DRIFT_KEYS) {
  test(`AC10: the rendered deduplication step of drift-${key} names the workflow, the strategy of the manifest and the project that holds the conventions; no credential is on the command line`, () => {
    const { frontmatter } = driftWorkflow(key);
    const step = frontmatter["pre-agent-steps"].find((candidate) => candidate.name === STEP);
    const handlerKey = frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"];
    assert.equal(handlerKey, `sdlc-drift-${key}`);
    assert.match(step.run, /^node "\$GITHUB_WORKSPACE\/node_modules\/ai-sdlc-factory\/src\/drift\/dedupe-open-prs\.mjs" --out \/tmp\/gh-aw\/agent --target-repo "\$CONFIGURED_TARGET_REPO" /);
    assert.ok(step.run.endsWith(` --close-older-key ${handlerKey} --upkeep-strategy ${driftPreset(key).driftAudit.upkeepStrategy} --project ${key}`), "the key of the safe output, the strategy of the manifest, and the project");
    assert.equal(/APP_PRIVATE_KEY|ghs_|github_pat/.test(step.run), false, "and no credential on the command line");
  });
}

for (const key of IMPLEMENT_KEYS) {
  test(`AC10 and AC45: the rendered deduplication step of implement-${key} is the implementation form, with the project`, () => {
    const step = implementWorkflow(key).frontmatter["pre-agent-steps"].find((candidate) => candidate.name === STEP);
    assert.ok(step.run.endsWith(` --upkeep-strategy ${driftPreset(key).driftAudit.upkeepStrategy} --implementation --project ${key}`), step.run);
    assert.equal(step.run.includes("--close-older-key"), false, "--implementation and --close-older-key name two different workflows");
  });
}

test("AC10: the preset's two lab workflows are told apart by the strategy, and the strategies map to the upkeeps of the lab's own schedules", () => {
  assert.equal(driftPreset("copilot-lab").driftAudit.upkeepStrategy, "content-and-docs-sync");
  assert.equal(driftPreset("self-improving-agents").driftAudit.upkeepStrategy, "code-quality-and-improvement-scan");
  assert.equal(upkeepOfStrategy(BLOCK, driftPreset("copilot-lab").driftAudit.upkeepStrategy), "weekly-audit");
  assert.equal(upkeepOfStrategy(BLOCK, driftPreset("self-improving-agents").driftAudit.upkeepStrategy), "self-improve");
});

for (const key of DRIFT_KEYS) {
  test(`AC10: the prompt of drift-${key} tells the agent to read open-pr-dedup.json before it calls create_pull_request`, () => {
    const { body } = driftWorkflow(key);
    assert.match(body, /Read `\/tmp\/gh-aw\/agent\/open-pr-dedup\.json` before (?:you )?call(?:ing)? `create_pull_request`/);
    assert.match(body, /skip the pull request when it lists a matching open pull request/);
    assert.ok(body.indexOf("open-pr-dedup.json") < body.indexOf("## Operating rules") || body.includes("## Operating rules"), "the rule is in the rendered prompt");
  });
}

// ---- 2. the table (E3) -----------------------------------------------------------------------------------------------------------------------

/**
 * The decisions of the dedupe script as they were before the conventions became data: src/drift/dedupe-open-prs.mjs of 3d1b52b (matchReasons, upkeepOf and decide, with the
 * constants that were compiled into it), kept verbatim as the reference of the table. It is frozen: it is the old behaviour, and the table holds the manifest to it.
 */
const legacy = (() => {
  const BRANCH_PREFIXES = ["automation/weekly-audit-", "automation/self-improve-", "sdlc/"];
  const BRANCH_PATTERNS = BRANCH_PREFIXES.map((prefix) => `${prefix}*`);
  const LABELS = ["content-audit", "self-improving-agents"];
  const UPKEEP_OF_LABEL = { "content-audit": "weekly-audit", "self-improving-agents": "self-improve" };
  const UPKEEP_OF_STEM = [
    ["weekly-audit-", "weekly-audit"],
    ["self-improve-", "self-improve"],
  ];
  const UPKEEP_OF_STRATEGY = { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" };
  const IMPLEMENTATION_HEAD = /^sdlc\/implement-report-[1-9][0-9]*$/;
  const matchReasonsOld = (pull) => {
    const reasons = [];
    const ref = String(pull?.head?.ref ?? "");
    BRANCH_PREFIXES.forEach((prefix, position) => {
      if (ref.startsWith(prefix)) reasons.push(`head branch matches ${BRANCH_PATTERNS[position]}`);
    });
    const labels = (Array.isArray(pull?.labels) ? pull.labels : []).map((label) => String(label?.name ?? ""));
    for (const label of LABELS) if (labels.includes(label)) reasons.push(`carries the label ${label}`);
    return reasons;
  };
  const belongsOld = (pull, closeOlderKey) => {
    const key = normalizeCloseOlderKey(closeOlderKey);
    return key !== "" && String(pull?.body ?? "").includes(`<!-- gh-aw-close-key: ${key} -->`);
  };
  const upkeepOfOld = (pull) => {
    const stem = String(pull?.head?.ref ?? "").replace(/^(?:automation|sdlc)\//, "");
    const found = new Set(UPKEEP_OF_STEM.filter(([prefix]) => stem.startsWith(prefix)).map(([, upkeep]) => upkeep));
    for (const label of Array.isArray(pull?.labels) ? pull.labels : []) {
      const upkeep = Object.hasOwn(UPKEEP_OF_LABEL, String(label?.name ?? "")) ? UPKEEP_OF_LABEL[String(label.name)] : undefined;
      if (upkeep !== undefined) found.add(upkeep);
    }
    return found.size === 1 ? [...found][0] : null;
  };
  const decideOld = (pull, workflow) => {
    const upkeep = upkeepOfOld(pull);
    if (workflow.closeOlderKey !== null && belongsOld(pull, workflow.closeOlderKey)) return { belongsTo: "current-workflow", upkeep, decision: "ignore" };
    const head = String(pull?.head?.ref ?? "");
    const known = workflow.closeOlderKey !== null || workflow.implementation === true;
    if (known && IMPLEMENTATION_HEAD.test(head)) return { belongsTo: "implementation", upkeep, decision: "ignore" };
    if (workflow.implementation === true && head.startsWith("sdlc/")) return { belongsTo: "another-workflow-or-schedule", upkeep, decision: "ignore" };
    const other = workflow.upkeep !== null && upkeep !== null && upkeep !== workflow.upkeep;
    return { belongsTo: "another-workflow-or-schedule", upkeep, decision: other ? "ignore" : "skip" };
  };
  const upkeepOfStrategyOld = (strategy) => (Object.hasOwn(UPKEEP_OF_STRATEGY, strategy) ? UPKEEP_OF_STRATEGY[strategy] : null);
  return { matchReasons: matchReasonsOld, upkeepOf: upkeepOfOld, decide: decideOld, upkeepOfStrategy: upkeepOfStrategyOld };
})();

const pull = (number, ref, labels = [], body = undefined) => ({ number, html_url: `https://github.example/example-owner/example-target/pull/${number}`, head: { ref }, labels: labels.map((name) => ({ name })), draft: false, ...(body === undefined ? {} : { body }) });

/** A head branch that the table does not take from the bare stems below is one that a schedule or the orchestrator could name, or one that they could not. */
const REFS = [
  "automation/weekly-audit-2026-11-01", "automation/self-improve-2026-11-02", "automation/weekly-audit-", "automation/weekly-audit", "automation/self-improve-", "automation/other-1",
  "sdlc/weekly-audit-2026-11-01", "sdlc/self-improve-2026-11-02", "sdlc/weekly-audit-", "sdlc/x", "sdlc/a/b", "sdlc/implement-report-7", "sdlc/implement-report-0", "sdlc/implement-report-7x", "sdlc",
  "SDLC/x", "feature/x", "feature/audited", "docs/automation/weekly-audit-x", "docs/sdlc/weekly-audit-x", "automation/automation/weekly-audit-x", "release/1.0", "main", "",
];
// a head branch without its namespace: the old code read the stem of any branch, so `weekly-audit-x` was an upkeep of its own (see the last test of this part)
const BARE_REFS = ["weekly-audit-x", "self-improve-x"];
const LABEL_SETS = [[], ["content-audit"], ["self-improving-agents"], ["content-audit", "self-improving-agents"], ["other"], ["Content-Audit"], ["content-audit", "other"], ["automated", "sdlc-drift", "needs-review"]];
const KEY = "sdlc-drift-copilot-lab";
const BODIES = [undefined, `Proposed changes.\n\n<!-- gh-aw-close-key: ${KEY} -->\n`, "<!-- gh-aw-close-key: some-other-key -->"];
const STRATEGIES = ["content-and-docs-sync", "code-quality-and-improvement-scan", "dependency-and-pattern-modernization", "custom", ""];
const KINDS = [
  { name: "a drift workflow", closeOlderKey: KEY, implementation: false },
  { name: "an implementation workflow", closeOlderKey: null, implementation: true },
  { name: "a workflow that nothing is known about", closeOlderKey: null, implementation: false },
];

/** The candidates of the table: every head branch and label set, with the head of a bare stem told apart. */
function* pulls(refs = REFS) {
  for (const ref of refs) for (const labels of LABEL_SETS) for (const body of BODIES) yield { ref, labels, body, candidate: pull(1, ref, labels, body) };
}

test("E3 table: the reasons that a pull request is a possible duplicate, in their order, are the old ones for every head branch and label set", () => {
  let compared = 0;
  for (const { ref, labels, candidate } of pulls([...REFS, ...BARE_REFS])) {
    assert.deepEqual(matchReasons(candidate, BLOCK), legacy.matchReasons(candidate), `reasons of ${JSON.stringify([ref, labels])}`);
    compared += 1;
  }
  assert.ok(compared > 500, `${compared} pull requests compared`);
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit-x", ["self-improving-agents"]), BLOCK), ["head branch matches automation/weekly-audit-*", "carries the label self-improving-agents"], "the text of a reason is unchanged");
});

test("E3 table: the upkeep of each strategy is the old one, for the four strategies of the schema and for none", () => {
  for (const strategy of STRATEGIES) assert.equal(upkeepOfStrategy(BLOCK, strategy), legacy.upkeepOfStrategy(strategy), `the upkeep of '${strategy}'`);
  assert.equal(upkeepOfStrategy(BLOCK, "toString"), null, "and a name of Object.prototype is no strategy");
});

test("E3 table: the upkeep of a pull request, and what a drift workflow, an implementation workflow and an unknown workflow do about it, equal the old decisions for every pull request that the old script could match", () => {
  let compared = 0;
  for (const { ref, labels, body, candidate } of pulls()) {
    if (legacy.matchReasons(candidate).length === 0) continue; // the script decides about the candidates only
    assert.equal(upkeepOf(candidate, BLOCK), legacy.upkeepOf(candidate), `upkeep of ${JSON.stringify([ref, labels])}`);
    for (const kind of KINDS) {
      for (const strategy of STRATEGIES) {
        const workflow = { closeOlderKey: kind.closeOlderKey, implementation: kind.implementation, upkeep: legacy.upkeepOfStrategy(strategy) };
        assert.deepEqual(decide(candidate, { ...workflow, upkeep: upkeepOfStrategy(BLOCK, strategy), config: BLOCK }), legacy.decide(candidate, workflow), `${kind.name}, strategy '${strategy}', ${JSON.stringify([ref, labels, body])}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 5000, `${compared} decisions compared`);
});

test("E3 table: whose pull request it is follows from gh-aw's marker for the close-older key, as before", () => {
  const own = pull(1, "sdlc/weekly-audit-2026-11-01", [], `x\n<!-- gh-aw-close-key: ${KEY} -->\n`);
  assert.equal(belongsToWorkflow(own, KEY), true);
  assert.equal(belongsToWorkflow(own, "  SDLC-Drift-Copilot-Lab "), true, "the key is normalized as gh-aw does: lower case, runs of other characters are one dash");
  assert.equal(belongsToWorkflow(own, "sdlc-drift-copilot"), false, "a key that is a prefix of the marker's is another key");
  assert.equal(belongsToWorkflow(own, "sdlc-drift-self-improving-agents"), false);
  assert.equal(belongsToWorkflow(pull(1, "sdlc/weekly-audit-2026-11-01", [], null), KEY), false, "no body, no marker");
  assert.equal(belongsToWorkflow(pull(1, "sdlc/weekly-audit-2026-11-01", ["sdlc-drift"]), KEY), false, "neither a head branch under sdlc/ nor the labels of the fleet make a pull request this workflow's");
  assert.equal(normalizeCloseOlderKey("My Key!"), "my-key");
});

test("E3 table: the one reading that the data does not carry over is a head branch without its namespace (weekly-audit-x), and it shows only for a label of the other upkeep", () => {
  // The old code removed `automation/` or `sdlc/` from the head and then read the stem, so a bare `weekly-audit-x` was an upkeep of its own. A declared prefix is a whole
  // prefix (`automation/weekly-audit-`, `sdlc/weekly-audit-`), so a bare branch is no upkeep of its head any more. A bare branch is no candidate by its head either way (no
  // prefix of the old list matches it), so the reading can differ only for a pull request that is a candidate through a label, and then only when that label is the other
  // upkeep's: with the label of its own upkeep both readings say the same, and with both labels both say none.
  const different = [];
  for (const { ref, labels, candidate } of pulls([...REFS, ...BARE_REFS])) {
    if (legacy.matchReasons(candidate).length === 0) continue;
    if (upkeepOf(candidate, BLOCK) !== legacy.upkeepOf(candidate)) different.push(JSON.stringify([ref, labels]));
  }
  assert.deepEqual([...new Set(different)].sort(), [
    JSON.stringify(["self-improve-x", ["content-audit"]]),
    JSON.stringify(["self-improve-x", ["content-audit", "other"]]),
    JSON.stringify(["weekly-audit-x", ["self-improving-agents"]]),
  ].sort());
  const bare = pull(1, "weekly-audit-x", ["self-improving-agents"]);
  assert.equal(legacy.upkeepOf(bare), null, "old: the head says weekly-audit and the label says self-improve, so neither");
  assert.equal(upkeepOf(bare, BLOCK), "self-improve", "new: the head is no declared prefix, so the label alone says");
  const alone = pull(2, "weekly-audit-x");
  assert.deepEqual(legacy.matchReasons(alone), [], "a bare branch alone is no candidate in either reading");
  assert.deepEqual(matchReasons(alone, BLOCK), []);
  assert.equal(legacy.upkeepOf(alone), "weekly-audit");
  assert.equal(upkeepOf(alone, BLOCK), null);
  // what that changes for a workflow: the weekly audit used to skip for such a pull request (an upkeep that is none counts as its own) and now ignores it (it is the other upkeep's)
  const weekly = { closeOlderKey: KEY, implementation: false };
  assert.equal(legacy.decide(bare, { ...weekly, upkeep: "weekly-audit" }).decision, "skip");
  assert.equal(decide(bare, { ...weekly, upkeep: "weekly-audit", config: BLOCK }).decision, "ignore");
});

// ---- 3. the script, run on the real manifest ---------------------------------------------------------------------------------------------------

const OWNER = "example-owner";
const REPO = "example-target";
const PULLS_PATH = `/repos/${OWNER}/${REPO}/pulls`;
const QUERY = "?state=open&per_page=30";
const TOKEN = "ghs_installationtokenfixture";
const OPEN = [
  pull(11, "automation/weekly-audit-2026-11-01"),
  pull(12, "automation/self-improve-2026-11-02"),
  pull(13, "sdlc/weekly-audit-2026-11-01"),
  pull(14, "feature/audited", ["content-audit", "automated"]),
  pull(15, "feature/agents", ["self-improving-agents"]),
  pull(16, "feature/x"),
  pull(17, "docs/automation/weekly-audit-x"),
  pull(18, "sdlc"),
  pull(19, "SDLC/Upper", ["other"]),
];
const listing = (list = OPEN) => createFakeFetch((entry) => (entry.pathAndSearch === `${PULLS_PATH}${QUERY}` ? json(200, list) : json(404, { message: "Not Found" })));
/** The environment of the step: the orchestrator workspace is this repository, so the manifest that the script reads is the real sdlc.yaml. */
const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: INSTANCE_ROOT, CONFIGURED_TARGET_REPO: `${OWNER}/${REPO}`, GH_APP_INSTALLATION_TOKEN: TOKEN, SDLC_MANIFEST: "", ...extra });
const out = () => path.join(tempDir("sdlc-s2-dedupe-"), "agent");
const report = (directory, name = "open-pr-dedup.json") => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const base = (key) => ["--target-repo", `${OWNER}/${REPO}`, "--project", key];

for (const key of DRIFT_KEYS) {
  test(`AC10: with --project ${key} the heads automation/weekly-audit-*, automation/self-improve-* and sdlc/* and the two labels are recorded, feature/x is not`, async () => {
    const directory = out();
    const fake = listing();
    const result = await invoke(run, ["--out", directory, ...base(key)], { env: env(), fetch: fake });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.requests.map((request) => `${request.method} ${request.pathAndSearch}`), [`GET ${PULLS_PATH}${QUERY}`]);
    const recorded = report(directory);
    assert.deepEqual(recorded.matches.map((match) => [match.number, match.headRef]), [
      [11, "automation/weekly-audit-2026-11-01"],
      [12, "automation/self-improve-2026-11-02"],
      [13, "sdlc/weekly-audit-2026-11-01"],
      [14, "feature/audited"],
      [15, "feature/agents"],
    ]);
    assert.deepEqual(recorded.matches.map((match) => match.url), [11, 12, 13, 14, 15].map((number) => `https://github.example/${OWNER}/${REPO}/pull/${number}`), "number, head ref and URL");
    assert.deepEqual(recorded.matches.map((match) => match.reasons), [
      ["head branch matches automation/weekly-audit-*"],
      ["head branch matches automation/self-improve-*"],
      ["head branch matches sdlc/*"],
      ["carries the label content-audit"],
      ["carries the label self-improving-agents"],
    ]);
    assert.deepEqual({ repository: recorded.repository, inspected: recorded.inspected, truncated: recorded.truncated, duplicate: recorded.duplicate }, { repository: `${OWNER}/${REPO}`, inspected: 9, truncated: false, duplicate: true });
    assert.deepEqual(listTree(directory), ["open-pr-dedup.json", "open-prs.json"]);
    assert.equal(fs.readFileSync(path.join(directory, "open-prs.json"), "utf8"), fs.readFileSync(path.join(directory, "open-pr-dedup.json"), "utf8"), "the same record is also written as open-prs.json");
  });
}

test("AC10: without --project nothing is known of the fleet's schedules, so only the sdlc/ branches of the orchestrator are candidates (the committed steps always pass the project)", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`], { env: env(), fetch: listing() });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(report(directory).matches.map((match) => match.number), [13], "sdlc/weekly-audit-2026-11-01 only: the lab's own branches and labels are not known, and the bare `sdlc` and the other heads are no candidate");
});

test("AC10: a project that the manifest does not have, and a manifest that cannot be read, stop the step with nothing written: an unknown state is never 'no duplicate'", async () => {
  const unknown = out();
  const result = await invoke(run, ["--out", unknown, ...base("no-such-project")], { env: env(), fetch: listing() });
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(unknown), false, "nothing is written");
  const elsewhere = tempDir("sdlc-s2-dedupe-workspace-");
  const missing = out();
  const noManifest = await invoke(run, ["--out", missing, ...base("copilot-lab")], { env: env({ GITHUB_WORKSPACE: elsewhere }), fetch: listing(), cwd: elsewhere });
  assert.equal(noManifest.code, 1);
  assert.equal(fs.existsSync(missing), false, "nothing is written");
});

// --- whose pull request it is: the current workflow's own earlier one stays open, another workflow's is not a duplicate --------------------------
//
// `sdlc/*` is the head of every pull request of the orchestrator, so with the three preset workflows the self-improvement draft of
// drift-self-improving-agents matched the weekly audit of drift-copilot-lab, and the other way round: each open pull request of one stopped the other,
// and a workflow's own earlier pull request stopped it too. Since SPEC-02 AC25 keeps that earlier pull request open (its items are in the next run's
// baseline), it is no reason to skip either. The record says, for each match, whose it is (belongsTo), which upkeep it is for (upkeep) and what the
// workflow does about it (decision).

const WEEKLY = { closeOlderKey: "sdlc-drift-copilot-lab", strategy: "content-and-docs-sync", upkeep: "weekly-audit", project: "copilot-lab" };
const IMPROVE = { closeOlderKey: "sdlc-drift-self-improving-agents", strategy: "code-quality-and-improvement-scan", upkeep: "self-improve", project: "self-improving-agents" };
const marked = (key) => `Proposed changes.\n\n<!-- gh-aw-close-key: ${key} -->\n`;
const owned = (number, ref, key, labels = []) => ({ ...pull(number, ref, labels), body: marked(key) });
const FLEET = [
  owned(21, "sdlc/weekly-audit-2026-10-25", WEEKLY.closeOlderKey, ["automated", "sdlc-drift", "needs-review"]),
  owned(22, "sdlc/self-improve-2026-11-01", IMPROVE.closeOlderKey, ["automated", "sdlc-drift", "needs-review"]),
  pull(23, "automation/weekly-audit-2026-11-01", ["content-audit"]),
  pull(24, "automation/self-improve-2026-11-02", ["self-improving-agents"]),
  pull(25, "sdlc/x"),
  pull(26, "feature/x"),
];
const flags = (workflow) => ["--close-older-key", workflow.closeOlderKey, "--upkeep-strategy", workflow.strategy, "--project", workflow.project];
const decisions = (directory) => Object.fromEntries(report(directory).matches.map((match) => [match.number, `${match.belongsTo === "current-workflow" ? "own" : "other"}:${match.decision}`]));

test("AC10: for the weekly audit, its own earlier pull request is no reason to skip, the self-improvement draft of the other workflow and the lab's own self-improvement pull request are of another upkeep, and the lab's own audit and a pull request of unknown upkeep are to be skipped for", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(WEEKLY)], { env: env(), fetch: listing(FLEET) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(decisions(directory), { 21: "own:ignore", 22: "other:ignore", 23: "other:skip", 24: "other:ignore", 25: "other:skip" });
  const recorded = report(directory);
  assert.equal(recorded.duplicate, true, "the lab's own audit is open");
  assert.deepEqual({ closeOlderKey: recorded.closeOlderKey, upkeep: recorded.upkeep }, { closeOlderKey: WEEKLY.closeOlderKey, upkeep: "weekly-audit" }, "the record says which workflow it was made for");
  assert.deepEqual(recorded.matches.map((match) => [match.number, match.headRef, match.url]), [21, 22, 23, 24, 25].map((number) => [number, FLEET.find((candidate) => candidate.number === number).head.ref, `https://github.example/${OWNER}/${REPO}/pull/${number}`]), "number, head ref and URL of every match, as AC10 requires");
  assert.equal(recorded.matches.every((match) => Array.isArray(match.reasons) && match.reasons.length > 0 && typeof match.draft === "boolean" && Array.isArray(match.labels)), true, "and the fields of the earlier record");
  assert.deepEqual(recorded.matches.map((match) => match.upkeep), ["weekly-audit", "self-improve", "weekly-audit", "self-improve", null]);
});

test("AC10: for the self-improvement run it is the other way round: its own earlier pull request is no reason to skip and the weekly audit's are of another upkeep", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(IMPROVE)], { env: env(), fetch: listing(FLEET) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(decisions(directory), { 21: "other:ignore", 22: "own:ignore", 23: "other:ignore", 24: "other:skip", 25: "other:skip" });
  assert.equal(report(directory).duplicate, true, "the lab's own self-improvement pull request is open");
});

test("AC10: an open pull request of the workflow itself, or of another workflow of the fleet, is not a reason to skip: nothing is a duplicate when only those are open", async () => {
  const open = [FLEET[0], FLEET[1]];
  for (const workflow of [WEEKLY, IMPROVE]) {
    const directory = out();
    const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(workflow)], { env: env(), fetch: listing(open) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report(directory).duplicate, false, workflow.closeOlderKey);
    assert.equal(report(directory).matches.length, 2, "both are still recorded: number, head and URL stay in matches");
    assert.deepEqual(new Set(report(directory).matches.map((match) => match.decision)), new Set(["ignore"]));
    assert.deepEqual(new Set(report(directory).matches.map((match) => match.belongsTo)), new Set(["current-workflow", "another-workflow-or-schedule"]));
  }
  const directory = out();
  assert.equal((await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(WEEKLY)], { env: env(), fetch: listing([FLEET[0], FLEET[2]]) })).code, 0);
  assert.equal(report(directory).duplicate, true, "with the lab's own audit open as well, it is");
});

test("AC10: with the project but without --close-older-key and --upkeep-strategy nothing is known of the workflow, so every match is to be skipped for, as before", async () => {
  const directory = out();
  const result = await invoke(run, ["--out", directory, ...base("copilot-lab")], { env: env(), fetch: listing(FLEET) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(decisions(directory), { 21: "other:skip", 22: "other:skip", 23: "other:skip", 24: "other:skip", 25: "other:skip" });
  assert.deepEqual({ duplicate: report(directory).duplicate, closeOlderKey: report(directory).closeOlderKey, upkeep: report(directory).upkeep }, { duplicate: true, closeOlderKey: null, upkeep: null });
  const onlyStrategy = out();
  await invoke(run, ["--out", onlyStrategy, ...base("copilot-lab"), "--upkeep-strategy", "content-and-docs-sync"], { env: env(), fetch: listing(FLEET) });
  assert.deepEqual(decisions(onlyStrategy), { 21: "other:skip", 22: "other:ignore", 23: "other:skip", 24: "other:ignore", 25: "other:skip" }, "with the upkeep alone the other upkeep is told apart, and its own pull request cannot be");
  const unknownStrategy = out();
  await invoke(run, ["--out", unknownStrategy, "--target-repo", `${OWNER}/${REPO}`, ...flags({ ...WEEKLY, strategy: "custom" })], { env: env(), fetch: listing(FLEET) });
  assert.deepEqual(decisions(unknownStrategy), { 21: "own:ignore", 22: "other:skip", 23: "other:skip", 24: "other:skip", 25: "other:skip" }, "a strategy that has no upkeep of the lab's schedules tells nothing apart: what is not its own is skipped for");
  assert.equal(report(unknownStrategy).upkeep, null);
});

test("AC10 and AC45: with --implementation every pull request of the fleet is no reason to skip, and only the target's own schedule of the same upkeep is", async () => {
  const implementationRun = (strategy, list, project = "copilot-lab") => {
    const directory = out();
    return invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, "--upkeep-strategy", strategy, "--implementation", "--project", project], { env: env(), fetch: listing(list) }).then((result) => ({ result, directory }));
  };
  const fleet = [...FLEET, pull(27, "sdlc/implement-report-41", ["automated", "sdlc-implement", "needs-review"])];
  const weekly = await implementationRun("content-and-docs-sync", fleet);
  assert.equal(weekly.result.code, 0, weekly.result.stderr);
  assert.deepEqual(decisions(weekly.directory), { 21: "other:ignore", 22: "other:ignore", 23: "other:skip", 24: "other:ignore", 25: "other:ignore", 27: "other:ignore" }, "the lab's own audit is the one duplicate of an audit report's implementation");
  assert.equal(report(weekly.directory).matches.find((match) => match.number === 27).belongsTo, "implementation");
  assert.deepEqual({ duplicate: report(weekly.directory).duplicate, implementation: report(weekly.directory).implementation, closeOlderKey: report(weekly.directory).closeOlderKey }, { duplicate: true, implementation: true, closeOlderKey: null });
  const improve = await implementationRun("code-quality-and-improvement-scan", fleet, "self-improving-agents");
  assert.deepEqual(decisions(improve.directory), { 21: "other:ignore", 22: "other:ignore", 23: "other:ignore", 24: "other:skip", 25: "other:ignore", 27: "other:ignore" });
  const onlyFleet = await implementationRun("content-and-docs-sync", [FLEET[0], FLEET[1], FLEET[4], fleet.at(-1)]);
  assert.equal(report(onlyFleet.directory).duplicate, false, "drift pull requests, other implementations and other sdlc/ pull requests never stop an implementation");
  const both = await invoke(run, ["--out", out(), ...base("copilot-lab"), "--close-older-key", "sdlc-drift-x", "--implementation"], { env: env(), fetch: listing(fleet) });
  assert.equal(both.code, 2, "the key of a drift workflow and --implementation name two different workflows");
});

test("AC10 and AC45: the implementation pull request of an earlier drift report is no duplicate for a known drift workflow, whatever its upkeep, and without the workflow's key it is skipped for like any other", async () => {
  const implementation = pull(27, "sdlc/implement-report-41", ["automated", "sdlc-implement", "needs-review"]);
  for (const workflow of [WEEKLY, IMPROVE, { ...WEEKLY, strategy: "custom" }]) {
    const directory = out();
    const result = await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(workflow)], { env: env(), fetch: listing([implementation, FLEET[2]]) });
    assert.equal(result.code, 0, result.stderr);
    const matches = Object.fromEntries(report(directory).matches.map((match) => [match.number, [match.belongsTo, match.decision]]));
    assert.deepEqual(matches[27], ["implementation", "ignore"], workflow.strategy);
    assert.equal(report(directory).matches.find((match) => match.number === 27).upkeep, null);
    const alone = out();
    await invoke(run, ["--out", alone, "--target-repo", `${OWNER}/${REPO}`, ...flags(workflow)], { env: env(), fetch: listing([implementation]) });
    assert.equal(report(alone).duplicate, false, `${workflow.strategy}: an open implementation pull request alone stops nothing`);
  }
  const unknown = out();
  await invoke(run, ["--out", unknown, ...base("copilot-lab")], { env: env(), fetch: listing([implementation]) });
  assert.deepEqual(report(unknown).matches.map((match) => [match.belongsTo, match.decision]), [["another-workflow-or-schedule", "skip"]], "nothing is known of the workflow");
});

test("AC10: the record of a run with the flags is as deterministic as before: the same pull requests give the same bytes", async () => {
  const first = out();
  const second = out();
  for (const directory of [first, second]) await invoke(run, ["--out", directory, "--target-repo", `${OWNER}/${REPO}`, ...flags(WEEKLY)], { env: env(), fetch: listing([...FLEET].reverse()) });
  assert.equal(fs.readFileSync(path.join(first, "open-pr-dedup.json"), "utf8"), fs.readFileSync(path.join(second, "open-pr-dedup.json"), "utf8"));
  assert.deepEqual(report(first).matches.map((match) => match.number), [21, 22, 23, 24, 25], "ordered by pull request number, whatever the order of the list");
});
