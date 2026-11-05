// AC8, AC9, AC10 and AC71: the BootstrapReconcileRequest contract (C1) and the engine authentication wiring.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { clone, minimalManifest, mutate, parseWorkflow, presetManifest, readText, referenceRequest, toYaml, withRequest } from "./helpers/fixtures.mjs";
import { recordWrites } from "./helpers/fs-spy.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const REQUEST_FILE = "BootstrapReconcileRequest";
const CLIENT_ID = "${{ vars.APP_CLIENT_ID }}";
const PRIVATE_KEY = "${{ secrets.APP_PRIVATE_KEY }}";

let shared;
before(() => {
  shared = createWorkspace();
  shared.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
});
after(() => shared.cleanup());

async function expectRequestError(request, label) {
  const before = shared.hash();
  const result = await shared.reconcile(request);
  assert.equal(result.status, "error", label);
  assert.deepEqual(result.generatedWorkflows, [], label);
  assert.equal(result.validationResults.length, 1, `${label}: exactly one validationResults entry`);
  assert.equal(result.validationResults[0].file, REQUEST_FILE, label);
  assert.equal(result.validationResults[0].valid, false, label);
  assert.ok(result.validationResults[0].errors.length > 0, label);
  assert.equal(shared.hash(), before, `${label}: .github is unchanged`);
  assert.equal(shared.shims.compileCalls().length, 0, `${label}: the compiler is never reached`);
  return result;
}

const mdNames = (workspace) =>
  workspace.list(".github/workflows").filter((file) => file.endsWith(".md") && !file.includes("/shared/")).map((file) => file.split("/").pop());
const readAll = (workspace) => mdNames(workspace).map((name) => ({ name, ...parseWorkflow(workspace.read(`.github/workflows/${name}`)) }));

function collectKey(value, key, found = []) {
  if (Array.isArray(value)) value.forEach((item) => collectKey(item, key, found));
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      if (name === key) found.push(item);
      collectKey(item, key, found);
    }
  }
  return found;
}

test("AC8: the reference request has exactly the nine keys of contract C1 and is accepted", async () => {
  const request = referenceRequest();
  assert.deepEqual(
    Object.keys(request).sort(),
    ["appClientIdVar", "appPrivateKeySecret", "appSlug", "dryRun", "engineAuthMode", "ghAwVersionPin", "manifestPath", "pollStateVarPrefix", "securityBaseline"],
  );
  assert.deepEqual(Object.keys(request.securityBaseline).sort(), [
    "forbidAutoMerge",
    "grantedAppPermissions",
    "minGhAwVersion",
    "requireStrictMode",
    "requireThreatDetection",
  ]);
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
  } finally {
    workspace.cleanup();
  }
});

test("AC8: a request that omits any field is rejected", async () => {
  for (const key of Object.keys(referenceRequest())) {
    const request = withRequest({ [key]: undefined });
    await expectRequestError(request, `omitting ${key}`);
  }
  for (const key of Object.keys(referenceRequest().securityBaseline)) {
    const request = withRequest();
    delete request.securityBaseline[key];
    await expectRequestError(request, `omitting securityBaseline.${key}`);
  }
});

test("AC8: a request that adds a field is rejected, at the top level and inside securityBaseline", async () => {
  const result = await expectRequestError(withRequest({ unexpected: 1 }), "extra top-level field");
  assert.ok(result.validationResults[0].errors.some((error) => error.includes("unexpected")));
  const nested = withRequest();
  nested.securityBaseline.unexpected = true;
  await expectRequestError(nested, "extra securityBaseline field");
});

test("AC8: values outside an enum, wrong types and wrong literals are rejected", async () => {
  const cases = {
    "engineAuthMode oauth": withRequest({ engineAuthMode: "oauth" }),
    "pollStateVarPrefix X_": withRequest({ pollStateVarPrefix: "X_" }),
    "dryRun yes": withRequest({ dryRun: "yes" }),
    "manifestPath number": withRequest({ manifestPath: 5 }),
    "appSlug number": withRequest({ appSlug: 5 }),
    "appClientIdVar number": withRequest({ appClientIdVar: 5 }),
    "appPrivateKeySecret object": withRequest({ appPrivateKeySecret: {} }),
    "ghAwVersionPin number": withRequest({ ghAwVersionPin: 101 }),
    "request is not an object": "not a request",
    "request is null": null,
    "request is an array": [],
  };
  const baseline = (patch) => {
    const request = withRequest();
    Object.assign(request.securityBaseline, patch);
    return request;
  };
  cases["minGhAwVersion 1.0.0"] = baseline({ minGhAwVersion: "1.0.0" });
  cases["requireStrictMode false"] = baseline({ requireStrictMode: false });
  cases["requireThreatDetection false"] = baseline({ requireThreatDetection: false });
  cases["forbidAutoMerge false"] = baseline({ forbidAutoMerge: false });
  cases["grantedAppPermissions admin"] = baseline({ grantedAppPermissions: { contents: "admin" } });
  cases["grantedAppPermissions array"] = baseline({ grantedAppPermissions: [] });
  for (const [label, request] of Object.entries(cases)) await expectRequestError(request, label);
});

