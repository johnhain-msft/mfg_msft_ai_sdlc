// Re-review of R5: exercise the scanner alternatives changed by the boundary fix, not just ghp_/github_pat_.
// Credentials are synthetic and assembled at runtime; integrations use disposable repositories and the offline API.
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { assertNoCredentials } from "../../bin/lib/instructions-file.mjs";
import { reconcile } from "../../src/reconcile.mjs";
import { createScenario, fixtureRepos, recordFsWrites, sha256Tree } from "./helpers/harness.mjs";

const SAMPLE = "A1b2C3d4E5f6G7h8I9j0";
const HEX = "0123456789abcdef".repeat(2);
const SHA = "4".repeat(40);
const github = (prefix) => [prefix, SAMPLE.repeat(2)].join("_");
const fineGrained = ["github", "pat", SAMPLE.repeat(3)].join("_");
const aws = (prefix) => `${prefix}${"Z".repeat(16)}`;
const fastGh = async (args) => ({ code: 0, stdout: args[0] === "aw" && args[1] === "version" ? "gh aw version v1.0.1\n" : "", stderr: "" });

const variants = [
  ...["ghu", "ghr"].map((prefix) => [`GitHub ${prefix}`, github(prefix)]),
  ...["ASIA", "AGPA", "AIDA", "AIPA", "ANPA", "ANVA", "AROA", "ABIA", "ACCA"].map((prefix) => [`AWS ${prefix}`, aws(prefix)]),
  ["OpenAI unscoped", `sk-${SAMPLE.repeat(2)}`],
  ["OpenAI service account", `sk-${"svcacct-"}${SAMPLE.repeat(2)}`],
  ["OpenAI admin", `sk-${"admin-"}${SAMPLE.repeat(2)}`],
  ...["a", "e", "o", "p", "r", "s"].map((type) => [`Slack ${type}`, `xox${type}-${SAMPLE}`]),
  ...[["r", "live"], ["r", "test"], ["s", "test"]].map(([type, mode]) => [`Stripe ${type}/${mode}`, `${type}k_${mode}_${SAMPLE}`]),
  ...["ca", "pa", "ss"].map((type) => [`Shopify ${type}`, `shp${type}_${HEX}`]),
  ["Azure Service Bus", `SharedAccessKey=${SAMPLE.repeat(2)}`],
  ...["Basic", "Token"].map((scheme) => [`Authorization ${scheme}`, `Authorization: ${scheme} ${SAMPLE}`]),
];

for (const [label, token] of variants) {
  test(`R5 QA r2 variants: ${label} is rejected after underscores and before suffixes`, () => {
    const refused = (error) => error.code === "instructions-credential" && !error.message.includes(token);
    assert.throws(() => assertNoCredentials(token, "standalone positive control"), refused);
    for (const text of [`backup_${token}`, `${token}_old`, `packages/backup_${token}_old/package.json`]) {
      assert.throws(() => assertNoCredentials(text, "inspected value"), refused);
    }
  });
}

const fixedLength = [
  ["AWS ID", aws("AKIA")],
  ["npm", ["npm", "Z".repeat(36)].join("_")],
  ["DigitalOcean", `dop_v1_${"a1".repeat(32)}`],
  ["Databricks", `dapi${HEX}`],
  ["Twilio", `SK${HEX}`],
  ["Shopify", `shpat_${HEX}`],
  ["Telegram", `123456789:AA${"Z".repeat(33)}`],
];

for (const [label, token] of fixedLength) {
  test(`R5 QA r2 controls: ${label} retains alphanumeric boundaries and its exact length`, () => {
    assert.throws(() => assertNoCredentials(token, "standalone positive control"), (error) => error.code === "instructions-credential");
    // Underscores delimit a credential, but letters/digits make these fixed-length formats a different, longer word.
    // A Telegram ID permits 8-10 digits, so prepend two digits to its nine-digit positive control.
    const digitPrefixed = `${label === "Telegram" ? "77" : "7"}${token}`;
    for (const text of [`a${token}`, digitPrefixed, `${token}Z`, `${token}7`, token.slice(0, -1)]) {
      assert.doesNotThrow(() => assertNoCredentials(text, "ordinary near-match"));
    }
  });
}

const pathCases = [
  ["user token glued to a package directory prefix", github("ghu"), "manifest", (token) => `packages/Backup7${token}/package.json`],
  ["refresh token glued to a workflow prefix", github("ghr"), "workflow", (token) => `.github/workflows/Backup7${token}.yml`],
  ["fine-grained PAT glued to an upstream provenance prefix", fineGrained, "upstream", (token) => `public/Backup7${token}/source.json`],
  ["fine-grained PAT glued to a downstream provenance prefix", fineGrained, "downstream", (token) => `public/Backup7${token}/source.json`],
  ["fixed-length AWS key between a downstream prefix and suffix", aws("AKIA"), "downstream", (token) => `public/backup_${token}_old/source.json`],
  ["fixed-length npm token between a package prefix and suffix", fixedLength.find(([label]) => label === "npm")[1], "manifest", (token) => `packages/backup_${token}_old/package.json`],
];

