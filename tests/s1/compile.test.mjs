// Opt-in: the real gh-aw compiler on the committed workflows. The rest of the suite is offline; this file runs
// only with SDLC_REAL_GH_AW=1 and a gh-aw CLI of v1.0.1 or newer (honouring XDG_DATA_HOME for an isolated install).
//
//   SDLC_REAL_GH_AW=1 node --test tests/s1/compile.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { ghAwEnvironment, reconcile } from "../../src/reconcile.mjs";
import { abs, listFiles, readText, referenceRequest, REPO_ROOT } from "./helpers/fixtures.mjs";

const requested = process.env.SDLC_REAL_GH_AW === "1";
const env = ghAwEnvironment(process.env);
const version = requested ? spawnSync("gh", ["aw", "version"], { env, encoding: "utf8" }) : null;
const installed = version?.stdout.match(/v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
const usable = installed !== null && (installed[0] > 1 || (installed[0] === 1 && (installed[1] > 0 || installed[2] >= 1)));
const skip = !requested ? "set SDLC_REAL_GH_AW=1 to run the real compiler" : !usable ? `gh aw >= v1.0.1 is required, found ${installed?.join(".") ?? "none"}` : false;

function originUrl() {
  const outcome = spawnSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8" });
  return outcome.status === 0 ? outcome.stdout.trim() : null;
}

function scratchRepository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-real-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const url = originUrl();
  if (url) execFileSync("git", ["remote", "add", "origin", url], { cwd: directory });
  return directory;
}

const workflowFiles = (root) => listFiles(root, ".github").filter((file) => !/agentics-maintenance/.test(file));

test("the committed workflows compile under gh aw compile --strict --purge --json with no error and no change", { skip }, () => {
  const directory = scratchRepository();
  try {
    fs.cpSync(abs(".github"), path.join(directory, ".github"), { recursive: true });
    fs.copyFileSync(abs(".gitattributes"), path.join(directory, ".gitattributes"));
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: directory, env, encoding: "utf8", timeout: 600000 });
    assert.equal(outcome.status, 0, outcome.stderr);
    const elements = JSON.parse(outcome.stdout);
    assert.equal(elements.length, 8);
    for (const element of elements) {
      assert.equal(element.valid, true, `${element.workflow}: ${JSON.stringify(element.errors)}`);
      assert.deepEqual(element.errors, []);
    }
    for (const file of workflowFiles(REPO_ROOT)) {
      assert.equal(fs.readFileSync(path.join(directory, file), "utf8").replace(/\r\n/g, "\n"), readText(abs(file)).replace(/\r\n/g, "\n"), `${file} is what the compiler produces`);
    }
    assert.deepEqual(workflowFiles(directory), workflowFiles(REPO_ROOT), "the compiler adds and removes no file of the fleet");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the validation-only form gh aw compile --strict --no-emit --json passes and writes nothing", { skip }, () => {
  const directory = scratchRepository();
  try {
    fs.cpSync(abs(".github"), path.join(directory, ".github"), { recursive: true });
    const before = workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]);
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--no-emit", "--json"], { cwd: directory, env, encoding: "utf8", timeout: 600000 });
    assert.equal(outcome.status, 0, outcome.stderr);
    for (const element of JSON.parse(outcome.stdout)) assert.equal(element.valid, true, element.workflow);
    const after = workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]);
    assert.deepEqual(after, before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reconcile() with the real compiler regenerates exactly the committed fleet, and a second run changes nothing", { skip }, async () => {
  const directory = scratchRepository();
  try {
    fs.copyFileSync(abs("sdlc.yaml"), path.join(directory, "sdlc.yaml"));
    fs.cpSync(abs("instructions"), path.join(directory, "instructions"), { recursive: true });
    fs.mkdirSync(path.join(directory, ".github", "aw"), { recursive: true });
    fs.copyFileSync(abs(".github", "aw", "actions-lock.json"), path.join(directory, ".github", "aw", "actions-lock.json"));
    const first = await reconcile(referenceRequest(), { cwd: directory, env: process.env });
    assert.equal(first.status, "ok", JSON.stringify(first.validationResults));
    assert.equal(first.generatedWorkflows.length, 8);
    const snapshot = workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]);
    for (const [file, text] of snapshot) {
      if (file === ".github/workflows/aw.json") continue;
      assert.equal(text.replace(/\r\n/g, "\n"), readText(abs(file)).replace(/\r\n/g, "\n"), file);
    }
    const second = await reconcile(referenceRequest(), { cwd: directory, env: process.env });
    assert.equal(second.status, "ok");
    assert.deepEqual(workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]), snapshot);
    assert.equal(fs.readdirSync(path.join(directory, ".github", "workflows")).some((name) => /agentics-maintenance/.test(name)), false, "the compiler's maintenance workflows are removed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a manifest that the real compiler rejects comes back as status error with its diagnostics, and the tree is restored", { skip }, async () => {
  const directory = scratchRepository();
  try {
    fs.copyFileSync(abs("sdlc.yaml"), path.join(directory, "sdlc.yaml"));
    fs.cpSync(abs("instructions"), path.join(directory, "instructions"), { recursive: true });
    const clean = await reconcile(referenceRequest(), { cwd: directory, env: process.env });
    assert.equal(clean.status, "ok", JSON.stringify(clean.validationResults));
    const before = workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]);
    // The engine accepts any MCP server object; only the compiler knows that `command` is not a property of an HTTP server.
    const broken = readText(abs("sdlc.yaml")).replace("          microsoft-learn:\n            type: http", "          microsoft-learn:\n            command: 123\n            type: nonsense");
    assert.notEqual(broken, readText(abs("sdlc.yaml")));
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), broken);
    const failed = await reconcile(referenceRequest(), { cwd: directory, env: process.env });
    assert.equal(failed.status, "error");
    const errors = failed.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.every((error) => /^[a-z0-9-]+: .+/.test(error)));
    assert.ok(errors.some((error) => error.startsWith("compile-error: ") && /Unknown property: (command|url)/.test(error)), errors.join("\n"));
    assert.deepEqual(workflowFiles(directory).map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")]), before, "the previous render is back byte for byte");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
