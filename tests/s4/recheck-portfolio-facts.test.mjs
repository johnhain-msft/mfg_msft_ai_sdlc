// AC21: tests/s4/recheck-portfolio-facts.mjs re-opens the downstream files that the gates and helpers rely on and compares every literal of the facts F70 to F81. Against the fixture it
// prints one OK line for each and exits 0; any literal that differs is a FAIL line and exit 1 (stop and report BLOCKED); it never writes into the directory that it is given.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, readText, runNode, tempDir, abs } from "./helpers/fixtures.mjs";

const SCRIPT = abs("tests", "s4", "recheck-portfolio-facts.mjs");
const IDS = Array.from({ length: 12 }, (_, index) => `F${70 + index}`);

function copyOfFixture() {
  const dir = path.join(tempDir("sdlc-s4-recheck-"), "portfolio");
  fs.cpSync(fixture("portfolio-min"), dir, { recursive: true });
  return dir;
}
function treeHash(directory) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(directory, full)}\0`).update(fs.readFileSync(full)).update("\0");
    }
  };
  walk(directory);
  return hash.digest("hex");
}
const lines = (result) => result.stdout.split("\n").filter((line) => line !== "");

test("AC21: against the fixture the script exits 0 and prints exactly one OK F<n> line for each of F70 to F81, in order, and writes nothing", () => {
  const dir = copyOfFixture();
  const before = treeHash(dir);
  const result = runNode(SCRIPT, [dir]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), IDS.map((id) => `OK ${id}`));
  assert.equal(treeHash(dir), before, "the checkout is read, never written");
});

const MUTATIONS = [
  ["F70", "experiences/copilot-workshop/content/rules.ts", (text) => text.replace("export const SPEAKING_WPM = 140;", "export const SPEAKING_WPM = 150;")],
  ["F70", "experiences/copilot-workshop/content/rules.ts", (text) => text.replace("perCommand: 8,", "perCommand: 9,")],
  ["F71", "experiences/copilot-workshop/content/rules.ts", (text) => text.replace("add('warn', 'audience-words'", "add('error', 'audience-words'")],
  ["F71", "experiences/copilot-workshop/content/rules.ts", (text) => text.replace("if (need > s.minutes * 60 + PAGE_ROUNDING_SECONDS)", "if (need > s.minutes * 60 + PAGE_ROUNDING_SECONDS + 1)")],
  ["F72", "experiences/copilot-workshop/content/source.ts", (text) => text.replace("/projects/everything-github-copilot/", "/projects/somewhere-else/")],
  ["F73", "experiences/copilot-workshop/content/lab-pace.ts", (text) => text.replace(/^  lab07:.*\n/m, "")],
  ["F73", "experiences/copilot-workshop/content/lab-pace.ts", (text) => text.replace("'lab-hardening': { title: 'Hardening', presenter: 4, selfPaced: 30, workshop: null }", "'lab-hardening': { title: 'Hardening', presenter: 4, selfPaced: 30, workshop: 5 }")],
  ["F74", "experiences/copilot-workshop/build-inputs.ts", (text) => text.replace("'tsconfig.json'", "'tsconfig.base.json'")],
  ["F75", "experiences/copilot-workshop/provenance.json", (text) => text.replace(/"commit": "2108ac9[0-9a-f]+"/, `"commit": "${"1".repeat(40)}"`)],
  ["F75", "experiences/copilot-workshop/source-inputs.json", (text) => text.replace('"hashing": "sha256 over LF-normalised bytes"', '"hashing": "sha1"')],
  ["F76", "tests/copilot-workshop.test.ts", (text) => text.replace('it("keeps audience pages sparse"', "it('keeps audience pages sparse'")],
  ["F77", "tests/pipeline-showcase.test.ts", (text) => text.replace('describe("pipeline-showcase sanitization"', 'describe("pipeline-showcase hygiene"')],
  ["F78", "tests/github-intermediate-workshop.test.ts", (text) => text.replace("it('gives every slide a title and non-empty, original speaker notes',", 'it("gives every slide a title and non-empty, original speaker notes",')],
  ["F78", "tests/github-intermediate-labs.test.ts", (text) => text.replace("Lab 0 HTTPS prompts accept only simulated credentials and do not retain them", "Lab 0 HTTPS prompts accept credentials")],
  ["F79", "tests/support/customer-terms.ts", (text) => text.replace(/^  "[0-9a-f]{64}",\n/m, "")],
  ["F80", "apps/lab-studio/package.json", (text) => text.replace('"drift:accept": "node scripts/check-lab-drift.mjs --accept"', '"drift:accept": "node scripts/check-lab-drift.mjs"')],
  ["F80", "apps/lab-studio/scripts/check-lab-drift.mjs", (text) => text.replace(/latin1/g, "utf8")],
  ["F81", "apps/lab-studio/client/src/labs/source.ts", (text) => text.replace("SOURCE_COMMIT.slice(0, 7)", "SOURCE_COMMIT.slice(0, 8)")],
  ["F81", "apps/lab-studio/server/tests/source.test.ts", (text) => text.replace(/expect\(SOURCE_SHORT_COMMIT\)\.toBe\("[0-9a-f]+"\)/, 'expect(SOURCE_SHORT_COMMIT).toBe("0000000")')],
];

for (const [id, file, mutate] of MUTATIONS) {
  test(`AC21: a literal of ${id} that differs in ${file} is reported as FAIL ${id} with exit 1, and every other fact still reads OK`, () => {
    const dir = copyOfFixture();
    const target = path.join(dir, ...file.split("/"));
    const before = readText(target);
    const after = mutate(before);
    assert.notEqual(after, before, "the mutation changed the file");
    fs.writeFileSync(target, after);
    const result = runNode(SCRIPT, [dir]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const output = lines(result);
    assert.equal(output.length, 12, "one line per fact");
    assert.ok(output.some((line) => line.startsWith(`FAIL ${id}: `)), output.join("\n"));
    assert.ok(output.filter((line) => line.startsWith("OK ")).length >= 10, "the facts that were not touched still pass");
    assert.match(result.stderr, /stop and report BLOCKED/);
  });
}

test("AC21: a file that is missing is a FAIL of the facts that need it, not a crash; a missing argument or a directory that does not exist is a usage error (exit 2)", () => {
  const dir = copyOfFixture();
  fs.rmSync(path.join(dir, "tests", "support", "customer-terms.ts"));
  const result = runNode(SCRIPT, [dir]);
  assert.equal(result.code, 1);
  assert.ok(lines(result).some((line) => line.startsWith("FAIL F79: ") && line.includes("cannot be read")));
  const none = runNode(SCRIPT, []);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /usage: node tests\/s4\/recheck-portfolio-facts\.mjs/);
  assert.equal(none.stdout, "");
  const missing = runNode(SCRIPT, [path.join(dir, "no-such-directory")]);
  assert.equal(missing.code, 2);
  assert.equal(runNode(SCRIPT, [dir, "extra"]).code, 2, "exactly one argument");
});

test("AC21: CRLF line endings and the BOM that a Windows checkout may carry do not change a verdict", () => {
  const dir = copyOfFixture();
  for (const file of ["experiences/copilot-workshop/content/rules.ts", "tests/copilot-workshop.test.ts", "tests/support/customer-terms.ts"]) {
    const target = path.join(dir, ...file.split("/"));
    fs.writeFileSync(target, `\uFEFF${readText(target).replace(/\n/g, "\r\n")}`);
  }
  const result = runNode(SCRIPT, [dir]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), IDS.map((id) => `OK ${id}`));
});
