// AC18: contract C5 request, build (gated by OQ34, OQ36, OQ37). Before it calls create_pull_request the agent runs every buildCommands entry
// in the target checkout (node presentation/build.mjs for the gh-admin repository) and commits the rebuilt outputs with its source
// changes; the bash tool allowlist permits the executables those commands and git need. This criterion asserts no handler error text and
// no engine comparison: a missing commit is caught by the clean-tree gate (verify-gate-admin.test.mjs).
//   OQ34 (which engines enforce a per-command allowlist): the rendered engine is `copilot`; the criterion asserts only the allowlist.
//   OQ37 (what create_pull_request does with uncommitted changes): nothing here depends on it; the gate detects the missing commit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { abs, driftPreset, driftWorkflow, minimalManifest, mutate, parseWorkflow, projectOf, readText, renderIn, tempDir, toYaml } from "./helpers/fixtures.mjs";

const body = () => driftWorkflow("gh-admin-msft").body;

test("AC18: the prompt of drift-gh-admin-msft orders node presentation/build.mjs, then the commit of its outputs, then the create_pull_request call", () => {
  const text = body();
  const build = text.indexOf("node presentation/build.mjs");
  const commit = text.indexOf("- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.");
  assert.ok(build > -1, "the build command is in the prompt");
  assert.ok(commit > build, "the commit instruction follows the build command");
  const call = text.indexOf("`create_pull_request`", commit);
  assert.ok(call > commit && call < commit + 140, "and ends in the call of create_pull_request");
  const fence = text.slice(text.indexOf("## Build commands"), text.indexOf("## Operating rules"));
  assert.match(fence, /Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:/);
  assert.match(fence, /```bash\nnode presentation\/build\.mjs\n```/);
});

test("AC18: the instruction text for the target says to rebuild and to commit the rebuilt outputs with the source edits", () => {
  const instructions = readText(abs("instructions", "gh-admin-msft.md"));
  assert.match(instructions, /Rebuild the deck and the presenter script with the build command of this workflow and commit the rebuilt outputs together with your source edits|Rebuild the deck and the presenter script with the build command from the build step of this workflow and commit the rebuilt outputs together with your source edits/);
  assert.match(instructions, /Do not edit the repository's tests, validation scripts or generated files that the build overwrites; change the sources and rebuild\./);
});

test("AC18: the rendered bash allowlist of every preset workflow permits node and git", () => {
  for (const key of ["gh-admin-msft", "copilot-lab", "self-improving-agents"]) {
    const { bash } = driftWorkflow(key).frontmatter.tools;
    assert.ok(bash.includes("node"), `${key}: node`);
    assert.ok(bash.includes("git"), `${key}: git`);
  }
});

test("AC18: node presentation/build.mjs is a buildCommand of the gh-admin-msft project in sdlc.yaml", () => {
  assert.ok(driftPreset("gh-admin-msft").driftAudit.buildCommands.includes("node presentation/build.mjs"));
  assert.ok(readText(abs("sdlc.yaml")).split("\n").some((line) => line.trim() === "- node presentation/build.mjs"), "as a line of the file, under buildCommands");
  assert.deepEqual(driftPreset("copilot-lab").driftAudit.buildCommands, []);
  assert.deepEqual(driftPreset("self-improving-agents").driftAudit.buildCommands, []);
  assert.match(driftWorkflow("copilot-lab").body, /This project has no build commands\./);
});

test("AC18: the allowlist holds the first word of every buildCommands entry, whatever the project, and git", async () => {
  const directory = tempDir("sdlc-s2-build-");
  try {
    const commands = ["npm run build:docs", "node scripts/rebuild.mjs --all", "make deck", "dotnet build -c Release", "  python3 tools/render.py"];
    const manifest = mutate(minimalManifest(), (copy) => {
      projectOf(copy, "alpha-service").driftAudit.buildCommands = commands;
    });
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), toYaml(manifest));
    const rendered = await renderIn(directory);
    const { frontmatter, body: prompt } = parseWorkflow(rendered.files.get(".github/workflows/drift-alpha-service.md"));
    for (const word of ["npm", "node", "make", "dotnet", "python3", "git"]) assert.ok(frontmatter.tools.bash.includes(word), `the allowlist permits ${word}`);
    for (const command of commands) assert.ok(prompt.includes(command.trim()), `the prompt lists ${command.trim()}`);
    const order = commands.map((command) => prompt.indexOf(command.trim()));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in declared order");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC18: the prompt tells the agent that the verification gate runs after it finishes and that it fixes the cause of a failure", () => {
  assert.match(body(), /The verification commands run after you finish; fix the cause of a failure rather than working around it\./);
});

test("AC18 (OQ34, OQ36, OQ37): this test file asserts no engine comparison, no handler error text and no remote-branch collision behaviour", () => {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const forbidden of ["No commits were found", "already exists and preserve-branch-name", "result: 'queued'", "Codex", "Agy"]) {
    assert.equal(source.split(forbidden).length - 1 <= 1, true, forbidden);
  }
});
