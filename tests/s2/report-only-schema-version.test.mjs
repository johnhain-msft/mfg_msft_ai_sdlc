// AC22: gh_aw_schema_version is report-only for the lab. The validator exits non-zero, so that post-steps exit 1, when anything that a pull
// request could be made of differs from the recorded base commit in gh_aw_schema_version or touches anything under .github/workflows/; and
// exclude-lock-yml: true and protected-files with policy "blocked" stay as AC2 renders them, with no exclude entry that covers
// .github/workflows/. The base commit is the one that prepare-run, the first step of the job, hands to the later steps through
// GITHUB_ENV (SDLC_BASE_SHA); it is never read from run-context.json, which the agent can edit. Nor does anything else that the agent can
// write in the checkout decide what the rule compares: a replace ref (`git replace <base> HEAD`), a graft file, and a change that is
// committed and then put back in the working tree are tested here too. What a pull request is made of is not HEAD: the patch and the
// bundle that create_pull_request wrote under /tmp/gh-aw during the agent step, and the commits on any ref, are tested below ("after the agent
// switched back"). The agent can also configure the checkout so that git starts a program of its choosing while the validator reads it (a clean
// filter, core.fsmonitor, a post-index-change hook), which could move the patch out of the way before it is read: that no program of the checkout
// runs inside the validator, and that no git process of the validator runs in the checkout's repository, is tested at the end of this file.
// That the validator's own files cannot be rewritten is tested in validator-integrity.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { openScratch } from "../../src/drift/lib/git-artifacts.mjs";
import { changedPaths, pinnedValueAt, run } from "../../src/validate-copilot-lab-audit.mjs";
import { DRIFT_KEYS, driftWorkflow, forceRemove, tempDir, writeTree } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo, git as gitIn, writeGitFixtureConfig } from "./helpers/git-fixture.mjs";
import { labFiles, withoutSection, withoutTopLevelKey } from "./helpers/lab-fixture.mjs";
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

test("AC22: every git call of the validator is made with --no-replace-objects, and with the fsmonitor program and the hooks of the checkout switched off", async () => {
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
    for (const { argv } of starts) {
      assert.equal(argv[1], "--no-replace-objects", argv.join(" "));
      const settings = argv.flatMap((argument, at) => (argv[at - 1] === "-c" ? [argument] : []));
      assert.deepEqual(settings, ["core.fsmonitor=false", "core.hooksPath=/dev/null"], `${argv.join(" ")}: no fsmonitor program, no hooks directory`);
      assert.ok(argv.includes("--no-pager"), argv.join(" "));
    }
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
  assert.match(validator.run, /node "\$GITHUB_WORKSPACE\/src\/validate-copilot-lab-audit\.mjs" \)$/);
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

// --- after the agent switched back: what a pull request is made of is not HEAD -------------------------------------------------------------
//
// In gh-aw v1.0.1 the create_pull_request tool writes /tmp/gh-aw/aw-<branch>.patch (git format-patch of <base>..<branch>, with an
// X-GH-AW-Base-Commit header after its first line) and, for the bundle transport, /tmp/gh-aw/aw-<branch>.bundle while the agent is still
// running; the agent job uploads those files and the safe_outputs job applies them whatever HEAD is by then. An agent can therefore commit a
// forbidden change on a branch, call the tool, and `git switch` back to the base commit: HEAD, the index and the working tree are the base's again.

/** The file name that gh-aw gives the patch or the bundle of a branch (sanitizeForFilename of git_patch_utils.cjs). */
const transportName = (branch, extension) => `aw-${branch.replace(/[/\\:*?"<>|]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").toLowerCase()}.${extension}`;

/** /tmp/gh-aw and /tmp/gh-aw/agent of a job: the artifact directory is the `agent` directory below the one that holds the patches and the bundles. */
function artifactDirectories() {
  const root = tempDir("sdlc-s2-artifacts-");
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent);
  return { root, agent };
}

/** Writes what create_pull_request writes for a branch: the patch, and with `bundle` the bundle too. */
function createPullRequest(directory, branch, { patch = true, bundle = false } = {}) {
  if (patch) {
    const [first, ...rest] = `${repo.git("format-patch", `${base}..${branch}`, "--stdout")}\n`.split("\n");
    fs.writeFileSync(path.join(directory, transportName(branch, "patch")), [first, `X-GH-AW-Base-Commit: ${base}`, ...rest].join("\n"));
  }
  if (bundle) repo.git("bundle", "create", path.join(directory, transportName(branch, "bundle")), `${base}..${branch}`);
}

/**
 * The agent's way of leaving: it commits `change` (a function of the checkout) on a new branch, calls create_pull_request, and switches back to the
 * branch that it started on. `keepBranch: false` deletes the branch and its reflog as well, so that only the files that the tool wrote are left.
 * Returns the result of the validator, run against the recorded base commit, with `observed`: what `observe(root)` saw right after the run (before
 * anything else touches the checkout, so that a program that the agent configured there has not had a second chance). `before(root)` is what the agent
 * does last, `finish(root)` undoes it before the checkout is put back, and `env` (an object, or a function of the artifact directory) is added to the
 * environment of the validator.
 */
async function afterTheAgentSwitchedBack({ change, branch = "sdlc/x", patch = true, bundle = false, keepBranch = true, before: prepareMore = () => {}, observe = () => undefined, finish = () => {}, env = {}, args = [] }) {
  const { root, agent } = artifactDirectories();
  const origin = repo.git("rev-parse", "--abbrev-ref", "HEAD");
  try {
    repo.git("switch", "-q", "-c", branch);
    change(repo);
    repo.commitAll(`change on ${branch}`);
    createPullRequest(root, branch, { patch, bundle });
    repo.git("switch", "-q", origin);
    if (!keepBranch) {
      repo.git("branch", "-q", "-D", branch);
      repo.git("reflog", "expire", "--expire=now", "--all");
    }
    assert.equal(repo.head(), base, "HEAD is the base commit again");
    assert.equal(repo.git("diff", "--name-only", base), "", "and so are the index and the working tree: a validator that looks at HEAD sees nothing");
    prepareMore(root);
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent, ...args], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, ...(typeof env === "function" ? env(root) : env) }) });
    return { ...result, observed: observe(root) };
  } finally {
    finish(root);
    repo.git("switch", "-q", origin);
    if (repo.git("branch", "--list", branch) !== "") repo.git("branch", "-q", "-D", branch);
    restore();
    forceRemove(root);
  }
}

