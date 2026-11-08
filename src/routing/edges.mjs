// The dependency edges that the S3 scripts read (SPEC-03 AC5, AC10, AC46): the edge of one router job from EDGE_JSON, and the edges of
// sdlc.yaml for the scripts that start from a slug or from a signal. Every repository, branch, key and variable name is data of an edge;
// nothing here names one.

import path from "node:path";
import YAML from "yaml";
import { assertShape, RoutingDataError, validateShape } from "./schema.mjs";

export const MANIFEST_FILE = "sdlc.yaml";

export const splitSlug = (slug) => {
  const text = String(slug);
  const slash = text.indexOf("/");
  return { owner: text.slice(0, slash), repo: text.slice(slash + 1) };
};

/** The identifier of the workflow that an edge dispatches, as SPEC-01 names it. */
export const cascadeWorkflowId = (edge) => (edge.mode === "mechanical" ? `cascade-mechanical-${edge.edgeId}` : `cascade-ai-${edge.edgeId}`);

/** The workflow file that is dispatched (the compiled lock file: contract C7 names it). */
export const cascadeWorkflowFile = (edge) => `${cascadeWorkflowId(edge)}.lock.yml`;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The edge of a router job (EDGE_JSON). @throws {RoutingDataError}
 * @returns {object}
 */
export function parseEdgeJson(text, expectedKey) {
  let edge;
  try {
    edge = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new RoutingDataError(`EDGE_JSON is not JSON: ${error.message}`);
  }
  assertShape("RouterEdge", edge, "EDGE_JSON");
  if (expectedKey !== undefined && edge.upstreamKey !== expectedKey) {
    throw new RoutingDataError(`EDGE_JSON describes the upstream '${edge.upstreamKey}', but this job routes '${expectedKey}'`);
  }
  return edge;
}

/**
 * The dependencyEdges of sdlc.yaml in `workspace`, each checked for the keys that S3 reads.
 * @param {{ fs: typeof import("node:fs") }} io
 * @returns {{ found: boolean, edges: object[] }} `found` is false when the file does not exist
 * @throws {RoutingDataError} when the file exists and cannot be read as a manifest
 */
export function loadManifestEdges(workspace, io) {
  const file = path.join(workspace, MANIFEST_FILE);
  let text;
  try {
    text = io.fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false, edges: [] };
    throw new RoutingDataError(`${file} cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new RoutingDataError(`${file} is not valid YAML: ${error.message}`);
  }
  if (!isObject(document)) throw new RoutingDataError(`${file} is not a mapping`);
  const raw = document.dependencyEdges ?? [];
  if (!Array.isArray(raw)) throw new RoutingDataError(`${file}: dependencyEdges is not a list`);
  const edges = raw.map((entry, index) => {
    const { valid, errors } = validateShape("ManifestEdge", entry);
    if (!valid) throw new RoutingDataError(`${file}: dependencyEdges[${index}] is not usable: ${errors.join("; ")}`);
    return entry;
  });
  return { found: true, edges };
}

/**
 * The edge whose upstreamSlug is `slug`, read from the manifest in `workspace`.
 * @returns {{ edge: object | null, reason: string | null }} `edge` is null when no entry (or more than one) names the slug
 * @throws {RoutingDataError} when the manifest cannot be read, or the entry that names the slug lacks what S3 needs
 */
export function findEdgeBySlug(workspace, slug, io) {
  const file = path.join(workspace, MANIFEST_FILE);
  let text;
  try {
    text = io.fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new RoutingDataError(`${file} cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new RoutingDataError(`${file} is not valid YAML: ${error.message}`);
  }
  const raw = isObject(document) && Array.isArray(document.dependencyEdges) ? document.dependencyEdges : [];
  const matches = raw.filter((entry) => isObject(entry) && entry.upstreamSlug === slug);
  if (matches.length === 0) return { edge: null, reason: `no dependencyEdges entry of ${file} has the upstreamSlug '${slug}'` };
  if (matches.length > 1) return { edge: null, reason: `${matches.length} dependencyEdges entries of ${file} have the upstreamSlug '${slug}'` };
  assertShape("ManifestEdge", matches[0], `the dependencyEdges entry '${slug}'`);
  return { edge: matches[0], reason: null };
}

/** The value that a JSON Pointer (RFC 6901) names in a parsed document, or `undefined`. */
export function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let current = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) return undefined;
      current = current[Number(key)];
    } else if (isObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}
