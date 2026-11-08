// Required-behavior reproductions kept outside *.test.mjs, so they do not make
// unrelated suite runs red. Socket-free fakes only; no GitHub request is sent.
// node tests/s2/fixtures/qa/auth-pagination-repro.mjs auth
// node tests/s2/fixtures/qa/auth-pagination-repro.mjs pagination
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run as dedupe } from "../../../../src/drift/dedupe-open-prs.mjs";
import { composeBody, run as escalate, TITLE } from "../../../../src/drift/escalate-gate-failure.mjs";
import { tokenKind } from "../../../../src/drift/lib/github-client.mjs";
import { forceRemove, tempDir } from "../../helpers/fixtures.mjs";
import { invoke } from "../../helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json } from "../../helpers/stub-server.mjs";

const central = "example/central";
const target = "example/target";
const workflowId = "drift-qa";
const escalationArgs = ["--workflow-id", workflowId, "--target-repo", target, "--failing-command", "npm test"];

async function auth(root) {
  assert.equal(tokenKind("ghu_qa_user_token"), "App user access token", "the implementation recognizes this as a user credential");
  const outcomes = [];
  for (const token of ["ghs_qa_installation", "ghu_qa_user_token"]) {
    const reads = createFakeFetch(() => json(200, []));
    const out = path.join(root, token.startsWith("ghs_") ? "installation" : "user");
    const deduplication = await invoke(dedupe, ["--target-repo", target, "--out", out], {
      fetch: reads,
      env: cleanEnv({ GH_APP_INSTALLATION_TOKEN: token }),
    });
    const issues = [];
    const writes = createFakeFetch((entry) => {
      if (entry.method === "GET") return json(200, issues);
      const issue = { number: 1, ...JSON.parse(entry.body) };
      issues.push(issue);
      return json(201, issue);
    });
    const escalation = await invoke(escalate, escalationArgs, {
      fetch: writes,
      env: cleanEnv({ GH_TOKEN: token, GITHUB_REPOSITORY: central }),
    });
    outcomes.push({
      kind: tokenKind(token),
      dedupe: deduplication.code,
      readRequests: reads.requests.length,
      artifactWritten: fs.existsSync(path.join(out, "open-pr-dedup.json")),
      escalation: escalation.code,
      escalationRequests: writes.requests.length,
      issuesCreated: issues.length,
    });
  }
  console.log(JSON.stringify(outcomes));
  assert.deepEqual(outcomes[0], {
    kind: "App installation token", dedupe: 0, readRequests: 1, artifactWritten: true,
    escalation: 0, escalationRequests: 2, issuesCreated: 1,
  }, "positive control: an installation token really reaches both callers");
  assert.deepEqual(outcomes[1], {
    kind: "App user access token", dedupe: 1, readRequests: 0, artifactWritten: false,
    escalation: 1, escalationRequests: 0, issuesCreated: 0,
  }, "AC9/AC10/AC30: a known App user credential must not authenticate installation-token-only callers");
}

async function pagination() {
  for (const unrelatedCount of [0, 500]) {
    const clock = createClock();
    const existing = {
      number: 501,
      title: TITLE(workflowId, target),
      state: "open",
      labels: [{ name: "sdlc-gate-failure" }],
      body: composeBody({
        workflowId, targetRepo: target, failingCommand: "npm ci",
        runUrl: "https://example.test/earlier", correlationId: "earlier",
        nowMs: clock.now(), earlier: null,
      }),
    };
    const issues = [
      ...Array.from({ length: unrelatedCount }, (_, index) => ({
        number: index + 1, title: `other failure ${index + 1}`, state: "open",
        labels: [{ name: "sdlc-gate-failure" }], body: "",
      })),
      existing,
    ];
    const pages = [];
    let creates = 0;
    let updates = 0;
    const fetch = createFakeFetch((entry) => {
      if (entry.method === "GET") {
        const page = Number(new URLSearchParams(entry.search).get("page") ?? 1);
        pages.push(page);
        const start = (page - 1) * 100;
        const headers = start + 100 < issues.length ? {
          link: `<https://api.github.com/repos/${central}/issues?state=open&labels=sdlc-gate-failure&per_page=100&page=${page + 1}>; rel="next"`,
        } : {};
        return json(200, issues.slice(start, start + 100), headers);
      }
      if (entry.method === "POST") {
        creates += 1;
        const issue = { number: 502, ...JSON.parse(entry.body) };
        issues.push(issue);
        return json(201, issue);
      }
      assert.equal(entry.method, "PATCH");
      assert.equal(entry.path, `/repos/${central}/issues/501`);
      updates += 1;
      Object.assign(existing, JSON.parse(entry.body));
      return json(200, existing);
    });
    const result = await invoke(escalate, escalationArgs, {
      fetch, now: clock.now, sleep: clock.sleep,
      env: cleanEnv({ GH_TOKEN: "ghs_qa_installation", GITHUB_REPOSITORY: central }),
    });
    console.log(JSON.stringify({ unrelatedCount, code: result.code, pages, creates, updates, issues: issues.length }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(creates, 0, "AC30: a matching open issue exists; a truncated search must not open a duplicate");
    assert.equal(updates, 1, "the existing issue is updated");
    assert.equal(issues.length, unrelatedCount + 1);
    assert.match(existing.body, /\| Occurrences \| 2 \|/);
  }
}

const root = tempDir("sdlc-qa-auth-pagination-");
try {
  const selected = process.argv[2] ?? "both";
  assert.ok(["auth", "pagination", "both"].includes(selected), "choose auth or pagination");
  for (const [name, reproduce] of [["auth", auth], ["pagination", pagination]]) {
    if (selected !== "both" && selected !== name) continue;
    try {
      await reproduce(root);
    } catch (error) {
      console.error(`${name}: ${error.stack}`);
      process.exitCode = 1;
    }
  }
} finally {
  forceRemove(root);
}
