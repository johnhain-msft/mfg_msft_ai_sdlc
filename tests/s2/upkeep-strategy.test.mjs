// AC14 and AC15: contract C5 request, strategy guidance and the custom strategy. The rendered prompt body selects its evaluation guidance by
// the project's upkeepStrategy; each guidance text lives in prompts/drift/strategy-<value>.md and is applied together with the project's
// registration instructions; with `custom` the agent follows only the registration instructions, and every instruction text is rendered
// unmodified. If no drift is found the agent records that outcome and does not open a pull request.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { abs, DRIFT_KEYS, driftWorkflow, fixture, parseWorkflow, readText, renderIn, tempDir } from "./helpers/fixtures.mjs";

const STRATEGIES = ["content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan"];
const FRAGMENT = (value) => readText(abs("prompts", "drift", `strategy-${value}.md`));
const GUIDANCE = {
  "content-and-docs-sync": /Compare the watched-source snapshots with the target's documentation, labs and presentation content/,
  "dependency-and-pattern-modernization": /Evaluate the package manifest snapshots for library and framework upgrades and pattern migrations \(for example 17 -> 18\) using the Context7 documentation server/,
  "code-quality-and-improvement-scan": /Scan the target's code for quality improvements and produce suggestions; a project may open them as draft pull requests/,
};
const MARKERS = {
  "content-and-docs-sync": ["INLINE-INSTRUCTIONS-DOCS-SYNC", "FILE-INSTRUCTIONS-DOCS-SYNC"],
  "dependency-and-pattern-modernization": ["INLINE-INSTRUCTIONS-MODERNIZATION", "FILE-INSTRUCTIONS-MODERNIZATION"],
  "code-quality-and-improvement-scan": ["INLINE-INSTRUCTIONS-QUALITY-SCAN", "FILE-INSTRUCTIONS-QUALITY-SCAN"],
};

async function bodyOf(directory) {
  const rendered = await renderIn(directory);
  const name = [...rendered.files.keys()].find((file) => /\/drift-[^/]+\.md$/.test(file));
  return parseWorkflow(rendered.files.get(name)).body;
}

test("AC14: the three strategy fragments exist under prompts/drift/ and hold the heading and the guidance of their strategy", () => {
  for (const value of STRATEGIES) {
    const file = abs("prompts", "drift", `strategy-${value}.md`);
    assert.ok(fs.existsSync(file), `${value}: prompts/drift/strategy-${value}.md exists`);
    const text = FRAGMENT(value);
    assert.ok(text.startsWith(`## Upkeep strategy: ${value}\n\n`), `${value}: the heading`);
    assert.match(text, GUIDANCE[value], `${value}: the guidance sentence`);
    assert.equal(text.split("## Upkeep strategy: ").length - 1, 1, "one strategy per fragment");
  }
});

for (const value of STRATEGIES) {
  test(`AC14: a project with upkeepStrategy ${value} gets that heading and guidance, the other strategies' headings are absent, and its instructions are applied`, async () => {
    const body = await bodyOf(fixture(`strategy-${value}`));
    assert.ok(body.includes(`## Upkeep strategy: ${value}\n`), "the heading of the selected value");
    for (const other of [...STRATEGIES.filter((candidate) => candidate !== value), "custom"]) assert.equal(body.includes(`## Upkeep strategy: ${other}`), false, `no heading for ${other}`);
    assert.equal(body.split("## Upkeep strategy: ").length - 1, 1, "exactly one strategy heading");
    assert.match(body, GUIDANCE[value], "the guidance sentence");
    assert.ok(body.includes(FRAGMENT(value).trim()), "the whole fragment, which is what prompts/drift/ holds for this value");
    const [inline, fromFile] = MARKERS[value];
    assert.ok(body.includes(inline), "the project's inline instructions");
    assert.ok(body.includes(fromFile), "and the text of its instructions file");
    assert.ok(body.indexOf(inline) < body.indexOf(fromFile) && body.indexOf(fromFile) < body.indexOf(`## Upkeep strategy: ${value}`), "the registration instructions come first, then the strategy guidance");
    for (const other of STRATEGIES.filter((candidate) => candidate !== value)) assert.equal(GUIDANCE[other].test(body), false, `${other}: its guidance is absent`);
  });
}

