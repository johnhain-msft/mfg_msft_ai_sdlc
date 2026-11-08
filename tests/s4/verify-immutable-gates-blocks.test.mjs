// AC43-AC47: check (iii) of src/verify-immutable-gates.mjs. The prelude, the describe( headers and the named blocks of the companion test files are byte for byte
// what they were at the base (single- and double-quoted titles alike), and the companion test files and the editable modules add none of the banned constructs.
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTestFile, blockTexts, compareStructure, countConstructs } from "../../src/adaptation/ts-structure.mjs";
import { git } from "./helpers/fixtures.mjs";
import { read, replaceOnce, scenario, shown } from "./helpers/gates.mjs";

const LAB = "cascade-ai-copilot-lab";
const SHOWCASE = "cascade-ai-pipeline-showcase";
const INTERMEDIATE = "cascade-ai-github-intermediate";
const COPILOT_TEST = "tests/copilot-workshop.test.ts";
const SHOWCASE_TEST = "tests/pipeline-showcase.test.ts";
const LABS_TEST = "tests/github-intermediate-labs.test.ts";
const WORKSHOP_TEST = "tests/github-intermediate-workshop.test.ts";
const M1 = "experiences/copilot-workshop/content/m1.ts";

const edit = (relative, from, to) => (dir) => ({ [relative]: replaceOnce(read(dir, relative), from, to) });
const violation = (result, file, pattern) => {
  assert.equal(result.code, 1, shown(result));
  assert.equal(result.json.status, "violation");
  assert.ok(result.json.violatingFiles.includes(file), `${file} in ${JSON.stringify(result.json.violatingFiles)}`);
  if (pattern) assert.match(result.stderr, pattern);
};

const THIRD_BODY = "expect(rules.pageSeconds(slide)).toBeLessThanOrEqual(slide.minutes * 60 + rules.PAGE_ROUNDING_SECONDS);";
const FIRST_BODY = "const findings = rules.checkCourse(course);";

test("AC43/AC44: editing the body of any of the five locked blocks exits 1, including the one whose double-quoted title holds an apostrophe; editing the other tests exits 0", () => {
  const bodies = [
    [FIRST_BODY, "const findings = rules.checkCourse(course).slice(0, 0);"],
    ["expect(rules.mainSpokenWords(slide), slide.id).toBeGreaterThanOrEqual(rules.MIN_SPOKEN_WORDS);", "expect(rules.mainSpokenWords(slide), slide.id).toBeGreaterThanOrEqual(0);"],
    [THIRD_BODY, "expect(rules.pageSeconds(slide)).toBeLessThanOrEqual(1e9);"],
    ["expect(rules.SPEAKING_WPM).toBe(140);", "expect(rules.SPEAKING_WPM).toBeGreaterThan(0);"],
    ["expect(words[words.length - 1]).toBeLessThanOrEqual(rules.AUDIENCE_WORDS.max);", "expect(words.length).toBeGreaterThan(-1);"],
  ];
  for (const [from, to] of bodies) violation(scenario({ mutate: edit(COPILOT_TEST, from, to) }).run(), COPILOT_TEST, /differs from the base/);
  const editable = scenario({ mutate: edit(COPILOT_TEST, "expect(inputs.commit).toBe(provenance.commit);", "expect(inputs.commit).toEqual(provenance.commit);") }).run();
  assert.equal(editable.code, 0, `the other tests of the file stay editable: ${shown(editable)}`);
});

test("AC43: a named block that is missing in the head, and one that is missing in the base, both exit 1", () => {
  const dropped = scenario({
    mutate: (dir) => {
      const text = read(dir, COPILOT_TEST);
      const start = text.indexOf('  it("keeps audience pages sparse"');
      const end = text.indexOf("  });\n", start) + "  });\n".length;
      return { [COPILOT_TEST]: text.slice(0, start) + text.slice(end) };
    },
  }).run();
  violation(dropped, COPILOT_TEST, /keeps audience pages sparse.*missing in the head/);
  const renamedInBase = scenario({ prepare: edit(COPILOT_TEST, '"keeps audience pages sparse"', '"keeps audience pages very sparse"') }).run();
  violation(renamedInBase, COPILOT_TEST, /keeps audience pages sparse.*missing in the base/);
  const renamedInHead = scenario({ mutate: edit(COPILOT_TEST, '"keeps audience pages sparse"', "'keeps audience pages sparse!'") }).run();
  violation(renamedInHead, COPILOT_TEST, /missing in the head/);
});

