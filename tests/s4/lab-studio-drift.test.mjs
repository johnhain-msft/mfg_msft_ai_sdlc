// AC31-AC34: src/lab-studio-drift.mjs recomputes the lab hashes of the studio manifest from an upstream checkout, reports the difference, and with
// --accept records it in place. The hashes are those of the studio's own checker (fixtures/lab-sources/expected-hashes.json was produced by it).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { labDigest } from "../../src/lab-studio-drift.mjs";
import { HELPERS, REPO_ROOT, abs, commitAll, fixture, git, jsonOf, labUpstream, readJson, readText, runNode, studioCheckout, tempDir, writeFiles } from "./helpers/fixtures.mjs";

const OLD = "d362e1c8752b398307ae84341ccc82fec63b595f";
const NEW = "b".repeat(40);
const MANIFEST = "apps/lab-studio/lab-sources.json";
const LABS = Array.from({ length: 20 }, (_, index) => `lab${String(index + 1).padStart(2, "0")}`);

function drift(portfolio, upstream, extra = [], options = {}) {
  return runNode(HELPERS.drift, ["--portfolio", portfolio, "--upstream", upstream, "--commit", NEW, ...extra], options);
}

const noStatus = (result) => assert.equal(result.stdout.includes('"status"'), false, `standard output carries no status on a fatal error: ${result.stdout}`);

test("AC31: an upstream tree whose hashes all match is in-sync (exit 0), even though the recorded commit is not --commit, and nothing is written", () => {
  const { dir } = studioCheckout();
  const result = drift(dir, labUpstream());
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(jsonOf(result.stdout), { status: "in-sync", previousCommit: OLD, targetCommit: NEW, changedLabs: [] });
  assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one JSON object");
  assert.equal(git(dir, ["status", "--porcelain"]).stdout, "");
});

test("AC31: one changed lab is drift (exit 1) and is named in changedLabs; without --accept nothing is written", () => {
  const { dir } = studioCheckout();
  const upstream = labUpstream();
  fs.appendFileSync(path.join(upstream, "labs", "lab05.md"), "A new line.\n");
  const result = drift(dir, upstream);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(jsonOf(result.stdout), { status: "drift", previousCommit: OLD, targetCommit: NEW, changedLabs: ["lab05"] });
  assert.equal(git(dir, ["diff", "--exit-code"], { allowFailure: true }).status, 0, "the checkout is untouched");
});

