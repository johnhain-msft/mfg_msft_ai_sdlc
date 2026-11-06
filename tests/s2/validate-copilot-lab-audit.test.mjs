// AC23: node src/validate-copilot-lab-audit.mjs exits 0 only when all 11 top-level keys of docs/_meta/registry.yaml are present, when
// docs/_meta/audit-report.md has its four required sections (and the sections of docs/_meta/audit-report.template.md), and, for a
// self-improve run (--self-improve), when self-improvement-report.md has its four required sections; otherwise it exits non-zero and
// names the missing key or section on stderr. The report-only rule of AC22 is tested in report-only-schema-version.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { AUDIT_SECTIONS, REGISTRY_KEYS, run, scalarOf, scanTopLevelKeys, SELF_IMPROVEMENT_SECTIONS, secondLevelHeadings, sectionProblems } from "../../src/validate-copilot-lab-audit.mjs";
import { driftWorkflow, driftPreset, presetManifest, projectOf, tempDir, script } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles, withoutSection, withoutTopLevelKey, withSectionOrder } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { runNode } from "./helpers/stub-server.mjs";

const REQUIRED_KEYS = ["schema_version", "copilot_cli_version_floor", "gh_aw_schema_version", "mcp_protocol_spec_version", "mcp_servers", "prepared_core", "models", "model_default_availability_policy", "enterprise_managed_settings", "labs", "audit"];
let repo;
let base;
let out;

before(() => {
  repo = createRepo(labFiles());
  base = repo.head();
  out = tempDir("sdlc-s2-validate-");
});

after(() => {
  repo.cleanup();
  fs.rmSync(out, { recursive: true, force: true });
});

/** Runs the validator on the working tree of the shared repository, then puts the tree back. */
async function validate(args = [], mutate = () => {}) {
  mutate(repo);
  try {
    return await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", base, ...args], { cwd: out });
  } finally {
    repo.git("checkout", "--", ".");
    repo.git("clean", "-fdq");
  }
}

test("AC23: the exported key list is the eleven keys of the lab registry, in its order", () => {
  assert.deepEqual(REGISTRY_KEYS, REQUIRED_KEYS);
  assert.deepEqual(scanTopLevelKeys(labFiles()["docs/_meta/registry.yaml"]).map((entry) => entry.key), REQUIRED_KEYS, "and the fixture registry has exactly those");
  assert.deepEqual(AUDIT_SECTIONS, ["Summary", "Checks", "Suggestions for Additions", "Metadata"]);
  assert.deepEqual(SELF_IMPROVEMENT_SECTIONS, ["Summary", "Findings", "Consolidation Candidates", "Metadata"]);
});

test("AC23: a registry with all 11 keys and an audit report with its four sections exits 0 and prints nothing on stderr", async () => {
  const result = await validate();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /validate-copilot-lab-audit: ok \(11 registry keys/);
});

for (const key of REQUIRED_KEYS) {
  test(`AC23: a registry without '${key}' exits non-zero and names it on stderr`, async () => {
    const result = await validate([], (checkout) => checkout.write("docs/_meta/registry.yaml", withoutTopLevelKey(checkout.read("docs/_meta/registry.yaml"), key)));
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(`docs/_meta/registry.yaml is missing the top-level key '${key}'`), result.stderr);
    assert.equal(result.stderr.trim().split("\n").filter((line) => line.includes("top-level key")).length, 1, "and only that key");
  });
}

for (const section of AUDIT_SECTIONS) {
  test(`AC23: an audit report without '## ${section}' exits non-zero and names the section`, async () => {
    const result = await validate([], (checkout) => checkout.write("docs/_meta/audit-report.md", withoutSection(checkout.read("docs/_meta/audit-report.md"), section)));
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(`docs/_meta/audit-report.md is missing the section '## ${section}'`), result.stderr);
  });
}

