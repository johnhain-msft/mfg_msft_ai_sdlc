// AC14 and AC15: contract C5 request, strategy guidance and the custom strategy. The rendered prompt body selects its evaluation guidance by
// the project's upkeepStrategy; each guidance text lives in prompts/drift/strategy-<value>.md and is applied together with the project's
// registration instructions; with `custom` the agent follows only the registration instructions, and every instruction text is rendered
// unmodified. If no drift is found the agent records that outcome and does not open a pull request.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { abs, copyFixture, DRIFT_KEYS, driftWorkflow, fixture, parseWorkflow, readText, renderIn, tempDir } from "./helpers/fixtures.mjs";

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

test("AC14: prompts/drift/strategy-<value>.md is the source of the guidance: the renderer reads it from the repository that it renders, and uses its built-in copy only where the file is absent", async () => {
  for (const value of STRATEGIES) {
    const directory = copyFixture(`strategy-${value}`);
    try {
      assert.equal(fs.existsSync(path.join(directory, "prompts")), false, "the fixture workspace carries no prompts/drift/");
      const builtIn = await bodyOf(directory);
      assert.ok(builtIn.includes(FRAGMENT(value).trim()), `${value}: without the file the built-in text is what the committed fragment says, to the letter`);
      const edited = `## Upkeep strategy: ${value}\n\nEDITED-GUIDANCE-OF-${value.toUpperCase()}: this sentence is in the file and in no source of the renderer.\n`;
      fs.mkdirSync(path.join(directory, "prompts", "drift"), { recursive: true });
      fs.writeFileSync(path.join(directory, "prompts", "drift", `strategy-${value}.md`), edited);
      const body = await bodyOf(directory);
      assert.ok(body.includes(edited.trim()), `${value}: the text of the file is what the prompt carries`);
      assert.equal(GUIDANCE[value].test(body), false, `${value}: the built-in guidance is not mixed in when the file exists`);
      assert.equal(body.split("## Upkeep strategy: ").length - 1, 1, `${value}: still exactly one strategy heading`);
      assert.ok(body.indexOf(MARKERS[value][1]) < body.indexOf(edited.trim()), "the registration instructions still come first");
      fs.writeFileSync(path.join(directory, "prompts", "drift", `strategy-${value}.md`), `${edited.trimEnd()}\r\n\r\n\r\n`);
      assert.ok((await bodyOf(directory)).includes(edited.trim()), `${value}: the line endings and the trailing blank lines of the file do not reach the prompt`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("AC14: a fragment that is in the repository but unusable is refused with the rule drift-strategy-fragment and is not replaced by the built-in text", async () => {
  const value = "content-and-docs-sync";
  const cases = [
    ["no heading", "Guidance without its heading.\n", /must begin with the heading '## Upkeep strategy: content-and-docs-sync'/],
    ["the heading of another strategy", "## Upkeep strategy: code-quality-and-improvement-scan\n\nGuidance.\n", /must begin with the heading/],
    ["an empty file", "", /must begin with the heading/],
    ["an expression opener", `## Upkeep strategy: ${value}\n\nUse \${{ secrets.TOKEN }} here.\n`, /expression opener/],
  ];
  for (const [name, text, message] of cases) {
    const directory = copyFixture(`strategy-${value}`);
    try {
      fs.mkdirSync(path.join(directory, "prompts", "drift"), { recursive: true });
      fs.writeFileSync(path.join(directory, "prompts", "drift", `strategy-${value}.md`), text);
      await assert.rejects(renderIn(directory), (error) => /drift-strategy-fragment/.test(error.message) && message.test(error.message) && /prompts\/drift\/strategy-content-and-docs-sync\.md/.test(error.message), name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  const directory = copyFixture(`strategy-${value}`);
  try {
    fs.mkdirSync(path.join(directory, "prompts", "drift", `strategy-${value}.md`), { recursive: true });
    await assert.rejects(renderIn(directory), /drift-strategy-fragment.*is not a file/, "a directory where the file should be");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC14: only a project that uses a built-in strategy needs its fragment, and a disabled project needs none", async () => {
  const directory = copyFixture("strategy-custom");
  try {
    fs.mkdirSync(path.join(directory, "prompts", "drift"), { recursive: true });
    for (const value of STRATEGIES) fs.writeFileSync(path.join(directory, "prompts", "drift", `strategy-${value}.md`), "a file that would be refused if it were read\n");
    assert.ok((await bodyOf(directory)).includes("CUSTOM-INSTRUCTIONS-FILE-START"), "a custom project reads no strategy fragment");
    const manifest = YAML.parse(readText(path.join(directory, "sdlc.yaml")));
    manifest.projects[0].driftAudit.upkeepStrategy = "content-and-docs-sync";
    manifest.projects[0].driftAudit.enabled = false;
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), YAML.stringify(manifest));
    const rendered = await renderIn(directory);
    assert.equal([...rendered.files.keys()].some((file) => /\/drift-[^/]+\.md$/.test(file)), false, "and a disabled project renders no workflow, so its fragment is not read either");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
