// AC1-AC4, AC21 and the schema halves of AC33, AC39, AC65, AC66 and AC69.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Ajv from "ajv";
import { abs, clone, minimalManifest, mutate, readText, REPO_ROOT } from "./helpers/fixtures.mjs";

const schemaFile = abs("schemas", "sdlc.schema.json");
const schemaText = readText(schemaFile);
const schema = JSON.parse(schemaText);
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

/** Validation errors flattened to strings that name the instance path, keyword and offending key. */
function errorsOf(manifest) {
  if (validate(manifest)) return [];
  return validate.errors.map((error) => {
    const key = error.params.additionalProperty ?? error.params.missingProperty ?? "";
    return `${error.instancePath || "/"} ${error.keyword} ${key} ${error.message}`.trim();
  });
}
const accepts = (manifest) => errorsOf(manifest).length === 0;
const rejectsNaming = (manifest, text) => {
  const errors = errorsOf(manifest);
  assert.ok(errors.length > 0, "the manifest must be rejected");
  assert.ok(errors.some((error) => error.includes(text)), `an error must name '${text}': ${errors.join(" | ")}`);
};

const base = () => minimalManifest();
const firstProject = (manifest) => manifest.projects[0];
const firstEdge = (manifest) => manifest.dependencyEdges[0];

test("AC1: the schema compiles in strict mode and validates the minimal fixture, whose owners are outside the preset", () => {
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.ok(accepts(base()), errorsOf(base()).join("\n"));
  const owners = base().projects.map((project) => project.repo.split("/")[0]);
  assert.deepEqual(owners, ["acme-labs", "globex-corp"]);
});

test("AC1: the manifest has only projects, dependencyEdges, protectedFilesExclude and engineApiKeySecret", () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), ["dependencyEdges", "engineApiKeySecret", "projects", "protectedFilesExclude"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["projects"]);
});

test("AC1: an unknown key at each of the five object levels fails with that key named", () => {
  const levels = [
    ["manifest", (manifest) => manifest],
    ["project", (manifest) => firstProject(manifest)],
    ["driftAudit", (manifest) => firstProject(manifest).driftAudit],
    ["edge", (manifest) => firstEdge(manifest)],
    ["immutableGates", (manifest) => firstEdge(manifest).immutableGates],
  ];
  for (const [level, pick] of levels) {
    const manifest = mutate(base(), (copy) => {
      pick(copy).unexpectedKey = 1;
    });
    assert.ok(!accepts(manifest), `${level} must reject an unknown key`);
    rejectsNaming(manifest, "additionalProperties unexpectedKey");
  }
  for (const pick of [
    (manifest) => firstProject(manifest).driftAudit.knowledgeSources,
    (manifest) => firstProject(manifest).driftAudit.knowledgeSources.watchUrls[0],
  ]) {
    rejectsNaming(mutate(base(), (copy) => (pick(copy).unexpectedKey = 1)), "additionalProperties unexpectedKey");
  }
});

test("AC1: the schema names no repository of the preset", () => {
  assert.equal(/johnhain-msft|ms-mfg-community|githubschool/.test(schemaText), false);
  assert.equal(/mfg_msft_ai_sdlc/.test(schemaText), false);
});

test("AC1: package-lock.json is tracked in git, not merely present on disk", () => {
  const outcome = spawnSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(outcome.status, 0, `${outcome.stdout}${outcome.stderr}`);
});

const KEY = "[a-z0-9][a-z0-9-]{0,62}";
const SLUG = "[A-Z0-9_]{1,64}";

test("AC2: the patterns are written into the schema for projectKey, upstreamKey, edgeId and upstreamSlug", () => {
  assert.ok(schemaText.includes(KEY));
  assert.ok(schemaText.includes(SLUG));
  assert.equal(schema.definitions.project.properties.projectKey.pattern, `^${KEY}$`);
  assert.equal(schema.definitions.edge.properties.upstreamKey.pattern, `^${KEY}$`);
  assert.equal(schema.definitions.edge.properties.edgeId.pattern, `^${KEY}$`);
  assert.equal(schema.definitions.edge.properties.upstreamSlug.pattern, `^${SLUG}$`);
});

test("AC2: a 63-character key is valid and a 64-character key invalid, for projectKey, upstreamKey and edgeId", () => {
  const setters = {
    projectKey: (manifest, value) => (firstProject(manifest).projectKey = value),
    upstreamKey: (manifest, value) => (firstEdge(manifest).upstreamKey = value),
    edgeId: (manifest, value) => (firstEdge(manifest).edgeId = value),
  };
  for (const [name, set] of Object.entries(setters)) {
    assert.ok(accepts(mutate(base(), (copy) => set(copy, "a".repeat(63)))), `${name}: 63 characters`);
    assert.ok(!accepts(mutate(base(), (copy) => set(copy, "a".repeat(64)))), `${name}: 64 characters`);
    assert.ok(!accepts(mutate(base(), (copy) => set(copy, "-leading"))), `${name}: leading dash`);
    assert.ok(!accepts(mutate(base(), (copy) => set(copy, "Upper"))), `${name}: uppercase letter`);
    assert.ok(!accepts(mutate(base(), (copy) => set(copy, ""))), `${name}: empty`);
    assert.ok(accepts(mutate(base(), (copy) => set(copy, "x-1"))), `${name}: ordinary key`);
  }
});