for (const [label, token, kind, fileOf] of pathCases) {
  test(`R5 QA r2 effects: ${label} is refused before files, state or S1`, async () => {
    const repositories = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
    const files = repositories[kind === "downstream" ? "example-owner/edge-ok" : "example-owner/node-app"].files;
    if (kind === "downstream") delete files["public/imported/source.json"];
    files[fileOf(token)] = kind === "manifest" ? "{}" : kind === "workflow" ? "on:\n  schedule:\n    - cron: '0 5 * * 0'\n" : JSON.stringify({ commit: SHA });
    const scenario = await createScenario({ fake: { repos: repositories } });
    try {
      const before = sha256Tree(scenario.workspace.dir);
      const { result: run, writes } = await recordFsWrites(() => scenario.onboard([
        "--repo", "example-owner/node-app",
        ...(kind === "downstream" ? ["--downstream", "example-owner/edge-ok"] : []),
      ], { env: scenario.env(scenario.appCredentials()), runGh: fastGh }));
      assert.notEqual(run.code, 0, "a credential must cause refusal, not merely be omitted from facts");
      assert.match(run.stderr, /appears to contain a credential/);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr.includes(token), false);
      assert.deepEqual(writes, [], "refusal precedes even a temporary output file");
      assert.equal(sha256Tree(scenario.workspace.dir), before, "all repository bytes are preserved");
      assert.equal(scenario.workspace.exists("instructions/node-app.md"), false);
      assert.equal(scenario.reconcile.calls.length, 0);
      assert.deepEqual(scenario.fake.nonGet(), [], "no state or credential is sent to GitHub");
    } finally {
      await scenario.cleanup();
    }
  });
}

test("R5 QA r2 benign: long ordinary paths still onboard through real S1 and replay without rewriting state", async () => {
  const packagePath = "packages/task-description-for-the-long-running-migration-job/package.json";
  const provenancePath = "public/risk_test_assessmentreportsforthequarter/source.json";
  const repositories = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/edge-ok": "edge-ok" });
  repositories["example-owner/node-app"].files[packagePath] = "{}";
  const downstream = repositories["example-owner/edge-ok"].files;
  delete downstream["public/imported/source.json"];
  downstream[provenancePath] = JSON.stringify({ commit: SHA });
  const scenario = await createScenario({ fake: { repos: repositories } });
  try {
    const reconciliations = [];
    const run = () => scenario.onboard(["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"], {
      env: scenario.env(scenario.appCredentials()),
      runGh: fastGh,
      reconcile: async (request, options) => {
        const result = await reconcile(request, options);
        reconciliations.push(result);
        return result;
      },
    });
    const first = await run();
    assert.equal(first.code, 0, first.stderr);
    assert.equal(reconciliations.length, 1);
    assert.equal(reconciliations[0].status, "ok", JSON.stringify(reconciliations[0].validationResults));
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    assert.ok(data.projects.find((project) => project.projectKey === "node-app").driftAudit.knowledgeSources.packageManifests.includes(packagePath));
    assert.equal(data.dependencyEdges.find((edge) => edge.edgeId === "node-app").provenanceFile, provenancePath);
    assert.ok(scenario.workspace.read("instructions/node-app.md").includes(packagePath));
    for (const artifact of reconciliations[0].generatedWorkflows) {
      assert.equal(scenario.workspace.exists(artifact.sourceMd), true);
      assert.ok(scenario.workspace.read(artifact.lockYml).includes("# sha256:"), "S1 actually invoked its compiler");
    }
    const variable = "SDLC_SYNC_STATE_NODE_APP";
    const state = scenario.fake.variablesOf("example-owner/example-repo")[variable];
    assert.equal(JSON.parse(state).lastMergedUpstreamSha, SHA);
    assert.equal(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").length, 1);
    const manifest = scenario.workspace.read("sdlc.yaml");
    const instructions = scenario.workspace.read("instructions/node-app.md");
    const second = await run();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(reconciliations.length, 2);
    assert.equal(reconciliations[1].status, "ok");
    assert.equal(scenario.workspace.read("sdlc.yaml"), manifest);
    assert.equal(scenario.workspace.read("instructions/node-app.md"), instructions);
    assert.equal(scenario.fake.variablesOf("example-owner/example-repo")[variable], state);
    assert.equal(scenario.fake.requests("POST /repos/:owner/:repo/actions/variables").length, 1);
  } finally {
    await scenario.cleanup();
  }
});