test("AC23: a missing registry, report or template is named, and a heading that is not a ## section does not count", async () => {
  for (const file of ["docs/_meta/registry.yaml", "docs/_meta/audit-report.md", "docs/_meta/audit-report.template.md"]) {
    const result = await validate([], (checkout) => checkout.remove(file));
    assert.notEqual(result.code, 0, file);
    assert.ok(result.stderr.includes(`${file} is missing`), `${file}: ${result.stderr}`);
  }
  const demoted = await validate([], (checkout) => checkout.write("docs/_meta/audit-report.md", checkout.read("docs/_meta/audit-report.md").replace("## Checks", "### Checks")));
  assert.notEqual(demoted.code, 0);
  assert.match(demoted.stderr, /missing the section '## Checks'/);
  const fenced = await validate([], (checkout) => checkout.write("docs/_meta/audit-report.md", checkout.read("docs/_meta/audit-report.md").replace("## Metadata", "```\n## Metadata\n```")));
  assert.notEqual(fenced.code, 0, "a heading inside a code fence is not a section");
  assert.match(fenced.stderr, /missing the section '## Metadata'/);
  const reordered = await validate([], (checkout) => checkout.write("docs/_meta/audit-report.md", withSectionOrder(checkout.read("docs/_meta/audit-report.md"), ["Checks", "Summary", "Suggestions for Additions", "Metadata"])));
  assert.notEqual(reordered.code, 0, "the sections are required in the order of the template");
  assert.match(reordered.stderr, /has its required sections out of order/);
});

test("AC23: the report is held to the sections of the template it is generated from", async () => {
  const extended = (checkout) => checkout.write("docs/_meta/audit-report.template.md", `${checkout.read("docs/_meta/audit-report.template.md")}\n## Appendix\n\n_None._\n`);
  const missing = await validate([], extended);
  assert.notEqual(missing.code, 0);
  assert.ok(missing.stderr.includes("docs/_meta/audit-report.md does not carry the template section '## Appendix'"), missing.stderr);
  const carried = await validate([], (checkout) => {
    extended(checkout);
    checkout.write("docs/_meta/audit-report.md", `${checkout.read("docs/_meta/audit-report.md")}\n## Appendix\n\nNothing.\n`);
  });
  assert.equal(carried.code, 0, carried.stderr);
});

test("AC23: for a self-improve run self-improvement-report.md must have its four sections too", async () => {
  const valid = await validate(["--self-improve"]);
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /the self-improvement report/);
  for (const section of SELF_IMPROVEMENT_SECTIONS) {
    const result = await validate(["--self-improve"], (checkout) => checkout.write("docs/_meta/self-improvement-report.md", withoutSection(checkout.read("docs/_meta/self-improvement-report.md"), section)));
    assert.notEqual(result.code, 0, section);
    assert.ok(result.stderr.includes(`docs/_meta/self-improvement-report.md is missing the section '## ${section}'`), `${section}: ${result.stderr}`);
  }
  const absent = await validate(["--self-improve"], (checkout) => checkout.remove("docs/_meta/self-improvement-report.md"));
  assert.notEqual(absent.code, 0);
  assert.match(absent.stderr, /self-improvement-report\.md is missing \(looked for docs\/_meta\/self-improvement-report\.md, self-improvement-report\.md\)/);
});

test("AC23: a run that is not a self-improve run does not need the self-improvement report, and the report may sit at the root or in --out", async () => {
  const without = await validate([], (checkout) => checkout.remove("docs/_meta/self-improvement-report.md"));
  assert.equal(without.code, 0, "an audit run is not asked for it");
  const atRoot = await validate(["--self-improve"], (checkout) => {
    checkout.write("self-improvement-report.md", checkout.read("docs/_meta/self-improvement-report.md"));
    checkout.remove("docs/_meta/self-improvement-report.md");
  });
  assert.equal(atRoot.code, 0, atRoot.stderr);
  fs.writeFileSync(path.join(out, "self-improvement-report.md"), labFiles()["docs/_meta/self-improvement-report.md"]);
  const inOut = await validate(["--self-improve"], (checkout) => checkout.remove("docs/_meta/self-improvement-report.md"));
  assert.equal(inOut.code, 0, inOut.stderr);
  fs.rmSync(path.join(out, "self-improvement-report.md"));
});

