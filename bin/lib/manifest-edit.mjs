// Writing the onboarding entries into sdlc.yaml without disturbing it (AC51).
//
// The merge is defined on plain data (mergeEntry): a new entry is appended, an existing entry gains the fields it
// misses, and a field is only changed when its flag was passed explicitly in this run. applyDataToText then turns the
// difference between the old and the new document into the smallest text edits (insert a key, replace a scalar,
// append an array item), so that every other byte of the file — comments, blank lines, key order, quoting — stays as it
// was. A file that already holds the entries is left byte-identical.

import YAML from "yaml";
import { SdlcError } from "./errors.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const URL_ARRAY_PATH = "driftAudit.knowledgeSources.watchUrls";

/**
 * The entry after an onboarding run: missing fields are filled from `synthesized`, fields whose dotted path is in
 * `explicit` take the synthesized value, everything else keeps its existing value.
 */
export function mergeEntry(existing, synthesized, explicit, prefix = "") {
  const merged = clone(existing);
  for (const [key, value] of Object.entries(synthesized)) {
    const dotted = `${prefix}${key}`;
    if (!(key in existing)) {
      merged[key] = clone(value);
    } else if (isObject(existing[key]) && isObject(value)) {
      merged[key] = mergeEntry(existing[key], value, explicit, `${dotted}.`);
    } else if (explicit.has(dotted)) {
      if (dotted === URL_ARRAY_PATH && Array.isArray(existing[key]) && Array.isArray(value)) {
        merged[key] = [...existing[key], ...value.filter((entry) => !existing[key].some((known) => known?.url === entry.url))].map(clone);
      } else {
        merged[key] = clone(value);
      }
    }
  }
  return merged;
}

/**
 * The manifest after an onboarding run, as plain data.
 * @param {object} data the parsed sdlc.yaml
 * @param {{ project: object, explicitProject: Set<string>, downstreamProject?: object, edge?: object, explicitEdge?: Set<string> }} change
 * @returns {{ data: object, touched: string[], keyCollision: string|null }} `touched` lists the projectKeys that were added or changed
 */
export function planManifestUpdate(data, { project, explicitProject, downstreamProject, edge, explicitEdge = new Set() }) {
  const merged = clone(data);
  merged.projects = merged.projects ?? [];
  const touched = [];

  const upsertProject = (entry, explicit) => {
    const index = merged.projects.findIndex((candidate) => candidate.projectKey === entry.projectKey);
    if (index === -1) {
      merged.projects.push(clone(entry));
      touched.push(entry.projectKey);
      return null;
    }
    const existing = merged.projects[index];
    if (String(existing.repo).toLowerCase() !== entry.repo.toLowerCase()) {
      return `the projectKey '${entry.projectKey}' is already used by ${existing.repo}, so ${entry.repo} cannot be onboarded under the same key; rename the existing project or onboard the repository by hand`;
    }
    const next = mergeEntry(existing, entry, explicit);
    if (!same(next, existing)) touched.push(entry.projectKey);
    merged.projects[index] = next;
    return null;
  };

  const collision = upsertProject(project, explicitProject);
  if (collision) return { data, touched: [], keyCollision: collision };
  if (downstreamProject && !merged.projects.some((candidate) => String(candidate.repo).toLowerCase() === downstreamProject.repo.toLowerCase())) {
    const second = upsertProject(downstreamProject, new Set());
    if (second) return { data, touched: [], keyCollision: second };
  }
  if (edge) {
    merged.dependencyEdges = merged.dependencyEdges ?? [];
    const index = merged.dependencyEdges.findIndex((candidate) => candidate.edgeId === edge.edgeId);
    if (index === -1) {
      merged.dependencyEdges.push(clone(edge));
    } else {
      const existing = merged.dependencyEdges[index];
      if (String(existing.downstreamRepo).toLowerCase() !== edge.downstreamRepo.toLowerCase()) {
        return {
          data,
          touched: [],
          keyCollision: `the edge '${edge.edgeId}' already runs from ${existing.upstreamRepo} to ${existing.downstreamRepo}; one upstream has one edge in the fleet manifest, so it cannot also feed ${edge.downstreamRepo}`,
        };
      }
      merged.dependencyEdges[index] = mergeEntry(existing, edge, explicitEdge);
    }
  }
  return { data: merged, touched, keyCollision: null };
}

// ---------------------------------------------------------------------------------------
// Text edits
// ---------------------------------------------------------------------------------------

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const lineStartOf = (text, offset) => text.lastIndexOf("\n", offset - 1) + 1;
const columnOf = (text, offset) => offset - lineStartOf(text, offset);

/** Start of the line after the one on which the content that ends at `end` ends (or the end of the text). */
function lineAfter(text, end) {
  if (end > 0 && text[end - 1] === "\n") return end;
  const next = text.indexOf("\n", end);
  return next === -1 ? text.length : next + 1;
}

function insertLines(text, offset, lines, eol) {
  const prefix = offset === text.length && text.length > 0 && !text.endsWith("\n") ? eol : "";
  return `${text.slice(0, offset)}${prefix}${lines.join(eol)}${eol}${text.slice(offset)}`;
}

