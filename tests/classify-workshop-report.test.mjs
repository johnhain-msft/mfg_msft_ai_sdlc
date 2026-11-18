// The classifier of the workshop source check (design E2): the verdicts that the router used to reach by reading the report itself (SPEC-03 AC20), now reached by
// this script, which the router runs right after the check. Every case of the old table of tests/s3/preflight-classification is here, as an input and an exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { abs } from "./helpers/instance.mjs";
import { classify, parseWorkshopReport, ReportError, run } from "../scripts/classify-workshop-report.mjs";

const CLEAN_REPORT = "Source revision: abc\nInputs checked: 25; changed 0, new 0, gone 0\nThe content matches the inputs.\n";
const CHANGED_REPORT = "Source revision: abc\nInputs checked: 25; changed 2, new 0, gone 1\n changed: labs/lab03.md -> re-read M3\nThe content was written against different inputs.\n";
const PROBLEM_REPORT = "Source revision: abc\nInputs checked: 25; changed 0, new 0, gone 0\n PROBLEM anchor: lab07 cites a heading that is gone\n";
const COMMAND = "npm run sync:workshop-source -- <checkout>";

const SCRIPT = abs("scripts", "classify-workshop-report.mjs");

/** A directory for the files that the router writes for a classifier (the two streams of the check), removed when the test ends. */
function streams(t, { stdout, stderr = "" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-classify-workshop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "check-0.stdout");
  const err = path.join(dir, "check-0.stderr");
  fs.writeFileSync(out, stdout);
  fs.writeFileSync(err, stderr);
  return { SDLC_PREFLIGHT_STDOUT_FILE: out, SDLC_PREFLIGHT_STDERR_FILE: err, SDLC_PREFLIGHT_INDEX: "0", SDLC_PREFLIGHT_COMMAND: COMMAND };
}

/** Runs the classifier in process, the way the router starts it, and returns what it exited with and printed. */
async function verdict(t, { stdout, exitCode, stderr }) {
  const env = { ...streams(t, { stdout, stderr }), SDLC_PREFLIGHT_EXIT_CODE: String(exitCode) };
  let out = "";
  let err = "";
  const code = await run([], { env, stdout: (text) => (out += text), stderr: (text) => (err += text) });
  return { code, out, err };
}

// ---- the reader ---------------------------------------------------------------------------------------------------------------------------

test("AC20 parseWorkshopReport reads the summary line and the PROBLEM lines of the printed report, and refuses a report without the summary", () => {
  assert.deepEqual(parseWorkshopReport(CLEAN_REPORT), { checked: 25, changed: 0, added: 0, removed: 0, problems: [] });
  assert.deepEqual(parseWorkshopReport(CHANGED_REPORT), { checked: 25, changed: 2, added: 0, removed: 1, problems: [] });
  assert.deepEqual(parseWorkshopReport(PROBLEM_REPORT).problems, ["anchor: lab07 cites a heading that is gone"]);
  assert.deepEqual(parseWorkshopReport("Inputs checked: 3; changed 1, new 2, gone 3\r\n PROBLEM missing: a\r\n PROBLEM licence: b\r\n"), {
    checked: 3,
    changed: 1,
    added: 2,
    removed: 3,
    problems: ["missing: a", "licence: b"],
  });
  for (const text of ["", "Source revision: abc\n", "Inputs checked: 5; changed 0, new 0\n", "inputs checked: 5; changed 0, new 0, gone 0\n", "  Inputs checked: 5; changed 0, new 0, gone 0\n", `${CLEAN_REPORT}${CLEAN_REPORT}`]) {
    assert.throws(() => parseWorkshopReport(text), ReportError, JSON.stringify(text));
  }
});

test("classify names what it found, and the exit code of the check alone decides nothing", () => {
  assert.deepEqual(classify({ exitCode: 1, stdout: CLEAN_REPORT, command: COMMAND }), { drift: false, summary: "workshop source check: 25 inputs, changed 0, new 0, gone 0, 0 problems (exit 1)" });
  assert.deepEqual(classify({ exitCode: 0, stdout: CHANGED_REPORT, command: COMMAND }), { drift: true, summary: "workshop source check: 25 inputs, changed 2, new 0, gone 1, 0 problems (exit 0)" });
  assert.throws(() => classify({ exitCode: 2, stdout: CLEAN_REPORT, command: COMMAND }), (error) => error instanceof ReportError && error.message.startsWith(`'${COMMAND}' exited with 2`));
});

// ---- the verdicts: 0 no drift, 1 drift, 2 a report that cannot be judged ------------------------------------------------------------------------

