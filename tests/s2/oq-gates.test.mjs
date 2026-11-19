// The gated open questions of SPEC-02: OQ22 to OQ25 (AC16), OQ28 and OQ29 (AC21), OQ34 (AC13, AC18), OQ35 (AC2, AC7), OQ36 (AC2, AC18, AC25)
// and OQ37 (AC18, AC20). SPEC-02 §4 keeps all ten open (each is CONTRADICTED by its verifier), and the non-goals forbid resolving them.
// A gated criterion therefore asserts the configuration and no outcome that an open question would decide. Each gated item has one test whose
// name is exactly the item id (the final inventory test reads this file and fails when one is missing or renamed); each states what the
// criterion promises not to assume and checks that nothing S2 ships or tests assumes it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { engineFile } from "../helpers/instance.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, driftWorkflowText, instanceScript, listTree, presetManifest, projectOf, readText, S2_ROOT } from "./helpers/fixtures.mjs";

const SPEC = readText(abs("specs", "02-upstream-drift-automation.md"));
const GATED = { OQ22: "AC16", OQ23: "AC16", OQ24: "AC16", OQ25: "AC16", OQ28: "AC21", OQ29: "AC21", OQ34: "AC13, AC18", OQ35: "AC2, AC7", OQ36: "AC2, AC18, AC25", OQ37: "AC18, AC20" };

const row = (id) => SPEC.split("\n").find((line) => line.startsWith(`| ${id} |`));
const code = (file) => readText(file).split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
/** The files of a directory of this repository, and of a directory of the engine package that this repository runs (S2 is the engine's drift automation: prompts/drift and src/drift). */
const s2Surface = (...parts) => listTree(abs(...parts)).map((file) => abs(...parts, file));
const engineSurface = (...parts) => listTree(engineFile(...parts)).map((file) => engineFile(...parts, file));

/** The files in which S2 would have to hard-code anything about the lab registry. */
const LAB_AUDIT_SURFACE = () => [abs("instructions", "copilot-lab.md"), instanceScript("validate-copilot-lab-audit.mjs"), ...engineSurface("prompts", "drift"), ...engineSurface("src", "drift")];
/** The files in which S2 would have to encode anything about the target's freshness check. */
const FRESHNESS_SURFACE = () => [abs("instructions", "gh-admin-msft.md"), abs("sdlc.yaml"), engineFile("src", "snapshot-watch-sources.mjs"), instanceScript("validate-copilot-lab-audit.mjs"), ...engineSurface("prompts", "drift"), ...engineSurface("src", "drift")];
/** Every non-comment line of every test and helper of the suite. */
const SUITE_CODE = () => listTree(S2_ROOT).filter((file) => file.endsWith(".mjs") && !file.startsWith("fixtures/")).map((file) => ({ file, text: code(path.join(S2_ROOT, ...file.split("/"))) }));

function gate(id, t) {
  const line = row(id);
  assert.ok(line, `${id} is still listed in §4`);
  assert.match(line, /\*\*CONTRADICTED\*\*/, `${id} is still open: S2 does not resolve it`);
  assert.ok(line.trimEnd().endsWith(`| ${GATED[id]} |`), `${id} still gates ${GATED[id]}`);
  t.diagnostic(`${id} gates ${GATED[id]}`);
}

test("OQ22", (t) => {
  gate("OQ22", t);
  const lab = readText(abs("instructions", "copilot-lab.md"));
  assert.match(lab, /1\. whether a freshness threshold is stated, and what it is;/, "AC16: the agent derives the threshold at run time");
  for (const file of LAB_AUDIT_SURFACE()) {
    const text = readText(file);
    assert.equal(/\b(stale|fresh\w*|expir\w*|threshold)\b[^.\n]{0,60}\b\d+\s*(day|week|month|year)s?\b/i.test(text), false, `${path.relative(abs("."), file)} states a freshness period`);
    assert.equal(/max_age|maximum_age|review_by|next_review|staleness/i.test(text), false, `${path.relative(abs("."), file)} names an age or review key`);
  }
});

test("OQ23", (t) => {
  gate("OQ23", t);
  const lab = readText(abs("instructions", "copilot-lab.md"));
  assert.match(lab, /2\. where verification dates are recorded, and which of them is the latest;/, "AC16: the agent finds the dates, and the latest of them, at run time");
  for (const file of LAB_AUDIT_SURFACE()) {
    const text = readText(file).replaceAll("2022-11-28", ""); // the GitHub REST API version header of the client, which is not a registry date
    assert.equal(/\blast_verified\b/.test(text), false, `${path.relative(abs("."), file)} assumes the last_verified field`);
    assert.equal(/\b20\d{2}-\d{2}-\d{2}\b/.test(text), false, `${path.relative(abs("."), file)} holds a date literal`);
  }
});

