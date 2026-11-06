// AC51: writes to sdlc.yaml preserve every existing entry. Onboarding a new project into the preset sdlc.yaml adds lines only, with no
// existing line, comment, key order or value changed; re-onboarding an existing projectKey updates only the fields whose flags were
// passed explicitly and fills fields that are missing, never overwriting an operator's edit; sdlc.yaml and instructions/<projectKey>.md
// are written atomically (a temporary file in the same directory, then a rename); identical inputs produce byte-identical output.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { applyDataToText, mergeEntry, planManifestUpdate } from "../../bin/lib/manifest-edit.mjs";
import { restoreFiles, writeFilesAtomically } from "../../bin/lib/atomic-write.mjs";
import { REPO_ROOT, createScenario, fixtureRepos } from "./helpers/harness.mjs";

const PRESET = nodeFs.readFileSync(path.join(REPO_ROOT, "sdlc.yaml"), "utf8");
const REPOS = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok", "example-owner/lab-like": "lab-like" });
const git = (scenario, ...args) => execFileSync("git", args, { cwd: scenario.workspace.dir, encoding: "utf8" });
const lines = (text) => text.split(/\r?\n/);

async function withManifest(text, callback, options = {}) {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: text }, ...options });
  try {
    scenario.workspace.commitAll("baseline");
    const run = (argv, extra = {}) => scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()), ...extra });
    return await callback({ scenario, run });
  } finally {
    await scenario.cleanup();
  }
}

/** True when every line of `before` occurs in `after`, unchanged and in the same order. */
function isSubsequence(before, after) {
  let position = 0;
  for (const line of after) if (position < before.length && line === before[position]) position += 1;
  return position === before.length;
}

// --- adding to the preset --------------------------------------------------------------------------------------------------

test("AC51: onboarding one new project into the preset sdlc.yaml adds lines only: git diff --numstat reports zero deleted lines", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const result = await run(["--repo", "example-owner/node-app", "--watch-url", "https://example.com/changelog"]);
    assert.equal(result.code, 0, result.stderr);
    const [added, deleted, file] = git(scenario, "diff", "--numstat", "--", "sdlc.yaml").trim().split(/\s+/);
    assert.equal(file, "sdlc.yaml");
    assert.ok(Number(added) > 20, `lines were added (${added})`);
    assert.equal(deleted, "0", "no line was deleted");
    assert.equal(git(scenario, "diff", "-U0", "--", "sdlc.yaml").split("\n").some((line) => line.startsWith("-") && !line.startsWith("---")), false, "no removed line in the patch");
    const before = lines(PRESET);
    const after = lines(scenario.workspace.read("sdlc.yaml"));
    assert.ok(isSubsequence(before, after), "every original line, comments and blank lines included, is still there, in order");
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    assert.deepEqual(data.projects.slice(0, -1), YAML.parse(PRESET).projects, "every existing project is unchanged, key order included");
    assert.equal(data.projects.at(-1).projectKey, "node-app");
    assert.deepEqual(Object.keys(data), Object.keys(YAML.parse(PRESET)), "the top-level key order is unchanged");
  });
});

test("AC51: the new project is appended after the last existing project, with the layout of the file's own entries", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    await run(["--repo", "example-owner/node-app"]);
    const text = scenario.workspace.read("sdlc.yaml");
    assert.match(text, /\n\n {2}- projectKey: node-app\n {4}repo: example-owner\/node-app\n/, "a blank line and the same two-space dash indentation as the other entries");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(/\r/.test(text), false);
  });
});

test("AC51: re-running with the same flags leaves git diff --exit-code clean", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const first = await run(["--repo", "example-owner/node-app", "--instructions", "Keep docs current"]);
    assert.equal(first.code, 0, first.stderr);
    scenario.workspace.commitAll("first onboarding");
    const second = await run(["--repo", "example-owner/node-app", "--instructions", "Keep docs current"]);
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code"), "git diff --exit-code is clean");
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "", "no file changed and none was added");
    assert.match(second.stderr, /\(already up to date\)/);
  });
});

