// The boundary with SPEC-04's three helper CLIs (SPEC-03 AC41, AC42, AC43, AC44, AC45, AC52): S3 consumes lab-studio-drift.mjs through the edge's own preflight command and
// nothing else; it never invokes bump-studio-revision-pins.mjs or verify-immutable-gates.mjs, and no file that S3 owns defines any of the three. S3 asserts only this
// boundary; the helpers themselves are verified by tests/s4.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, edge, fixture, presetEdges as presetEdgesOf, REPO_ROOT, sha, state } from "./helpers/fixtures.mjs";
import { CHANGED_REPORT, IN_SYNC, preflightEdge } from "./helpers/preflight-world.mjs";

const BUMP = "bump-studio-revision-pins";
const VERIFY = "verify-immutable-gates";
const STUDIO = "lab-studio-drift";

const scriptFiles = () => [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
const workflowFiles = () => [abs(".github", "workflows", "cascade-router.yml"), abs(".github", "workflows", "cascade-mechanical-ghec-admin.md"), abs(".github", "workflows", "cascade-mechanical-ghec-admin.lock.yml")];
const rel = (file) => path.relative(REPO_ROOT, file).replace(/\\/g, "/");
const code = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

test("AC41 AC42 rg for the two helpers that S3 never invokes finds nothing in the scripts, the modules they use, the router or the mechanical workflow", () => {
  for (const file of [...scriptFiles(), ...workflowFiles()]) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(BUMP), false, `${rel(file)} names ${BUMP}`);
    assert.equal(text.includes(VERIFY), false, `${rel(file)} names ${VERIFY}`);
  }
});

test("AC52 no file that S3 owns defines any of the three helpers: none has their name, parses their options, or exports them", () => {
  const owned = [...scriptFiles(), ...fs.readdirSync(abs("tests", "s3")).filter((name) => name.endsWith(".test.mjs")).map((name) => abs("tests", "s3", name))];
  for (const file of owned) assert.equal(new RegExp(`${BUMP}|${VERIFY}|${STUDIO}`).test(path.basename(file)), false, rel(file));
  // the options of the three CLIs are parsed by SPEC-04's files, never by a script of S3
  for (const file of scriptFiles()) {
    const text = code(file);
    for (const option of ["--new-sha", "--accept", "--portfolio", "--frozen-intrinsics"]) assert.equal(text.includes(option), false, `${rel(file)} handles ${option}`);
  }
  // the one stand-in that exists is a fixture of the tests, named as such, and says what it is
  const stub = abs("tests", "s3", "fixtures", "helpers", "lab-studio-drift.stub.mjs");
  assert.ok(fs.existsSync(stub));
  assert.match(fs.readFileSync(stub, "utf8"), /hermetic stand-in/);
  assert.match(fs.readFileSync(stub, "utf8"), /never substitutes this file for a missing one/);
});

test("AC52 the only place where S3's source mentions the studio helper is the classifier of the edge's preflight command, and nothing there runs it by name", () => {
  const mentioning = scriptFiles().filter((file) => code(file).includes(STUDIO)).map(rel);
  assert.deepEqual(mentioning, ["src/routing/preflight.mjs"]);
  const lines = code(abs("src", "routing", "preflight.mjs")).split("\n").filter((line) => line.includes(STUDIO));
  for (const line of lines) assert.match(line, /\/\\b?lab-studio-drift|test\(|kind|studio/, line);
  assert.equal(/["'`]node\s/.test(code(abs("src", "routing", "preflight.mjs"))), false, "no command line is composed in the source");
});

test("AC41 AC42 the router runs the edge's own commands and no other: for an edge without a preflight no command is run, and for every edge what is run is the edge's text", async (t) => {
  const quiet = routerWorld();
  t.after(() => quiet.cleanup());
  const none = fakePreflight([]);
  await quiet.go({ preflightDeps: none.deps });
  assert.deepEqual(none.calls, [], "an edge that declares no preflight runs nothing");

  const lab = preflightEdge();
  const w = routerWorld({ edge: lab, state: state({}, lab), upstream: { head: sha("h2") } });
  t.after(() => w.cleanup());
  const fake = fakePreflight([{ match: /sync:workshop-source/, code: 1, stdout: CHANGED_REPORT }, { match: /lab-studio-drift/, code: 0, stdout: `${JSON.stringify(IN_SYNC)}\n` }]);
  assert.equal((await w.go({ preflightDeps: fake.deps })).code, 0);
  const expected = lab.preflightCommands.map((command) => command.split("<checkout>").join('"$UPSTREAM_DIR"'));
  const ran = fake.scripts().filter((script) => !script.startsWith("npm ci"));
  assert.deepEqual(ran, expected, "exactly the edge's commands, with the checkout bound");
  for (const script of fake.scripts()) {
    assert.equal(script.includes(BUMP) || script.includes(VERIFY), false);
    assert.equal(script.includes("--accept"), false, "S3 never accepts a revision on behalf of the studio");
  }
});

test("AC64 the importer is a black box: no source or test of S3 asserts, copies or depends on its sanitisation allowlist, its link rewriting, its Markdown parsing or its heading ids", () => {
  // the names of the importer's own libraries and options, assembled so that this file does not contain them
  const names = [["sanitize", "-html"], ["Markdown", "It"], ["Github", "Slugger"], ["transform", "Tags"], ["allowed", "Schemes"], ["wrapDiagram", "Cards"], ["rewrite", "Link"], ["workshop", "-adaptations"]].map((parts) => parts.join(""));
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|json|md)$/.test(entry.name) && !full.endsWith("helper-cli-boundary.test.mjs")) found.push(full);
    }
  };
  walk(abs("src", "routing"));
  walk(abs("tests", "s3"));
  found.push(abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"));
  for (const file of found) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of names) assert.equal(text.includes(name), false, `${rel(file)} names ${name}`);
  }
  // the only thing that S3 knows about the importer is one positional argument: the edge's command, with the checkout bound
  const commands = presetEdgesOf().find((entry) => entry.mode === "mechanical").importCommands;
  assert.deepEqual(commands, ["npm run import:ghec-admin -- <checkout>"]);
});

test("AC43 AC44 AC45 S3 asserts only the boundary of the checks that SPEC-04 owns: no source of S3 parses test files, names their blocks, or checks the rules that those checks verify", () => {
  const checks = [/\b(?:describe|it)\(\s*["'`]/, /\.skip\b/, /\.only\b/, /\bvi\.mock\b/, /tests\/support\/customer-terms/, /content\/rules/];
  for (const file of scriptFiles()) {
    const text = code(file);
    for (const pattern of checks) assert.equal(pattern.test(text), false, `${rel(file)} matches ${pattern}`);
  }
  assert.equal(fs.existsSync(fixture("helpers", "lab-studio-drift.stub.mjs")), true);
  void edge;
});