const bump = (checkout) => setVersion('"9.9.9"')(checkout);
const recompile = (checkout) => checkout.write(".github/workflows/stand-in.lock.yml", "name: recompiled by the agent\n");

test("AC22: an agent that commits a bump on a branch, calls create_pull_request and switches back does not get past the rule: the branch and the patch are read", async () => {
  const result = await afterTheAgentSwitchedBack({ change: bump });
  assert.equal(result.code, 1, result.stdout);
  assert.ok(result.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), result.stderr);
  assert.match(result.stderr, /commit [0-9a-f]{12} \(refs\/heads\/sdlc\/x\)/, "the commit that only a branch names is read");
  assert.ok(result.stderr.includes("aw-sdlc-x.patch (patch 1 of 1)"), "and so is the patch that the tool wrote");
});

test("AC22: with the branch and its reflog gone, the patch that the tool wrote still carries the change, and it is the patch that is named", async () => {
  const bumped = await afterTheAgentSwitchedBack({ change: bump, keepBranch: false });
  assert.equal(bumped.code, 1, bumped.stdout);
  assert.ok(bumped.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in aw-sdlc-x.patch (patch 1 of 1))"), bumped.stderr);
  assert.equal(bumped.stderr.includes("refs/heads/sdlc/x"), false, "there is no branch left to name");
  const recompiled = await afterTheAgentSwitchedBack({ change: recompile, keepBranch: false });
  assert.equal(recompiled.code, 1, recompiled.stdout);
  assert.ok(recompiled.stderr.includes(".github/workflows/stand-in.lock.yml differs from the base commit"), recompiled.stderr);
  assert.ok(recompiled.stderr.includes("(in aw-sdlc-x.patch (patch 1 of 1))"), recompiled.stderr);
  const removed = await afterTheAgentSwitchedBack({ change: (checkout) => checkout.remove(".github/workflows/stand-in.lock.yml"), keepBranch: false });
  assert.equal(removed.code, 1, "a deleted workflow is a change too");
  assert.ok(removed.stderr.includes(".github/workflows/stand-in.lock.yml differs from the base commit"), removed.stderr);
});

test("AC22: the same holds for the bundle of the bundle transport, with or without a patch beside it", async () => {
  for (const patch of [true, false]) {
    const bumped = await afterTheAgentSwitchedBack({ change: bump, patch, bundle: true, keepBranch: false });
    assert.equal(bumped.code, 1, `patch beside it: ${patch}\n${bumped.stdout}`);
    assert.match(bumped.stderr, /gh_aw_schema_version changed from '0\.86\.2' to '9\.9\.9'; it is report-only \(in .*aw-sdlc-x\.bundle \(commit [0-9a-f]{12}\)/);
    const recompiled = await afterTheAgentSwitchedBack({ change: recompile, patch, bundle: true, keepBranch: false });
    assert.equal(recompiled.code, 1, `patch beside it: ${patch}\n${recompiled.stdout}`);
    assert.match(recompiled.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit [0-9a-f]{12}; .*\(in .*aw-sdlc-x\.bundle \(commit [0-9a-f]{12}\)/);
  }
});

test("AC22: a patch is read message by message: a change that a later commit of the same patch puts back is still named, because the pull request carries both commits", async () => {
  const { root, agent } = artifactDirectories();
  const origin = repo.git("rev-parse", "--abbrev-ref", "HEAD");
  try {
    repo.git("switch", "-q", "-c", "sdlc/x");
    bump(repo);
    repo.commitAll("bump");
    repo.git("checkout", base, "--", "docs/_meta/registry.yaml");
    repo.commitAll("put it back");
    createPullRequest(root, "sdlc/x");
    repo.git("switch", "-q", origin);
    repo.git("branch", "-q", "-D", "sdlc/x");
    repo.git("reflog", "expire", "--expire=now", "--all");
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in aw-sdlc-x.patch (patch 1 of 2))"), result.stderr);
    assert.equal(result.stderr.includes("patch 2 of 2"), false, "the second message leaves the base's value and is not named");
  } finally {
    repo.git("switch", "-q", origin);
    restore();
    forceRemove(root);
  }
});

test("AC22: a patch, a bundle and a branch that change neither the version nor a workflow pass, and the run says what it inspected", async () => {
  const mechanical = (checkout) => {
    checkout.write("labs/lab01.md", "A mechanical fix.\n");
    checkout.write("docs/_meta/registry.yaml", checkout.read("docs/_meta/registry.yaml").replace('copilot_cli_version_floor: "1.0.82"', 'copilot_cli_version_floor: "1.0.99"'));
    checkout.write("docs/_meta/audit-report.md", `${checkout.read("docs/_meta/audit-report.md")}\nA note.\n`);
  };
  const result = await afterTheAgentSwitchedBack({ change: mechanical, bundle: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /unchanged since [0-9a-f]{12}; 1 commit, 1 patch file, 1 bundle file of what a pull request could be made of also inspected\)/);
});

test("AC22: a patch or a bundle that cannot be read, or that does not apply to the base commit, fails the run: a file that cannot be inspected is not a file that is fine", async () => {
  const garbage = await afterTheAgentSwitchedBack({ change: bump, keepBranch: false, before: (root) => fs.writeFileSync(path.join(root, transportName("sdlc/x", "patch")), "this is not a patch\n") });
  assert.equal(garbage.code, 1, garbage.stdout);
  assert.match(garbage.stderr, /aw-sdlc-x\.patch cannot be inspected: .*corrupt mailbox/);
  const empty = await afterTheAgentSwitchedBack({ change: bump, keepBranch: false, before: (root) => fs.writeFileSync(path.join(root, transportName("sdlc/x", "patch")), "") });
  assert.equal(empty.code, 1, "an empty file is not a patch either");
  assert.match(empty.stderr, /aw-sdlc-x\.patch cannot be inspected: it is empty/);
  const moved = await afterTheAgentSwitchedBack({
    change: bump,
    keepBranch: false,
    before: (root) => {
      const file = path.join(root, transportName("sdlc/x", "patch"));
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('-gh_aw_schema_version: "0.86.2"', '-gh_aw_schema_version: "0.70.0"'));
    },
  });
  assert.equal(moved.code, 1, "a patch whose lines are not the base commit's lines does not apply");
  assert.match(moved.stderr, /aw-sdlc-x\.patch cannot be inspected: its message 1 of 1 does not apply to the base commit/);
  const foreign = createRepo(labFiles());
  const { root, agent } = artifactDirectories();
  try {
    foreign.write("labs/foreign.md", "A commit that the checkout does not have.\n");
    const middle = foreign.commitAll("a base of its own");
    foreign.write("labs/lab01.md", "A lab file.\n");
    foreign.commitAll("change");
    foreign.git("branch", "-f", "foreign-tip");
    foreign.git("bundle", "create", path.join(root, "aw-foreign.bundle"), `${middle}..foreign-tip`);
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, "a bundle that builds on commits that the checkout does not have");
    assert.match(result.stderr, /aw-foreign\.bundle cannot be inspected: .*prerequisite/i);
  } finally {
    foreign.cleanup();
    forceRemove(root);
  }
});

