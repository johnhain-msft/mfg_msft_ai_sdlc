// AC19, AC26, AC29 and AC71: who owns what. The state of the poll (SDLC_SYNC_STATE_<SLUG>) is SPEC-03's: no S4 file or rendered step writes it, reads the in-flight fields or polls another run; the
// correlation id is the router's and is only carried; the downstream repository changes only through the safe output, never through a push, a merge or a write request.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { abs, readText } from "./helpers/fixtures.mjs";
import { createRun } from "./helpers/runtime.mjs";
import { AI, WORKFLOW_DIR, customJobs, lockTextOf, workflowOf } from "./helpers/workflows.mjs";

const HELPERS = ["src/lab-studio-drift.mjs", "src/bump-studio-revision-pins.mjs", "src/verify-immutable-gates.mjs"];
const ENGINE = [...HELPERS, "src/ai-pull-request-result.mjs", ...fs.readdirSync(abs("src", "adaptation")).filter((name) => name.endsWith(".mjs")).map((name) => `src/adaptation/${name}`)];
const sourceOf = (spec) => readText(abs(WORKFLOW_DIR, `${spec.id}.md`));

/** Every `run:` script of a workflow: the steps of the agent job and of the two custom jobs. */
function scriptsOf(spec) {
  const { frontmatter } = workflowOf(spec);
  const steps = [...frontmatter.steps, ...frontmatter["pre-agent-steps"], ...frontmatter["post-steps"], ...Object.values(customJobs(spec)).flatMap((job) => job.steps)];
  return steps.map((step) => String(step.run ?? "")).filter((text) => text !== "");
}

test("AC19: no helper or engine file names the state variable, the variables endpoint or the variable command", () => {
  for (const file of ENGINE) {
    const text = readText(abs(...file.split("/")));
    for (const banned of ["SDLC_SYNC_STATE", "actions/variables", "gh variable"]) assert.equal(text.includes(banned), false, `${file}: ${banned}`);
  }
});

test("AC19: the rendered workflows (the source and the compiled lock) never name SDLC_SYNC_STATE_<SLUG> or the variables API, and reach the poll state only through src/update-poll-state.mjs in the two custom jobs", () => {
  for (const spec of AI) {
    for (const [label, text] of [["source", sourceOf(spec)], ["lock", lockTextOf(spec)]]) {
      for (const banned of ["SDLC_SYNC_STATE", "actions/variables", "gh variable", "gh secret"]) assert.equal(text.includes(banned), false, `${spec.id} ${label}: ${banned}`);
    }
    const { frontmatter } = workflowOf(spec);
    const outside = { ...frontmatter, jobs: undefined };
    assert.equal(JSON.stringify(outside).includes("update-poll-state"), false, `${spec.id}: only the custom jobs invoke SPEC-03's script`);
    assert.equal(workflowOf(spec).body.includes("update-poll-state"), false, `${spec.id}: nor does the prompt`);
    assert.deepEqual(Object.keys(customJobs(spec)).sort(), ["escalate_failure", "finalize_poll_state"]);
    for (const [name, job] of Object.entries(customJobs(spec))) {
      assert.equal(job.steps.filter((step) => String(step.run ?? "").includes("update-poll-state.mjs")).length, 1, `${spec.id}.${name}: exactly one invocation`);
    }
  }
});