test("AC20 rc1 equal to 1 with changed 0, new 0, gone 0 is no drift: sync:workshop-source exits 1 whenever the commit differs", async (t) => {
  for (const exitCode of [1, 0]) {
    const { code, out } = await verdict(t, { stdout: CLEAN_REPORT, exitCode });
    assert.equal(code, 0, `exit ${exitCode}`);
    assert.match(out, /no drift|changed 0, new 0, gone 0/);
  }
});

test("AC20 a report that names changed, new or gone inputs, or a PROBLEM, is drift whatever the exit status says", async (t) => {
  for (const [report, exitCode] of [
    [CHANGED_REPORT, 1],
    [CHANGED_REPORT, 0],
    [PROBLEM_REPORT, 1],
    [PROBLEM_REPORT, 0],
    ["Inputs checked: 5; changed 0, new 1, gone 0\n", 1],
    ["Inputs checked: 5; changed 0, new 0, gone 2\n", 1],
    ["Inputs checked: 5; changed 1, new 0, gone 0\n", 0],
  ]) {
    const { code } = await verdict(t, { stdout: report, exitCode });
    assert.equal(code, 1, `${JSON.stringify(report)} (exit ${exitCode})`);
  }
});

test("AC20 a PROBLEM line is a line of its own: text that merely contains the word is not one", async (t) => {
  const prose = "Inputs checked: 3; changed 0, new 0, gone 0\nNo PROBLEM found, nothing to re-read\n  a PROBLEM mentioned in prose\n";
  assert.equal((await verdict(t, { stdout: prose, exitCode: 1 })).code, 0);
});

test("AC20 the verdict is 2 when the summary line is absent or ambiguous, or the command exited abnormally: never a drift, never a clean result", async (t) => {
  const cases = [
    ["no summary line", "Source revision: abc\nsomething else\n", 1],
    ["no output", "", 0],
    ["two summaries", `${CLEAN_REPORT}${CLEAN_REPORT}`, 1],
    ["garbled summary", "Inputs checked: many; changed none\n", 1],
    ["exit 127", CLEAN_REPORT, 127],
    ["exit 2", CLEAN_REPORT, 2],
    ["exit 137", CHANGED_REPORT, 137],
  ];
  for (const [label, stdout, exitCode] of cases) {
    const { code, out, err } = await verdict(t, { stdout, exitCode, stderr: "boom\n" });
    assert.equal(code, 2, label);
    assert.equal(out, "", `${label}: nothing is claimed on standard output`);
    assert.match(err, /^classify-workshop-report: /, label);
  }
  const abnormal = await verdict(t, { stdout: CLEAN_REPORT, exitCode: 127, stderr: "npm: command not found\n" });
  assert.match(abnormal.err, /exited with 127: npm: command not found/, "the tail of the check's own error is carried into the message");
});

test("the classifier refuses to guess when the router did not set its variables, or the report cannot be read", async (t) => {
  for (const env of [{}, { SDLC_PREFLIGHT_STDOUT_FILE: "x" }, { SDLC_PREFLIGHT_EXIT_CODE: "1" }, { ...streams(t, { stdout: CLEAN_REPORT }), SDLC_PREFLIGHT_EXIT_CODE: "soon" }, { SDLC_PREFLIGHT_STDOUT_FILE: path.join(os.tmpdir(), "sdlc-no-such-report.stdout"), SDLC_PREFLIGHT_EXIT_CODE: "1" }]) {
    let err = "";
    const code = await run([], { env, stdout: () => {}, stderr: (text) => (err += text) });
    assert.equal(code, 2, JSON.stringify(env));
    assert.match(err, /classify-workshop-report: /);
  }
});

test("AC20 a crash of the classifier itself is a 2, not node's own exit code 1, which the router would read as a drift", async (t) => {
  const env = { ...streams(t, { stdout: CLEAN_REPORT }), SDLC_PREFLIGHT_EXIT_CODE: "1" };
  let err = "";
  const code = await run([], {
    env,
    stdout: () => {
      throw new TypeError("standard output is closed");
    },
    stderr: (text) => (err += text),
  });
  assert.equal(code, 2);
  assert.match(err, /classify-workshop-report: TypeError: standard output is closed/);
});

// ---- as the router starts it: a process with the variables in its environment ---------------------------------------------------------------------

test("started as a command, the script imports the engine's public API and exits with the verdict", (t) => {
  const cases = [
    [CLEAN_REPORT, 1, 0],
    [CHANGED_REPORT, 1, 1],
    ["no report\n", 1, 2],
  ];
  for (const [report, exitCode, expected] of cases) {
    const env = { ...process.env, ...streams(t, { stdout: report }), SDLC_PREFLIGHT_EXIT_CODE: String(exitCode) };
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), env, encoding: "utf8" });
    assert.equal(result.status, expected, `${JSON.stringify(report)}: ${result.stderr}`);
  }
});
