// The boundary with SPEC-04's three helper CLIs (SPEC-03 AC41, AC42, AC43, AC44, AC45, AC52), as it is drawn now that the router is the engine's and the helpers are this
// repository's (scripts/): the router consumes lab-studio-drift.mjs through the edge's own preflight command and nothing else; it never invokes bump-studio-revision-pins.mjs or
// verify-immutable-gates.mjs, and no file that S3 owns defines any of the three. S3 asserts only this boundary; the helpers themselves are verified by tests/s4.
//
// What S3 owns is the part of the engine package that routes (src/route-upstream.mjs, src/update-poll-state.mjs, src/routing/) and the tests of this directory. The package is pinned
// and installed, so these tests read it where it is installed: they are the ones that notice when a new release of the engine learns the name of one of this repository's helpers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { engineFile, presetManifest } from "../helpers/instance.mjs";
import { declaredPreflight, expanded } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, fixture, presetEdges as presetEdgesOf, REPO_ROOT, sha, state } from "./helpers/fixtures.mjs";

const BUMP = "bump-studio-revision-pins";
const VERIFY = "verify-immutable-gates";
const STUDIO = "lab-studio-drift";

const scriptFiles = () => [engineFile("src", "route-upstream.mjs"), engineFile("src", "update-poll-state.mjs"), ...fs.readdirSync(engineFile("src", "routing")).map((name) => engineFile("src", "routing", name))];
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
  // and the helpers are scripts of this repository, which the engine does not ship
  for (const name of [BUMP, STUDIO, "validate-copilot-lab-audit"]) assert.equal(fs.existsSync(engineFile("src", `${name}.mjs`)), false, `${name}.mjs is no script of the engine`);
  for (const name of [BUMP, STUDIO]) assert.equal(fs.existsSync(abs("scripts", `${name}.mjs`)), true, `${name}.mjs is a script of this repository`);
});

test("AC52 S3's source does not mention the studio helper at all: the edge's preflight command is the only place that names it, and the router composes no command line of its own", () => {
  assert.deepEqual(scriptFiles().filter((file) => code(file).includes(STUDIO)).map(rel), [], "the classification of the helper's report was moved into this repository's scripts");
  assert.equal(/["'`]node\s/.test(code(engineFile("src", "routing", "preflight.mjs"))), false, "no command line is composed in the source");
  const named = presetEdgesOf().filter((edge) => [...edge.preflightCommands, ...edge.acceptCommands].some((command) => command.includes(STUDIO))).map((edge) => edge.edgeId);
  assert.deepEqual(named, ["copilot-lab"], "and the one edge that runs the helper says so in its own commands");
});

test("AC41 AC42 the router runs the edge's own commands and no other: for an edge without a preflight no command is run, and for the edge that runs the studio helper what is run is the edge's text", async (t) => {
  const quiet = routerWorld();
  t.after(() => quiet.cleanup());
  const none = declaredPreflight({ preflightCommands: [], preflightChecks: [] });
  await quiet.go({ preflightDeps: none.deps });
  assert.deepEqual(none.calls, [], "an edge that declares no preflight runs nothing");

  const lab = presetEdgesOf().find((edge) => edge.upstreamKey === "copilot-lab");
  const entry = { ...lab, initialBaselineSha: sha("sha0"), onBots: ["fixture-app[bot]"], stateVariable: "SDLC_SYNC_STATE_COPILOT_LAB" };
  const scripts = {};
  for (const file of ["scripts/classify-workshop-report.mjs", "scripts/lab-studio-drift.mjs"]) scripts[file] = fs.readFileSync(abs(file), "utf8");
  const w = routerWorld({ central: "johnhain-msft/mfg_msft_ai_sdlc", edge: entry, state: state({}, entry), upstream: { head: sha("h2") }, downstream: { head: sha("main") }, manifestEdges: [lab], manifestExtra: { factory: presetManifest().factory }, workspaceFiles: scripts });
  t.after(() => w.cleanup());
  const fake = declaredPreflight(lab);
  const result = await w.go({ preflightDeps: fake.deps });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const classifiers = lab.preflightChecks.flatMap((check) => (check.classifier ? [check.classifier] : []));
  const expected = [...lab.preflightCommands, ...classifiers].map(expanded);
  const ran = fake.scripts().filter((script) => !script.startsWith("npm ci"));
  assert.deepEqual(ran, expected, "exactly the edge's commands, with the checkout bound, and the classifier that the edge declares");
  for (const script of fake.scripts()) {
    assert.equal(script.includes(BUMP) || script.includes(VERIFY), false);
    assert.equal(script.includes("--accept"), false, "S3 never accepts a revision on behalf of the studio");
  }
  assert.ok(ran.some((script) => script.includes(STUDIO)), "the helper is run, by the edge's own command");
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
  walk(engineFile("src", "routing"));
  walk(abs("tests", "s3"));
  found.push(engineFile("src", "route-upstream.mjs"), engineFile("src", "update-poll-state.mjs"));
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
  assert.equal(fs.existsSync(fixture("state", "valid-seed.json")), true);
});
