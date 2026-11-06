// AC30: contract C5 error handoff, failure escalation. The escalate_failure job of the orchestrator repository opens, or updates when
// it already exists, one deduplicated issue labelled sdlc-gate-failure and titled "[sdlc-failure] <workflowId> (<targetRepo>)",
// whose body names the failing command, the run URL and the correlation id; a second failure of the same workflow on the same
// target updates it; nothing is written outside /repos/<central repository>/. The job itself is rendered by SPEC-01 and parsed here.
// The failing command comes from the jobs of the run, which the private central repository lets the job's token read only with
// actions: read: the stub below enforces that rule with the permissions of the compiled job, so a job that loses the permission fails here.
//
// The compile-time question of §4 (does gh aw compile --strict accept a custom job with permissions: { issues: write }?) is
// answered by the real compiler: tests/s2/c2-frontmatter.test.mjs run with SDLC_REAL_GH_AW=1 compiles the three workflows,
// escalate_failure included, with --strict, so failure reporting does not fall back to safe-outputs issue reporting.
import assert from "node:assert/strict";
import test from "node:test";
import { composeBody, DEFAULT_LABEL, readEarlierBody, run, TITLE } from "../../src/drift/escalate-gate-failure.mjs";
import { DRIFT_KEYS, driftLock, driftPreset, driftWorkflow, script, stepWith } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, json, runNode, startStubServer } from "./helpers/stub-server.mjs";

const CENTRAL = "johnhain-msft/mfg_msft_ai_sdlc";
const TARGET = "ms-mfg-community/day-in-the-life-copilot-lab";
const RUN_URL = `https://github.com/${CENTRAL}/actions/runs/4242`;
const base = `/repos/${CENTRAL}`;

/**
 * A stateful stand-in for the issues of the central repository (and the jobs of one run). With `permissions` it also enforces what the
 * API enforces for a repository that is private: the job's GITHUB_TOKEN reads the jobs of a run only with actions: read (or write) and
 * writes issues only with issues: write, and is refused otherwise with "Resource not accessible by integration".
 */
function tracker({ jobs = null, permissions = null } = {}) {
  const issues = [];
  const refused = () => json(403, { message: "Resource not accessible by integration" });
  const may = (scope, levels) => permissions === null || levels.includes(permissions[scope]);
  const handler = (entry) => {
    if (entry.method === "GET" && entry.path === `${base}/issues`) {
      if (!may("issues", ["read", "write"])) return refused();
      const params = new URLSearchParams(entry.search);
      const wanted = params.get("labels");
      return json(200, issues.filter((issue) => issue.state === (params.get("state") ?? "open") && (wanted === null || issue.labels.some((label) => label.name === wanted))));
    }
    if (entry.method === "POST" && entry.path === `${base}/issues`) {
      if (!may("issues", ["write"])) return refused();
      const payload = JSON.parse(entry.body);
      const issue = { number: issues.length + 1, title: payload.title, body: payload.body, state: "open", labels: payload.labels.map((name) => ({ name })), html_url: `https://github.com${base}/issues/${issues.length + 1}` };
      issues.push(issue);
      return json(201, issue);
    }
    const patch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(entry.path);
    if (entry.method === "PATCH" && patch) {
      if (!may("issues", ["write"])) return refused();
      const issue = issues.find((candidate) => candidate.number === Number(patch[1]));
      Object.assign(issue, JSON.parse(entry.body));
      return json(200, issue);
    }
    if (entry.method === "GET" && /\/actions\/runs\/\d+\/jobs$/.test(entry.path)) return jobs && may("actions", ["read", "write"]) ? json(200, jobs) : refused();
    return json(404, { message: "Not Found" });
  };
  return { issues, handler };
}

const env = (extra = {}) => cleanEnv({ GH_TOKEN: "ghs_jobtoken", GITHUB_REPOSITORY: CENTRAL, ...extra });
const args = (extra = []) => ["--workflow-id", "drift-copilot-lab", "--target-repo", TARGET, "--correlation-id", "corr-7", "--run-url", RUN_URL, ...extra];
const writes = (fake) => fake.requests.filter((request) => request.method !== "GET");

