// AC19, AC30, AC42, AC54 and AC63-AC69: the gated open questions OQ30, OQ31, OQ32 and OQ38-OQ43.
// Each gated item has one test whose name is exactly the item id; the final inventory test reads this
// file and fails when one of them is missing or renamed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, renderFleet } from "ai-sdlc-factory/reconcile";
import { engineFile } from "../helpers/instance.mjs";
import {
  abs,
  fixture,
  listFiles,
  loadRenderedFixture,
  minimalManifest,
  mutate,
  parseWorkflow,
  presetManifest,
  readText,
  referenceRequest,
  REPO_ROOT,
  toYaml,
} from "./helpers/fixtures.mjs";
import { recordWrites } from "./helpers/fs-spy.mjs";
import { stubLockContent } from "./helpers/shims.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const preset = presetManifest();
const rendered = renderFleet(request);
const mdFiles = [...rendered.files.keys()].filter((name) => name.endsWith(".md"));
const handlerFiles = mdFiles.filter((name) => "create-pull-request" in (parseWorkflow(rendered.files.get(name)).frontmatter["safe-outputs"] ?? {}));
const committedMd = () => listFiles(REPO_ROOT, W).filter((name) => name.endsWith(".md"));

function withFrontmatter(files, name, change) {
  const copy = new Map(files);
  const { frontmatter, body } = parseWorkflow(copy.get(name));
  change(frontmatter);
  copy.set(name, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
  return copy;
}
const minimalRequest = referenceRequest();
const DRIFT = `${W}/drift-alpha-service.md`;
const CASCADE = `${W}/cascade-mechanical-alpha-to-beta.md`;
const invalid = (files) => checkRendered(files, minimalRequest, minimalManifest()).filter((entry) => !entry.valid);

const mdNameOf = (file) => file.split("/").pop();

/** All eight generated workflows get a pre-seeded lock whose header is one of the fixtures. */
async function runWithSeededLocks(headerFile) {
  const workspace = createWorkspace();
  const header = readText(fixture("locks", headerFile));
  for (const pair of renderFleet(request).workflows) workspace.write(pair.lockYml, header);
  const result = await workspace.reconcile(request);
  return { workspace, result };
}

test("OQ30", async (t) => {
  t.diagnostic("AC63: lock headers are never compared with a literal; the compile step always runs; the lock files are the compiler's bytes");
  assert.notEqual(readText(fixture("locks", "header-a.lock.yml")).split("\n")[0], readText(fixture("locks", "header-b.lock.yml")).split("\n")[0]);
  assert.match(readText(fixture("locks", "header-a.lock.yml")), /^# gh-aw-metadata: .*"schema_version":"v3"/);
  assert.match(readText(fixture("locks", "header-b.lock.yml")), /^# gh-aw-metadata: .*"schema_version":"v4"/);
  for (const headerFile of ["header-a.lock.yml", "header-b.lock.yml"]) {
    const { workspace, result } = await runWithSeededLocks(headerFile);
    try {
      assert.equal(result.status, "ok", `${headerFile}: ${JSON.stringify(result.validationResults)}`);
      assert.equal(workspace.shims.compileCalls().length, 1, `${headerFile}: the compile stub is invoked exactly once`);
      for (const pair of result.generatedWorkflows) {
        const expected = stubLockContent(mdNameOf(pair.sourceMd), Buffer.from(workspace.read(pair.sourceMd)));
        assert.equal(workspace.read(pair.lockYml), expected, `${pair.lockYml} equals the compile stub's output byte for byte`);
      }
    } finally {
      workspace.cleanup();
    }
  }
  const missing = createWorkspace({ compile: { mode: "ok", skip: ["drift-gh-admin-msft.md"] } });
  try {
    const result = await missing.reconcile(request);
    assert.equal(result.status, "error", "a missing lockYml for any sourceMd yields status error");
    const errors = result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => /^lock-missing: .*drift-gh-admin-msft\.lock\.yml/.test(error)), errors.join("\n"));
    assert.deepEqual(missing.list(W), [], "and the run is rolled back");
  } finally {
    missing.cleanup();
  }
  const source = readText(engineFile("src", "reconcile.mjs"));
  for (const literal of ["gh-aw-metadata", "schema_version", "frontmatter_hash", "body_hash"]) assert.equal(source.includes(literal), false, `the engine never mentions ${literal}`);
});

test("OQ31", async (t) => {
  t.diagnostic("AC63: no freshness decision from compiler_version or from matching existing lock files; a lock without a compiler_version is fine");
  const workspace = createWorkspace();
  try {
    for (let run = 1; run <= 3; run += 1) {
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
      assert.equal(workspace.shims.compileCalls().length, run, `run ${run}: the compile step runs although every lock already exists`);
      for (const pair of result.generatedWorkflows) workspace.write(pair.lockYml, readText(fixture("locks", "header-b.lock.yml")));
    }
    const manifest = mutate(preset, (copy) => copy.projects.push({ ...copy.projects[3], projectKey: "late-addition", repo: "acme-labs/late-addition", driftAudit: { ...copy.projects[0].driftAudit, instructionsFile: null, instructions: "Keep it current.", knowledgeSources: { watchUrls: [{ url: "https://example.org/x", label: "x", kind: "docs" }], packageManifests: [], mcpServers: {} } } }));
    workspace.write("sdlc.yaml", toYaml(manifest));
    const grown = await workspace.reconcile(request);
    assert.equal(grown.status, "ok", JSON.stringify(grown.validationResults));
    assert.ok(grown.generatedWorkflows.some((pair) => pair.sourceMd.endsWith("drift-late-addition.md")), "a workflow added to a tree of matching locks is compiled");
    assert.ok(workspace.exists(`${W}/drift-late-addition.lock.yml`));
    assert.equal(workspace.shims.compileCalls().length, 4);
  } finally {
    workspace.cleanup();
  }
  const source = readText(engineFile("src", "reconcile.mjs"));
  assert.equal(source.includes("compiler_version"), false);
});

test("OQ32", async (t) => {
  t.diagnostic("AC63: no assumption that every action reference in a lock file is a commit SHA; no edit of a .lock.yml or actions-lock.json");
  const tagged = readText(fixture("locks", "header-b.lock.yml"));
  assert.match(tagged, /@v0\b/, "the fixture pins an action by tag, not by commit SHA");
  const workspace = createWorkspace({ compile: { mode: "ok", lockContent: tagged } });
  try {
    workspace.write(".github/aw/actions-lock.json", '{"entries":{"github/gh-aw-actions/setup@v0":{"repo":"github/gh-aw-actions/setup","version":"v0","sha":""}}}\n');
    const pinsBefore = workspace.read(".github/aw/actions-lock.json");
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const pair of result.generatedWorkflows) assert.equal(workspace.read(pair.lockYml), tagged, `${pair.lockYml} is exactly what the compiler wrote`);
    assert.equal(workspace.read(".github/aw/actions-lock.json"), pinsBefore, "the pin cache is the compiler's alone");
    const second = await workspace.reconcile(request);
    assert.equal(second.status, "ok");
    for (const pair of second.generatedWorkflows) assert.equal(workspace.read(pair.lockYml), tagged);
  } finally {
    workspace.cleanup();
  }
  const writes = [];
  const probe = createWorkspace({ compile: { mode: "ok", lockContent: tagged } });
  try {
    const recorded = await recordWrites(async () => {
      await probe.reconcile(request);
    });
    writes.push(...recorded);
    for (const target of writes.map((value) => value.split(path.sep).join("/"))) {
      assert.equal(/\.lock\.yml$|actions-lock\.json$/.test(target), false, `the engine itself never writes ${target}`);
    }
  } finally {
    probe.cleanup();
  }
});

