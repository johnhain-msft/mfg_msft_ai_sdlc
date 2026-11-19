// AC20 and AC21: the shipped gate of johnhain-msft/gh-admin-msft (gated by OQ28, OQ29, OQ37). Its verifyCommands are, in this order, npm ci,
// node presentation/build.mjs, a git status --porcelain clean-tree check, npm run test:unit, npm run test:freshness, npm run test:deck and
// npm test -- --skip-links, with reviewers assigned. The clean-tree entry exits non-zero whenever git status --porcelain prints a line,
// untracked files included: it is the detector for rebuilt outputs that the agent did not commit. S2 consumes only the exit status of
// npm run test:freshness and encodes no assumption about how the target classifies phrasing (OQ28) or reads speaker notes (OQ29).
//
// `--skip-links`: confirmed against the target repository before use. Its `test` script is `node tests/run-all.js`, which reads
// `process.argv.includes('--skip-links')` and skips the link-validation suite; `npm test -- --skip-links` passes the argument through.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { engineFile } from "../helpers/instance.mjs";
import { abs, driftPreset, driftWorkflow, fixture, listTree, projectOf, presetManifest, readText, readTree, REPO_ROOT } from "./helpers/fixtures.mjs";
import { adminFiles, BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";

const AUDIT = () => projectOf(presetManifest(), "gh-admin-msft").driftAudit;
const EXPECTED = ["npm ci", "node presentation/build.mjs", 'test -z "$(git status --porcelain)"', "npm run test:unit", "npm run test:freshness", "npm run test:deck", "npm test -- --skip-links"];
const CLEAN_TREE = EXPECTED[2];

test("AC20: the verifyCommands of gh-admin-msft are exactly the seven commands, in this order, and the reviewers are assigned", () => {
  assert.deepEqual(AUDIT().verifyCommands, EXPECTED);
  assert.ok(AUDIT().reviewers.length > 0, "reviewers are assigned in sdlc.yaml");
  assert.ok(AUDIT().reviewers.every((reviewer) => typeof reviewer === "string" && reviewer !== ""));
  assert.deepEqual(driftWorkflow("gh-admin-msft").frontmatter["post-steps"].map((step) => step.run), EXPECTED, "and the rendered post-steps run them");
  assert.deepEqual(driftPreset("gh-admin-msft").driftAudit.verifyCommands, EXPECTED);
});

test("AC20: the gate names the target's scripts by their package.json names and calls no validator directly", () => {
  const joined = EXPECTED.join("\n");
  assert.ok(joined.includes("npm run test:freshness") && joined.includes("npm run test:deck"), "test:freshness and test:deck");
  assert.equal(/validate-freshness|validate-deck/.test(joined), false, "the validators are the target's own concern");
});

/** The clean-tree command on a repository made from a fixture directory. */
async function cleanTreeIn(name, change = () => {}) {
  const gate = createGateWorkspace({ checkoutName: "gh-admin-msft", files: readTree(fixture("clean-tree", name, "files")) });
  try {
    const overlay = fixture("clean-tree", name, "overlay");
    if (fs.existsSync(overlay)) for (const [relative, text] of Object.entries(readTree(overlay))) gate.write(relative, text);
    change(gate);
    return await gate.runScript(CLEAN_TREE, { workingDirectory: "gh-admin-msft" });
  } finally {
    gate.cleanup();
  }
}

test("AC20: the clean-tree entry exits 0 on a clean fixture repository and non-zero on a dirty one", { skip: BASH_SKIP }, async () => {
  assert.deepEqual(listTree(fixture("clean-tree", "clean", "files")), ["docs/lab01.md", "package.json"]);
  const clean = await cleanTreeIn("clean");
  assert.equal(clean.code, 0, clean.stderr);
  const dirty = await cleanTreeIn("dirty");
  assert.notEqual(dirty.code, 0, "an untracked rebuilt output makes it fail");
});

test("AC20: the clean-tree entry fails for any line of git status --porcelain: untracked, modified, deleted, staged or renamed", { skip: BASH_SKIP }, async () => {
  const forms = {
    untracked: (gate) => gate.write("new-output.html", "x\n"),
    modified: (gate) => gate.write("docs/lab01.md", "changed\n"),
    deleted: (gate) => gate.remove("docs/lab01.md"),
    nestedUntracked: (gate) => gate.write("presentation/dist/deck/slide-01.png", "png\n"),
  };
  for (const [name, change] of Object.entries(forms)) {
    const outcome = await cleanTreeIn("clean", change);
    assert.notEqual(outcome.code, 0, name);
  }
  const ignored = await cleanTreeIn("clean", (gate) => {
    gate.write(".gitignore", "build-cache/\n");
    gate.git("add", ".gitignore");
    gate.git("commit", "-q", "-m", "ignore");
    gate.write("build-cache/x.bin", "ignored output\n");
  });
  assert.equal(ignored.code, 0, "a file that is ignored does not appear in git status --porcelain, so it is not a missing commit");
});

test("AC20 and AC18: a gate run in which the build leaves an output that was not committed fails at the clean-tree step, before the tests", { skip: BASH_SKIP }, async () => {
  const steps = driftWorkflow("gh-admin-msft").frontmatter["post-steps"];
  const gate = createGateWorkspace({ checkoutName: "gh-admin-msft", files: adminFiles() });
  try {
    // the build writes a file into the checkout, as `node presentation/build.mjs` does for the deck
    gate.write("presentation/build.mjs", 'import fs from "node:fs";\nfs.writeFileSync("rebuilt-deck.html", "rebuilt\\n");\n');
    gate.git("add", "-A");
    gate.git("commit", "-q", "-m", "build script");
    const outcome = await gate.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken" } });
    assert.equal(outcome.code, 1, outcome.log);
    assert.equal(outcome.failed, CLEAN_TREE);
    assert.deepEqual(outcome.ran, EXPECTED.slice(0, 3), "npm ci, the build and the clean-tree check ran; the tests did not");
  } finally {
    gate.cleanup();
  }
});

test("AC20: with the build output committed first, the same gate passes the clean-tree step", { skip: BASH_SKIP }, async () => {
  const steps = driftWorkflow("gh-admin-msft").frontmatter["post-steps"];
  const gate = createGateWorkspace({ checkoutName: "gh-admin-msft", files: adminFiles() });
  try {
    gate.write("presentation/build.mjs", 'import fs from "node:fs";\nfs.writeFileSync("rebuilt-deck.html", "rebuilt\\n");\n');
    gate.write("rebuilt-deck.html", "rebuilt\n");
    gate.git("add", "-A");
    gate.git("commit", "-q", "-m", "build script and its output, committed");
    const outcome = await gate.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken" } });
    assert.equal(outcome.code, 0, outcome.log);
  } finally {
    gate.cleanup();
  }
});

test("AC21: the gate exits 1 when the stubbed npm run test:freshness exits non-zero, runs nothing after it, and passes when it exits 0", { skip: BASH_SKIP }, async () => {
  const steps = driftWorkflow("gh-admin-msft").frontmatter["post-steps"];
  const gate = createGateWorkspace({ checkoutName: "gh-admin-msft", files: adminFiles() });
  try {
    const failed = await gate.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken", SDLC_S2_NPM_FAIL: JSON.stringify(["run test:freshness"]) } });
    assert.equal(failed.code, 1, failed.log);
    assert.equal(failed.failed, "npm run test:freshness");
    assert.deepEqual(failed.ran, EXPECTED.slice(0, 5));
    const npmCalls = gate.shims.calls("npm").map((call) => call.args.join(" "));
    assert.deepEqual(npmCalls, ["ci", "run test:unit", "run test:freshness"], "test:deck and the full suite never ran");
  } finally {
    gate.cleanup();
  }
  const passing = createGateWorkspace({ checkoutName: "gh-admin-msft", files: adminFiles() });
  try {
    const outcome = await passing.runSteps(steps, { env: { GH_TOKEN: "ghs_fixturetoken" } });
    assert.equal(outcome.code, 0, outcome.log);
  } finally {
    passing.cleanup();
  }
});

test("AC21: S2 consumes only the exit status of npm run test:freshness: the step is the bare command, with no output parsing", () => {
  const step = driftWorkflow("gh-admin-msft").frontmatter["post-steps"][4];
  assert.equal(step.run, "npm run test:freshness");
  assert.equal(/[|><&;]|grep|sed|awk|tee|\$\(/.test(step.run), false);
  assert.equal("continue-on-error" in step || "if" in step, false);
});

function* files(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(child);
    else yield child;
  }
}

test("AC21: nothing in the engine's src/drift/, the instruction file or the rendered prompt names isCorrective, htmlToText or data-notes, and the target's tests are not edited", () => {
  const identifiers = ["isCorrective", "htmlToText", "data-notes"];
  const searched = [...files(engineFile("src", "drift")), engineFile("src", "snapshot-watch-sources.mjs"), abs("scripts", "validate-copilot-lab-audit.mjs"), abs("instructions", "gh-admin-msft.md")];
  for (const file of searched) {
    const text = fs.readFileSync(file, "utf8");
    for (const identifier of identifiers) assert.equal(text.includes(identifier), false, `${path.relative(REPO_ROOT, file)} contains ${identifier}`);
  }
  const { body } = driftWorkflow("gh-admin-msft");
  for (const identifier of identifiers) assert.equal(body.includes(identifier), false, `the rendered prompt contains ${identifier}`);
  assert.match(readText(abs("instructions", "gh-admin-msft.md")), /Do not edit the repository's tests, validation scripts or generated files/);
});