test("AC22: only aw-*.patch and aw-*.bundle files next to the artifact directory are read, and a missing directory is nothing to read", async () => {
  const { root, agent } = artifactDirectories();
  try {
    fs.writeFileSync(path.join(root, "notes.patch"), "not a patch\n");
    fs.writeFileSync(path.join(root, "aw-prompts.txt"), "not a patch\n");
    fs.writeFileSync(path.join(agent, "aw-inside.patch"), "not a patch, and not in the directory that is read\n");
    const ignored = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(ignored.code, 0, ignored.stderr);
    const missing = await invoke(run, ["--checkout", repo.dir, "--out", path.join(root, "no-such-directory", "agent")], { cwd: out, env: withBase(base) });
    assert.equal(missing.code, 0, missing.stderr);
    fs.writeFileSync(path.join(root, "aw-x.patch"), "not a patch\n");
    const read = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(read.code, 1, "aw-*.patch is read");
  } finally {
    forceRemove(root);
  }
});

test("AC22: a commit that no ref, no patch and no bundle carries is nothing that a pull request can be made of", async () => {
  const { root, agent } = artifactDirectories();
  try {
    bump(repo);
    repo.git("add", "-A");
    const dangling = repo.git("commit-tree", repo.git("write-tree"), "-p", base, "-m", "dangling");
    assert.equal(repo.git("cat-file", "-t", dangling), "commit");
    repo.git("reset", "-q", "--hard", base);
    assert.equal(repo.git("branch", "--contains", dangling), "", "no branch has it");
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    restore();
    forceRemove(root);
  }
});

test("AC23: the registry and the audit report are read at the tip of the branch and in the patch as well as in the working tree: a good file in the tree does not hide a bad one in the commit", async () => {
  const broken = (checkout) => {
    checkout.write("docs/_meta/registry.yaml", withoutTopLevelKey(checkout.read("docs/_meta/registry.yaml"), "labs"));
    checkout.write("docs/_meta/audit-report.md", withoutSection(checkout.read("docs/_meta/audit-report.md"), "Summary"));
  };
  const onBranch = await afterTheAgentSwitchedBack({ change: broken });
  assert.equal(onBranch.code, 1, onBranch.stdout);
  assert.match(onBranch.stderr, /docs\/_meta\/registry\.yaml is missing the top-level key 'labs' \(in commit [0-9a-f]{12} \(refs\/heads\/sdlc\/x\)\)/);
  assert.match(onBranch.stderr, /docs\/_meta\/audit-report\.md is missing the section '## Summary' \(in commit [0-9a-f]{12} \(refs\/heads\/sdlc\/x\)\)/);
  assert.match(onBranch.stderr, /docs\/_meta\/registry\.yaml is missing the top-level key 'labs' \(in aw-sdlc-x\.patch \(patch 1 of 1\)\)/, "and in the patch of the same commit");
  const inBundle = await afterTheAgentSwitchedBack({ change: broken, patch: false, bundle: true, keepBranch: false });
  assert.equal(inBundle.code, 1, inBundle.stdout);
  assert.match(inBundle.stderr, /docs\/_meta\/registry\.yaml is missing the top-level key 'labs' \(in aw-sdlc-x\.bundle \(commit [0-9a-f]{12}\)\)/);
  const untracked = await afterTheAgentSwitchedBack({ change: broken, keepBranch: false });
  assert.equal(untracked.code, 1, "the working tree has the base's valid files, and that is not what the patch carries");
  const spoofed = await afterTheAgentSwitchedBack({
    change: broken,
    keepBranch: false,
    before: () => repo.write("docs/_meta/audit-report.md", `${repo.read("docs/_meta/audit-report.md")}\nA spoof in the working tree.\n`),
  });
  assert.equal(spoofed.code, 1, "nor does a good file left in the working tree");
  assert.match(spoofed.stderr, /\(in aw-sdlc-x\.patch \(patch 1 of 1\)\)/);
});

