// Paths, readers and small helpers shared by the tests/s2 suite. The rendering helpers come from the S1 suite, so that
// the S2 tests judge the very workflows that the reconciler renders and commits.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { engineFile, expandFactoryCommand, FACTORY_DIR } from "../../helpers/instance.mjs";
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

export { abs, customJobsOf, expandFactoryCommand, FACTORY_DIR, minimalManifest, mutate, parseWorkflow, presetManifest, projectOf, readText, readWorkflow, referenceRequest, REPO_ROOT, toYaml };

export const S2_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const FIXTURES = path.join(S2_ROOT, "fixtures");
export const WORKFLOWS = ".github/workflows";
/** The preset's drift workflows: the project key of each. */
export const DRIFT_KEYS = ["gh-admin-msft", "copilot-lab", "self-improving-agents"];

export const fixture = (...parts) => path.join(FIXTURES, ...parts);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const readYaml = (file) => YAML.parse(fs.readFileSync(file, "utf8"));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
/** A script of the installed engine package: `engineScript("drift", "dedupe-open-prs.mjs")` is <engine>/src/drift/dedupe-open-prs.mjs. */
export const engineScript = (...parts) => engineFile("src", ...parts);
/** A script of this repository: `instanceScript("validate-copilot-lab-audit.mjs")` is scripts/validate-copilot-lab-audit.mjs. */
export const instanceScript = (name) => abs("scripts", name);
/** The verifyCommands of a project as the renderer writes them into its post-steps: the manifest's engine placeholders expanded. */
export const renderedVerifyCommands = (projectKey) => projectOf(presetManifest(), projectKey).driftAudit.verifyCommands.map(expandFactoryCommand);

/** The committed workflow of a project: frontmatter, text of the frontmatter and Markdown body. */
export const driftWorkflow = (projectKey) => readWorkflow(`drift-${projectKey}.md`);
export const driftWorkflowText = (projectKey) => fs.readFileSync(abs(WORKFLOWS, `drift-${projectKey}.md`), "utf8");
export const driftPreset = (projectKey) => projectOf(presetManifest(), projectKey);

/** The committed implementation workflow of a project (SPEC-02 AC45): frontmatter, text of the frontmatter and Markdown body. */
export const implementWorkflow = (projectKey) => readWorkflow(`implement-${projectKey}.md`);

/** The compiled lock file of a project's drift workflow (or of another of its workflows), parsed; `header` is its gh-aw-manifest comment as an object. */
export function driftLock(projectKey, prefix = "drift") {
  const text = fs.readFileSync(abs(WORKFLOWS, `${prefix}-${projectKey}.lock.yml`), "utf8");
  const manifest = /^# gh-aw-manifest: (.+)$/m.exec(text);
  return { text, workflow: YAML.parse(text), header: manifest ? JSON.parse(manifest[1]) : null };
}

/** The compiled lock file of a project's implementation workflow, parsed. */
export const implementLock = (projectKey) => driftLock(projectKey, "implement");

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

const scratch = new Set();

/**
 * Removes a directory tree, one that a test staged read-only (files 0444, directories 0555, as prepare-run stages the validator) as well as an
 * ordinary one: it makes the tree writable first, because a directory without write permission cannot have its entries removed. It never follows
 * a link: a junction or a link is unlinked, so the tree that it points to is left alone.
 */
export function forceRemove(directory) {
  const makeWritable = (target) => {
    let entries;
    try {
      entries = fs.readdirSync(target);
      fs.chmodSync(target, 0o755);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = path.join(target, name);
      try {
        const stat = fs.lstatSync(child);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) makeWritable(child);
        else fs.chmodSync(child, 0o644);
      } catch {
        // an entry that is gone, or one that cannot be changed: rmSync below decides
      }
    }
  };
  makeWritable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

// A test that does not remove its scratch directory would leave it in the temporary directory for good (a full run leaves about a hundred and
// forty), so whatever is still there when the test process exits is removed here. rmSync unlinks a junction or a link and never follows it.
process.once("exit", () => {
  for (const directory of scratch) {
    try {
      forceRemove(directory);
    } catch {
      // best effort: a scratch directory is only litter
    }
  }
});

/** A scratch directory that the caller removes; one that is left behind is removed when the test process exits. */
export function tempDir(prefix = "sdlc-s2-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.add(directory);
  return directory;
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
