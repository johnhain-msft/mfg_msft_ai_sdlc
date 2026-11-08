// Puts the regression tests of qa-defects.regression.mjs (R1-R7: AC11, AC45, AC49, AC50 and AC51) into the suites that run by the
// *.test.mjs convention: `npm test`, `npm run test:s5` and `node --test tests/s5/` (through index.js). Importing the module registers
// its tests with the runner of this process; the module itself still runs on its own, which is how a single finding is reproduced:
//   node --test --test-name-pattern='^R1 ' tests/s5/qa-defects.regression.mjs
import "./qa-defects.regression.mjs";
