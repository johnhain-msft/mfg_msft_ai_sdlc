// The helper of the instance's own tests: the root of this repository, small readers over it, and the way to reach the engine package that it installs.
//
// The engine is a dependency (node_modules/ai-sdlc-factory), and its `exports` map publishes only five entries (the three modules of docs/api.md, the schemas
// and package.json). A test that has to run an engine script by path, or read an engine file, finds the package directory through package.json, which is
// exported, and imports a module of it by file URL. That is a deep import: it is not covered by the engine's semver, and the tests that do it are the ones
// that are meant to notice when the engine moves.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

export const INSTANCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const WORKFLOWS = ".github/workflows";

export const abs = (...parts) => path.join(INSTANCE_ROOT, ...parts);
export const readText = (file) => fs.readFileSync(file, "utf8");
export const readJson = (file) => JSON.parse(readText(file));
export const readYaml = (file) => YAML.parse(readText(file));

/** The manifest of this repository. */
export const presetManifest = () => readYaml(abs("sdlc.yaml"));

/** Splits a generated workflow into its parsed frontmatter and its Markdown body. */
export function parseWorkflow(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("the workflow has no frontmatter");
  return { frontmatter: YAML.parse(match[1]), frontmatterText: match[1], body: match[2] };
}

export const readWorkflow = (name) => parseWorkflow(readText(abs(WORKFLOWS, name)));

/**
 * The steps that install the engine package at the head of a list of steps: the step that mints the read token for the private engine repository (id factory_token) and
 * the `npm ci --ignore-scripts` that follows it, and what is left. A fleet whose engine is public has the install step alone.
 */
export function splitFactoryInstall(steps) {
  const count = steps[0]?.id === "factory_token" ? 2 : steps[0]?.run === "npm ci --ignore-scripts" ? 1 : 0;
  return { install: steps.slice(0, count), rest: steps.slice(count) };
}

/** The directory of the installed engine package. */
export const engineRoot = () => path.dirname(createRequire(import.meta.url).resolve("ai-sdlc-factory/package.json"));

/** A path inside the engine package. */
export const engineFile = (...parts) => path.join(engineRoot(), ...parts);

/** Imports a module of the engine package by its path inside it, for example `importEngine("src/drift/prepare-run.mjs")`. */
export const importEngine = (relative) => import(pathToFileURL(engineFile(...relative.split("/"))).href);

/** The directory of the engine package relative to the workspace of a job, as the manifest says it (`factory.dir`, else node_modules/<package>). */
export const FACTORY_DIR = (() => {
  const { factory } = presetManifest();
  return factory?.dir ?? (factory ? `node_modules/${factory.package}` : ".");
})();

/** A command of the manifest as the renderer writes it into a workflow: `<factory-dir>` is the relative directory, `<factory>` the quoted absolute one. */
export const expandFactoryCommand = (command) =>
  command.replaceAll("<factory-dir>", FACTORY_DIR).replaceAll("<factory>", `"${FACTORY_DIR === "." ? "$GITHUB_WORKSPACE" : `$GITHUB_WORKSPACE/${FACTORY_DIR}`}"`);

/**
 * Puts the engine package into a scratch workspace the way npm lays it out, as a copy of the files that a script needs (never a link into this repository):
 * `<dir>/node_modules/ai-sdlc-factory/package.json` and `src/`, so that `import "ai-sdlc-factory/drift-lib"` resolves from a script of the workspace. The exports that
 * such a script imports need no third-party package.
 */
export function installFactory(dir, { entries = ["package.json", "src"] } = {}) {
  const target = path.join(dir, ...FACTORY_DIR.split("/"));
  fs.mkdirSync(target, { recursive: true });
  for (const entry of entries) fs.cpSync(engineFile(entry), path.join(target, entry), { recursive: true });
  return target;
}