test("AC9: every generated workflow allowlists the App sender and references the App credentials by name only", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    const workflows = readAll(workspace);
    assert.equal(workflows.length, 8);
    for (const { name, frontmatter } of workflows) {
      assert.deepEqual(frontmatter.on.bots, ["fixture-app[bot]"], `${name} on.bots`);
      const blocks = collectKey(frontmatter, "github-app");
      assert.ok(blocks.length >= 2, `${name} has github-app blocks`);
      for (const block of blocks) assert.deepEqual(block, { "client-id": CLIENT_ID, "private-key": PRIVATE_KEY }, `${name} github-app`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC9: the App credential names come from the request", async () => {
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(withRequest({ appSlug: "Other-App-2", appClientIdVar: "MY_CLIENT_ID", appPrivateKeySecret: "MY_PRIVATE_KEY" }));
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const { name, frontmatter } of readAll(workspace)) {
      assert.deepEqual(frontmatter.on.bots, ["Other-App-2[bot]"], name);
      for (const block of collectKey(frontmatter, "github-app")) {
        assert.deepEqual(block, { "client-id": "${{ vars.MY_CLIENT_ID }}", "private-key": "${{ secrets.MY_PRIVATE_KEY }}" }, name);
      }
    }
    for (const file of workspace.list(".github/workflows").filter((name) => name.endsWith(".md"))) {
      const text = workspace.read(file);
      assert.equal(text.includes("vars.APP_CLIENT_ID") || text.includes("secrets.APP_PRIVATE_KEY"), false, `${file} still references the default names`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC9: an appSlug that is empty or has a character other than ASCII letters, digits and '-' is rejected", async () => {
  for (const bad of ["bad slug]", "", "has_underscore", "dot.ed", "slash/ed", "accénted", "new\nline"]) {
    await expectRequestError(withRequest({ appSlug: bad }), `appSlug ${JSON.stringify(bad)}`);
  }
  const workspace = createWorkspace();
  try {
    const result = await workspace.reconcile(withRequest({ appSlug: "Fixture-App-1" }));
    assert.equal(result.status, "ok");
  } finally {
    workspace.cleanup();
  }
});

test("AC9: an appClientIdVar or appPrivateKeySecret that is not an identifier is rejected", async () => {
  for (const key of ["appClientIdVar", "appPrivateKeySecret"]) {
    for (const bad of ["1BAD", "has-dash", "has space", "", "A}}x", "$(id)"]) {
      await expectRequestError(withRequest({ [key]: bad }), `${key} ${JSON.stringify(bad)}`);
    }
  }
});

test("AC9: the reconciler never calls /app-manifests or /app; its only gh calls are `aw compile`", async () => {
  const workspace = createWorkspace();
  try {
    await workspace.reconcile(referenceRequest());
    const calls = workspace.shims.calls("gh");
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 2), ["aw", "compile"]);
      assert.equal(call.args.some((arg) => /app-manifests|^app$|^\/app$/.test(arg)), false);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC10: a stateVariable that is not pollStateVarPrefix plus upstreamSlug is rejected, naming the edge", async () => {
  const manifest = mutate(presetManifest(), (copy) => {
    copy.dependencyEdges[0].stateVariable = "SDLC_SYNC_STATE_SOMETHING_ELSE";
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const before = workspace.hash();
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^edge-state-variable: .*ghec-admin.*SDLC_SYNC_STATE_GH_ADMIN_MSFT/.test(error)), errors.join("\n"));
    assert.equal(workspace.hash(), before);
  } finally {
    workspace.cleanup();
  }
});

test("AC10: ghAwVersionPin below securityBaseline.minGhAwVersion is rejected; 1.0.1, v1.0.1 and >=v1.0.1 are accepted", async () => {
  for (const bad of ["0.85.3", ">=v0.9.0", "v1.0.0", ">=1.0.0", "latest", "1.0", ""]) {
    await expectRequestError(withRequest({ ghAwVersionPin: bad }), `ghAwVersionPin ${JSON.stringify(bad)}`);
  }
  for (const good of ["1.0.1", "v1.0.1", ">=v1.0.1", ">=1.0.1", "1.2.0", "v2.0.0"]) {
    const workspace = createWorkspace();
    try {
      const result = await workspace.reconcile(withRequest({ ghAwVersionPin: good }));
      assert.equal(result.status, "ok", `${good}: ${JSON.stringify(result.validationResults)}`);
    } finally {
      workspace.cleanup();
    }
  }
});