test("AC30: two failures of the same workflow on the same target give one issue create and then one update, never a second create", async () => {
  const { issues, handler } = tracker();
  const fake = createFakeFetch(handler);
  const first = await invoke(run, args(["--failing-command", "npm run test:freshness"]), { env: env(), fetch: fake });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, `[sdlc-failure] drift-copilot-lab (${TARGET})`);
  assert.deepEqual(issues[0].labels.map((label) => label.name), ["sdlc-gate-failure"]);
  const second = await invoke(run, args(["--correlation-id", "corr-8", "--failing-command", "npm test"]), { env: env(), fetch: fake });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(issues.length, 1, "no second issue");
  assert.deepEqual(writes(fake).map((request) => `${request.method} ${request.path}`), [`POST ${base}/issues`, `PATCH ${base}/issues/1`], "one create, then one update");
  assert.ok(fake.requests.every((request) => request.path.startsWith(`${base}/`)), "no request outside /repos/<central repository>/");
  assert.ok(fake.requests.every((request) => request.headers.authorization === "Bearer ghs_jobtoken"));
  assert.match(first.stdout, /opened issue #1/);
  assert.match(second.stdout, /updated issue #1/);
  assert.match(issues[0].body, /\| Failing command \| `npm test` \|/, "the update shows the latest failure");
  assert.match(issues[0].body, /\| Occurrences \| 2 \|/);
  assert.match(issues[0].body, /correlation id `corr-7` — failing command: `npm run test:freshness`/, "and keeps the earlier one in its history");
  assert.match(issues[0].body, /correlation id `corr-8` — failing command: `npm test`/);
});

test("AC30: the body names the failing command, the run URL and the correlation_id", async () => {
  const { issues, handler } = tracker();
  const result = await invoke(run, args(["--failing-command", "node presentation/build.mjs"]), { env: env(), fetch: createFakeFetch(handler) });
  assert.equal(result.code, 0, result.stderr);
  const [{ body }] = issues;
  assert.ok(body.includes("`node presentation/build.mjs`"), "the failing command");
  assert.ok(body.includes(RUN_URL), "the run URL");
  assert.ok(body.includes("`corr-7`"), "the correlation id");
  assert.ok(body.includes("`drift-copilot-lab`") && body.includes(`\`${TARGET}\``));
  assert.match(body, /^<!-- sdlc-gate-failure:v1 workflow=drift-copilot-lab target=ms-mfg-community\/day-in-the-life-copilot-lab -->/);
});

test("AC30: a different workflow or a different target repository is a different issue", async () => {
  const { issues, handler } = tracker();
  const fake = createFakeFetch(handler);
  for (const extra of [[], ["--workflow-id", "drift-self-improving-agents"], ["--target-repo", "johnhain-msft/gh-admin-msft"]]) {
    assert.equal((await invoke(run, [...args(), ...extra], { env: env(), fetch: fake })).code, 0);
  }
  assert.equal(issues.length, 3);
  assert.equal(new Set(issues.map((issue) => issue.title)).size, 3);
  assert.deepEqual(writes(fake).map((request) => request.method), ["POST", "POST", "POST"]);
});

test("AC30: only an open issue with the label is updated: a closed one, a pull request and a title that differs are not", async () => {
  const { issues, handler } = tracker();
  const title = TITLE("drift-copilot-lab", TARGET);
  issues.push({ number: 10, title, body: "old", state: "closed", labels: [{ name: DEFAULT_LABEL }], html_url: "x" });
  issues.push({ number: 11, title, body: "pr", state: "open", labels: [{ name: DEFAULT_LABEL }], pull_request: {}, html_url: "x" });
  issues.push({ number: 12, title: `${title} extra`, body: "other", state: "open", labels: [{ name: DEFAULT_LABEL }], html_url: "x" });
  issues.push({ number: 13, title, body: "no label", state: "open", labels: [{ name: "other" }], html_url: "x" });
  const fake = createFakeFetch(handler);
  assert.equal((await invoke(run, args(), { env: env(), fetch: fake })).code, 0);
  assert.deepEqual(writes(fake).map((request) => `${request.method} ${request.path}`), [`POST ${base}/issues`], "a new issue is opened");
  const read = fake.requests.find((request) => request.method === "GET" && request.path === `${base}/issues`);
  assert.equal(read.search, `?state=open&labels=${DEFAULT_LABEL}&per_page=100`, "the read asks for open issues with the label");
  assert.deepEqual(issues.slice(0, 4).map((issue) => issue.body), ["old", "pr", "other", "no label"], "none of the four was touched");
});

test("AC30: the failing command is looked up as the first failed step of the agent job, and is 'not determined' when the token cannot read the jobs", async () => {
  const jobs = { jobs: [{ name: "activation", conclusion: "success", steps: [] }, { name: "agent", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "npm run test:deck", conclusion: "failure" }, { name: "npm test -- --skip-links", conclusion: "skipped" }] }] };
  const readable = tracker({ jobs });
  const fake = createFakeFetch(readable.handler);
  assert.equal((await invoke(run, args(), { env: env(), fetch: fake })).code, 0);
  assert.match(readable.issues[0].body, /\| Failing command \| `npm run test:deck` \|/);
  assert.ok(fake.requests.some((request) => request.path === `${base}/actions/runs/4242/jobs`), "the run id comes from the run URL");
  const refused = tracker();
  const refusedFetch = createFakeFetch(refused.handler);
  assert.equal((await invoke(run, args(), { env: env(), fetch: refusedFetch })).code, 0, "a refusal of the lookup does not stop the escalation");
  assert.match(refused.issues[0].body, /\| Failing command \| not determined \(see the run\) \|/);
  const explicit = tracker({ jobs });
  const explicitFetch = createFakeFetch(explicit.handler);
  assert.equal((await invoke(run, args(["--failing-command", "npm ci"]), { env: env(), fetch: explicitFetch })).code, 0);
  assert.equal(explicitFetch.requests.some((request) => request.path.includes("/actions/")), false, "a given command needs no lookup");
  assert.match(explicit.issues[0].body, /\| Failing command \| `npm ci` \|/);
});

