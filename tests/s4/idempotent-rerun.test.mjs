// AC30: a retry or a re-dispatch of the same inputs is idempotent. The second run of a workflow for the same upstream_sha reuses the branch name and the close-older key,
// regenerates the same helper output and the same tree, and a second pass of the deterministic sequence over the first run's result changes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { git } from "./helpers/fixtures.mjs";
import { createRun } from "./helpers/runtime.mjs";
import { AI, edgeOf, workflowOf } from "./helpers/workflows.mjs";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs } from "./helpers/fixtures.mjs";
import { referenceRequest } from "./helpers/workflows.mjs";

const treeOf = (run) => git(run.portfolio, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
/** The JSON lines that the helper commands printed: the helper output (git's and npm's lines name commits and times). */
const jsonLines = (text) => text.split("\n").filter((line) => line.startsWith("{"));

test("AC30: two runs of the deterministic sequence of each workflow from the same base give the same tree and the same helper JSON, and a second pass over the first result changes nothing", () => {
  for (const spec of AI) {
    const options = { labChanged: true, inputs: { on_commit_only_advance: "bump-provenance" } };
    const first = createRun(spec, options);
    const second = createRun(spec, options);
    try {
      for (const run of [first, second]) assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0], spec.id);
      assert.equal(first.baseSha, second.baseSha, `${spec.id}: the same base`);
      const a = first.agentRuns();
      const b = second.agentRuns();
      assert.equal(a.status, 0, `${spec.id}: ${a.stdout}${a.stderr}`);
      assert.equal(b.status, 0, `${spec.id}: ${b.stdout}${b.stderr}`);
      assert.deepEqual(jsonLines(b.stdout), jsonLines(a.stdout), `${spec.id}: the helper JSON of the second run equals the first`);
      assert.ok(jsonLines(a.stdout).length > 0 || spec !== AI[0], `${spec.id}: the helpers printed JSON`);
      assert.equal(treeOf(second), treeOf(first), `${spec.id}: the same tree, so git diff --exit-code between the two heads is clean`);
      assert.deepEqual(git(first.portfolio, ["diff", "--name-only", first.baseSha, first.head()]).stdout, git(second.portfolio, ["diff", "--name-only", second.baseSha, second.head()]).stdout);
      // the second pass over the result of the first, without the commit: nothing more to change
      const headBefore = first.head();
      const commands = first.promptCommands().split("\n").filter((line) => !/^git (add|commit)\b/.test(line)).join("\n");
      const again = first.script(commands);
      assert.equal(again.status, 0, `${spec.id}: ${again.stdout}${again.stderr}`);
      assert.equal(first.porcelain(), "", `${spec.id}: git status --porcelain prints nothing after the second pass`);
      assert.equal(first.head(), headBefore);
      assert.doesNotThrow(() => git(first.portfolio, ["diff", "--exit-code", headBefore, "HEAD"]), `${spec.id}: git diff --exit-code of the first head and HEAD`);
      if (spec === AI[0]) {
        const accepted = jsonLines(again.stdout).map((line) => JSON.parse(line)).filter((entry) => entry.status !== undefined);
        assert.deepEqual(accepted.map((entry) => [entry.status, entry.changedLabs]), [["accepted", []]], `${spec.id}: the second studio accept finds nothing to change`);
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }
  }
});

test("AC30: a re-dispatch reuses the branch name and the close-older key: the rendered values are constants of the edge, and a second render is byte-identical", () => {
  const one = renderFleet(referenceRequest(), { cwd: abs(".") });
  const two = renderFleet(referenceRequest(), { cwd: abs(".") });
  assert.ok(one.ok && two.ok);
  for (const spec of AI) {
    const file = `.github/workflows/${spec.id}.md`;
    assert.equal(two.files.get(file), one.files.get(file), spec.id);
    const { frontmatter, body } = workflowOf(spec);
    const handler = frontmatter["safe-outputs"]["create-pull-request"];
    assert.equal(handler["close-older-key"], edgeOf(spec).closeOlderKey, spec.id);
    assert.ok(body.includes(`exactly the branch \`${edgeOf(spec).branchName}\``), spec.id);
    assert.equal(frontmatter["pre-agent-steps"][1].run.includes(`BRANCH_NAME=${edgeOf(spec).branchName}`), true, spec.id);
    assert.equal(handler["recreate-ref"], true, `${spec.id}: the branch is recreated, so a re-run replaces the pull request's head`);
    assert.equal(handler["preserve-branch-name"], true, spec.id);
  }
});
