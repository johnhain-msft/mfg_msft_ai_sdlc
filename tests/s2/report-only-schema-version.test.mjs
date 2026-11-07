// AC22: gh_aw_schema_version is report-only for the lab. The validator exits non-zero, so that post-steps exit 1, when the target's
// diff against the recorded base commit changes gh_aw_schema_version or touches anything under .github/workflows/; and
// exclude-lock-yml: true and protected-files with policy "blocked" stay as AC2 renders them, with no exclude entry that covers
// .github/workflows/. The base commit is the one that prepare-run, the first step of the job, hands to the later steps through
// GITHUB_ENV (SDLC_BASE_SHA); it is never read from run-context.json, which the agent can edit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { changedPaths, pinnedValueAt, run } from "../../src/validate-copilot-lab-audit.mjs";
import { DRIFT_KEYS, driftWorkflow, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { labFiles } from "./helpers/lab-fixture.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

let repo;
let base;
let out;

before(() => {
  repo = createRepo(labFiles());
  base = repo.head();
  out = tempDir("sdlc-s2-report-only-");
});

after(() => {
  repo.cleanup();
  fs.rmSync(out, { recursive: true, force: true });
});

/** The environment of a verification step: the base commit that the first step of the job exported. */
const withBase = (sha) => cleanEnv({ SDLC_BASE_SHA: sha });

/** Applies a change to the shared checkout, validates against the recorded base commit, and puts the checkout back. */
async function afterChange(change, args = []) {
  change(repo);
  try {
    return await invoke(run, ["--checkout", repo.dir, "--out", out, ...args], { cwd: out, env: withBase(base) });
  } finally {
    repo.git("reset", "-q", "--hard", base);
    repo.git("clean", "-fdq");
  }
}

const setVersion = (version) => (checkout) => checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace('gh_aw_schema_version: "0.86.2"', `gh_aw_schema_version: ${version}`));

/** Puts the shared checkout back as the base commit left it: replace refs and a graft file (which an agent can make in .git) included. */
function restore() {
  for (const ref of repo.git("for-each-ref", "--format=%(refname:lstrip=2)", "refs/replace/").split("\n").filter(Boolean)) repo.git("replace", "-d", ref);
  fs.rmSync(path.join(repo.dir, ".git", "info", "grafts"), { force: true });
  repo.git("reset", "-q", "--hard", base);
  repo.git("clean", "-fdq");
}

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

test("AC22: the base commit is the one that the first step exported as SDLC_BASE_SHA, so a run is judged against what that step recorded", async () => {
  repo.write(".github/workflows/x.lock.yml", "name: x\n");
  const first = repo.commitAll("touch workflows");
  try {
    const againstOld = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.notEqual(againstOld.code, 0, "judged against the recorded base");
    const againstNew = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(first) });
    assert.equal(againstNew.code, 0, againstNew.stderr);
    const flagWins = await invoke(run, ["--checkout", repo.dir, "--out", out, "--base-sha", first], { cwd: out, env: withBase(base) });
    assert.equal(flagWins.code, 0, "an operator's --base-sha is explicit and comes first");
  } finally {
    repo.git("reset", "-q", "--hard", base);
  }
});

const forgedContext = (sha) => fs.writeFileSync(path.join(out, "run-context.json"), JSON.stringify({ baseSha: sha }));

test("AC22: an agent that bumps gh_aw_schema_version, commits it and rewrites run-context.json to name its own commit does not get past the rule", async () => {
  setVersion('"9.9.9"')(repo);
  const head = repo.commitAll("bump the pinned version");
  forgedContext(head);
  try {
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, `the forged context must not decide: ${result.stdout}`);
    assert.ok(result.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), result.stderr);
    assert.match(result.stderr, /records the base commit [0-9a-f]{12}, but the first step of the job handed over [0-9a-f]{12} \(SDLC_BASE_SHA\)/, "the edit of the run context is named as well");
    const withoutVariable = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out });
    assert.equal(withoutVariable.code, 1, "without the exported variable the file is not a base either");
    assert.match(withoutVariable.stderr, /the base commit is unknown/);
  } finally {
    repo.git("reset", "-q", "--hard", base);
    fs.rmSync(path.join(out, "run-context.json"), { force: true });
  }
});

