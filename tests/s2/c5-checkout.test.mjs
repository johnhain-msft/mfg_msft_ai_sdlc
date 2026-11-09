// AC9: contract C5 request, checkout. Each run checks out the target repository into a workspace subdirectory through the rendered `checkout:`
// entry, authenticated with the GitHub App installation token, before any pre-agent step reads the target; a cross-repository
// create-pull-request requires that checkout. No workflow and no repository variable is required in the target repository, and no personal
// access token authenticates the checkout or any GitHub API call of S2.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { run as escalate } from "../../src/drift/escalate-gate-failure.mjs";
import { DRIFT_KEYS, driftLock, driftPreset, driftWorkflow, driftWorkflowText, presetManifest, tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./helpers/stub-server.mjs";

const nameOf = (slug) => slug.slice(slug.indexOf("/") + 1);

for (const key of DRIFT_KEYS) {
  test(`AC9: drift-${key}.md has exactly one checkout entry for its target repository, in a subdirectory, with App credentials`, () => {
    const { frontmatter } = driftWorkflow(key);
    const target = frontmatter["safe-outputs"]["create-pull-request"]["target-repo"];
    const entries = frontmatter.checkout.filter((entry) => entry.repository === target);
    assert.equal(entries.length, 1, "exactly one entry for the target");
    assert.equal(frontmatter.checkout.length, 1);
    const [entry] = entries;
    assert.ok(typeof entry.path === "string" && entry.path !== "" && entry.path !== "." && !entry.path.startsWith("/") && !entry.path.includes("..") && !/^[A-Za-z]:/.test(entry.path), `path '${entry.path}' is a subdirectory`);
    assert.equal(entry.path, nameOf(target), "named after the repository, as the checkout step and the scripts expect");
    assert.ok(entry["github-app"]["client-id"] && entry["github-app"]["private-key"], "the github-app block holds client-id and private-key");
    assert.equal(entry["github-app"]["client-id"], "${{ vars.APP_CLIENT_ID }}");
    assert.equal(entry["github-app"]["private-key"], "${{ secrets.APP_PRIVATE_KEY }}");
    assert.equal(entry.current, true);
  });

  test(`AC9: every pre-agent step of drift-${key} that reads the target uses the checkout path`, () => {
    const { frontmatter } = driftWorkflow(key);
    const [{ path: checkoutPath, repository }] = frontmatter.checkout;
    const [prepare, deduplicate, snapshot] = frontmatter["pre-agent-steps"];
    const named = (step) => /--checkout (\S+)/.exec(step.run)?.[1];
    assert.equal(named(snapshot), checkoutPath, "the snapshot step names the checkout path");
    assert.equal(snapshot.env.CONFIGURED_TARGET_REPO, repository);
    assert.equal(named(prepare), undefined, "prepare-run derives it: <workspace>/<repository name>");
    assert.equal(nameOf(prepare.env.CONFIGURED_TARGET_REPO), checkoutPath, "from the configured repository, which names the same directory");
    assert.equal(named(deduplicate), undefined, "the deduplication reads the target through the API, not the checkout");
    assert.equal(deduplicate.env.CONFIGURED_TARGET_REPO, repository);
    for (const step of [prepare, deduplicate, snapshot]) assert.equal(step.env.CONFIGURED_TARGET_REPO, repository, `${step.name}: one target`);
    // a step after the three S2 scripts is the install of the dependencies of this very target: it runs in its checkout and is given no variable or credential
    for (const step of frontmatter["pre-agent-steps"].slice(3)) {
      assert.equal(step["working-directory"], checkoutPath, `${step.name}: runs in the checkout of the target`);
      assert.equal("env" in step, false, `${step.name}: holds no variable or credential`);
      assert.equal(step.run, "npm ci --ignore-scripts", `${step.name}: installs without running the lifecycle scripts of the target`);
    }
  });

  test(`AC9: the compiled drift-${key}.lock.yml checks the target out with an App installation token, into that path, and writes no personal credential into a step`, () => {
    const lock = driftLock(key);
    const steps = lock.workflow.jobs.agent.steps;
    const target = driftPreset(key).repo;
    const mint = steps.find((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token"));
    assert.ok(mint, "an App token is minted for the checkout");
    assert.equal(mint.with["client-id"], "${{ vars.APP_CLIENT_ID }}");
    assert.equal(mint.with["private-key"], "${{ secrets.APP_PRIVATE_KEY }}");
    const checkout = steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout") && step.with?.repository === target);
    assert.ok(checkout, `a checkout of ${target}`);
    assert.equal(checkout.with.path, nameOf(target));
    assert.equal(checkout.with.token, `\${{ steps.${mint.id}.outputs.token }}`, "authenticated with that token");
    assert.equal(checkout.with["persist-credentials"], false);
  });

  test(`AC9: nothing in drift-${key} authenticates the checkout or an S2 step with a personal access token, and the target needs no variable`, () => {
    const { frontmatter } = driftWorkflow(key);
    const s2Surface = JSON.stringify({ checkout: frontmatter.checkout, pre: frontmatter["pre-agent-steps"], escalation: frontmatter.jobs.escalate_failure, outputs: frontmatter["safe-outputs"] });
    assert.equal(/PAT\b|_PAT_|personal|github-token|GH_AW_GITHUB_TOKEN|GH_PAT/i.test(s2Surface), false, "no personal access token reference");
    const secrets = [...s2Surface.matchAll(/secrets\.([A-Za-z_]+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(secrets)].sort(), ["APP_PRIVATE_KEY", "GITHUB_TOKEN"], "the App key and the job's GITHUB_TOKEN only");
    const variables = [...driftWorkflowText(key).matchAll(/vars\.([A-Za-z_]+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(variables)], ["APP_CLIENT_ID"], "the only variable is the orchestrator's App client id, never one of the target");
  });
}

test("AC9: the target repositories need no workflow: the fleet's workflows all live in this repository and none is generated for a target", () => {
  const manifest = presetManifest();
  for (const project of manifest.projects) assert.equal(project.deconflictInRepoSchedules, "none", `${project.projectKey}: no in-repo schedule is touched`);
  for (const key of DRIFT_KEYS) assert.equal(driftWorkflow(key).frontmatter.checkout.length, 1);
});

test("AC9: the scripts accept an App installation token and nothing else for the deduplication read and for the escalation: every other kind is refused before any request", async () => {
  // a personal access token (classic and fine-grained), an OAuth token, a user access token of an App (it acts as a user), a refresh token,
  // a token of the format that had no prefix, and a string that is no token
  const refused = ["ghp_pat", "github_pat_fixture", "gho_oauth", "ghu_appusertoken", "ghr_refreshtoken", "0123456789abcdef0123456789abcdef01234567", "not-a-github-token"];
  for (const token of refused) {
    const fake = createFakeFetch(() => json(200, []));
    const read = await invoke(dedupe, ["--out", "unused"], { env: cleanEnv({ CONFIGURED_TARGET_REPO: "example-owner/example-target", GH_APP_INSTALLATION_TOKEN: token }), fetch: fake });
    assert.equal(read.code, 1, `dedupe ${token}`);
    const escalation = await invoke(escalate, ["--workflow-id", "drift-x", "--target-repo", "example-owner/example-target"], { env: cleanEnv({ GITHUB_REPOSITORY: "example-owner/example-central", GH_TOKEN: token }), fetch: fake });
    assert.equal(escalation.code, 1, `escalate ${token}`);
    assert.equal(fake.requests.length, 0, `${token}: no request carries it`);
    assert.equal(`${read.stderr}${escalation.stderr}`.includes(token), false, `${token} is not echoed`);
  }
  // the control: with an installation token (also in the stateless format `ghs_<app id>_<JWT>`, which is no 40-character token) the same two calls send their
  // requests, so that the loop above is a refusal of the kind of the token and not of every call
  for (const token of ["ghs_installationtoken", "ghs_1234567_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl"]) {
    const read = createFakeFetch(() => json(200, []));
    const directory = path.join(tempDir("sdlc-s2-installation-token-"), "agent");
    assert.equal((await invoke(dedupe, ["--out", directory], { env: cleanEnv({ CONFIGURED_TARGET_REPO: "example-owner/example-target", GH_APP_INSTALLATION_TOKEN: token }), fetch: read })).code, 0, `dedupe ${token}`);
    assert.deepEqual(read.requests.map((request) => request.headers.authorization), [`Bearer ${token}`]);
    const issues = createFakeFetch((entry) => (entry.method === "GET" ? json(200, []) : json(201, { number: 1 })));
    assert.equal((await invoke(escalate, ["--workflow-id", "drift-x", "--target-repo", "example-owner/example-target"], { env: cleanEnv({ GITHUB_REPOSITORY: "example-owner/example-central", GH_TOKEN: token }), fetch: issues })).code, 0, `escalate ${token}`);
    assert.deepEqual(issues.requests.map((request) => request.method), ["GET", "POST"]);
    assert.ok(issues.requests.every((request) => request.headers.authorization === `Bearer ${token}`));
  }
});
