// Round-three delta coverage: exercise the fixes through public APIs and the actual rendered shell.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildAcks, checkRendered, renderFleet } from "../../src/reconcile.mjs";
import { fixture, minimalManifest, parseWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { recordWrites } from "./helpers/fs-spy.mjs";
import { BashSandbox } from "./helpers/bash-runtime.mjs";

const W = ".github/workflows";
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const errorsOf = (result) => result.validationResults.flatMap((entry) => entry.errors);

function workspace(t, manifest = minimalManifest(), options = {}) {
  const work = createWorkspace({ manifestText: toYaml(manifest), ...options });
  t.after(() => work.cleanup());
  return work;
}

function mixedManifest() {
  const manifest = minimalManifest();
  manifest.dependencyEdges.push({
    ...structuredClone(manifest.dependencyEdges[0]),
    edgeId: "alpha-ai-to-beta",
    upstreamKey: "alpha-ai",
    upstreamSlug: "ALPHA_AI",
    stateVariable: "SDLC_SYNC_STATE_ALPHA_AI",
    branchName: "sdlc/cascade-alpha-ai-to-beta",
    closeOlderKey: "sdlc-cascade-alpha-ai-to-beta",
    mode: "ai-adaptation",
  });
  return manifest;
}

function render(work, manifest, patch = {}) {
  work.write("sdlc.yaml", toYaml(manifest));
  const result = renderFleet({ ...referenceRequest(), ...patch }, { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}

function withDetection(files, file, value) {
  const copy = new Map(files);
  const { frontmatter, body } = parseWorkflow(copy.get(file));
  frontmatter["safe-outputs"]["threat-detection"] = value;
  copy.set(file, `---\n${YAML.stringify(frontmatter)}---\n${body}`);
  return copy;
}

test("AC21 delta: nested manifests validate repository-root instructions through all three public APIs", async (t) => {
  const manifest = minimalManifest();
  const relative = "instructions/alpha guide.md";
  manifest.projects[0].driftAudit.instructionsFile = relative;
  const work = workspace(t, manifest, {
    files: {
      "config/deep/fleet.yaml": toYaml(manifest),
      [relative]: "ROOT invalid ${{ secrets.QA_SENTINEL }}\n",
      [`config/deep/${relative}`]: "DECOY otherwise valid instructions\n",
    },
  });
  const request = { ...referenceRequest(), manifestPath: "config/deep/fleet.yaml" };
  const before = work.hash(["."]);
  const rejected = renderFleet(request, { cwd: work.dir });
  assert.equal(rejected.ok, false, "repository-root instruction validation cannot be bypassed by a safe decoy");
  assert.throws(() => buildAcks(request, { cwd: work.dir }), /manifest-expression-opener/);
  let result;
  const writes = await recordWrites(async () => { result = await work.reconcile(request); });
  assert.equal(result.status, "error");
  assert.ok(errorsOf(result).some((error) => error.startsWith("manifest-expression-opener: ") && error.includes(relative)));
  assert.equal(work.hash(["."]), before);
  assert.deepEqual(writes.filter((target) => inside(work.dir, target)), []);
  assert.equal(work.shims.compileCalls().length, 0);

  work.write(relative, "ROOT valid instruction bytes\n");
  work.write(`config/deep/${relative}`, "DECOY invalid ${{ secrets.QA_SENTINEL }}\n");
  for (const manifestPath of [request.manifestPath, work.path(request.manifestPath)]) {
    const updated = { ...request, manifestPath };
    const rendered = renderFleet(updated, { cwd: work.dir });
    assert.equal(rendered.ok, true, JSON.stringify(rendered.result));
    const { body } = parseWorkflow(rendered.files.get(`${W}/drift-alpha-service.md`));
    assert.ok(body.includes("ROOT valid instruction bytes"));
    assert.equal(body.includes("DECOY"), false);
    assert.deepEqual(buildAcks(updated, { cwd: work.dir }).drift[0].gateCommands, manifest.projects[0].driftAudit.verifyCommands);
  }
  result = await work.reconcile({ ...request, manifestPath: work.path(request.manifestPath) });
  assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
  assert.ok(work.read(`${W}/drift-alpha-service.md`).includes("ROOT valid instruction bytes"));
  assert.ok(work.read(`${W}/drift-alpha-service.lock.yml`).startsWith("# stub compiler output"));
});

test("AC11 delta: malformed detection is rejected in every generated workflow kind", (t) => {
  const manifest = mixedManifest();
  const work = workspace(t, manifest);
  const files = render(work, manifest);
  const originals = [...files];
  const sources = [...files.keys()].filter((file) => file.endsWith(".md"));
  assert.equal(sources.length, 4, "drift, mechanical, AI and onboarding are all exercised");
  for (const file of sources) {
    for (const value of [null, true, 17, "disabled", [], [{ "continue-on-error": false }]]) {
      const results = checkRendered(withDetection(files, file, value), referenceRequest(), manifest);
      assert.deepEqual(results.filter((entry) => !entry.valid).map((entry) => entry.file), [file], `${file}: reject ${JSON.stringify(value)}`);
      assert.ok(results.find((entry) => entry.file === file).errors.some((error) => error.includes("threat-detection")));
    }
  }
  assert.deepEqual([...files], originals, "validation leaves the original fleet bytes intact");
});

test("AC11 delta: object detection policy requires literal false and optional literal true", (t) => {
  const manifest = mixedManifest();
  const work = workspace(t, manifest);
  const files = render(work, manifest);
  for (const file of [...files.keys()].filter((name) => name.endsWith(".md"))) {
    for (const value of [
      { "continue-on-error": null },
      { "continue-on-error": 0 },
      { "continue-on-error": "false" },
      { "continue-on-error": false, enabled: "true" },
      { "continue-on-error": false, enabled: 1 },
      { "continue-on-error": false, enabled: [] },
      { "continue-on-error": false, engine: false, enabled: true },
    ]) {
      const results = checkRendered(withDetection(files, file, value), referenceRequest(), manifest);
      assert.equal(results.find((entry) => entry.file === file).valid, false, `${file}: object policy rejects ${JSON.stringify(value)}`);
    }
    for (const value of [{ "continue-on-error": false }, { "continue-on-error": false, enabled: true }]) {
      const results = checkRendered(withDetection(files, file, value), referenceRequest(), manifest);
      assert.deepEqual(results.filter((entry) => !entry.valid), [], `${file}: valid object policy is accepted`);
    }
  }
});

test("write-spy delta: copying records the destination, while renaming records both mutated paths", async (t) => {
  const work = workspace(t);
  const source = path.join(work.root, "read-only.txt");
  const first = work.path("first.txt");
  const renamed = work.path("renamed.txt");
  const second = work.path("second.txt");
  fs.writeFileSync(source, "original fixture bytes\n");
  const writes = await recordWrites(async () => {
    fs.copyFileSync(source, first);
    fs.renameSync(first, renamed);
    fs.cpSync(source, second);
  });
  assert.equal(writes.includes(source), false, "reading a copy source is not a write");
  for (const target of [first, renamed, second]) assert.ok(writes.includes(target), `the mutated destination ${target} is observed`);
  assert.equal(writes.filter((target) => target === first).length, 2, "copy destination and rename source are both mutations");
  assert.equal(fs.existsSync(first), false);
  for (const file of [source, renamed, second]) assert.equal(fs.readFileSync(file, "utf8"), "original fixture bytes\n");
});

test("AC10 delta: staged success, compatibility retry and compiler failure never touch the working tree", async (t) => {
  for (const [label, compile, expected, calls] of [
    ["success", { mode: "ok" }, "ok", 1],
    ["compatibility retry", { mode: "unsupported-protected-files" }, "ok", 2],
    ["partial compiler failure", { mode: "partial-error", outputFile: fixture("compile-output.error.json"), sideFiles: true }, "error", 1],
  ]) {
    const work = workspace(t, minimalManifest(), { compile });
    work.write(".github/aw/actions-lock.json", '{"entries":{}}\n');
    work.write(`${W}/operator.yml`, "# preserve exact operator bytes\r\n");
    const before = work.hash(["."]);
    let result;
    const writes = await recordWrites(async () => { result = await work.reconcile({ ...referenceRequest(), dryRun: true }); });
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.validationResults)}`);
    assert.deepEqual(writes.filter((target) => inside(work.dir, target)), [], `${label}: no temporary tree writes`);
    assert.equal(work.hash(["."]), before, `${label}: original bytes and file set are preserved`);
    const compiles = work.shims.compileCalls();
    assert.equal(compiles.length, calls, label);
    const stage = compiles[0].cwd;
    assert.equal(inside(work.dir, stage), false, `${label}: the compiler only runs outside the tree`);
    assert.ok(writes.includes(path.join(stage, ".github", "aw", "actions-lock.json")), `${label}: the existing lock is copied into staging`);
    for (const call of compiles) {
      assert.equal(call.cwd, stage);
      assert.deepEqual(call.args, ["aw", "compile", "--strict", "--no-emit", "--json"]);
    }
    assert.equal(fs.existsSync(stage), false, `${label}: even failed or retried compilation leaves no staging directory`);
  }
});

test("AC10 delta: scratch-creation failure returns an error without tree writes or compiler execution", async (t) => {
  const work = workspace(t);
  const before = work.hash(["."]);
  const original = fs.mkdtempSync;
  let attempted = false;
  let result;
  let writes;
  try {
    fs.mkdtempSync = function failStaging(prefix, ...rest) {
      if (String(prefix).includes("sdlc-reconcile-")) {
        attempted = true;
        throw new Error("QA EACCES preparing dry-run stage");
      }
      return original.call(this, prefix, ...rest);
    };
    writes = await recordWrites(async () => { result = await work.reconcile({ ...referenceRequest(), dryRun: true }); });
  } finally {
    fs.mkdtempSync = original;
  }
  assert.equal(attempted, true);
  assert.equal(result.status, "error", "scratch-creation failure must not be reported as success");
  assert.ok(errorsOf(result).some((error) => error.includes("QA EACCES preparing dry-run stage")));
  assert.deepEqual(writes.filter((target) => inside(work.dir, target)), []);
  assert.equal(work.hash(["."]), before);
  assert.equal(work.shims.compileCalls().length, 0);
});

test("AC32 delta: ERE alternatives stay whole-path and case-sensitive across actual deletions and renames", (t) => {
  const manifest = minimalManifest();
  manifest.dependencyEdges[0].allowedFiles = ["README.md", "docs/*.md"];
  const work = workspace(t, manifest);
  const files = render(work, manifest);
  const { frontmatter } = parseWorkflow(files.get(`${W}/cascade-mechanical-alpha-to-beta.md`));
  const script = frontmatter["post-steps"].find((step) => step.name === "Verify changed paths are covered by the allowed files").run;
  const box = new BashSandbox();
  t.after(() => box.cleanup());
  const original = { "README.md": "root file\n", "docs/guide.md": "guide file\n", "docs/obsolete.md": "delete this\n", "keep.txt": "stable\n" };
  const base = box.revision("beta-docs", original);
  const retained = { ...original };
  delete retained["docs/obsolete.md"];
  const deleted = box.revision("beta-docs", retained, base);
  assert.equal(box.run(script, { BASE_SHA: base }).status, 0, "deleting an allowed file remains permitted");
  for (const [from, to] of [
    ["README.md", "NOTREADME.md"],
    ["README.md", "README.md.backup"],
    ["docs/guide.md", "docs/guide.MD"],
    ["docs/guide.md", "docs/nested/guide.md"],
  ]) {
    const renamed = { ...retained, [to]: retained[from] };
    delete renamed[from];
    box.revision("beta-docs", renamed, deleted);
    assert.ok(box.git("beta-docs", "diff", "--name-only", deleted, "HEAD").split("\n").includes(to));
    const outcome = box.run(script, { BASE_SHA: deleted });
    assert.equal(outcome.status, 1, `whole-path ERE must reject the renamed path ${to}`);
    assert.ok(outcome.stderr.includes(`path outside the allowed files: ${to}`), outcome.stderr);
    assert.equal(fs.readFileSync(box.path(`beta-docs/${to}`), "utf8"), retained[from], "a rejecting gate does not erase the changed file");
  }
});

test("AC71 delta: provider precedence and auth-mode switching keep credentials and bash policy aligned", (t) => {
  const manifest = mixedManifest();
  manifest.projects[0].driftAudit.buildCommands = ["DOCS_FLAG=1 qa-docgen --check"];
  for (const edge of manifest.dependencyEdges) edge.importCommands = ["qa-import <checkout>"];
  const work = workspace(t, manifest);
  for (const [mode, secret, engine, variable] of [
    ["api-key", "team_anthropic_OPENAI_GOOGLE_key", "claude", "ANTHROPIC_API_KEY"],
    ["api-key", "team_claude_codex_key", "claude", "ANTHROPIC_API_KEY"],
    ["api-key", "team_openai_google_key", "codex", "OPENAI_API_KEY"],
    ["api-key", "team_codex_KEY", "codex", "OPENAI_API_KEY"],
    ["api-key", "team_gemini_key", "gemini", "GEMINI_API_KEY"],
    ["api-key", "team_google_key", "gemini", "GEMINI_API_KEY"],
    ["api-key", "custom_key", "claude", "ANTHROPIC_API_KEY"],
    ["copilot-pat", "team_OPENAI_KEY", "copilot", "COPILOT_GITHUB_TOKEN"],
    ["copilot-requests", "team_OPENAI_KEY", "copilot", null],
  ]) {
    manifest.engineApiKeySecret = secret;
    const files = render(work, manifest, { engineAuthMode: mode });
    for (const [file, text] of files) {
      if (!file.endsWith(".md")) continue;
      const { frontmatter } = parseWorkflow(text);
      const label = `${mode}/${secret}: ${file}`;
      assert.equal(frontmatter.engine.id, engine, label);
      const expectedEnv = variable === null ? undefined : { [variable]: `\${{ secrets.${mode === "copilot-pat" ? "COPILOT_GITHUB_TOKEN" : secret} }}` };
      assert.deepEqual(frontmatter.engine.env, expectedEnv, `${label}: credential reference follows the selected mode`);
      assert.equal(frontmatter.permissions["copilot-requests"], mode === "copilot-requests" ? "write" : undefined, label);
      if (engine === "codex") {
        assert.deepEqual(frontmatter.tools.bash, ["*"], `${label}: Codex cannot enforce a per-command list`);
      } else {
        assert.equal(frontmatter.tools.bash.includes("*"), false, label);
        const command = file.includes("/drift-") ? "qa-docgen" : file.includes("/cascade-") ? "qa-import" : "node";
        assert.ok(frontmatter.tools.bash.includes(command), `${label}: the manifest-derived command allowlist is retained`);
      }
    }
  }
  assert.equal(work.shims.compileCalls().length, 0, "rendering the authentication variants remains pure");
});
