// Additional failure-path coverage derived from C1 and the implementation, not from compiler success claims.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, reconcile, renderFleet } from "../../src/reconcile.mjs";
import { abs, loadRenderedFixture, minimalManifest, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

function workspace(t, options = {}) {
  const result = createWorkspace({ manifestText: toYaml(minimalManifest()), ...options });
  t.after(() => result.cleanup());
  return result;
}

const errorsOf = (result) => result.validationResults.flatMap((entry) => entry.errors);

test("AC8 QA: null, array and boolean request fields are rejected before writes or compiler execution", async (t) => {
  const work = workspace(t);
  const before = work.hash(["."]);
  const stringFields = ["manifestPath", "appSlug", "appClientIdVar", "appPrivateKeySecret", "pollStateVarPrefix", "engineAuthMode", "ghAwVersionPin"];
  for (const key of stringFields) {
    for (const value of [null, [], false]) {
      const request = { ...referenceRequest(), [key]: value };
      const result = await work.reconcile(request);
      assert.equal(result.status, "error", `${key}=${JSON.stringify(value)}`);
      assert.equal(result.validationResults[0].file, "BootstrapReconcileRequest");
      assert.ok(errorsOf(result).some((error) => error.includes(key)));
    }
  }
  for (const securityBaseline of [null, [], false]) {
    const result = await work.reconcile({ ...referenceRequest(), securityBaseline });
    assert.equal(result.status, "error");
    assert.ok(errorsOf(result).some((error) => error.includes("securityBaseline")));
  }
  for (const grantedAppPermissions of [null, false, "write"]) {
    const request = referenceRequest();
    request.securityBaseline.grantedAppPermissions = grantedAppPermissions;
    const result = await work.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(errorsOf(result).some((error) => error.includes("grantedAppPermissions")));
  }
  assert.equal(work.hash(["."]), before);
  assert.equal(work.shims.compileCalls().length, 0);
});

test("AC10 QA: prerelease versions below the security floor and empty manifest paths are rejected", (t) => {
  const work = workspace(t);
  const bad = [
    { ghAwVersionPin: "1.0.1-rc.1" },
    { ghAwVersionPin: ">=v1.0.1-alpha" },
    { manifestPath: "" },
    { manifestPath: " \t " },
  ];
  for (const patch of bad) {
    const result = renderFleet({ ...referenceRequest(), ...patch }, { cwd: work.dir });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.result.validationResults[0].file, "BootstrapReconcileRequest");
  }
  const newer = renderFleet({ ...referenceRequest(), ghAwVersionPin: "1.0.2-rc.1" }, { cwd: work.dir });
  assert.equal(newer.ok, true, "a prerelease whose numeric core is above the floor is allowed");
});

test("AC15/AC18 QA: duplicate YAML mappings and a bounded excessive-alias document fail before emission", async (t) => {
  const work = workspace(t);
  const malformed = [
    "projects: []\nprojects: []\n",
    `projects: &p [x]\ndependencyEdges: [${Array(201).fill("*p").join(", ")}]\n`,
  ];
  for (const text of malformed) {
    work.write("sdlc.yaml", text);
    const before = work.hash(["."]);
    const result = await work.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    assert.ok(errorsOf(result).some((error) => error.startsWith("manifest-unparseable: ")), errorsOf(result).join("\n"));
    assert.equal(work.hash(["."]), before);
  }
  assert.equal(work.shims.compileCalls().length, 0);
});

test("AC21/AC58 QA: a BOM and CRLF in an instruction file normalize to BOM-free LF output", (t) => {
  const manifest = minimalManifest();
  manifest.projects[0].driftAudit.instructionsFile = "instructions/alpha.md";
  const work = workspace(t, {
    manifestText: toYaml(manifest),
    files: { "instructions/alpha.md": "\uFEFFfirst line\r\nsecond line\r\n" },
  });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true);
  const source = result.files.get(".github/workflows/drift-alpha-service.md");
  assert.ok(source.includes("first line\nsecond line"), "instruction-file lines survive as normalized content");
  assert.equal(source.includes("\r"), false);
  assert.equal(source.includes("\uFEFF"), false);
});

