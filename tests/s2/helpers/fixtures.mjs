// Paths, readers and small helpers shared by the tests/s2 suite. The rendering helpers come from the S1 suite, so that
// the S2 tests judge the very workflows that the reconciler renders and commits.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  abs,
  customJobsOf,
  minimalManifest,
  mutate,
  parseWorkflow,
  presetManifest,
  projectOf,
  readText,
  readWorkflow,
  referenceRequest,
  REPO_ROOT,
  toYaml,
} from "../../s1/helpers/fixtures.mjs";

export { abs, customJobsOf, minimalManifest, mutate, parseWorkflow, presetManifest, projectOf, readText, readWorkflow, referenceRequest, REPO_ROOT, toYaml };

export const S2_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const FIXTURES = path.join(S2_ROOT, "fixtures");
export const WORKFLOWS = ".github/workflows";
/** The preset's drift workflows: the project key of each. */
export const DRIFT_KEYS = ["gh-admin-msft", "copilot-lab", "self-improving-agents"];

export const fixture = (...parts) => path.join(FIXTURES, ...parts);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const readYaml = (file) => YAML.parse(fs.readFileSync(file, "utf8"));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const script = (...parts) => path.join(REPO_ROOT, "src", ...parts);

/** The committed workflow of a project: frontmatter, text of the frontmatter and Markdown body. */
export const driftWorkflow = (projectKey) => readWorkflow(`drift-${projectKey}.md`);
export const driftWorkflowText = (projectKey) => fs.readFileSync(abs(WORKFLOWS, `drift-${projectKey}.md`), "utf8");
export const driftPreset = (projectKey) => projectOf(presetManifest(), projectKey);

/** The compiled lock file of a project, parsed; `header` is its gh-aw-manifest comment as an object. */
export function driftLock(projectKey) {
  const text = fs.readFileSync(abs(WORKFLOWS, `drift-${projectKey}.lock.yml`), "utf8");
  const manifest = /^# gh-aw-manifest: (.+)$/m.exec(text);
  return { text, workflow: YAML.parse(text), header: manifest ? JSON.parse(manifest[1]) : null };
}

/** All files below a directory as POSIX paths relative to it, sorted. */
export function listTree(root, start = "") {
  const found = [];
  const base = path.join(root, start);
  if (!fs.existsSync(base)) return found;
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop();
    if (fs.lstatSync(current).isDirectory()) for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    else found.push(path.relative(root, current).split(path.sep).join("/"));
  }
  return found.sort();
}

/** "path:sha256" lines of every file below a directory. */
export const hashTree = (root) => listTree(root).map((file) => `${file}:${sha256(fs.readFileSync(path.join(root, file)))}`).join("\n");

/** Every file below a directory as { POSIX path relative to it: text }. */
export function readTree(root) {
  return Object.fromEntries(listTree(root).map((file) => [file, fs.readFileSync(path.join(root, ...file.split("/")), "utf8")]));
}

/** A scratch directory that the caller removes. */
export function tempDir(prefix = "sdlc-s2-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copies a fixture directory (or the files of a map) into a new scratch directory. */
export function copyFixture(...parts) {
  const directory = tempDir();
  fs.cpSync(fixture(...parts), directory, { recursive: true });
  return directory;
}

export function writeTree(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/** The step of a job or section whose `run` contains the text. */
export const stepWith = (steps, text) => steps.find((step) => typeof step.run === "string" && step.run.includes(text));

/** A drift workflow rendered from a manifest in a fixture directory (no file is written). */
export async function renderIn(directory, request = referenceRequest()) {
  const { renderFleet } = await import("../../../src/reconcile.mjs");
  const result = renderFleet(request, { cwd: directory });
  if (!result.ok) throw new Error(JSON.stringify(result.result));
  return result;
}
