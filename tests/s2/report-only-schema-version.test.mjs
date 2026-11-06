// AC22: gh_aw_schema_version is report-only for the lab. The validator exits non-zero, so that post-steps exit 1, when the target's
// diff against the recorded baseSha changes gh_aw_schema_version or touches anything under .github/workflows/; and
// exclude-lock-yml: true and protected-files with policy "blocked" stay as AC2 renders them, with no exclude entry that covers
// .github/workflows/.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { run } from "../../src/validate-copilot-lab-audit.mjs";
import { DRIFT_KEYS, driftWorkflow, tempDir } from "./helpers/fixtures.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";

let repo;
let base;
let out;

before(() => {
  repo = createRepo(labFiles());
  base = repo.head();
  out = tempDir("sdlc-s2-report-only-");
  fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: base }));
});

after(() => {
  repo.cleanup();
  fs.rmSync(out, { recursive: true, force: true });
});

/** Applies a change to the shared checkout, validates against the recorded baseSha, and puts the checkout back. */
async function afterChange(change, args = []) {
  change(repo);
  try {
    return await invoke(run, ["--checkout", repo.dir, "--out", out, ...args], { cwd: out });
  } finally {
    repo.git("reset", "-q", "--hard", base);
    repo.git("clean", "-fdq");
  }
}

const setVersion = (version) => (checkout) => checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace('gh_aw_schema_version: "0.86.2"', `gh_aw_schema_version: ${version}`));

test("AC22: a checkout that changes gh_aw_schema_version exits non-zero and names the old and the new value", async () => {
  const result = await afterChange(setVersion('"0.88.2"'));
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '0.88.2'; it is report-only"), result.stderr);
});

test("AC22: a checkout that touches .github/workflows/x.lock.yml exits non-zero and names the path", async () => {
  const result = await afterChange((checkout) => checkout.write(".github/workflows/x.lock.yml", "name: recompiled\n"));
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(".github/workflows/x.lock.yml differs from the base commit"), result.stderr);
  assert.match(result.stderr, /nothing under \.github\/workflows\/ may be edited, recompiled or deleted/);
});

test("AC22: a checkout that touches neither exits 0, although it changes other registry values and lab files", async () => {
  const result = await afterChange((checkout) => {
    checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace('copilot_cli_version_floor: "1.0.82"', 'copilot_cli_version_floor: "1.0.99"').replace("pace_workshop_minutes: 12", "pace_workshop_minutes: 15"));
    checkout.write("docs/_meta/audit-report.md", `${checkout.read("docs/_meta/audit-report.md")}\nA note.\n`);
    checkout.write("labs/lab01.md", "A new lab file.\n");
  });
  assert.equal(result.code, 0, result.stderr);
});

test("AC22: the same change is caught whether it is committed, staged, modified in the working tree or untracked", async () => {
  const forms = {
    committed: (checkout) => {
      checkout.write(".github/workflows/stand-in.lock.yml", "name: changed\n");
      checkout.commitAll("recompile");
    },
    staged: (checkout) => {
      checkout.write(".github/workflows/stand-in.lock.yml", "name: staged\n");
      checkout.git("add", "-A");
    },
    modified: (checkout) => checkout.write(".github/workflows/stand-in.lock.yml", "name: modified\n"),
    untracked: (checkout) => checkout.write(".github/workflows/brand-new.yml", "name: new\n"),
    deleted: (checkout) => checkout.remove(".github/workflows/stand-in.lock.yml"),
    renamedAway: (checkout) => {
      checkout.git("mv", ".github/workflows/stand-in.lock.yml", "docs/moved.yml");
    },
    renamedIn: (checkout) => {
      checkout.write("docs/other.yml", "name: other\n");
      checkout.commitAll("add");
      checkout.git("mv", "docs/other.yml", ".github/workflows/other.yml");
    },
    caseVariant: (checkout) => checkout.write(".GitHub/Workflows/Evil.yml", "name: evil\n"),
  };
  for (const [name, change] of Object.entries(forms)) {
    const result = await afterChange(change);
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, /\.github\/workflows\/|\.GitHub\/Workflows\//i, name);
  }
  const versionForms = {
    committed: (checkout) => {
      setVersion('"0.90.0"')(checkout);
      checkout.commitAll("bump");
    },
    staged: (checkout) => {
      setVersion('"0.90.0"')(checkout);
      checkout.git("add", "-A");
    },
    modified: setVersion('"0.90.0"'),
  };
  for (const [name, change] of Object.entries(versionForms)) {
    const result = await afterChange(change);
    assert.notEqual(result.code, 0, `version ${name}`);
    assert.match(result.stderr, /gh_aw_schema_version changed from '0\.86\.2' to '0\.90\.0'/, name);
  }
});