test("AC22: the same forgery over a recompiled workflow is refused, and an untouched run is not flagged for an unchanged run context", async () => {
  repo.write(".github/workflows/stand-in.lock.yml", "name: recompiled by the agent\n");
  const head = repo.commitAll("recompile");
  forgedContext(head);
  try {
    const forged = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(forged.code, 1);
    assert.match(forged.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit/);
  } finally {
    repo.git("reset", "-q", "--hard", base);
  }
  forgedContext(base);
  try {
    const honest = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(honest.code, 0, honest.stderr);
    assert.equal(honest.stderr, "", "a run context that agrees with the exported commit says nothing");
  } finally {
    fs.rmSync(path.join(out, "run-context.json"), { force: true });
  }
});

test("AC22: a base commit that is not a full commit id is refused before git sees it", async () => {
  for (const bad of ["HEAD", "--exec-path=/tmp", "abc123", "0".repeat(41), `${base} --all`]) {
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(bad) });
    assert.equal(result.code, 1, JSON.stringify(bad));
    assert.match(result.stderr, /is not a full commit id/, JSON.stringify(bad));
  }
});

// The agent works in the checkout that the validator then reads, and it can write the .git directory of that checkout (the compiled agent step
// allows `git` with any arguments). Whatever in that directory decides what git answers, other than the objects themselves, must not decide what
// the report-only rule compares.

test("AC22: an agent that commits a change and runs `git replace <base> HEAD` does not get past the rule: git is asked for the real base commit", async () => {
  const forms = {
    "a bumped gh_aw_schema_version": { change: () => setVersion('"9.9.9"')(repo), expected: "gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only" },
    "a recompiled workflow": { change: () => repo.write(".github/workflows/stand-in.lock.yml", "name: recompiled by the agent\n"), expected: ".github/workflows/stand-in.lock.yml differs from the base commit" },
  };
  for (const [name, { change, expected }] of Object.entries(forms)) {
    change();
    const head = repo.commitAll(name);
    repo.git("replace", base, head);
    try {
      assert.equal(repo.git("diff", "--name-only", base), "", `${name}: with the replace ref in place, plain git answers that nothing differs from the base`);
      const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
      assert.equal(result.code, 1, `${name}: the replaced base must not decide\n${result.stdout}`);
      assert.ok(result.stderr.includes(expected), `${name}: ${result.stderr}`);
      assert.match(result.stderr, /the target checkout has a replace ref \(refs\/replace\/[0-9a-f]{40}\)/, "and the replace ref itself is named");
    } finally {
      restore();
    }
  }
});

test("AC22: git is asked for the objects as they are: under a replace ref, changedPaths and pinnedValueAt still read the real base commit", () => {
  setVersion('"9.9.9"')(repo);
  const head = repo.commitAll("bump the pinned version");
  repo.git("replace", base, head);
  try {
    assert.equal(repo.git("diff", "--name-only", base), "", "plain git, with the replace ref in place, answers that nothing differs from the base");
    assert.deepEqual(changedPaths(repo.dir, base, cleanEnv(), head), ["docs/_meta/registry.yaml"]);
    assert.equal(pinnedValueAt(repo.dir, base, cleanEnv()), "0.86.2");
    assert.equal(pinnedValueAt(repo.dir, head, cleanEnv()), "9.9.9");
  } finally {
    restore();
  }
});