test("AC51: identical inputs produce byte-identical output, from two independent starting points", async () => {
  const outputs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withManifest(PRESET, async ({ scenario, run }) => {
      const result = await run(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok", "--schedule", "30 4 * * 2", "--instructions", "Same text"]);
      assert.equal(result.code, 0, result.stderr);
      outputs.push([scenario.workspace.read("sdlc.yaml"), scenario.workspace.read("instructions/node-app.md")]);
    });
  }
  assert.equal(outputs[0][0], outputs[1][0]);
  assert.equal(outputs[0][1], outputs[1][1]);
});

// --- re-onboarding ---------------------------------------------------------------------------------------------------------

test("AC51: a changed --schedule on an existing project changes only that field", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app"])).code, 0);
    scenario.workspace.commitAll("first onboarding");
    const second = await run(["--repo", "example-owner/node-app", "--schedule", "0 5 * * 0"]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(git(scenario, "status", "--porcelain").trimEnd().split("\n"), [" M sdlc.yaml"], "only sdlc.yaml changed, the instructions file did not");
    assert.equal(git(scenario, "diff", "--numstat").trim(), "1\t1\tsdlc.yaml");
    const patch = git(scenario, "diff", "-U0").split("\n").filter((line) => /^[-+][^-+]/.test(line));
    assert.deepEqual(patch, ['-      schedule: "0 6 * * 1"', '+      schedule: "0 5 * * 0"']);
  });
});

/** Applies `change` to the part of the manifest from the node-app entry on (the new entry is the last project). */
const editNodeApp = (text, change) => {
  const index = text.indexOf("  - projectKey: node-app");
  assert.ok(index > 0, "the node-app entry is in the manifest");
  return text.slice(0, index) + change(text.slice(index));
};

test("AC51: re-onboarding without flags never overwrites a value that the operator edited", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app"])).code, 0);
    const edited = editNodeApp(scenario.workspace.read("sdlc.yaml"), (tail) =>
      tail
        .replace("      reviewers: []\n", "      reviewers:\n        - the-operator\n")
        .replace("      draft: false\n", "      draft: true\n")
        .replace('      schedule: "0 6 * * 1"\n      upkeepStrategy: dependency-and-pattern-modernization', '      schedule: "15 3 * * 4"\n      upkeepStrategy: custom')
        .replace("        - npm test\n", "        - npm run verify:all\n")
        .replace("    defaultBranch: main\n", "    defaultBranch: trunk\n"),
    );
    scenario.workspace.write("sdlc.yaml", edited);
    scenario.workspace.commitAll("operator edits");
    const entryBefore = YAML.parse(edited).projects.find((project) => project.projectKey === "node-app");
    assert.deepEqual(
      [entryBefore.driftAudit.reviewers, entryBefore.driftAudit.draft, entryBefore.driftAudit.upkeepStrategy, entryBefore.defaultBranch, entryBefore.driftAudit.verifyCommands, entryBefore.driftAudit.schedule],
      [["the-operator"], true, "custom", "trunk", ["npm run verify:all"], "15 3 * * 4"],
      "the edits applied",
    );
    const rerun = await run(["--repo", "example-owner/node-app"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code"), "nothing of the operator's edits was touched");
  });
});

test("AC51: a flag that is passed explicitly changes its own field and leaves the operator's other edits alone", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app"])).code, 0);
    scenario.workspace.write(
      "sdlc.yaml",
      editNodeApp(scenario.workspace.read("sdlc.yaml"), (tail) => tail.replace("      draft: false\n", "      draft: true\n").replace("      reviewers: []\n", "      reviewers:\n        - the-operator\n")),
    );
    scenario.workspace.commitAll("operator edits");
    const rerun = await run(["--repo", "example-owner/node-app", "--strategy", "content-and-docs-sync", "--schedule", "1 2 * * 3"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    const entry = YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((project) => project.projectKey === "node-app");
    assert.equal(entry.driftAudit.upkeepStrategy, "content-and-docs-sync");
    assert.equal(entry.driftAudit.schedule, "1 2 * * 3");
    assert.equal(entry.driftAudit.draft, true, "the edited draft is kept");
    assert.deepEqual(entry.driftAudit.reviewers, ["the-operator"], "the edited reviewers are kept");
    assert.match(rerun.stderr, /Upkeep strategy: content-and-docs-sync\n/);
  });
});

