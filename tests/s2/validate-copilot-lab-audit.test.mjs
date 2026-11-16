// AC23: node src/validate-copilot-lab-audit.mjs exits 0 only when all 11 top-level keys of docs/_meta/registry.yaml are present and,
// for an audit run, docs/_meta/audit-report.md has its four required sections (and the sections of docs/_meta/audit-report.template.md),
// or, for a self-improve run (--self-improve), self-improvement-report.md has its four required sections: a self-improve run does not
// need the audit report, which the weekly audit generates in its own pull request. Otherwise it exits non-zero and names the missing
// key or section on stderr. The report-only rule of AC22 is tested in report-only-schema-version.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { AUDIT_SECTIONS, REGISTRY_KEYS, run, scalarOf, scanTopLevelKeys, SELF_IMPROVEMENT_SECTIONS, secondLevelHeadings, sectionProblems } from "../../src/validate-copilot-lab-audit.mjs";
import { driftWorkflow, driftPreset, forceRemove, presetManifest, projectOf, tempDir, script } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles, withoutSection, withoutTopLevelKey, withSectionOrder } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, runNode } from "./helpers/stub-server.mjs";

const REQUIRED_KEYS = ["schema_version", "copilot_cli_version_floor", "gh_aw_schema_version", "mcp_protocol_spec_version", "mcp_servers", "prepared_core", "models", "model_default_availability_policy", "enterprise_managed_settings", "labs", "audit"];
let repo;
let base;
let out;

before(() => {
  repo = createRepo(labFiles());
  base = repo.head();
  // the run has committed a change, so it proposes a pull request and its working tree is held to the report (a run that commits nothing is not: see
  // the issue #14 tests below)
  repo.write("labs/proposed-change.md", "# a change that the run committed\n");
  repo.commitAll("the run's change");
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
  assert.match(verify[0], /node "\$GITHUB_WORKSPACE\/src\/validate-copilot-lab-audit\.mjs" --self-improve \)$/, "the validator is the last thing of the first command, with its argument");
  assert.match(projectOf(presetManifest(), "copilot-lab").driftAudit.verifyCommands[0], /node "\$GITHUB_WORKSPACE\/src\/validate-copilot-lab-audit\.mjs" \)$/, "and the lab's audit has none");
  assert.equal(driftWorkflow("self-improving-agents").frontmatter["post-steps"][0].run, verify[0]);
});

test("AC23: without a base commit the report-only rule cannot be checked, so the run fails closed; the base is --base-sha or SDLC_BASE_SHA, never run-context.json", async () => {
  const none = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /the base commit is unknown/);
  assert.match(none.stderr, /SDLC_BASE_SHA is not set and --base-sha was not given/);
  fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: base }));
  try {
    const fromContext = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
    assert.notEqual(fromContext.code, 0, "a file under --out is not a source of the base commit: the agent can edit it");
    assert.match(fromContext.stderr, /the base commit is unknown/);
    fs.writeFileSync(path.join(out, "run-context.json"), "{ not json");
    const fromVariable = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base }) });
    assert.equal(fromVariable.code, 0, `the variable that prepare-run exported is the source, whatever the run context holds: ${fromVariable.stderr}`);
  } finally {
    fs.rmSync(path.join(out, "run-context.json"), { force: true });
  }
  const fromVariable = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base }) });
  assert.equal(fromVariable.code, 0, fromVariable.stderr);
  assert.match(fromVariable.stdout, new RegExp(`unchanged since ${base.slice(0, 12)}`));
  const unknown = await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", "0".repeat(40)], { cwd: out });
  assert.notEqual(unknown.code, 0, "a base commit that is not in the checkout");
  assert.match(unknown.stderr, /is not in the target checkout/);
  const notACommit = await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", "main"], { cwd: out });
  assert.notEqual(notACommit.code, 0, "a branch name is not a base commit");
  assert.match(notACommit.stderr, /is not a full commit id/);
  assert.notEqual((await invoke(run, ["--bogus"], { cwd: out })).code, 0);
  assert.equal((await invoke(run, ["--bogus"], { cwd: out })).code, 2, "an unknown option is a usage error");
});

test("AC23: a self-improve run needs no audit report and no template: the lab's default branch holds only the template, and the weekly audit turns it into a report inside its own pull request", async () => {
  const defaultBranch = (checkout) => checkout.remove("docs/_meta/audit-report.md");
  const selfImprove = await validate(["--self-improve"], defaultBranch);
  assert.equal(selfImprove.code, 0, selfImprove.stderr);
  assert.equal(selfImprove.stderr, "");
  assert.match(selfImprove.stdout, /the self-improvement report complete/);
  const audit = await validate([], defaultBranch);
  assert.notEqual(audit.code, 0, "an audit run on the same tree is asked for the report");
  assert.ok(audit.stderr.includes("docs/_meta/audit-report.md is missing"), audit.stderr);
  const noTemplate = await validate(["--self-improve"], (checkout) => {
    defaultBranch(checkout);
    checkout.remove("docs/_meta/audit-report.template.md");
  });
  assert.equal(noTemplate.code, 0, `the template is the audit report's own input: ${noTemplate.stderr}`);
  const damaged = await validate(["--self-improve"], (checkout) => checkout.write("docs/_meta/audit-report.md", "# nothing\n"));
  assert.equal(damaged.code, 0, `a report that this run did not write is not this run's business: ${damaged.stderr}`);
});

