// Explicit failing reproduction for AC22, deliberately outside *.test.mjs so the
// normal suites are not left red. Run: node tests/s2/fixtures/qa/staged-pinned-repro.mjs
// The script should exit 0 only once the validator rejects the index-only change.
import assert from "node:assert/strict";
import path from "node:path";
import { forceRemove, instanceScript, tempDir } from "../../helpers/fixtures.mjs";
import { createRepo } from "../../helpers/git-fixture.mjs";
import { labFiles } from "../../helpers/lab-fixture.mjs";
import { cleanEnv, runNode } from "../../helpers/stub-server.mjs";

const registry = "docs/_meta/registry.yaml";
const root = tempDir("sdlc-qa-index-only-");
const repo = createRepo(labFiles(), { dir: path.join(root, "checkout") });
const out = path.join(root, "artifacts", "agent");
try {
  const base = repo.head();
  const original = repo.read(registry);
  const args = ["--checkout", repo.dir, "--out", out];
  const options = { cwd: root, env: cleanEnv({ SDLC_BASE_SHA: base }) };
  const baseline = await runNode(instanceScript("validate-copilot-lab-audit.mjs"), args, options);
  assert.equal(baseline.code, 0, baseline.stderr);
  repo.write(registry, original.replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"'));
  repo.git("add", "--", registry);
  repo.write(registry, original);
  assert.equal(repo.head(), base, "HEAD is unchanged");
  assert.equal(repo.read(registry), original, "the working tree has the original pinned value");
  assert.match(repo.git("show", `:${registry}`), /gh_aw_schema_version: "9\.9\.9"/, "the index still carries the bump");
  console.log(`Index-only change: ${repo.status()}`);
  const result = await runNode(instanceScript("validate-copilot-lab-audit.mjs"), args, options);
  console.log(JSON.stringify(result));
  assert.equal(result.code, 1, "AC22: a staged pinned-version bump must fail even when HEAD and the working tree hold the base value");
  assert.match(result.stderr, /gh_aw_schema_version/);
} finally {
  forceRemove(root);
}
