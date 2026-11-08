// AC48-AC50: check (iv) of src/verify-immutable-gates.mjs. Under `node --frozen-intrinsics` the locked rule and sanitiser modules are loaded and every value that
// they export is frozen before any editable module is imported; the rule checker, the pinned constants and the sanitiser then run in that process; and Vitest
// runs the companion test files, whose locked tests must all have passed. The downstream's TypeScript is loaded by Node's own type stripping here (the synthetic
// checkout has no tsx), and Vitest is a stand-in that writes the report that a test gives it, so nothing leaves this machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deepFreeze, readInvariants } from "../../src/adaptation/frozen-harness.mjs";
import { evaluateLockedTests } from "../../src/adaptation/vitest-run.mjs";
import { fixture, readJson } from "./helpers/fixtures.mjs";
import { policyOf, read, replaceOnce, scenario, shown } from "./helpers/gates.mjs";

const LAB = "cascade-ai-copilot-lab";
const SHOWCASE = "cascade-ai-pipeline-showcase";
const INTERMEDIATE = "cascade-ai-github-intermediate";
const CONTENT = "experiences/copilot-workshop/content";
const M1 = `${CONTENT}/m1.ts`;
const RULES = `${CONTENT}/rules.ts`;
const SHARED = `${CONTENT}/shared.ts`;
const TERMS = "tests/support/customer-terms.ts";
const COPILOT_TEST = "tests/copilot-workshop.test.ts";

// A module of the content directory that re-exports the locked values: the way an editable module reaches a locked value without a new import of the locked
// module, which check (iii) would catch. It is part of the base, so only check (iv) can see what an editable module does to the values that it re-exports.
const SHARED_SOURCE = [
  "export { AUDIENCE_WORDS, LIVE_SECONDS, SPEECH_WPM } from './rules';",
  "export { findCustomerTerms } from '../../../tests/support/customer-terms';",
  "",
].join("\n");
const withShared = () => ({ [SHARED]: SHARED_SOURCE });
const prependToM1 = (code) => (dir) => ({ [M1]: `${code}\n${read(dir, M1)}` });
const importShared = "import { AUDIENCE_WORDS, LIVE_SECONDS, SPEECH_WPM, findCustomerTerms } from './shared';";

const words = (count, prefix = "w") => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
const violation = (result, file, pattern) => {
  assert.equal(result.code, 1, shown(result));
  assert.equal(result.json.status, "violation", shown(result));
  assert.ok(result.json.violatingFiles.includes(file), `${file} in ${JSON.stringify(result.json.violatingFiles)}\n${result.stderr}`);
  if (pattern) assert.match(result.stderr, pattern, shown(result));
};

/** Replaces the Vitest stand-in by one that also records how it was started; returns a reader of the recorded calls. */
function recordVitestCalls(dir) {
  const script = path.join(dir, "node_modules", "vitest", "vitest.mjs");
  const log = path.join(dir, "node_modules", "vitest", "calls.jsonl");
  const recorder = [
    'import recorder from "node:fs";',
    `recorder.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS ?? "", frozen: Object.isFrozen(Object.prototype) }) + "\\n");`,
    "",
  ].join("\n");
  fs.writeFileSync(script, recorder + fs.readFileSync(script, "utf8"));
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
}

test("AC48/AC50: a clean change of an editable module is ok, and check (iv) really ran: Vitest started once, in the checkout, over the companion file, with the JSON reporter and without the frozen flag", () => {
  const checked = scenario({ mutate: (dir) => ({ [M1]: replaceOnce(read(dir, M1), "Three ways to extend the tool.", "Three ways to extend the whole tool.") }) });
  const calls = recordVitestCalls(checked.dir);
  const result = checked.run({ env: { NODE_OPTIONS: "--frozen-intrinsics --max-old-space-size=1024" } });
  assert.equal(result.code, 0, shown(result));
  assert.deepEqual(result.json, { status: "ok", violatingFiles: [] });
  const recorded = calls();
  assert.equal(recorded.length, 1, "Vitest ran exactly once");
  const [call] = recorded;
  assert.equal(call.argv[0], "run");
  assert.ok(call.argv.includes("--reporter=json"), JSON.stringify(call.argv));
  assert.ok(call.argv.some((argument) => argument.startsWith("--outputFile=")), JSON.stringify(call.argv));
  assert.equal(call.argv.at(-1), "tests/copilot-workshop.test.ts");
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(checked.dir), "Vitest runs in the checkout");
  assert.equal(call.frozen, false, "Vitest patches the built-ins, so its process must not be frozen");
  assert.doesNotMatch(call.nodeOptions, /frozen-intrinsics/);
  assert.match(call.nodeOptions, /--max-old-space-size=1024/, "the other options of the environment are kept");
});

