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
import YAML from "yaml";
import { ghAwEnvironment, reconcile } from "../../src/reconcile.mjs";
import { abs, listFiles, minimalManifest, readText, referenceRequest, REPO_ROOT, toYaml } from "./helpers/fixtures.mjs";

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

test("the committed workflows compile under gh aw compile --strict --purge --json with no error and only the documented Checks-permission adaptation", { skip }, () => {
  const directory = scratchRepository();
  try {
    fs.cpSync(abs(".github"), path.join(directory, ".github"), { recursive: true });
    fs.copyFileSync(abs(".gitattributes"), path.join(directory, ".gitattributes"));
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: directory, env, encoding: "utf8", timeout: 600000 });
    assert.equal(outcome.status, 0, outcome.stderr);
    const elements = JSON.parse(outcome.stdout);
    assert.equal(elements.length, 9);
    for (const element of elements) {
      assert.equal(element.valid, true, `${element.workflow}: ${JSON.stringify(element.errors)}`);
      assert.deepEqual(element.errors, []);
    }
    for (const file of workflowFiles(REPO_ROOT)) {
      // The raw compiler adds a Checks permission that this six-permission App does not hold; reconcile removes exactly that line.
      const compiled = fs.readFileSync(path.join(directory, file), "utf8").replace(/\r\n/g, "\n");
      const adapted = file.endsWith(".lock.yml") ? compiled.replace(/^[ \t]*permission-checks: read\n/gm, "") : compiled;
      assert.equal(adapted, readText(abs(file)).replace(/\r\n/g, "\n"), `${file} is what the compiler produces, with only permission-checks: read removed`);
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
    assert.equal(first.generatedWorkflows.length, 9);
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

test("reconcile() with the real compiler reconciles a non-empty protectedFilesExclude: the compiler's rejection of protected_files falls back to a strict-only aw.json", { skip }, async () => {
  const directory = scratchRepository();
  try {
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), `${readText(abs("sdlc.yaml")).replace(/\s+$/, "")}\nprotectedFilesExclude:\n  - /README.md\n  - CHANGELOG.md\n`);
    fs.cpSync(abs("instructions"), path.join(directory, "instructions"), { recursive: true });
    const notes = [];
    const result = await reconcile(referenceRequest(), { cwd: directory, env: process.env, log: (line) => notes.push(line) });
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.generatedWorkflows.length, 9);
    assert.equal(notes.length, 1, "the rejected key is reported");
    assert.equal(fs.readFileSync(path.join(directory, ".github", "workflows", "aw.json"), "utf8"), '{\n  "strict": true\n}\n');
    for (const name of ["drift-gh-admin-msft", "drift-copilot-lab", "drift-self-improving-agents", "sdlc-onboard"]) {
      const source = fs.readFileSync(path.join(directory, ".github", "workflows", `${name}.md`), "utf8");
      assert.ok(/protected-files:\n\s+policy: blocked\n\s+exclude:\n\s+- \/README\.md\n\s+- CHANGELOG\.md\n/.test(source), `${name}: the list reaches the handler`);
      assert.ok(fs.existsSync(path.join(directory, ".github", "workflows", `${name}.lock.yml`)), `${name}: compiled`);
    }
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

for (const [mode, secret, engineId, edgeMode = "mechanical"] of [
  ["copilot-requests", null, "copilot"],
  ["copilot-pat", null, "copilot"],
  ["api-key", "ANTHROPIC_API_KEY", "claude"],
  ["api-key", "GOOGLE_API_KEY", "gemini"],
  ["api-key", "OPENAI_API_KEY", "codex"],
  ["api-key", "OPENAI_API_KEY", "codex", "ai-adaptation"],
  ["api-key", "CUSTOM_PROVIDER_KEY", "claude"],
]) {
  test(`AC71 real compiler: ${mode}${secret ? `/${secret}` : ""} compiles a non-preset ${edgeMode} fleet on the ${engineId} engine and preserves credential wiring in its locks`, { skip }, async () => {
    const directory = scratchRepository();
    try {
      const manifest = minimalManifest();
      manifest.dependencyEdges[0].mode = edgeMode;
      if (secret) manifest.engineApiKeySecret = secret;
      fs.writeFileSync(path.join(directory, "sdlc.yaml"), toYaml(manifest));
      fs.mkdirSync(path.join(directory, ".github", "aw"), { recursive: true });
      fs.copyFileSync(abs(".github", "aw", "actions-lock.json"), path.join(directory, ".github", "aw", "actions-lock.json"));
      const result = await reconcile({ ...referenceRequest(), engineAuthMode: mode }, { cwd: directory, env });
      assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
      assert.equal(result.generatedWorkflows.length, 3, "one mechanical, one drift and onboarding");
      for (const pair of result.generatedWorkflows) {
        const text = fs.readFileSync(path.join(directory, pair.lockYml), "utf8");
        const lock = YAML.parse(text);
        assert.ok(lock.jobs.agent && lock.jobs.detection && lock.jobs.safe_outputs, `${pair.lockYml} is an actual compiled workflow`);
        assert.ok(text.includes(`"agent_id":"${engineId}"`), `${pair.lockYml}: compiled for the ${engineId} engine`);
        if (mode === "copilot-requests") {
          const permissions = JSON.stringify({ workflow: lock.permissions, agent: lock.jobs.agent.permissions });
          assert.ok(permissions.includes('"copilot-requests":"write"'), `${pair.lockYml}: request-based authentication is granted`);
        } else {
          const expected = secret ?? "COPILOT_GITHUB_TOKEN";
          assert.ok(text.includes(`secrets.${expected}`), `${pair.lockYml}: the credential is a secret reference`);
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