test("AC22: a checkout that has a graft file is refused, because --no-replace-objects does not switch grafts off", async () => {
  const graftFile = path.join(repo.dir, ".git", "info", "grafts");
  fs.mkdirSync(path.dirname(graftFile), { recursive: true });
  fs.writeFileSync(graftFile, `${base}\n`);
  try {
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /the target checkout has a graft file \(.*grafts\)/);
  } finally {
    restore();
  }
  const named = path.join(out, "named-grafts");
  fs.writeFileSync(named, `${base}\n`);
  try {
    const refused = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, GIT_GRAFT_FILE: named }) });
    assert.equal(refused.code, 1, "the graft file that git is told to read is the one that counts");
    assert.match(refused.stderr, /the target checkout has a graft file/);
    const absent = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, GIT_GRAFT_FILE: path.join(out, "no-such-grafts") }) });
    assert.equal(absent.code, 0, `a graft file that is not there is nothing: ${absent.stderr}`);
  } finally {
    fs.rmSync(named, { force: true });
  }
});

test("AC22: a change that is committed and then put back in the working tree is still reported: the commits are what the pull request carries", async () => {
  const forms = {
    "a bumped gh_aw_schema_version": { change: () => setVersion('"9.9.9"')(repo), file: "docs/_meta/registry.yaml", expected: "gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in the HEAD commit)" },
    "a recompiled workflow": { change: () => repo.write(".github/workflows/stand-in.lock.yml", "name: recompiled by the agent\n"), file: ".github/workflows/stand-in.lock.yml", expected: ".github/workflows/stand-in.lock.yml differs from the base commit" },
    "a deleted workflow": { change: () => repo.remove(".github/workflows/stand-in.lock.yml"), file: ".github/workflows/stand-in.lock.yml", expected: ".github/workflows/stand-in.lock.yml differs from the base commit" },
  };
  for (const [name, { change, file, expected }] of Object.entries(forms)) {
    change();
    repo.commitAll(name);
    repo.git("checkout", base, "--", file); // the index and the working tree are the base's again; the commit keeps the change
    try {
      assert.equal(repo.git("diff", "--name-only", base), "", `${name}: the working tree no longer differs from the base`);
      const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
      assert.equal(result.code, 1, `${name}\n${result.stdout}`);
      assert.ok(result.stderr.includes(expected), `${name}: ${result.stderr}`);
    } finally {
      restore();
    }
  }
});

test("AC22: commits that change neither the pinned version nor a workflow pass, however many there are and whatever else they edit", async () => {
  repo.write("labs/lab01.md", "A mechanical fix.\n");
  repo.commitAll("fix a lab file");
  repo.write("docs/_meta/registry.yaml", repo.read("docs/_meta/registry.yaml").replace('copilot_cli_version_floor: "1.0.82"', 'copilot_cli_version_floor: "1.0.99"'));
  repo.write("docs/_meta/audit-report.md", `${repo.read("docs/_meta/audit-report.md")}\nA note.\n`);
  repo.commitAll("update the registry and the report");
  try {
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    restore();
  }
});

test("AC22: every git call of the validator is made with --no-replace-objects", async () => {
  const trace = path.join(out, "git-trace2.jsonl");
  try {
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, GIT_TRACE2_EVENT: trace }) });
    assert.equal(result.code, 0, result.stderr);
    const starts = fs
      .readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "start");
    assert.ok(starts.length > 0, "the trace holds the git calls of the run");
    for (const { argv } of starts) assert.equal(argv[1], "--no-replace-objects", argv.join(" "));
  } finally {
    fs.rmSync(trace, { force: true });
  }
});

