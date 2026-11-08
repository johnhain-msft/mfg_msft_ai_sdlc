// AC16: the reconciler refuses, with a non-zero exit and nothing written, an AI workflow whose allowed-files include a locked rule, source, type or sandbox-test file
// (or any other locked harness or runtime file), and a job-level concurrency that duplicates the workflow-level group.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, renderFleet } from "../../src/reconcile.mjs";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { abs, readText } from "./helpers/fixtures.mjs";
import { manifest as presetOf, parseWorkflow, referenceRequest } from "./helpers/workflows.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

const LAB_WORKFLOW = ".github/workflows/cascade-ai-copilot-lab.md";
const UNSAFE = [
  ["rules.ts", "experiences/copilot-workshop/content/rules.ts"],
  ["source.ts", "experiences/copilot-workshop/content/source.ts"],
  ["types.ts", "experiences/copilot-workshop/content/types.ts"],
  ["sandbox.test.ts", "apps/lab-studio/server/tests/sandbox.test.ts"],
  ["another locked harness file", "tests/auth.test.ts"],
  ["a glob that reaches rules.ts", "experiences/copilot-workshop/content/*.ts"],
  ["a glob that reaches a locked directory", "src/**"],
];

/** A committed workspace that holds the preset with one entry added to the allowed files of the copilot-lab edge. */
function workspaceWith(entry) {
  const manifest = structuredClone(presetOf());
  manifest.dependencyEdges.find((edge) => edge.edgeId === "copilot-lab").allowedFiles.push(entry);
  const workspace = createWorkspace({ manifestText: YAML.stringify(manifest, { lineWidth: 0 }), instructions: true });
  for (const [name, value] of [["user.email", "fixture@example.invalid"], ["user.name", "Fixture"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) git(workspace.dir, ["config", name, value]);
  git(workspace.dir, ["add", "-A"]);
  git(workspace.dir, ["commit", "-q", "-m", "base"]);
  return workspace;
}

for (const [label, entry] of UNSAFE) {
  test(`AC16: an allowed-files entry that includes ${label} (${entry}) fails the reconciliation: non-zero exit, no .lock.yml written, an empty git status`, async () => {
    const workspace = workspaceWith(entry);
    try {
      assert.equal(workspace.status(), "", "the workspace starts clean");
      const requestFile = path.join(workspace.root, "request.json");
      fs.writeFileSync(requestFile, JSON.stringify(referenceRequest()));
      const cli = workspace.cli(requestFile);
      assert.notEqual(cli.code, 0, `${cli.stdout}${cli.stderr}`);
      assert.equal(cli.json?.status, "error");
      const errors = cli.json.validationResults.flatMap((result) => result.errors);
      assert.ok(errors.some((error) => /^allowed-files-locked-path: /.test(error) && error.includes(entry)), JSON.stringify(errors));
      assert.deepEqual(workspace.list(".github/workflows").filter((file) => file.endsWith(".lock.yml")), [], "no lock file was written");
      assert.deepEqual(workspace.list(".github/workflows"), [], "nothing was written under .github/workflows");
      assert.equal(workspace.status(), "", "git status --porcelain prints nothing");
      assert.equal((await workspace.reconcile(referenceRequest())).status, "error", "the same through the module");
      assert.equal(workspace.status(), "");
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC16: a job-level concurrency on a custom job that duplicates the workflow-level group is rejected by the check that the reconciler runs on every rendered workflow (no other job-level concurrency is accepted either)", () => {
  const rendered = renderFleet(referenceRequest(), { cwd: abs(".") });
  assert.ok(rendered.ok);
  const request = referenceRequest();
  const clean = checkRendered(new Map(rendered.files), request, presetOf());
  assert.deepEqual(clean.filter((result) => !result.valid), [], "the rendered preset passes");
  const withConcurrency = (job, concurrency) => {
    const files = new Map(rendered.files);
    const { frontmatter, body } = parseWorkflow(files.get(LAB_WORKFLOW));
    frontmatter.jobs[job].concurrency = concurrency;
    files.set(LAB_WORKFLOW, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
    return checkRendered(files, request, presetOf());
  };
  for (const job of ["finalize_poll_state", "escalate_failure"]) {
    const duplicate = withConcurrency(job, { group: "sdlc-state-copilot-lab" }).find((result) => result.file.endsWith("cascade-ai-copilot-lab.md"));
    assert.equal(duplicate.valid, false, job);
    assert.ok(duplicate.errors.some((error) => /^job-level-concurrency: /.test(error) && error.includes("duplicates the workflow-level group")), JSON.stringify(duplicate.errors));
  }
  const other = withConcurrency("finalize_poll_state", { group: "something-else" }).find((result) => result.file.endsWith("cascade-ai-copilot-lab.md"));
  assert.equal(other.valid, false);
  assert.ok(other.errors.some((error) => /^job-level-concurrency: /.test(error)));
  assert.equal(readText(abs(LAB_WORKFLOW)).includes("concurrency: {"), false, "the committed workflow has none in a job");
});
