// Glob matching and directory listing for the packageManifests patterns (SPEC-02 AC12).
//
// A pattern is relative to the target checkout. `*` and `?` stay inside one path segment, `**` crosses directories
// (`**/x` also matches a root-level x), `{a,b}` chooses between alternatives, everything else is literal and the match
// is case-sensitive, as in git. The listing never follows a symbolic link and never enters `.git` or `node_modules`.

import nodeFs from "node:fs";
import path from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_ENTRIES = 50000;

/** Throws for a pattern that is empty, absolute or leaves the checkout. */
export function assertRelativePattern(pattern) {
  const text = String(pattern ?? "");
  if (text.trim() === "") throw new Error("a package manifest pattern is empty");
  if (/^[/\\]/.test(text) || /^[A-Za-z]:/.test(text) || text.includes("\\") || text.includes("\0")) {
    throw new Error(`the package manifest pattern '${text}' must be a relative POSIX path`);
  }
  if (text.split("/").includes("..")) throw new Error(`the package manifest pattern '${text}' leaves the checkout`);
  return text;
}

function segmentToSource(segment) {
  let source = "";
  let depth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      depth += 1;
      source += "(?:";
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      source += ")";
    } else if (char === "," && depth > 0) source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/[{}]/g, "\\$&");
  }
  if (depth !== 0) throw new Error(`the pattern segment '${segment}' has an unbalanced brace`);
  return source;
}

/** The anchored expression that a relative POSIX path must match. */
export function globToRegExp(pattern) {
  const segments = assertRelativePattern(pattern).replace(/^\.\//, "").split("/").filter((segment) => segment !== "" && segment !== ".");
  let source = "";
  segments.forEach((segment, position) => {
    const last = position === segments.length - 1;
    if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += segmentToSource(segment) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`);
}

export const matchesGlob = (pattern, relativePath) => globToRegExp(pattern).test(relativePath);

/** Sorted POSIX paths (relative to `root`) of every regular file below it. */
export function listFiles(root, { fs = nodeFs } = {}) {
  const found = [];
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop();
    const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        found.push(child);
        if (found.length > MAX_ENTRIES) throw new Error(`the checkout holds more than ${MAX_ENTRIES} files`);
      }
    }
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
