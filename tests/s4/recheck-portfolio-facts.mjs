#!/usr/bin/env node
// The opt-in recheck of the portfolio facts F70-F81 of SPEC-04 (AC21).
//
//   node tests/s4/recheck-portfolio-facts.mjs "<portfolio-checkout-or-fixture>"
//
// Before an implementation depends on the downstream files that the gates and the helpers rely on, this script re-opens them and compares every literal that
// the spec records: the rule constants and check codes, the source module, the lab pace table, the build inputs, the two provenance files, the named tests and
// quote styles of the three companion test files, the customer-term sanitiser, the two Studio drift scripts and the Studio pin forms. It prints one line per
// fact, `OK F<n>` or `FAIL F<n>: <what differs>`, and it only reads: nothing under the directory that it is given is written.
//
//   exit 0  every fact F70 to F81 holds     exit 1  at least one differs (stop and report BLOCKED)     exit 2  the directory cannot be read
//
// The recorded revision below is the one that the facts name; a downstream checkout that has moved on differs from them on purpose, and that is the signal.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECORDED_COMMIT = "2108ac9a1e9eff96e97b500117b0de4a546768c3";
const RECORDED_REPOSITORY = "https://github.com/ms-mfg-community/day-in-the-life-copilot-lab";

const RULES = "experiences/copilot-workshop/content/rules.ts";
const SOURCE = "experiences/copilot-workshop/content/source.ts";
const PACE = "experiences/copilot-workshop/content/lab-pace.ts";
const BUILD_INPUTS = "experiences/copilot-workshop/build-inputs.ts";
const PROVENANCE = "experiences/copilot-workshop/provenance.json";
const SOURCE_INPUTS = "experiences/copilot-workshop/source-inputs.json";
const WORKSHOP_TEST = "tests/copilot-workshop.test.ts";
const SHOWCASE_TEST = "tests/pipeline-showcase.test.ts";
const LABS_TEST = "tests/github-intermediate-labs.test.ts";
const INTERMEDIATE_TEST = "tests/github-intermediate-workshop.test.ts";
const TERMS = "tests/support/customer-terms.ts";
const STUDIO_PACKAGE = "apps/lab-studio/package.json";
const STUDIO_DRIFT = "apps/lab-studio/scripts/check-lab-drift.mjs";
const STUDIO_SOURCE = "apps/lab-studio/client/src/labs/source.ts";
const STUDIO_SOURCE_TEST = "apps/lab-studio/server/tests/source.test.ts";

/** A read of the checkout that never throws: a file that is missing is a problem of the fact that needs it. */
function reader(root) {
  const cache = new Map();
  return (relative) => {
    if (!cache.has(relative)) {
      const file = path.join(root, ...relative.split("/"));
      let text = null;
      try {
        text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      } catch {
        text = null;
      }
      cache.set(relative, text);
    }
    return cache.get(relative);
  };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A regular expression of the literal pieces, with any run of white space (and none) allowed between them, and line comments too: a comment is not a literal. */
const GAP = String.raw`(?:\s|\/\/[^\n]*(?:\n|$))*`;
const spaced = (...pieces) => new RegExp(pieces.map((piece) => (piece instanceof RegExp ? piece.source : escape(piece))).join(GAP));
const QUOTE = /['"]/;
const q = (text) => new RegExp(`['"]${escape(text)}['"]`);

/** @returns {(text: string | null, file: string) => { expect: (label: string, test: string | RegExp | ((text: string) => boolean)) => void, problems: string[] }} */
function checker(file, text) {
  const problems = [];
  return {
    problems,
    expect(label, test) {
      if (text === null) {
        if (!problems.some((problem) => problem.startsWith(`${file} cannot be read`))) problems.push(`${file} cannot be read`);
        return;
      }
      const holds = typeof test === "string" ? text.includes(test) : test instanceof RegExp ? test.test(text) : test(text);
      if (!holds) problems.push(`${file}: ${label}`);
    },
  };
}

/** The text of the object literal that a declaration opens, or null. */
function objectLiteral(text, declaration) {
  const start = text.search(declaration);
  if (start === -1) return null;
  const open = text.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && (depth -= 1) === 0) return text.slice(open + 1, index);
  }
  return null;
}