test("OQ38", async (t) => {
  t.diagnostic("AC64: every create-pull-request handler carries an explicit protected-files policy of blocked");
  assert.equal(handlerFiles.length, 12);
  const manifest = mutate(preset, (copy) => {
    copy.protectedFilesExclude = ["notes.md", "/docs/changelog.md"];
    copy.dependencyEdges[0].protectedFilesExclude = ["/public/ghec-admin/keep.md"];
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const files = renderFleet(request, { cwd: workspace.dir }).files;
    for (const name of handlerFiles) {
      const policy = parseWorkflow(files.get(name)).frontmatter["safe-outputs"]["create-pull-request"]["protected-files"];
      assert.equal(policy.policy, "blocked", name);
      const base = mdNameOf(name);
      if (base.startsWith("drift-") || base.startsWith("implement-") || base.startsWith("sdlc-onboard")) assert.deepEqual(policy.exclude, ["/docs/changelog.md", "notes.md"], `${base}: the manifest's list`);
      else if (base === "cascade-mechanical-ghec-admin.md") assert.deepEqual(policy.exclude, ["/public/ghec-admin/keep.md"], `${base}: the edge's list`);
      else assert.deepEqual(policy.exclude, preset.dependencyEdges.find((edge) => base === `cascade-${edge.mode === "mechanical" ? "mechanical" : "ai"}-${edge.edgeId}.md`).protectedFilesExclude, `${base}: the edge's list`);
    }
  } finally {
    workspace.cleanup();
  }
  for (const name of committedMd()) {
    const text = readText(abs(name));
    const matches = text.match(/protected-files/g) ?? [];
    assert.equal(matches.length, handlerFiles.includes(name) ? 1 : 0, `${name}: one protected-files key per handler`);
  }
  const fixtureFiles = loadRenderedFixture();
  assert.deepEqual(invalid(fixtureFiles), []);
  for (const file of [DRIFT, CASCADE]) {
    const without = withFrontmatter(fixtureFiles, file, (fm) => delete fm["safe-outputs"]["create-pull-request"]["protected-files"]);
    const entry = invalid(without).find((candidate) => candidate.file === file);
    assert.ok(entry && entry.errors.some((error) => /^protected-files-policy-missing: /.test(error) && error.includes(file)), `${file}: a handler without the key fails checkRendered`);
    const loose = withFrontmatter(fixtureFiles, file, (fm) => (fm["safe-outputs"]["create-pull-request"]["protected-files"] = { exclude: [] }));
    assert.ok(invalid(loose).some((candidate) => candidate.file === file), `${file}: a handler without an explicit policy fails`);
    const request_review = withFrontmatter(fixtureFiles, file, (fm) => (fm["safe-outputs"]["create-pull-request"]["protected-files"] = { policy: "request-review", exclude: [] }));
    assert.ok(invalid(request_review).some((candidate) => candidate.errors.some((error) => /^protected-files-policy-not-blocked: /.test(error))));
  }
});

test("OQ39", async (t) => {
  t.diagnostic("AC65: no allow-workflows anywhere, exclude-lock-yml: true on every handler, no commit path rendered");
  for (const name of committedMd()) assert.equal(readText(abs(name)).includes("allow-workflows"), false, name);
  for (const name of mdFiles) assert.equal(rendered.files.get(name).includes("allow-workflows"), false, name);
  for (const name of handlerFiles) assert.equal(parseWorkflow(rendered.files.get(name)).frontmatter["safe-outputs"]["create-pull-request"]["exclude-lock-yml"], true, name);
  const asked = createWorkspace({ manifestText: toYaml(mutate(preset, (copy) => (copy.allowWorkflows = true))), instructions: true });
  try {
    const result = await asked.reconcile(request);
    assert.equal(result.status, "error");
    assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: .*allowWorkflows/.test(error)));
    assert.deepEqual(asked.list(W), []);
  } finally {
    asked.cleanup();
  }
  const edgeAsked = createWorkspace({ manifestText: toYaml(mutate(preset, (copy) => (copy.dependencyEdges[1]["allow-workflows"] = true))), instructions: true });
  try {
    assert.equal((await edgeAsked.reconcile(request)).status, "error");
  } finally {
    edgeAsked.cleanup();
  }
  const files = loadRenderedFixture();
  for (const file of [DRIFT, CASCADE]) {
    const bad = withFrontmatter(files, file, (fm) => (fm["safe-outputs"]["create-pull-request"]["allow-workflows"] = true));
    assert.ok(invalid(bad).some((entry) => entry.file === file && entry.errors.some((error) => /^allow-workflows-forbidden: /.test(error))), file);
    const noLockExclusion = withFrontmatter(files, file, (fm) => (fm["safe-outputs"]["create-pull-request"]["exclude-lock-yml"] = false));
    assert.ok(invalid(noLockExclusion).some((entry) => entry.file === file && entry.errors.some((error) => /^exclude-lock-yml-missing: /.test(error))), file);
  }
});