test("AC23: how a self-improve run is selected is the --self-improve argument, which the preset passes", () => {
  const verify = projectOf(presetManifest(), "self-improving-agents").driftAudit.verifyCommands;
  assert.equal(verify[0], 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" --self-improve');
  assert.equal(projectOf(presetManifest(), "copilot-lab").driftAudit.verifyCommands[0], 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"');
  assert.equal(driftWorkflow("self-improving-agents").frontmatter["post-steps"][0].run, verify[0]);
});

test("AC23: without a base commit the report-only rule cannot be checked, so the run fails closed; the base can come from run-context.json", async () => {
  const none = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /the base commit is unknown/);
  fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: base }));
  const fromContext = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
  assert.equal(fromContext.code, 0, fromContext.stderr);
  fs.writeFileSync(path.join(out, "run-context.json"), "{ not json");
  const broken = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
  assert.notEqual(broken.code, 0);
  fs.rmSync(path.join(out, "run-context.json"));
  const unknown = await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", "0".repeat(40)], { cwd: out });
  assert.notEqual(unknown.code, 0, "a base commit that is not in the checkout");
  assert.match(unknown.stderr, /is not in the target checkout/);
  assert.notEqual((await invoke(run, ["--bogus"], { cwd: out })).code, 0);
  assert.equal((await invoke(run, ["--bogus"], { cwd: out })).code, 2, "an unknown option is a usage error");
});

test("AC23: the scanner reads top-level keys only: quoted keys, comments, block scalars, CRLF and a byte order mark", () => {
  const text = "\uFEFF# comment: not a key\r\n---\r\nschema_version: 1 # trailing\r\n\"quoted key\": x\r\n'single''s': y\r\nblock: |\r\n  nested: not-top-level\r\n  more\r\nlist:\r\n- a: b\r\n  c: d\r\nlast:\r\n";
  assert.deepEqual(scanTopLevelKeys(text).map((entry) => entry.key), ["schema_version", "quoted key", "single's", "block", "list", "last"]);
  assert.equal(scalarOf('"0.86.2" # note'), "0.86.2");
  assert.equal(scalarOf("'0.86.2'"), "0.86.2");
  assert.equal(scalarOf("0.86.2"), "0.86.2");
  assert.equal(scalarOf(""), "");
  assert.deepEqual(secondLevelHeadings("# t\n## A\n```\n## B\n```\n<!--\n## C\n-->\n### D\n## E ##\n"), ["A", "E"]);
  assert.deepEqual(sectionProblems("r", "## A\n## B\n", ["A", "B"]), []);
  assert.deepEqual(sectionProblems("r", "## B\n## A\n", ["A", "B"]), ["r has its required sections out of order (expected ## A, ## B)"]);
});

test("AC23: the post-step of drift-copilot-lab runs the validator from the orchestrator workspace in the target checkout", { skip: BASH_SKIP }, async () => {
  const step = driftWorkflow("copilot-lab").frontmatter["post-steps"][0];
  assert.equal(step.run, 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"');
  assert.equal(step["working-directory"], "day-in-the-life-copilot-lab");
  const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: labFiles() });
  try {
    const passed = await gate.runSteps([step]);
    assert.equal(passed.code, 0, passed.log);
    gate.write("docs/_meta/registry.yaml", withoutTopLevelKey(labFiles()["docs/_meta/registry.yaml"], "labs"));
    const failed = await gate.runSteps([step]);
    assert.equal(failed.code, 1);
    assert.ok(failed.log.includes("missing the top-level key 'labs'"), failed.log);
  } finally {
    gate.cleanup();
  }
  assert.ok(driftPreset("copilot-lab").driftAudit.verifyCommands.includes(step.run));
});

test("AC23: run as a process, the validator exits 0 on the valid fixture and 1 on a broken one", async () => {
  const environment = { ...process.env };
  const ok = await runNode(script("validate-copilot-lab-audit.mjs"), ["--out", out, "--base-sha", base], { env: environment, cwd: repo.dir });
  assert.equal(ok.code, 0, ok.stderr);
  repo.write("docs/_meta/audit-report.md", "# nothing\n");
  try {
    const broken = await runNode(script("validate-copilot-lab-audit.mjs"), ["--out", out, "--base-sha", base], { env: environment, cwd: repo.dir });
    assert.equal(broken.code, 1);
    for (const section of AUDIT_SECTIONS) assert.ok(broken.stderr.includes(`'## ${section}'`), section);
  } finally {
    repo.git("checkout", "--", ".");
  }
});
