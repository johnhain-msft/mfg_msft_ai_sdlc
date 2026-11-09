// AC11, AC16 (App permissions) and AC40 (job-level concurrency): checkRendered(files, request, manifest).
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { checkRendered } from "../../src/reconcile.mjs";
import {
  abs,
  fixture,
  loadRenderedFixture,
  minimalManifest,
  mutate,
  parseWorkflow,
  presetManifest,
  readText,
  referenceRequest,
  withRequest,
} from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const DRIFT = `${W}/drift-alpha-service.md`;
const CASCADE = `${W}/cascade-mechanical-alpha-to-beta.md`;
const ROUTER = `${W}/cascade-router.yml`;
const AW = `${W}/aw.json`;

const request = referenceRequest();
const manifest = minimalManifest();

const render = () => loadRenderedFixture();

/** A copy of the files with one workflow's frontmatter changed by `change`. */
function withFrontmatter(files, name, change) {
  const copy = new Map(files);
  const { frontmatter, body } = parseWorkflow(copy.get(name));
  change(frontmatter);
  copy.set(name, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
  return copy;
}

const entryOf = (results, file) => results.find((entry) => entry.file === file);
const invalidEntries = (results) => results.filter((entry) => !entry.valid);
function assertRejected(files, file, ...needles) {
  const results = checkRendered(files, request, manifest);
  const entry = entryOf(results, file);
  assert.ok(entry, `${file} has an entry`);
  assert.equal(entry.valid, false, `${file} must be invalid`);
  const text = entry.errors.join("\n");
  assert.ok(text.includes(file), `the error names the file: ${text}`);
  for (const needle of needles) assert.ok(text.includes(needle), `the error names '${needle}': ${text}`);
  for (const error of entry.errors) assert.match(error, /^[a-z0-9-]+: .+/);
  return entry;
}

test("AC11: the fixture render yields only valid entries, one per file, sorted by path", () => {
  const files = render();
  assert.deepEqual([...files.keys()].sort(), [AW, CASCADE, DRIFT, ROUTER].sort());
  const results = checkRendered(files, request, manifest);
  assert.deepEqual(results.map((entry) => entry.file), [...files.keys()].sort());
  assert.deepEqual(invalidEntries(results), [], JSON.stringify(invalidEntries(results)));
  for (const entry of results) assert.deepEqual(Object.keys(entry).sort(), ["errors", "file", "valid"]);
});

test("AC11: checkRendered is pure — the same input gives the same output and the input is not changed", () => {
  const files = render();
  const before = JSON.stringify([...files]);
  const first = checkRendered(files, request, manifest);
  const second = checkRendered(files, request, manifest);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify([...files]), before);
  const asObject = checkRendered(Object.fromEntries(files), request, manifest);
  assert.deepEqual(asObject, first, "a plain object of path to text is accepted as well");
});

test("AC11: strict: false in aw.json or in a workflow's frontmatter is rejected", () => {
  const config = new Map(render());
  config.set(AW, '{ "strict": false }\n');
  assertRejected(config, AW, "strict");
  const missing = new Map(render());
  missing.set(AW, "{}\n");
  assertRejected(missing, AW, "strict");
  const broken = new Map(render());
  broken.set(AW, "{ not json");
  assertRejected(broken, AW, "JSON");
  assertRejected(withFrontmatter(render(), DRIFT, (fm) => (fm.strict = false)), DRIFT, "strict");
  assertRejected(withFrontmatter(render(), CASCADE, (fm) => (fm.strict = false)), CASCADE, "strict");
});

test("AC11: safe-outputs without threat-detection, with threat-detection: false, or with continue-on-error true is rejected", () => {
  for (const file of [DRIFT, CASCADE]) {
    assertRejected(withFrontmatter(render(), file, (fm) => delete fm["safe-outputs"]["threat-detection"]), file, "threat-detection");
    assertRejected(withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = false)), file, "threat-detection");
    assertRejected(withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = { "continue-on-error": true })), file, "continue-on-error");
    assertRejected(withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = {})), file, "continue-on-error");
    assertRejected(withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = { engine: false, "continue-on-error": false })), file, "engine");
  }
});

