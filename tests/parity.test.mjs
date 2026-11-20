// The permanent compatibility check of this repository (design G.8): what the pinned engine renders from sdlc.yaml is what is committed under .github/workflows.
//
// It is the check that the migration to the engine package was proved with, made standing. Bumping the engine without regenerating fails it, and regenerating shows the
// difference in the pull request: the same render-and-compare as the proof, forever. To fix a failure here, run `npm run reconcile -- --request tests/fixtures/request.reference.json` (gh-aw >= 1.0.1; set SDLC_GH_AW_DATA_HOME
// to an isolated install of it on a machine whose global `gh aw` is older), review `git diff`, and commit sdlc.yaml, package.json, package-lock.json and .github/workflows together.
//
//   SDLC_REAL_GH_AW=1 npm test   also compiles the committed sources with the real gh-aw and compares the hashes of the committed locks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderFleet } from "ai-sdlc-factory/reconcile";
import { abs, INSTANCE_ROOT, presetManifest, readJson, readText, WORKFLOWS } from "./helpers/instance.mjs";

const AW = `${WORKFLOWS}/aw.json`;
const request = readJson(abs("tests", "fixtures", "request.reference.json"));
const rendered = renderFleet(request, { cwd: INSTANCE_ROOT });

const committedFiles = (suffix) => fs.readdirSync(abs(WORKFLOWS)).filter((name) => name.endsWith(suffix)).sort();
const header = (text) => /^# gh-aw-metadata: (\{.*\})$/m.exec(text);

test("the pinned engine renders the fleet of sdlc.yaml", () => {
  assert.equal(rendered.ok, true, JSON.stringify(rendered.result?.validationResults ?? rendered.result));
  assert.equal(rendered.files.size, 14, "the 12 workflow sources, cascade-router.yml and aw.json");
});

test("every workflow source and the router that the engine renders equals the committed file, byte for byte", () => {
  const names = [...rendered.files.keys()].filter((file) => file !== AW).sort();
  assert.equal(names.length, 13);
  for (const file of names) {
    assert.equal(readText(abs(file)), rendered.files.get(file), `${file} is not what the pinned engine renders: run npm run reconcile -- --request tests/fixtures/request.reference.json and commit the result`);
  }
});

test("the committed workflows are exactly the generated ones: no workflow source is missing or left over, and every source has its lock", () => {
  const generated = names(rendered.files, ".md");
  assert.deepEqual(committedFiles(".md"), generated, "the workflow sources");
  assert.deepEqual(committedFiles(".lock.yml"), generated.map((name) => name.replace(/\.md$/, ".lock.yml")), "the locks");
  // the files of the workflows directory that are not generated are hand-written, and few: a new one is a decision of its own
  const generatedFiles = new Set([...generated, ...generated.map((name) => name.replace(/\.md$/, ".lock.yml")), "cascade-router.yml", "aw.json"]);
  const handWritten = fs.readdirSync(abs(WORKFLOWS)).filter((name) => !generatedFiles.has(name)).sort();
  assert.deepEqual(handWritten, ["instance-ci.yml", "sdlc-bridge-dispatch.yml"]);
});

function names(files, suffix) {
  return [...files.keys()].filter((file) => file.endsWith(suffix)).map((file) => path.posix.basename(file)).sort();
}

test("AC55: the committed aw.json is strict-only: the compiler that produced the committed locks, gh-aw v1.0.1, rejects protected_files", () => {
  // The repository config schema of v1.0.1 has additionalProperties: false and no protected_files key (the v1.2.0
  // pre-release has it), so the strict-only file is what that compiler accepts. A re-pin to a compiler that accepts the
  // key changes this expectation together with AC55 and section 4 of the spec.
  const first = readText(abs(WORKFLOWS, "drift-gh-admin-msft.lock.yml")).split("\n")[0];
  assert.ok(first.includes('"compiler_version":"v1.0.1"'), first);
  assert.equal(readText(abs(AW)), '{\n  "strict": true\n}\n');
  assert.deepEqual(readJson(abs(AW)), { strict: true });
  // what the engine renders has the key, and the reconciler falls back to this file when the compiler refuses it
  assert.deepEqual(JSON.parse(rendered.files.get(AW)), { strict: true, protected_files: { exclude: [] } });
});