test("OQ24", (t) => {
  gate("OQ24", t);
  const lab = readText(abs("instructions", "copilot-lab.md"));
  assert.match(lab, /3\. whether a structured mapping from a claim to the files that consume it exists;/, "AC16: whether a mapping exists is decided at run time");
  assert.match(lab, /Do not hard-code a threshold, a date location or a claim-to-file mapping\./);
  for (const file of LAB_AUDIT_SURFACE()) {
    const text = readText(file);
    assert.equal(/\b(consumers|used_in|referenced_by)\s*:/.test(text), false, `${path.relative(abs("."), file)} assumes a mapping key`);
    assert.equal(/\b[\w./-]+\.(md|ts|js|mjs|json|sh|ps1):\d+\b/.test(text), false, `${path.relative(abs("."), file)} pairs a file with a line`);
  }
});

test("OQ25", (t) => {
  gate("OQ25", t);
  const lab = readText(abs("instructions", "copilot-lab.md"));
  assert.match(lab, /4\. which consumers its comments name\./, "AC16: the consumers are read from the registry's comments at run time");
  assert.match(lab, /Record in the `## Checks` section of the report each of these four points that you could not determine\./);
  for (const file of LAB_AUDIT_SURFACE()) {
    const text = readText(file);
    for (const consumer of ["registry-consumed.test", "scripts/preflight", "mcp-configs", "labs/lab14", "labs/lab20", "compiler_version"]) {
      assert.equal(text.includes(consumer), false, `${path.relative(abs("."), file)} names the consumer '${consumer}'`);
    }
  }
});