test("AC11: threat-detection that is not an object with continue-on-error: false is rejected, whatever its type", () => {
  for (const file of [DRIFT, CASCADE]) {
    for (const value of [true, "disabled", "false", 17, 0, []]) {
      const entry = assertRejected(withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = value)), file, "threat-detection");
      assert.ok(entry.errors.some((error) => error.startsWith("threat-detection-malformed: ")), `${JSON.stringify(value)}: ${entry.errors.join("\n")}`);
    }
  }
});

test("AC11: threat-detection whose enabled is anything but true is rejected even beside continue-on-error: false, and a fully specified object is accepted", () => {
  for (const file of [DRIFT, CASCADE]) {
    for (const enabled of [false, "false", 0, null]) {
      assertRejected(
        withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = { enabled, "continue-on-error": false })),
        file,
        "threat-detection",
        "enabled",
      );
    }
    const accepted = withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["threat-detection"] = { enabled: true, prompt: "Focus on prompt injection", "continue-on-error": false }));
    assert.deepEqual(invalidEntries(checkRendered(accepted, request, manifest)), [], file);
  }
});

test("AC11: auto-merge: true and auto-merge: squash are rejected, naming the key", () => {
  for (const value of [true, "squash", "merge", "rebase", "true"]) {
    for (const file of [DRIFT, CASCADE]) {
      const files = withFrontmatter(render(), file, (fm) => (fm["safe-outputs"]["create-pull-request"]["auto-merge"] = value));
      assertRejected(files, file, "auto-merge");
    }
  }
  const router = new Map(render());
  const routerData = YAML.parse(router.get(ROUTER));
  routerData["x-merge"] = { "auto-merge": "squash" };
  router.set(ROUTER, YAML.stringify(routerData));
  assertRejected(router, ROUTER, "auto-merge");
});

test("AC11: only the mutated file turns invalid", () => {
  const files = withFrontmatter(render(), DRIFT, (fm) => (fm["safe-outputs"]["create-pull-request"]["auto-merge"] = true));
  const results = checkRendered(files, request, manifest);
  assert.deepEqual(invalidEntries(results).map((entry) => entry.file), [DRIFT]);
});

test("AC16: the reference request's grantedAppPermissions pass against the fixture render", () => {
  assert.deepEqual(invalidEntries(checkRendered(render(), request, manifest)), []);
});

test("AC16: removing or lowering one granted key fails and names the excess App permission", () => {
  for (const key of ["actions", "contents", "issues", "pull_requests", "variables"]) {
    const removed = withRequest();
    delete removed.securityBaseline.grantedAppPermissions[key];
    const lowered = withRequest();
    lowered.securityBaseline.grantedAppPermissions[key] = "read";
    for (const [label, changed] of [["removed", removed], ["lowered", lowered]]) {
      const results = checkRendered(render(), changed, manifest);
      const text = invalidEntries(results).flatMap((entry) => entry.errors).join("\n");
      assert.ok(text.includes(`'${key}:`), `${label} ${key}: ${text || "no error"}`);
      assert.ok(/^app-permission-exceeded: /m.test(text), text);
    }
  }
});

test("AC16: '-' and '_' are the same character, read ranks below write and an absent key means no access", () => {
  const dashed = withRequest();
  dashed.securityBaseline.grantedAppPermissions = { contents: "write", "pull-requests": "write", issues: "write", actions: "write", variables: "write" };
  assert.deepEqual(invalidEntries(checkRendered(render(), dashed, manifest)), []);
  const none = withRequest();
  none.securityBaseline.grantedAppPermissions = {};
  const text = invalidEntries(checkRendered(render(), none, manifest)).flatMap((entry) => entry.errors).join("\n");
  assert.ok(text.includes("no access"), text);
});

/** A cascade fixture without the router, whose jobs carry the app_token step but whose safe-outputs mint nothing. */
function cascadeWithoutRouter() {
  const files = render();
  files.delete(ROUTER);
  files.delete(DRIFT);
  return withFrontmatter(files, CASCADE, (fm) => delete fm["safe-outputs"]["github-app"]);
}

