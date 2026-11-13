// AC42 and AC43: the snapshot step compares this run with the previous run's watch index, and snapshots the pages that the target cites.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../../src/snapshot-watch-sources.mjs";
import { hashTree, listTree, tempDir } from "./helpers/fixtures.mjs";
import { invoke } from "./helpers/run-script.mjs";
import { createFakeFetch } from "./helpers/stub-server.mjs";

const FEED = "https://news.example.test/feed/";
const DOCS = "https://docs.example.test";

const item = (slug, title, day) =>
  `<item><title>${title}</title><link>https://news.example.test/${slug}</link><pubDate>${day} Nov 2026 10:00:00 +0000</pubDate><description><![CDATA[<p>About ${title}.</p>]]></description></item>`;
const feedOf = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>${items.join("")}</channel></rss>`;
const docsPage = (title, sentence) => `<html><body><nav><a href="/x">Menu</a></nav><main><h1>${title}</h1><p>${sentence}</p></main></body></html>`;

/** A drift workspace: sdlc.yaml with one feed and a citedPages block, and a checkout whose labs cite pages of docs.example.test. */
function workspaceWith({ maxPages = 2, labs } = {}) {
  const root = tempDir("sdlc-s2-delta-");
  const manifest = path.join(root, "sdlc.yaml");
  fs.writeFileSync(
    manifest,
    [
      "projects:",
      "  - projectKey: delta",
      "    repo: example-owner/target",
      "    driftAudit:",
      "      knowledgeSources:",
      "        watchUrls:",
      `          - url: ${FEED}`,
      "            label: News feed",
      "            kind: feed",
      "        packageManifests: []",
      "        citedPages:",
      "          include: [labs/**/*.md, README.md]",
      "          hosts: [docs.example.test]",
      `          maxPages: ${maxPages}`,
      "        mcpServers: {}",
      "",
    ].join("\n"),
  );
  const checkout = path.join(root, "target");
  const files = labs ?? {
    "labs/lab01.md": `See ${DOCS}/a and ${DOCS}/b#step-2 and ${DOCS}/a/.`,
    "labs/lab02.md": `Read [the guide](${DOCS}/a), then https://other.example.test/ignored.`,
    "labs/notes.txt": `${DOCS}/not-included`,
    "README.md": `${DOCS}/c`,
  };
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
    fs.writeFileSync(path.join(checkout, relative), text);
  }
  return { root, manifest, checkout, out: (name) => path.join(root, name), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function pages({ items, docs = {}, failing = [] }) {
  return createFakeFetch((entry) => {
    if (entry.url === FEED) return { status: 200, headers: { "content-type": "application/rss+xml" }, body: feedOf(items) };
    if (failing.includes(entry.url)) return { status: 503, body: "busy" };
    const page = docs[entry.url];
    return page ? { status: 200, headers: { "content-type": "text/html" }, body: page } : { status: 404, body: "missing" };
  });
}

const DOCS_V1 = { [`${DOCS}/a`]: docsPage("A", "Policies apply to every organization."), [`${DOCS}/b`]: docsPage("B", "Rulesets protect branches.") };
const args = (workspace, out, extra = []) => ["--out", out, "--project", "delta", "--manifest", workspace.manifest, "--checkout", workspace.checkout, "--timeout-ms", "500", ...extra];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Makes the output of one run the --previous of the next, the way the workflow does through the artifact and previous-watch-index.mjs. */
function previousFrom(out, directory, runId) {
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(out, "sources", "watch-index.json"), path.join(directory, "watch-index.json"));
  fs.writeFileSync(path.join(directory, "baseline.json"), JSON.stringify({ found: true, runId, runUrl: `https://github.com/o/r/actions/runs/${runId}`, createdAt: "2026-11-09T13:23:00Z", artifactId: 1, workflow: "drift-delta.lock.yml", artifact: "sdlc-watch-index-delta" }));
  return directory;
}