function documentOf(value) {
  const document = new YAML.Document(value);
  YAML.visit(document, {
    Pair(_, pair) {
      if (pair.key?.value === "schedule" && typeof pair.value?.value === "string") pair.value.type = "QUOTE_DOUBLE";
    },
  });
  return document;
}

const linesOf = (value) => documentOf(value).toString({ lineWidth: 0, indent: 2 }).replace(/\n$/, "").split("\n");

function scalarText(node, value) {
  if (typeof value !== "string") return YAML.stringify(value).trimEnd();
  if (node.type === "QUOTE_DOUBLE" || value.includes("\n")) return JSON.stringify(value);
  const plain = YAML.stringify(value, { lineWidth: 0 }).trimEnd();
  return plain.includes("\n") ? JSON.stringify(value) : plain;
}

const nodeAt = (document, path) => (path.length === 0 ? document.contents : document.getIn(path, true));

function applyEdit(text, edit) {
  const eol = eolOf(text);
  const document = YAML.parseDocument(text);
  const { path } = edit;
  if (edit.op === "insert-key") {
    const map = nodeAt(document, path);
    if (!YAML.isMap(map) || map.flow || map.items.length === 0) return null;
    const indent = columnOf(text, map.items[0].key.range[0]);
    const last = map.items.at(-1);
    const end = (last.value ?? last.key).range[1];
    const lines = linesOf({ [edit.key]: edit.value }).map((line) => `${" ".repeat(indent)}${line}`);
    if (path.length === 0) lines.unshift("");
    return insertLines(text, lineAfter(text, end), lines, eol);
  }
  if (edit.op === "append-items") {
    const sequence = nodeAt(document, path);
    if (!YAML.isSeq(sequence)) return null;
    const topLevel = path.length === 1;
    if (sequence.flow) {
      if (sequence.items.length > 0) return null;
      const parent = nodeAt(document, path.slice(0, -1));
      const pair = YAML.isMap(parent) ? parent.items.find((candidate) => candidate.key?.value === path.at(-1)) : null;
      if (!pair) return null;
      const keyColumn = columnOf(text, pair.key.range[0]);
      const head = text.slice(0, sequence.range[0]).replace(/[ \t]+$/, "");
      const lineEnd = lineAfter(text, sequence.range[1]);
      const tail = text.slice(sequence.range[1], lineEnd);
      const lines = edit.items.flatMap((item) => linesOf([item]).map((line) => `${" ".repeat(keyColumn + 2)}${line}`));
      return `${head}${tail}${lines.join(eol)}${eol}${text.slice(lineEnd)}`;
    }
    const dashColumn = columnOf(text, sequence.items[0].range[0]) - 2;
    const lines = edit.items.flatMap((item) => [...(topLevel ? [""] : []), ...linesOf([item]).map((line) => `${" ".repeat(Math.max(dashColumn, 0))}${line}`)]);
    return insertLines(text, lineAfter(text, sequence.items.at(-1).range[1]), lines, eol);
  }
  if (edit.op === "replace") {
    const node = nodeAt(document, path);
    if (!YAML.isScalar(node)) return null;
    return `${text.slice(0, node.range[0])}${scalarText(node, edit.value)}${text.slice(node.range[1])}`;
  }
  return null;
}

function diffEdits(path, before, after, edits) {
  if (isObject(before) && isObject(after)) {
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) edits.push({ op: "insert-key", path, key, value });
      else diffEdits([...path, key], before[key], value, edits);
    }
  } else if (Array.isArray(before) && Array.isArray(after)) {
    if (after.length < before.length) {
      edits.push({ op: "unsupported", path });
      return;
    }
    for (let index = 0; index < before.length; index += 1) diffEdits([...path, index], before[index], after[index], edits);
    if (after.length > before.length) edits.push({ op: "append-items", path, items: after.slice(before.length) });
  } else if (!same(before, after)) {
    edits.push({ op: "replace", path, value: after });
  }
}

/** The full-document fallback for the shapes the text editor does not handle (it may re-format the file). */
function reserialize(text, data) {
  const document = YAML.parseDocument(text);
  document.contents = document.createNode(data);
  return document.toString({ lineWidth: 0, indent: 2 });
}

/**
 * Turns the change from `original` to `merged` into text edits.
 * @returns {string} the new text; identical to `text` when nothing changed
 * @throws {SdlcError} when the edited text does not parse back to `merged`
 */
export function applyDataToText(text, original, merged) {
  const edits = [];
  diffEdits([], original, merged, edits);
  let current = text;
  let exact = true;
  for (const edit of edits) {
    const next = edit.op === "unsupported" ? null : applyEdit(current, edit);
    if (next === null) {
      exact = false;
      break;
    }
    current = next;
  }
  if (!exact) current = reserialize(text, merged);
  let reparsed;
  try {
    reparsed = YAML.parse(current);
  } catch (error) {
    throw new SdlcError(`internal error: the edited manifest is not valid YAML (${error.message.split("\n")[0]}); nothing was written`, { code: "manifest-edit" });
  }
  if (!same(reparsed, merged)) {
    throw new SdlcError("internal error: the edited manifest does not hold exactly the intended entries; nothing was written", { code: "manifest-edit" });
  }
  return current;
}