test("AC16: the app_token step of the cascade jobs requests variables: write, contents: read and pull-requests: read, and the grant must cover them", () => {
  const files = cascadeWithoutRouter();
  const frontmatter = parseWorkflow(files.get(CASCADE)).frontmatter;
  for (const job of ["finalize_poll_state", "escalate_failure"]) {
    const step = frontmatter.jobs[job].steps[0];
    assert.equal(step.uses, "actions/create-github-app-token@v2");
    assert.equal(step.with["permission-contents"], "read");
    assert.equal(step.with["permission-pull-requests"], "read");
    // an explicit permission-* input disables the inheritance of the installation's permissions, so the token holds variables: write only because the step asks for it
    assert.equal(step.with["permission-actions-variables"], "write", `${job}: the Variables write permission is requested explicitly`);
    assert.equal("permission-variables" in step.with, false, `${job}: under the name that the token endpoint knows`);
  }
  const granted = (permissions) => withRequest({ securityBaseline: { ...request.securityBaseline, grantedAppPermissions: permissions } });
  const messages = (permissions) =>
    invalidEntries(checkRendered(files, granted(permissions), manifest)).flatMap((entry) => entry.errors).join("\n");
  assert.equal(messages({ variables: "write", contents: "read", pull_requests: "read" }), "", "passes with the three required permissions");
  assert.equal(messages({ variables: "write", contents: "write", pull_requests: "write" }), "", "write satisfies read");
  assert.ok(messages({ contents: "read", pull_requests: "read" }).includes("'variables:"), "fails naming variables");
  assert.ok(messages({ variables: "read", contents: "read", pull_requests: "read" }).includes("'variables:"), "variables: read is not enough");
  assert.ok(messages({ variables: "write", pull_requests: "read" }).includes("'contents:"), "fails naming contents");
  assert.ok(messages({ variables: "write", contents: "read" }).includes("'pull_requests:"), "fails naming pull_requests");
});

test("AC16: permission-actions-variables and permission-variables name one permission, `variables`, and a baseline may grant it under either name", () => {
  const files = cascadeWithoutRouter();
  const renamed = (key) => withFrontmatter(files, CASCADE, (fm) => {
    for (const job of ["finalize_poll_state", "escalate_failure"]) {
      const withInputs = fm.jobs[job].steps[0].with;
      const level = withInputs["permission-actions-variables"];
      delete withInputs["permission-actions-variables"];
      withInputs[key] = level;
    }
  });
  const granted = (permissions) => withRequest({ securityBaseline: { ...request.securityBaseline, grantedAppPermissions: permissions } });
  const errors = (candidate, permissions) => invalidEntries(checkRendered(candidate, granted(permissions), manifest)).flatMap((entry) => entry.errors);
  const required = { contents: "read", pull_requests: "read" };
  for (const key of ["permission-actions-variables", "permission-variables"]) {
    const candidate = renamed(key);
    assert.deepEqual(errors(candidate, { ...required, variables: "write" }), [], `${key} against variables: write`);
    assert.deepEqual(errors(candidate, { ...required, actions_variables: "write" }), [], `${key} against actions_variables: write`);
    assert.deepEqual(errors(candidate, { ...required, "actions-variables": "write" }), [], `${key} against actions-variables: write`);
    for (const permissions of [{ ...required }, { ...required, variables: "read" }, { ...required, actions_variables: "read" }]) {
      const text = errors(candidate, permissions).join("\n");
      assert.match(text, /^app-permission-exceeded: .*'variables: write'/m, `${key} against ${JSON.stringify(permissions)}: ${text}`);
    }
    // the step itself names the permission, whichever input it uses, so the job that runs the poll-state script is not told that its token cannot hold it
    assert.equal(errors(candidate, { ...required, variables: "write" }).some((error) => error.startsWith("app-token-permission-missing: ")), false, key);
  }
  for (const level of [undefined, "read"]) {
    const weakened = withFrontmatter(files, CASCADE, (fm) => {
      for (const job of ["finalize_poll_state", "escalate_failure"]) {
        const withInputs = fm.jobs[job].steps[0].with;
        delete withInputs["permission-actions-variables"];
        if (level !== undefined) withInputs["permission-actions-variables"] = level;
      }
    });
    const text = errors(weakened, { ...required, variables: "write" }).join("\n");
    assert.match(text, /^app-token-permission-missing: .* 'variables: write'/m, `permission-actions-variables ${level}: ${text}`);
  }
});