test("AC23: a self-improvement report with a missing section in the commit is named, whatever the working tree holds", async () => {
  const result = await afterTheAgentSwitchedBack({
    change: (checkout) => checkout.write("docs/_meta/self-improvement-report.md", "## Summary\n\n## Findings\n"),
    keepBranch: false,
    args: ["--self-improve"],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /docs\/_meta\/self-improvement-report\.md is missing the section '## Consolidation Candidates' \(in aw-sdlc-x\.patch \(patch 1 of 1\)\)/);
  assert.equal(result.stderr.includes("is missing the section '## Consolidation Candidates' (in commit"), false, "the branch is gone, so only the patch names it");
});

/** Every file of the .git directory of the shared checkout with its size and modification time: what a read of the checkout must leave as it was. */
function gitDirectoryListing() {
  const found = [];
  const stack = [path.join(repo.dir, ".git")];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory()) stack.push(entry);
      else found.push(`${path.relative(repo.dir, entry)}:${stat.size}:${stat.mtimeMs}`);
    }
  }
  return found.sort().join("\n");
}

test("AC22: reading the patches and the bundles writes nothing in the checkout and leaves no scratch repository behind", async () => {
  const listing = gitDirectoryListing;
  const { root, agent } = artifactDirectories();
  // the scratch repository goes where os.tmpdir() says; a directory of this test makes it visible, and the other tests of the process unaffected
  const scratchRoot = tempDir("sdlc-s2-scratch-root-");
  const saved = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]));
  const origin = repo.git("rev-parse", "--abbrev-ref", "HEAD");
  try {
    repo.git("switch", "-q", "-c", "sdlc/x");
    bump(repo);
    repo.commitAll("bump");
    createPullRequest(root, "sdlc/x", { bundle: true });
    repo.git("switch", "-q", origin);
    const untouched = listing();
    for (const name of Object.keys(saved)) process.env[name] = scratchRoot;
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /aw-sdlc-x\.bundle \(commit [0-9a-f]{12}\)/, "the run did read the bundle, so the scratch repository existed");
    assert.equal(listing(), untouched, "nothing in .git changed: not an object, not the index, not a ref");
    assert.equal(repo.status(), "");
    assert.deepEqual(fs.readdirSync(scratchRoot), [], "the scratch repository in the temporary directory is removed");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    repo.git("switch", "-q", origin);
    repo.git("branch", "-q", "-D", "sdlc/x");
    restore();
    forceRemove(root);
  }
});

test("AC22: through the rendered steps, an agent that commits a bump, calls create_pull_request (the patch) and switches back still fails the lab's post-step", { skip: BASH_SKIP }, async () => {
  const { frontmatter } = driftWorkflow("copilot-lab");
  const [prepareStep] = frontmatter["pre-agent-steps"];
  const [validator] = frontmatter["post-steps"];
  const lab = labFiles();
  const bumped = lab["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"');
  for (const keepBranch of [true, false]) {
    const gate = createGateWorkspace({ checkoutName: "day-in-the-life-copilot-lab", files: lab });
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      const origin = gate.git("rev-parse", "--abbrev-ref", "HEAD");
      // the agent: commit on a branch, call create_pull_request (the tool writes the patch under /tmp/gh-aw, which is gate.artifacts here), go back
      gate.git("switch", "-q", "-c", "sdlc/x");
      gate.write("docs/_meta/registry.yaml", bumped);
      gate.git("add", "-A");
      gate.git("commit", "-q", "-m", "bump the pinned version");
      const [first, ...rest] = `${gate.git("format-patch", `${gate.baseSha}..sdlc/x`, "--stdout")}\n`.split("\n");
      fs.writeFileSync(path.join(gate.artifacts, "aw-sdlc-x.patch"), [first, `X-GH-AW-Base-Commit: ${gate.baseSha}`, ...rest].join("\n"));
      gate.git("switch", "-q", origin);
      if (!keepBranch) {
        gate.git("branch", "-q", "-D", "sdlc/x");
        gate.git("reflog", "expire", "--expire=now", "--all");
      }
      assert.equal(gate.git("rev-parse", "HEAD"), gate.baseSha, "HEAD is the base commit");
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, `branch kept: ${keepBranch}\n${finished.log}`);
      assert.ok(finished.log.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only"), finished.log);
      assert.ok(finished.log.includes("aw-sdlc-x.patch (patch 1 of 1)"), finished.log);
    } finally {
      gate.cleanup();
    }
  }
});

// --- what the agent configured in the checkout does not run inside the validator ---------------------------------------------------------------
//
// The agent has `git` with any arguments, so it can write .git/config, .git/info/attributes and .git/hooks of the checkout, and the validator then
// runs git there, on the host. A `core.fsmonitor` program, a `filter.<name>.clean` command that an attribute selects and a post-index-change hook are
// programs that git starts by itself while it reads the index or the working tree. One that runs inside the validator can move the patch that
// create_pull_request wrote out of the way before the validator lists the directory and put it back afterwards, so that the check passes and the pull
// request still carries the change. The programs of these tests do the first part: each leaves a line in a trace file and renames the patch. They must
// not run, and the validator must read the patch and name the change. (Each test below fails against the validator before this change: it ran them.)

const slash = (file) => file.replace(/\\/g, "/");
const gitDirectoryFile = (...parts) => path.join(repo.dir, ".git", ...parts);
/** The tracked file of the lab fixture that the filters and the touched index entries are about. */
const TRACKED = "package.json";
const WORKFLOW = ".github/workflows/stand-in.lock.yml";
const PATCH_NAMED = "gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in aw-sdlc-x.patch (patch 1 of 1))";
/** What the programs left: nothing ran, and the patch is where the tool wrote it. */
const NOTHING_RAN = { ran: "", patchInPlace: true, hidden: false };
/** The environment of a job's step does not switch fsmonitor off for every git call, as the runner of this suite does (GIT_CONFIG_COUNT in its environment). */
const WITHOUT_ENV_CONFIG = { GIT_CONFIG_COUNT: "0" };

/** Remembers .git/config and .git/info/attributes; the function that it returns puts them back and removes the hook that a test wrote. */
function saveGitDirectory() {
  const files = ["config", "info/attributes"].map((name) => {
    const file = gitDirectoryFile(...name.split("/"));
    return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
  });
  return () => {
    for (const [file, content] of files) {
      if (content === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content);
    }
    fs.rmSync(gitDirectoryFile("hooks", "post-index-change"), { force: true });
  };
}