test("AC21 QA: the instruction byte-size boundary accepts 512 KiB and rejects one additional UTF-8 byte without writing", async (t) => {
  const manifest = minimalManifest();
  manifest.projects[0].driftAudit.instructionsFile = "instructions/alpha.md";
  const limit = 512 * 1024;
  const exact = "é".repeat(limit / 2);
  const work = workspace(t, { manifestText: toYaml(manifest), files: { "instructions/alpha.md": exact } });
  assert.equal(fs.statSync(work.path("instructions/alpha.md")).size, limit);
  assert.equal(renderFleet(referenceRequest(), { cwd: work.dir }).ok, true, "the exact byte boundary is accepted");
  work.write("instructions/alpha.md", `${exact}x`);
  const before = work.hash(["."]);
  const result = await work.reconcile(referenceRequest());
  assert.equal(result.status, "error");
  assert.ok(errorsOf(result).some((error) => error.startsWith("drift-instructions-file: ") && error.includes("larger than 524288 bytes")));
  assert.equal(work.hash(["."]), before);
  assert.equal(work.shims.compileCalls().length, 0);
});

function recording(work, text, mode = "ok-recorded") {
  work.write("../compiler-output.txt", text);
  work.shims.compile({ mode, outputFile: work.path("../compiler-output.txt") });
}

test("AC13 QA: a compiler banner before its JSON array does not lose workflow validation results", async (t) => {
  const work = workspace(t);
  const elements = renderFleet(referenceRequest(), { cwd: work.dir }).workflows.map((workflow) => ({ workflow: workflow.id, valid: true, errors: [] }));
  recording(work, `notice: using offline action pins\n${JSON.stringify(elements)}\n`);
  const result = await work.reconcile(referenceRequest());
  assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
  assert.deepEqual(result.validationResults, elements.map((entry) => ({ file: entry.workflow, valid: true, errors: [] })));
  for (const pair of result.generatedWorkflows) assert.equal(work.exists(pair.lockYml), true);
});

test("AC13/AC16 QA: malformed compiler entries and heterogeneous diagnostics fail closed and retain the original messages", async (t) => {
  const work = workspace(t);
  const diagnostics = ["original diagnostic", { message: "message with\nan exact newline" }, { detail: "opaque object" }, 42];
  recording(work, JSON.stringify([null, { workflow: "broken-workflow", valid: false, errors: diagnostics }]));
  const before = work.hash(["."]);
  const result = await work.reconcile(referenceRequest());
  assert.equal(result.status, "error");
  assert.equal(result.validationResults[0].file, "unknown");
  assert.equal(result.validationResults[0].valid, false);
  assert.deepEqual(result.validationResults[1].errors, [
    "compile-error: original diagnostic",
    "compile-error: message with\nan exact newline",
    'compile-error: {"detail":"opaque object"}',
    "compile-error: 42",
  ]);
  assert.equal(work.hash(["."]), before);
});

test("AC16/AC17 QA: a nonzero compiler exit overrides an otherwise all-valid JSON result and restores the tree", async (t) => {
  const work = workspace(t);
  recording(work, JSON.stringify([{ workflow: "apparently-valid", valid: true, errors: [] }]), "error-recorded");
  work.write(".github/workflows/operator.yml", "# byte-for-byte operator content\r\n");
  const before = work.hash(["."]);
  const result = await work.reconcile(referenceRequest());
  assert.equal(result.status, "error", "a successful-looking JSON record cannot override exit 1");
  assert.ok(result.validationResults.some((entry) => !entry.valid && entry.file === "gh aw compile" && entry.errors.some((error) => error.includes("code 1"))));
  assert.equal(work.hash(["."]), before);
});

test("AC13/AC17 QA: truncated and non-array compiler JSON produce a diagnostic and roll back every output", async (t) => {
  const work = workspace(t);
  for (const output of ['{"valid":true}\n', 'compiler notice\n[{"workflow":', ""]) {
    recording(work, output);
    const before = work.hash(["."]);
    const result = await work.reconcile(referenceRequest());
    assert.equal(result.status, "error", JSON.stringify(output));
    assert.ok(errorsOf(result).some((error) => error.startsWith("compile-failed: ")));
    assert.equal(work.hash(["."]), before);
  }
});

