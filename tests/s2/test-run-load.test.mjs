// The load that the test suite puts on the host. Review finding on the delta of SPEC-02: the combined `npm test` failed on three of three runs on a host that
// was busy with other projects' builds, each time in a different test and each time on a spawn that waited for more than a minute (a `git hash-object` of
// the bash helper that ended with ETIMEDOUT, a bash that its timeout killed, a first `gh aw version` of the S5 fake that did not succeed and made the
// version gate fall back to `--version`), while every suite passed when it ran alone. The tests were right; the run kept too many processes starting at once.
//
// What these tests hold, each of which fails against the suite as it was before the fix:
//  - the test scripts of package.json give the runner a `--test-concurrency` (its default is one file fewer than the logical processors of the host), the same
//    number in every script, and it is TEST_FILE_CONCURRENCY of helpers/load.mjs, a small number;
//  - the hermetic test of AC39, which starts a runner of its own over every other file of this suite, takes the size of its pool from helpers/load.mjs and not
//    from the processors of the host, and that pool is no larger than the runner's;
//  - the spawn timeout of the bash helper of the S1 suite, the shortest of the helpers, is not shorter than the two minutes that the helpers of this suite allow;
//  - a child of this suite does not inherit the XDG_DATA_HOME of the shell that runs it (the verification of this repository exports it for the reconciler, and with
//    it exported two AC24 tests failed on "the parent has neither afterwards"), and a value that a test gives a child still reaches it;
//  - nor does it inherit SDLC_REAL_GH_AW (`SDLC_REAL_GH_AW=1 npm test` asks for the real gh-aw compiler): the gh of a child is a shim that cannot compile, so a child
//    that had it ran the real-compiler checks through the shim and failed (AC37, in the hermetic child of idempotence.test.mjs); they run in the test process only.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as bashHelper from "../s1/helpers/bash-runtime.mjs";
import { abs } from "./helpers/fixtures.mjs";
import { HERMETIC_WORKERS, hermeticWorkers, TEST_FILE_CONCURRENCY } from "./helpers/load.mjs";
import { createShims } from "./helpers/shims.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

const TEST_SCRIPTS = ["test", "test:s1", "test:s2", "test:s3", "test:s4", "test:s5"];
const SUITES = ["s1", "s2", "s3", "s4", "s5"];
/** The values that a command line gives `--test-concurrency` (`--test-concurrency=4` or `--test-concurrency 4`). */
const concurrencyOf = (command) => [...String(command ?? "").matchAll(/(?:^|\s)--test-concurrency(?:=|\s+)(\S+)/g)].map((match) => match[1]);
const scripts = () => JSON.parse(fs.readFileSync(abs("package.json"), "utf8")).scripts;

test("every test script of package.json caps how many test files run at once, at the same small number, and the full run still covers all five suites", () => {
  const found = scripts();
  for (const name of TEST_SCRIPTS) assert.deepEqual(concurrencyOf(found[name]), [String(TEST_FILE_CONCURRENCY)], `${name}: ${found[name]}`);
  for (const suite of SUITES) {
    assert.ok(found.test.includes(`tests/${suite}/*.test.mjs`), `test runs tests/${suite}`);
    assert.ok(found[`test:${suite}`].includes(`tests/${suite}/*.test.mjs`), `test:${suite} runs tests/${suite}`);
  }
  // a cap, not a restatement of the default: at the default of the runner (15 files at once on a 16-thread host) the runs that this finding is about failed
  assert.ok(Number.isInteger(TEST_FILE_CONCURRENCY) && TEST_FILE_CONCURRENCY >= 1 && TEST_FILE_CONCURRENCY <= 4, `${TEST_FILE_CONCURRENCY}`);
});

test("the hermetic test of AC39 takes the size of its pool from helpers/load.mjs, and that pool is no larger than the number of files that the runner has going", () => {
  assert.ok(HERMETIC_WORKERS >= 1 && HERMETIC_WORKERS <= TEST_FILE_CONCURRENCY, `${HERMETIC_WORKERS} against ${TEST_FILE_CONCURRENCY}`);
  assert.equal(hermeticWorkers(64), HERMETIC_WORKERS, "a big host gets the cap and not a few fewer than its processors");
  assert.equal(hermeticWorkers(2), Math.min(2, HERMETIC_WORKERS), "a small host gets fewer");
  assert.equal(hermeticWorkers(1), 1);
  assert.equal(hermeticWorkers(0), 1, "and never none");
  const source = fs.readFileSync(abs("tests", "s2", "no-github-writes.test.mjs"), "utf8");
  assert.ok(/Array\.from\(\{ length: hermeticWorkers\(\) \}, worker\)/.test(source), "the pool is sized by hermeticWorkers()");
  assert.equal(source.includes("availableParallelism"), false, "and by nothing that is read from the processors of the host");
});

test("the spawn timeout of the bash helper of the S1 suite is not shorter than the two minutes that the helpers of this suite allow", () => {
  assert.ok(bashHelper.TIMEOUT_MS >= 120000, `${bashHelper.TIMEOUT_MS} ms`);
});

test("a child of this suite does not inherit the XDG_DATA_HOME of the shell that runs it, and a value that a test gives it still reaches it", () => {
  const earlier = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "C:\\ambient\\xdg-data";
  const shims = createShims();
  try {
    assert.equal("XDG_DATA_HOME" in cleanEnv(), false, "cleanEnv");
    assert.equal("XDG_DATA_HOME" in shims.env(), false, "the environment of the shims");
    assert.equal(cleanEnv({ XDG_DATA_HOME: "explicit" }).XDG_DATA_HOME, "explicit");
    assert.equal(shims.env({ XDG_DATA_HOME: "explicit" }).XDG_DATA_HOME, "explicit");
  } finally {
    shims.cleanup();
    if (earlier === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = earlier;
  }
});

test("a child of this suite does not inherit SDLC_REAL_GH_AW of the shell that runs it: its gh is a shim that cannot compile, so the checks that ask for the real compiler run in the test process and skip in the children", () => {
  const earlier = process.env.SDLC_REAL_GH_AW;
  process.env.SDLC_REAL_GH_AW = "1";
  const shims = createShims();
  try {
    assert.equal("SDLC_REAL_GH_AW" in cleanEnv(), false, "cleanEnv");
    assert.equal("SDLC_REAL_GH_AW" in shims.env(), false, "the environment of the shims");
    assert.equal(cleanEnv({ SDLC_REAL_GH_AW: "1" }).SDLC_REAL_GH_AW, "1", "a value that a test gives a child still reaches it");
    assert.equal(shims.env({ SDLC_REAL_GH_AW: "1" }).SDLC_REAL_GH_AW, "1");
  } finally {
    shims.cleanup();
    if (earlier === undefined) delete process.env.SDLC_REAL_GH_AW;
    else process.env.SDLC_REAL_GH_AW = earlier;
  }
});