test("AC43: an edited prelude line, a new import before the first describe(, an edited describe( header and an added describe all exit 1", () => {
  violation(scenario({ mutate: edit(COPILOT_TEST, "const root = process.cwd();", "const root = process.cwd() + '';") }).run(), COPILOT_TEST, /before the first describe\(/);
  violation(scenario({ mutate: edit(COPILOT_TEST, 'import path from "node:path";', 'import path from "node:path";\nimport os from "node:os";') }).run(), COPILOT_TEST, /before the first describe\(/);
  violation(scenario({ mutate: edit(COPILOT_TEST, 'describe("provenance", () => {', 'describe("provenance of the build", () => {') }).run(), COPILOT_TEST, /describe\( header lines differ/);
  violation(scenario({ mutate: (dir) => ({ [COPILOT_TEST]: `${read(dir, COPILOT_TEST)}\ndescribe("an extra group", () => {\n  it("is new", () => {\n    expect(1).toBe(1);\n  });\n});\n` }) }).run(), COPILOT_TEST, /describe\( header lines differ/);
});

test("AC43: a work tree that git has converted to CRLF (core.autocrlf) holds the content of the LF blob and is no violation; a change on top of it is found, and a CRLF blob that is committed is not the base", () => {
  const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
  // the checkout filter of a Windows machine: the blob stays LF, the work tree copy has CRLF, and git itself reports no change
  const checkedOut = scenario({ commit: false, mutate: (dir) => ({ [COPILOT_TEST]: crlf(read(dir, COPILOT_TEST)) }) });
  git(checkedOut.dir, ["config", "core.autocrlf", "true"]);
  assert.equal(git(checkedOut.dir, ["diff", "--name-only", "HEAD"]).stdout.trim(), "", "git sees no change in the converted checkout");
  const clean = checkedOut.run();
  assert.equal(clean.code, 0, shown(clean));
  assert.deepEqual(clean.json, { status: "ok", violatingFiles: [] });
  // an edit of a locked body in such a checkout is still a difference from the base
  const edited = scenario({
    commit: false,
    mutate: (dir) => ({ [COPILOT_TEST]: crlf(replaceOnce(read(dir, COPILOT_TEST), FIRST_BODY, "const findings = rules.checkCourse(course).slice(0, 0);")) }),
  });
  git(edited.dir, ["config", "core.autocrlf", "true"]);
  violation(edited.run(), COPILOT_TEST, /passes every content rule.*differs from the base \(in the work tree\)/);
  // what is committed is compared as it is: a blob that holds CRLF is not the LF blob of the base
  violation(scenario({ mutate: (dir) => ({ [COPILOT_TEST]: crlf(read(dir, COPILOT_TEST)) }) }).run(), COPILOT_TEST, /before the first describe\(/);
});

test("AC43/AC46: the single-quoted titles of the two intermediate workshop blocks are found in the base and the head; editing either body, or the block of the labs file, exits 1", () => {
  assert.equal(scenario({ workflow: INTERMEDIATE }).run().code, 0, "found in both: the single-quoted titles are read");
  violation(scenario({ workflow: INTERMEDIATE, mutate: edit(WORKSHOP_TEST, "for (const day of course.days) expect(day.title.length).toBeGreaterThan(0);", "for (const day of course.days) expect(day).toBeDefined();") }).run(), WORKSHOP_TEST);
  violation(scenario({ workflow: INTERMEDIATE, mutate: edit(WORKSHOP_TEST, "expect(findCustomerTerms(all)).toEqual([]);", "expect(findCustomerTerms('')).toEqual([]);") }).run(), WORKSHOP_TEST);
  violation(scenario({ workflow: INTERMEDIATE, mutate: edit(LABS_TEST, 'expect(run(" git clone ")).toBe("git clone");', 'expect(run(" git clone ")).toBeTruthy();') }).run(), LABS_TEST);
  const free = scenario({ workflow: INTERMEDIATE, mutate: edit(WORKSHOP_TEST, "expect(course.days.length).toBe(3);", "expect(course.days.length).toBeGreaterThan(2);") }).run();
  assert.equal(free.code, 0, shown(free));
});

test("AC45: for the showcase, editing either locked describe body, or the findCustomerTerms import line, exits 1; the unlocked describe stays editable", () => {
  violation(scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, 'expect(readFileSync(svgPath, "utf8")).not.toMatch(/<script/i);', 'expect(readFileSync(svgPath, "utf8")).toBeTruthy();') }).run(), SHOWCASE_TEST, /pipeline-showcase animated SVG/);
  violation(scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, "expect(findCustomerTerms(JSON.stringify(data))).toEqual([]);", "expect(findCustomerTerms('')).toEqual([]);") }).run(), SHOWCASE_TEST, /pipeline-showcase sanitization/);
  const noImport = scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, 'import { findCustomerTerms } from "./support/customer-terms";\n', 'import { findCustomerTerms as scan } from "./support/customer-terms";\n') }).run();
  violation(noImport, SHOWCASE_TEST, /import of findCustomerTerms|before the first describe\(/);
  const free = scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, "expect(Array.isArray(data.runs)).toBe(true);", "expect(Array.isArray(data.runs)).toBeTruthy();") }).run();
  assert.equal(free.code, 0, shown(free));
});