test("AC2: upstreamSlug accepts GH_ADMIN_MSFT and rejects gh-admin, GH-ADMIN and 65 characters", () => {
  const withSlug = (value) => mutate(base(), (copy) => (firstEdge(copy).upstreamSlug = value));
  assert.ok(accepts(withSlug("GH_ADMIN_MSFT")));
  assert.ok(accepts(withSlug("A".repeat(64))));
  for (const bad of ["gh-admin", "GH-ADMIN", "A".repeat(65), ""]) assert.ok(!accepts(withSlug(bad)), `'${bad}'`);
});

test("AC3: deconflictInRepoSchedules is an enum with default none; the id list follows the value", () => {
  const property = schema.definitions.project.properties.deconflictInRepoSchedules;
  assert.deepEqual(property.enum, ["none", "disable-workflow-schedules"]);
  assert.equal(property.default, "none");
  const withMode = (mode, ids) =>
    mutate(base(), (copy) => {
      if (mode === undefined) delete firstProject(copy).deconflictInRepoSchedules;
      else firstProject(copy).deconflictInRepoSchedules = mode;
      if (ids === undefined) delete firstProject(copy).deconflictWorkflowIds;
      else firstProject(copy).deconflictWorkflowIds = ids;
    });
  assert.ok(accepts(withMode(undefined, undefined)), "both omitted normalise to none and an empty list");
  assert.ok(accepts(withMode("none", [])));
  assert.ok(accepts(withMode("disable-workflow-schedules", ["ci.yml"])));
  assert.ok(!accepts(withMode("disable-workflow-schedules", [])), "an empty id list is rejected");
  assert.ok(!accepts(withMode("disable-workflow-schedules", undefined)), "the id list is required");
  assert.ok(!accepts(withMode("delete-workflows", ["ci.yml"])), "delete-workflows is not a mode");
  assert.ok(!accepts(withMode("none", ["ci.yml"])), "ids are empty unless schedules are disabled");
});

test("AC4: a project is projectKey, repo, defaultBranch, driftAudit, the two deconflict keys and an optional autoMerge: false", () => {
  const project = schema.definitions.project;
  assert.deepEqual(Object.keys(project.properties).sort(), [
    "autoMerge",
    "deconflictInRepoSchedules",
    "deconflictWorkflowIds",
    "defaultBranch",
    "driftAudit",
    "projectKey",
    "repo",
  ]);
  assert.deepEqual([...project.required].sort(), ["defaultBranch", "driftAudit", "projectKey", "repo"]);
  assert.ok(accepts(mutate(base(), (copy) => (firstProject(copy).autoMerge = false))));
  assert.ok(!accepts(mutate(base(), (copy) => (firstProject(copy).autoMerge = true))));
  assert.ok(!accepts(mutate(base(), (copy) => (firstProject(copy).autoMerge = "squash"))));
});

test("AC4: two project entries MAY name the same repository", () => {
  const manifest = mutate(base(), (copy) => {
    const second = clone(firstProject(copy));
    second.projectKey = "alpha-service-two";
    copy.projects.push(second);
  });
  assert.equal(manifest.projects[0].repo, manifest.projects[2].repo);
  assert.ok(accepts(manifest), errorsOf(manifest).join("\n"));
});

test("AC4: an edge carrying onBots, or autoMerge: true, fails", () => {
  rejectsNaming(mutate(base(), (copy) => (firstEdge(copy).onBots = ["x[bot]"])), "additionalProperties onBots");
  assert.ok(!accepts(mutate(base(), (copy) => (firstEdge(copy).autoMerge = true))));
  assert.ok(accepts(mutate(base(), (copy) => (firstEdge(copy).autoMerge = false))));
});

test("AC4: immutableGates of { zeroDiffPaths: [] } validates; omitting zeroDiffPaths fails naming it", () => {
  assert.deepEqual(firstEdge(base()).immutableGates, { zeroDiffPaths: [] });
  assert.ok(accepts(base()));
  rejectsNaming(mutate(base(), (copy) => (firstEdge(copy).immutableGates = {})), "zeroDiffPaths");
  const withBlocks = mutate(base(), (copy) => {
    firstEdge(copy).immutableGates = { zeroDiffPaths: ["src"], lockedTestBlocks: [{ anything: true }], inProcessInvariants: { free: "form" } };
  });
  assert.ok(accepts(withBlocks), "lockedTestBlocks and inProcessInvariants pass through unvalidated");
});

