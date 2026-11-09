import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("AI SDLC presentation deck builds cleanly in strict check mode and has up-to-date outputs", () => {
  const buildScript = path.join(ROOT, "presentation", "build.mjs");
  const out = execFileSync(process.execPath, [buildScript, "--check", "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /12 slides · 12 script sections/);
  assert.match(out, /strict/);

  const distHtml = path.join(ROOT, "presentation", "dist", "index.html");
  const presenterMd = path.join(ROOT, "presenter", "PRESENTER-SCRIPT.md");
  assert.equal(fs.existsSync(distHtml), true, "presentation/dist/index.html exists");
  assert.equal(fs.existsSync(presenterMd), true, "presenter/PRESENTER-SCRIPT.md exists");

  const html = fs.readFileSync(distHtml, "utf8");
  const dataMatch = html.match(/<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, "deck-data JSON script block is present");
  assert.equal(/<\/script|<!--/.test(dataMatch[1]), false, "no unsafe sequences inside deck-data JSON");
  const parsed = JSON.parse(dataMatch[1]);
  assert.equal(parsed.slides.length, 12);
  assert.ok(html.includes('<div class="topbar-left">'), "topbar-left hook present for portfolio importer");
  assert.ok(html.includes('<div class="sp-title">'), "sp-title hook present for portfolio importer");
});