test("AC31/AC33: --accept exits 0 with status accepted, rewrites only the commit and the changed hash, and a second run changes nothing", () => {
  const { dir } = studioCheckout();
  const upstream = labUpstream();
  fs.appendFileSync(path.join(upstream, "labs", "lab05.md"), "A new line.\n");
  const first = drift(dir, upstream, ["--accept"]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(jsonOf(first.stdout), { status: "accepted", previousCommit: OLD, targetCommit: NEW, changedLabs: ["lab05"] });
  assert.equal(git(dir, ["diff", "--name-only"]).stdout.trim(), MANIFEST, "git diff lists only the manifest");
  assert.equal(git(dir, ["diff", "--numstat"]).stdout.trim().split("\t").slice(0, 2).join(" "), "2 2", "and only two lines of it: the commit and the changed hash");
  const recorded = readJson(path.join(dir, ...MANIFEST.split("/")));
  assert.equal(recorded._provenance.commit, NEW);
  assert.equal(recorded._provenance.repository, "ms-mfg-community/day-in-the-life-copilot-lab", "the repository and the hashing label stay");
  assert.deepEqual(Object.keys(recorded), ["_provenance", ...LABS], "the key order stays");
  assert.deepEqual(Object.keys(recorded.lab05), ["source", "sourceHash", "studio", "studioExists"], "and so does the field order");
  commitAll(dir, "accepted");
  const second = drift(dir, upstream, ["--accept"]);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(jsonOf(second.stdout), { status: "accepted", previousCommit: NEW, targetCommit: NEW, changedLabs: [] });
  assert.equal(git(dir, ["diff", "--exit-code"], { allowFailure: true }).status, 0, "a second identical invocation leaves the file byte-identical");
  assert.equal(drift(dir, upstream).code, 0, "and the checkout is now in sync");
});

test("AC33: --accept keeps the indentation and the line ends of the file it rewrites", () => {
  const { dir } = studioCheckout();
  const file = path.join(dir, ...MANIFEST.split("/"));
  const crlf = JSON.stringify(readJson(file), null, 4).replace(/\n/g, "\r\n");
  fs.writeFileSync(file, crlf);
  commitAll(dir, "crlf and four spaces");
  const upstream = labUpstream();
  fs.appendFileSync(path.join(upstream, "labs", "lab12.md"), "More.\n");
  const result = drift(dir, upstream, ["--accept"]);
  assert.equal(result.code, 0, result.stderr);
  const after = readText(file);
  assert.ok(after.includes("\r\n") && !/[^\r]\n/.test(after), "still CRLF throughout");
  assert.ok(/^ {4}"lab01"/m.test(after), "still four spaces");
  assert.equal(readJson(file)._provenance.commit, NEW);
  const changed = [...after.matchAll(/"sourceHash": "([0-9a-f]{16})"/g)].map((match) => match[1]);
  const before = [...crlf.matchAll(/"sourceHash": "([0-9a-f]{16})"/g)].map((match) => match[1]);
  assert.equal(changed.filter((hash, index) => hash !== before[index]).length, 1, "one hash moved");
});

test("AC31: a missing --commit, a malformed one, a missing --upstream, an unknown option and a directory that does not exist all exit 2 with no status", () => {
  const { dir } = studioCheckout();
  const upstream = labUpstream();
  const cases = [
    ["missing --commit", ["--portfolio", dir, "--upstream", upstream]],
    ["39 characters", ["--portfolio", dir, "--upstream", upstream, "--commit", "a".repeat(39)]],
    ["uppercase", ["--portfolio", dir, "--upstream", upstream, "--commit", "A".repeat(40)]],
    ["short", ["--portfolio", dir, "--upstream", upstream, "--commit", "2108ac9"]],
    ["missing --upstream", ["--portfolio", dir, "--commit", NEW]],
    ["unknown option", ["--portfolio", dir, "--upstream", upstream, "--commit", NEW, "--force"]],
    ["no such upstream", ["--portfolio", dir, "--upstream", path.join(upstream, "nope"), "--commit", NEW]],
    ["nothing at all", []],
  ];
  for (const [label, args] of cases) {
    const result = runNode(HELPERS.drift, args);
    assert.equal(result.code, 2, `${label}: ${result.stdout}${result.stderr}`);
    noStatus(result);
    assert.ok(result.stderr.trim().split("\n").length >= 1 && result.stderr.includes("lab-studio-drift:"), `${label}: a diagnostic on standard error`);
  }
  assert.equal(git(dir, ["status", "--porcelain"]).stdout, "");
});

test("AC32: the digest is the first 16 hex characters of the SHA-256 of the LF-normalised bytes: CRLF and LF copies agree and the golden values are the studio checker's own", () => {
  const upstream = fixture("lab-sources", "upstream");
  const golden = readJson(fixture("lab-sources", "expected-hashes.json"));
  assert.deepEqual(Object.keys(golden), LABS);
  for (const key of LABS) assert.equal(labDigest(fs.readFileSync(path.join(upstream, "labs", `${key}.md`))), golden[key], key);
  const lf = fs.readFileSync(path.join(upstream, "labs", "lab05.md"));
  const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
  assert.notDeepEqual(crlf, lf);
  assert.equal(labDigest(crlf), labDigest(lf));
  assert.equal(labDigest(lf), golden.lab05);
  // a byte that is not UTF-8 is hashed as itself: the latin1 string is never re-encoded as UTF-8
  const raw = Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0xfe, 0x80, 0x0a]);
  assert.equal(labDigest(raw), crypto.createHash("sha256").update(Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x80, 0x0a])).digest("hex").slice(0, 16));
  assert.notEqual(labDigest(raw), crypto.createHash("sha256").update(Buffer.from(raw.toString("latin1").replace(/\r\n/g, "\n"), "utf8")).digest("hex").slice(0, 16));
});

