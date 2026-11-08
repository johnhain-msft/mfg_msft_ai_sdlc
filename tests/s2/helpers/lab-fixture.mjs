// A lab-shaped checkout for the validator tests: the fixture tree under tests/s2/fixtures/lab/valid/ as a git repository.

import fs from "node:fs";
import path from "node:path";
import { fixture } from "./fixtures.mjs";

/** Every file of tests/s2/fixtures/lab/valid/ as { relative path: text }. */
export function labFiles() {
  const root = fixture("lab", "valid");
  const files = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else files[path.relative(root, child).split(path.sep).join("/")] = fs.readFileSync(child, "utf8");
    }
  }
  return files;
}

/** The text of a YAML mapping without one top-level key and the lines that belong to it. */
export function withoutTopLevelKey(text, key) {
  const lines = text.split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (new RegExp(`^${key}:`).test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^[ \t]/.test(line) || line === "")) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\n");
}

/** The text of a Markdown report without one `## ` section (its heading and what follows up to the next `## `). */
export function withoutSection(text, heading) {
  const lines = text.split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/^## /.test(line)) skipping = line === `## ${heading}`;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/** The same report with its `## ` sections in another order (the text before the first section stays first). */
export function withSectionOrder(text, order) {
  const parts = text.split(/^(?=## )/m);
  const preamble = /^## /.test(parts[0]) ? "" : parts.shift();
  const byHeading = new Map(parts.map((part) => [part.split("\n")[0].replace(/^## /, ""), part]));
  return preamble + order.map((heading) => byHeading.get(heading)).join("");
}
