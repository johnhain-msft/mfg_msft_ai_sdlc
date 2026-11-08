// Every `run:` script that the renderer emits must at least parse: `bash -n` over the workflows' run bodies.
// Skipped (with a reason) when no bash that understands a plain relative script path is available.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { parseWorkflow, referenceRequest } from "./helpers/fixtures.mjs";
import YAML from "yaml";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-bashn-"));
fs.writeFileSync(path.join(scratch, "probe.sh"), "true\n");

function findBash() {
  const candidates = [process.env.GIT_BASH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash", "/usr/bin/bash", "bash"].filter(Boolean);
  for (const candidate of candidates) {
    const outcome = spawnSync(candidate, ["-n", "probe.sh"], { cwd: scratch, encoding: "utf8" });
    if (outcome.status === 0) return candidate;
  }
  return null;
}

const bash = findBash();

function collectRuns(name, value, where = "", found = []) {
  if (Array.isArray(value)) value.forEach((item, index) => collectRuns(name, item, `${where}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "run" && typeof item === "string") found.push({ name, where: `${where}.${key}`, script: item });
      else collectRuns(name, item, `${where}.${key}`, found);
    }
  }
  return found;
}

test("every rendered run script of every generated workflow is valid bash", { skip: bash === null ? "no bash executable that can syntax-check a script was found" : false }, () => {
  const rendered = renderFleet(referenceRequest());
  const runs = [];
  for (const [name, text] of rendered.files) {
    if (name.endsWith(".md")) collectRuns(name, parseWorkflow(text).frontmatter, "", runs);
    else if (name.endsWith("cascade-router.yml")) collectRuns(name, YAML.parse(text), "", runs);
  }
  assert.ok(runs.length > 100, `${runs.length} run scripts`);
  // One bash process checks every script, each wrapped in its own function; only a failure falls back to one process per script.
  fs.writeFileSync(path.join(scratch, "bundle.sh"), runs.map((entry, index) => `script_${index}() {\n${entry.script}\n}\n`).join("\n"));
  const bundled = spawnSync(bash, ["-n", "bundle.sh"], { cwd: scratch, encoding: "utf8" });
  if (bundled.status === 0) return;
  runs.forEach((entry, index) => {
    const file = `script-${index}.sh`;
    fs.writeFileSync(path.join(scratch, file), `${entry.script}\n`);
    const outcome = spawnSync(bash, ["-n", file], { cwd: scratch, encoding: "utf8" });
    assert.equal(outcome.status, 0, `${entry.name} ${entry.where}: ${outcome.stderr}`);
  });
  assert.fail(`the bundle failed to parse although every script did: ${bundled.stderr}`);
});

test("no rendered run script embeds a GitHub expression: values reach scripts through env bindings only", () => {
  const rendered = renderFleet(referenceRequest());
  const offenders = [];
  for (const [name, text] of rendered.files) {
    const runs = [];
    if (name.endsWith(".md")) collectRuns(name, parseWorkflow(text).frontmatter, "", runs);
    else if (name.endsWith("cascade-router.yml")) collectRuns(name, YAML.parse(text), "", runs);
    for (const entry of runs) if (entry.script.includes("${{")) offenders.push(`${entry.name} ${entry.where}`);
  }
  assert.deepEqual(offenders, []);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
