// AC2: contract C2 request, rendered frontmatter. Each drift workflow carries typed gh-aw frontmatter with the structure and the
// literals of the contract, plus only the three extra keys that AC3 names. The test asserts the rendered configuration, not
// the runtime semantics of continue-on-error: false, preserve-branch-name: true, recreate-ref: false or if-no-changes: error (OQ35, OQ36).
//
// The compiler check at the end is opt-in, like tests/s1/compile.test.mjs, because the rest of the suite is offline:
//   SDLC_REAL_GH_AW=1 node --test tests/s2/c2-frontmatter.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { ghAwEnvironment } from "../../src/reconcile.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, REPO_ROOT, WORKFLOWS } from "./helpers/fixtures.mjs";

const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const isStringList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function assertContract(frontmatter, project) {
  const audit = project.driftAudit;
  assert.deepEqual(
    Object.keys(frontmatter).sort(),
    ["checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools"],
    "the nine contract keys plus engine, tools and jobs",
  );

  // on
  assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "schedule", "workflow_dispatch"]);
  assert.deepEqual(frontmatter.on.schedule, [{ cron: audit.schedule }], "on.schedule holds one { cron } entry equal to driftAudit.schedule");
  assert.ok(isStringList(frontmatter.on.bots) && frontmatter.on.bots.length === 1, "on.bots is a list of one App sender");
  assert.deepEqual(Object.keys(frontmatter.on.workflow_dispatch), ["inputs"]);
  const inputs = frontmatter.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["correlation_id", "dry_run", "extra_instructions", "target_repo"]);
  for (const name of ["target_repo", "correlation_id", "extra_instructions"]) assert.equal(inputs[name].type, "string", `${name} is a string input`);
  assert.equal(inputs.dry_run.type, "boolean", "dry_run is a boolean input");

  // concurrency, permissions, network
  assert.deepEqual(Object.keys(frontmatter.concurrency).sort(), ["cancel-in-progress", "group"]);
  assert.equal(typeof frontmatter.concurrency.group, "string");
  assert.equal(frontmatter.concurrency["cancel-in-progress"], false);
  assert.deepEqual(frontmatter.permissions, { actions: "read", contents: "read", issues: "read", "pull-requests": "read" });
  assert.deepEqual(Object.keys(frontmatter.network), ["allowed"]);
  assert.ok(isStringList(frontmatter.network.allowed));

  // checkout
  assert.equal(frontmatter.checkout.length, 1);
  const [checkout] = frontmatter.checkout;
  assert.deepEqual(Object.keys(checkout).sort(), ["current", "github-app", "path", "repository"]);
  assert.equal(typeof checkout.repository, "string");
  assert.equal(typeof checkout.path, "string");
  assert.equal(checkout.current, true);
  assert.deepEqual(checkout["github-app"], { ...APP, repositories: [checkout.path] }, "the token of the checkout is scoped to the target repository");

  // the other contract keys
  assert.equal(typeof frontmatter["mcp-servers"], "object");
  assert.ok(Array.isArray(frontmatter["pre-agent-steps"]));
  assert.ok(Array.isArray(frontmatter["post-steps"]));

  // safe-outputs
  const outputs = frontmatter["safe-outputs"];
  assert.deepEqual(Object.keys(outputs).sort(), ["create-issue", "create-pull-request", "github-app", "report-failure-as-issue", "threat-detection"]);
  assert.deepEqual(outputs["create-issue"], {
    "target-repo": project.repo,
    "title-prefix": "[sdlc-drift] ",
    labels: ["automated", "sdlc-drift", "drift-report"],
    "close-older-issues": false,
    max: 1,
  }, "no report closes an earlier one: its items are in the next run's baseline, so only the pull request that implements it, or a human, may (AC44)");
  assert.deepEqual(outputs["github-app"], { ...APP, repositories: [checkout.path] }, "the token of the safe outputs, like that of the checkout, is scoped to the target repository alone (AC69)");
  assert.equal(outputs["report-failure-as-issue"], false);
  assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false });
  const handler = outputs["create-pull-request"];
  assert.deepEqual(Object.keys(handler).sort(), [
    "auto-merge",
    "branch-prefix",
    "close-older-key",
    "close-older-pull-requests",
    "draft",
    "exclude-lock-yml",
    "fallback-as-issue",
    "if-no-changes",
    "labels",
    "max",
    "max-patch-size",
    "preserve-branch-name",
    "protected-files",
    "recreate-ref",
    "reviewers",
    "target-repo",
    "title-prefix",
  ]);
  assert.equal(typeof handler["target-repo"], "string");
  assert.equal(typeof handler["title-prefix"], "string");
  assert.ok(isStringList(handler.labels));
  assert.ok(isStringList(handler.reviewers));
  assert.equal(typeof handler.draft, "boolean");
  assert.equal(handler["branch-prefix"], "sdlc/");
  assert.equal(handler["preserve-branch-name"], true);
  assert.equal(handler["recreate-ref"], false);
  assert.equal(handler["if-no-changes"], "error");
  assert.equal(handler["close-older-pull-requests"], false, "an earlier pull request of the workflow stays open (AC25)");
  assert.equal(typeof handler["close-older-key"], "string");
  assert.equal(handler["exclude-lock-yml"], true);
  assert.deepEqual(Object.keys(handler["protected-files"]).sort(), ["exclude", "policy"]);
  assert.equal(handler["protected-files"].policy, "blocked");
  assert.ok(isStringList(handler["protected-files"].exclude));
  assert.equal(handler["auto-merge"], false);
  assert.equal(handler["fallback-as-issue"], true);
  assert.equal(handler.max, 1);
  assert.equal(handler["max-patch-size"], 10240);
  assert.equal(typeof handler.max, "number");
  assert.equal(handler.draft, audit.draft);
  assert.equal(handler["target-repo"], project.repo);
}