test("AC19/AC29: no S4 file implements, imports or runs the poll-state script, and none of them generates a correlation id", () => {
  for (const file of ENGINE) {
    const text = readText(abs(...file.split("/")));
    assert.equal(/update-poll-state|from ["'][^"']*poll-state/.test(text), false, `${file}: the poll-state script`);
    assert.equal(/correlation/i.test(text), false, `${file}: a correlation id`);
    assert.equal(/randomUUID|randomBytes|crypto\.getRandom/.test(text), false, `${file}: random identifiers`);
  }
});

test("AC26: no step or script of the three workflows reads, writes or polls inFlightRunId or inFlightTargetSha, or the status of another run", () => {
  for (const spec of AI) {
    for (const [label, text] of [["source", sourceOf(spec)], ["lock", lockTextOf(spec)]]) {
      for (const banned of ["inFlightRunId", "inFlightTargetSha", "gh run view", "gh run watch", "gh run list", "workflow_run_id", "lastMergedUpstreamSha", "openPrTargetSha", "failedAttempts"]) {
        assert.equal(text.includes(banned), false, `${spec.id} ${label}: ${banned}`);
      }
    }
    for (const script of scriptsOf(spec)) assert.equal(/\bsleep\b|\bwatch\b/.test(script.replace(/set -euo pipefail/g, "")), false, `${spec.id}: nothing waits for another run`);
  }
  for (const file of ENGINE) for (const banned of ["inFlightRunId", "inFlightTargetSha", "gh run"]) assert.equal(readText(abs(...file.split("/"))).includes(banned), false, `${file}: ${banned}`);
});

test("AC29: dispatch-inputs.json holds the ten inputs verbatim, and correlation_id reaches the run only as the dispatch input: bound, recorded and handed on, never assigned", () => {
  const run = createRun(AI[0], { inputs: { correlation_id: "bridge:deploy-42/a+b=c" } });
  try {
    assert.deepEqual(run.runPre().map((result) => result.status), [0, 0, 0, 0]);
    const recorded = JSON.parse(run.artifact("dispatch-inputs.json"));
    assert.equal(recorded.correlation_id, "bridge:deploy-42/a+b=c");
    assert.deepEqual(recorded, run.inputs);
    assert.equal(Object.keys(recorded).length, 10);
  } finally {
    run.cleanup();
  }
  for (const spec of AI) {
    const text = sourceOf(spec);
    const bodyStart = text.indexOf("\n---\n", 4) + 5;
    const uses = text.slice(0, bodyStart).split("\n").filter((line) => /correlation_id|CORRELATION_ID/.test(line));
    assert.ok(uses.length > 0, `${spec.id}: the id is carried`);
    for (const line of uses) {
      const trimmed = line.trim();
      const carried =
        /^correlation_id:$/.test(trimmed) || // the declaration of the input
        /CORRELATION_ID: \$\{\{ inputs\.correlation_id \}\}/.test(trimmed) || // the binding
        /correlation_id: e\.CORRELATION_ID/.test(trimmed) || // the record for the agent
        /UPSTREAM_ETAG: e\.UPSTREAM_ETAG|upstream_etag: e\.UPSTREAM_ETAG/.test(trimmed); // (the same record program)
      assert.ok(carried, `${spec.id}: ${trimmed}`);
    }
    // the prompt only names it: the pull-request body lists it, and the evidence file holds it
    for (const line of text.slice(bodyStart).split("\n").filter((candidate) => /correlation_id/.test(candidate))) {
      assert.equal(/correlation_id\s*[:=]/.test(line), false, `${spec.id}: the prompt assigns no id: ${line}`);
    }
  }
});

test("AC71: no rendered step runs git push, a merge, an issue or pull-request command, or a gh api request with a write method against the downstream repository; the only write path is the safe output", () => {
  for (const spec of AI) {
    const text = [...scriptsOf(spec), workflowOf(spec).body].join("\n");
    for (const banned of ["git push", "gh pr merge", "gh pr create", "gh pr edit", "gh issue", "gh release", "gh workflow run", "--method", "-X POST", "-X PATCH", "-X PUT", "-X DELETE"]) {
      assert.equal(text.includes(banned), false, `${spec.id}: ${banned}`);
    }
    for (const script of scriptsOf(spec)) {
      for (const line of script.split("\n").filter((candidate) => /(?:^|[\s;&|(`])gh\s/.test(candidate))) {
        assert.match(line, /gh api "repos\/[^"]+"/, `${spec.id}: the only gh call is a plain GET: ${line}`);
        assert.equal(/\s(-f|-F|--field|--raw-field|--input)\b/.test(line), false, `${spec.id}: ${line}`);
      }
    }
    const { frontmatter } = workflowOf(spec);
    assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["auto-merge"], false);
    assert.deepEqual(Object.keys(frontmatter["safe-outputs"]).filter((name) => name !== "github-app" && name !== "threat-detection").sort(), ["create-pull-request"], `${spec.id}: the only handler`);
  }
});