test("AC32: through the command, a CRLF upstream tree is as in-sync as the LF tree", () => {
  const { dir } = studioCheckout();
  const upstream = labUpstream();
  for (const key of LABS) {
    const file = path.join(upstream, "labs", `${key}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  }
  const result = drift(dir, upstream);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonOf(result.stdout).status, "in-sync");
});

for (const variant of ["bad-unparsable", "bad-missing-lab", "bad-extra-key", "bad-hash-format", "bad-entry-fields", "bad-absent-source"]) {
  test(`AC34: the manifest of ${variant} fails closed: exit 2, no status, and git diff --exit-code stays clean (also with --accept)`, () => {
    const { dir } = studioCheckout(variant);
    for (const extra of [[], ["--accept"]]) {
      const result = drift(dir, labUpstream(), extra);
      assert.equal(result.code, 2, `${extra.join(" ")}: ${result.stdout}${result.stderr}`);
      noStatus(result);
      assert.equal(git(dir, ["diff", "--exit-code"], { allowFailure: true }).status, 0);
    }
  });
}

test("AC34: a missing manifest, a source path that leaves the upstream checkout and a source that is a directory are fatal too", () => {
  const upstream = labUpstream();
  const none = repoFromEmpty();
  assert.equal(drift(none, upstream).code, 2);
  const { dir } = studioCheckout();
  const file = path.join(dir, ...MANIFEST.split("/"));
  const outside = readJson(file);
  outside.lab04.source = "../outside.md";
  fs.writeFileSync(file, `${JSON.stringify(outside, null, 2)}\n`);
  fs.writeFileSync(path.join(path.dirname(upstream), "outside.md"), "x\n");
  const escaped = drift(dir, upstream);
  assert.equal(escaped.code, 2, escaped.stderr);
  noStatus(escaped);
  const directory = readJson(file);
  directory.lab04.source = "labs";
  fs.writeFileSync(file, `${JSON.stringify(directory, null, 2)}\n`);
  assert.equal(drift(dir, upstream).code, 2);
});

function repoFromEmpty() {
  const dir = path.join(tempDir("sdlc-s4-empty-"), "checkout");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("AC1/AC31: the manifest that applies is found through GITHUB_WORKSPACE when the current directory has none, and never inside --portfolio", () => {
  const { dir } = studioCheckout();
  const upstream = labUpstream();
  const elsewhere = tempDir("sdlc-s4-cwd-");
  const viaWorkspace = drift(dir, upstream, [], { cwd: elsewhere, env: { GITHUB_WORKSPACE: REPO_ROOT } });
  assert.equal(viaWorkspace.code, 0, viaWorkspace.stderr);
  const nowhere = drift(dir, upstream, [], { cwd: elsewhere });
  assert.equal(nowhere.code, 2, "no sdlc.yaml anywhere is fatal");
  noStatus(nowhere);
  // a manifest that sits in the downstream checkout (the agent could have written it) is not read, even when it is the current directory
  writeFiles(dir, { "sdlc.yaml": readText(abs("sdlc.yaml")).replace("manifest: apps/lab-studio/lab-sources.json", "manifest: apps/lab-studio/other.json") });
  const shadowed = drift(dir, upstream, [], { cwd: dir, env: { GITHUB_WORKSPACE: REPO_ROOT } });
  assert.equal(shadowed.code, 0, `the workspace manifest applies, not the downstream one: ${shadowed.stderr}`);
});

test("AC1: the helper completes against a fleet whose paths differ from the portfolio's (the synthetic fleet names its own manifest)", () => {
  const fleet = fixture("synthetic-fleet");
  const checkout = tempDir("sdlc-s4-synthetic-");
  const portfolio = path.join(checkout, "w");
  fs.cpSync(path.join(fleet, "portfolio"), portfolio, { recursive: true });
  const upstream = path.join(fleet, "upstream");
  const synced = runNode(HELPERS.drift, ["--portfolio", portfolio, "--upstream", upstream, "--commit", NEW], { cwd: fleet });
  assert.equal(synced.code, 0, `the digests of the synthetic manifest are those of its lessons: ${synced.stderr}`);
  assert.deepEqual(jsonOf(synced.stdout), { status: "in-sync", previousCommit: "a".repeat(40), targetCommit: NEW, changedLabs: [] });
  // one lesson of the fleet changes upstream: only that lab is named, under the name that the fleet's own manifest gives it
  const changed = path.join(checkout, "upstream");
  fs.cpSync(upstream, changed, { recursive: true });
  fs.appendFileSync(path.join(changed, "labs", "lab07.md"), "One more line.\n");
  const drifted = runNode(HELPERS.drift, ["--portfolio", portfolio, "--upstream", changed, "--commit", NEW], { cwd: fleet });
  assert.equal(drifted.code, 1, drifted.stderr);
  assert.deepEqual(jsonOf(drifted.stdout), { status: "drift", previousCommit: "a".repeat(40), targetCommit: NEW, changedLabs: ["lab07"] });
});