test("AC23: a self-improve run still holds the registry, the self-improvement report and the report-only rule, with no audit report in the tree", async () => {
  const defaultBranch = (checkout) => checkout.remove("docs/_meta/audit-report.md");
  const registry = await validate(["--self-improve"], (checkout) => {
    defaultBranch(checkout);
    checkout.write("docs/_meta/registry.yaml", withoutTopLevelKey(checkout.read("docs/_meta/registry.yaml"), "labs"));
  });
  assert.notEqual(registry.code, 0);
  assert.ok(registry.stderr.includes("missing the top-level key 'labs'"), registry.stderr);
  const report = await validate(["--self-improve"], (checkout) => {
    defaultBranch(checkout);
    checkout.write("docs/_meta/self-improvement-report.md", withoutSection(checkout.read("docs/_meta/self-improvement-report.md"), "Findings"));
  });
  assert.notEqual(report.code, 0);
  assert.ok(report.stderr.includes("missing the section '## Findings'"), report.stderr);
  const missing = await validate(["--self-improve"], (checkout) => {
    defaultBranch(checkout);
    checkout.remove("docs/_meta/self-improvement-report.md");
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /self-improvement-report\.md is missing/);
  assert.equal(/audit-report/.test(missing.stderr), false, "and the audit report is not what it names");
  const workflows = await validate(["--self-improve"], (checkout) => {
    defaultBranch(checkout);
    checkout.write(".github/workflows/stand-in.lock.yml", "name: recompiled\n");
  });
  assert.notEqual(workflows.code, 0);
  assert.match(workflows.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit/);
});

// Issue #14 (run 43716421196): an audit agent that found nothing to change filed its report as the drift report issue and wrote nothing in the checkout.
// The post-step failed on the missing audit report, so the job failed and the issue was never filed. gh-aw makes a pull request only of commits, through
// the patch or bundle that create_pull_request writes (SPEC-02 OQ37), so a run that commits nothing (HEAD is the base commit and no commit is ahead of it)
// and writes no patch or bundle has nothing that a pull request could be made of: its report file is not asked for, whatever it leaves uncommitted,
// whether it is an audit or a self-improve run. A run that commits, or calls create_pull_request, is held to the report as before (the second test).
function quietLab(files) {
  const lab = createRepo(files);
  // the base commit has a parent with the same tree, so that HEAD can leave the base commit without changing a file
  lab.git("commit", "-q", "--allow-empty", "-m", "base of the run");
  const branch = lab.git("rev-parse", "--abbrev-ref", "HEAD");
  const root = tempDir("sdlc-s2-quiet-");
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent);
  const labBase = lab.head();
  return {
    lab,
    root,
    base: labBase,
    check: (args = []) => invoke(run, ["--checkout", lab.dir, "--out", agent, "--base-sha", labBase, ...args], { cwd: agent }),
    reset() {
      lab.git("switch", "-q", "--discard-changes", "-C", branch, labBase);
      lab.git("clean", "-fdq");
      for (const name of fs.readdirSync(root)) if (name !== "agent") fs.rmSync(path.join(root, name), { recursive: true, force: true });
    },
    cleanup() {
      lab.cleanup();
      forceRemove(root);
    },
  };
}

const withoutReports = () => {
  const files = labFiles();
  delete files["docs/_meta/audit-report.md"];
  delete files["docs/_meta/self-improvement-report.md"];
  return files;
};