test("AC51: a re-run fills fields that are missing and changes nothing else", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app"])).code, 0);
    const without = editNodeApp(scenario.workspace.read("sdlc.yaml"), (tail) => tail.replace("      draft: false\n", "").replace("    deconflictWorkflowIds: []\n", ""));
    assert.notEqual(without, scenario.workspace.read("sdlc.yaml"));
    scenario.workspace.write("sdlc.yaml", without);
    scenario.workspace.commitAll("fields removed");
    const missing = YAML.parse(without).projects.find((project) => project.projectKey === "node-app");
    assert.equal("deconflictWorkflowIds" in missing || "draft" in missing.driftAudit, false, "the fields are missing");
    const rerun = await run(["--repo", "example-owner/node-app"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    const entry = YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((project) => project.projectKey === "node-app");
    assert.strictEqual(entry.driftAudit.draft, false);
    assert.deepEqual(entry.deconflictWorkflowIds, []);
    assert.equal(git(scenario, "diff", "--numstat").trim().split("\t")[1], "0", "the fields were added, nothing was deleted");
  });
});

test("AC51: --watch-url on an existing project appends the new URL and keeps the operator's existing ones", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app", "--watch-url", "https://example.com/changelog"])).code, 0);
    scenario.workspace.commitAll("first onboarding");
    const rerun = await run(["--repo", "example-owner/node-app", "--watch-url", "https://example.com/blog/feed.xml"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    const entry = YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((project) => project.projectKey === "node-app");
    assert.deepEqual(entry.driftAudit.knowledgeSources.watchUrls.map((item) => item.url), ["https://example.com/changelog", "https://example.com/blog/feed.xml"]);
    assert.equal(git(scenario, "diff", "--numstat").trim().split("\t")[1], "0", "an appended item deletes no line");
  });
});

test("AC51: --instructions on an existing project replaces the operator text of the file, keeps the generated section and updates the field", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app", "--instructions", "First version"])).code, 0);
    scenario.workspace.commitAll("first onboarding");
    const rerun = await run(["--repo", "example-owner/node-app", "--instructions", "Second version"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    const text = scenario.workspace.read("instructions/node-app.md");
    assert.ok(text.startsWith("Second version\n\n<!-- sdlc-onboard:generated -->"));
    assert.equal(text.includes("First version"), false);
    const entry = YAML.parse(scenario.workspace.read("sdlc.yaml")).projects.find((project) => project.projectKey === "node-app");
    assert.equal(entry.driftAudit.instructions, "Second version");
  });
});

test("AC51: without --instructions the operator text that is already in the instructions file survives a re-run", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app", "--instructions", "Operator text that must survive"])).code, 0);
    scenario.workspace.commitAll("first onboarding");
    scenario.workspace.write("instructions/node-app.md", `${scenario.workspace.read("instructions/node-app.md").replace("Operator text that must survive", "Operator text that must survive, edited by hand")}`);
    scenario.workspace.commitAll("hand edit");
    const rerun = await run(["--repo", "example-owner/node-app"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.ok(scenario.workspace.read("instructions/node-app.md").startsWith("Operator text that must survive, edited by hand\n\n<!-- sdlc-onboard:generated -->"));
    assert.doesNotThrow(() => git(scenario, "diff", "--exit-code"));
  });
});

test("AC51: the projectKey of an existing entry that belongs to another repository is not taken over", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const text = PRESET.replace("projectKey: portfolio", "projectKey: node-app");
    scenario.workspace.write("sdlc.yaml", text);
    scenario.workspace.commitAll("conflicting key");
    const result = await run(["--repo", "example-owner/node-app"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /the projectKey 'node-app' is already used by johnhain-msft\/portfolio, so example-owner\/node-app cannot be onboarded under the same key/);
    assert.equal(scenario.workspace.read("sdlc.yaml"), text);
    assert.equal(scenario.reconcile.calls.length, 0);
  });
});

