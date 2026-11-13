// Independent coverage of the approved S1 token correction and S3 runtime error
// paths/boundaries. All REST calls use the existing in-process fake.fetch.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { checkRendered, renderFleet } from "../../src/reconcile.mjs";
import { validateShape } from "../../src/routing/schema.mjs";
import { SUCCESS_CURSORS } from "../../src/routing/sync-state.mjs";
import { parseWorkflow, presetManifest, referenceRequest } from "../s1/helpers/fixtures.mjs";
import { edge, NOW_ISO, REPO_ROOT, sha, TOKENS } from "./helpers/fixtures.mjs";
import { flagsFor, invoke, PR_HEAD, TARGET, world } from "./helpers/poll-state-world.mjs";
import { seededShowcaseWorld } from "./helpers/qa-round2-worlds.mjs";
import { SHOWCASE_SCRIPT } from "./helpers/preflight-world.mjs";

const failureFlags = (e) => [
  "--record-failure", "--slug", e.upstreamSlug, "--target-sha", TARGET,
  "--workflow-id", `cascade-ai-${e.edgeId}`,
];
const cursors = (value) => Object.fromEntries(SUCCESS_CURSORS.map((name) => [name, value[name]]));
const bootstrapState = (e, overrides = {}) => ({
  ...initialSyncState(e.initialBaselineSha, NOW_ISO),
  ...overrides,
});

test("QA2 token floor: each cascade job rejects every omitted permission and Variables read", () => {
  const request = referenceRequest();
  const manifest = presetManifest();
  const rendered = renderFleet(request, { cwd: REPO_ROOT });
  assert.equal(rendered.ok, true);
  assert.deepEqual(checkRendered(rendered.files, request, manifest).filter((entry) => !entry.valid), []);
  const files = [...rendered.files].filter(([file]) => /\/cascade-(?:ai|mechanical)-.*\.md$/.test(file));
  assert.equal(files.length, 6);
  for (const [file, text] of files) {
    for (const job of ["finalize_poll_state", "escalate_failure"]) {
      for (const [permission, replacement] of [
        ["permission-actions-variables", undefined],
        ["permission-actions-variables", "read"],
        ["permission-contents", undefined],
        ["permission-pull-requests", undefined],
      ]) {
        const { frontmatter, body } = parseWorkflow(text);
        const token = frontmatter.jobs[job].steps.find((step) => step.id === "app_token");
        if (replacement === undefined) delete token.with[permission];
        else token.with[permission] = replacement;
        const changed = new Map(rendered.files);
        changed.set(file, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n${body}`);
        const errors = checkRendered(changed, request, manifest).flatMap((entry) => entry.errors);
        // the check names the Variables permission by the name of the baseline and the manifest, whichever name the token input uses
        const required = permission === "permission-actions-variables" ? "variables" : permission.slice("permission-".length);
        assert.ok(
          errors.some((error) => error.startsWith("app-token-permission-missing:") && error.includes(`job '${job}'`) && error.includes(`'${required}:`)),
          `${file} ${job} ${permission}=${replacement}: ${errors.join("\n")}`,
        );
      }
    }
  }
});

test("QA2 failure issue API refusal fails the script after exactly one persisted counter transition", async (t) => {
  const e = edge();
  const start = bootstrapState(e, { inFlightRunId: 713, inFlightTargetSha: TARGET });
  const w = world({ edgeValue: e, start });
  t.after(() => w.workspace.cleanup());
  w.stub.inject("GET", "/issues", {
    status: 403,
    body: { message: "Resource not accessible by integration" },
    headers: { "x-accepted-github-permissions": "issues=read" },
  });
  const result = await invoke(w, failureFlags(e), { env: { CORRELATION_ID: "qa-issue-refusal" } });
  assert.equal(result.code, 1, result.stderr);
  const after = w.stub.variable(e.stateVariable);
  assert.equal(after.failedAttempts, 1);
  assert.equal(after.failedTargetSha, TARGET);
  assert.equal(after.blockedTargetSha, null);
  assert.equal(after.inFlightRunId, null);
  assert.equal(after.inFlightTargetSha, null);
  assert.deepEqual(cursors(after), cursors(start));
  assert.equal(w.stub.calls("PATCH").length, 1);
  assert.equal(w.stub.calls("POST", "/issues").length, 0);
  assert.equal(w.stub.issues.length, 0);
  assert.equal(w.stub.calls("GET", "/issues")[0].headers.authorization, `Bearer ${TOKENS.issues}`);
});

test("QA2 a provenance path replaced by a directory is one negative verification, never an accepted PR", async (t) => {
  const e = edge();
  const start = bootstrapState(e, { inFlightRunId: 713, inFlightTargetSha: TARGET });
  const w = world({ edgeValue: e, start });
  t.after(() => w.workspace.cleanup());
  // GET contents returns an array when the configured path is a directory.
  w.stub.inject("GET", "/contents/", {
    status: 200,
    body: [{ type: "file", name: "index.json", path: `${e.provenanceFile}/index.json`, sha: PR_HEAD }],
  });
  const result = await invoke(w, flagsFor(e));
  assert.equal(result.code, 1, result.stderr);
  const after = w.stub.variable(e.stateVariable);
  assert.deepEqual(cursors(after), cursors(start));
  assert.equal(after.failedAttempts, 1);
  assert.equal(after.failedTargetSha, TARGET);
  assert.equal(after.inFlightRunId, null);
  assert.equal(after.inFlightTargetSha, null);
  assert.equal(after.openPrNumber, null);
  assert.equal(after.openPrTargetSha, null);
  assert.equal(w.stub.calls("PATCH").length, 1);
  assert.equal(w.stub.issues.length, 1);
  assert.match(w.stub.issues[0].body, /not a file/);
  assert.equal(w.stub.requests.some((request) => request.path.endsWith("/pulls") && request.method !== "GET"), false);
});

