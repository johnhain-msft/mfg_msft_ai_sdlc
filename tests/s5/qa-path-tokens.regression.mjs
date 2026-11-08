// Regression tests for the follow-up of the S5 defect R5 that executable QA found (AC50): a credential that follows a file-name prefix in a path that the inspection reads
// (`packages/backup_<token>/package.json`) must be refused like the same credential standing alone; the product fix is in (the scanner no longer takes `_` for a part of a word).
// The suites run this file through qa-path-tokens.regression.test.mjs (`npm test`, `node --test tests/s5/`), and it can run on its own:
// node --test tests/s5/qa-path-tokens.regression.mjs. All credentials are synthetic, assembled at runtime, and all writes occur in disposable fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { assertNoCredentials } from "../../bin/lib/instructions-file.mjs";
import { createScenario, fixtureRepos, recordFsWrites, sha256Tree } from "./helpers/harness.mjs";

const credentials = [
  ["classic PAT", ["ghp", "A1b2C3d4E5f6G7h8I9j0".repeat(2)].join("_")],
  ["fine-grained PAT", ["github", "pat", "A1b2C3d4E5f6G7h8I9j0".repeat(3)].join("_")],
];
const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });

for (const [credential, token] of credentials) {
  for (const kind of ["package manifest", "scheduled workflow", "upstream provenance", "downstream provenance"]) {
    test(`R5 follow-up: a ${credential} after a filename prefix in ${kind} must never be copied`, async () => {
      assert.throws(() => assertNoCredentials(token, "positive control"), (error) => error.code === "instructions-credential", "the exact synthetic token is recognized when it stands alone");
      const repositories = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
      const upstream = repositories["example-owner/node-app"].files;
      const downstream = repositories["example-owner/edge-ok"].files;
      if (kind === "package manifest") upstream[`packages/backup_${token}/package.json`] = "{}";
      if (kind === "scheduled workflow") upstream[`.github/workflows/backup_${token}.yml`] = "on:\n  schedule:\n    - cron: '0 5 * * 0'\n";
      if (kind === "upstream provenance") upstream[`public/backup_${token}/source.json`] = JSON.stringify({ commit: "4".repeat(40) });
      if (kind === "downstream provenance") {
        delete downstream["public/imported/source.json"];
        downstream[`public/backup_${token}/source.json`] = JSON.stringify({ commit: "4".repeat(40) });
      }
      const scenario = await createScenario({ fake: { repos: repositories } });
      try {
        const before = sha256Tree(scenario.workspace.dir);
        const { result: run, writes } = await recordFsWrites(() => scenario.onboard([
          "--repo", "example-owner/node-app",
          ...(kind === "downstream provenance" ? ["--downstream", "example-owner/edge-ok"] : []),
        ], { env: scenario.env(scenario.appCredentials()), runGh: fastGh }));
        const instructions = scenario.workspace.exists("instructions/node-app.md") ? scenario.workspace.read("instructions/node-app.md") : "";
        assert.deepEqual({
          rejected: run.code !== 0,
          noOutputWrites: writes.length === 0,
          repositoryUnchanged: sha256Tree(scenario.workspace.dir) === before,
          noReconcilerCall: scenario.reconcile.calls.length === 0,
          noGitHubMutation: scenario.fake.nonGet().length === 0,
          noCredentialInInstructions: !instructions.includes(token),
          noCredentialInManifest: !scenario.workspace.read("sdlc.yaml").includes(token),
          noCredentialInOutput: !`${run.stdout}${run.stderr}`.includes(token),
        }, {
          rejected: true,
          noOutputWrites: true,
          repositoryUnchanged: true,
          noReconcilerCall: true,
          noGitHubMutation: true,
          noCredentialInInstructions: true,
          noCredentialInManifest: true,
          noCredentialInOutput: true,
        }, "AC50 applies to credentials embedded within a path component, not only tokens at a word boundary");
      } finally {
        await scenario.cleanup();
      }
    });
  }
}