test("the lock pins the engine the way package.json names it, and every other resolved URL of the lock is the npm registry's", () => {
  const manifest = presetManifest();
  const spec = readJson(abs("package.json")).dependencies[manifest.factory.package];
  const lock = readJson(abs("package-lock.json"));
  const key = `node_modules/${manifest.factory.package}`;
  assert.ok(lock.packages[key], `the lock has ${key}`);
  const resolved = lock.packages[key].resolved;
  if (spec.startsWith("file:")) {
    // a local copy for verification before the first release of the engine; the release tag replaces it
    assert.ok(resolved.startsWith("file:"), `${key} is resolved as ${resolved}`);
  } else {
    const [, owner, repo] = /^github:([^/]+)\/(.+)$/.exec(manifest.factory.source);
    assert.match(spec, new RegExp(`^github:${owner}/${repo}#v\\d+\\.\\d+\\.\\d+`), "package.json names a release tag of the engine repository");
    assert.match(resolved, new RegExp(`^git\\+ssh://git@github\\.com/${owner}/${repo}\\.git#[0-9a-f]{40}$`), "and the lock pins the commit that it resolved to");
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === key || entry.resolved === undefined) continue;
    assert.ok(entry.resolved.startsWith("https://registry.npmjs.org/"), `${name} is resolved as ${entry.resolved}`);
  }
});

/** The environment of the real compiler: an isolated gh-aw install, when SDLC_GH_AW_DATA_HOME names one, for a machine whose global gh aw is older. */
function ghAwEnvironment(source) {
  const env = { ...source, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  const home = source.SDLC_GH_AW_DATA_HOME;
  if (home && !source.XDG_DATA_HOME && fs.existsSync(home)) env.XDG_DATA_HOME = home;
  return env;
}

test("SDLC_REAL_GH_AW=1: the committed locks are what the real gh-aw compiles from the committed sources (the hashes of their metadata match a fresh compile)", { skip: process.env.SDLC_REAL_GH_AW !== "1" && "set SDLC_REAL_GH_AW=1 to run the real gh-aw (>= 1.0.1)", timeout: 15 * 60 * 1000 }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-parity-"));
  try {
    const workflows = path.join(scratch, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.mkdirSync(path.join(scratch, ".github", "aw"), { recursive: true });
    for (const name of committedFiles(".md")) fs.copyFileSync(abs(WORKFLOWS, name), path.join(workflows, name));
    fs.copyFileSync(abs(AW), path.join(workflows, "aw.json"));
    fs.copyFileSync(abs(".github", "aw", "actions-lock.json"), path.join(scratch, ".github", "aw", "actions-lock.json"));
    const env = ghAwEnvironment(process.env);
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: scratch, env, windowsHide: true }).status, 0);
    const compiled = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 10 * 60 * 1000 });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`.slice(-2000));
    for (const name of committedFiles(".lock.yml")) {
      const committed = header(readText(abs(WORKFLOWS, name)));
      const fresh = header(readText(path.join(workflows, name)));
      assert.ok(committed && fresh, `${name} has gh-aw metadata`);
      const [a, b] = [JSON.parse(committed[1]), JSON.parse(fresh[1])];
      assert.equal(b.compiler_version, a.compiler_version, `${name}: compiled by the same gh-aw`);
      assert.equal(b.frontmatter_hash, a.frontmatter_hash, `${name}: the frontmatter of the committed lock is the committed source's`);
      assert.equal(b.body_hash, a.body_hash, `${name}: the body of the committed lock is the committed source's`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