const FAILED_RUN = { jobs: [{ name: "activation", conclusion: "success", steps: [] }, { name: "agent", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "npm run test:deck", conclusion: "failure" }] }] };

for (const key of DRIFT_KEYS) {
  test(`AC30: with the permissions that the compiled drift-${key}.lock.yml gives escalate_failure, a private central repository lets the script name the failing command`, async () => {
    const { permissions } = driftLock(key).workflow.jobs.escalate_failure;
    const allowed = tracker({ jobs: FAILED_RUN, permissions });
    const result = await invoke(run, args(), { env: env(), fetch: createFakeFetch(allowed.handler) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(allowed.issues[0].body, /\| Failing command \| `npm run test:deck` \|/, `the job holds ${JSON.stringify(permissions)}`);
    // the control: the permissions that the job held before (no actions: read) are refused the lookup, so the command was never named
    const without = tracker({ jobs: FAILED_RUN, permissions: { contents: "read", issues: "write" } });
    assert.equal((await invoke(run, args(), { env: env(), fetch: createFakeFetch(without.handler) })).code, 0);
    assert.match(without.issues[0].body, /\| Failing command \| not determined \(see the run\) \|/);
  });
}

test("AC32: a rate limit on the jobs lookup that outlasts the retries fails the step with exit 1 and opens no issue, instead of being read as 'not determined'", async () => {
  const { issues, handler } = tracker({ jobs: FAILED_RUN });
  const limited = createFakeFetch((entry) => (/\/actions\/runs\/\d+\/jobs$/.test(entry.path) ? json(429, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "1" }) : handler(entry)));
  const clock = createClock();
  const result = await invoke(run, args(["--max-retries", "2"]), { env: env(), fetch: limited, sleep: clock.sleep, now: clock.now });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /still rate limited after 2 retries/);
  assert.deepEqual(clock.waits, [1000, 1000], "each retry waited as the server stated");
  assert.equal(writes(limited).length, 0, "nothing was written with a command that could not be looked up");
  assert.equal(issues.length, 0);
  // a limit that clears is retried and the command is named
  let calls = 0;
  const recovering = tracker({ jobs: FAILED_RUN });
  const recoveringFetch = createFakeFetch((entry) => (/\/actions\/runs\/\d+\/jobs$/.test(entry.path) && (calls += 1) === 1 ? json(403, { message: "rate limit exceeded" }, { "retry-after": "2" }) : recovering.handler(entry)));
  const later = createClock();
  assert.equal((await invoke(run, args(), { env: env(), fetch: recoveringFetch, sleep: later.sleep, now: later.now })).code, 0);
  assert.deepEqual(later.waits, [2000]);
  assert.match(recovering.issues[0].body, /\| Failing command \| `npm run test:deck` \|/);
});

test("AC30: a run that cannot be found, or a lookup that the server fails, leaves the command 'not determined' and the issue is still opened", async () => {
  for (const reply of [json(404, { message: "Not Found" }), json(500, { message: "Server Error" }), json(200, { jobs: [] }), json(200, { jobs: [{ name: "agent", conclusion: "success", steps: [] }] })]) {
    const { issues, handler } = tracker();
    const fake = createFakeFetch((entry) => (/\/actions\/runs\/\d+\/jobs$/.test(entry.path) ? reply : handler(entry)));
    const result = await invoke(run, args(), { env: env(), fetch: fake });
    assert.equal(result.code, 0, `${reply.status}: ${result.stderr}`);
    assert.match(issues[0].body, /\| Failing command \| not determined \(see the run\) \|/, `${reply.status}`);
    assert.ok(issues[0].body.includes(RUN_URL), "and the run URL is the pointer");
  }
});