test("AC43: the structure compare reports every difference once and none for an identical file (unit view of what the command decides)", () => {
  const base = `import { describe, it } from "vitest";\nconst a = 1;\ndescribe("g", () => {\n  it("x", () => {\n    run();\n  });\n});\n`;
  const blocks = [{ kind: "it", title: "x" }];
  assert.deepEqual(compareStructure({ baseText: base, headText: base, blocks }), []);
  assert.equal(compareStructure({ baseText: base, headText: base.replace("run();", "run(1);"), blocks }).length, 1);
  assert.equal(compareStructure({ baseText: base, headText: base.replace("const a = 1;", "const a = 2;"), blocks }).length, 1);
  assert.equal(compareStructure({ baseText: base, headText: base.replace('describe("g"', 'describe("h"'), blocks }).length, 1);
  assert.deepEqual(compareStructure({ baseText: base, headText: base.replace("const a = 1;", "const a = 1; // moved"), blocks }).length, 1, "a comment before the first describe is part of the prelude");
  const analysis = analyzeTestFile(`describe("g", () => {\n  it('it\\'s "quoted"', () => {});\n  it(\`template title\`, () => {});\n  // it("in a comment", () => {});\n  const s = 'it("in a string", () => {})';\n});\n`);
  assert.equal(blockTexts(analysis, "it", `it's "quoted"`).length, 1, "escapes in a single-quoted title are decoded");
  assert.equal(blockTexts(analysis, "it", "template title").length, 1);
  assert.equal(blockTexts(analysis, "it", "in a comment").length + blockTexts(analysis, "it", "in a string").length, 0, "comments and strings hold no block");
});

const CONSTRUCTS = [
  ["it.skip", COPILOT_TEST, edit(COPILOT_TEST, 'it("records one revision, and every artefact that names it agrees"', 'it.skip("records one revision, and every artefact that names it agrees"'), /adds \.skip/],
  ["it.only", COPILOT_TEST, edit(COPILOT_TEST, 'it("records one revision, and every artefact that names it agrees"', 'it.only("records one revision, and every artefact that names it agrees"'), /adds \.only/],
  ["it.todo", COPILOT_TEST, (dir) => ({ [COPILOT_TEST]: `${read(dir, COPILOT_TEST)}\nit.todo("later");\n` }), /adds \.todo/],
  ["vi.mock", COPILOT_TEST, (dir) => ({ [COPILOT_TEST]: `${read(dir, COPILOT_TEST)}\nvi.mock("../experiences/copilot-workshop/content/rules");\n` }), /adds vi\.mock/],
  ["Object.assign", M1, (dir) => ({ [M1]: `${read(dir, M1)}\nexport const copy = Object.assign({}, m1);\n` }), /adds Object\.assign/],
  ["Object.defineProperty", M1, (dir) => ({ [M1]: `${read(dir, M1)}\nObject.defineProperty(m1, "id", { value: "x" });\n` }), /adds Object\.defineProperty/],
  ["Reflect.*", M1, (dir) => ({ [M1]: `${read(dir, M1)}\nexport const keys = Reflect.ownKeys(m1);\n` }), /adds Reflect/],
  ["property mutation", COPILOT_TEST, edit(COPILOT_TEST, "expect(inputs.commit).toBe(provenance.commit);", "rules.AUDIENCE_WORDS.max = 100;\n    expect(inputs.commit).toBe(provenance.commit);"), /adds property mutation/],
  ["a new import of the rules module", M1, (dir) => ({ [M1]: `import { LIVE_SECONDS } from './rules';\n${read(dir, M1)}` }), /adds new import of a locked module/],
  ["shadowing of an imported identifier", COPILOT_TEST, edit(COPILOT_TEST, "expect(inputs.commit).toBe(provenance.commit);", "const rules = { commit: inputs.commit };\n    expect(rules.commit).toBe(provenance.commit);"), /adds shadowing/],
];
for (const [name, file, mutate, pattern] of CONSTRUCTS) {
  test(`AC47: adding one occurrence of ${name} exits 1 and names the file`, () => {
    violation(scenario({ mutate }).run(), file, pattern);
  });
}

