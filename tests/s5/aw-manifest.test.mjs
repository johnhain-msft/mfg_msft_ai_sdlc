// AC1 and AC2: aw.yml is the gh-aw package manifest. It is validated against the schema that gh-aw publishes
// (tests/s5/fixtures/aw_manifest_schema.json, the F59 source) and its resources are checked against the destination
// rules that the gh-aw document lists (tests/s5/fixtures/aw-yml-package-manifest.md), which are read from the snapshot
// and not copied into this test.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { ghEnvironment } from "../../bin/lib/gh-runner.mjs";
import { FIXTURES, REPO_ROOT } from "./helpers/harness.mjs";

const schema = JSON.parse(fs.readFileSync(path.join(FIXTURES, "aw_manifest_schema.json"), "utf8"));
const doc = fs.readFileSync(path.join(FIXTURES, "aw-yml-package-manifest.md"), "utf8");
const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "aw.yml"), "utf8"));

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Workflow paths that a manifest lists: the `includes` entries (strings, or the `source` of a mapping) and the deprecated `files`. */
function listedPaths(data) {
  return [
    ...(data.includes ?? []).map((entry) => (typeof entry === "string" ? entry : entry.source)),
    ...(data.files ?? []),
  ];
}

/** Resource destination rules, read from the "Resources" section of the gh-aw document. */
function destinationRules(markdown) {
  const section = markdown.slice(markdown.indexOf("## Resources"));
  const supported = section.slice(section.indexOf("Supported destinations are:"), section.indexOf("Resource destinations must be unique"));
  const bullets = supported.split("\n").filter((line) => line.startsWith("- "));
  return bullets.map((bullet) => {
    const paths = [...bullet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const directory = paths.find((candidate) => candidate.endsWith("/"));
    const extensions = paths.filter((candidate) => /^\.[a-z]+$/.test(candidate));
    if (/^- Direct children of/.test(bullet)) {
      return (destination) => destination.startsWith(directory) && !destination.slice(directory.length).includes("/") && destination.length > directory.length && extensions.some((extension) => destination.endsWith(extension));
    }
    if (/^- Files under/.test(bullet)) return (destination) => destination.startsWith(directory) && destination.length > directory.length;
    if (/helper scripts under/.test(bullet)) return (destination) => destination.startsWith(directory) && !destination.slice(directory.length).includes("/") && extensions.some((extension) => destination.endsWith(extension));
    return (destination) => destination === paths[0];
  });
}

const rules = destinationRules(doc);
const permitted = (destination) => rules.some((rule) => rule(destination));

const S1_OWNED = (destination) =>
  ["sdlc.yaml", "schemas/sdlc.schema.json", ".github/workflows/aw.json"].includes(destination) ||
  destination.endsWith(".lock.yml") ||
  (/^\.github\/workflows\/[^/]+\.md$/.test(destination) && destination !== ".github/workflows/sdlc-onboard.md");

test("AC1: aw.yml exists at the repository root and validates against gh-aw's package-manifest schema", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "aw.yml")));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.trim().length > 0);
});

test("AC1: it carries a description (at most 255 characters, as gh aw add warns beyond that)", () => {
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim().length > 0);
  assert.ok(manifest.description.length <= 255);
});

test("AC1: it lists the onboarding workflow under the key the schema prefers, and every listed path exists", () => {
  assert.ok(Array.isArray(manifest.includes), "the workflows are listed under `includes`");
  assert.match(schema.properties.files.description, /^Deprecated/, "the schema deprecates `files` in favour of `includes`");
  assert.equal("files" in manifest, false);
  const listed = listedPaths(manifest);
  assert.ok(listed.includes(".github/workflows/sdlc-onboard.md"));
  for (const entry of listed) {
    // a string that starts with .github/ is resolved against the consuming repository root; the package root is the repository root here
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...entry.split("/"))), `${entry} exists`);
  }
});

test("AC1: it uses only keys that the schema defines, and min-version states the gh-aw prerequisite", () => {
  for (const key of Object.keys(manifest)) assert.ok(key in schema.properties, `${key} is a schema property`);
  assert.equal(manifest["min-version"], "v1.0.1");
  assert.match(manifest["min-version"], new RegExp(schema.properties["min-version"].pattern));
});

test("AC1: the package README.md that gh aw add requires sits next to aw.yml", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "README.md")));
});

