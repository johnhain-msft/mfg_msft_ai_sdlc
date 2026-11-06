// Writing the onboarding entries into sdlc.yaml without disturbing it (AC51).
//
// The merge is defined on plain data (mergeEntry): a new entry is appended, an existing entry gains the fields it
// misses, and a field is only changed when its flag was passed explicitly in this run. applyDataToText then turns the
// difference between the old and the new document into the smallest text edits (insert a key, replace a scalar,
// append an array item), so that every other byte of the file — comments, blank lines, key order, quoting — stays as it
// was. A file that already holds the entries is left byte-identical. An edit that cannot be made in place (a field that
// is reached through an alias or a merge key, say) is refused: the file is never rebuilt from the data, because that
// would delete comments and blank lines and re-style entries that this run was not asked to change.

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

function documentOf(value, { flow = false } = {}) {
  const document = new YAML.Document(value);
  YAML.visit(document, {
    Pair(_, pair) {
      if (pair.key?.value === "schedule" && typeof pair.value?.value === "string") pair.value.type = "QUOTE_DOUBLE";
    },
    // inside a flow collection a string with a line break has to be one double-quoted line: a block scalar is not allowed there
    // and a folded one would break the indentation that a flow collection in a block collection needs
    Scalar(_, node) {
      if (flow && typeof node.value === "string" && node.value.includes("\n")) node.type = "QUOTE_DOUBLE";
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

/** `value` as one single-line flow node, for insertion inside a flow collection (a block scalar or block collection is not allowed there). */
function flowText(value) {
  if (value === null || typeof value !== "object") return scalarText({}, value);
  return documentOf(value, { flow: true }).toString({ lineWidth: 0, indent: 2, collectionStyle: "flow" }).trimEnd();
}

/** `key: value` in flow style: the text of one entry of a flow mapping. */
function flowPair(key, value) {
  const match = /^\{ ([\s\S]*) \}$/.exec(flowText({ [key]: value }));
  return match ? match[1] : null;
}

/** True when a collection above the node at `path` is written in flow style, so that the node itself can only be edited in flow style. */
function inFlowContext(document, path) {
  for (let length = 0; length < path.length; length += 1) {
    const ancestor = nodeAt(document, path.slice(0, length));
    if (YAML.isCollection(ancestor) && ancestor.flow) return true;
  }
  return false;
}

/** The end of the last entry of a non-empty flow collection (an entry without a value ends with its key). */
const endOfLastEntry = (collection) => {
  const last = collection.items.at(-1);
  return YAML.isPair(last) ? (last.value ?? last.key).range[1] : last.range[1];
};

/**
 * An empty flow collection (`{}` or `[]`) that is the value of a block-mapping key becomes a block collection on the lines
 * after its key, the way a new entry is written; a comment after the empty collection stays on the key's line. Returns null
 * when the collection is not the value of a key that sits on the same line.
 */
function expandEmptyFlow({ text, document, path, node, blockLines, eol }) {
  const parent = nodeAt(document, path.slice(0, -1));
  const pair = YAML.isMap(parent) ? parent.items.find((candidate) => candidate.key?.value === path.at(-1)) : null;
  if (!pair || pair.value !== node) return null;
  const head = text.slice(0, node.range[0]).replace(/[ \t]+$/, "");
  if (head === "" || head.endsWith("\n")) return null;
  const keyColumn = columnOf(text, pair.key.range[0]);
  const lineEnd = lineAfter(text, node.range[1]);
  const tail = text.slice(node.range[1], lineEnd);
  const lineBreak = tail.endsWith("\n") ? "" : eol; // the last line of the file may have no line break of its own
  const lines = blockLines.map((line) => `${" ".repeat(keyColumn + 2)}${line}`);
  return `${head}${tail}${lineBreak}${lines.join(eol)}${eol}${text.slice(lineEnd)}`;
}

/**
 * Adds entries to a flow collection. An empty collection that stands in block context is expanded (expandEmptyFlow); every
 * other one — empty or not, and every one inside another flow collection, where a block collection is not allowed — is
 * extended in place, in flow style, so that only the line of the collection changes.
 * @param {string[]} entries the new entries as flow text (`key: value` pairs of a mapping, items of a sequence)
 * @param {string[]} blockLines the same entries as block-style lines
 */
function extendFlow({ text, document, path, node, entries, blockLines, eol }) {
  const [start, end] = node.range;
  const inner = text.slice(start + 1, end - 1);
  if (node.items.length === 0) {
    if (inner.trim() === "" && !inFlowContext(document, path)) {
      const expanded = expandEmptyFlow({ text, document, path, node, blockLines, eol });
      if (expanded !== null) return expanded;
    }
    if (inner.trim() === "") return `${text.slice(0, start)}${text[start]} ${entries.join(", ")} ${text[end - 1]}${text.slice(end)}`;
    return `${text.slice(0, start + 1)} ${entries.join(", ")}${text.slice(start + 1)}`; // a comment inside the brackets stays where it is
  }
  const after = endOfLastEntry(node);
  return `${text.slice(0, after)}, ${entries.join(", ")}${text.slice(after)}`;
}

/** `projects[1].driftAudit.schedule` for the path ["projects", 1, "driftAudit", "schedule"]. */
const describePath = (path) => path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${part}`)).join("") || "the top level";

function applyEdit(text, edit) {
  const eol = eolOf(text);
  const document = YAML.parseDocument(text);
  const { path } = edit;
  if (edit.op === "insert-key") {
    const map = nodeAt(document, path);
    if (!YAML.isMap(map)) return null;
    if (map.flow) {
      const entry = flowPair(edit.key, edit.value);
      return entry === null ? null : extendFlow({ text, document, path, node: map, entries: [entry], blockLines: linesOf({ [edit.key]: edit.value }), eol });
    }
    if (map.items.length === 0) return null;
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
      return extendFlow({ text, document, path, node: sequence, entries: edit.items.map(flowText), blockLines: edit.items.flatMap((item) => linesOf([item])), eol });
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

/**
 * Turns the change from `original` to `merged` into text edits.
 * @param {string} text the manifest as it is on disk
 * @param {object} original the parsed `text`
 * @param {object} merged the document that the edited text has to parse to
 * @param {{ label?: string }} [options] how the manifest is named in a diagnostic
 * @returns {string} the new text; identical to `text` when nothing changed
 * @throws {SdlcError} when an edit cannot be made in place (the file is never rebuilt from the data, so no comment, blank
 *   line or style of an entry that was not asked to change is lost), or when the edited text does not parse back to `merged`
 */
export function applyDataToText(text, original, merged, { label = "the manifest" } = {}) {
  const edits = [];
  diffEdits([], original, merged, edits);
  let current = text;
  for (const edit of edits) {
    const next = edit.op === "unsupported" ? null : applyEdit(current, edit);
    if (next === null) {
      throw new SdlcError(
        `${label} cannot be updated in place at ${describePath(edit.path)}: the field is reached through an alias or a merge key, or its form is not one that can be edited without ` +
          `rewriting the file, which would change comments, blank lines and entries that this run was not asked to change. Nothing was written; edit ${label} by hand.`,
        { code: "manifest-edit" },
      );
    }
    current = next;
  }
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
