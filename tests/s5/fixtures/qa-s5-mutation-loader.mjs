// Opt-in sensitivity checks: mutate loaded source in memory, never edit product files.
// $env:SDLC_S5_QA_MUTATION = "arrays"
// node --import ./tests/s5/fixtures/qa-s5-mutation-loader.mjs --test --test-name-pattern="^R1 QA delta:" tests/s5/qa-edge-coverage.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const mutations = {
  arrays: ["/bin/lib/inspect-repo.mjs", [
    ["if (Array.isArray(node)) {", "if (Array.isArray(node)) continue;\n    if (false) {"],
  ]],
  "array-indices": ["/bin/lib/inspect-repo.mjs", [
    ['pointer: `${pointer}/${index}`', 'pointer: `${pointer}/0`'],
  ]],
  "sha-validation": ["/bin/lib/inspect-repo.mjs", [
    ['typeof node.commit === "string" && SHA.test(node.commit)', 'typeof node.commit === "string"'],
  ]],
  "secret-directory": ["/bin/lib/instructions-file.mjs", [
    ["if (directory !== undefined)", "if (false)"],
  ]],
  "alphabetic-secret": ["/bin/lib/instructions-file.mjs", [
    ["if (assigned && /[A-Za-z]/.test(assigned[1]))", "if (assigned && /[A-Za-z]/.test(assigned[1]) && /\\d/.test(assigned[1]))"],
  ]],
  "lenient-utf8": ["/bin/lib/instructions-file.mjs", [
    ["{ fatal: true, ignoreBOM: true }", "{ fatal: false, ignoreBOM: true }"],
  ]],
  "strip-bom": ["/bin/lib/instructions-file.mjs", [
    ["{ fatal: true, ignoreBOM: true }", "{ fatal: true, ignoreBOM: false }"],
  ]],
  "fact-guards": ["/bin/lib/onboard-run.mjs", [
    ["assertDetectedFactsHaveNoCredentials(upstream);", "void upstream;"],
    ["assertDetectedFactsHaveNoCredentials(downstream);", "void downstream;"],
    ["assertNoCredentials(instructionsText, `the instructions file ${instructionsRelative}`);", "void instructionsText;"],
    ['assertNoCredentialsIn([project, downstreamProject, edge], "the entries of sdlc.yaml that this run writes");', "void project;"],
  ]],
  "generated-guard": ["/bin/lib/onboard-run.mjs", [
    ["assertNoCredentials(instructionsText, `the instructions file ${instructionsRelative}`);", "void instructionsText;"],
  ]],
  "entry-guard": ["/bin/lib/onboard-run.mjs", [
    ['assertNoCredentialsIn([project, downstreamProject, edge], "the entries of sdlc.yaml that this run writes");', "void project;"],
  ]],
  "first-boundary": ["/bin/lib/instructions-file.mjs", [
    ["for (const match of existing.matchAll(GENERATED_BOUNDARY)) index = match.index;", "for (const match of existing.matchAll(GENERATED_BOUNDARY)) { index = match.index; break; }"],
  ]],
  "skip-close": ["/bin/lib/manifest-flow.mjs", [
    ["await closeServer(server);", "void server;"],
  ]],
  // Re-review sensitivity: restore the old scanner anchors, or remove the precision-preserving boundaries entirely.
  "scanner-old-boundaries": ["/bin/lib/instructions-file.mjs", [
    ["/gh[pousr]_", "/\\bgh[pousr]_"],
    ["/github_pat_", "/\\bgithub_pat_"],
    [/\(\?<!\[A-Za-z0-9\]\)/g, "\\b"],
    [/\(\?!\[A-Za-z0-9\]\)/g, "\\b"],
  ]],
  "scanner-no-boundaries": ["/bin/lib/instructions-file.mjs", [
    [/\(\?<!\[A-Za-z0-9\]\)/g, ""],
    [/\(\?!\[A-Za-z0-9\]\)/g, ""],
  ]],
  "scanner-disabled": ["/bin/lib/instructions-file.mjs", [
    ["if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) || hasSecretAssignment(text)) {", "if (false) {"],
  ]],
  // Root-cause control for the isolated RED reproducer: this changes only in-memory matching,
  // so QA can verify the failures are due to word-boundary anchors, not fixture/API behavior.
  "embedded-token-boundaries": ["/bin/lib/instructions-file.mjs", [
    ["/\\bgh[pousr]_", "/gh[pousr]_"],
    ["/\\bgithub_pat_", "/github_pat_"],
  ]],
};

const selected = process.env.SDLC_S5_QA_MUTATION;
if (selected) {
  assert.ok(Object.hasOwn(mutations, selected), `unknown S5 QA mutation: ${selected}`);
  const [suffix, replacements] = mutations[selected];
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith(suffix)) return loaded;
      let source = String(loaded.source);
      for (const [before, after] of replacements) {
        const mutated = source.replace(before, after);
        assert.notEqual(mutated, source, `mutation ${selected} must change its intended target`);
        source = mutated;
      }
      return { ...loaded, source };
    },
  });
}
