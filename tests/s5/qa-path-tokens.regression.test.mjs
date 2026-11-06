// Puts the regression tests of qa-path-tokens.regression.mjs (the follow-up of R5, AC50: a credential after a file-name prefix in a path that the inspection reads) into the suites that
// run by the *.test.mjs convention: `npm test`, `npm run test:s5` and `node --test tests/s5/` (through index.js). Importing the module registers its tests with the runner of this
// process; the module itself still runs on its own, which is how the finding is reproduced:
//   node --test tests/s5/qa-path-tokens.regression.mjs
import "./qa-path-tokens.regression.mjs";
