// Scenarios for the immutable-gate tests: a copy of the minimal synthetic portfolio, a base commit, a change committed on top of it, and the command run under
// `node --frozen-intrinsics` from the orchestrator checkout (whose sdlc.yaml is the preset the fixture mirrors).
import path from "node:path";
import YAML from "yaml";
import { HELPERS, REPO_ROOT, abs, commitAll, installVitestStub, jsonOf, passingReport, portfolioMin, readText, runNode, writeFiles } from "./fixtures.mjs";

export const preset = YAML.parse(readText(abs("sdlc.yaml")));
export const edgeOf = (edgeId) => preset.dependencyEdges.find((edge) => edge.edgeId === edgeId);
export const WORKFLOWS = ["cascade-ai-copilot-lab", "cascade-ai-pipeline-showcase", "cascade-ai-github-intermediate"];
export const policyOf = (workflow) => edgeOf(workflow.replace(/^cascade-ai-/, "")).immutableGates;

export const read = (dir, relative) => readText(path.join(dir, ...relative.split("/")));

/**
 * @param {object} [options]
 * @param {(dir: string) => object} [options.prepare] files (null deletes) committed as part of the base
 * @param {(dir: string) => object} [options.mutate] files (null deletes) committed on top of the base: the change that is checked
 * @param {object} [options.report] the Vitest report that the stand-in writes (default: every locked block of the workflow passed)
 * @param {boolean} [options.commit] false leaves the mutation uncommitted, in the work tree
 */
export function scenario({ workflow = "cascade-ai-copilot-lab", prepare, mutate, report, commit = true } = {}) {
  const { dir, base: original } = portfolioMin();
  installVitestStub(dir, report ?? passingReport(policyOf(workflow).lockedTestBlocks));
  let base = original;
  if (prepare) {
    writeFiles(dir, prepare(dir));
    base = commitAll(dir, "prepare the base");
  }
  if (mutate) {
    writeFiles(dir, mutate(dir));
    if (commit) commitAll(dir, "the change under test");
  }
  return {
    dir,
    base,
    run: (options = {}) => runGates(dir, base, workflow, options),
  };
}

/** Runs the command; the result carries the parsed JSON of its standard output. */
export function runGates(dir, base, workflow, { cwd = REPO_ROOT, frozen = true, env = {}, args } = {}) {
  const result = runNode(HELPERS.gates, args ?? ["--portfolio", dir, "--base", base, "--workflow", workflow], { cwd, frozen, env });
  return { ...result, json: jsonOf(result.stdout) };
}

/** The message that a failed assertion shows: both streams of the command. */
export const shown = (result) => `exit ${result.code}\n${result.stdout}\n${result.stderr}`;

/** The text of a locked block (or any substring) replaced once; the replacement must change the text. */
export function replaceOnce(text, from, to) {
  if (!text.includes(from)) throw new Error(`the fixture does not contain: ${from}`);
  return text.replace(from, () => to);
}