test("AC48: every value that a locked module exports is frozen before an editable module is imported: an editable module that only checks it is let through, and one that expects an unfrozen value is not", () => {
  const probe = [
    importShared,
    "const frozen = [AUDIENCE_WORDS, LIVE_SECONDS, SPEECH_WPM, findCustomerTerms].every((value) => Object.isFrozen(value));",
    "if (!frozen) throw new Error('a locked value was not frozen when this module was imported');",
  ].join("\n");
  const frozen = scenario({ prepare: withShared, mutate: prependToM1(probe) }).run();
  assert.equal(frozen.code, 0, shown(frozen));
  const control = scenario({ prepare: withShared, mutate: prependToM1(`${importShared}\nif (Object.isFrozen(LIVE_SECONDS)) throw new Error('LIVE_SECONDS was already frozen');`) }).run();
  violation(control, M1, /LIVE_SECONDS was already frozen/);
});

test("AC48: an editable module that changes a locked value at import time, through a path that check (iii) cannot see, gets a TypeError and is a violation (exit 1) that names that module", () => {
  const mutations = [
    ["a constant", "LIVE_SECONDS.perCommand = 1;"],
    ["a pinned threshold", "AUDIENCE_WORDS.max = 500;"],
    ["the speaking rate object", "SPEECH_WPM.max = 1000;"],
    ["a function of the sanitiser", "(findCustomerTerms as unknown as { patched: boolean }).patched = true;"],
    ["a built-in", "(Array.prototype as unknown as { includes: () => boolean }).includes = () => true;"],
  ];
  for (const [name, code] of mutations) {
    const result = scenario({ prepare: withShared, mutate: prependToM1(`${importShared}\nvoid [AUDIENCE_WORDS, LIVE_SECONDS, SPEECH_WPM, findCustomerTerms];\n${code}`) }).run();
    violation(result, M1, /m1\.ts.*\(TypeError\): Cannot (?:assign to read only|add) property/);
    assert.deepEqual(result.json.violatingFiles, [M1], `${name}: only the module that tried it`);
  }
  const clean = scenario({ prepare: withShared, mutate: prependToM1(`${importShared}\nvoid [AUDIENCE_WORDS, LIVE_SECONDS, SPEECH_WPM, findCustomerTerms];`) }).run();
  assert.equal(clean.code, 0, `the same module without the mutation is fine: ${shown(clean)}`);
});

test("AC48: a locked module that cannot be imported at all is a violation that names it (exit 1)", () => {
  const result = scenario({ prepare: (dir) => ({ [TERMS]: `throw new Error("the sanitiser is broken");\n${read(dir, TERMS)}` }) }).run();
  violation(result, TERMS, /the locked module tests\/support\/customer-terms\.ts cannot be imported: the sanitiser is broken/);
});

test("AC48: an editable module that cannot be imported (a syntax error, a missing module, a throw at the top level) is a violation that names it", () => {
  const broken = [
    ["a syntax error", "export const = ;"],
    ["a module that does not exist", "import './nowhere-at-all';"],
    ["a throw at the top level", "throw new Error('no content for you');"],
  ];
  for (const [name, code] of broken) {
    const result = scenario({ mutate: prependToM1(code) }).run();
    assert.equal(result.code, 1, `${name}: ${shown(result)}`);
    assert.ok(result.json.violatingFiles.includes(M1) || result.json.violatingFiles.some((file) => file.startsWith(CONTENT)), `${name}: ${result.stdout}`);
  }
});