test("AC43: the pages that included files cite on the named hosts are snapshotted as text, the most cited first, at most maxPages, with the files that cite them", async () => {
  const workspace = workspaceWith();
  try {
    const out = workspace.out("run1");
    const fetch = pages({ items: [item("one", "One", 10)], docs: DOCS_V1 });
    const result = await invoke(run, args(workspace, out), { fetch });
    assert.equal(result.code, 0, result.stderr);
    const { citedPages } = readJson(path.join(out, "sources", "manifest.json"));
    assert.deepEqual(
      { include: citedPages.include, hosts: citedPages.hosts, maxPages: citedPages.maxPages, scannedFiles: citedPages.scannedFiles, citedUrls: citedPages.citedUrls },
      { include: ["labs/**/*.md", "README.md"], hosts: ["docs.example.test"], maxPages: 2, scannedFiles: 3, citedUrls: 3 },
      "labs/notes.txt is not included, the other host is ignored, a fragment and a trailing slash do not make another page",
    );
    assert.deepEqual(
      citedPages.pages.map((page) => [page.url, page.citations, page.citedBy, page.state]),
      [
        [`${DOCS}/a`, 3, ["labs/lab01.md", "labs/lab02.md"], "ok"],
        [`${DOCS}/b`, 1, ["labs/lab01.md"], "ok"],
      ],
      "README.md's page /c is the third most cited and maxPages is 2",
    );
    assert.equal(fs.readFileSync(path.join(out, ...citedPages.pages[0].snapshot.split("/")), "utf8"), "A\nPolicies apply to every organization.\n", "the text of the main content, not the HTML");
    assert.match(citedPages.pages[0].snapshot, /^sources\/cited\/docs\.example\.test-[0-9a-f]{12}\.txt$/);
    assert.deepEqual(fetch.requests.map((request) => request.url), [FEED, `${DOCS}/a`, `${DOCS}/b`], "the watched URLs first, then the cited pages in rank order, one at a time");
    assert.equal(fetch.state.maxInflight, 1);
  } finally {
    workspace.cleanup();
  }
});

