// The router as a consumer of the studio drift helper of C7 (2)(a) (SPEC-03 AC40, AC21, AC28): a stub CLI that emits each of the three exit codes with the JSON of the contract,
// run as a real process by a real bash from the workspace of the router, as the edge's preflight command names it. What decides is the helper: exit 0 with no changed lab is
// no drift, exit 1 is drift, exit 2 is a failure of the preflight that writes nothing, and anything that does not match the contract is a failure too. SPEC-04 verifies the CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBash, createStubBin, hostEnvironment } from "./helpers/git-world.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { fixture, sha, state } from "./helpers/fixtures.mjs";
import { CLEAN_REPORT, DRIFT, helperScript, IN_SYNC, preflightEdge } from "./helpers/preflight-world.mjs";

const bash = findBash();

/** The router with the stub helper in its workspace and a stub npm; the checkouts are directories (no git: this file is about the helper). */
function consumer(drift) {
  const edge = preflightEdge();
  const bin = createStubBin({ npm: { rules: [{ match: "^ci", code: 0 }, { match: "^run sync:workshop-source", code: 0, stdout: CLEAN_REPORT }] } });
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-consumer-"));
  const w = routerWorld({ edge, state: state({}, edge), upstream: { head: sha("h2") }, env: { ...hostEnvironment(), PATH: bin.path(), RUNNER_TEMP: runnerTemp } });
  const src = path.join(w.workspace.dir, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.copyFileSync(fixture("helpers", "lab-studio-drift.stub.mjs"), path.join(src, "lab-studio-drift.mjs"));
  fs.writeFileSync(path.join(src, "lab-studio-drift.stub.json"), JSON.stringify(helperScript(drift)));
  const calls = () => {
    const log = path.join(src, "lab-studio-drift.log.jsonl");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  return {
    w,
    calls,
    go: () => w.go({ bash, preflightDeps: { ensureCheckout: async ({ dir }) => fs.mkdirSync(dir, { recursive: true }) } }),
    cleanup() {
      w.cleanup();
      bin.cleanup();
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    },
  };
}

test("AC40 exit 0 with an empty changedLabs is no drift: the preflight is a noop and the helper was run once, without --accept", async (t) => {
  const c = consumer({ code: 0, stdout: IN_SYNC });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(c.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(c.w.stub.world.dispatches.length, 0);
  const [call] = c.calls();
  assert.equal(c.calls().length, 1);
  assert.deepEqual(call.args.filter((_, index) => index % 2 === 0), ["--portfolio", "--upstream", "--commit"], "the three options of the contract, in the order of the edge's command");
  assert.equal(call.args.includes("--accept"), false);
  assert.equal(call.args[5], sha("h2"), "--commit is the target");
});

test("AC40 exit 1 with status drift is drift: the cascade is dispatched with the scope that names the studio", async (t) => {
  const c = consumer({ code: 1, stdout: DRIFT });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(c.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(c.w.stub.world.dispatches[0].body.inputs.sync_scope, "studio-only");
  assert.equal(c.w.state().inFlightTargetSha, sha("h2"));
});

test("AC40 AC28 exit 2 is a failure of the preflight: nothing is written, nothing is dispatched, and one issue says why", async (t) => {
  const c = consumer({ code: 2, stdout: "", stderr: "fatal: cannot read apps/lab-studio/lab-sources.json\n" });
  t.after(() => c.cleanup());
  const before = c.w.stub.variables.get(c.w.edge.stateVariable);
  const result = await c.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with 2, a fatal error of the studio drift helper/);
  assert.equal(c.w.patches().length, 0);
  assert.equal(c.w.stub.variables.get(c.w.edge.stateVariable), before);
  assert.equal(c.w.stub.world.dispatches.length, 0);
  assert.equal(c.w.stub.issues.length, 1);
});

test("AC40 output that is not the contract's JSON, or that disagrees with the exit code, is a failure and never a drift or a clean result", async (t) => {
  for (const [label, drift] of [
    ["not JSON", { code: 0, stdout: "all good\n" }],
    ["no output", { code: 0, stdout: "" }],
    ["exit 0 with a changed lab", { code: 0, stdout: { ...IN_SYNC, changedLabs: ["lab01"] } }],
    ["exit 1 with status in-sync", { code: 1, stdout: IN_SYNC }],
    ["an exit code of nobody's contract", { code: 3, stdout: IN_SYNC }],
  ]) {
    const c = consumer(drift);
    t.after(() => c.cleanup());
    const result = await c.go();
    assert.equal(result.code, 1, label);
    assert.equal(c.w.patches().length, 0, label);
    assert.equal(c.w.stub.world.dispatches.length, 0, label);
  }
});

test("AC40 a helper that is not there is a failure, and no stand-in takes its place: node exits 1 for the file, and the router says what did not print", async (t) => {
  const c = consumer(IN_SYNC);
  t.after(() => c.cleanup());
  fs.rmSync(path.join(c.w.workspace.dir, "src", "lab-studio-drift.mjs"));
  const result = await c.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not print the JSON/);
  assert.equal(c.w.patches().length, 0);
  assert.equal(c.w.stub.world.dispatches.length, 0);
  assert.deepEqual(c.calls(), [], "the stub was not run in its place");
});