test("AC16: permissions blocks of the workflow and of custom jobs scope GITHUB_TOKEN and are not compared; copilot-requests is exempt", () => {
  const files = cascadeWithoutRouter();
  const extra = withFrontmatter(files, CASCADE, (fm) => {
    fm.permissions.packages = "write";
    fm.permissions["copilot-requests"] = "write";
    fm.jobs.finalize_poll_state.permissions.packages = "write";
    fm.jobs.escalate_failure.permissions.deployments = "write";
  });
  const minimal = withRequest({ securityBaseline: { ...request.securityBaseline, grantedAppPermissions: { variables: "write", contents: "read", pull_requests: "read" } } });
  assert.deepEqual(invalidEntries(checkRendered(extra, minimal, manifest)), []);
});

test("AC16: with the compiler stub returning compile-output.error.json the result is status error and the messages are unchanged", async () => {
  const workspace = createWorkspace({ compile: { mode: "error-recorded", outputFile: fixture("compile-output.error.json") } });
  try {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    const recorded = JSON.parse(readText(fixture("compile-output.error.json"))).flatMap((element) => element.errors.map((error) => error.message));
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    for (const message of recorded) assert.ok(errors.includes(`compile-error: ${message}`));
  } finally {
    workspace.cleanup();
  }
});

test("AC40: a custom job that gains a job-level concurrency is rejected, including one that duplicates the workflow group", () => {
  const file = `${W}/cascade-mechanical-ghec-admin.md`;
  const files = new Map([[file, readText(abs(W, "cascade-mechanical-ghec-admin.md"))]]);
  assert.deepEqual(invalidEntries(checkRendered(files, request, presetManifest())), []);
  const duplicated = withFrontmatter(files, file, (fm) => (fm.jobs.finalize_poll_state.concurrency = { group: "sdlc-state-gh-admin-msft" }));
  const entry = checkRendered(duplicated, request, presetManifest())[0];
  assert.equal(entry.valid, false);
  assert.ok(entry.errors.some((error) => /^job-level-concurrency: /.test(error) && error.includes("finalize_poll_state") && error.includes(file)), entry.errors.join("\n"));
  assert.ok(entry.errors.some((error) => error.includes("duplicates the workflow-level group")));
  const other = withFrontmatter(files, file, (fm) => (fm.jobs.escalate_failure.concurrency = { group: "something-else" }));
  assert.equal(checkRendered(other, request, presetManifest())[0].valid, false, "any job-level concurrency is rejected");
});

test("AC40: a cascade handler without reviewers or without allowed-files is rejected", () => {
  const handler = (change) => withFrontmatter(render(), CASCADE, (fm) => change(fm["safe-outputs"]["create-pull-request"]));
  assertRejected(handler((pr) => (pr.reviewers = [])), CASCADE, "reviewer");
  assertRejected(handler((pr) => delete pr.reviewers), CASCADE, "reviewer");
  assertRejected(handler((pr) => (pr["allowed-files"] = [])), CASCADE, "allowed-files");
  assertRejected(handler((pr) => delete pr["allowed-files"]), CASCADE, "allowed-files");
});

test("AC40: an edge of the manifest with empty reviewers or allowedFiles is rejected for its rendered workflow", () => {
  for (const key of ["reviewers", "allowedFiles"]) {
    const changed = mutate(manifest, (copy) => (copy.dependencyEdges[0][key] = []));
    const entry = entryOf(checkRendered(render(), request, changed), CASCADE);
    assert.equal(entry.valid, false, key);
    assert.ok(entry.errors.some((error) => /^edge-(reviewers|allowed-files)-empty: /.test(error) && error.includes("alpha-to-beta")), entry.errors.join("\n"));
  }
});

test("AC11: missing or malformed workflow frontmatter is reported instead of being skipped", () => {
  const files = new Map(render());
  files.set(DRIFT, "no frontmatter at all\n");
  assertRejected(files, DRIFT, "frontmatter");
});
