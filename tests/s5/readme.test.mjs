// AC3: the package README.md shows consumers how to install, states the gh-aw prerequisite and its reason, gives the
// quick start and says how a blocked sync state is reset.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "./helpers/harness.mjs";

const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

for (const required of [
  "gh aw add owner/repo",
  "gh aw add owner/repo/path/to/package",
  "gh-aw >= v1.0.1",
  "GHSA-8h78-hpm7-29gg",
  "node bin/sdlc-bootstrap.mjs",
  "node bin/sdlc-onboard.mjs --repo",
  "reset_blocked: true",
]) {
  test(`AC3: README.md contains ${JSON.stringify(required)}`, () => {
    assert.ok(readme.includes(required));
  });
}

test("AC3: the install commands are shown as commands, both forms", () => {
  assert.match(readme, /^gh aw add owner\/repo$/m);
  assert.match(readme, /^gh aw add owner\/repo\/path\/to\/package$/m);
});

test("AC3: the quick start gives the bootstrap first and the onboarding second", () => {
  assert.ok(readme.indexOf("node bin/sdlc-bootstrap.mjs") < readme.indexOf("node bin/sdlc-onboard.mjs --repo <owner/repo-or-path>"));
  assert.match(readme, /## Quick start[\s\S]*node bin\/sdlc-bootstrap\.mjs[\s\S]*node bin\/sdlc-onboard\.mjs --repo <owner\/repo-or-path>/);
});

test("AC3: a blocked sync state is reset only through cascade-router.yml, never by editing the variable", () => {
  assert.match(readme, /reset_blocked: true[\s\S]{0,120}never[\s\S]{0,60}SDLC_SYNC_STATE_<SLUG>/);
  assert.ok(readme.includes("cascade-router.yml"));
});

test("AC3: the prerequisite states its reason and the remediation of the advisory", () => {
  assert.match(readme, /gh aw upgrade/);
  assert.match(readme, /\.lock\.yml/);
});
