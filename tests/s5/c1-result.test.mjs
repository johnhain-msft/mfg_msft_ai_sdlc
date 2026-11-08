// AC37 and AC38: S5 validates the ReconcileResult of S1 (a malformed response, `status: "ok"` with an invalid entry and
// `status: "error"` are all failures), reports the lockYml values as compiledWorkflows on success, and on a failure prints every
// error with its file and a Remediation section, leaves .github/workflows/ and schemas/ alone and, for the onboarding,
// puts sdlc.yaml and instructions/<projectKey>.md back to their previous bytes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { reconcileResultProblems, sendToReconciler } from "../../bin/lib/reconcile-client.mjs";
import { createLogger } from "../../bin/lib/logger.mjs";
import { Capture, createScenario, errorResult, fixtureRepos } from "./helpers/harness.mjs";

const REPOS = fixtureRepos({ "example-owner/node-app": "node-app" });
const entry = (name) => ({ sourceMd: `.github/workflows/${name}.md`, lockYml: `.github/workflows/${name}.lock.yml` });
const validResult = (names = ["drift-alpha-service", "cascade-router"]) => ({
  status: "ok",
  generatedWorkflows: names.map(entry),
  repoConfigPath: ".github/workflows/aw.json",
  validationResults: names.map((name) => ({ file: `.github/workflows/${name}.md`, valid: true, errors: [] })),
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const without = (result, key) => {
  const copy = { ...result };
  delete copy[key];
  return copy;
};

/** A scenario whose working copy is committed and holds files under .github/workflows and schemas, as the real repository does. */
async function committedScenario(options = {}) {
  const scenario = await createScenario(options);
  scenario.workspace.write(".github/workflows/aw.json", '{ "strict": true }\n');
  scenario.workspace.write(".github/workflows/drift-alpha-service.md", "---\non: workflow_dispatch\n---\nfixture\n");
  scenario.workspace.write("schemas/sdlc.schema.json", '{ "type": "object" }\n');
  scenario.workspace.commitAll();
  return scenario;
}

const bootstrapRun = (scenario) => scenario.bootstrap(["--non-interactive"], { env: scenario.env(scenario.appCredentials()) });
const onboardRun = (scenario) => scenario.onboard(["--repo", "example-owner/node-app"], { env: scenario.env(scenario.appCredentials()) });

// --- AC37 ------------------------------------------------------------------------------------------------------------------

for (const [entryPoint, run] of [
  ["bootstrap", bootstrapRun],
  ["onboard", onboardRun],
]) {
  test(`AC37: ${entryPoint}: a valid result is accepted and the lockYml values become compiledWorkflows (sorted, lockYml only)`, async () => {
    const scenario = await createScenario({ fake: { repos: REPOS }, reconcile: () => validResult(["zeta-flow", "alpha-flow", "drift-node-app"]) });
    try {
      const result = await run(scenario);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.compiledWorkflows, [".github/workflows/alpha-flow.lock.yml", ".github/workflows/drift-node-app.lock.yml", ".github/workflows/zeta-flow.lock.yml"]);
      assert.equal(JSON.stringify(report).includes(".md"), false, "no sourceMd is reported");
    } finally {
      await scenario.cleanup();
    }
  });

  for (const [label, makeResult, pattern] of [
    ["a result without validationResults", () => without(validResult(), "validationResults"), /malformed ReconcileResult.*no 'validationResults'/],
    ["status ok with a valid:false entry", () => ({ ...validResult(), validationResults: [{ file: ".github/workflows/drift-alpha-service.md", valid: false, errors: ["fixture compile error"] }] }), /fixture compile error/],
    ["status error", () => errorResult(["fixture S1 error"]), /fixture S1 error/],
    ["a result that is not an object", () => "ok", /not an object/],
    ["a null result", () => null, /not an object/],
    ["a status outside ok and error", () => ({ ...validResult(), status: "success" }), /status 'success' is not "ok" or "error"/],
    ["a generatedWorkflows that is not an array of { sourceMd, lockYml }", () => ({ ...validResult(), generatedWorkflows: [{ sourceMd: "a.md" }] }), /generatedWorkflows is not an array/],
    ["a repoConfigPath that is not a string", () => ({ ...validResult(), repoConfigPath: 7 }), /repoConfigPath is not a string/],
    ["a validation entry whose errors are not strings", () => ({ ...validResult(), validationResults: [{ file: "a", valid: true, errors: [1] }] }), /validationResults is not an array/],
    ["a result with a key beyond the four of the contract", () => ({ ...validResult(), extra: true }), /unexpected key 'extra'/],
  ]) {
    test(`AC37: ${entryPoint}: ${label} is a failure: non-zero exit, no report, no readiness check`, async () => {
      const scenario = await createScenario({ fake: { repos: REPOS }, reconcile: makeResult });
      try {
        const result = await run(scenario);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, pattern);
        assert.equal(result.stdout, "", "no report is printed");
        assert.deepEqual(scenario.gh.calls("aw", "validate"), []);
        assert.deepEqual(scenario.gh.calls("aw", "doctor"), []);
      } finally {
        await scenario.cleanup();
      }
    });
  }

  test(`AC37: ${entryPoint}: an exception thrown by the reconciler is a failure, not a crash`, async () => {
    const scenario = await createScenario({
      fake: { repos: REPOS },
      reconcile: () => {
        throw new Error("fixture reconciler exploded");
      },
    });
    try {
      const result = await run(scenario);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /src\/reconcile\.mjs failed unexpectedly: fixture reconciler exploded/);
      assert.equal(result.stdout, "");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC37: reconcileResultProblems lists every problem of a malformed response and none for a valid one", () => {
  assert.deepEqual(reconcileResultProblems(validResult()), []);
  assert.deepEqual(reconcileResultProblems(errorResult(["x"])), []);
  const problems = reconcileResultProblems({ status: "nope", generatedWorkflows: "x", validationResults: [] });
  assert.ok(problems.some((line) => /repoConfigPath/.test(line)));
  assert.ok(problems.some((line) => /status 'nope'/.test(line)));
  assert.ok(problems.some((line) => /generatedWorkflows/.test(line)));
});

test("AC37: sendToReconciler passes the request, the working copy, the environment and a log function to the reconciler", async () => {
  const seen = [];
  const logs = new Capture();
  const outcome = await sendToReconciler({
    request: { marker: 1 },
    reconcile: async (request, options) => {
      seen.push([request, options.cwd, options.env.MARKER, typeof options.log]);
      options.log("progress from S1");
      return validResult(["only"]);
    },
    cwd: "/work",
    env: { MARKER: "m" },
    logger: createLogger(logs),
    restored: "",
  });
  assert.deepEqual(seen, [[{ marker: 1 }, "/work", "m", "function"]]);
  assert.deepEqual(outcome.compiledWorkflows, [".github/workflows/only.lock.yml"]);
  assert.match(logs.text, /progress from S1/);
});

// --- AC38 ------------------------------------------------------------------------------------------------------------------

const S1_FAILURES = [
  { label: "a schema error", errors: ["/projects/0/driftAudit/schedule must match pattern \"^(\\S+\\s+){4}\\S+$\"", "/dependencyEdges/1/reviewers must NOT have fewer than 1 items"], file: "sdlc.yaml" },
  { label: "a permission excess", errors: ["permissions.administration: write exceeds securityBaseline.grantedAppPermissions (allowed: none)"], file: ".github/workflows/drift-alpha-service.md" },
  { label: "an enabled auto-merge", errors: ["safe-outputs.create-pull-request.auto-merge: true is forbidden by securityBaseline.forbidAutoMerge"], file: ".github/workflows/cascade-router.md" },
  { label: "a compile ValidationResult error", errors: ["strict mode: network.allowed must list explicit domains", "strict mode: wildcard domain *.example.com is not allowed"], file: ".github/workflows/drift-alpha-service.md" },
];

for (const { label, errors, file } of S1_FAILURES) {
  const answer = () => ({ ...errorResult(errors, file), validationResults: [{ file, valid: false, errors }, { file: ".github/workflows/other.md", valid: true, errors: [] }] });

  test(`AC38: bootstrap: ${label}: non-zero exit, every error with its file, a Remediation section addressed to external:operator, nothing compiled, workflows and schemas as they were`, async () => {
    const scenario = await committedScenario({ reconcile: answer });
    try {
      const result = await bootstrapRun(scenario);
      assert.notEqual(result.code, 0);
      for (const error of errors) assert.ok(result.stderr.includes(`${file}: ${error}`), `stderr names ${file} and ${error}\n${result.stderr}`);
      assert.match(result.stderr, /Remediation \(external:operator\):/);
      assert.match(result.stderr, /no workflow was compiled/);
      assert.equal(result.stdout, "", "no workflow is reported as compiled");
      assert.doesNotThrow(() => git(scenario.workspace.dir, "diff", "--exit-code", "--", ".github/workflows", "schemas"));
      assert.equal(git(scenario.workspace.dir, "status", "--porcelain", "--untracked-files=all"), "", "the working copy is untouched");
    } finally {
      await scenario.cleanup();
    }
  });

  test(`AC38: onboard: ${label}: the same, and sdlc.yaml is byte-identical to its original with no instructions file left behind`, async () => {
    const scenario = await committedScenario({ fake: { repos: REPOS }, reconcile: answer });
    try {
      const before = scenario.workspace.read("sdlc.yaml");
      const result = await onboardRun(scenario);
      assert.notEqual(result.code, 0);
      for (const error of errors) assert.ok(result.stderr.includes(`${file}: ${error}`));
      assert.match(result.stderr, /Remediation \(external:operator\):/);
      assert.equal(result.stdout, "");
      assert.equal(Buffer.from(scenario.workspace.read("sdlc.yaml")).equals(Buffer.from(before)), true, "sdlc.yaml is byte-identical");
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false, "the instructions file was not left behind");
      assert.match(result.stderr, /were restored to their previous bytes/);
      assert.doesNotThrow(() => git(scenario.workspace.dir, "diff", "--exit-code", "--", ".github/workflows", "schemas"));
      assert.equal(git(scenario.workspace.dir, "status", "--porcelain", "--untracked-files=all"), "", "the working copy is as committed");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC38: onboard: an instructions file that existed before the run gets its previous bytes back, not the regenerated ones", async () => {
  const scenario = await committedScenario({ fake: { repos: REPOS }, reconcile: () => errorResult(["sdlc.yaml: fixture schema error"]) });
  try {
    const previous = "Operator notes that were here before.\r\nSecond line without the generated section.\n";
    scenario.workspace.write("instructions/node-app.md", previous);
    scenario.workspace.commitAll("existing instructions");
    const result = await onboardRun(scenario);
    assert.notEqual(result.code, 0);
    assert.equal(scenario.workspace.read("instructions/node-app.md"), previous);
    assert.equal(git(scenario.workspace.dir, "status", "--porcelain", "--untracked-files=all"), "");
  } finally {
    await scenario.cleanup();
  }
});

test("AC38: onboard: an entry that did not exist before is not left in sdlc.yaml when S1 rejects", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS }, reconcile: () => errorResult(["sdlc.yaml: fixture schema error"]) });
  try {
    const result = await onboardRun(scenario);
    assert.notEqual(result.code, 0);
    assert.equal(scenario.workspace.read("sdlc.yaml").includes("node-app"), false);
  } finally {
    await scenario.cleanup();
  }
});

test("AC38: an error without any diagnostic still fails and says so", async () => {
  const scenario = await createScenario({ reconcile: () => ({ status: "error", generatedWorkflows: [], repoConfigPath: ".github/workflows/aw.json", validationResults: [] }) });
  try {
    const result = await bootstrapRun(scenario);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /reported an error without a diagnostic/);
  } finally {
    await scenario.cleanup();
  }
});

test("AC38: status ok with an invalid entry prints that entry's errors too", async () => {
  const scenario = await createScenario({ reconcile: () => ({ ...validResult(), validationResults: [{ file: "a.md", valid: false, errors: ["first problem", "second problem"] }] }) });
  try {
    const result = await bootstrapRun(scenario);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /status ok with an invalid validation result/);
    assert.ok(result.stderr.includes("a.md: first problem") && result.stderr.includes("a.md: second problem"));
  } finally {
    await scenario.cleanup();
  }
});