test("AC17/AC18 QA: an I/O failure after the first emitted source restores earlier writes and operator bytes", async (t) => {
  const work = workspace(t);
  work.write(".github/workflows/operator.yml", "# keep the operator's exact bytes\r\n");
  work.write(".github/workflows/cascade-mechanical-alpha-to-beta.md", "uncommitted source bytes\r\n");
  const before = work.hash(["."]);
  const statusBefore = work.status();
  const original = fs.writeFileSync;
  let injected = false;
  let result;
  try {
    fs.writeFileSync = function failOnce(file, ...args) {
      if (!injected && String(file) === work.path(".github/workflows/drift-alpha-service.md")) {
        injected = true;
        throw new Error("QA simulated disk-full after one workflow write");
      }
      return original.call(this, file, ...args);
    };
    result = await work.reconcile(referenceRequest());
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(injected, true, "the error was reached after a real earlier write");
  assert.equal(result.status, "error");
  assert.ok(errorsOf(result).some((error) => error.includes("QA simulated disk-full")));
  assert.equal(work.hash(["."]), before);
  assert.equal(work.status(), statusBefore);
  assert.equal(work.shims.compileCalls().length, 0, "a partial emission must not reach the compiler");
});

test("AC10/AC17 QA: an invalid executable file produces a spawn error without leaving generated files", async (t) => {
  const work = workspace(t, { gh: false });
  const binary = path.join(work.shims.directory, process.platform === "win32" ? "gh.exe" : "gh");
  fs.writeFileSync(binary, "not an executable program\n");
  if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
  const before = work.hash(["."]);
  const result = await work.reconcile(referenceRequest());
  assert.equal(result.status, "error");
  assert.ok(errorsOf(result).some((error) => /^(?:compile-unavailable|compile-failed): /.test(error)));
  assert.equal(work.hash(["."]), before);
});

test("AC12 QA: missing CLI arguments and malformed or null request JSON produce only an error result with exit 1", (t) => {
  const work = workspace(t);
  work.write("malformed.json", '{"unterminated":');
  work.write("null.json", "null\n");
  const before = work.hash(["."]);
  for (const args of [
    [],
    ["--request"],
    ["--unexpected"],
    ["--request", work.path("malformed.json")],
    ["--request", work.path("null.json")],
  ]) {
    const outcome = spawnSync(process.execPath, [abs("src", "reconcile.mjs"), ...args], {
      cwd: work.dir,
      env: { ...process.env, ...work.shims.env() },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(outcome.status, 1, `${JSON.stringify(args)}: ${outcome.stderr}`);
    const result = JSON.parse(outcome.stdout);
    assert.equal(result.status, "error");
    assert.equal(result.validationResults[0].file, "BootstrapReconcileRequest");
    assert.ok(errorsOf(result).every((error) => /^[a-z0-9-]+: .+/.test(error)));
    assert.deepEqual(result.generatedWorkflows, []);
    assert.equal(work.hash(["."]), before);
  }
  assert.equal(work.shims.compileCalls().length, 0);
});

test("AC11 QA: invalid config JSON, router YAML and workflow frontmatter produce file-local errors, not exceptions", () => {
  for (const [file, text, rule] of [
    [".github/workflows/aw.json", "{not-json", "repo-config-invalid:"],
    [".github/workflows/cascade-router.yml", "name: [unterminated\n", "router-invalid:"],
    [".github/workflows/drift-alpha-service.md", "---\non: [unterminated\n---\n\n# Body\n", "frontmatter-invalid:"],
  ]) {
    const files = loadRenderedFixture();
    files.set(file, text);
    const before = [...files];
    const results = checkRendered(files, referenceRequest(), minimalManifest());
    const invalid = results.filter((entry) => !entry.valid);
    assert.equal(invalid.length, 1, JSON.stringify(invalid));
    assert.equal(invalid[0].file, file);
    assert.ok(invalid[0].errors.some((error) => error.startsWith(rule)), JSON.stringify(invalid[0]));
    assert.deepEqual([...files], before, "the validator must not mutate supplied content");
  }
});

test("AC41 QA: router failure masking is rejected for forced-success shell fallbacks and continue-on-error", () => {
  const file = ".github/workflows/cascade-router.yml";
  for (const step of [
    { run: "node src/route-upstream.mjs || true" },
    { run: "node src/route-upstream.mjs || :" },
    { run: "node src/route-upstream.mjs; exit 0" },
    { run: "node src/route-upstream.mjs", "continue-on-error": true },
  ]) {
    const files = loadRenderedFixture();
    const router = YAML.parse(files.get(file));
    router.jobs.route.steps.push(step);
    files.set(file, YAML.stringify(router));
    const entry = checkRendered(files, referenceRequest(), minimalManifest()).find((result) => result.file === file);
    assert.equal(entry.valid, false, JSON.stringify(step));
    assert.ok(entry.errors.some((error) => error.startsWith("router-masks-failure: ")));
  }
  const files = loadRenderedFixture();
  assert.equal(checkRendered(files, referenceRequest(), minimalManifest()).find((result) => result.file === file).valid, true);
});

test("AC52 QA: globs capable of reaching beneath a locked directory are rejected even without matching its literal name", (t) => {
  const work = workspace(t);
  for (const [allowed, locked] of [
    ["**/*.md", "src"],
    ["docs/*/*.md", "docs/private"],
    ["docs/**/safe.md", "docs/private/nested"],
  ]) {
    const manifest = minimalManifest();
    const edge = manifest.dependencyEdges[0];
    edge.mode = "ai-adaptation";
    edge.allowedFiles = [allowed];
    edge.immutableGates.zeroDiffPaths = [locked];
    work.write("sdlc.yaml", toYaml(manifest));
    const before = work.hash(["."]);
    const result = renderFleet(referenceRequest(), { cwd: work.dir });
    assert.equal(result.ok, false, `${allowed} can write beneath ${locked}`);
    assert.ok(errorsOf(result.result).some((error) => error.startsWith("allowed-files-locked-path: ") && error.includes(locked)));
    assert.equal(work.hash(["."]), before);
  }
  const safe = minimalManifest();
  safe.dependencyEdges[0].mode = "ai-adaptation";
  safe.dependencyEdges[0].allowedFiles = ["docs/*.md"];
  safe.dependencyEdges[0].immutableGates.zeroDiffPaths = ["src"];
  work.write("sdlc.yaml", toYaml(safe));
  assert.equal(renderFleet(referenceRequest(), { cwd: work.dir }).ok, true, "an unrelated directory remains writable");
});

test("AC17 QA: a timed-out compiler fails the run and restores operator files and purged orphans", async (t) => {
  // Both numbers are generous because the whole suite runs in parallel: on a loaded machine the stub compiler (a launcher, then node)
  // can take seconds to start, and it has to be running when the timeout fires and still be asleep when it does. The stub sleeps
  // without burning CPU, so a long delay costs time but no load.
  const timeoutMs = 15000;
  const compilerDelayMs = 20000;
  const work = workspace(t);
  work.write(".github/workflows/operator.yml", "# retain these exact operator bytes\r\n");
  work.write(".github/workflows/orphan.lock.yml", "# retain this purged orphan\r\n");
  work.write(".gitattributes", "* text=auto eol=lf\n");
  work.shims.compile({ mode: "ok", delayMs: compilerDelayMs, sideFiles: true });
  const before = work.hash(["."]);
  const result = await reconcile(referenceRequest(), { cwd: work.dir, env: work.shims.env(), timeoutMs });
  assert.equal(work.shims.compileCalls().length, 1, "the sleeping compiler was actually reached");
  assert.equal(result.status, "error", "timeout must not turn a success-capable compiler into a successful run");
  assert.ok(errorsOf(result).some((error) => error.startsWith("compile-failed: ")));
  const compilerStarted = fs.statSync(work.shims.logPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, compilerStarted + compilerDelayMs + 1000 - Date.now())));
  assert.equal(work.hash(["."]), before, "all files, including compiler side effects, are restored after termination");
});