/** Where the programs of a test leave their trace, and where the patch that they would move is. */
const programPaths = (root) => ({ trace: path.join(root, "agent-programs-ran.txt"), patch: path.join(root, transportName("sdlc/x", "patch")) });

/** Writes the two programs, a clean filter (which copies its input) and a hook (which says nothing), and returns the command that starts each. */
function writePrograms(root) {
  const { trace, patch } = programPaths(root);
  const program = (name, passThrough) => {
    const file = path.join(root, name);
    const source = ['import fs from "node:fs";', "const [trace, patch] = process.argv.slice(2);", 'fs.appendFileSync(trace, "ran\\n");', 'if (fs.existsSync(patch)) fs.renameSync(patch, patch + ".hidden");'];
    if (passThrough) source.push("process.stdin.pipe(process.stdout);");
    fs.writeFileSync(file, `${source.join("\n")}\n`);
    return `node ${slash(file)} ${slash(trace)} ${slash(patch)}`;
  };
  return { filter: program("filter-program.mjs", true), hook: program("hook-program.mjs", false) };
}

/** What the programs did, read right after the validator ran: what they traced, and whether the patch is where the tool wrote it. */
function whatTheProgramsDid(root) {
  const { trace, patch } = programPaths(root);
  return { ran: fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "", patchInPlace: fs.existsSync(patch), hidden: fs.existsSync(`${patch}.hidden`) };
}

/** Makes the entry of a tracked file in the index differ from the file's stat, so that a `git diff` refreshes the index and writes it. */
function touch(relative) {
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(repo.dir, ...relative.split("/")), later, later);
}

test("AC22: a clean filter that the agent configured in the checkout, and selected in .git/info/attributes or in a .gitattributes of the working tree, does not run inside the validator: the patch that it would have moved is read", async () => {
  const forms = {
    ".git/info/attributes": () => {
      fs.mkdirSync(gitDirectoryFile("info"), { recursive: true });
      fs.appendFileSync(gitDirectoryFile("info", "attributes"), `${TRACKED} filter=x\n`);
    },
    ".gitattributes of the working tree": () => repo.write(".gitattributes", `${TRACKED} filter=x\n`),
  };
  for (const [name, select] of Object.entries(forms)) {
    const putBack = saveGitDirectory();
    const result = await afterTheAgentSwitchedBack({
      change: bump,
      keepBranch: false,
      before: (root) => {
        repo.git("config", "filter.x.clean", writePrograms(root).filter);
        select();
        repo.write(TRACKED, `${repo.read(TRACKED)}\n`); // a modified file: git has to hash it, and a clean filter runs then
      },
      observe: whatTheProgramsDid,
      finish: putBack,
    });
    assert.equal(result.code, 1, `${name}\n${result.stdout}${result.stderr}`);
    assert.ok(result.stderr.includes(PATCH_NAMED), `${name}: ${result.stderr}`);
    assert.match(result.stderr, /sets 'filter\.x\.clean'/, `${name}: the configuration that names the program is named as well`);
    assert.deepEqual(result.observed, NOTHING_RAN, `${name}: no program of the agent ran, and the patch is where the tool wrote it`);
  }
});

test("AC22: an fsmonitor program that the agent configured in the checkout does not run inside the validator, whichever git command reads the index", async () => {
  const putBack = saveGitDirectory();
  const result = await afterTheAgentSwitchedBack({
    change: bump,
    keepBranch: false,
    before: (root) => repo.git("config", "core.fsmonitor", writePrograms(root).hook),
    observe: whatTheProgramsDid,
    finish: putBack,
    env: WITHOUT_ENV_CONFIG,
  });
  assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
  assert.ok(result.stderr.includes(PATCH_NAMED), result.stderr);
  assert.match(result.stderr, /sets 'core\.fsmonitor'/);
  assert.deepEqual(result.observed, NOTHING_RAN);
});

test("AC22: a post-index-change hook that the agent wrote in the checkout, in .git/hooks or in a directory that core.hooksPath names, does not run inside the validator", async () => {
  const writeHook = (directory, command) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "post-index-change"), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
  };
  const forms = {
    ".git/hooks": (root, command) => writeHook(gitDirectoryFile("hooks"), command),
    "core.hooksPath": (root, command) => {
      writeHook(path.join(root, "agent-hooks"), command);
      repo.git("config", "core.hooksPath", path.join(root, "agent-hooks"));
    },
  };
  for (const [name, install] of Object.entries(forms)) {
    const putBack = saveGitDirectory();
    const result = await afterTheAgentSwitchedBack({
      change: bump,
      keepBranch: false,
      before: (root) => {
        install(root, writePrograms(root).hook);
        touch(TRACKED); // the entry of the index no longer matches the file's stat: a `git diff` there writes the index, and git then runs the hook
      },
      observe: whatTheProgramsDid,
      finish: putBack,
    });
    assert.equal(result.code, 1, `${name}\n${result.stdout}${result.stderr}`);
    assert.ok(result.stderr.includes(PATCH_NAMED), `${name}: ${result.stderr}`);
    assert.deepEqual(result.observed, NOTHING_RAN, `${name}: the hook did not run, and the patch is where the tool wrote it`);
  }
});

test("AC22: nor does a program of the global configuration or of the global attributes, which the agent could write if the agent step can write the home directory of the runner", async () => {
  const home = tempDir("sdlc-s2-agent-home-");
  const result = await afterTheAgentSwitchedBack({
    change: bump,
    keepBranch: false,
    before: (root) => {
      const programs = writePrograms(root);
      fs.mkdirSync(path.join(home, "xdg", "git"), { recursive: true });
      fs.writeFileSync(path.join(home, "gitconfig"), `[filter "g"]\n\tclean = ${programs.filter}\n[core]\n\tfsmonitor = ${programs.hook}\n`);
      fs.writeFileSync(path.join(home, "xdg", "git", "attributes"), `${TRACKED} filter=g\n`);
      repo.write(TRACKED, `${repo.read(TRACKED)}\n`);
    },
    env: () => ({ ...WITHOUT_ENV_CONFIG, GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), XDG_CONFIG_HOME: path.join(home, "xdg") }),
    observe: whatTheProgramsDid,
  });
  assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
  assert.ok(result.stderr.includes(PATCH_NAMED), result.stderr);
  assert.deepEqual(result.observed, NOTHING_RAN, "the global filter and the global fsmonitor program did not run");
  assert.doesNotMatch(result.stderr, /sets '/, "the global configuration is the runner's, not the checkout's: the refusal is about the checkout's own");
});

