// AC50, the instance half: instructions/<projectKey>.md never holds a credential or the content of a secret file.
//
// The scanner that refuses a credential (assertNoCredentials) and the reader that refuses a file outside the working copy, a secret file and a file that is not text
// (readOperatorInstructions) are the engine's: they are the `--instructions` of the onboarding command, and the engine's own tests (tests/s5/instructions-secrets of the package)
// prove them against every provider that the scanner knows, with synthetic values. What only this repository can say is that the instructions that it commits are ordinary
// text to the scanner of the engine that it pins, so a bump of the engine that makes the scanner stricter is noticed here, by the file that it would refuse.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importEngine, INSTANCE_ROOT, presetManifest } from "../helpers/instance.mjs";

// a deep import: the scanner is no part of the engine's public API (docs/api.md lists the three entries), and this test is meant to notice when it moves
const { assertNoCredentials } = await importEngine("bin/lib/instructions-file.mjs");

test("AC50: the instructions that this repository commits are not refused", () => {
  const directory = path.join(INSTANCE_ROOT, "instructions");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files, ["copilot-lab.md", "gh-admin-msft.md", "self-improving-agents.md"]);
  for (const name of files) assert.doesNotThrow(() => assertNoCredentials(fs.readFileSync(path.join(directory, name), "utf8"), name), name);
});

test("AC50: every instructionsFile that the manifest names is one of those files, and no file of instructions/ is left that no project names", () => {
  const named = presetManifest().projects.map((project) => project.driftAudit.instructionsFile).filter((file) => file !== null && file !== undefined).sort();
  assert.deepEqual(named, ["instructions/copilot-lab.md", "instructions/gh-admin-msft.md", "instructions/self-improving-agents.md"]);
  const present = fs.readdirSync(path.join(INSTANCE_ROOT, "instructions")).map((name) => `instructions/${name}`).sort();
  assert.deepEqual(present, named);
});