// --- the text itself -------------------------------------------------------------------------------------------------------

test("AC51: comments, anchors and aliases, quoting styles, flow sequences and key order of existing entries survive", async () => {
  const manifest = [
    "# top of file comment",
    "# second line   ",
    "projects:",
    "  # a comment between the key and the first item",
    "  - projectKey: first",
    "    repo: third-party/first   # trailing comment",
    "    defaultBranch: 'main'",
    "    deconflictInRepoSchedules: none",
    "    deconflictWorkflowIds: []",
    "    driftAudit: &defaults",
    "      enabled: false",
    "      schedule: \"0 6 * * 1\"",
    "      upkeepStrategy: custom",
    "      instructions: \"\"",
    "      instructionsFile: null",
    "      knowledgeSources: {watchUrls: [], packageManifests: [], mcpServers: {}}",
    "      buildCommands: []",
    "      verifyCommands: [ 'npm test' ]",
    "      draft: false",
    "      reviewers: [alice, bob]",
    "  - projectKey: second",
    "    repo: third-party/second",
    "    defaultBranch: main",
    "    deconflictInRepoSchedules: none",
    "    deconflictWorkflowIds: []",
    "    driftAudit: *defaults",
    "",
    "# before the edges",
    "dependencyEdges: []",
    "",
  ].join("\n");
  await withManifest(manifest, async ({ scenario, run }) => {
    const result = await run(["--repo", "example-owner/node-app"]);
    assert.equal(result.code, 0, result.stderr);
    const after = scenario.workspace.read("sdlc.yaml");
    assert.ok(isSubsequence(lines(manifest), lines(after)), "every original line is intact and in order");
    const [added, deleted] = git(scenario, "diff", "--numstat", "--", "sdlc.yaml").trim().split(/\s+/);
    assert.ok(Number(added) > 0);
    assert.equal(deleted, "0");
    assert.deepEqual(YAML.parse(after).projects.slice(0, 2), YAML.parse(manifest).projects);
  });
});

test("AC51: a manifest with CRLF line endings stays CRLF throughout; a last line without a newline is not rewritten, and an entry appended at the end gets its newline", async () => {
  const crlf = PRESET.replace(/\r?\n/g, "\r\n");
  await withManifest(crlf, async ({ scenario, run }) => {
    const result = await run(["--repo", "example-owner/node-app"]);
    assert.equal(result.code, 0, result.stderr);
    const after = scenario.workspace.read("sdlc.yaml");
    assert.equal((after.match(/\r\n/g) ?? []).length, after.split("\n").length - 1, "every line break is CRLF");
    assert.ok(isSubsequence(lines(crlf), lines(after)));
  });
  const bare = "projects: []\ndependencyEdges: []";
  await withManifest(bare, async ({ scenario, run }) => {
    const result = await run(["--repo", "example-owner/node-app"]);
    assert.equal(result.code, 0, result.stderr);
    const after = scenario.workspace.read("sdlc.yaml");
    assert.equal(YAML.parse(after).projects[0].projectKey, "node-app");
    assert.ok(after.endsWith("dependencyEdges: []"), "the last line was not rewritten");
  });
  await withManifest("projects: []", async ({ scenario, run }) => {
    const result = await run(["--repo", "example-owner/node-app"]);
    assert.equal(result.code, 0, result.stderr);
    const after = scenario.workspace.read("sdlc.yaml");
    assert.equal(YAML.parse(after).projects[0].projectKey, "node-app");
    assert.ok(after.endsWith("\n"));
  });
});