test("AC22: which keys of the checkout's own configuration are a program for git to run: fsmonitor, a clean, smudge or process filter, an external diff and a textconv; not a false value, not another key, not the configuration of the runner", () => {
  const checkout = createRepo({ "README.md": "target\n" });
  const elsewhere = tempDir("sdlc-s2-config-scopes-");
  const globalFile = path.join(elsewhere, "gitconfig");
  fs.writeFileSync(globalFile, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n[core]\n\tfsmonitor = node global-hook.mjs\n[diff]\n\texternal = global-diff\n');
  const environment = (extra = {}) => cleanEnv({ GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: globalFile, ...extra });
  const listed = (extra) => {
    const scratch = openScratch({ checkout: checkout.dir, env: environment(extra), fs });
    try {
      return scratch.configuration.commandKeys;
    } finally {
      scratch.dispose();
    }
  };
  try {
    assert.deepEqual(listed(), [], "the global configuration (and the system one, which a runner image fills with filter.lfs) is not the checkout's");
    assert.deepEqual(
      listed({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "node from-the-environment.mjs", GIT_CONFIG_KEY_1: "filter.e.clean", GIT_CONFIG_VALUE_1: "cat" }),
      [],
      "nor is the environment of the step",
    );
    for (const [key, value] of [
      ["core.fsmonitor", "node hook.mjs"],
      ["core.fsmonitor", "true"],
      ["filter.x.clean", "cat"],
      ["filter.X.y.smudge", "cat"],
      ["filter.x.process", "git-lfs filter-process"],
      ["diff.external", "difftool"],
      ["diff.x.command", "difftool"],
      ["diff.x.textconv", "cat"],
    ]) {
      checkout.git("config", key, value);
      assert.deepEqual(listed(), [{ scope: "local", key }], `${key} = ${value}`);
      checkout.git("config", "--unset", key);
    }
    fs.appendFileSync(path.join(checkout.dir, ".git", "config"), "[core]\n\tfsmonitor\n");
    assert.deepEqual(listed(), [{ scope: "local", key: "core.fsmonitor" }], "a key without a value is true, which starts the built-in daemon");
    checkout.git("config", "--unset", "core.fsmonitor");
    for (const value of ["false", "no", "off", "0", ""]) {
      checkout.git("config", "core.fsmonitor", value);
      assert.deepEqual(listed(), [], `core.fsmonitor = '${value}' switches the program off`);
    }
    checkout.git("config", "--unset", "core.fsmonitor");
    for (const [key, value] of [
      ["filter.x.required", "true"],
      ["diff.x.binary", "true"],
      ["core.hooksPath", "hooks"],
      ["core.worktree", "."],
      ["remote.origin.url", "https://example.invalid/target.git"],
      ["http.https://example.invalid/.extraheader", "AUTHORIZATION: basic fixture"],
      ["user.name", "Fixture"],
    ]) {
      checkout.git("config", key, value);
      assert.deepEqual(listed(), [], `${key} names no program`);
      checkout.git("config", "--unset", key);
    }
    fs.writeFileSync(path.join(checkout.dir, ".git", "included.cfg"), '[filter "y"]\n\tsmudge = cat\n');
    checkout.git("config", "include.path", "included.cfg");
    assert.deepEqual(listed(), [{ scope: "local", key: "filter.y.smudge" }], "a program that the checkout's configuration includes is the checkout's own");
  } finally {
    checkout.cleanup();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("AC22: a checkout whose own configuration names such a program is refused, as one with a replace ref or a graft file is, and the refusal says which key", async () => {
  for (const [key, value] of [
    ["core.fsmonitor", "node -e 0"],
    ["filter.x.clean", "cat"],
    ["diff.x.textconv", "cat"],
  ]) {
    repo.git("config", key, value);
    try {
      const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, ...WITHOUT_ENV_CONFIG }) });
      assert.equal(result.code, 1, `${key}\n${result.stdout}`);
      assert.match(result.stderr, new RegExp(`the configuration of the target checkout \\(local\\) sets '${key.replace(/\./g, "\\.")}', a program that git would run while it reads the index or the working tree`), key);
    } finally {
      repo.git("config", "--unset", key);
    }
  }
  repo.git("config", "core.fsmonitor", "false");
  try {
    const switchedOff = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base, ...WITHOUT_ENV_CONFIG }) });
    assert.equal(switchedOff.code, 0, `a program that is switched off is nothing: ${switchedOff.stderr}`);
  } finally {
    repo.git("config", "--unset", "core.fsmonitor");
  }
});

test("AC22: what the checkout's index and settings say decides nothing about what the working tree is compared with: assume-unchanged, skip-worktree and a core.worktree that names a pristine copy do not hide a rewritten workflow", async () => {
  const forms = {
    "assume-unchanged": { set: () => repo.git("update-index", "--assume-unchanged", WORKFLOW), unset: () => repo.git("update-index", "--no-assume-unchanged", WORKFLOW) },
    "skip-worktree": { set: () => repo.git("update-index", "--skip-worktree", WORKFLOW), unset: () => repo.git("update-index", "--no-skip-worktree", WORKFLOW) },
    "a core.worktree that names a pristine copy": {
      set: () => {
        const decoy = tempDir("sdlc-s2-decoy-worktree-");
        writeTree(decoy, labFiles());
        repo.git("config", "core.worktree", decoy);
      },
      unset: () => repo.git("config", "--unset", "core.worktree"),
    },
  };
  for (const [name, form] of Object.entries(forms)) {
    form.set();
    repo.write(WORKFLOW, "name: rewritten by the agent\n");
    try {
      const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: cleanEnv({ SDLC_BASE_SHA: base }) });
      assert.equal(result.code, 1, `${name}\n${result.stdout}`);
      assert.match(result.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit [0-9a-f]{12}; .*\(in the working tree\)/, name);
    } finally {
      form.unset();
      restore();
    }
  }
});