test("AC4: an edge carries every key of AC33 except onBots, plus the policy keys", () => {
  const required = schema.definitions.edge.required;
  for (const key of [
    "upstreamRepo", "upstreamKey", "upstreamSlug", "upstreamDefaultBranch", "initialBaselineSha", "downstreamRepo", "mode", "schedule",
    "onCommitOnlyAdvance", "stateVariable", "provenanceFile", "provenanceJsonPointer", "branchName", "closeOlderKey", "reviewers",
    "importCommands", "buildCommands", "verifyCommands", "edgeId", "preflightCommands", "acceptCommands", "adaptationInstructions",
    "allowedFiles", "protectedFilesExclude", "autoMerge", "immutableGates",
  ]) {
    assert.ok(required.includes(key), `edge.required lists ${key}`);
    rejectsNaming(mutate(base(), (copy) => delete firstEdge(copy)[key]), key);
  }
  assert.equal(required.includes("onBots"), false);
  for (const name of ["edgeId", "allowedFiles", "zeroDiffPaths", "deconflictWorkflowIds"]) {
    assert.ok(new RegExp(name).test(schemaText), `the schema mentions ${name}`);
  }
});

test("AC21: driftAudit has the ten typed fields of contract C2, each of them required, and the one optional field agentSandbox", () => {
  const audit = schema.definitions.driftAudit;
  const fields = ["enabled", "schedule", "upkeepStrategy", "instructions", "instructionsFile", "knowledgeSources", "buildCommands", "verifyCommands", "draft", "reviewers"];
  assert.deepEqual([...audit.required].sort(), [...fields].sort());
  assert.deepEqual(Object.keys(audit.properties).sort(), [...fields, "agentSandbox"].sort());
  for (const field of fields) {
    rejectsNaming(mutate(base(), (copy) => delete firstProject(copy).driftAudit[field]), field);
  }
  const wrong = { enabled: "yes", schedule: 5, upkeepStrategy: "nothing", instructions: 7, knowledgeSources: [], buildCommands: "make", verifyCommands: {}, draft: "no", reviewers: "me" };
  for (const [field, value] of Object.entries(wrong)) {
    assert.ok(!accepts(mutate(base(), (copy) => (firstProject(copy).driftAudit[field] = value))), `${field} must be typed`);
  }
  const knowledge = audit.properties.knowledgeSources;
  assert.deepEqual([...knowledge.required].sort(), ["mcpServers", "packageManifests", "watchUrls"]);
  assert.ok(/dependency-and-pattern-modernization/.test(schemaText));
  assert.deepEqual(audit.properties.upkeepStrategy.enum, [
    "content-and-docs-sync",
    "dependency-and-pattern-modernization",
    "code-quality-and-improvement-scan",
    "custom",
  ]);
});

test("AC21: agentSandbox is optional; installDependencies is a boolean and bashCommands a list of distinct bare command names, and it has no other key", () => {
  const withSandbox = (value) => mutate(base(), (copy) => (firstProject(copy).driftAudit.agentSandbox = value));
  assert.ok(accepts(base()), "a project without it is valid");
  for (const good of [{}, { installDependencies: true }, { installDependencies: false, bashCommands: [] }, { bashCommands: ["awk", "python3", "g++", "7z", "x.y", "a_b", "c-d"] }]) {
    assert.ok(accepts(withSandbox(good)), JSON.stringify(good));
  }
  for (const bad of [
    { installDependencies: "yes" }, { installDependencies: 1 }, { bashCommands: "awk" }, { bashCommands: [1] }, { bashCommands: [""] },
    { bashCommands: ["*"] }, { bashCommands: ["awk -F"] }, { bashCommands: ["/usr/bin/awk"] }, { bashCommands: ["./awk"] }, { bashCommands: ["a;b"] }, { bashCommands: ["-x"] },
    { bashCommands: ["awk", "awk"] }, { unexpectedKey: true },
  ]) {
    assert.ok(!accepts(withSandbox(bad)), JSON.stringify(bad));
  }
  rejectsNaming(withSandbox({ unexpectedKey: true }), "additionalProperties unexpectedKey");
});

test("AC21: watchUrls entries need url, label and a known kind; kind podcast is rejected", () => {
  const entry = (patch) => mutate(base(), (copy) => Object.assign(firstProject(copy).driftAudit.knowledgeSources.watchUrls[0], patch));
  for (const kind of ["changelog", "blog", "docs", "release-notes", "feed"]) assert.ok(accepts(entry({ kind })), kind);
  assert.ok(!accepts(entry({ kind: "podcast" })));
  for (const key of ["url", "label", "kind"]) {
    assert.ok(!accepts(mutate(base(), (copy) => delete firstProject(copy).driftAudit.knowledgeSources.watchUrls[0][key])), key);
  }
});