test("AC10: with dryRun true no file of the working tree changes, generatedWorkflows is non-empty and no --purge run happens", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
    const hashBefore = workspace.hash();
    const treeBefore = workspace.hash(["."]);
    const statusBefore = workspace.status();
    const result = await workspace.reconcile(withRequest({ dryRun: true }));
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.generatedWorkflows.length, 8);
    assert.equal(workspace.hash(), hashBefore, ".github/workflows is identical");
    assert.equal(workspace.hash(["."]), treeBefore, "the whole working tree is identical");
    assert.equal(workspace.status(), statusBefore);
    const compiles = workspace.shims.compileCalls();
    assert.equal(compiles.length, 1);
    assert.ok(compiles[0].args.includes("--no-emit"), compiles[0].args.join(" "));
    assert.ok(compiles[0].args.includes("--strict") && compiles[0].args.includes("--json"));
    assert.equal(compiles[0].args.includes("--purge"), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC10: a dry run of an invalid manifest still fails and writes nothing", async () => {
  const workspace = createWorkspace({ manifestText: readText(new URL("./fixtures/manifest.invalid-schema.yaml", import.meta.url)) });
  try {
    const before = workspace.hash(["."]);
    const result = await workspace.reconcile(withRequest({ dryRun: true }));
    assert.equal(result.status, "error");
    assert.equal(workspace.hash(["."]), before);
  } finally {
    workspace.cleanup();
  }
});

test("AC10: a dry run whose staging directory cannot be prepared reports an error and never writes into the working tree", async () => {
  const cases = [
    [
      "git exits with a failure",
      (workspace) => {
        const launcher = path.join(workspace.shims.directory, process.platform === "win32" ? "git.cmd" : "git");
        fs.writeFileSync(launcher, process.platform === "win32" ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
        return {};
      },
    ],
    [
      "git cannot be started",
      (workspace) => {
        const empty = path.join(workspace.root, "empty-bin");
        fs.mkdirSync(empty);
        return { PATH: empty, Path: empty };
      },
    ],
  ];
  for (const [label, prepare] of cases) {
    const workspace = createWorkspace();
    try {
      workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
      const environment = prepare(workspace);
      const treeBefore = workspace.hash(["."]);
      let result;
      const writes = await recordWrites(async () => {
        result = await workspace.reconcile(withRequest({ dryRun: true }), environment);
      });
      assert.equal(result.status, "error", label);
      assert.deepEqual(result.generatedWorkflows, [], label);
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => error.startsWith("dry-run-staging-failed: ")), `${label}: ${errors.join(" | ")}`);
      assert.equal(workspace.hash(["."]), treeBefore, `${label}: the working tree is identical`);
      const inside = writes.filter((target) => target.startsWith(`${workspace.dir}${path.sep}`));
      assert.deepEqual(inside, [], `${label}: nothing is written into the working tree, not even temporarily`);
      assert.equal(workspace.shims.compileCalls().length, 0, `${label}: no compiler runs in the working tree`);
    } finally {
      workspace.cleanup();
    }
  }
});

async function renderMode(mode, manifestPatch) {
  const manifest = manifestPatch ? mutate(presetManifest(), manifestPatch) : presetManifest();
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  const result = await workspace.reconcile(withRequest({ engineAuthMode: mode }));
  return { workspace, result };
}

test("AC71: copilot-requests adds the copilot-requests permission and references no secret", async () => {
  const { workspace, result } = await renderMode("copilot-requests");
  try {
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const { name, frontmatter, frontmatterText } of readAll(workspace)) {
      assert.ok(frontmatter.engine, `${name} has an engine key`);
      assert.equal(frontmatter.permissions["copilot-requests"], "write", name);
      assert.equal(JSON.stringify(frontmatter.engine).includes("secrets."), false, `${name}: no secret reference in engine`);
      assert.equal(frontmatterText.includes("COPILOT_GITHUB_TOKEN"), false, name);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC71: copilot-pat references COPILOT_GITHUB_TOKEN and adds no copilot-requests permission", async () => {
  const { workspace, result } = await renderMode("copilot-pat");
  try {
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const { name, frontmatter, frontmatterText } of readAll(workspace)) {
      assert.ok(frontmatter.engine, `${name} has an engine key`);
      assert.ok(JSON.stringify(frontmatter.engine).includes("${{ secrets.COPILOT_GITHUB_TOKEN }}"), name);
      assert.equal("copilot-requests" in frontmatter.permissions, false, name);
      assert.equal(frontmatterText.includes("copilot-requests"), false, name);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC71: api-key without engineApiKeySecret returns status error and with it references the named secret", async () => {
  const missing = await renderMode("api-key");
  try {
    assert.equal(missing.result.status, "error");
    const errors = missing.result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^engine-api-key-secret-missing: /.test(error)), errors.join("\n"));
    assert.deepEqual(missing.workspace.list(".github/workflows"), [], "nothing was written");
  } finally {
    missing.workspace.cleanup();
  }
  const named = await renderMode("api-key", (copy) => {
    copy.engineApiKeySecret = "MY_ENGINE_KEY";
  });
  try {
    assert.equal(named.result.status, "ok", JSON.stringify(named.result.validationResults));
    for (const { name, frontmatter, frontmatterText } of readAll(named.workspace)) {
      assert.ok(frontmatter.engine, `${name} has an engine key`);
      assert.ok(JSON.stringify(frontmatter.engine).includes("${{ secrets.MY_ENGINE_KEY }}"), name);
      assert.equal("copilot-requests" in frontmatter.permissions, false, name);
      assert.equal(frontmatterText.includes("COPILOT_GITHUB_TOKEN"), false, name);
    }
  } finally {
    named.workspace.cleanup();
  }
});