test("QA2 a refused state PATCH preserves the exact variable and reports the event on both CLI paths", async (t) => {
  const e = edge();
  for (const mode of ["success", "record-failure"]) {
    const start = bootstrapState(e, {
      failedTargetSha: TARGET, failedAttempts: 1,
      inFlightRunId: 713, inFlightTargetSha: TARGET,
      openPrNumber: 7, openPrTargetSha: sha("older-target"),
    });
    const w = world({ edgeValue: e, start });
    t.after(() => w.workspace.cleanup());
    const before = w.stub.variables.get(e.stateVariable);
    w.stub.inject("PATCH", "/actions/variables/", {
      status: 403,
      body: { message: "Resource not accessible by integration" },
      headers: { "x-accepted-github-permissions": "variables=write" },
    });
    const result = await invoke(w, mode === "success" ? flagsFor(e) : failureFlags(e), {
      env: { CORRELATION_ID: "qa-state-write-refusal" },
    });
    assert.equal(result.code, 1, `${mode}: ${result.stderr}`);
    assert.equal(w.stub.variables.get(e.stateVariable), before, `${mode}: no partial durable write`);
    assert.equal(w.stub.calls("PATCH").length, 1, `${mode}: no second failure-counter PATCH`);
    assert.equal(w.stub.issues.length, 1);
    assert.ok(w.stub.issues[0].body.includes("| Correlation id | `qa-state-write-refusal` |"));
    assert.equal(w.stub.variable(e.stateVariable).failedAttempts, 1, `${mode}: an API error is not another failed target attempt`);
  }
});

test("QA2 correlation boundaries: one and 128 characters survive every failure path and a later comment", async (t) => {
  for (const id of ["c", `c${"x".repeat(127)}`]) {
    assert.equal(validateShape("CorrelationId", id).valid, true);
    for (const mode of ["record-failure", "verification", "request-error"]) {
      const w = world({ ...(mode === "verification" ? { pulls: [] } : {}) });
      t.after(() => w.workspace.cleanup());
      if (mode === "request-error") w.stub.inject("GET", "/pulls", { status: 500, body: { message: "Server Error" } });
      const result = await invoke(w, mode === "record-failure" ? failureFlags(w.edgeValue) : flagsFor(w.edgeValue), { env: { CORRELATION_ID: id } });
      assert.equal(result.code, mode === "record-failure" ? 0 : 1, result.stderr);
      assert.equal(w.stub.issues.length, 1);
      assert.ok(w.stub.issues[0].body.includes(`| Correlation id | \`${id}\` |`), `${mode}: ${w.stub.issues[0].body}`);
      assert.equal(w.stub.issues[0].body.includes("run-77-1"), false);
      assert.equal(w.stub.variable(w.edgeValue.stateVariable).failedAttempts, mode === "request-error" ? 0 : 1);
    }
  }
  const w = world();
  t.after(() => w.workspace.cleanup());
  assert.equal((await invoke(w, failureFlags(w.edgeValue), { env: { CORRELATION_ID: "first-event" } })).code, 0);
  const second = `c${"x".repeat(127)}`;
  assert.equal((await invoke(w, failureFlags(w.edgeValue), { env: { CORRELATION_ID: second } })).code, 0);
  assert.equal(w.stub.issues.length, 1);
  assert.equal(w.stub.world.comments.length, 1);
  assert.ok(w.stub.world.comments[0].body.includes(`| Correlation id | \`${second}\` |`));
  assert.equal(w.stub.variable(w.edgeValue.stateVariable).failedAttempts, 2);
  assert.equal(w.stub.variable(w.edgeValue.stateVariable).blockedTargetSha, TARGET);
});

test("QA2 a capture script represented as a symlink fails before capture or state advancement", async (t) => {
  const w = seededShowcaseWorld();
  t.after(() => w.cleanup());
  const before = w.w.stub.variables.get(w.edge.stateVariable);
  assert.equal(w.edge.initialBaselineSha, w.w.state().lastMergedUpstreamSha);
  w.w.stub.inject("GET", (file) => file.endsWith(`/contents/${SHOWCASE_SCRIPT}`), {
    status: 200,
    body: { type: "symlink", path: SHOWCASE_SCRIPT, target: "../missing.mjs", sha: sha("symlink") },
  });
  const result = await w.go();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /not a file that the contents API returned as base64/);
  assert.equal(w.w.stub.variables.get(w.edge.stateVariable), before);
  assert.equal(w.w.patches().length, 0);
  assert.equal(w.w.stub.world.dispatches.length, 0);
  assert.equal(w.w.stub.issues.length, 1);
  assert.deepEqual(w.leftoverClones(), []);
});