test("AC21: schedule is a five-field cron expression", () => {
  const withSchedule = (value) => mutate(base(), (copy) => (firstProject(copy).driftAudit.schedule = value));
  for (const good of ["0 13 * * 1", "*/15 * * * *", "0 6 1 * *", "30 5 * * 0"]) assert.ok(accepts(withSchedule(good)), good);
  for (const bad of ["", "* * * *", "0 0 * * * *", "every monday", "0 13 * * 1\n0 1 * * *"]) assert.ok(!accepts(withSchedule(bad)), JSON.stringify(bad));
});

test("AC21: instructionsFile is null or a repository-relative path (no leading slash, no ..)", () => {
  const withFile = (value) => mutate(base(), (copy) => (firstProject(copy).driftAudit.instructionsFile = value));
  assert.ok(accepts(withFile(null)));
  assert.ok(accepts(withFile("instructions/alpha-service.md")));
  for (const bad of ["../x.md", "/etc/passwd", "a/../../x.md", "C:\\x.md", "a\\b.md", ""]) assert.ok(!accepts(withFile(bad)), JSON.stringify(bad));
});

test("AC33: initialBaselineSha is 40 lowercase hexadecimal characters; schedule is null or a cron; mode is a known mode", () => {
  const withEdge = (patch) => mutate(base(), (copy) => Object.assign(firstEdge(copy), patch));
  assert.ok(accepts(withEdge({ initialBaselineSha: "a".repeat(40) })));
  for (const bad of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), ""]) {
    assert.ok(!accepts(withEdge({ initialBaselineSha: bad })), `${bad.length} characters`);
  }
  assert.ok(accepts(withEdge({ schedule: null })));
  assert.ok(accepts(withEdge({ schedule: "0 */6 * * *" })));
  assert.ok(!accepts(withEdge({ schedule: "hourly" })));
  assert.ok(!accepts(withEdge({ mode: "manual" })));
  assert.ok(accepts(withEdge({ mode: "ai-adaptation" })));
  assert.ok(!accepts(withEdge({ onCommitOnlyAdvance: "ignore" })));
  assert.ok(accepts(withEdge({ onCommitOnlyAdvance: "bump-provenance" })));
  assert.ok(!accepts(withEdge({ provenanceJsonPointer: "commit" })), "a JSON Pointer starts with /");
  assert.ok(accepts(withEdge({ provenanceJsonPointer: "/_provenance/commit" })));
});

test("AC39: an edge without initialBaselineSha fails with the key named", () => {
  rejectsNaming(mutate(base(), (copy) => delete firstEdge(copy).initialBaselineSha), "initialBaselineSha");
});

test("AC71: engineApiKeySecret is an identifier", () => {
  const withSecret = (value) => mutate(base(), (copy) => (copy.engineApiKeySecret = value));
  assert.ok(accepts(withSecret("MY_KEY")));
  assert.ok(accepts(withSecret("_k1")));
  for (const bad of ["1BAD", "has-dash", "has space", ""]) assert.ok(!accepts(withSecret(bad)), JSON.stringify(bad));
});

test("AC55: protectedFilesExclude entries are basenames, prefixes or rooted paths and globs", () => {
  const withList = (value) => mutate(base(), (copy) => (copy.protectedFilesExclude = value));
  assert.ok(accepts(withList(["README.md", "docs/", "/docs/index.md", "src/**/*.md"])));
  assert.ok(!accepts(withList(["../outside"])));
  assert.ok(!accepts(withList("README.md")));
});

test("AC73: maxPatchFiles is an optional positive integer of an edge", () => {
  const withLimit = (value) => mutate(base(), (copy) => (firstEdge(copy).maxPatchFiles = value));
  assert.equal(schema.definitions.edge.required.includes("maxPatchFiles"), false);
  assert.ok(accepts(base()), "an edge without it validates");
  for (const good of [1, 100, 1000]) assert.ok(accepts(withLimit(good)), String(good));
  for (const bad of [0, -1, 1.5, "100", null]) assert.ok(!accepts(withLimit(bad)), JSON.stringify(bad));
});

test("AC65, AC66, AC69: a manifest that asks for allow-workflows, staging or a safe-outputs token fails validation", () => {
  for (const key of ["allowWorkflows", "allow-workflows", "staged", "githubToken", "github-token"]) {
    rejectsNaming(mutate(base(), (copy) => (copy[key] = true)), `additionalProperties ${key}`);
    rejectsNaming(mutate(base(), (copy) => (firstEdge(copy)[key] = true)), `additionalProperties ${key}`);
    rejectsNaming(mutate(base(), (copy) => (firstProject(copy)[key] = true)), `additionalProperties ${key}`);
  }
});
