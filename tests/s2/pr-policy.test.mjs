// AC25, AC31 and AC34: contract C5 request, pull request creation (gated by OQ36), blocked pull request creation, and the draft and reviewer
// policy. Once every gate has passed, the pull request is created or updated only through safe-outputs.create-pull-request on branch
// sdlc/<workflowKey>-YYYY-MM-DD with preserve-branch-name: true, recreate-ref: true, close-older-pull-requests: true with a distinct
// close-older-key per drift workflow and auto-merge: false; if the organization blocks pull request creation, fallback-as-issue: true opens an
// issue, and max stays 1. This test asserts the rendered flags only: what a remote-branch collision does is OQ36 and nothing here assumes it.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DRIFT_KEYS, driftPreset, driftWorkflow, driftWorkflowText, abs, WORKFLOWS } from "./helpers/fixtures.mjs";

const handler = (key) => driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"];
const BRANCH = /^sdlc\/.+-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

for (const key of DRIFT_KEYS) {
  test(`AC25: drift-${key} creates its pull request only through safe-outputs.create-pull-request, with the branch and close-older policy`, () => {
    const outputs = driftWorkflow(key).frontmatter["safe-outputs"];
    assert.deepEqual(
      Object.keys(outputs).filter((name) => !["github-app", "report-failure-as-issue", "threat-detection"].includes(name)),
      ["create-pull-request"],
      "the only write handler",
    );
    const flags = handler(key);
    assert.equal(flags["branch-prefix"], "sdlc/");
    assert.equal(flags["preserve-branch-name"], true, "no random suffix");
    assert.equal(flags["recreate-ref"], true);
    assert.equal(flags["close-older-pull-requests"], true);
    assert.equal(typeof flags["close-older-key"], "string");
    assert.ok(flags["close-older-key"].length > 0);
    assert.equal(flags["auto-merge"], false);
    assert.equal(flags["exclude-lock-yml"], true);
  });

  test(`AC25: the prompt of drift-${key} tells the agent to name its branch <workflowKey>-YYYY-MM-DD with the current UTC date`, () => {
    const { body } = driftWorkflow(key);
    const expected = key === "self-improving-agents" ? "self-improve" : "weekly-audit";
    assert.match(body, new RegExp(`Name the working branch \`${expected}-YYYY-MM-DD\` with the current UTC date`), `${key} uses ${expected}`);
    assert.equal(/Name the working branch `[a-z-]+-YYYY-MM-DD`/.test(body.replace(new RegExp(`\`${expected}-YYYY-MM-DD\``), "")), false, "and no other workflow key");
    assert.equal(BRANCH.test(`sdlc/${expected}-2026-11-06`), true, "with the sdlc/ prefix that branch-prefix applies, the branch matches the pattern");
    assert.match(body, /The `sdlc\/` prefix is added when the pull request is created; do not write it yourself\./, `${key}: the agent leaves the prefix to branch-prefix, so the branch is not sdlc/sdlc/...`);
  });

  test(`AC31: drift-${key} renders fallback-as-issue: true and max: 1, and never fallback-as-issue: false`, () => {
    assert.equal(handler(key)["fallback-as-issue"], true);
    assert.equal(handler(key).max, 1);
    assert.equal(driftWorkflowText(key).includes("fallback-as-issue: false"), false);
    const lock = fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8");
    assert.equal(/fallback_as_issue\\?":false/.test(lock), false, "and neither does the compiled lock");
    assert.match(lock, /fallback_as_issue\\?":true/);
  });
}

test("AC25: the three close-older-key values differ, one per drift workflow", () => {
  const keys = DRIFT_KEYS.map((key) => handler(key)["close-older-key"]);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys, DRIFT_KEYS.map((key) => `sdlc-drift-${key}`));
});

test("AC25: drift-copilot-lab uses weekly-audit and drift-self-improving-agents uses self-improve as <workflowKey>, and the pattern accepts both examples", () => {
  assert.match("sdlc/weekly-audit-YYYY-MM-DD".replace("YYYY-MM-DD", "2026-11-01"), BRANCH);
  assert.match("sdlc/self-improve-YYYY-MM-DD".replace("YYYY-MM-DD", "2026-11-02"), BRANCH);
  assert.match(driftWorkflow("copilot-lab").body, /`weekly-audit-YYYY-MM-DD`/);
  assert.match(driftWorkflow("self-improving-agents").body, /`self-improve-YYYY-MM-DD`/);
  assert.equal(driftWorkflow("copilot-lab").body.includes("self-improve-YYYY"), false);
  assert.equal(driftWorkflow("self-improving-agents").body.includes("weekly-audit-YYYY"), false);
});

test("AC25: workflowKey is not a driftAudit field: the preset has none and the prefix comes from branch-prefix", () => {
  for (const key of DRIFT_KEYS) {
    assert.equal("workflowKey" in driftPreset(key).driftAudit, false);
    assert.equal(handler(key)["branch-prefix"], "sdlc/");
  }
});

test("AC31: no drift workflow or lock disables the fallback, and max is 1 for each", () => {
  for (const key of DRIFT_KEYS) {
    assert.equal(driftWorkflowText(key).includes("fallback-as-issue: false"), false, key);
    assert.equal(handler(key).max, 1, key);
  }
});

test("AC34: the rendered draft and reviewers of the three preset workflows follow the policy", () => {
  assert.equal(handler("gh-admin-msft").draft, false);
  assert.equal(handler("copilot-lab").draft, false);
  assert.equal(handler("self-improving-agents").draft, true);
  assert.deepEqual(handler("gh-admin-msft").reviewers, driftPreset("gh-admin-msft").driftAudit.reviewers);
  assert.ok(handler("gh-admin-msft").reviewers.length > 0);
  assert.deepEqual(handler("copilot-lab").reviewers, []);
  assert.deepEqual(handler("self-improving-agents").reviewers, []);
});

test("AC34: every pull request still requires explicit human review and merge: nothing merges, approves or enables auto-merge", () => {
  for (const key of DRIFT_KEYS) {
    assert.equal(handler(key)["auto-merge"], false, key);
    assert.match(driftWorkflow(key).body, /never merge/, `${key}: the prompt says never merge`);
  }
});