const SLIDE_BLOCKS = "blocks: ['Agents', 'Skills', 'Hooks'],";
const SLIDE_SCRIPT = /script: \[[^\n]*\],\n/;
test("AC49: checkCourse is run in this process over the course: a finding of level error or of level warn is a violation (exit 1) that names the changed module", () => {
  const cases = [
    ["error: more audience words than the hard limit", (text) => replaceOnce(text, SLIDE_BLOCKS, `blocks: ['${words(89)}'],`), /error audience-words M1\/m1-opening/],
    ["warn: more audience words than the target", (text) => replaceOnce(text, SLIDE_BLOCKS, `blocks: ['${words(70)}'],`), /warn audience-words M1\/m1-opening/],
    ["error: a lead that is too long", (text) => replaceOnce(text, "lead: 'Three ways to extend the tool.'", `lead: '${words(30)}'`), /lead-length/],
    ["error: a page that cannot be spoken in its minutes", (text) => text.replace(SLIDE_SCRIPT, () => `script: ['${words(300)}'],\n`), /pace/],
    ["error: a module that runs over its minutes", (text) => replaceOnce(text.replace(SLIDE_SCRIPT, () => `script: ['${words(100)}'],\n`), "minutes: 1,\n  slides", "minutes: 0.5,\n  slides"), /module-pace M1/],
  ];
  for (const [name, change, pattern] of cases) {
    const result = scenario({ mutate: (dir) => ({ [M1]: change(read(dir, M1)) }) }).run();
    assert.equal(result.code, 1, `${name}: ${shown(result)}`);
    violation(result, M1, pattern);
    assert.match(result.stderr, /check \(iv\)/);
  }
  const within = scenario({ mutate: (dir) => ({ [M1]: replaceOnce(read(dir, M1), SLIDE_BLOCKS, `blocks: ['${words(50)}'],`) }) }).run();
  assert.equal(within.code, 0, `a page within every limit passes: ${shown(within)}`);
});

test("AC49: a finding in a base that was already unclean is still a violation, and it names the course module when no editable module changed", () => {
  const result = scenario({ prepare: (dir) => ({ [M1]: replaceOnce(read(dir, M1), SLIDE_BLOCKS, `blocks: ['${words(89)}'],`) }) }).run();
  violation(result, `${CONTENT}/index.ts`, /audience-words/);
});

test("AC49: the pinned constants are asserted: a speaking rate or thresholds that are not the pinned ones are a violation that names the rule module, even when the change itself did not touch it", () => {
  const rates = [
    ["the speaking rate", (text) => replaceOnce(text, "export const SPEAKING_WPM = 140;", "export const SPEAKING_WPM = 150;"), /SPEAKING_WPM is 150, not the pinned 140/],
    ["the hard limit of audience words", (text) => replaceOnce(text, "{ target: 60, max: 90 }", "{ target: 60, max: 95 }"), /AUDIENCE_WORDS is .*"max":95.*not the pinned/],
    ["an added field of the thresholds", (text) => replaceOnce(text, "{ target: 60, max: 90 }", "{ target: 60, max: 90, extra: 1 }"), /AUDIENCE_WORDS is/],
  ];
  for (const [name, change, pattern] of rates) {
    const result = scenario({ prepare: (dir) => ({ [RULES]: change(read(dir, RULES)) }) }).run();
    assert.equal(result.code, 1, `${name}: ${shown(result)}`);
    violation(result, RULES, pattern);
  }
});

test("AC49: findCustomerTerms runs over every changed editable content module and every changed companion test file; a protected phrase is a violation that names the file", () => {
  const inModule = scenario({ mutate: (dir) => ({ [M1]: replaceOnce(read(dir, M1), "'Agents'", "'Contoso Widgets'") }) }).run();
  violation(inModule, M1, /findCustomerTerms found 1 protected phrase/);
  const inTest = scenario({
    mutate: (dir) => ({ [COPILOT_TEST]: replaceOnce(read(dir, COPILOT_TEST), "    expect(inputs.commit).toBe(provenance.commit);", "    // a note about Contoso Widgets\n    expect(inputs.commit).toBe(provenance.commit);") }),
  }).run();
  violation(inTest, COPILOT_TEST, /findCustomerTerms found 1 protected phrase/);
  const unchanged = scenario({ prepare: (dir) => ({ [M1]: replaceOnce(read(dir, M1), "'Agents'", "'Contoso Widgets'") }) }).run();
  assert.equal(unchanged.code, 0, `a phrase in a file that the change did not touch is not this change's business: ${shown(unchanged)}`);
  const phraseOnly = scenario({ mutate: (dir) => ({ [M1]: replaceOnce(read(dir, M1), "'Agents'", "'Contoso'") }) }).run();
  assert.equal(phraseOnly.code, 0, `one word of a two-word phrase is not the phrase: ${shown(phraseOnly)}`);
});

