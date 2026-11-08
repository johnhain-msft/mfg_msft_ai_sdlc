// AC28: contract C5 state ownership. external:upstream-repos owns the git refs, pull requests and CI status checks of the target repositories; S2
// owns the audit report and the proposed commit bundle before the push. S2 never creates, updates, deletes or merges a ref, pull request,
// review or status check on an upstream repository except through safe-outputs.create-pull-request: the agent's commits stay in the target
// checkout, are packaged as a bundle that the safe_outputs job pushes, and the report is written by S2 (the agent and the post-steps) before
// that push.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { abs, DRIFT_KEYS, driftLock, driftPreset, driftWorkflow, listTree, readText } from "./helpers/fixtures.mjs";

const FORBIDDEN_OPERATIONS = /Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: the pull request is created only through the `create_pull_request` safe output\./;
const S2_SOURCES = () => [abs("src", "snapshot-watch-sources.mjs"), abs("src", "validate-copilot-lab-audit.mjs"), ...listTree(abs("src", "drift")).map((file) => abs("src", "drift", file))];

for (const key of DRIFT_KEYS) {
  test(`AC28: the prompt body of drift-${key}.md forbids git push, gh pr, write-method gh api calls and merging, and names create_pull_request as the only way`, () => {
    const { body } = driftWorkflow(key);
    assert.match(body, FORBIDDEN_OPERATIONS);
    const rules = body.slice(body.indexOf("## Operating rules"));
    assert.match(rules, FORBIDDEN_OPERATIONS, "in the operating rules, below the registration instructions that an operator writes");
    assert.match(rules, /Read `\/tmp\/gh-aw\/agent\/open-pr-dedup\.json` before you call `create_pull_request`/, "the deduplication is read before the pull request is requested");
    assert.match(rules, /Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`/, "the commits are made in the checkout, ahead of the safe output");
  });

  test(`AC28: drift-${key}.md gives the agent no way to write to the upstream repository other than the create-pull-request safe output`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(Object.keys(frontmatter["safe-outputs"]).sort(), ["create-pull-request", "github-app", "threat-detection"], "the publishing safe outputs are create-pull-request alone");
    assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["target-repo"], driftPreset(key).repo);
    assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" }, "the agent job's token reads and cannot write a ref or a pull request");
    const bash = frontmatter.tools.bash;
    for (const tool of ["gh", "curl", "wget"]) assert.equal(bash.includes(tool), false, `the agent may not run ${tool}`);
    assert.ok(bash.includes("git"), "git stays allowed: the agent commits in the checkout, and the safe_outputs job pushes");
    assert.equal(frontmatter.checkout.length, 1, "the commits stay in the one target checkout");
    for (const step of [...frontmatter["pre-agent-steps"], ...frontmatter["post-steps"]]) {
      assert.equal(/git push|gh pr |gh api|\/merge|enablePullRequestAutoMerge/.test(step.run), false, `${step.name}: no step pushes or calls the API`);
    }
  });

  test(`AC28: in drift-${key}.lock.yml every S2 step runs in the agent job, which cannot write, and only safe_outputs (after it) holds the write permissions that push the bundle`, () => {
    const { jobs } = driftLock(key).workflow;
    assert.equal(Object.values(jobs.agent.permissions).includes("write"), false, "the agent job, which holds the pre-agent steps, the agent and the post-steps, has no write permission");
    assert.deepEqual(jobs.safe_outputs.permissions, { contents: "write", issues: "write", "pull-requests": "write" }, "safe_outputs is the job that publishes");
    for (const needed of ["agent", "detection"]) assert.ok([].concat(jobs.safe_outputs.needs).includes(needed), `safe_outputs needs ${needed}`);
    const runs = (job) => (job.steps ?? []).map((step) => String(step.run ?? "")).join("\n");
    for (const script of ["src/drift/prepare-run.mjs", "src/drift/dedupe-open-prs.mjs", "src/snapshot-watch-sources.mjs"]) {
      assert.ok(runs(jobs.agent).includes(script), `${script} runs in the agent job`);
      assert.equal(runs(jobs.safe_outputs).includes(script), false, `and not in safe_outputs`);
    }
    if (key === "copilot-lab") assert.ok(runs(jobs.agent).includes("src/validate-copilot-lab-audit.mjs"), "the lab's audit validator is a step of the agent job, so the report is final before the push");
    assert.equal(runs(jobs.safe_outputs).includes("src/"), false, "no S2 script runs in the publishing job");
  });
}

test("AC28: the lab and the self-improvement prompts write the report in the target and a copy under /tmp/gh-aw/agent before create_pull_request", () => {
  const lab = driftWorkflow("copilot-lab").body;
  assert.match(lab, /Write a copy of `docs\/_meta\/audit-report\.md` to `\/tmp\/gh-aw\/agent\/audit-report\.md` before you call `create_pull_request`\./);
  assert.match(lab, /generated fresh from `docs\/_meta\/audit-report\.template\.md` on every run/);
  const improving = driftWorkflow("self-improving-agents").body;
  assert.match(improving, /written to `docs\/_meta\/self-improvement-report\.md`/);
  assert.match(improving, /Write a copy of the report to `\/tmp\/gh-aw\/agent\/self-improvement-report\.md` before you call `create_pull_request`\./);
});

test("AC28: neither src/snapshot-watch-sources.mjs nor any script in src/drift/ (nor the validator) contains 'git push'", () => {
  const files = S2_SOURCES();
  assert.ok(files.length >= 14, `scanned ${files.length} files`);
  for (const file of files) assert.equal(/git push/.test(readText(file)), false, `${path.relative(abs("."), file)} contains 'git push'`);
});

test("AC28: where an S2 prompt or instruction file mentions git push, gh pr or gh api, it is to forbid it", () => {
  const files = [...listTree(abs("prompts", "drift")).map((file) => abs("prompts", "drift", file)), ...listTree(abs("instructions")).map((file) => abs("instructions", file))];
  assert.ok(files.length >= 8);
  for (const file of files) {
    for (const line of readText(file).split("\n").filter((candidate) => /git push|gh pr\b|gh api/.test(candidate))) {
      assert.match(line, /\b(never|not|forbid|forbids|must not)\b/i, `${path.basename(file)}: ${line.trim()}`);
    }
  }
});