test("AC51: onboarding into a manifest that has no dependencyEdges key adds none, and with --downstream it adds the key at the end", async () => {
  const manifest = PRESET.split("\n").filter((line) => !line.startsWith("dependencyEdges")).join("\n");
  assert.equal("dependencyEdges" in YAML.parse(manifest), false);
  await withManifest(manifest, async ({ scenario, run }) => {
    assert.equal((await run(["--repo", "example-owner/node-app"])).code, 0);
    assert.equal("dependencyEdges" in YAML.parse(scenario.workspace.read("sdlc.yaml")), false);
    scenario.workspace.commitAll("first");
    const withEdge = await run(["--repo", "example-owner/lab-like", "--downstream", "example-owner/edge-ok"]);
    assert.equal(withEdge.code, 0, withEdge.stderr);
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    assert.equal(data.dependencyEdges.length, 1);
    assert.equal(git(scenario, "diff", "--numstat", "--", "sdlc.yaml").trim().split("\t")[1], "0");
  });
});

// --- atomic writes ---------------------------------------------------------------------------------------------------------

/** A node:fs stand-in that records its writes and renames and fails on request. */
function recordingFs({ failRename, failWrite } = {}) {
  const events = [];
  let renames = 0;
  const stand = {
    ...nodeFs,
    writeFileSync(target, data, ...rest) {
      events.push(["write", String(target)]);
      if (failWrite?.(String(target))) throw new Error("injected write failure");
      return nodeFs.writeFileSync(target, data, ...rest);
    },
    renameSync(from, to) {
      renames += 1;
      events.push(["rename", String(from), String(to)]);
      if (failRename?.(renames, String(to))) throw new Error("injected rename failure");
      return nodeFs.renameSync(from, to);
    },
  };
  return { fs: stand, events };
}

test("AC51: each file is written to a temporary file in its own directory and then renamed over the target", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const { fs, events } = recordingFs();
    const result = await run(["--repo", "example-owner/node-app"], { fs });
    assert.equal(result.code, 0, result.stderr);
    const renames = events.filter(([kind]) => kind === "rename");
    assert.deepEqual(renames.map(([, , to]) => path.basename(to)), ["sdlc.yaml", "node-app.md"]);
    for (const [, from, to] of renames) {
      assert.equal(path.dirname(from), path.dirname(to), "the temporary file is in the same directory");
      assert.notEqual(from, to);
      assert.ok(events.findIndex(([kind, target]) => kind === "write" && target === from) < events.findIndex(([kind, source]) => kind === "rename" && source === from), "written before it is renamed");
    }
    assert.deepEqual(nodeFs.readdirSync(scenario.workspace.dir).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
  });
});

test("AC51: an injected rename failure leaves the original bytes of sdlc.yaml and no instructions file", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const before = nodeFs.readFileSync(scenario.workspace.path("sdlc.yaml"));
    const { fs } = recordingFs({ failRename: () => true });
    const result = await run(["--repo", "example-owner/node-app"], { fs });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /injected rename failure/);
    assert.ok(nodeFs.readFileSync(scenario.workspace.path("sdlc.yaml")).equals(before), "byte-identical");
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.deepEqual(nodeFs.readdirSync(scenario.workspace.dir).filter((name) => /\.(tmp|restore)$/.test(name)), []);
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "");
  });
});

test("AC51: a rename failure on the second file puts the first file back", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const before = nodeFs.readFileSync(scenario.workspace.path("sdlc.yaml"));
    const { fs } = recordingFs({ failRename: (count) => count === 2 });
    const result = await run(["--repo", "example-owner/node-app"], { fs });
    assert.notEqual(result.code, 0);
    assert.ok(nodeFs.readFileSync(scenario.workspace.path("sdlc.yaml")).equals(before), "sdlc.yaml was rolled back");
    assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "");
  });
});

test("AC51: a write failure of a temporary file leaves everything as it was", async () => {
  await withManifest(PRESET, async ({ scenario, run }) => {
    const { fs } = recordingFs({ failWrite: (target) => target.endsWith(".tmp") && !target.includes("sdlc.yaml.") });
    const result = await run(["--repo", "example-owner/node-app"], { fs });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /injected write failure/);
    assert.equal(git(scenario, "status", "--porcelain", "--untracked-files=all"), "");
  });
});

