// AC33: the self-improving-agents drift workflow. Its prompt directs the agent to scan the lab's agents, skills and prompts for the five
// drift signals of the lab's own self-improving-agents workflow and to produce self-improvement-report.md with its four sections;
// it forbids edits to the lab's own workflow and its lock, records a check it cannot run as a limitation, and never merges. The
// validator checks the report of a self-improve run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { run } from "../../scripts/validate-copilot-lab-audit.mjs";
import { abs, driftWorkflow, readText, tempDir } from "./helpers/fixtures.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles, withoutSection } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";

// The five signals, as the lab's own .github/workflows/self-improving-agents.md names them ("What 'drift' means here").
const SIGNALS = ["Stale references", "Contradicted by recent human corrections", "Underused", "Contradicts eval-harness conventions", "Duplicated responsibility"];
const FINDINGS_SUBSECTIONS = ["Stale references", "Contradicted by recent human corrections", "Underused", "Contradicts eval-harness conventions", "Duplicated responsibility"];

let repo;
let base;
let out;

before(() => {
  repo = createRepo(labFiles());
  base = repo.head();
  // the run has committed a change, so it proposes a pull request and its working tree is held to the report (SPEC-02 AC23: a run that commits
  // nothing is not asked for the report file, since gh-aw makes a pull request only of commits)
  repo.write("labs/proposed-change.md", "# a change that the run committed\n");
  repo.commitAll("the run's change");
  out = tempDir("sdlc-s2-selfimprove-");
});

after(() => {
  repo.cleanup();
  fs.rmSync(out, { recursive: true, force: true });
});

async function validateWith(report) {
  repo.write("docs/_meta/self-improvement-report.md", report);
  try {
    return await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", base, "--self-improve"], { cwd: out });
  } finally {
    repo.git("checkout", "--", ".");
  }
}

const body = () => driftWorkflow("self-improving-agents").body;
const signalsOf = (text) => {
  const section = /## The five drift signals([\s\S]*?)\n## /.exec(text)[1];
  return [...section.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((match) => match[1].replace(/:$/, ""));
};

test("AC33: the prompt lists exactly five drift signals, the five of the lab's own self-improving-agents workflow", () => {
  assert.deepEqual(signalsOf(body()), SIGNALS);
  assert.equal(signalsOf(body()).length, 5);
  assert.ok(body().includes("taken from the lab's own self-improvement workflow"));
  assert.match(body(), /Scan every agent, skill and prompt for these five signals/);
});

test("AC33: the prompt asks for self-improvement-report.md with its four sections, in a file in docs/_meta and in the pull request body", () => {
  const text = body();
  assert.match(text, /self-improvement-report\.md/);
  assert.match(text, /written to `docs\/_meta\/self-improvement-report\.md` and attached in the pull request body/);
  for (const section of ["Summary", "Findings", "Consolidation Candidates", "Metadata"]) assert.ok(text.includes(`\`## ${section}\``), `## ${section}`);
  assert.match(text, /`## Summary`: counts of agents, skills and prompts scanned, drift signals found per category, mechanical fixes applied and non-mechanical concerns flagged/);
  assert.match(text, /`## Findings`: one subsection per drift signal/);
  assert.match(text, /`## Consolidation Candidates`: duplicated-responsibility pairs, named but not merged/);
  assert.match(text, /`## Metadata`: run date, branch name and, if present, the content registry `schema_version`/);
});

test("AC33: the prompt forbids edits to the lab's self-improving-agents workflow and its lock, records a check that cannot run, and never merges", () => {
  const text = body();
  assert.match(text, /Never edit the lab's `\.github\/workflows\/self-improving-agents\.md` or its compiled `\.lock\.yml`/);
  assert.match(text, /A check you cannot run is a limitation to record, not something to skip silently or to invent findings for/);
  assert.match(text, /and never merge/);
  assert.match(text, /Mechanical, low-risk fixes only/);
  assert.match(text, /The pull request is a draft for a human to review/);
});

test("AC33: the instruction file is the one the preset names, and it holds the same five signals", () => {
  assert.deepEqual(signalsOf(readText(abs("instructions", "self-improving-agents.md")) + "\n## "), SIGNALS);
});

test("AC33: a report with one ### subsection per listed signal under ## Findings passes the validator for a self-improve run", async () => {
  const report = labFiles()["docs/_meta/self-improvement-report.md"];
  const findings = /## Findings\n([\s\S]*?)\n## /.exec(report)[1];
  assert.deepEqual([...findings.matchAll(/^### (.+)$/gm)].map((match) => match[1]), FINDINGS_SUBSECTIONS, "the fixture has one subsection per signal");
  const result = await validateWith(report);
  assert.equal(result.code, 0, result.stderr);
});

for (const section of ["Summary", "Findings", "Consolidation Candidates", "Metadata"]) {
  test(`AC33: a self-improvement report without '## ${section}' fails the validator`, async () => {
    const result = await validateWith(withoutSection(labFiles()["docs/_meta/self-improvement-report.md"], section));
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(`is missing the section '## ${section}'`), result.stderr);
  });
}

test("AC33: the same report passes on a tree that holds the audit template and no audit report, which is how the lab's default branch looks before a weekly audit merges", async () => {
  repo.remove("docs/_meta/audit-report.md");
  assert.ok(fs.existsSync(path.join(repo.dir, "docs", "_meta", "audit-report.template.md")));
  const result = await validateWith(labFiles()["docs/_meta/self-improvement-report.md"]);
  assert.equal(result.code, 0, `a self-improve run is not asked for the audit report: ${result.stderr}`);
});

test("AC33: the prompt of the self-improving workflow is a draft policy and carries no reviewer, leaving assignment to CODEOWNERS", () => {
  const { frontmatter } = driftWorkflow("self-improving-agents");
  assert.equal(frontmatter["safe-outputs"]["create-pull-request"].draft, true);
  assert.deepEqual(frontmatter["safe-outputs"]["create-pull-request"].reviewers, []);
  assert.ok(path.basename(abs("instructions", "self-improving-agents.md")).length > 0);
});