/** The numbers of `key: number` members of an object literal, in order. */
function numberMembers(body) {
  return [...body.matchAll(/(?:^|[,\s{])([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)/g)].map((match) => [match[1], Number(match[2])]);
}

/** The text of the `it(...)` (or `it.skipIf(...)(...)`) block that opens with the title, up to the next block at the same indentation. */
function blockOf(text, openers) {
  for (const opener of openers) {
    const start = text.indexOf(opener);
    if (start === -1) continue;
    const next = text.slice(start + opener.length).search(/\n\s*(?:it|describe)(?:\.\w+)?(?:\([^)]*\))?\(/);
    return next === -1 ? text.slice(start) : text.slice(start, start + opener.length + next);
  }
  return null;
}

const FACTS = [
  ["F70", (read) => {
    const rules = checker(RULES, read(RULES));
    rules.expect("imports { DOCUMENT_COMMIT } from './source'", spaced("import", "{", "DOCUMENT_COMMIT", "}", "from", QUOTE, "./source", QUOTE));
    rules.expect("imports its types from './types'", spaced("from", QUOTE, "./types", QUOTE));
    rules.expect("AUDIENCE_WORDS = { target: 60, max: 90 }", spaced("export const AUDIENCE_WORDS =", "{", "target:", "60,", "max:", "90", "}"));
    rules.expect("SPEAKING_WPM = 140", spaced("export const SPEAKING_WPM =", "140;"));
    rules.expect("SPEECH_WPM = { min: 55, max: SPEAKING_WPM }", spaced("export const SPEECH_WPM =", "{", "min:", "55,", "max:", "SPEAKING_WPM", "}"));
    rules.expect("MIN_OCCUPANCY = SPEECH_WPM.min / SPEAKING_WPM", spaced("export const MIN_OCCUPANCY =", "SPEECH_WPM.min", "/", "SPEAKING_WPM;"));
    rules.expect("PAGE_ROUNDING_SECONDS = 15", spaced("export const PAGE_ROUNDING_SECONDS =", "15;"));
    rules.expect("MIN_SPOKEN_WORDS = 25", spaced("export const MIN_SPOKEN_WORDS =", "25;"));
    rules.expect("MAX_PARAGRAPH_WORDS = 130", spaced("export const MAX_PARAGRAPH_WORDS =", "130;"));
    rules.expect("MAX_LIFT = 0.15", spaced("export const MAX_LIFT =", "0.15;"));
    const text = read(RULES);
    const live = text === null ? null : objectLiteral(text, /export const LIVE_SECONDS\s*=/);
    const wanted = [["perCommand", 8], ["runMin", 10], ["wait", 15], ["ask", 10], ["switch", 5], ["click", 3], ["show", 2], ["point", 2]];
    if (text !== null && (live === null || JSON.stringify(numberMembers(live)) !== JSON.stringify(wanted))) {
      rules.problems.push(`${RULES}: LIVE_SECONDS is not ${wanted.map(([key, value]) => `${key}: ${value}`).join(", ")} (found ${live === null ? "no declaration" : JSON.stringify(numberMembers(live))})`);
    }
    return rules.problems;
  }],
  ["F71", (read) => {
    const rules = checker(RULES, read(RULES));
    rules.expect("an error 'audience-words' above AUDIENCE_WORDS.max", spaced("aw", ">", "AUDIENCE_WORDS.max", ")", "add(", "'error',", "'audience-words'"));
    rules.expect("a warn 'audience-words' in an else-if above AUDIENCE_WORDS.target", spaced("else if", "(", "aw", ">", "AUDIENCE_WORDS.target", ")", "add(", "'warn',", "'audience-words'"));
    rules.expect("an error 'lead-length' for a lead over 25 words", spaced("wordCount(s.lead)", ">", "25", ")", "add(", "'error',", "'lead-length'"));
    rules.expect("an error 'pace' above s.minutes * 60 + PAGE_ROUNDING_SECONDS", spaced("if (need", ">", "s.minutes", "*", "60", "+", "PAGE_ROUNDING_SECONDS", ")", "{", "add(", "'error',", "'pace'"));
    rules.expect("maxSpeechWords is Math.floor(s.minutes * SPEAKING_WPM + 1e-9)", spaced("maxSpeechWords", "=", "(s: Slide): number", "=>", "Math.floor(s.minutes", "*", "SPEAKING_WPM", "+", "1e-9)"));
    rules.expect("an else-if error 'pace-speech' when main > maxSpeechWords(s)", spaced("else if", "(", "main", ">", "maxSpeechWords(s)", ")", "{", "add(", "'error',", "'pace-speech'"));
    rules.expect(
      "an else-if warn 'pace' when main >= MIN_SPOKEN_WORDS && need < MIN_OCCUPANCY * s.minutes * 60 && !roomTime",
      spaced("else if", "(", "main", ">=", "MIN_SPOKEN_WORDS", "&&", "need", "<", "MIN_OCCUPANCY", "*", "s.minutes", "*", "60", "&&", "!roomTime", ")", "{", "add(", "'warn',", "'pace'"),
    );
    rules.expect(
      "roomTime is an interlude that has a wait cue",
      spaced("roomTime", "=", "mod.kind", "===", "'interlude'", "&&", "s.script.some(", "(b)", "=>", "b.t", "===", "'cue'", "&&", "b.kind", "===", "'wait')"),
    );
    rules.expect("an error 'module-pace' above mod.minutes * 60 + 0.5", spaced("delivery", ">", "mod.minutes", "*", "60", "+", "0.5", ")", "add(", "'error',", "'module-pace'"));
    return rules.problems;
  }],
  ["F72", (read) => {
    const source = checker(SOURCE, read(SOURCE));
    source.expect("imports provenance from '../provenance.json'", spaced("import provenance from", QUOTE, "../provenance.json", QUOTE));
    source.expect("REPOSITORY: string = provenance.repository", spaced("export const REPOSITORY: string =", "provenance.repository"));
    source.expect("DOCUMENT_COMMIT: string = provenance.documentCommit", spaced("export const DOCUMENT_COMMIT: string =", "provenance.documentCommit"));
    source.expect("sourceUrl(path, anchor)", spaced("export const sourceUrl =", "(path: string,", "anchor?: string)"));
    source.expect("treeUrl(path)", spaced("export const treeUrl =", "(path: string)"));
    source.expect("PROJECT_PAGE = '/projects/everything-github-copilot/'", spaced("export const PROJECT_PAGE =", QUOTE, "/projects/everything-github-copilot/", QUOTE));
    return source.problems;
  }],
  ["F73", (read) => {
    const pace = checker(PACE, read(PACE));
    pace.expect("the header names the pace: front matter of labs/<id>.md", "`pace:` front matter of labs/<id>.md");
    pace.expect("the header names the workshop pace of the registry (hosted labs only)", /workshop\s+<- `pace_workshop_minutes` in docs\/_meta\/registry\.yaml \(hosted labs only\)/);
    pace.expect("the header gives the regenerate command", "npm run sync:workshop-source -- <path to a clean checkout of the pinned revision>");
    const text = read(PACE);
    if (text !== null) {
      const body = objectLiteral(text, /export const labPace\b/);
      const entries = body === null ? [] : [...body.matchAll(/^\s*(?:'([^']+)'|(lab\d+)):\s*\{([^}\n]*)\}/gm)].map((match) => ({ key: match[1] ?? match[2], fields: match[3] }));
      const keys = entries.map((entry) => entry.key);
      const expected = [...Array.from({ length: 20 }, (_, index) => `lab${String(index + 1).padStart(2, "0")}`), "lab-gh-extensions", "lab-copilot-cli-extensions", "lab-hardening"];
      if (JSON.stringify(keys) !== JSON.stringify(expected)) pace.problems.push(`${PACE}: labPace has ${keys.length} entries (${keys.join(", ")}), not the 23 lab01 to lab20, lab-gh-extensions, lab-copilot-cli-extensions, lab-hardening`);
      const nulls = entries.filter((entry) => /workshop:\s*null\b/.test(entry.fields)).map((entry) => entry.key);
      if (JSON.stringify(nulls) !== JSON.stringify(expected.slice(20))) pace.problems.push(`${PACE}: the entries whose workshop is null are ${nulls.join(", ") || "none"}, not the three source-only labs`);
    }
    return pace.problems;
  }],
  ["F74", (read) => {
    const inputs = checker(BUILD_INPUTS, read(BUILD_INPUTS));
    inputs.expect(
      "INPUTS is the nine build inputs",
      spaced("const INPUTS =", "[", "'content',", "'src',", "'public',", "'index.html',", "'provenance.json',", "'source-inputs.json',", "'build-inputs.ts',", "'vite.config.ts',", "'tsconfig.json'", "]"),
    );
    inputs.expect("exports hashBuildInputs(root)", spaced("export function hashBuildInputs(root: string)"));
    inputs.expect("hashes with SHA-256", spaced("createHash(", "'sha256')"));
    inputs.expect("sorts the relative file names", ".sort()");
    inputs.expect("normalises line endings to LF", /\.replace\(\/\\r\\n\/g,\s*'\\n'\)/);
    return inputs.problems;
  }],
  ["F75", (read) => {
    const problems = [];
    const json = (file) => {
      const text = read(file);
      if (text === null) return problems.push(`${file} cannot be read`), null;
      try {
        return JSON.parse(text);
      } catch {
        return problems.push(`${file} is not JSON`), null;
      }
    };
    const provenance = json(PROVENANCE);
    const inputs = json(SOURCE_INPUTS);
    const same = (file, document, member, value) => {
      if (document !== null && document[member] !== value) problems.push(`${file}: ${member} is ${JSON.stringify(document[member])}, not ${JSON.stringify(value)}`);
    };
    for (const [member, value] of [["repository", RECORDED_REPOSITORY], ["commit", RECORDED_COMMIT], ["documentCommit", RECORDED_COMMIT], ["path", "experiences/copilot-workshop"], ["build", "npm run build:experiences"], ["license", "MIT"], ["inputs", SOURCE_INPUTS]]) {
      same(PROVENANCE, provenance, member, value);
    }
    same(SOURCE_INPUTS, inputs, "repository", RECORDED_REPOSITORY);
    same(SOURCE_INPUTS, inputs, "commit", RECORDED_COMMIT);
    same(SOURCE_INPUTS, inputs, "hashing", "sha256 over LF-normalised bytes");
    if (inputs !== null) {
      for (const key of [".github/agents/*.agent.md", ".github/skills/", ".github/workflows/"]) {
        if (inputs.files === null || typeof inputs.files !== "object" || !Object.hasOwn(inputs.files, key)) problems.push(`${SOURCE_INPUTS}: files has no ${key}`);
      }
    }
    return problems;
  }],
  ["F76", (read) => {
    const test = checker(WORKSHOP_TEST, read(WORKSHOP_TEST));
    const titles = [
      "passes every content rule: no errors and no warnings",
      "gives every teaching page a literal script, not notes",
      "can be delivered in the minutes the plan gives it: speech at the app's own rate plus the live cues, on every page and in every module",
      "plans with one speaking rate: the pace band tops out at it, and the speaker view reads it from the rules instead of typing its own",
      "keeps audience pages sparse",
      "records one revision, and every artefact that names it agrees",
    ];
    for (const title of titles) test.expect(`it("${title}", ...) with double-quoted title`, `it(${JSON.stringify(title)},`);
    test.expect(
      'it.skipIf(!process.env.WORKSHOP_SOURCE)("finds the content in sync with an export of the pinned revision (set WORKSHOP_SOURCE)", ...)',
      'it.skipIf(!process.env.WORKSHOP_SOURCE)("finds the content in sync with an export of the pinned revision (set WORKSHOP_SOURCE)",',
    );
    const text = read(WORKSHOP_TEST);
    if (text !== null) {
      const first = blockOf(text, [`it(${JSON.stringify(titles[0])},`]);
      if (first === null || !/rules\.checkCourse\(course\)/.test(first) || !/toEqual\(\[\]\)/.test(first)) {
        test.problems.push(`${WORKSHOP_TEST}: the first block does not require rules.checkCourse(course) to equal an empty list`);
      }
      const revision = blockOf(text, [`it(${JSON.stringify(titles[5])},`]);
      for (const part of ["provenance.json", "source-inputs.json", "DOCUMENT_COMMIT", "source.json"]) {
        if (revision === null || !revision.includes(part)) test.problems.push(`${WORKSHOP_TEST}: the revision block does not check ${part}`);
      }
    }
    return test.problems;
  }],
  ["F77", (read) => {
    const test = checker(SHOWCASE_TEST, read(SHOWCASE_TEST));
    test.expect('imports { findCustomerTerms } from "./support/customer-terms"', spaced("import", "{", "findCustomerTerms", "}", "from", '"./support/customer-terms"'));
    test.expect('describe("pipeline-showcase animated SVG", ...)', 'describe("pipeline-showcase animated SVG",');
    test.expect('describe("pipeline-showcase sanitization", ...)', 'describe("pipeline-showcase sanitization",');
    const text = read(SHOWCASE_TEST);
    if (text !== null) {
      const start = text.indexOf('describe("pipeline-showcase sanitization",');
      const end = start === -1 ? -1 : text.indexOf("\ndescribe(", start + 1);
      const block = start === -1 ? "" : text.slice(start, end === -1 ? undefined : end);
      for (const [label, pattern] of [["a call of findCustomerTerms", /findCustomerTerms\(/], ["manual-setup-and-test", /manual-setup-and-test/], ["a pattern for emails", /@/], ["a pattern for UUIDs", /uuid/i], ["a pattern for tokens", /token/i]]) {
        if (!pattern.test(block)) test.problems.push(`${SHOWCASE_TEST}: the sanitization block has no ${label}`);
      }
    }
    return test.problems;
  }],
  ["F78", (read) => {
    const labs = checker(LABS_TEST, read(LABS_TEST));
    labs.expect('it("Lab 0 HTTPS prompts accept only simulated credentials and do not retain them", ...)', 'it("Lab 0 HTTPS prompts accept only simulated credentials and do not retain them",');
    const workshop = checker(INTERMEDIATE_TEST, read(INTERMEDIATE_TEST));
    workshop.expect("it('gives every slide a title and non-empty, original speaker notes', ...)", "it('gives every slide a title and non-empty, original speaker notes',");
    workshop.expect("it('contains no customer names, private framing, personal paths or real emails', ...)", "it('contains no customer names, private framing, personal paths or real emails',");
    workshop.expect("imports findCustomerTerms from './support/customer-terms'", spaced("import", "{", "findCustomerTerms", "}", "from", "'./support/customer-terms'"));
    const text = read(INTERMEDIATE_TEST);
    if (text !== null) {
      const block = blockOf(text, ["it('contains no customer names, private framing, personal paths or real emails',"]);
      if (block === null || !/findCustomerTerms\(all\)/.test(block)) workshop.problems.push(`${INTERMEDIATE_TEST}: the sanitising block does not call findCustomerTerms(all)`);
    }
    return [...labs.problems, ...workshop.problems];
  }],
  ["F79", (read) => {
    const terms = checker(TERMS, read(TERMS));
    const text = read(TERMS);
    if (text !== null) {
      const digests = text.match(/["'][0-9a-f]{64}["']/g) ?? [];
      if (digests.length !== 26) terms.problems.push(`${TERMS}: DIGESTS holds ${digests.length} SHA-256 digests, not 26`);
    }
    terms.expect("DIGESTS is a Set", /DIGESTS\s*=\s*new Set\(/);
    terms.expect("exports findCustomerTerms(text: string): string[]", spaced("export function findCustomerTerms(text: string):", "string[]"));
    terms.expect("lower-cases the text into alphanumeric words", /toLowerCase\(\)\.match\(\/\[a-z0-9\]\+\/g\)/);
    terms.expect("looks at phrases of one to three words", spaced("n = 1;", "n <= 3"));
    terms.expect("hashes a phrase with SHA-256 as hex", /createHash\(["']sha256["']\)\.update\(\w+\)\.digest\(["']hex["']\)/);
    return terms.problems;
  }],
  ["F80", (read) => {
    const problems = [];
    const text = read(STUDIO_PACKAGE);
    if (text === null) problems.push(`${STUDIO_PACKAGE} cannot be read`);
    else {
      let scripts = null;
      try {
        scripts = JSON.parse(text).scripts ?? null;
      } catch {
        problems.push(`${STUDIO_PACKAGE} is not JSON`);
      }
      if (scripts !== null) {
        if (scripts.drift !== "node scripts/check-lab-drift.mjs") problems.push(`${STUDIO_PACKAGE}: drift is ${JSON.stringify(scripts.drift)}`);
        if (scripts["drift:accept"] !== "node scripts/check-lab-drift.mjs --accept") problems.push(`${STUDIO_PACKAGE}: drift:accept is ${JSON.stringify(scripts["drift:accept"])}`);
      }
    }
    const script = checker(STUDIO_DRIFT, read(STUDIO_DRIFT));
    script.expect('the digest reads latin1 text and normalises CRLF: readFileSync(path).toString("latin1").replace(/\\r\\n/g, "\\n")', /readFileSync\([^)]*\)\.toString\(["']latin1["']\)\.replace\(\/\\r\\n\/g,\s*["']\\n["']\)/);
    script.expect("the digest is SHA-256", /createHash\(["']sha256["']\)/);
    script.expect("the digest is its first 16 hex characters", /\.slice\(0,\s*16\)/);
    script.expect("the manifest is lab-sources.json", "lab-sources.json");
    script.expect("the sources are labs/labNN.md", /labs\/lab\$\{|labs\/lab/);
    script.expect("--accept writes the manifest", "--accept");
    return [...problems, ...script.problems];
  }],
  ["F81", (read) => {
    const source = checker(STUDIO_SOURCE, read(STUDIO_SOURCE));
    source.expect('SOURCE_REPOSITORY = "ms-mfg-community/day-in-the-life-copilot-lab"', spaced("export const SOURCE_REPOSITORY =", '"ms-mfg-community/day-in-the-life-copilot-lab";'));
    source.expect(`SOURCE_COMMIT = "${RECORDED_COMMIT}"`, spaced("export const SOURCE_COMMIT =", `"${RECORDED_COMMIT}";`));
    source.expect("SOURCE_SHORT_COMMIT = SOURCE_COMMIT.slice(0, 7)", spaced("export const SOURCE_SHORT_COMMIT =", "SOURCE_COMMIT.slice(0,", "7);"));
    const test = checker(STUDIO_SOURCE_TEST, read(STUDIO_SOURCE_TEST));
    test.expect(`expect(SOURCE_COMMIT).toBe("${RECORDED_COMMIT}")`, spaced("expect(SOURCE_COMMIT).toBe(", `"${RECORDED_COMMIT}")`));
    test.expect("expect(manifest._provenance.commit).toBe(SOURCE_COMMIT)", spaced("expect(manifest._provenance.commit).toBe(", "SOURCE_COMMIT)"));
    test.expect(`expect(SOURCE_SHORT_COMMIT).toBe("${RECORDED_COMMIT.slice(0, 7)}")`, spaced("expect(SOURCE_SHORT_COMMIT).toBe(", `"${RECORDED_COMMIT.slice(0, 7)}")`));
    return [...source.problems, ...test.problems];
  }],
];

/**
 * @param {string} root the portfolio checkout or fixture
 * @returns {{ id: string, ok: boolean, problems: string[] }[]} one result per fact, F70 to F81
 */
export function recheck(root) {
  const read = reader(root);
  return FACTS.map(([id, check]) => {
    const problems = check(read);
    return { id, ok: problems.length === 0, problems };
  });
}

function main(argv) {
  const [directory, ...rest] = argv;
  if (directory === undefined || directory === "" || rest.length > 0) {
    process.stderr.write('usage: node tests/s4/recheck-portfolio-facts.mjs "<portfolio-checkout-or-fixture>"\n');
    return 2;
  }
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`recheck-portfolio-facts: not a directory: ${root}\n`);
    return 2;
  }
  let failed = 0;
  for (const { id, ok, problems } of recheck(root)) {
    if (ok) {
      process.stdout.write(`OK ${id}\n`);
      continue;
    }
    failed += 1;
    process.stdout.write(`FAIL ${id}: ${problems.join("; ")}\n`);
  }
  if (failed > 0) process.stderr.write(`recheck-portfolio-facts: ${failed} of ${FACTS.length} facts differ from the spec: stop and report BLOCKED\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