test("AC71: an engineApiKeySecret that is not an identifier fails schema validation", async () => {
  const { workspace, result } = await renderMode("api-key", (copy) => {
    copy.engineApiKeySecret = "not an identifier";
  });
  try {
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("schema-validation: ")));
  } finally {
    workspace.cleanup();
  }
});

test("AC71: no generated file contains a literal credential in any mode", async () => {
  const literal = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN/;
  for (const mode of ["copilot-requests", "copilot-pat"]) {
    const { workspace, result } = await renderMode(mode);
    try {
      assert.equal(result.status, "ok");
      for (const file of workspace.list(".github/workflows")) assert.equal(literal.test(workspace.read(file)), false, `${mode}: ${file}`);
      for (const file of workspace.list(".github/workflows").filter((name) => name.endsWith(".md") || name.endsWith(".yml"))) {
        const outsideExpressions = workspace.read(file).replace(/\$\{\{[^}]*\}\}/g, "");
        assert.equal(/secrets\./.test(outsideExpressions), false, `${mode}: ${file} mentions a secret outside an expression`);
      }
    } finally {
      workspace.cleanup();
    }
  }
});

test("AC71: the engine that an api-key secret selects decides tools.bash: codex renders [\"*\"], every other engine keeps its command allowlist", () => {
  const cases = [
    { mode: "copilot-requests", secret: undefined, engine: "copilot" },
    { mode: "copilot-pat", secret: undefined, engine: "copilot" },
    { mode: "api-key", secret: "ANTHROPIC_API_KEY", engine: "claude" },
    { mode: "api-key", secret: "CLAUDE_CODE_TOKEN", engine: "claude" },
    { mode: "api-key", secret: "GOOGLE_API_KEY", engine: "gemini" },
    { mode: "api-key", secret: "GEMINI_KEY", engine: "gemini" },
    { mode: "api-key", secret: "OPENAI_API_KEY", engine: "codex" },
    { mode: "api-key", secret: "CODEX_TOKEN", engine: "codex" },
    { mode: "api-key", secret: "CUSTOM_PROVIDER_KEY", engine: "claude" },
  ];
  const workspace = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  try {
    for (const edgeMode of ["mechanical", "ai-adaptation"]) {
      for (const { mode, secret, engine } of cases) {
        const label = `${edgeMode} ${mode}${secret ? `/${secret}` : ""}`;
        workspace.write(
          "sdlc.yaml",
          toYaml(
            mutate(minimalManifest(), (copy) => {
              if (secret) copy.engineApiKeySecret = secret;
              copy.dependencyEdges[0].mode = edgeMode;
            }),
          ),
        );
        const result = renderFleet(withRequest({ engineAuthMode: mode }), { cwd: workspace.dir });
        assert.ok(result.ok, `${label}: ${JSON.stringify(result.result)}`);
        const sources = [...result.files].filter(([file]) => file.endsWith(".md"));
        assert.equal(sources.length, 3, `${label}: one drift, one cascade and the onboarding workflow`);
        for (const [file, text] of sources) {
          const { frontmatter } = parseWorkflow(text);
          assert.equal(frontmatter.engine.id, engine, `${label}: ${file} engine`);
          if (engine === "codex") {
            assert.deepEqual(frontmatter.tools.bash, ["*"], `${label}: ${file} cannot carry a command allowlist the compiler would reject`);
          } else {
            assert.ok(frontmatter.tools.bash.includes("git") && !frontmatter.tools.bash.includes("*"), `${label}: ${file} keeps its allowlist`);
          }
        }
      }
    }
  } finally {
    workspace.cleanup();
  }
});

test("a request object is never mutated by reconcile", async () => {
  const request = referenceRequest();
  const copy = clone(request);
  const workspace = createWorkspace();
  try {
    await workspace.reconcile(request);
    assert.deepEqual(request, copy);
  } finally {
    workspace.cleanup();
  }
});