test("OQ28", (t) => {
  gate("OQ28", t);
  for (const file of FRESHNESS_SURFACE()) assert.equal(readText(file).includes("isCorrective"), false, `${path.relative(abs("."), file)} encodes how the target classifies corrective phrasing`);
  for (const key of DRIFT_KEYS) assert.equal(driftWorkflow(key).body.includes("isCorrective"), false, `the prompt body of drift-${key}.md`);
  const verify = projectOf(presetManifest(), "gh-admin-msft").driftAudit.verifyCommands;
  assert.ok(verify.includes("npm run test:freshness"), "AC21: the freshness check is one verify command");
  assert.equal(/[|>]|\bgrep\b|\bsed\b|\|\|/.test("npm run test:freshness"), false);
  assert.deepEqual(verify.filter((command) => command.includes("freshness")), ["npm run test:freshness"], "and it is consumed by its exit status alone: no filter, no reinterpretation of its output");
  assert.match(readText(abs("instructions", "gh-admin-msft.md")), /Do not edit the repository's tests, validation scripts or generated files that the build overwrites/, "nor is the target's tests/ edited to make it pass");
});

test("OQ29", (t) => {
  gate("OQ29", t);
  for (const file of FRESHNESS_SURFACE()) {
    const text = readText(file);
    assert.equal(text.includes("htmlToText"), false, `${path.relative(abs("."), file)} encodes how the target reads HTML`);
    assert.equal(text.includes("data-notes"), false, `${path.relative(abs("."), file)} encodes how the target reads speaker notes`);
  }
  for (const key of DRIFT_KEYS) {
    const { body } = driftWorkflow(key);
    for (const identifier of ["htmlToText", "data-notes", "isCorrective"]) assert.equal(body.includes(identifier), false, `${identifier} in the prompt body of drift-${key}.md`);
  }
  assert.equal(driftPreset("gh-admin-msft").driftAudit.verifyCommands.some((command) => /validate-freshness/.test(command) && command !== "npm run test:freshness"), false, "the script is reached only through the repository's own npm script");
});

test("OQ34", (t) => {
  gate("OQ34", t);
  for (const key of DRIFT_KEYS) {
    const { frontmatter } = driftWorkflow(key);
    assert.equal(driftWorkflowText(key).includes("web-search"), false, `AC13: ${key} does not rely on native web search`);
    assert.ok("web-fetch" in frontmatter.tools && frontmatter.tools.bash.includes("git") && frontmatter.tools.bash.includes("node"), `AC13/AC18: ${key} declares web-fetch and a bash allowlist with git and node`);
    assert.ok(frontmatter.engine, `${key}: an engine key is rendered`);
  }
  for (const { file, text } of SUITE_CODE()) {
    assert.equal(/assert\.(equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(driftWorkflow\([^)]*\)\.)?frontmatter\.engine(\.id)?\s*,\s*["'`{]/.test(text), false, `${file} pins the engine`);
    assert.equal(/\bengines\.md\b/.test(text), false, `${file} cites the engines reference as a source of an assertion`);
  }
});

test("OQ35", (t) => {
  gate("OQ35", t);
  for (const key of DRIFT_KEYS) assert.deepEqual(driftWorkflow(key).frontmatter["safe-outputs"]["threat-detection"], { "continue-on-error": false }, `AC2: ${key} renders the configuration`);
  const outcomes = [["gh-aw", "threat", "detected"].join("-"), ["gh-aw", "threat", "engine", "error"].join("-"), ["Threat detection", "engine error"].join(" "), ["agentic", "threat", "detected"].join(" "), "[!" + "CAUTION]"];
  for (const { file, text } of SUITE_CODE()) for (const outcome of outcomes) assert.equal(text.includes(outcome), false, `${file} asserts a detection outcome: ${outcome}`);
  for (const file of [engineFile("src", "snapshot-watch-sources.mjs"), instanceScript("validate-copilot-lab-audit.mjs"), ...engineSurface("src", "drift")]) {
    for (const outcome of outcomes) assert.equal(readText(file).includes(outcome), false, `${path.relative(abs("."), file)} depends on a detection outcome`);
  }
});

test("OQ36", (t) => {
  gate("OQ36", t);
  for (const key of DRIFT_KEYS) {
    const block = driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"];
    assert.strictEqual(block["preserve-branch-name"], true, `AC2/AC25: ${key}`);
    assert.strictEqual(block["recreate-ref"], false, `AC2/AC25: ${key}: an earlier pull request stays open`);
    assert.strictEqual(block["fallback-as-issue"], true);
  }
  const collision = [["already exists and", "preserve-branch-name is enabled"].join(" "), ["push", "failed"].join("_"), ["error", "type"].join("_"), ["Remote", "branch"].join(" ")];
  for (const { file, text } of SUITE_CODE()) for (const phrase of collision) assert.equal(text.includes(phrase), false, `${file} asserts what a remote-branch collision does: ${phrase}`);
  for (const file of [engineFile("src", "snapshot-watch-sources.mjs"), ...engineSurface("src", "drift"), ...engineSurface("prompts", "drift")]) {
    for (const phrase of collision) assert.equal(readText(file).includes(phrase), false, `${path.relative(abs("."), file)} assumes a collision behaviour: ${phrase}`);
  }
});

test("OQ37", (t) => {
  gate("OQ37", t);
  const handlerError = ["No commits were found", "to create a pull request"].join(" ");
  const recovery = ["object", "pack"].join("-");
  for (const { file, text } of SUITE_CODE()) {
    assert.equal(text.includes(handlerError), false, `${file} asserts the handler's error text`);
    assert.equal(text.includes(recovery), false, `${file} asserts the handler's recovery path`);
  }
  for (const file of [engineFile("src", "snapshot-watch-sources.mjs"), ...engineSurface("src", "drift"), ...engineSurface("prompts", "drift"), ...s2Surface("instructions")]) {
    assert.equal(readText(file).includes(handlerError), false, `${path.relative(abs("."), file)} depends on the handler's error text`);
  }
  const verify = driftPreset("gh-admin-msft").driftAudit.verifyCommands;
  assert.equal(verify[2], 'test -z "$(git status --porcelain)"', "AC20: a missing commit is caught by the clean-tree gate, third in the order");
  assert.deepEqual(verify.slice(0, 2), ["npm ci", "node presentation/build.mjs"]);
});

test("the ten gated items of SPEC-02 each have one test in this file, and §4 lists no other open question of this spec", () => {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const id of Object.keys(GATED)) assert.equal(new RegExp(`^test\\("${id}", \\(t\\)`, "m").test(source), true, `the test named ${id} exists`);
  const open = SPEC.split("\n").filter((line) => /^\| OQ\d+ \|/.test(line)).map((line) => /^\| (OQ\d+) \|/.exec(line)[1]);
  assert.deepEqual(open, Object.keys(GATED), "§4 holds exactly these ten");
  assert.match(SPEC, /Resolving any open question: `OQ22`–`OQ25`, `OQ28`–`OQ29` and `OQ34`–`OQ37` stay in §4/, "and the non-goals still forbid resolving them");
});