test("AC30: untrusted text in the arguments cannot break out of the issue: it stays in a code span and a link needs an http(s) address", async () => {
  const { issues, handler } = tracker();
  const result = await invoke(run, ["--workflow-id", "drift-x", "--target-repo", TARGET, "--correlation-id", "a`b\n## injected @everyone", "--run-url", "javascript:alert(1)", "--failing-command", "x`y\r\n\u0007z"], { env: env(), fetch: createFakeFetch(handler) });
  assert.equal(result.code, 0, result.stderr);
  const [{ body }] = issues;
  assert.equal(body.includes("javascript:"), false, "a run URL that is not http(s) is dropped");
  assert.match(body, /\| Run \| not provided \|/);
  assert.equal(/\n## injected/.test(body), false, "no heading is injected");
  assert.match(body, /correlation id `a'b ## injected @everyone`/);
  assert.match(body, /\| Failing command \| `x'y z` \|/);
});

test("AC30: the body keeps a bounded history and parses back what it wrote", () => {
  let body = null;
  for (let index = 1; index <= 25; index += 1) {
    body = composeBody({ workflowId: "drift-x", targetRepo: "o/r", failingCommand: "npm test", runUrl: `https://example.test/run/${index}`, correlationId: `c${index}`, nowMs: Date.UTC(2026, 10, 6, 12, 0, 0) + index * 1000, earlier: body === null ? null : readEarlierBody(body) });
  }
  const parsed = readEarlierBody(body);
  assert.equal(parsed.occurrences, 25);
  assert.equal(parsed.history.length, 20, "twenty entries at most");
  assert.ok(parsed.history[0].includes("c6") && parsed.history.at(-1).includes("c25"), "the oldest were dropped");
  assert.deepEqual(readEarlierBody(null), { history: [], occurrences: 0 });
  assert.deepEqual(readEarlierBody("a body that this script did not write"), { history: [], occurrences: 0 });
});

test("AC30: a missing token, a personal access token, a bad workflow id or repository and an API error each exit non-zero without a second write", async () => {
  const none = createFakeFetch(tracker().handler);
  assert.equal((await invoke(run, args(), { env: cleanEnv({ GITHUB_REPOSITORY: CENTRAL }), fetch: none })).code, 1, "no token");
  for (const token of ["ghp_personal", "github_pat_fixture", "gho_oauth"]) {
    const result = await invoke(run, args(), { env: env({ GH_TOKEN: token }), fetch: none });
    assert.equal(result.code, 1, token);
    assert.equal(result.stderr.includes(token), false);
  }
  assert.equal(none.requests.length, 0, "nothing was sent");
  assert.equal((await invoke(run, args(), { env: cleanEnv({ GH_TOKEN: "ghs_x" }), fetch: none })).code, 2, "GITHUB_REPOSITORY is required");
  assert.equal((await invoke(run, args(), { env: env({ GITHUB_REPOSITORY: "not-a-slug" }), fetch: none })).code, 2);
  assert.equal((await invoke(run, ["--workflow-id", "bad id", "--target-repo", TARGET], { env: env(), fetch: none })).code, 2);
  assert.equal((await invoke(run, ["--workflow-id", "drift-x", "--target-repo", "nope"], { env: env(), fetch: none })).code, 2);
  const broken = createFakeFetch((entry) => (entry.method === "GET" ? json(200, []) : json(500, { message: "Server Error" })));
  const clock = createClock();
  const failed = await invoke(run, args(["--failing-command", "x"]), { env: env(), fetch: broken, sleep: clock.sleep, now: clock.now });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /returned HTTP 500: Server Error/);
  assert.equal(writes(broken).length, 1, "the create is not repeated after a server error");
  const forbidden = createFakeFetch((entry) => (entry.method === "GET" ? json(200, []) : json(403, { message: "Resource not accessible by integration" })));
  assert.equal((await invoke(run, args(["--failing-command", "x"]), { env: env(), fetch: forbidden })).code, 1);
});