test("AC1: the schema rejects what the document says is unsupported (a docs field, a missing name)", () => {
  assert.equal(validate({ description: "x" }), false);
  assert.equal(validate({ name: "x", docs: "README.md" }), false);
  assert.equal(validate({ name: "x", includes: [".github/workflows/sdlc-onboard.md"] }), true);
});

test("AC2: the destination rules are read from the snapshot of the gh-aw document", () => {
  assert.equal(rules.length, 4, "four destination bullets are listed in the Resources section");
  assert.equal(permitted(".github/aw/helper.json"), true);
  assert.equal(permitted(".github/CODEOWNERS"), true);
  assert.equal(permitted(".github/workflows/shared/util.mjs"), true);
  assert.equal(permitted(".github/workflows/shared/util.cjs"), true);
  assert.equal(permitted(".github/ISSUE_TEMPLATE/bug.yml"), true);
  assert.equal(permitted(".github/ISSUE_TEMPLATE/bug.yaml"), true, "OQ33: the .yaml extension is permitted too");
  assert.equal(permitted(".github/ISSUE_TEMPLATE/nested/bug.yml"), false);
  assert.equal(permitted(".github/workflows/shared/util.js"), false);
  assert.equal(permitted("sdlc.yaml"), false);
});

test("AC2: every resource that aw.yml declares has a permitted destination, and none targets an S1-owned path", () => {
  for (const resource of manifest.resources ?? []) {
    assert.ok(permitted(resource.destination), `${resource.destination} is a permitted destination`);
    assert.equal(S1_OWNED(resource.destination), false, `${resource.destination} is not owned by S1`);
  }
});

test("AC2: no included workflow is an S1-owned file other than the package's own onboarding workflow", () => {
  for (const entry of listedPaths(manifest)) {
    assert.equal(entry.endsWith(".lock.yml"), false, `${entry} is not a lock file`);
    assert.equal(S1_OWNED(entry), false, `${entry} is the package's own workflow, not an S1-owned rendering`);
  }
});

test("AC2: the S1-owned-path check catches every path that the spec names", () => {
  for (const owned of ["sdlc.yaml", "schemas/sdlc.schema.json", ".github/workflows/aw.json", ".github/workflows/drift-x.md", ".github/workflows/cascade-router.lock.yml"]) {
    assert.equal(S1_OWNED(owned), true, owned);
  }
  assert.equal(S1_OWNED(".github/workflows/sdlc-onboard.md"), false);
});

// The real compiler validates a repository-root aw.yml before it compiles (the gh-aw document: "gh aw compile validates repository-root
// manifests before compilation"). Opt-in, because it needs the gh-aw CLI: SDLC_REAL_GH_AW=1.
const realCompiler = { skip: process.env.SDLC_REAL_GH_AW === "1" ? false : "set SDLC_REAL_GH_AW=1 to run the real gh-aw compiler (it needs the gh-aw CLI, version 1.0.1 or newer)" };

function compileWith(manifestText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-awyml-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.cpSync(path.join(REPO_ROOT, ".github"), path.join(root, ".github"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "sdlc.yaml"), path.join(root, "sdlc.yaml"));
    fs.writeFileSync(path.join(root, "aw.yml"), manifestText);
    fs.copyFileSync(path.join(REPO_ROOT, "README.md"), path.join(root, "README.md"));
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: root, env: ghEnvironment(process.env), encoding: "utf8", shell: process.platform === "win32" });
    return { code: outcome.status, output: `${outcome.stdout}\n${outcome.stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("AC1 (OQ33): the real compiler accepts the committed aw.yml", realCompiler, () => {
  const outcome = compileWith(fs.readFileSync(path.join(REPO_ROOT, "aw.yml"), "utf8"));
  assert.equal(outcome.code, 0, outcome.output);
  assert.equal(/aw\.yml/i.test(outcome.output) && /error|invalid/i.test(outcome.output), false, outcome.output);
});

test("AC1 (OQ33): the real compiler does validate aw.yml: an invalid one (a docs field, a missing name) is rejected, so the pass above is not vacuous", realCompiler, () => {
  const outcome = compileWith("manifest-version: \"1\"\ndescription: no name here\ndocs: not-supported\n");
  assert.notEqual(outcome.code, 0, outcome.output);
  assert.match(outcome.output, /aw\.yml/i);
});
