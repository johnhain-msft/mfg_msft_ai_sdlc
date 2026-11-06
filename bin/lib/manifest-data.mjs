// Reading the fleet manifest for what S5 needs (edges, projects, deconfliction options). S5 never validates the
// manifest against the schema itself: S1 owns that (contract C1); these checks only keep S5 from acting on a
// document it cannot interpret.

import fs from "node:fs";
import YAML from "yaml";
import { SdlcError } from "./errors.mjs";
import { isRepoSlug } from "./validators.mjs";

/** Reads and parses the manifest; returns { text, data }. */
export function readManifest(absolutePath, displayPath = absolutePath) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new SdlcError(`${displayPath} cannot be read: ${error.message}`, { code: "manifest" });
  }
  const document = YAML.parseDocument(text.replace(/^\uFEFF/, ""));
  if (document.errors.length > 0) {
    throw new SdlcError(`${displayPath} is not valid YAML: ${document.errors[0].message.split("\n")[0]}`, { code: "manifest" });
  }
  const data = document.toJS({ maxAliasCount: 200 });
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.projects)) {
    throw new SdlcError(`${displayPath} is not a fleet manifest: it needs a 'projects' array (src/reconcile.mjs validates the rest)`, { code: "manifest" });
  }
  if (data.dependencyEdges !== undefined && !Array.isArray(data.dependencyEdges)) {
    throw new SdlcError(`${displayPath}: 'dependencyEdges' must be an array`, { code: "manifest" });
  }
  return { text, data };
}

/** The dependency edges that carry what the bootstrap needs to seed their state variables. */
export function stateEdges(manifest) {
  const edges = manifest.dependencyEdges ?? [];
  for (const edge of edges) {
    if (edge === null || typeof edge !== "object") throw new SdlcError("dependencyEdges holds an entry that is not a mapping", { code: "manifest" });
    if (!isRepoSlug(edge.downstreamRepo)) throw new SdlcError(`dependencyEdges entry '${edge.edgeId ?? "?"}' has no valid downstreamRepo`, { code: "manifest" });
  }
  return edges;
}