test("AC49: a change that is only in the work tree is run through the same checks as a commit", () => {
  const result = scenario({ commit: false, mutate: (dir) => ({ [M1]: replaceOnce(read(dir, M1), "'Agents'", "'Contoso Widgets'") }) }).run();
  violation(result, M1, /findCustomerTerms/);
});

test("AC50: Vitest runs over the companion test file of the workflow and every locked test must be in its JSON report and have passed", () => {
  const outcomes = [
    ["every locked test passed", "passed.json", LAB, 0],
    ["a locked it() skipped", "skipped.json", LAB, 1],
    ["a locked it() absent from the report", "missing.json", LAB, 1],
  ];
  for (const [name, report, workflow, code] of outcomes) {
    const result = scenario({ workflow, report: readJson(fixture("vitest-json", report)) }).run();
    assert.equal(result.code, code, `${name}: ${shown(result)}`);
    assert.equal(result.json.status, code === 0 ? "ok" : "violation");
    if (code === 1) {
      assert.deepEqual(result.json.violatingFiles, [COPILOT_TEST]);
      assert.match(result.stderr, /check \(iv\): tests\/copilot-workshop\.test\.ts: it\(".+"\)/);
    }
  }
});

test("AC50: a locked it() that failed, is pending or is a todo is a violation; so is one whose status is not the string passed", () => {
  const base = readJson(fixture("vitest-json", "passed.json"));
  for (const status of ["failed", "pending", "todo", "skipped", "disabled", undefined]) {
    const report = structuredClone(base);
    report.testResults[0].assertionResults[0].status = status;
    const result = scenario({ report }).run();
    assert.equal(result.code, 1, `${String(status)}: ${shown(result)}`);
    assert.deepEqual(result.json.violatingFiles, [COPILOT_TEST]);
  }
});

test("AC50: for a locked describe() every test under it must be in the report and have passed; a test of an unlocked describe may fail without a violation", () => {
  const passed = scenario({ workflow: SHOWCASE, report: readJson(fixture("vitest-json", "describe-passed.json")) }).run();
  assert.equal(passed.code, 0, shown(passed));
  const childFailed = scenario({ workflow: SHOWCASE, report: readJson(fixture("vitest-json", "describe-child-failed.json")) }).run();
  violation(childFailed, "tests/pipeline-showcase.test.ts", /describe\("pipeline-showcase animated SVG"\) > is self-contained.*"failed"/);
  const unlockedFailure = readJson(fixture("vitest-json", "describe-passed.json"));
  unlockedFailure.testResults[0].assertionResults[2].status = "failed";
  assert.equal(unlockedFailure.testResults[0].assertionResults[2].ancestorTitles[0], "pipeline-showcase run-data snapshot");
  const unlocked = scenario({ workflow: SHOWCASE, report: unlockedFailure }).run();
  assert.equal(unlocked.code, 0, `the run-data describe is not locked: ${shown(unlocked)}`);
  const absent = readJson(fixture("vitest-json", "describe-passed.json"));
  absent.testResults[0].assertionResults = absent.testResults[0].assertionResults.filter((entry) => entry.ancestorTitles[0] !== "pipeline-showcase sanitization");
  violation(scenario({ workflow: SHOWCASE, report: absent }).run(), "tests/pipeline-showcase.test.ts", /describe\("pipeline-showcase sanitization"\) did not appear/);
});

test("AC50: the workflow that owns two companion files is judged on both of them", () => {
  const passed = scenario({ workflow: INTERMEDIATE, report: readJson(fixture("vitest-json", "github-intermediate-passed.json")) }).run();
  assert.equal(passed.code, 0, shown(passed));
  const report = readJson(fixture("vitest-json", "github-intermediate-passed.json"));
  report.testResults[1].assertionResults[1].status = "failed";
  const failed = scenario({ workflow: INTERMEDIATE, report }).run();
  violation(failed, "tests/github-intermediate-workshop.test.ts", /contains no customer names/);
  assert.deepEqual(failed.json.violatingFiles, ["tests/github-intermediate-workshop.test.ts"]);
});

