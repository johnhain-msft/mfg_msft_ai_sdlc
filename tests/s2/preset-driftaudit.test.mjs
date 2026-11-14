// AC34 and AC40: the shipped preset data. sdlc.yaml holds the three driftAudit blocks that render the fleet of the two
// upstream repositories, and the draft and reviewer policy of their pull requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, presetManifest, readText } from "./helpers/fixtures.mjs";

const STRATEGIES = ["content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan", "custom"];
const EXPECTED = {
  "gh-admin-msft": { repo: "johnhain-msft/gh-admin-msft", file: "instructions/gh-admin-msft.md" },
  "copilot-lab": { repo: "ms-mfg-community/day-in-the-life-copilot-lab", file: "instructions/copilot-lab.md" },
  "self-improving-agents": { repo: "ms-mfg-community/day-in-the-life-copilot-lab", file: "instructions/self-improving-agents.md" },
};

/** A five-field cron expression: minute hour day-of-month month day-of-week, each from the characters cron allows. */
function isCron(value) {
  const fields = String(value).trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[0-9*,/\-A-Za-z?LW#]+$/.test(field));
}

test("AC40: the preset renders drift-gh-admin-msft, drift-copilot-lab and drift-self-improving-agents for their repositories", () => {
  const manifest = presetManifest();
  const enabled = manifest.projects.filter((project) => project.driftAudit.enabled).map((project) => project.projectKey);
  assert.deepEqual([...enabled].sort(), [...DRIFT_KEYS].sort(), "exactly the three drift projects are enabled");
  for (const key of DRIFT_KEYS) {
    const project = driftPreset(key);
    assert.equal(project.repo, EXPECTED[key].repo, key);
    assert.equal(driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"]["target-repo"], EXPECTED[key].repo, `${key}: the rendered target-repo`);
  }
});

test("AC40: each entry has a valid cron schedule, an upkeepStrategy of the enum and an instructionsFile that exists", () => {
  for (const key of DRIFT_KEYS) {
    const audit = driftPreset(key).driftAudit;
    assert.equal(audit.enabled, true, key);
    assert.ok(isCron(audit.schedule), `${key}: '${audit.schedule}' is a five-field cron`);
    assert.ok(STRATEGIES.includes(audit.upkeepStrategy), `${key}: ${audit.upkeepStrategy}`);
    assert.equal(audit.instructionsFile, EXPECTED[key].file, key);
    assert.ok(fs.existsSync(abs(audit.instructionsFile)), `${audit.instructionsFile} exists`);
    assert.ok(readText(abs(audit.instructionsFile)).trim().length > 0, `${audit.instructionsFile} is not empty`);
  }
});

test("AC40: every watched URL has a literal hostname, and both MCP servers are declared", () => {
  for (const key of DRIFT_KEYS) {
    const sources = driftPreset(key).driftAudit.knowledgeSources;
    assert.ok(sources.watchUrls.length > 0, `${key} watches at least one URL`);
    for (const entry of sources.watchUrls) {
      const url = new URL(entry.url);
      assert.match(url.protocol, /^https?:$/, entry.url);
      assert.equal(entry.url.includes("*"), false, `${entry.url} has no wildcard`);
      assert.match(url.hostname, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, `${entry.url} has a literal hostname`);
      assert.ok(["changelog", "blog", "docs", "release-notes", "feed"].includes(entry.kind), `${entry.url}: kind ${entry.kind}`);
    }
    assert.ok("microsoft-learn" in sources.mcpServers && "context7" in sources.mcpServers, `${key} declares microsoft-learn and context7`);
  }
});

test("AC40: the lab watches the github/gh-aw releases page and its package manifests cover node/package.json and **/*.csproj", () => {
  for (const key of ["copilot-lab", "self-improving-agents"]) {
    const watched = driftPreset(key).driftAudit.knowledgeSources.watchUrls;
    const releases = watched.filter((entry) => entry.kind === "release-notes" && new URL(entry.url).pathname === "/github/gh-aw/releases");
    assert.equal(releases.length, 1, `${key} has one release-notes entry for the github/gh-aw releases page`);
    // the Atom feed of a release page also lists the bare tags of the repository: on 2026-11-13, 9 of the 10 entries of github/gh-aw's were
    // gh-aw/work-queue/<sha> tags, so the feed showed one release where the page shows ten
    for (const entry of watched) assert.doesNotMatch(new URL(entry.url).pathname, /\/releases\.atom$/, `${key}: ${entry.url} is the release page, not its Atom feed`);
  }
  const manifests = driftPreset("copilot-lab").driftAudit.knowledgeSources.packageManifests;
  assert.ok(manifests.includes("node/package.json"), "node/package.json");
  assert.ok(manifests.includes("**/*.csproj"), "**/*.csproj");
});

test("AC40: the lab's own scheduled workflows are not part of this repository's fleet", () => {
  const workflows = fs.readdirSync(abs(".github", "workflows"));
  for (const name of ["weekly-content-audit.md", "weekly-content-audit.lock.yml", "self-improving-agents.md", "self-improving-agents.lock.yml"]) {
    assert.equal(workflows.includes(name), false, `${name} stays in the lab`);
  }
});

test("AC34: drift-gh-admin-msft and drift-copilot-lab render draft: false and drift-self-improving-agents renders draft: true", () => {
  const draft = (key) => driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"].draft;
  assert.equal(draft("gh-admin-msft"), false);
  assert.equal(draft("copilot-lab"), false);
  assert.equal(draft("self-improving-agents"), true);
  for (const key of DRIFT_KEYS) assert.equal(draft(key), driftPreset(key).driftAudit.draft, `${key}: the rendered draft is the manifest's`);
});

test("AC34: the gh-admin-msft entry lists explicit reviewers and the two lab entries list none, leaving assignment to CODEOWNERS", () => {
  const reviewers = (key) => driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"].reviewers;
  assert.ok(driftPreset("gh-admin-msft").driftAudit.reviewers.length > 0, "sdlc.yaml lists reviewers for gh-admin-msft");
  assert.deepEqual(reviewers("gh-admin-msft"), driftPreset("gh-admin-msft").driftAudit.reviewers);
  assert.ok(reviewers("gh-admin-msft").length > 0);
  assert.deepEqual(reviewers("copilot-lab"), []);
  assert.deepEqual(reviewers("self-improving-agents"), []);
  assert.deepEqual(driftPreset("copilot-lab").driftAudit.reviewers, []);
  assert.deepEqual(driftPreset("self-improving-agents").driftAudit.reviewers, []);
});