test("AC22: a change that is staged and then put back in the working tree is still reported, through the index", async () => {
  repo.write(WORKFLOW, "name: staged by the agent\n");
  repo.git("add", WORKFLOW);
  repo.write(WORKFLOW, labFiles()[WORKFLOW]); // the working tree is the base's again; the index is not
  try {
    assert.equal(repo.git("diff", "--name-only", base), "", "a comparison of the working tree sees nothing");
    const result = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit [0-9a-f]{12}; .*\(in the index\)/);
  } finally {
    restore();
  }
});

test("AC22: the checkout is only read: a stat-dirty index is neither refreshed nor rewritten, nothing else in .git changes, and the scratch repository of every run is removed, whether the run passes or fails", async () => {
  const scratchRoot = tempDir("sdlc-s2-scratch-root-");
  const saved = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]));
  touch(TRACKED);
  try {
    const untouched = gitDirectoryListing();
    for (const name of Object.keys(saved)) process.env[name] = scratchRoot;
    const passes = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(passes.code, 0, passes.stderr);
    assert.equal(gitDirectoryListing(), untouched, "a run that passes changes nothing in .git: the index is not refreshed, and no hook runs");
    assert.deepEqual(fs.readdirSync(scratchRoot), [], "the scratch repository of a run that passes is removed");
    repo.write(".github/workflows/x.lock.yml", "name: x\n");
    const fails = await invoke(run, ["--checkout", repo.dir, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(fails.code, 1);
    assert.equal(gitDirectoryListing(), untouched, "nor does a run that fails");
    assert.deepEqual(fs.readdirSync(scratchRoot), [], "and its scratch repository is removed too");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restore();
  }
});

test("AC22: the patch and bundle files are copied before anything else is read, so that what is inspected is what the directory held: a file that is gone by the time git reads is still named", async () => {
  const { root, agent } = artifactDirectories();
  const origin = repo.git("rev-parse", "--abbrev-ref", "HEAD");
  const removed = [];
  // a file system whose copy of a transport file is followed by the removal of the original, as an agent's program could make it happen
  const vanishing = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (property === "copyFileSync") {
        return (from, to) => {
          value.call(target, from, to);
          if (!/^aw-/.test(path.basename(String(from)))) return; // the validator copies other files too (the HEAD of the checkout, for one)
          target.rmSync(from);
          removed.push(path.basename(String(from)));
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    repo.git("switch", "-q", "-c", "sdlc/x");
    bump(repo);
    repo.commitAll("bump");
    createPullRequest(root, "sdlc/x", { bundle: true });
    repo.git("switch", "-q", origin);
    repo.git("branch", "-q", "-D", "sdlc/x");
    repo.git("reflog", "expire", "--expire=now", "--all");
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base), fs: vanishing });
    assert.deepEqual(removed.sort(), ["aw-sdlc-x.bundle", "aw-sdlc-x.patch"], "the validator copied both files, and the originals are gone");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith("aw-")), false);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /gh_aw_schema_version changed from '0\.86\.2' to '9\.9\.9'; it is report-only \(in aw-sdlc-x\.bundle \(commit [0-9a-f]{12}\) and aw-sdlc-x\.patch \(patch 1 of 1\)\)/, "both files are named, in the order of their names");
    assert.doesNotMatch(result.stderr, /cannot be inspected/);
  } finally {
    repo.git("switch", "-q", origin);
    restore();
    forceRemove(root);
  }
});

// --- no git process of the validator runs in the checkout's repository -------------------------------------------------------------------------
//
// Everything that the validator asks git runs in a scratch repository that borrows the objects of the checkout and takes copies of its refs, HEAD and
// shallow file (drift/lib/git-artifacts.mjs). The tests above show that no program of the checkout's configuration runs; these show the other side: that
// nothing about the checkout's repository decides what the validator reads except what is in it, for each shape that a checkout can have.

test("AC22: an aw-*.patch entry that is not a regular file (a directory here, a pipe in the worst case, which would block a read for good) fails the run without being read", async () => {
  const { root, agent } = artifactDirectories();
  try {
    fs.mkdirSync(path.join(root, "aw-sdlc-x.patch"));
    const result = await invoke(run, ["--checkout", repo.dir, "--out", agent], { cwd: out, env: withBase(base) });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /aw-sdlc-x\.patch cannot be inspected: it is not a regular file/);
  } finally {
    forceRemove(root);
  }
});

test("AC22: a configuration that no git can read in the checkout does not stop the validator from reading the patch: no git process of the validator runs under it", async () => {
  const putBack = saveGitDirectory();
  const result = await afterTheAgentSwitchedBack({
    change: bump,
    keepBranch: false,
    before: () => fs.appendFileSync(gitDirectoryFile("config"), "[core]\n\trepositoryformatversion = 99\n"), // every git that starts in the checkout dies on this
    finish: putBack,
  });
  assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
  assert.ok(result.stderr.includes(PATCH_NAMED), result.stderr);
  assert.doesNotMatch(result.stderr, /unknown repository format|not a git repository|fatal:/i);
});