test("OQ40", async (t) => {
  t.diagnostic("AC66: no staging key; dry_run is a boolean on drift workflows and a string on cascade workflows");
  for (const name of [...committedMd(), ...mdFiles]) {
    const text = rendered.files.get(name) ?? readText(abs(name));
    assert.equal(/staged/.test(text), false, name);
  }
  for (const name of mdFiles) {
    const { frontmatter } = parseWorkflow(rendered.files.get(name));
    const input = frontmatter.on?.workflow_dispatch?.inputs?.dry_run;
    if (mdNameOf(name).startsWith("drift-")) assert.equal(input.type, "boolean", name);
    else if (/cascade-(mechanical|ai)-/.test(name)) assert.equal(input.type, "string", name);
  }
  assert.equal(mdFiles.filter((name) => mdNameOf(name).startsWith("drift-")).length, 3);
  assert.equal(mdFiles.filter((name) => /cascade-(mechanical|ai)-/.test(name)).length, 5);
  for (const key of ["staged", "safeOutputs"]) {
    const workspace = createWorkspace({ manifestText: toYaml(mutate(preset, (copy) => (copy[key] = key === "staged" ? true : { staged: true }))), instructions: true });
    try {
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "error", key);
      assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^schema-validation: /.test(error)), key);
    } finally {
      workspace.cleanup();
    }
  }
  const files = loadRenderedFixture();
  const staged = withFrontmatter(files, DRIFT, (fm) => (fm["safe-outputs"].staged = true));
  assert.ok(invalid(staged).some((entry) => entry.file === DRIFT && entry.errors.some((error) => /^staging-key-forbidden: /.test(error))));
  const perHandler = withFrontmatter(files, CASCADE, (fm) => (fm["safe-outputs"]["create-pull-request"].staged = true));
  assert.ok(invalid(perHandler).some((entry) => entry.file === CASCADE));
  const dry = createWorkspace();
  try {
    const compile = await dry.reconcile({ ...request, dryRun: true });
    assert.equal(compile.status, "ok");
    assert.ok(dry.shims.compileCalls()[0].args.includes("--no-emit"), "dryRun is the no-write run, not a staging mechanism");
  } finally {
    dry.cleanup();
  }
});

