// Loads a YAML document for a drift script.
//
// The `yaml` package parses it when it can be imported. When it cannot (the script runs in a job that never ran `npm ci`)
// the dependency-free reader of `yaml-subset.mjs` does, and it fails on anything it does not support. Both give the same
// value for the manifests that this repository uses, which tests/s2/snapshot-watch-sources.test.mjs checks.

import { parseYamlSubset } from "./yaml-subset.mjs";

let standard;

async function standardParser() {
  if (standard === undefined) {
    try {
      const module = await import("yaml");
      standard = module.default ?? module;
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "MODULE_NOT_FOUND") throw error;
      standard = null;
    }
  }
  return standard;
}

/**
 * @param {string} text
 * @param {{ parser?: "auto" | "subset" | "yaml" }} [options] `auto` prefers the `yaml` package
 */
export async function loadYaml(text, { parser = "auto" } = {}) {
  if (parser !== "subset") {
    const yaml = await standardParser();
    if (yaml !== null) return yaml.parse(String(text));
    if (parser === "yaml") throw new Error("the 'yaml' package is not installed");
  }
  return parseYamlSubset(text);
}
