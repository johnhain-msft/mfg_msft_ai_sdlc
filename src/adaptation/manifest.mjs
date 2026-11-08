// The data of the AI adaptation helpers, read from the fleet manifest (SPEC-04 AC1).
//
// The three helper commands name no repository, path or test title of their own: the zero-diff paths, the locked test blocks, the in-process
// invariants, the studio manifest, the revision-pin targets and their provenance files are data of the manifest (`sdlc.yaml`). The manifest is found
// in the current directory or in GITHUB_WORKSPACE, the checkout of the orchestrator, and never inside the downstream checkout under inspection: a
// file that the agent could have added to the downstream checkout is not a source of policy.
//
// The YAML is read by the `yaml` package when it can be imported and by the dependency-free reader of the drift scripts when it cannot (these
// commands run in jobs that never ran `npm ci`, and one of them runs under `--frozen-intrinsics`).

import fs from "node:fs";
import path from "node:path";
import { loadYaml } from "../drift/lib/yaml-load.mjs";

export const MANIFEST_FILE = "sdlc.yaml";

/** A problem with the manifest or with the data that a helper needs from it: the command exits 2 with this message. */
export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const realpath = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/** True when `child` is `parent` or lies beneath it. */
export function isInside(parent, child) {
  const relative = path.relative(realpath(parent), realpath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The manifest that applies: sdlc.yaml in the current directory, else in GITHUB_WORKSPACE; a candidate inside one of the `avoid` directories (the
 * downstream checkout that is being inspected) is skipped.
 * @returns {string | null} the absolute path, or null when no candidate exists
 */
export function locateManifest({ cwd, env = {}, avoid = [] }) {
  const roots = [cwd, env.GITHUB_WORKSPACE].filter((root) => typeof root === "string" && root !== "");
  for (const root of roots) {
    const candidate = path.resolve(root, MANIFEST_FILE);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (avoid.some((directory) => isInside(directory, candidate))) continue;
    return candidate;
  }
  return null;
}

/** @returns {Promise<{ file: string, document: object }>} */
export async function readManifest(options) {
  const file = locateManifest(options);
  if (file === null) throw new ManifestError(`${MANIFEST_FILE} was not found in the current directory or in GITHUB_WORKSPACE (outside the downstream checkout)`);
  let document;
  try {
    document = await loadYaml(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManifestError(`${file} cannot be read as YAML: ${error.message}`);
  }
  if (!isObject(document)) throw new ManifestError(`${file} is not a mapping`);
  return { file, document };
}

/** The workflow id of a dependency edge, as the reconciler names it. */
export const workflowIdOf = (edge) => (edge.mode === "mechanical" ? `cascade-mechanical-${edge.edgeId}` : `cascade-ai-${edge.edgeId}`);

/** The `ai-adaptation` edges of a manifest document. */
export function aiEdges(document) {
  const edges = Array.isArray(document.dependencyEdges) ? document.dependencyEdges : [];
  return edges.filter((edge) => isObject(edge) && edge.mode === "ai-adaptation" && typeof edge.edgeId === "string");
}

const stringList = (value, label) => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) throw new ManifestError(`${label} must be a list of non-empty strings`);
  return value;
};

/**
 * The immutable-gate data of the AI edge whose workflow id is `workflowId`, and the test files of its siblings: the companion files of the other AI
 * edges that deliver into the same downstream repository.
 * @returns {{ edge: object, zeroDiffPaths: string[], lockedTestBlocks: object[], inProcessInvariants: object, allowedFiles: string[], siblingTestFiles: string[] } | null}
 * null when no AI edge has that workflow id
 */
export function gatePolicyFor(document, workflowId) {
  const edges = aiEdges(document);
  const edge = edges.find((candidate) => workflowIdOf(candidate) === workflowId);
  if (edge === undefined) return null;
  const label = `the edge '${edge.edgeId}'`;
  const gates = edge.immutableGates;
  if (!isObject(gates)) throw new ManifestError(`${label} has no immutableGates`);
  const zeroDiffPaths = stringList(gates.zeroDiffPaths ?? [], `${label}: immutableGates.zeroDiffPaths`);
  const lockedTestBlocks = gates.lockedTestBlocks ?? [];
  if (!Array.isArray(lockedTestBlocks)) throw new ManifestError(`${label}: immutableGates.lockedTestBlocks must be a list`);
  for (const entry of lockedTestBlocks) {
    if (!isObject(entry) || typeof entry.file !== "string" || entry.file === "" || !Array.isArray(entry.blocks)) {
      throw new ManifestError(`${label}: every lockedTestBlocks entry needs a file and a list of blocks`);
    }
    for (const block of entry.blocks) {
      if (!isObject(block) || !["it", "describe"].includes(block.kind) || typeof block.title !== "string" || block.title === "") {
        throw new ManifestError(`${label}: every locked block needs a kind (it or describe) and a title`);
      }
    }
    if (entry.lockedImports !== undefined) stringList(entry.lockedImports, `${label}: lockedImports of ${entry.file}`);
  }
  const inProcessInvariants = gates.inProcessInvariants ?? {};
  if (!isObject(inProcessInvariants)) throw new ManifestError(`${label}: immutableGates.inProcessInvariants must be a mapping`);
  const own = new Set(lockedTestBlocks.map((entry) => entry.file));
  const siblingTestFiles = new Set();
  for (const other of edges) {
    if (other === edge || other.downstreamRepo !== edge.downstreamRepo) continue;
    const blocks = isObject(other.immutableGates) && Array.isArray(other.immutableGates.lockedTestBlocks) ? other.immutableGates.lockedTestBlocks : [];
    for (const entry of blocks) if (isObject(entry) && typeof entry.file === "string" && !own.has(entry.file)) siblingTestFiles.add(entry.file);
  }
  return {
    edge,
    zeroDiffPaths,
    lockedTestBlocks,
    inProcessInvariants,
    allowedFiles: stringList(edge.allowedFiles ?? [], `${label}: allowedFiles`),
    siblingTestFiles: [...siblingTestFiles].sort(),
  };
}

/**
 * One section of the `adaptation` data of the AI edges (for example `labStudioDrift`), or null when no AI edge declares it. Edges that declare it
 * differently are ambiguous, because the helper commands are not told which edge they serve.
 */
export function adaptationSection(document, name) {
  const found = [];
  for (const edge of aiEdges(document)) {
    const adaptation = edge.adaptation;
    if (isObject(adaptation) && adaptation[name] !== undefined) found.push({ edgeId: edge.edgeId, value: adaptation[name] });
  }
  if (found.length === 0) return null;
  const first = JSON.stringify(found[0].value);
  if (found.some((entry) => JSON.stringify(entry.value) !== first)) {
    throw new ManifestError(`the edges ${found.map((entry) => `'${entry.edgeId}'`).join(" and ")} declare different adaptation.${name} data, so the command cannot tell which one applies`);
  }
  return found[0].value;
}

/** A repository-relative path from the manifest: no absolute path, no drive letter, no `..` segment. */
export function relativePath(value, label) {
  if (typeof value !== "string" || value === "" || /^[/\\]/.test(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..") || /[\u0000-\u001f]/.test(value)) {
    throw new ManifestError(`${label} must be a path inside the repository`);
  }
  return value.replace(/\\/g, "/");
}

/** The value that a JSON Pointer (RFC 6901) names in a parsed document, or `undefined`. */
export function resolvePointer(document, pointer) {
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
