// AC13: contract C5 request, corroboration (gated by OQ34). The agent corroborates changelog and blog updates, library version upgrades and
// framework pattern migrations through the context7 and microsoft-learn MCP servers declared under knowledgeSources.mcpServers (rendered into
// mcp-servers) and through web-fetch, enabled in the tools key next to a bash allowlist that contains git and the first word of each
// buildCommands entry. Native tools.web-search is not relied on. This criterion asserts no engine comparison: which engines support a
// per-command bash allowlist is OQ34 and stays open here; the test only asserts that an engine key is rendered.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, driftWorkflowText, readText, WORKFLOWS } from "./helpers/fixtures.mjs";

const sorted = (value) => (Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);

for (const key of DRIFT_KEYS) {
  test(`AC13: the rendered mcp-servers of drift-${key} hold microsoft-learn and context7, equal to the project's knowledgeSources.mcpServers`, () => {
    const servers = driftWorkflow(key).frontmatter["mcp-servers"];
    assert.ok("microsoft-learn" in servers && "context7" in servers, "both servers");
    assert.deepEqual(sorted(servers), sorted(driftPreset(key).driftAudit.knowledgeSources.mcpServers));
    assert.deepEqual(servers["microsoft-learn"], { type: "http", url: "https://learn.microsoft.com/api/mcp" }, "microsoft-learn is an http server at the Learn endpoint");
    assert.deepEqual(servers.context7, { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] }, "context7 is an npx server running @upstash/context7-mcp");
  });

  test(`AC13: tools of drift-${key} enables web-fetch with a bash list that contains git and node, and the frontmatter has an engine key`, () => {
    const { frontmatter } = driftWorkflow(key);
    assert.ok("web-fetch" in frontmatter.tools, "web-fetch is enabled");
    assert.ok(Array.isArray(frontmatter.tools.bash));
    assert.ok(frontmatter.tools.bash.includes("git") && frontmatter.tools.bash.includes("node"));
    for (const command of driftPreset(key).driftAudit.buildCommands) assert.ok(frontmatter.tools.bash.includes(command.trim().split(/\s+/)[0]), `the first word of ${command}`);
    assert.ok(frontmatter.engine, "an engine key is rendered");
    assert.ok(typeof frontmatter.engine === "string" || typeof frontmatter.engine.id === "string");
    assert.equal("web-search" in frontmatter.tools, false, "native web search is not enabled");
  });

  test(`AC13: nothing in drift-${key}.md or its lock relies on web-search`, () => {
    assert.equal(driftWorkflowText(key).includes("web-search"), false, `${WORKFLOWS}/drift-${key}.md`);
    assert.equal(/webSearch\\?":true/.test(fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8")), false, "the compiled tool configuration does not turn web search on");
    assert.match(fs.readFileSync(abs(WORKFLOWS, `drift-${key}.lock.yml`), "utf8"), /webSearch\\?":false/, "and says so explicitly");
  });
}

test("AC13: the prompt tells the agent to corroborate every proposed change through the two servers or by fetching the cited page", () => {
  const sentence = readText(abs("prompts", "drift", "corroboration.md")).trim();
  for (const key of DRIFT_KEYS) assert.ok(driftWorkflow(key).body.includes(sentence), `${key}: ${sentence}`);
  assert.match(sentence, /Microsoft Learn and Context7 servers or by fetching the cited page/);
});

test("AC13, AC43: the network allowlist holds the watched and cited hostnames only, so that web-fetch reaches the pages the project names and nothing else", () => {
  for (const key of DRIFT_KEYS) {
    const sources = driftPreset(key).driftAudit.knowledgeSources;
    const hosts = new Set([...sources.watchUrls.map((entry) => new URL(entry.url).hostname), ...(sources.citedPages?.hosts ?? [])]);
    assert.deepEqual(new Set(driftWorkflow(key).frontmatter.network.allowed), hosts, key);
  }
});
