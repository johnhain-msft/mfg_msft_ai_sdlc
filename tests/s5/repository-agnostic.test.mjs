// AC5: engine code is repository-agnostic. No file under bin/, neither aw.yml nor .github/workflows/sdlc-onboard.md,
// contains a preset owner or workflow ID; preset names live only in sdlc.yaml and tests/s5/fixtures/. The same scan
// covers the `auto-merge: true` check of AC35.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "./helpers/harness.mjs";

const FORBIDDEN = ["johnhain-msft", "ms-mfg-community", "githubschool", "weekly-content-audit", "self-improving-agents", "generate-prd", "code-review"];

function filesUnder(relative) {
  const absolute = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => filesUnder(`${relative}/${entry.name}`));
}

const SCANNED = [...filesUnder("bin"), "aw.yml", ".github/workflows/sdlc-onboard.md"];

test("AC5: the scan covers every bin file, aw.yml and the onboarding workflow", () => {
  assert.ok(SCANNED.length >= 20, `${SCANNED.length} files are scanned`);
  assert.ok(SCANNED.includes("bin/sdlc-bootstrap.mjs"));
  assert.ok(SCANNED.includes("bin/lib/app-permissions.json"));
  assert.ok(SCANNED.includes("aw.yml"));
});

test("AC5: no scanned file contains a preset repository owner or workflow ID", () => {
  const hits = [];
  for (const file of SCANNED) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const word of FORBIDDEN) if (text.includes(word)) hits.push(`${file}: ${word}`);
  }
  assert.deepEqual(hits, []);
});

test("AC35: no scanned file enables auto-merge", () => {
  const hits = SCANNED.filter((file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8").includes("auto-merge: true"));
  assert.deepEqual(hits, []);
});

test("AC5: the preset names do live in sdlc.yaml, so the scan is not vacuous", () => {
  const preset = fs.readFileSync(path.join(REPO_ROOT, "sdlc.yaml"), "utf8");
  assert.ok(FORBIDDEN.some((word) => preset.includes(word)));
});

test("AC5: the central repository, the App owner and the deconfliction targets are read from run-time inputs", () => {
  const sources = SCANNED.filter((file) => file.endsWith(".mjs")).map((file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8")).join("\n");
  assert.match(sources, /remote", "get-url", "origin"/, "the central repository comes from the origin remote");
  assert.match(sources, /deconflictInRepoSchedules/, "the deconfliction targets come from the manifest");
  assert.match(sources, /options\.owner \?\? central\.owner/, "the App owner comes from --owner or the central repository");
});
