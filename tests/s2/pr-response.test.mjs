// AC27: contract C5 response GitHubPullRequestResponse. The pull request opened or updated by a run is { number, html_url, head: { ref, sha }, draft },
// where head.ref matches sdlc/<workflowKey>-YYYY-MM-DD and draft equals the draft that the workflow renders; the shape validates against
// schemas/github-pull-request-response.schema.json, which requires all four keys and permits extra keys. src/drift/check-pr-response.mjs
// exits 0 only for such a response.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { BRANCH_PATTERN, checkResponse, renderedDraft, run } from "../../src/drift/check-pr-response.mjs";
import { abs, fixture, readJson, script } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { runNode } from "./helpers/stub-server.mjs";

const validate = new Ajv({ allErrors: true, strict: true }).compile(readJson(abs("schemas", "github-pull-request-response.schema.json")));
const LAB = abs(".github", "workflows", "drift-copilot-lab.md");
const IMPROVING = abs(".github", "workflows", "drift-self-improving-agents.md");
const GH_ADMIN = abs(".github", "workflows", "drift-gh-admin-msft.md");
const response = (name) => fixture("pr-response", `${name}.json`);
const check = (name, workflow = LAB) => runNode(script("drift", "check-pr-response.mjs"), [response(name), "--workflow", workflow]);

test("AC27: a response with the four keys, a head.ref of the branch pattern and the draft that the workflow renders exits 0", async () => {
  const lab = await check("valid");
  assert.equal(lab.code, 0, lab.stderr);
  assert.match(lab.stdout, /pull request #42 is valid \(sdlc\/weekly-audit-2026-11-01, draft false\)/);
  const improving = await check("valid-draft", IMPROVING);
  assert.equal(improving.code, 0, improving.stderr);
  const admin = await check("valid", GH_ADMIN);
  assert.equal(admin.code, 0, admin.stderr);
});

test("AC27: a response with further keys of the GitHub pull request object exits 0", async () => {
  const result = await check("extra-keys");
  assert.equal(result.code, 0, result.stderr);
});

for (const [name, reason] of [
  ["missing-number", /must have required property 'number'/],
  ["missing-html_url", /must have required property 'html_url'/],
  ["missing-head-ref", /head must have required property 'ref'/],
  ["missing-head-sha", /head must have required property 'sha'/],
  ["missing-draft", /must have required property 'draft'/],
  ["wrong-types", /number must be integer|draft must be boolean/],
]) {
  test(`AC27: the fixture ${name} fails the command, naming the reason, and the schema`, async () => {
    const result = await check(name);
    assert.equal(result.code, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, reason);
    assert.equal(validate(readJson(response(name))), false, `${name}: the schema refuses it too`);
  });
}

test("AC27: the schema accepts the valid fixtures and one with extra keys, and refuses each fixture that lacks a required key", () => {
  for (const name of ["valid", "valid-draft", "extra-keys", "wrong-branch"]) assert.equal(validate(readJson(response(name))), true, `${name}: ${JSON.stringify(validate.errors)}`);
  for (const name of ["missing-number", "missing-html_url", "missing-head-ref", "missing-head-sha", "missing-draft"]) assert.equal(validate(readJson(response(name))), false, name);
  const schema = readJson(abs("schemas", "github-pull-request-response.schema.json"));
  assert.deepEqual([...schema.required].sort(), ["draft", "head", "html_url", "number"]);
  assert.deepEqual([...schema.properties.head.required].sort(), ["ref", "sha"]);
  assert.equal(schema.additionalProperties, true, "extra keys are permitted");
  assert.equal(validate({ number: 0, html_url: "https://x.test/1", head: { ref: "r", sha: "s" }, draft: false }), false, "a pull request number is at least 1");
  assert.equal(validate({ number: 1, html_url: "not a url", head: { ref: "r", sha: "s" }, draft: false }), false);
  assert.equal(validate({ number: 1, html_url: "https://x.test/1", head: { ref: "", sha: "s" }, draft: false }), false);
});

test("AC27: a head.ref outside sdlc/<workflowKey>-YYYY-MM-DD, or a draft that differs from the workflow's rendered draft, exits 1", async () => {
  const branch = await check("wrong-branch");
  assert.equal(branch.code, 1);
  assert.match(branch.stderr, /head\.ref 'feature\/x' does not match/);
  const draftMismatch = await check("valid", IMPROVING);
  assert.equal(draftMismatch.code, 1, "drift-self-improving-agents renders draft: true");
  assert.match(draftMismatch.stderr, /draft is false, but the workflow renders draft: true/);
  const other = await check("valid-draft", LAB);
  assert.equal(other.code, 1, "drift-copilot-lab renders draft: false");
  assert.match(other.stderr, /draft is true, but the workflow renders draft: false/);
});

test("AC27: the branch pattern accepts the examples of AC25 and refuses what is not the sdlc/<workflowKey>-YYYY-MM-DD form", () => {
  for (const ref of ["sdlc/weekly-audit-2026-11-01", "sdlc/self-improve-2026-11-02", "sdlc/a-b-c-1999-01-31"]) assert.match(ref, BRANCH_PATTERN);
  for (const ref of ["weekly-audit-2026-11-01", "sdlc/weekly-audit", "sdlc/-2026-11-01", "sdlc/weekly-audit-2026-11-01-x", "automation/weekly-audit-2026-11-01", "sdlc/weekly-audit-26-11-01"]) assert.doesNotMatch(ref, BRANCH_PATTERN, ref);
});

test("AC27: the rendered draft is read from the workflow's frontmatter, and a workflow without one is a usage error", async () => {
  assert.equal(renderedDraft(fs.readFileSync(LAB, "utf8")), false);
  assert.equal(renderedDraft(fs.readFileSync(IMPROVING, "utf8")), true);
  assert.deepEqual(checkResponse(readJson(response("valid")), { draft: false }), []);
  assert.deepEqual(checkResponse(readJson(response("valid")), { draft: true }), ["draft is false, but the workflow renders draft: true"]);
  assert.throws(() => renderedDraft("no frontmatter"), /no frontmatter/);
  for (const argv of [[], [response("valid")], [response("valid"), "--workflow"], [response("valid"), "--workflow", fixture("pr-response", "valid.json")], ["a.json", "b.json", "--workflow", LAB], [response("valid"), "--bogus", "x", "--workflow", LAB]]) {
    const result = await invoke(run, argv);
    assert.equal(result.code, 2, JSON.stringify(argv));
  }
  const unreadable = await invoke(run, [fixture("pr-response", "absent.json"), "--workflow", LAB]);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.stderr, /cannot be read as JSON/);
});

test("AC27: the check reads two files and writes nothing", async () => {
  const before = fs.readdirSync(fixture("pr-response")).sort();
  await check("valid");
  assert.deepEqual(fs.readdirSync(fixture("pr-response")).sort(), before);
});
