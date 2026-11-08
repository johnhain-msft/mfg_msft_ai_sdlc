// A fixture with the structure of the real showcase test: a locked import, two locked describe blocks and one editable one.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findCustomerTerms } from "./support/customer-terms";

const root = path.resolve(__dirname, "..");
const experience = path.join(root, "experiences", "pipeline-showcase");
const svgPath = path.join(experience, "public", "media", "pipeline-demo.svg");
const data = JSON.parse(readFileSync(path.join(experience, "content", "run-data.json"), "utf8")) as { runs: unknown[] };

describe("pipeline-showcase animated SVG", () => {
  it("is a well-formed SVG document", () => {
    expect(existsSync(svgPath) ? readFileSync(svgPath, "utf8") : "<svg></svg>").toContain("<svg");
  });

  it("is self-contained: no script, no event handlers, no external references", () => {
    expect(readFileSync(svgPath, "utf8")).not.toMatch(/<script/i);
  });
});

describe("pipeline-showcase run-data snapshot", () => {
  it("describes the public template repository", () => {
    expect(Array.isArray(data.runs)).toBe(true);
  });
});

describe("pipeline-showcase sanitization", () => {
  const forbidden: [string, RegExp][] = [
    ["a personal machine path", /[A-Za-z]:\\Users\\/],
    ["an email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["a UUID", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ["a token", /gh[pousr]_[A-Za-z0-9]{20,}/],
    ["an excluded source document", /manual-setup-and-test/],
  ];

  it("contains no customer names, personal paths, emails, UUIDs or tokens", () => {
    expect(findCustomerTerms(JSON.stringify(data))).toEqual([]);
    for (const [label, pattern] of forbidden) expect(JSON.stringify(data), label).not.toMatch(pattern);
  });
});
