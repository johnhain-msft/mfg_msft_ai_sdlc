// How much of the host the test suite takes for itself.
//
// `npm test` runs every test file in a process of its own, and each file starts bash, git and node processes of its own. Left at the default of
// the runner (one file fewer than the host has logical processors, 15 on a 16-thread workstation), the suite kept so many processes starting at
// once that, on a host that was busy with other work, a spawn that takes a second waited for more than a minute (a `git hash-object` of the bash
// helper that ended with ETIMEDOUT, a bash that its timeout killed, a first `gh aw version` of the S5 fake that did not succeed and made the version
// gate fall back to `--version`), and the test that owned it failed on a timeout that said nothing about the code under test. The suite therefore
// bounds its own load, in the one place that decides it (the `--test-concurrency` of the test scripts of package.json) and in the one test that starts
// a runner of its own (the hermetic test of AC39).

import os from "node:os";

/** How many test files the runner has going at once: the number that the test scripts of package.json give `--test-concurrency`, which a test holds equal to this. */
export const TEST_FILE_CONCURRENCY = 4;

/** How many child test runs the hermetic test (no-github-writes.test.mjs, AC39) has going at once, besides the files that the runner runs: no more than the runner itself has. */
export const HERMETIC_WORKERS = TEST_FILE_CONCURRENCY;

/** The size of the pool of the hermetic test on a host with `processors` logical processors: HERMETIC_WORKERS, or fewer on a smaller host, and never less than one. */
export const hermeticWorkers = (processors = os.availableParallelism()) => Math.max(1, Math.min(HERMETIC_WORKERS, processors));