test("AC22: a linked working tree, whose .git is a file, is read through the directories that the file names: its HEAD, its index and the refs and objects of the main repository", async () => {
  const linked = path.join(tempDir("sdlc-s2-linked-"), "lab");
  repo.git("worktree", "add", "-q", "--detach", linked, base);
  try {
    assert.ok(fs.statSync(path.join(linked, ".git")).isFile(), ".git of a linked working tree is a file");
    const clean = await invoke(run, ["--checkout", linked, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(clean.code, 0, clean.stderr);
    fs.writeFileSync(path.join(linked, ...WORKFLOW.split("/")), "name: rewritten by the agent\n");
    const dirty = await invoke(run, ["--checkout", linked, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(dirty.code, 1, dirty.stdout);
    assert.match(dirty.stderr, /\.github\/workflows\/stand-in\.lock\.yml differs from the base commit [0-9a-f]{12}; .*\(in the working tree\)/);
    gitIn(linked, ["add", "-A"]);
    gitIn(linked, ["commit", "-q", "-m", "recompile"]);
    const committed = await invoke(run, ["--checkout", linked, "--out", out], { cwd: out, env: withBase(base) });
    assert.equal(committed.code, 1, committed.stdout);
    assert.match(committed.stderr, /\(in the HEAD commit, the index and the working tree\)/, "the HEAD, the index and the working tree of the linked working tree, which are not those of the main one (that stays at the base commit)");
  } finally {
    repo.git("worktree", "remove", "--force", linked);
    repo.git("worktree", "prune");
  }
});

test("AC22: a shallow checkout, which is what actions/checkout makes by default (fetch-depth 1), is read: the parents of the base commit are missing, and a commit on top of it is found", async () => {
  const origin = createRepo(labFiles());
  origin.write("labs/lab01.md", "A second commit, so that the base commit has a parent.\n");
  origin.commitAll("second");
  const parent = tempDir("sdlc-s2-shallow-");
  const clone = path.join(parent, "lab");
  try {
    gitIn(parent, ["clone", "-q", "--depth", "1", pathToFileURL(origin.dir).href, clone]);
    writeGitFixtureConfig(clone);
    assert.ok(fs.existsSync(path.join(clone, ".git", "shallow")), "the clone is shallow");
    const shallowBase = gitIn(clone, ["rev-parse", "HEAD"]);
    assert.equal(gitIn(clone, ["rev-list", "--count", "HEAD"]), "1");
    const clean = await invoke(run, ["--checkout", clone, "--out", out], { cwd: out, env: withBase(shallowBase) });
    assert.equal(clean.code, 0, clean.stderr);
    const branchBefore = gitIn(clone, ["rev-parse", "--abbrev-ref", "HEAD"]);
    gitIn(clone, ["switch", "-q", "-c", "sdlc/x"]);
    fs.writeFileSync(path.join(clone, "docs", "_meta", "registry.yaml"), fs.readFileSync(path.join(clone, "docs", "_meta", "registry.yaml"), "utf8").replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"'));
    gitIn(clone, ["add", "-A"]);
    gitIn(clone, ["commit", "-q", "-m", "bump"]);
    const { root, agent } = artifactDirectories();
    try {
      const [first, ...rest] = `${gitIn(clone, ["format-patch", `${shallowBase}..sdlc/x`, "--stdout"])}\n`.split("\n");
      fs.writeFileSync(path.join(root, "aw-sdlc-x.patch"), [first, `X-GH-AW-Base-Commit: ${shallowBase}`, ...rest].join("\n"));
      gitIn(clone, ["switch", "-q", branchBefore]);
      const kept = await invoke(run, ["--checkout", clone, "--out", agent], { cwd: out, env: withBase(shallowBase) });
      assert.equal(kept.code, 1, kept.stdout);
      assert.match(kept.stderr, /commit [0-9a-f]{12} \(refs\/heads\/sdlc\/x\)/, "the commit that only a branch of the shallow clone names");
      assert.ok(kept.stderr.includes("aw-sdlc-x.patch (patch 1 of 1)"), "and the patch");
      gitIn(clone, ["branch", "-q", "-D", "sdlc/x"]);
      const patchOnly = await invoke(run, ["--checkout", clone, "--out", agent], { cwd: out, env: withBase(shallowBase) });
      assert.equal(patchOnly.code, 1, patchOnly.stdout);
      assert.ok(patchOnly.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in aw-sdlc-x.patch (patch 1 of 1))"), patchOnly.stderr);
    } finally {
      forceRemove(root);
    }
  } finally {
    origin.cleanup();
    forceRemove(parent);
  }
});

test("AC22: a checkout that keeps its refs in the reftable format is refused: its refs cannot be copied and read here, and a checkout that cannot be read is not one that is fine", async (t) => {
  const dir = tempDir("sdlc-s2-reftable-");
  try {
    gitIn(dir, ["init", "-q", "--ref-format=reftable"]);
  } catch {
    t.skip("this git cannot make a repository with the reftable ref format");
    return;
  }
  const result = await invoke(run, ["--checkout", dir, "--out", out], { cwd: out, env: withBase("0".repeat(40)) });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /the target checkout cannot be inspected: the refs of the target checkout are stored in the reftable format/);
});

test("AC22: a sha256 checkout is read in a scratch repository of the same object format", async (t) => {
  const dir = tempDir("sdlc-s2-sha256-");
  try {
    gitIn(dir, ["init", "-q", "--object-format=sha256"]);
  } catch {
    t.skip("this git cannot make a sha256 repository");
    return;
  }
  writeGitFixtureConfig(dir);
  writeTree(dir, labFiles());
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "base"]);
  const sha = gitIn(dir, ["rev-parse", "HEAD"]);
  assert.equal(sha.length, 64, "a sha256 commit id");
  const clean = await invoke(run, ["--checkout", dir, "--out", out], { cwd: out, env: withBase(sha) });
  assert.equal(clean.code, 0, clean.stderr);
  writeTree(dir, { "docs/_meta/registry.yaml": labFiles()["docs/_meta/registry.yaml"].replace('gh_aw_schema_version: "0.86.2"', 'gh_aw_schema_version: "9.9.9"') });
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "bump"]);
  const bumped = await invoke(run, ["--checkout", dir, "--out", out], { cwd: out, env: withBase(sha) });
  assert.equal(bumped.code, 1, bumped.stdout);
  assert.ok(bumped.stderr.includes("gh_aw_schema_version changed from '0.86.2' to '9.9.9'; it is report-only (in the HEAD commit and the working tree)"), bumped.stderr);
});