test("AC30: the command, run twice as a process against a stub server, opens one issue and then updates it", async () => {
  const { issues, handler } = tracker();
  const server = await startStubServer(handler);
  try {
    const environment = env({ GITHUB_API_URL: server.url });
    const first = await runNode(script("drift", "escalate-gate-failure.mjs"), args(["--failing-command", "npm test"]), { env: environment });
    assert.equal(first.code, 0, first.stderr);
    const second = await runNode(script("drift", "escalate-gate-failure.mjs"), args(["--failing-command", "npm test"]), { env: environment });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(issues.length, 1);
    assert.deepEqual(server.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`), [`POST ${base}/issues`, `PATCH ${base}/issues/1`]);
    assert.ok(server.requests.every((request) => request.path.startsWith(`${base}/`)), "no request outside /repos/<central repository>/");
    assert.equal(server.state.maxInflight, 1);
  } finally {
    await server.close();
  }
});

for (const key of DRIFT_KEYS) {
  test(`AC30: the rendered escalation step of drift-${key} opens the issue titled for its workflow and target when the runner runs it`, { skip: BASH_SKIP }, async () => {
    const step = driftWorkflow(key).frontmatter.jobs.escalate_failure.steps.find((candidate) => String(candidate.run ?? "").includes("escalate-gate-failure.mjs"));
    const { issues, handler } = tracker();
    const server = await startStubServer(handler);
    const gate = createGateWorkspace({ checkoutName: "unused", files: { "README.md": "x\n" } });
    try {
      const outcome = await gate.runSteps([step], { env: { GITHUB_REPOSITORY: CENTRAL, GITHUB_API_URL: server.url, CORRELATION_ID: "dispatch-9", RUN_URL } });
      assert.equal(outcome.code, 0, outcome.log);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].title, `[sdlc-failure] drift-${key} (${driftPreset(key).repo})`);
      assert.deepEqual(issues[0].labels.map((label) => label.name), ["sdlc-gate-failure"]);
      assert.ok(issues[0].body.includes("`dispatch-9`") && issues[0].body.includes(RUN_URL));
      assert.ok(server.requests.every((request) => request.path.startsWith(`${base}/`)));
    } finally {
      gate.cleanup();
      await server.close();
    }
  });
}

/** The first step of a job that is not one that gh-aw adds itself. */
const userSteps = (steps) => steps.filter((step) => !String(step.name ?? "").startsWith("Configure GH_HOST"));

for (const key of DRIFT_KEYS) {
  test(`AC30: the compiled drift-${key}.lock.yml has an escalate_failure job with the guard, needs, permissions, checkout and npm ci ahead of the script`, () => {
    const { workflow, header } = driftLock(key);
    const job = workflow.jobs.escalate_failure;
    assert.ok(job, "the job exists");
    assert.equal(job.if, "failure() && inputs.dry_run != true");
    assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"]);
    assert.deepEqual(job.permissions, { actions: "read", contents: "read", issues: "write" });
    assert.equal("concurrency" in job, false, "no job-level concurrency");
    const steps = userSteps(job.steps);
    const [checkout, install] = steps;
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/, "the checkout is pinned by the compiler");
    const pinned = header.actions.find((action) => action.repo === "actions/checkout" && checkout.uses.endsWith(action.sha));
    assert.equal(pinned.version, "v4", "and the pin is actions/checkout@v4");
    assert.equal(checkout.with["sparse-checkout"], "src\nschemas");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(install.run, "npm ci --ignore-scripts");
    const index = steps.findIndex((step) => String(step.run ?? "").includes("src/drift/escalate-gate-failure.mjs"));
    assert.ok(index >= 2, "the script step follows both");
    assert.deepEqual(steps.slice(0, 2), [checkout, install]);
    assert.equal(steps.some((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token")), false, "no App token: GITHUB_TOKEN with issues: write");
    assert.equal(steps[index].env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(frontmatter.jobs.escalate_failure.steps.slice(0, 2), [{ uses: "actions/checkout@v4", with: { "sparse-checkout": "src\nschemas", "persist-credentials": false } }, { run: "npm ci --ignore-scripts" }], "and so does the source");
  });

  test(`AC30: the escalation step of drift-${key} passes its identity to the script and no other repository is addressed`, () => {
    const { frontmatter } = driftWorkflow(key);
    const step = stepWith(frontmatter.jobs.escalate_failure.steps, "escalate-gate-failure.mjs");
    assert.equal(step.env.WORKFLOW_ID, `drift-${key}`);
    assert.equal(step.env.TARGET_REPO, driftPreset(key).repo);
    assert.ok(step.run.startsWith('node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs"'));
    assert.match(step.run, /--workflow-id "\$WORKFLOW_ID" --target-repo "\$TARGET_REPO" --correlation-id "\$CORRELATION_ID" --run-url "\$RUN_URL"/);
    assert.equal(step.env.RUN_URL, "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}");
    assert.equal(JSON.stringify(frontmatter.jobs.escalate_failure).includes("safe_outputs\"]"), true, "it runs after safe_outputs and never in its place");
  });
}
