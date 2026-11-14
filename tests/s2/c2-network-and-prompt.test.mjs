// AC3: contract C2 request, derived configuration. The literal hostnames of knowledgeSources.watchUrls and of citedPages.hosts are in
// network.allowed (no wildcard), the prompt body carries the instruction text and the upkeepStrategy value, the frontmatter has exactly the
// twelve keys, and pre-agent-steps holds exactly the five S2 steps in order (AC41), followed by the install of the dependencies of the
// target only for a project whose agentSandbox asks for it.
import assert from "node:assert/strict";
import test from "node:test";
import { abs, customJobsOf, DRIFT_KEYS, driftPreset, driftWorkflow, readText } from "./helpers/fixtures.mjs";

const TWELVE_KEYS = ["checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools"];
const hostnamesOf = (project) => [
  ...project.driftAudit.knowledgeSources.watchUrls.map((entry) => new URL(entry.url).hostname),
  ...(project.driftAudit.knowledgeSources.citedPages?.hosts ?? []),
];

for (const key of DRIFT_KEYS) {
  test(`AC3: drift-${key}.md allows every watched and cited hostname and no wildcard`, () => {
    const { frontmatter } = driftWorkflow(key);
    const project = driftPreset(key);
    const allowed = frontmatter.network.allowed;
    for (const host of hostnamesOf(project)) assert.ok(allowed.includes(host), `${host} is in network.allowed`);
    assert.deepEqual([...allowed].sort(), [...new Set(hostnamesOf(project))].sort(), "network.allowed holds exactly the watched and cited hostnames");
    for (const entry of allowed) assert.equal(entry.includes("*"), false, `${entry} has no wildcard`);
  });

  test(`AC3: the prompt body of drift-${key}.md carries the instruction text and the upkeepStrategy value`, () => {
    const { body } = driftWorkflow(key);
    const audit = driftPreset(key).driftAudit;
    assert.ok(body.includes(audit.instructions.trim()), "the inline instructions");
    assert.ok(body.includes(readText(abs(audit.instructionsFile)).replace(/\s+$/, "")), "the text of the instructions file, unmodified");
    assert.ok(body.includes(`## Upkeep strategy: ${audit.upkeepStrategy}`), "the upkeepStrategy value");
    for (const entry of audit.knowledgeSources.watchUrls) assert.ok(body.includes(entry.url), `the prompt lists ${entry.url}`);
    for (const pattern of audit.knowledgeSources.packageManifests) assert.ok(body.includes(`\`${pattern}\``), `the prompt lists the pattern ${pattern}`);
  });

  test(`AC3: drift-${key}.md has exactly the twelve top-level keys and the five S2 pre-agent-steps in order, and after them the dependency install only when its project asks for it`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(Object.keys(frontmatter).sort(), TWELVE_KEYS);
    const steps = frontmatter["pre-agent-steps"];
    const project = driftPreset(key);
    const installs = project.driftAudit.agentSandbox?.installDependencies === true;
    assert.equal(steps.length, installs ? 6 : 5, installs ? "the five S2 steps and the install" : "exactly five pre-agent steps");
    assert.ok(steps[0].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs"'), steps[0].run);
    assert.ok(steps[1].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs"'), steps[1].run);
    assert.ok(steps[2].run.startsWith('node "$GITHUB_WORKSPACE/src/drift/previous-watch-index.mjs"'), steps[2].run);
    assert.ok(steps[3].run.startsWith('node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs"'), steps[3].run);
    assert.ok(steps[3].run.includes(" --previous /tmp/gh-aw/agent/previous"), "the snapshot compares with the index that the step before it fetched");
    assert.deepEqual([steps[4].uses, steps[4].if, steps[4].with.name], ["actions/upload-artifact@v4", "inputs.dry_run != true", `sdlc-watch-index-${key}`], "the index of a run that is not a dry run is kept for the next one");
    assert.equal(steps.filter((step) => String(step.run).includes("snapshot-watch-sources.mjs")).length, 1, "one snapshot invocation covers every watchUrls, packageManifests and citedPages entry");
    if (installs) {
      assert.deepEqual(steps[5], { name: "Install target checkout dependencies for in-sandbox validation", "working-directory": project.repo.split("/")[1], run: "npm ci --ignore-scripts" });
    }
    assert.deepEqual(Object.keys(customJobsOf(frontmatter.jobs)), ["escalate_failure", "implement_report"], "jobs holds only escalate_failure and implement_report besides the built-in guards");
    const start = frontmatter.jobs.implement_report;
    assert.deepEqual([start.needs, start.if, start.permissions], [["safe_outputs"], "needs.safe_outputs.result == 'success' && needs.safe_outputs.outputs.created_issue_number != '' && inputs.dry_run != true", { actions: "write" }], "AC46: it starts after a report was filed, with the right to dispatch and no other");
    assert.equal(start.steps.length, 1);
    assert.equal(start.steps[0].env.WORKFLOW_FILE, `implement-${key}.lock.yml`, "AC46: it starts the implementation workflow of the same project");
    assert.equal(start.steps[0].env.REPORT_ISSUE, "${{ needs.safe_outputs.outputs.created_issue_number }}", "AC46: with the number of the report that this run filed");
    assert.match(start.steps[0].run, /^gh workflow run "\$WORKFLOW_FILE" --repo "\$GITHUB_REPOSITORY" --ref "\$GITHUB_REF_NAME" -f report_issue="\$REPORT_ISSUE" -f correlation_id="\$CORRELATION_ID"$/);
  });

  test(`AC3: post-steps of drift-${key}.md are the project's verifyCommands in order`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.deepEqual(frontmatter["post-steps"].map((step) => step.run), driftPreset(key).driftAudit.verifyCommands);
  });

  test(`AC42, AC44: the prompt of drift-${key}.md makes changes.md the work list and asks for a drift report of what someone has to act on, and for none when nothing is`, () => {
    const { body } = driftWorkflow(key);
    assert.match(body, /## What changed since the last run\n\nStart with `\/tmp\/gh-aw\/agent\/sources\/changes\.md`\./);
    assert.match(body, /That list is your work list, and every item of it gets a decision\./);
    assert.match(
      body,
      /When a source's first page lists none of the entries that the baseline knew, the snapshot step has read its older pages until one does, up to a limit; a source that still does not reach the baseline is listed under `## Possible gaps` with the period that neither run saw\. Open the older pages of that source for that period yourself, decide those entries as well, and name the gap under `## Limitations` when you cannot\./,
      "a possible gap is work too, never a silent hole in the list",
    );
    assert.match(body, /- `## Limitations`: the sources that could not be fetched, the possible gaps that you could not close and the checks that could not run\./);
    assert.match(body, /A long list is no reason to skip items: decide each one\./);
    assert.match(body, /An item that does not concern this repository is not relevant: count it, but do not list it in the report\./, "the report lists no item that is not relevant");
    assert.equal(/needs one line that says why/.test(body), false, "and no longer asks for a line for each of them");
    assert.match(
      body,
      /fetch an entry or a page with the `web_fetch` tool whenever its excerpt is not enough to decide \(the shell has no `curl`, `wget` or `gh`, and refuses a redirection or a heredoc; the hosts of the watched URLs and of the cited pages are reachable\)/,
      "live run 43558253314 tried curl, was refused, and concluded that it could not fetch: name the tool that can",
    );
    assert.match(body, /## Drift report\n\nFile a drift report when at least one item of the work list is applied, recommended or could not be confirmed: exactly one `create_issue` call,/);
    assert.ok(body.includes(`a run of the workflow \`implement-${key}\` researches every item under \`## Recommended\` and \`## Could not confirm\` again and opens one pull request that closes the report`), "the agent knows that the report starts its implementation (AC46)");
    assert.match(body, /When every item is not relevant, or the work list is empty, file no report: call `noop` with one line that says how many items you triaged and which baseline you compared with\./);
    assert.ok(body.includes(`Title it \`Drift report: ${key} YYYY-MM-DD\``));
    const sections = ["## Summary", "## Applied", "## Recommended", "## Could not confirm", "## Limitations"].map((section) => body.indexOf(`- \`${section}\``));
    assert.ok(sections.every((at) => at > 0), "every section is described");
    assert.deepEqual([...sections].sort((a, b) => a - b), sections, "in this order");
    assert.match(body, /one line that counts the items that you triaged as not relevant \(never list them\)/);
    assert.match(body, /- `## Recommended`: a task list \(`- \[ \] `\)/);
    assert.match(body, /- `## Could not confirm`: a task list \(`- \[ \] `\)/);
    assert.match(body, /Each item says what to change, names the files that it concerns and links its source\./, "an item stands on its own, because the implementation run starts from the report alone");
    for (const gone of ["## Watched-source changes", "## Recommendations"]) assert.equal(body.includes(`- \`${gone}\``), false, `${gone} is gone`);
    assert.match(body, /content that the sources announce and this repository does not cover yet/, "recommendations include what to add, not only what to fix");
    assert.match(body, /In a dry run call neither: `\/tmp\/gh-aw\/agent\/dry-run-proposal\.json` exists already with `null` under `proposal` and `report`; replace the `null` of `report` with the report that you would have filed/);
    assert.match(body, /`report` with the report that you would have filed, `\{ "title": \.\.\., "body": \.\.\. \}`, using the edit tool: the shell of this workflow refuses a redirection or a heredoc\. Leave it `null` when you would have filed none\./, "the dry run names the tool that can write the file");
    assert.match(
      body,
      /When the registration instructions above define a report of their own \(such as `docs\/_meta\/audit-report\.md` or `self-improvement-report\.md`\), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it;/,
      "a project's own report is written on every run, so that its validator finds it",
    );
    assert.match(body, /the body of the issue is that report followed by the sections below other than `## Summary`\./);
    const order = ["## Watched sources", "## What changed since the last run", "## Drift report", "## Operating rules"].map((heading) => body.indexOf(heading));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the sections come in this order");
    const cited = driftPreset(key).driftAudit.knowledgeSources.citedPages;
    assert.equal(body.includes("/tmp/gh-aw/agent/sources/cited/"), Boolean(cited), "the cited pages are described where they are snapshotted, and only there");
    if (cited) for (const value of [...cited.include, ...cited.hosts]) assert.ok(body.includes(`\`${value}\``), value);
  });
}

test("AC3: no network.allowed entry of any drift workflow contains a wildcard", () => {
  for (const key of DRIFT_KEYS) for (const entry of driftWorkflow(key).frontmatter.network.allowed) assert.doesNotMatch(entry, /\*/, `${key}: ${entry}`);
});