test("AC47: the identifiers of the sanitiser are protected the same way: a new import of it into an editable module, a mutation of it and a binding of its name all exit 1", () => {
  const modules = "experiences/copilot-workshop/content/index.ts";
  violation(scenario({ mutate: (dir) => ({ [modules]: `import { findCustomerTerms } from '../../../tests/support/customer-terms';\n${read(dir, modules)}` }) }).run(), modules, /new import/);
  violation(scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, "expect(Array.isArray(data.runs)).toBe(true);", "findCustomerTerms.cache = [];\n    expect(Array.isArray(data.runs)).toBe(true);") }).run(), SHOWCASE_TEST, /property mutation/);
  violation(scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, "expect(Array.isArray(data.runs)).toBe(true);", "const findCustomerTerms = () => [];\n    expect(Array.isArray(data.runs)).toBe(true);") }).run(), SHOWCASE_TEST, /shadowing/);
  violation(scenario({ workflow: SHOWCASE, mutate: edit(SHOWCASE_TEST, "expect(Array.isArray(data.runs)).toBe(true);", "expect([1].map((findCustomerTerms) => findCustomerTerms)).toEqual([1]);") }).run(), SHOWCASE_TEST, /shadowing/);
});

test("AC47: moving the existing it.skipIf line is not a violation (it.skipIf is not .skip), and neither are comments, strings and a construct that the base already had", () => {
  const moved = scenario({
    mutate: (dir) => {
      const text = read(dir, COPILOT_TEST);
      const start = text.indexOf("  it.skipIf(!process.env.WORKSHOP_SOURCE)");
      const end = text.indexOf("  });\n", start) + "  });\n".length;
      const call = text.slice(start, end);
      const without = text.slice(0, start) + text.slice(end);
      // the call moves into the describe that ends right before the one it came from
      const closing = without.lastIndexOf("});\n", without.indexOf('describe("the retired importer and the source check"'));
      return { [COPILOT_TEST]: without.slice(0, closing) + call + without.slice(closing) };
    },
  }).run();
  assert.equal(moved.code, 0, shown(moved));
  const harmless = scenario({ mutate: (dir) => ({ [M1]: `${read(dir, M1)}\n// Object.assign and it.skip and Reflect.get in a comment\nexport const note = "vi.mock Object.defineProperty .only";\n` }) }).run();
  assert.equal(harmless.code, 0, shown(harmless));
  const preexisting = scenario({
    prepare: (dir) => ({ [M1]: `${read(dir, M1)}\nexport const copy = Object.assign({}, m1);\n` }),
    mutate: (dir) => ({ [M1]: read(dir, M1).replace("'Extensibility'", "'Extensibility again'") }),
  }).run();
  assert.equal(preexisting.code, 0, `a count that does not grow is not an added occurrence: ${shown(preexisting)}`);
  const more = scenario({
    prepare: (dir) => ({ [M1]: `${read(dir, M1)}\nexport const copy = Object.assign({}, m1);\n` }),
    mutate: (dir) => ({ [M1]: `${read(dir, M1)}\nexport const second = Object.assign({}, m1);\n` }),
  }).run();
  violation(more, M1, /adds Object\.assign \(1 at .*, 2 in HEAD\)/);
});

test("AC47: the counts are taken from tokens: an uncommitted edit that adds a construct in the work tree is caught as well", () => {
  const result = scenario({ mutate: (dir) => ({ [M1]: `${read(dir, M1)}\nexport const copy = Object.assign({}, m1);\n` }), commit: false }).run();
  violation(result, M1, /adds Object\.assign/);
  const counts = countConstructs("it.skip(1); a['only'](); vi.doMock('x'); Reflect.get(a, 'b'); Object['assign'](a);", { filePath: "x.ts", lockedModules: [] });
  assert.deepEqual([counts[".skip"], counts[".only"], counts["vi.mock"], counts.Reflect, counts["Object.assign"]], [1, 1, 1, 1, 1]);
});
