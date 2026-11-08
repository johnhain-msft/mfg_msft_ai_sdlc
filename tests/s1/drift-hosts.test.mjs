// AC24: network.allowed is the exact, lower-cased, de-duplicated, sorted hostname list of the watched URLs.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks, renderFleet } from "../../src/reconcile.mjs";
import { mutate, parseWorkflow, presetManifest, projectOf, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const entry = (url) => ({ url, label: `watch ${url}`, kind: "docs" });

async function render(urls, { mutateManifest } = {}) {
  const manifest = mutate(presetManifest(), (copy) => {
    projectOf(copy, "gh-admin-msft").driftAudit.knowledgeSources.watchUrls = urls.map(entry);
    mutateManifest?.(copy);
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  return { workspace, manifest };
}

test("AC24: mixed-case, repeated and unsorted hosts yield a lower-cased, de-duplicated, sorted list", async () => {
  const { workspace } = await render(["https://Docs.GitHub.com/a", "https://github.blog/changelog/", "https://docs.github.com/b"]);
  try {
    const rendered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(rendered.ok, JSON.stringify(rendered.result));
    const { frontmatter } = parseWorkflow(rendered.files.get(".github/workflows/drift-gh-admin-msft.md"));
    assert.deepEqual(frontmatter.network.allowed, ["docs.github.com", "github.blog"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC24: no scheme, port, path, query or wildcard reaches network.allowed", async () => {
  const { workspace } = await render([
    "https://example.com:8443/path?q=1#frag",
    "https://sub.Example.org",
    "https://user@host.example.net/x",
    "https://zeta.example.com/",
    "https://alpha.example.com/",
  ]);
  try {
    const rendered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(rendered.ok, JSON.stringify(rendered.result));
    const { frontmatter } = parseWorkflow(rendered.files.get(".github/workflows/drift-gh-admin-msft.md"));
    assert.deepEqual(frontmatter.network.allowed, ["alpha.example.com", "example.com", "host.example.net", "sub.example.org", "zeta.example.com"]);
    for (const host of frontmatter.network.allowed) assert.match(host, /^[a-z0-9.-]+$/);
  } finally {
    workspace.cleanup();
  }
});

test("AC24: allowedNetworkDomains in the acknowledgement is network.allowed as rendered", async () => {
  const { workspace } = await render(["https://Docs.GitHub.com/a", "https://github.blog/changelog/"]);
  try {
    const rendered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    const { frontmatter } = parseWorkflow(rendered.files.get(".github/workflows/drift-gh-admin-msft.md"));
    const ack = buildAcks(referenceRequest(), { cwd: workspace.dir }).drift.find((item) => item.workflowId === "drift-gh-admin-msft");
    assert.deepEqual(ack.allowedNetworkDomains, frontmatter.network.allowed);
    assert.deepEqual(ack.allowedNetworkDomains, ["docs.github.com", "github.blog"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC24: the watched URLs are the only source of network.allowed (MCP server hosts are not added)", () => {
  const manifest = presetManifest();
  const project = projectOf(manifest, "gh-admin-msft");
  assert.ok(JSON.stringify(project.driftAudit.knowledgeSources.mcpServers).includes("learn.microsoft.com"));
  const rendered = renderFleet(referenceRequest(), { cwd: process.cwd() });
  const { frontmatter } = parseWorkflow(rendered.files.get(".github/workflows/drift-gh-admin-msft.md"));
  assert.deepEqual(frontmatter.network.allowed, ["docs.github.com", "github.blog"]);
});

test("AC24: a project without watched URLs gets an empty list", async () => {
  const { workspace } = await render([], {});
  try {
    const rendered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(rendered.ok);
    const { frontmatter } = parseWorkflow(rendered.files.get(".github/workflows/drift-gh-admin-msft.md"));
    assert.deepEqual(frontmatter.network.allowed, []);
  } finally {
    workspace.cleanup();
  }
});

for (const url of ["https://*.github.com/", "http://example.com/", "not a url", "https://", "ftp://example.com/", "https://exa*mple.com/", "//example.com/", ""]) {
  test(`AC24: the watched URL ${JSON.stringify(url)} is rejected before any file is written`, async () => {
    const { workspace } = await render([url]);
    try {
      const before = workspace.hash();
      const result = await workspace.reconcile(referenceRequest());
      assert.equal(result.status, "error");
      const errors = result.validationResults.flatMap((item) => item.errors);
      assert.ok(errors.some((error) => /^drift-watch-url-invalid: /.test(error) && error.includes("'gh-admin-msft'")), errors.join("\n"));
      assert.ok(errors.some((error) => error.includes(url)), errors.join("\n"));
      assert.equal(workspace.hash(), before);
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC24: one invalid URL among valid ones still rejects the whole run", async () => {
  const { workspace } = await render(["https://github.blog/changelog/", "https://*.github.com/"]);
  try {
    const result = await workspace.reconcile(referenceRequest());
    assert.equal(result.status, "error");
    assert.equal(workspace.list(".github/workflows").length, 0);
  } finally {
    workspace.cleanup();
  }
});

test("AC24: URLs of a disabled project are neither validated nor extracted", () => {
  const manifest = mutate(presetManifest(), (copy) => {
    projectOf(copy, "portfolio").driftAudit.knowledgeSources.watchUrls = [entry("https://*.never-rendered.example/")];
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const rendered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(rendered.ok, JSON.stringify(rendered.result));
    assert.equal(rendered.files.has(".github/workflows/drift-portfolio.md"), false);
    assert.equal([...rendered.files.values()].some((text) => text.includes("never-rendered")), false);
  } finally {
    workspace.cleanup();
  }
});
