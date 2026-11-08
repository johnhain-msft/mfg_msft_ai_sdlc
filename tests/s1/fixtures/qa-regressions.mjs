// The QA reproductions for the AC10, AC11, AC21, AC32 and AC71 findings live in tests/s1/qa-regressions.test.mjs,
// which `npm test` runs. This re-export keeps `node --test tests/s1/fixtures/qa-regressions.mjs` working.
import "../qa-regressions.test.mjs";
