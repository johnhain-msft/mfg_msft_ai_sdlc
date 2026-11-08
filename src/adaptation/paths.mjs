// Path matching for the verification of the AI adaptation helpers.

const escapeLiteral = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * The expression for one `allowed-files` pattern with the meaning that gh-aw gives it: `*` matches any characters except `/`, `**` matches any
 * characters including `/`, and every other character is literal. The match is anchored and case-sensitive.
 */
export function allowedPattern(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
    } else {
      source += escapeLiteral(pattern[i]);
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when a repository-relative path matches one of the `allowed-files` patterns. */
export const allowedBy = (patterns, file) => patterns.some((pattern) => allowedPattern(pattern).test(file));

const normalise = (entry) => entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** A zero-diff entry names a file, a directory (everything beneath it) or, with a wildcard, a pattern: does it cover this path? */
export function covers(entry, file) {
  const wanted = normalise(entry);
  if (/[*?]/.test(wanted)) return allowedPattern(wanted).test(file) || allowedPattern(`${wanted}/**`).test(file);
  return file === wanted || file.startsWith(`${wanted}/`);
}

/** The path of an import specifier relative to the file that holds it, without an extension, or null for a specifier that is not relative. */
export function resolveRelative(importer, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && specifier !== "." && specifier !== "..") return null;
  const parts = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return stripExtension(parts.join("/"));
}

/** The path without a script extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) and without a trailing `/index`. */
export function stripExtension(file) {
  return file.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}