test("AC14: the instructions file is rendered unmodified apart from its trailing white space, whatever the strategy", async () => {
  for (const value of STRATEGIES) {
    const text = readText(fixture(`strategy-${value}`, "instructions", "fixture.md"));
    assert.ok((await bodyOf(fixture(`strategy-${value}`))).includes(text.replace(/\s+$/, "")), value);
  }
});

test("AC14: the guidance of each strategy that the preset uses is in the committed prompt, and the preset covers two of the three strategies", () => {
  const used = new Map(DRIFT_KEYS.map((key) => [key, /## Upkeep strategy: ([a-z-]+)/.exec(driftWorkflow(key).body)?.[1]]));
  assert.deepEqual([...used.values()].sort(), ["code-quality-and-improvement-scan", "content-and-docs-sync", "content-and-docs-sync"]);
  for (const [key, value] of used) assert.ok(driftWorkflow(key).body.includes(FRAGMENT(value).trim()), `${key}: the fragment of ${value} is in its prompt`);
});

test("AC14: when no drift is found the agent records that outcome and does not open a pull request, in every strategy and in the preset", async () => {
  const bodies = [...(await Promise.all(STRATEGIES.map((value) => bodyOf(fixture(`strategy-${value}`))))), await bodyOf(fixture("strategy-custom")), ...DRIFT_KEYS.map((key) => driftWorkflow(key).body)];
  for (const body of bodies) assert.match(body, /If you find no drift, record that outcome and do not open a pull request\./);
  for (const line of readText(abs("prompts", "drift", "remediation.md")).trim().split("\n")) assert.ok(bodies.every((body) => body.includes(line)), line);
  assert.ok(bodies.every((body) => body.includes(readText(abs("prompts", "drift", "corroboration.md")).trim())), "the corroboration sentence");
});

test("AC15: with upkeepStrategy custom the prompt holds the full text of the instructions file and none of the built-in strategy headings", async () => {
  const body = await bodyOf(fixture("strategy-custom"));
  const text = readText(fixture("strategy-custom", "instructions", "custom.md"));
  assert.ok(body.includes(text.replace(/\s+$/, "")), "the instructions file, byte for byte up to its final line break");
  assert.ok(body.includes("CUSTOM-INSTRUCTIONS-FILE-START") && body.includes("CUSTOM-INSTRUCTIONS-FILE-END"));
  for (const value of STRATEGIES) assert.equal(body.includes(`## Upkeep strategy: ${value}`), false, `no ## Upkeep strategy: ${value}`);
  assert.equal(body.includes("## Upkeep strategy: "), false, "no strategy heading at all");
  for (const value of STRATEGIES) assert.equal(GUIDANCE[value].test(body), false, `${value}: the built-in guidance is absent`);
  assert.ok(body.includes("/tmp/gh-aw/agent/sources/"), "the snapshots are still named");
  assert.match(body, /## Watched sources[\s\S]*https:\/\/changelog\.example\.test\/custom/);
});

test("AC15: inline instructions are rendered byte for byte, for custom and for the other strategies", async () => {
  const directory = tempDir("sdlc-s2-inline-");
  try {
    const inline = "Keep the labs current: check `docs/` (see \"rules\") and 'quotes';\nsecond line with *emphasis* and a trailing colon:";
    for (const value of [...STRATEGIES, "custom"]) {
      const manifest = YAML.parse(readText(fixture("strategy-custom", "sdlc.yaml")));
      manifest.projects[0].driftAudit.instructions = inline;
      manifest.projects[0].driftAudit.instructionsFile = null;
      manifest.projects[0].driftAudit.upkeepStrategy = value;
      fs.writeFileSync(path.join(directory, "sdlc.yaml"), YAML.stringify(manifest, { lineWidth: 0 }));
      const body = await bodyOf(directory);
      assert.ok(body.includes(inline), `${value}: the inline text, byte for byte`);
      assert.equal(body.includes("## Upkeep strategy: "), value !== "custom", `${value}: a strategy heading is rendered for a built-in strategy only`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC15: a project with neither instructions nor instructionsFile is rejected (AC6), so no prompt is rendered without instructions", async () => {
  const directory = tempDir("sdlc-s2-noinstr-");
  try {
    const manifest = YAML.parse(readText(fixture("strategy-custom", "sdlc.yaml")));
    manifest.projects[0].driftAudit.instructionsFile = null;
    manifest.projects[0].driftAudit.instructions = "";
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), YAML.stringify(manifest));
    await assert.rejects(renderIn(directory), /drift-instructions-missing/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