test("AC50: a Vitest that writes no JSON report is a violation of every companion file (exit 1); a checkout without Vitest cannot be judged (exit 2, no JSON)", () => {
  const silent = scenario({});
  fs.writeFileSync(path.join(silent.dir, "node_modules", "vitest", "vitest.mjs"), "process.exitCode = 1;\n");
  violation(silent.run(), COPILOT_TEST, /Vitest produced no JSON report/);
  const garbage = scenario({});
  fs.writeFileSync(path.join(garbage.dir, "node_modules", "vitest", "vitest.mjs"), "process.stdout.write('not json at all');\nprocess.exitCode = 1;\n");
  violation(garbage.run(), COPILOT_TEST, /Vitest produced no JSON report/);
  const absent = scenario({});
  fs.rmSync(path.join(absent.dir, "node_modules", "vitest"), { recursive: true });
  const result = absent.run();
  assert.equal(result.code, 2, shown(result));
  assert.equal(result.json, null, "nothing was decided, so no JSON");
  assert.match(result.stderr, /vitest is not installed/);
});

test("AC50: the locked tests are read from the report by the file's own name, from a Windows or a POSIX path, and a report of another file does not stand in for it", () => {
  const locked = policyOf(LAB).lockedTestBlocks;
  const report = readJson(fixture("vitest-json", "passed.json"));
  assert.deepEqual(evaluateLockedTests(report, locked), []);
  const windows = structuredClone(report);
  windows.testResults[0].name = "C:\\work\\portfolio\\tests\\copilot-workshop.test.ts";
  assert.deepEqual(evaluateLockedTests(windows, locked), [], "a path with backslashes");
  const other = structuredClone(report);
  other.testResults[0].name = "/work/portfolio/tests/not-the-file.test.ts";
  assert.equal(evaluateLockedTests(other, locked).length, locked[0].blocks.length, "every locked block is then absent");
  assert.equal(evaluateLockedTests(null, locked).length, locked[0].blocks.length);
  assert.equal(evaluateLockedTests({ testResults: "nope" }, locked).length, locked[0].blocks.length);
});

test("AC48: deepFreeze freezes an object, an array, a function and what they hold, and the prototype of a class, but never the prototype of a built-in", () => {
  class Rule {
    check() {
      return true;
    }
  }
  const nested = { list: [1, { inner: "x" }], fn: Object.assign(() => 1, { property: { deep: true } }), when: new Rule(), map: new Map([["a", { b: 1 }]]) };
  deepFreeze(nested);
  for (const value of [nested, nested.list, nested.list[1], nested.fn, nested.fn.property, nested.when, Rule.prototype]) assert.ok(Object.isFrozen(value), String(value));
  assert.equal(Object.isFrozen(Map.prototype), false, "Map.prototype belongs to the runtime");
  assert.equal(Object.isFrozen(Object.prototype), false);
  assert.equal(Object.isFrozen(Array.prototype), false);
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  deepFreeze(cyclic);
  assert.ok(Object.isFrozen(cyclic));
  const accessor = { get value() { return { inside: 1 }; } };
  deepFreeze(accessor);
  assert.ok(Object.isFrozen(accessor));
  deepFreeze(null);
  deepFreeze(3);
  deepFreeze("text");
});

test("AC48: the inProcessInvariants of an edge are read strictly: a mapping, a list of module paths, references that name a module and an export, and constants that carry their value", () => {
  const preset = policyOf(LAB).inProcessInvariants;
  const read = readInvariants(preset);
  assert.deepEqual(read.frozenModules, preset.frozenModules);
  assert.deepEqual(read.course, { module: `${CONTENT}/index.ts`, export: "course" });
  assert.deepEqual(read.check, { module: RULES, export: "checkCourse" });
  assert.deepEqual(read.constants.map((entry) => [entry.export, entry.value]), [["SPEAKING_WPM", 140], ["AUDIENCE_WORDS", { target: 60, max: 90 }]]);
  assert.deepEqual(read.customerTerms, { module: TERMS, export: "findCustomerTerms" });
  const showcase = readInvariants(policyOf(SHOWCASE).inProcessInvariants);
  assert.equal(showcase.course, null);
  assert.equal(showcase.check, null);
  assert.deepEqual(showcase.constants, []);
  for (const bad of [null, [], "x", { frozenModules: "x" }, { frozenModules: [1] }, { constants: {} }, { constants: [{ module: "a", export: "b" }] }, { course: { module: "a" } }, { check: { export: "b" } }]) {
    assert.throws(() => readInvariants(bad), /immutableGates\.inProcessInvariants/, JSON.stringify(bad));
  }
});