test("AC22: a change that is not the value passes: another quote style, a comment, a similarly named directory", async () => {
  const quote = await afterChange(setVersion("'0.86.2'"));
  assert.equal(quote.code, 0, quote.stderr);
  const unquoted = await afterChange(setVersion("0.86.2 # same value"));
  assert.equal(unquoted.code, 0, unquoted.stderr);
  const comment = await afterChange((checkout) => checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace("# NOTE: this value is report-only", "# NOTE: upstream latest is 0.99.0; this value is report-only")));
  assert.equal(comment.code, 0, comment.stderr);
  const sibling = await afterChange((checkout) => {
    checkout.write(".github/workflows-notes/readme.md", "not a workflow\n");
    checkout.write(".github/ISSUE_TEMPLATE/bug.md", "template\n");
  });
  assert.equal(sibling.code, 0, sibling.stderr);
});

test("AC22: a registry that loses the key, or gains it, is reported as a change of the value", async () => {
  const lost = await afterChange((checkout) => checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace('gh_aw_schema_version: "0.86.2"\n', "")));
  assert.notEqual(lost.code, 0);
  assert.match(lost.stderr, /gh_aw_schema_version changed from '0\.86\.2' to \(absent\)/);
  assert.match(lost.stderr, /missing the top-level key 'gh_aw_schema_version'/);
});

test("AC22: the base commit comes from run-context.json, so a run is judged against what prepare-run recorded", async () => {
  repo.write(".github/workflows/x.lock.yml", "name: x\n");
  const first = repo.commitAll("touch workflows");
  try {
    const againstOld = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
    assert.notEqual(againstOld.code, 0, "judged against the recorded base");
    fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: first }));
    const againstNew = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
    assert.equal(againstNew.code, 0, againstNew.stderr);
  } finally {
    repo.git("reset", "-q", "--hard", base);
    fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: base }));
  }
});

for (const key of ["copilot-lab", "self-improving-agents"]) {
  test(`AC22: drift-${key}.md keeps exclude-lock-yml: true and protected-files blocked, with no exclude entry under .github/workflows/`, () => {
    const handler = driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"];
    assert.equal(handler["exclude-lock-yml"], true);
    assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: [] });
    for (const entry of handler["protected-files"].exclude) assert.equal(/\.github\/workflows/.test(entry), false, entry);
    assert.equal("allow-workflows" in handler, false);
  });
}

test("AC22: no drift workflow lets the agent edit .github/workflows through protected-files", () => {
  for (const key of DRIFT_KEYS) {
    const exclude = driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"]["protected-files"].exclude;
    assert.equal(exclude.some((entry) => /\.github\/workflows/.test(entry)), false, key);
  }
});

test("AC22: the prompt of the lab workflow treats gh_aw_schema_version as report-only and forbids touching .github/workflows/", () => {
  const { body } = driftWorkflow("copilot-lab");
  assert.match(body, /Treat `gh_aw_schema_version` as report-only\. Report new `github\/gh-aw` releases in `docs\/_meta\/audit-report\.md`, and never change that value\./);
  assert.match(body, /Never edit, recompile or delete anything under `\.github\/workflows\/`/);
});