for (const key of DRIFT_KEYS) {
  test(`AC2: drift-${key}.md carries the typed frontmatter of contract C2`, () => {
    assertContract(driftWorkflow(key).frontmatter, driftPreset(key));
  });
}

test("AC2: the three workflows differ only in the values that come from their project", () => {
  const groups = DRIFT_KEYS.map((key) => driftWorkflow(key).frontmatter.concurrency.group);
  assert.equal(new Set(groups).size, 3, "three distinct concurrency groups");
  const closeKeys = DRIFT_KEYS.map((key) => driftWorkflow(key).frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"]);
  assert.equal(new Set(closeKeys).size, 3, "three distinct close-older-key values");
  for (const key of DRIFT_KEYS) assert.equal("close-older-key" in driftWorkflow(key).frontmatter["safe-outputs"]["create-issue"], false, `${key}: a report closes no other report`);
});

const requested = process.env.SDLC_REAL_GH_AW === "1";
const env = ghAwEnvironment(process.env);
const version = requested ? spawnSync("gh", ["aw", "version"], { env, encoding: "utf8" }) : null;
const installed = version?.stdout.match(/v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
const usable = installed !== null && (installed[0] > 1 || (installed[0] === 1 && (installed[1] > 0 || installed[2] >= 1)));
const skip = !requested ? "set SDLC_REAL_GH_AW=1 to run the real compiler" : !usable ? `gh aw >= v1.0.1 is required, found ${installed?.join(".") ?? "none"}` : false;

test("AC2: gh aw compile --strict --purge --json exits 0 with the three drift workflows present", { skip }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s2-compile-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    fs.cpSync(abs(".github"), path.join(directory, ".github"), { recursive: true });
    fs.copyFileSync(abs(".gitattributes"), path.join(directory, ".gitattributes"));
    for (const key of DRIFT_KEYS) assert.ok(fs.existsSync(path.join(directory, WORKFLOWS, `drift-${key}.md`)), `drift-${key}.md is present`);
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: directory, env, encoding: "utf8", timeout: 600000 });
    assert.equal(outcome.status, 0, outcome.stderr);
    const elements = JSON.parse(outcome.stdout);
    for (const key of DRIFT_KEYS) {
      const element = elements.find((entry) => String(entry.workflow).endsWith(`drift-${key}.md`));
      assert.ok(element, `the compiler reports drift-${key}.md`);
      assert.equal(element.valid, true, `${key}: ${JSON.stringify(element.errors)}`);
    }
    for (const key of DRIFT_KEYS) {
      assert.equal(fs.readFileSync(path.join(directory, WORKFLOWS, `drift-${key}.lock.yml`), "utf8").replace(/\r\n/g, "\n"), fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8").replace(/\r\n/g, "\n"), `drift-${key}.lock.yml is what the compiler produces`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC2: the committed workflows are the ones in this repository", () => {
  for (const key of DRIFT_KEYS) assert.ok(fs.existsSync(path.join(REPO_ROOT, WORKFLOWS, `drift-${key}.md`)));
});