test("OQ41", async (t) => {
  t.diagnostic("AC67: every checkout entry carries explicit github-app credentials built from the request, scoped to the repository that it checks out");
  let entries = 0;
  for (const name of mdFiles) {
    const { frontmatter } = parseWorkflow(rendered.files.get(name));
    for (const entry of frontmatter.checkout ?? []) {
      const { repositories, ...credentials } = entry["github-app"];
      assert.deepEqual(credentials, APP, `${name}: ${entry.repository ?? "current"}`);
      // A token for the central repository (the default scope) is enough for the onboarding workflow's own checkout; every other checkout names its repository.
      if (entry.repository.startsWith("${{")) assert.equal(repositories, undefined, `${name}: the checkout of the central repository`);
      else assert.deepEqual(repositories, [entry.repository.split("/")[1]], `${name}: ${entry.repository}`);
      entries += 1;
    }
  }
  assert.ok(entries >= 11, `checked ${entries} checkout entries`);
  const files = loadRenderedFixture();
  for (const file of [DRIFT, CASCADE]) {
    const broken = withFrontmatter(files, file, (fm) => delete fm.checkout[fm.checkout.length - 1]["github-app"]);
    const entry = invalid(broken).find((candidate) => candidate.file === file);
    assert.ok(entry && entry.errors.some((error) => /^checkout-github-app-missing: /.test(error) && error.includes(file)), `${file}: a checkout without its block fails checkRendered`);
    const wrong = withFrontmatter(files, file, (fm) => (fm.checkout[0]["github-app"] = { "client-id": "${{ vars.OTHER }}", "private-key": APP["private-key"] }));
    assert.ok(invalid(wrong).some((candidate) => candidate.file === file), `${file}: credentials built from other names fail`);
  }
});

test("OQ42", async (t) => {
  t.diagnostic("AC68: files are written only under .github/workflows of the working directory; no prompt claims that targets stay unchanged");
  const workspace = createWorkspace();
  try {
    const workflowsDirectory = path.join(workspace.dir, ".github", "workflows");
    const stagingPrefix = path.join(os.tmpdir(), "sdlc-reconcile-");
    const writes = await recordWrites(async () => {
      await workspace.reconcile(request);
      await workspace.reconcile({ ...request, dryRun: true });
    });
    assert.ok(writes.length > 0);
    for (const target of writes) {
      assert.ok(target === workflowsDirectory || target.startsWith(workflowsDirectory + path.sep) || target.startsWith(stagingPrefix), `unexpected write: ${target}`);
    }
    assert.equal(writes.some((target) => target.startsWith(path.join(workspace.dir, "src")) || target.startsWith(path.join(workspace.dir, "instructions"))), false);
  } finally {
    workspace.cleanup();
  }
  const phrase = /unchanged|untouched|zero installed/i;
  for (const name of [...committedMd(), ...mdFiles]) assert.equal(phrase.test(rendered.files.get(name) ?? readText(abs(name))), false, name);
  const generator = readText(engineFile("src", "reconcile.mjs"));
  assert.equal(/target repositor(y|ies) (stay|remain)/i.test(generator), false);
});

