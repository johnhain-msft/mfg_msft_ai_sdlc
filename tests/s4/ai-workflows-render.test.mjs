// AC3 and AC4: the rendering of the three AI workflows is deterministic and idempotent, no S4 workflow file is edited by hand, and (opt-in, with the real
// gh-aw compiler) the .lock.yml files are the compiler's output for the .md sources.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ghAwEnvironment, reconcile, renderFleet } from "../../src/reconcile.mjs";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { abs, readText } from "./helpers/fixtures.mjs";
import { AI, WORKFLOW_DIR, referenceRequest } from "./helpers/workflows.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const mdPaths = AI.map((spec) => `${WORKFLOW_DIR}/${spec.id}.md`);
const lockPaths = AI.map((spec) => `${WORKFLOW_DIR}/${spec.id}.lock.yml`);

function copyOfRepository() {
  const workspace = createWorkspace({ manifestText: readText(abs("sdlc.yaml")), instructions: true });
  fs.cpSync(abs(".github"), workspace.path(".github"), { recursive: true });
  if (fs.existsSync(abs(".gitattributes"))) fs.copyFileSync(abs(".gitattributes"), workspace.path(".gitattributes"));
  for (const [name, value] of [["user.email", "fixture@example.invalid"], ["user.name", "Fixture"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) git(workspace.dir, ["config", name, value]);
  git(workspace.dir, ["add", "-A"]);
  git(workspace.dir, ["commit", "-q", "-m", "base"]);
  return workspace;
}

test("AC3: rendering is deterministic: two renders of the preset give byte-identical files, and the three AI sources are the committed ones", () => {
  const first = renderFleet(referenceRequest(), { cwd: abs(".") });
  const second = renderFleet(referenceRequest(), { cwd: abs(".") });
  assert.ok(first.ok && second.ok, JSON.stringify(first.result ?? second.result));
  assert.deepEqual([...second.files.keys()], [...first.files.keys()]);
  for (const [file, text] of first.files) assert.equal(second.files.get(file), text, `${file}: identical on a second render`);
  for (const file of mdPaths) assert.equal(first.files.get(file), readText(abs(file)), `${file}: the committed workflow is the renderer's output, so no hand edit`);
  assert.deepEqual(first.workflows.filter((workflow) => workflow.id.startsWith("cascade-ai-")).map((workflow) => workflow.lockYml).sort(), [...lockPaths].sort());
});

test("AC3: two runs of the reconciler on an unchanged sdlc.yaml leave .github/workflows byte for byte as the first run left it, and git diff --exit-code is clean after the second", () => {
  const workspace = copyOfRepository();
  try {
    const requestFile = path.join(workspace.root, "request.json");
    fs.writeFileSync(requestFile, JSON.stringify(referenceRequest()));
    const first = workspace.cli(requestFile);
    assert.equal(first.code, 0, `${first.stdout}${first.stderr}`);
    for (const file of mdPaths) assert.equal(workspace.read(file), readText(abs(file)), `${file}: rendered the same into a copy of the repository`);
    git(workspace.dir, ["add", "-A"]);
    git(workspace.dir, ["commit", "-q", "--allow-empty", "-m", "after the first run"]);
    const afterFirst = workspace.hash();
    const second = workspace.cli(requestFile);
    assert.equal(second.code, 0, `${second.stdout}${second.stderr}`);
    assert.equal(workspace.hash(), afterFirst, "the second run changed nothing");
    assert.doesNotThrow(() => git(workspace.dir, ["diff", "--exit-code", "--", ".github/workflows"]), "git diff --exit-code .github/workflows");
    assert.equal(git(workspace.dir, ["status", "--porcelain", "--untracked-files=all", "--", ".github/workflows"]), "");
  } finally {
    workspace.cleanup();
  }
});

test("AC3: the golden copies of the AI prompts that the S1 suite compares with are the same bytes as the committed workflows", () => {
  for (const spec of AI) {
    assert.equal(readText(abs("tests", "s1", "fixtures", "golden", `${spec.id}.md`)), readText(abs(WORKFLOW_DIR, `${spec.id}.md`)), spec.id);
  }
});

// With the real compiler (opt-in, like tests/s1/compile.test.mjs and tests/s2/idempotence.test.mjs).
const requested = process.env.SDLC_REAL_GH_AW === "1";
const env = ghAwEnvironment(process.env);
const version = requested ? spawnSync("gh", ["aw", "version"], { env, encoding: "utf8" }) : null;
const installed = version?.stdout.match(/v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
const usable = installed !== null && (installed[0] > 1 || (installed[0] === 1 && (installed[1] > 0 || installed[2] >= 1)));
const skip = !requested ? "set SDLC_REAL_GH_AW=1 to run the real compiler" : !usable ? `gh aw >= v1.0.1 is required, found ${installed?.join(".") ?? "none"}` : false;

test("AC3/AC4: with the real gh-aw compiler, gh aw compile --strict --purge --json reports the three workflows and leaves their .md and .lock.yml files unchanged, twice", { skip }, async () => {
  const workspace = copyOfRepository();
  try {
    for (let run = 1; run <= 2; run += 1) {
      const result = await reconcile(referenceRequest(), { cwd: workspace.dir, env });
      assert.equal(result.status, "ok", `run ${run}: ${JSON.stringify(result.validationResults)}`);
      const reported = result.generatedWorkflows.map((workflow) => workflow.lockYml);
      for (const lock of lockPaths) assert.ok(reported.includes(lock), `run ${run}: ${lock} is reported`);
    }
    assert.doesNotThrow(
      () => git(workspace.dir, ["diff", "--exit-code", "--", ...mdPaths, ...lockPaths]),
      "git diff --exit-code of the three .md and the three .lock.yml files",
    );
    assert.equal(git(workspace.dir, ["status", "--porcelain", "--untracked-files=all", "--", ".github/workflows"]), "");
  } finally {
    workspace.cleanup();
  }
});