test("AC42: without a previous index the work list says so and offers the most recent entries; the next run with that index lists only what is new", async () => {
  const workspace = workspaceWith();
  try {
    const first = workspace.out("run1");
    assert.equal((await invoke(run, args(workspace, first), { fetch: pages({ items: [item("two", "Two", 11), item("one", "One", 10)], docs: DOCS_V1 }) })).code, 0);
    const firstChanges = fs.readFileSync(path.join(first, "sources", "changes.md"), "utf8");
    assert.match(firstChanges, /^Baseline: none \(no previous watch index was given \(--previous\)\)\./m);
    assert.match(firstChanges, /## New entries \(2\)\n\n1\. \[Two\]\(https:\/\/news\.example\.test\/two\) — 2026-11-11 — News feed\n {3}> About Two\.\n2\. \[One\]/);
    assert.match(firstChanges, /2 cited pages are seen for the first time/);

    const previous = previousFrom(first, workspace.out("previous"), 101);
    const second = workspace.out("run2");
    const docsV2 = { ...DOCS_V1, [`${DOCS}/b`]: docsPage("B", "Rulesets protect branches and tags.") };
    const result = await invoke(run, args(workspace, second, ["--previous", previous]), { fetch: pages({ items: [item("three", "Three", 12), item("two", "Two", 11), item("one", "One", 10)], docs: docsV2 }) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /since run 101: 1 new entry, 1 changed source\(s\), 1 changed cited page\(s\)/);
    const changes = readJson(path.join(second, "sources", "changes.json"));
    assert.deepEqual(changes.baseline, { found: true, runId: 101, runUrl: "https://github.com/o/r/actions/runs/101", createdAt: "2026-11-09T13:23:00Z" });
    assert.deepEqual(changes.newEntries.map((entry) => entry.title), ["Three"]);
    assert.deepEqual(changes.citedPages.map((page) => [page.url, page.status]), [[`${DOCS}/a`, "unchanged"], [`${DOCS}/b`, "changed"]]);
    const markdown = fs.readFileSync(path.join(second, "sources", "changes.md"), "utf8");
    assert.match(markdown, /## Changed cited pages \(1\)\n\n- https:\/\/docs\.example\.test\/b — cited 1 time by labs\/lab01\.md; text in `sources\/cited\//);
  } finally {
    workspace.cleanup();
  }
});

test("AC42: when nothing changed since the previous run the work list is empty, and the same inputs give the same bytes", async () => {
  const workspace = workspaceWith();
  try {
    const fetch = () => pages({ items: [item("one", "One", 10)], docs: DOCS_V1 });
    const first = workspace.out("run1");
    assert.equal((await invoke(run, args(workspace, first), { fetch: fetch() })).code, 0);
    const previous = previousFrom(first, workspace.out("previous"), 7);
    const second = workspace.out("run2");
    assert.equal((await invoke(run, args(workspace, second, ["--previous", previous]), { fetch: fetch() })).code, 0);
    const summary = readJson(path.join(second, "sources", "changes.json")).summary;
    assert.deepEqual(summary, { newEntries: 0, changedSources: 0, changedCitedPages: 0, firstSeenSources: 0, firstSeenCitedPages: 0, failed: 0 });
    assert.deepEqual(readJson(path.join(second, "sources", "watch-index.json")), readJson(path.join(first, "sources", "watch-index.json")), "an unchanged world gives an unchanged index");
    const hashes = hashTree(second);
    assert.equal((await invoke(run, args(workspace, second, ["--previous", previous]), { fetch: fetch() })).code, 0);
    assert.equal(hashTree(second), hashes, "byte-identical output on a second run with the same inputs");
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:/.test(fs.readFileSync(path.join(second, "sources", "watch-index.json"), "utf8")), false, "the index holds no timestamp");
  } finally {
    workspace.cleanup();
  }
});

test("AC42, AC43: a cited page that cannot be fetched, a baseline that was not found and a budget that runs out are reported, never guessed", async () => {
  const workspace = workspaceWith({ maxPages: 3 });
  try {
    const previous = workspace.out("previous");
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "baseline.json"), JSON.stringify({ found: false, reason: "no successful run of drift-delta.lock.yml among the last 20 has an unexpired artifact named sdlc-watch-index-delta" }));
    const out = workspace.out("run");
    const result = await invoke(run, args(workspace, out, ["--previous", previous]), { fetch: pages({ items: [], docs: DOCS_V1, failing: [`${DOCS}/c`] }) });
    assert.equal(result.code, 0, result.stderr);
    const manifest = readJson(path.join(out, "sources", "manifest.json"));
    assert.deepEqual(manifest.citedPages.pages.map((page) => [page.url, page.state, page.error]), [[`${DOCS}/a`, "ok", null], [`${DOCS}/b`, "ok", null], [`${DOCS}/c`, "failed", "HTTP 503"]]);
    assert.ok(manifest.limitations.includes(`${DOCS}/c (cited page): HTTP 503`));
    const markdown = fs.readFileSync(path.join(out, "sources", "changes.md"), "utf8");
    assert.match(markdown, /Baseline: none \(no successful run of drift-delta\.lock\.yml among the last 20 has an unexpired artifact named sdlc-watch-index-delta\)/);
    assert.match(markdown, /## Could not fetch \(1\)\n\n- https:\/\/docs\.example\.test\/c \(cited page\): HTTP 503/);

    const budget = workspace.out("budget");
    assert.equal((await invoke(run, args(workspace, budget, ["--cited-budget-ms", "0"]), { fetch: pages({ items: [], docs: DOCS_V1 }) })).code, 0);
    const skipped = readJson(path.join(budget, "sources", "manifest.json"));
    assert.deepEqual(skipped.citedPages.pages.map((page) => page.state), ["skipped", "skipped", "skipped"]);
    assert.ok(skipped.limitations.includes("3 cited page(s) were not fetched: the 0 s budget for cited pages ran out"));
    assert.equal(listTree(budget).some((file) => file.startsWith("sources/cited/")), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC43: a citedPages block needs the target checkout, like the package manifests", async () => {
  const workspace = workspaceWith();
  try {
    const result = await invoke(run, ["--out", workspace.out("x"), "--project", "delta", "--manifest", workspace.manifest, "--checkout", path.join(workspace.root, "missing")], { fetch: pages({ items: [] }) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the target checkout '.*missing' does not exist/);
  } finally {
    workspace.cleanup();
  }
});