test("AC22: prepare-run appends the base commit to GITHUB_ENV, and the one line is all it adds there", async () => {
  const workspace = tempDir("sdlc-s2-export-");
  const checkout = createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") });
  const envFile = path.join(workspace, "github-env");
  fs.writeFileSync(envFile, "EXISTING=1\n");
  try {
    const result = await invoke(prepare, ["--out", path.join(workspace, "out")], { env: cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: "example-owner/example-target", GITHUB_ENV: envFile }), cwd: workspace });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(envFile, "utf8"), `EXISTING=1\nSDLC_BASE_SHA=${checkout.head()}\n`);
    assert.match(result.stdout, /exported as SDLC_BASE_SHA/);
    const unwritable = await invoke(prepare, ["--out", path.join(workspace, "out2")], { env: cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: "example-owner/example-target", GITHUB_ENV: path.join(workspace, "no-such-directory", "github-env") }), cwd: workspace });
    assert.equal(unwritable.code, 1, "a base commit that cannot be handed over stops the step before the agent starts");
    assert.match(unwritable.stderr, /cannot be exported to the later steps through GITHUB_ENV/);
    assert.equal(fs.existsSync(path.join(workspace, "out2")), false, "and nothing is left under --out");
    const outside = await invoke(prepare, ["--out", path.join(workspace, "out3")], { env: cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: "example-owner/example-target" }), cwd: workspace });
    assert.equal(outside.code, 0, "outside Actions there is no GITHUB_ENV and nothing to export to");
    assert.doesNotMatch(outside.stdout, /exported/);
  } finally {
    checkout.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("AC22: through the rendered steps, an agent that bumps the pinned version and forges run-context.json still fails the lab's post-step", { skip: BASH_SKIP }, async () => {
  const { frontmatter } = driftWorkflow("copilot-lab");
  const [prepareStep] = frontmatter["pre-agent-steps"];
  const [validator] = frontmatter["post-steps"];
  assert.match(prepareStep.run, /prepare-run\.mjs/);
  assert.equal(validator.run, 'node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs"');
  const lab = labFiles();
  for (const forge of [true, false]) {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: lab });
    try {
      gate.exported = {};
      const started = await gate.runSteps([prepareStep]);
      assert.equal(started.code, 0, started.log);
      assert.equal(gate.exported.SDLC_BASE_SHA, gate.baseSha, "the first step is what hands the base commit to the later steps");
      // the agent runs now, with the checkout and the artifact directory in its hands
      gate.write("docs/_meta/registry.yaml", lab["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"'));
      gate.git("add", "-A");
      gate.git("commit", "-q", "-m", "bump the pinned version");
      if (forge) gate.writeRunContext({ baseSha: gate.git("rev-parse", "HEAD") });
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, `forged: ${forge}\n${finished.log}`);
      assert.ok(finished.log.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), finished.log);
    } finally {
      gate.cleanup();
    }
  }
  const honest = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: lab });
  try {
    honest.exported = {};
    assert.equal((await honest.runSteps([prepareStep])).code, 0);
    honest.write("labs/lab01.md", "A mechanical fix.\n");
    honest.git("add", "-A");
    honest.git("commit", "-q", "-m", "mechanical fix");
    const passed = await honest.runSteps([validator]);
    assert.equal(passed.code, 0, `the chain itself works: ${passed.log}`);
  } finally {
    honest.cleanup();
  }
});

test("AC22: through the rendered steps, an agent that commits a bump of the pinned version and then plants a replace ref, or puts its working tree back, still fails the lab's post-step", { skip: BASH_SKIP }, async () => {
  const { frontmatter } = driftWorkflow("copilot-lab");
  const [prepareStep] = frontmatter["pre-agent-steps"];
  const [validator] = frontmatter["post-steps"];
  const lab = labFiles();
  const bumped = lab["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"');
  const forgeries = {
    "git replace <base> HEAD": (gate) => gate.git("replace", gate.baseSha, "HEAD"),
    "the working tree put back": (gate) => gate.git("checkout", gate.baseSha, "--", "docs/_meta/registry.yaml"),
  };
  for (const [name, forge] of Object.entries(forgeries)) {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: lab });
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      gate.write("docs/_meta/registry.yaml", bumped);
      gate.git("add", "-A");
      gate.git("commit", "-q", "-m", "bump the pinned version");
      forge(gate);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, `${name}\n${finished.log}`);
      assert.ok(finished.log.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), `${name}\n${finished.log}`);
    } finally {
      gate.cleanup();
    }
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
