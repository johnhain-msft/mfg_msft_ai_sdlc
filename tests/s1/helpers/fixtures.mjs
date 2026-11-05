// Paths, readers and small parsers shared by the tests/s1 suite.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = path.join(REPO_ROOT, "tests", "s1", "fixtures");
export const WORKFLOWS = ".github/workflows";

export const abs = (...parts) => path.join(REPO_ROOT, ...parts);
export const fixture = (...parts) => path.join(FIXTURES, ...parts);
export const readText = (file) => fs.readFileSync(file, "utf8");
export const readJson = (file) => JSON.parse(readText(file));
export const readYaml = (file) => YAML.parse(readText(file));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const clone = (value) => structuredClone(value);

/** The request that the committed workflows were rendered from. */
export const referenceRequest = () => readJson(fixture("request.reference.json"));

/** A copy of a request with a shallow patch (securityBaseline patches are merged one level deep). */
export function withRequest(patch = {}, base = referenceRequest()) {
  const request = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete request[key];
    else request[key] = value;
  }
  return request;
}

export const presetManifest = () => readYaml(abs("sdlc.yaml"));
export const minimalManifest = () => readYaml(fixture("manifest.minimal.yaml"));
export const toYaml = (value) => YAML.stringify(value, { lineWidth: 0 });

/** Applies `change` to a deep copy of a manifest object and returns the copy. */
export function mutate(manifest, change) {
  const copy = clone(manifest);
  change(copy);
  return copy;
}

export const edgeOf = (manifest, edgeId) => manifest.dependencyEdges.find((edge) => edge.edgeId === edgeId);
export const projectOf = (manifest, projectKey) => manifest.projects.find((project) => project.projectKey === projectKey);

/** Splits a generated workflow into its parsed frontmatter and its Markdown body. */
export function parseWorkflow(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("the workflow has no frontmatter");
  return { frontmatter: YAML.parse(match[1]), frontmatterText: match[1], body: match[2] };
}

export const readWorkflow = (name) => parseWorkflow(readText(abs(WORKFLOWS, name)));

/** Every file under a fixture directory as a Map of `.github/workflows/<name>` to its text. */
export function loadRenderedFixture(directory = fixture("rendered-minimal")) {
  const files = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    files.set(`${WORKFLOWS}/${name}`, readText(path.join(directory, name)));
  }
  return files;
}

/** Step list of a job or of a top-level key such as `pre-agent-steps`. */
export const stepsOf = (value) => (Array.isArray(value) ? value : value?.steps ?? []);

/** The built-in jobs whose `if:` the renderer guards with the agent-success condition (AC29); they are sections, not custom jobs. */
export const BUILT_IN_JOB_SECTIONS = ["detection", "safe_outputs"];
export const AGENT_SUCCESS_GUARD = "needs.agent.result == 'success'";

/** The custom jobs among the `jobs:` entries of a generated workflow (AC35): everything but the built-in guard sections. */
export function customJobsOf(jobs = {}) {
  return Object.fromEntries(Object.entries(jobs).filter(([name]) => !BUILT_IN_JOB_SECTIONS.includes(name)));
}

/** Glob match for allowed-files style patterns: `**` crosses directories, `*` and `?` do not. */
export function globMatches(pattern, file) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(file);
}

/** The step whose `run` contains the text. */
export const stepWithRun = (steps, text) => steps.find((step) => typeof step.run === "string" && step.run.includes(text));

/** Sorted POSIX paths of every file below a directory, relative to it. */
export function listFiles(root, start = "") {
  const found = [];
  const base = path.join(root, start);
  if (!fs.existsSync(base)) return found;
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop();
    if (fs.lstatSync(current).isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else {
      found.push(path.relative(root, current).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

/** A stable "path:sha256" listing of every file below the given roots (files and directories). */
export function hashListing(root, relatives) {
  const lines = [];
  for (const relative of relatives) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) continue;
    const files = fs.lstatSync(target).isDirectory() ? listFiles(root, relative) : [relative];
    for (const file of files) lines.push(`${file}:${sha256(fs.readFileSync(path.join(root, file)))}`);
  }
  return lines.sort().join("\n");
}
