// AC36: repository-agnostic engine. No file under src/drift/, nor src/snapshot-watch-sources.mjs, nor src/validate-copilot-lab-audit.mjs, nor any
// schema that S2 adds, contains a literal repository slug: the target repository, the central repository (GITHUB_REPOSITORY), hostnames,
// commands, reviewers and close-older-key values come from sdlc.yaml or the environment. The fleet exists only as preset data in sdlc.yaml
// and in instructions/<projectKey>.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { abs, DRIFT_KEYS, driftPreset, listTree, readText } from "./helpers/fixtures.mjs";

const FORBIDDEN = ["johnhain-msft/", "ms-mfg-community/", "githubschool/"];

const sourceFiles = () => [
  ...listTree(abs("src", "drift")).map((file) => abs("src", "drift", file)),
  abs("src", "snapshot-watch-sources.mjs"),
  abs("src", "validate-copilot-lab-audit.mjs"),
  abs("schemas", "drift-compile-ack.schema.json"),
  abs("schemas", "github-pull-request-response.schema.json"),
];

test("AC36: no file of S2's engine or of its schemas contains johnhain-msft/, ms-mfg-community/ or githubschool/", () => {
  const files = sourceFiles();
  assert.ok(files.length >= 18, `scanned ${files.length} files`);
  for (const file of files) {
    const text = readText(file);
    for (const slug of FORBIDDEN) assert.equal(text.includes(slug), false, `${path.relative(abs("."), file)} contains '${slug}'`);
  }
});

test("AC36: the scan covers the whole of src/drift/, including its lib/ directory", () => {
  const scanned = sourceFiles().map((file) => path.relative(abs("src"), file).split(path.sep).join("/"));
  for (const expected of ["drift/prepare-run.mjs", "drift/dedupe-open-prs.mjs", "drift/escalate-gate-failure.mjs", "drift/check-pr-response.mjs", "drift/lib/github-client.mjs", "drift/lib/app-token.mjs", "snapshot-watch-sources.mjs", "validate-copilot-lab-audit.mjs"]) {
    assert.ok(scanned.includes(expected), `${expected} is scanned`);
  }
  const onDisk = fs.readdirSync(abs("src", "drift"), { recursive: true }).filter((entry) => entry.endsWith(".mjs")).map((entry) => `drift/${entry.split(path.sep).join("/")}`);
  for (const file of onDisk) assert.ok(scanned.includes(file), `${file} is scanned`);
});

test("AC36: no S2 source carries a string literal that looks like an owner/repository slug (comments aside)", () => {
  // A slug in code would be `"<owner>/<repository>"` handed to an API path or a comparison; the scripts only build such paths from input.
  const slug = /["'`](?:[a-z0-9][a-z0-9-]{0,38})\/(?:[a-z0-9_.-]{1,100})["'`]/gi;
  const allowed = /^["'`](?:\.\.?\/|node:|\/tmp\/|text\/|application\/|image\/|\/repos|\/app|\/pulls|\/issues|\.github\/)/i;
  for (const file of sourceFiles().filter((candidate) => candidate.endsWith(".mjs"))) {
    for (const [index, line] of readText(file).split("\n").entries()) {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      for (const match of line.matchAll(slug)) {
        const text = match[0];
        if (allowed.test(text) || /\.(m?js|json|md|ya?ml|txt|csproj|toml|mod)["'`]$/.test(text) || /[*{}$]/.test(text)) continue;
        if (/^["'`](?:docs|src|schemas|prompts|tests|instructions|sources|node|bin|lib|gh-aw|github|actions|workflows|manifests|projects|sdlc|automation|weekly-audit|self-improve)\//.test(text)) continue;
        assert.fail(`${path.relative(abs("."), file)}:${index + 1} holds a string that looks like a repository slug: ${text}`);
      }
    }
  }
});

test("AC36: the fleet exists as preset data: the slugs are in sdlc.yaml, and each instruction file belongs to a registered project", () => {
  const manifest = fs.readFileSync(abs("sdlc.yaml"), "utf8");
  for (const slug of ["johnhain-msft/gh-admin-msft", "ms-mfg-community/day-in-the-life-copilot-lab"]) assert.ok(manifest.includes(slug), `${slug} is in sdlc.yaml`);
  for (const key of DRIFT_KEYS) {
    const { instructionsFile } = driftPreset(key).driftAudit;
    assert.equal(instructionsFile, `instructions/${key}.md`);
    assert.ok(fs.existsSync(abs(instructionsFile)));
  }
});

test("AC36: the central repository is read from GITHUB_REPOSITORY and the target from the configured repository, not from the code", () => {
  const escalation = readText(abs("src", "drift", "escalate-gate-failure.mjs"));
  assert.match(escalation, /GITHUB_REPOSITORY/);
  const prepare = readText(abs("src", "drift", "prepare-run.mjs"));
  assert.match(prepare, /CONFIGURED_TARGET_REPO/);
  const dedupe = readText(abs("src", "drift", "dedupe-open-prs.mjs"));
  assert.match(dedupe, /CONFIGURED_TARGET_REPO/);
});