test("OQ43", async (t) => {
  t.diagnostic("AC69: safe outputs authenticate only through safe-outputs.github-app; no github-token in any form");
  for (const name of [...committedMd(), ...mdFiles]) assert.equal((rendered.files.get(name) ?? readText(abs(name))).includes("github-token"), false, name);
  for (const name of mdFiles) {
    const outputs = parseWorkflow(rendered.files.get(name)).frontmatter["safe-outputs"];
    const { repositories, ...credentials } = outputs["github-app"];
    assert.deepEqual(credentials, APP, name);
    // The token of a safe-outputs handler has one owner, which the compiler takes from the checkout entries, and every name is resolved under it (AC69). The handlers of a drift
    // or implementation workflow all take its project's repository as their target-repo, so its token names that one and never the central repository, which another owner does
    // not have (run 43926158616; the writes that this gives up in the conclusion job are recorded in AC69); a cascade workflow's token has the orchestrator's owner and names the
    // central repository and the downstream one; the onboarding workflow writes to the central repository, the compiler's default scope, and names none.
    const file = name.split("/").pop();
    const target = outputs["create-pull-request"]["target-repo"];
    if (/^(?:drift|implement)-/.test(file)) {
      assert.deepEqual(repositories, [target.split("/")[1]], name);
    } else if (/^cascade-/.test(file)) {
      assert.deepEqual(repositories, ["${{ github.event.repository.name }}", target.split("/")[1]], name);
    } else {
      assert.equal(file, "sdlc-onboard.md", `${name}: the only other workflow is the onboarding one`);
      assert.equal(repositories, undefined, name);
    }
    assert.equal("github-token" in outputs, false, name);
    for (const handler of Object.values(outputs)) if (handler && typeof handler === "object") assert.equal("github-token" in handler, false, name);
  }
  for (const key of ["githubToken", "github-token", "safeOutputsToken"]) {
    for (const where of ["manifest", "project", "edge"]) {
      const manifest = mutate(minimalManifest(), (copy) => {
        const target = where === "manifest" ? copy : where === "project" ? copy.projects[0] : copy.dependencyEdges[0];
        target[key] = "${{ secrets.NAME }}";
      });
      const workspace = createWorkspace({ manifestText: toYaml(manifest) });
      try {
        const result = await workspace.reconcile(request);
        assert.equal(result.status, "error", `${where}.${key}`);
        assert.ok(result.validationResults.flatMap((entry) => entry.errors).some((error) => /^(schema-validation|manifest-expression-opener): /.test(error)), `${where}.${key}`);
      } finally {
        workspace.cleanup();
      }
    }
  }
  const files = loadRenderedFixture();
  for (const form of ["${{ secrets.NAME }}", "${{ needs.job.outputs.token }}", "${{ steps.mint.outputs.token }}", "${{ steps.mint.outputs.token || secrets.NAME }}"]) {
    const global = withFrontmatter(files, DRIFT, (fm) => (fm["safe-outputs"]["github-token"] = form));
    assert.ok(invalid(global).some((entry) => entry.file === DRIFT && entry.errors.some((error) => /^safe-outputs-token-forbidden: /.test(error))), `global ${form}`);
    const perHandler = withFrontmatter(files, CASCADE, (fm) => (fm["safe-outputs"]["create-pull-request"]["github-token"] = form));
    assert.ok(invalid(perHandler).some((entry) => entry.file === CASCADE && entry.errors.some((error) => /^safe-outputs-token-forbidden: /.test(error))), `per handler ${form}`);
  }
});

test("AC19, AC42 and AC54: this file holds one test for each of OQ30, OQ31, OQ32 and OQ38 to OQ43", () => {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const id of ["OQ30", "OQ31", "OQ32", "OQ38", "OQ39", "OQ40", "OQ41", "OQ42", "OQ43"]) {
    assert.equal(new RegExp(`^test\\("${id}", async \\(t\\)`, "m").test(source), true, `the test named ${id} exists`);
  }
});

test("AC30, AC42 and AC54: the gated behaviours hold against every generated workflow at once (router, mechanical, AI, drift, onboarding)", () => {
  assert.equal(mdFiles.length, 12);
  assert.ok(rendered.files.has(`${W}/cascade-router.yml`));
  const router = rendered.files.get(`${W}/cascade-router.yml`);
  assert.equal(/staged|allow-workflows|github-token|allow_workflows/.test(router), false);
  assert.deepEqual(checkRendered(rendered.files, request, preset).filter((entry) => !entry.valid), []);
});