test("AC51: writeFilesAtomically does not touch a file whose new bytes equal the old ones, and restoreFiles puts bytes back", () => {
  const scenario = nodeFs.mkdtempSync(path.join(nodeFs.realpathSync(process.env.TEMP ?? "."), "sdlc-atomic-"));
  try {
    const target = path.join(scenario, "a.txt");
    nodeFs.writeFileSync(target, "same\n");
    const mtime = nodeFs.statSync(target).mtimeMs;
    const outcome = writeFilesAtomically([{ path: target, text: "same\n" }, { path: path.join(scenario, "new", "b.txt"), text: "fresh\n" }]);
    assert.deepEqual(outcome.changed, [path.join(scenario, "new", "b.txt")]);
    assert.equal(nodeFs.statSync(target).mtimeMs, mtime, "an identical file is left alone");
    assert.equal(nodeFs.readFileSync(path.join(scenario, "new", "b.txt"), "utf8"), "fresh\n");
    restoreFiles(outcome.originals);
    assert.equal(nodeFs.existsSync(path.join(scenario, "new", "b.txt")), false, "a file that did not exist is removed again");
    assert.equal(nodeFs.readFileSync(target, "utf8"), "same\n");
  } finally {
    nodeFs.rmSync(scenario, { recursive: true, force: true });
  }
});

// --- the merge rules, on plain data ----------------------------------------------------------------------------------------

test("AC51: mergeEntry: a missing key is filled, an explicit path is replaced, everything else keeps its value, nested mappings are merged", () => {
  const existing = { a: 1, nested: { x: "keep", y: "old" }, list: [1] };
  const synthesized = { a: 2, b: 3, nested: { x: "new", y: "new", z: "added" }, list: [2] };
  assert.deepEqual(mergeEntry(existing, synthesized, new Set()), { a: 1, nested: { x: "keep", y: "old", z: "added" }, list: [1], b: 3 });
  assert.deepEqual(mergeEntry(existing, synthesized, new Set(["nested.y", "list"])), { a: 1, nested: { x: "keep", y: "new", z: "added" }, list: [2], b: 3 });
  assert.deepEqual(existing, { a: 1, nested: { x: "keep", y: "old" }, list: [1] }, "the input is not modified");
});

test("AC51: planManifestUpdate adds a project, an edge and a downstream project once, and names the projects that it touched", () => {
  const data = YAML.parse("projects: []\ndependencyEdges: []\n");
  const project = { projectKey: "p", repo: "o/p", driftAudit: { schedule: "0 6 * * 1" } };
  const downstream = { projectKey: "d", repo: "o/d", driftAudit: { enabled: false } };
  const edge = { edgeId: "p", downstreamRepo: "o/d", mode: "ai-adaptation" };
  const first = planManifestUpdate(data, { project, explicitProject: new Set(), downstreamProject: downstream, edge });
  assert.deepEqual(first.touched, ["p", "d"]);
  assert.equal(first.data.projects.length, 2);
  assert.equal(first.data.dependencyEdges.length, 1);
  const second = planManifestUpdate(first.data, { project, explicitProject: new Set(), downstreamProject: downstream, edge });
  assert.deepEqual(second.touched, [], "nothing changed, so nothing is touched");
  assert.deepEqual(second.data, first.data);
  const elsewhere = planManifestUpdate(first.data, { project, explicitProject: new Set(), edge: { ...edge, downstreamRepo: "o/other" } });
  assert.match(elsewhere.keyCollision, /the edge 'p' already runs from .* to o\/d/);
});

test("AC51: applyDataToText returns the text itself when nothing changed and refuses an edit that does not reproduce the intended data", () => {
  const text = "# keep\nprojects:\n  - projectKey: a   # note\n    repo: o/a\n";
  assert.equal(applyDataToText(text, YAML.parse(text), YAML.parse(text)), text);
  const original = YAML.parse(text);
  const merged = structuredClone(original);
  merged.projects[0].extra = { nested: ["x", "y"] };
  const edited = applyDataToText(text, original, merged);
  assert.ok(edited.startsWith("# keep\nprojects:\n  - projectKey: a   # note\n    repo: o/a\n"));
  assert.deepEqual(YAML.parse(edited), merged);
});