test("AC23: a run that commits nothing and writes no patch or bundle passes without its report, whatever it leaves uncommitted, and still answers to rules 1 and 4", async () => {
  const quiet = quietLab(withoutReports());
  const { lab } = quiet;
  const registry = lab.read("docs/_meta/registry.yaml");
  // gh-aw makes a pull request only of commits (SPEC-02 OQ37): what a run leaves uncommitted cannot be published, so it asks for no report either
  const uncommitted = {
    "nothing at all": () => undefined,
    "an untracked file": () => lab.write("labs/notes.md", "# notes\n"),
    "a changed file": () => lab.write("docs/_meta/registry.yaml", `${registry}# reviewed\n`),
    "a staged change": () => {
      lab.write("docs/_meta/registry.yaml", `${registry}# reviewed\n`);
      lab.git("add", "docs/_meta/registry.yaml");
    },
    "a report without its sections": () => lab.write("docs/_meta/audit-report.md", "# nothing\n"),
  };
  try {
    for (const [place, leave] of Object.entries(uncommitted)) {
      leave();
      try {
        const audit = await quiet.check();
        assert.equal(audit.code, 0, `${place}: ${audit.stderr}`);
        assert.equal(audit.stderr, "", place);
        assert.match(audit.stdout, /ok \(11 registry keys, the audit report not asked for, because HEAD is the base commit, no commit is ahead of it and there is no patch or bundle: the run proposes no pull request/, place);
        assert.match(audit.stdout, new RegExp(`unchanged since ${quiet.base.slice(0, 12)}`), place);
        const selfImprove = await quiet.check(["--self-improve"]);
        assert.equal(selfImprove.code, 0, `${place}: ${selfImprove.stderr}`);
        assert.match(selfImprove.stdout, /the self-improvement report not asked for/, place);
      } finally {
        quiet.reset();
      }
    }
    lab.write("docs/_meta/registry.yaml", withoutTopLevelKey(registry, "labs"));
    const keyless = await quiet.check();
    assert.notEqual(keyless.code, 0, "rule 1 holds on a run that proposes nothing");
    assert.ok(keyless.stderr.includes("missing the top-level key 'labs'"), keyless.stderr);
    assert.equal(keyless.stderr.includes("audit-report.md"), false, "and the report is still not asked for");
    quiet.reset();
    lab.write(".github/workflows/stand-in.lock.yml", "name: recompiled\n");
    const recompiled = await quiet.check();
    assert.notEqual(recompiled.code, 0, "and so does rule 4");
    assert.match(recompiled.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit/);
  } finally {
    quiet.cleanup();
  }
});

test("AC23: anything that a pull request could be made of brings the report back: a commit on HEAD, a branch ahead of the base, a patch and a HEAD that left the base", async () => {
  const quiet = quietLab(withoutReports());
  const { lab } = quiet;
  const places = {
    "a commit on HEAD": () => {
      lab.write("labs/notes.md", "# notes\n");
      lab.commitAll("notes");
    },
    "a branch ahead of the base with HEAD back on it": () => {
      lab.git("switch", "-q", "-c", "sdlc/x");
      lab.write("labs/notes.md", "# notes\n");
      lab.commitAll("notes");
      lab.git("switch", "-q", "-");
    },
    "a patch that create_pull_request wrote, its branch deleted": () => {
      lab.git("switch", "-q", "-c", "sdlc/x");
      lab.write("labs/notes.md", "# notes\n");
      lab.commitAll("notes");
      const [first, ...rest] = `${lab.git("format-patch", `${quiet.base}..sdlc/x`, "--stdout")}\n`.split("\n");
      fs.writeFileSync(path.join(quiet.root, "aw-sdlc-x.patch"), [first, `X-GH-AW-Base-Commit: ${quiet.base}`, ...rest].join("\n"));
      lab.git("switch", "-q", "-");
      lab.git("branch", "-q", "-D", "sdlc/x");
    },
    "HEAD moved off the base commit to one with the same tree": () => lab.git("switch", "-q", "--detach", "HEAD~1"),
  };
  // the working tree itself is held to the report (the line that names no place), not only the tip of a commit, a branch or a patch
  const workingTreeLine = "validate-copilot-lab-audit: docs/_meta/audit-report.md is missing";
  try {
    for (const [place, leave] of Object.entries(places)) {
      leave();
      try {
        const result = await quiet.check();
        assert.notEqual(result.code, 0, place);
        assert.ok(result.stderr.split(/\r?\n/).includes(workingTreeLine), `${place}: ${result.stderr}`);
      } finally {
        quiet.reset();
        if (lab.git("branch", "--list", "sdlc/x") !== "") lab.git("branch", "-q", "-D", "sdlc/x");
      }
    }
    lab.write("labs/notes.md", "# notes\n");
    lab.commitAll("notes");
    const selfImprove = await quiet.check(["--self-improve"]);
    assert.notEqual(selfImprove.code, 0, "a self-improve run that commits is asked for its report too");
    assert.match(selfImprove.stderr, /self-improvement-report\.md is missing/);
  } finally {
    quiet.cleanup();
  }
});

test("AC23: the rendered post-step of drift-self-improving-agents passes on a lab tree that has the audit template and no audit report, as the default branch of the lab does", { skip: BASH_SKIP }, async () => {
  const step = driftWorkflow("self-improving-agents").frontmatter["post-steps"][0];
  assert.match(step.run, /node "\$GITHUB_WORKSPACE\/src\/validate-copilot-lab-audit\.mjs" --self-improve \)$/);
  const files = labFiles();
  delete files["docs/_meta/audit-report.md"];
  assert.ok("docs/_meta/audit-report.template.md" in files);
  const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files });
  try {
    const passed = await gate.runSteps([step]);
    assert.equal(passed.code, 0, passed.log);
    // a run that commits a change proposes a pull request, and then its working tree is held to the self-improvement report
    gate.write("labs/proposed-change.md", "# a change that the run committed\n");
    gate.git("add", "labs/proposed-change.md");
    gate.git("commit", "-q", "-m", "the run's change");
    gate.remove("docs/_meta/self-improvement-report.md");
    const failed = await gate.runSteps([step]);
    assert.equal(failed.code, 1);
    assert.ok(failed.log.includes("self-improvement-report.md is missing"), failed.log);
  } finally {
    gate.cleanup();
  }
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
  assert.match(step.run, /node "\$GITHUB_WORKSPACE\/src\/validate-copilot-lab-audit\.mjs" \)$/);
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
