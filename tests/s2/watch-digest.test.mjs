// The digest of a watched source and the comparison with the previous run's watch index (SPEC-02 AC11, AC41-AC43).
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndex,
  compareWithPrevious,
  digestSnapshot,
  extractCitations,
  FIRST_RUN_ENTRY_LIMIT,
  htmlToText,
  rankCitations,
  renderChangesMarkdown,
} from "../../src/drift/lib/watch-digest.mjs";

const bytes = (text) => Buffer.from(text, "utf8");
const html = (contentType = "text/html") => contentType;

/** A changelog index the way github.blog serves it: site chrome, then one <article> per entry with a permalink, label links and a <time>. */
function changelogPage(entries, { chrome = "Blog home" } = {}) {
  const articles = entries
    .map(
      ([slug, title, date]) =>
        `<article class="post"><h3><a href="https://github.blog/changelog/${slug}">${title}</a></h3>` +
        `<a href="https://github.blog/changelog/2026/?label=copilot">copilot</a><time datetime="${date}">${date}</time><p>Summary of ${title}.</p></article>`,
    )
    .join("\n");
  return `<!doctype html><html><head><title>Changelog</title><script>var build = "${chrome}";</script></head><body>` +
    `<header><a href="https://github.blog">${chrome}</a></header><nav><a href="/changelog/feed/">Feed</a></nav><main>${articles}</main>` +
    `<footer><a href="https://github.com/about">About</a></footer></body></html>`;
}

/** A documentation page: navigation (outside and inside <main>), the article and a footer. */
function docsPage(paragraph, links = [], { script = "x" } = {}) {
  const items = links.map(([href, title]) => `<li><a href="${href}">${title}</a></li>`).join("");
  return `<html><body><header>Docs header</header><nav aria-label="products"><a href="/en/other">Other product</a></nav>` +
    `<main><nav aria-label="breadcrumbs"><a href="/en">Home</a></nav><h1>Enterprise administration</h1><p>${paragraph}</p>` +
    `<ul>${items}<li><a href="https://example.org/elsewhere">Off-site</a></li><li><a href="#section">Same page</a></li></ul>` +
    `<script>window.__state = "${script}";</script></main><footer>Footer &copy; GitHub</footer></body></html>`;
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Changelog</title>
<item><title>Actions for ARM32 Linux &#038; Windows retirement</title><link>https://github.blog/changelog/2026-11-12-actions-for-arm32-retirement</link>
<guid isPermaLink="false">https://github.blog/changelog/2026-11-12-actions-for-arm32-retirement</guid><pubDate>Thu, 12 Nov 2026 20:59:36 +0000</pubDate>
<content:encoded><![CDATA[<!DOCTYPE html><html><body><p>GitHub Actions retires the <strong>ARM32</strong> runners on December 1.</p><script>tracking()</script></body></html>]]></content:encoded></item>
<item><title><![CDATA[Copilot memory is generally available]]></title><link>https://github.blog/changelog/2026-11-10-copilot-memory-ga</link>
<pubDate>Tue, 10 Nov 2026 16:00:00 +0000</pubDate><description><![CDATA[<p>Copilot memory is now GA.</p>]]></description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes</title>
<entry><id>tag:github.com,2008:Repository/1/v1.0.111</id><updated>2026-11-13T13:40:16Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/github/copilot-cli/releases/tag/v1.0.111"/><title>1.0.111</title>
<content type="html">&lt;ul&gt;&lt;li&gt;Add regular expression support to permission rules&lt;/li&gt;&lt;/ul&gt;</content></entry>
</feed>`;

test("htmlToText drops scripts, styles and SVG, breaks lines at block elements, decodes entities and collapses whitespace", () => {
  const text = htmlToText("<div>Fish &amp; chips<script>alert(1)</script><style>p{}</style></div><svg><text>logo</text></svg><p>A&nbsp;&nbsp;b &#8212; c &#x2019;d&#039;</p><br>tail");
  assert.equal(text, "Fish & chips\nA b \u2014 c \u2019d'\ntail");
});

test("an index of <article> entries gives one entry per article: the permalink, its title and its date, never the label links or the site chrome", () => {
  const digest = digestSnapshot({ url: "https://github.blog/changelog/", kind: "changelog", contentType: html(), bytes: bytes(changelogPage([["2026-11-13-a", "Entry A &amp; more", "2026-11-13"], ["2026-11-12-b", "Entry B", "2026-11-12"]])) });
  assert.deepEqual(digest.entries, [
    { url: "https://github.blog/changelog/2026-11-13-a", title: "Entry A & more", date: "2026-11-13" },
    { url: "https://github.blog/changelog/2026-11-12-b", title: "Entry B", date: "2026-11-12" },
  ]);
  assert.match(digest.textSha256, /^[0-9a-f]{64}$/);
  assert.equal(digest.text.includes("Blog home"), false, "the header is not part of the text");
});

test("the text hash of a page ignores scripts and the navigation around the main content", () => {
  const url = "https://docs.github.com/en/enterprise-cloud@latest/admin";
  const a = digestSnapshot({ url, kind: "docs", contentType: html(), bytes: bytes(docsPage("Admins manage policies.", [], { script: "build-1" })) });
  const b = digestSnapshot({ url, kind: "docs", contentType: html(), bytes: bytes(docsPage("Admins manage policies.", [], { script: "build-2" }).replace("Other product", "Renamed product")) });
  const c = digestSnapshot({ url, kind: "docs", contentType: html(), bytes: bytes(docsPage("Admins manage rulesets.", [])) });
  assert.equal(a.textSha256, b.textSha256, "a new build id or a changed product menu is not a change of the page");
  assert.notEqual(a.textSha256, c.textSha256, "a changed sentence is");
  assert.equal(a.text, "Enterprise administration\nAdmins manage policies.\nOff-site\nSame page");
});

test("a page without <article> entries lists the same-host links of its main content, resolved, without fragments, off-site links or the page itself", () => {
  const url = "https://docs.github.com/en/enterprise-cloud@latest/admin";
  const digest = digestSnapshot({
    url,
    kind: "docs",
    contentType: html(),
    bytes: bytes(docsPage("x", [["/en/enterprise-cloud@latest/admin/new-article#intro", "New article"], ["https://docs.github.com/en/enterprise-cloud@latest/admin", "This page"], ["/en/enterprise-cloud@latest/admin/new-article", "Duplicate"]])),
  });
  assert.deepEqual(digest.entries, [{ url: "https://docs.github.com/en/enterprise-cloud@latest/admin/new-article", title: "New article", date: null }]);
});

test("an RSS feed gives its items with the link, the decoded title, the publication date and an excerpt of the content", () => {
  const digest = digestSnapshot({ url: "https://github.blog/changelog/feed/", kind: "feed", contentType: "application/rss+xml", bytes: bytes(RSS) });
  assert.deepEqual(digest.entries, [
    { url: "https://github.blog/changelog/2026-11-12-actions-for-arm32-retirement", title: "Actions for ARM32 Linux & Windows retirement", date: "2026-11-12", excerpt: "GitHub Actions retires the ARM32 runners on December 1." },
    { url: "https://github.blog/changelog/2026-11-10-copilot-memory-ga", title: "Copilot memory is generally available", date: "2026-11-10", excerpt: "Copilot memory is now GA." },
  ]);
});

test("an Atom feed is read the same way, whatever content type the server names, and its escaped HTML content becomes text", () => {
  const digest = digestSnapshot({ url: "https://github.com/github/copilot-cli/releases.atom", kind: "release-notes", contentType: "text/html", bytes: bytes(ATOM) });
  assert.deepEqual(digest.entries, [{ url: "https://github.com/github/copilot-cli/releases/tag/v1.0.111", title: "1.0.111", date: "2026-11-13", excerpt: "Add regular expression support to permission rules" }]);
});

test("a long excerpt is cut at a word boundary", () => {
  const long = `<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://e.test/a</link><description>${"word ".repeat(200)}</description></item></channel></rss>`;
  const [entry] = digestSnapshot({ url: "https://e.test/feed", kind: "feed", contentType: "application/xml", bytes: bytes(long) }).entries;
  assert.ok(entry.excerpt.length <= 361, String(entry.excerpt.length));
  assert.match(entry.excerpt, /word\u2026$/);
});

test("citations: only the named hosts, case-insensitively, without fragment, trailing punctuation or trailing slash, counted per URL", () => {
  const found = extractCitations(
    "See [the docs](https://docs.github.com/en/admin/policies#rulesets). Also https://DOCS.github.com/en/admin/policies/, https://docs.github.com/en/billing?tool=webui. " +
      "Not https://github.blog/changelog/ and not https://docs.github.com.evil.test/x.",
    ["docs.github.com"],
  );
  assert.deepEqual(found, ["https://docs.github.com/en/admin/policies", "https://docs.github.com/en/admin/policies", "https://docs.github.com/en/billing?tool=webui"]);
});

test("rankCitations orders by the number of citations, then by URL, caps the list, and names the citing files sorted", () => {
  const ranked = rankCitations(
    new Map([
      ["labs/lab02.md", ["https://d.test/b", "https://d.test/a", "https://d.test/a"]],
      ["docs/01.md", ["https://d.test/b", "https://d.test/c"]],
      ["labs/lab01.md", ["https://d.test/b"]],
    ]),
    2,
  );
  assert.deepEqual(ranked, [
    { url: "https://d.test/b", citations: 3, citedBy: ["docs/01.md", "labs/lab01.md", "labs/lab02.md"] },
    { url: "https://d.test/a", citations: 2, citedBy: ["labs/lab02.md"] },
  ]);
});

const FEED = { url: "https://github.blog/changelog/feed/", label: "Changelog feed", kind: "feed" };
const INDEX_PAGE = { url: "https://github.blog/changelog/", label: "Changelog", kind: "changelog" };
const DOCS = { url: "https://docs.github.com/en/admin", label: "Admin docs", kind: "docs" };
const entry = (slug, extra = {}) => ({ url: `https://github.blog/changelog/${slug}`, title: `Title ${slug}`, date: null, ...extra });

function current({ feed = [], index = [], docsText = "same", docsLinks = [], cited = [] } = {}) {
  return {
    project: "p",
    sources: [
      { ...FEED, state: "ok", textSha256: `feed-${feed.map((e) => e.url).join()}`, entries: feed },
      { ...INDEX_PAGE, state: "ok", textSha256: `index-${index.map((e) => e.url).join()}`, entries: index },
      { ...DOCS, state: "ok", textSha256: `docs-${docsText}`, entries: docsLinks },
    ],
    citedPages: cited,
  };
}

test("without a previous index every entry source offers its most recent entries, documentation pages offer none, and cited pages are first seen", () => {
  const many = Array.from({ length: FIRST_RUN_ENTRY_LIMIT + 5 }, (_, i) => entry(`2026-11-${String(i + 1).padStart(2, "0")}-x`));
  const now = current({ feed: many, docsLinks: [{ url: "https://docs.github.com/en/admin/a", title: "A", date: null }], cited: [{ url: "https://docs.github.com/en/x", state: "ok", textSha256: "1", citations: 4, citedBy: ["labs/lab01.md"], snapshot: "sources/cited/x.txt" }] });
  const changes = compareWithPrevious({ current: now, previous: null, baseline: { found: false, reason: "no earlier run" } });
  assert.equal(changes.newEntries.length, FIRST_RUN_ENTRY_LIMIT);
  assert.deepEqual(changes.newEntries[0].sources, ["Changelog feed"]);
  assert.deepEqual(changes.sources.map((s) => [s.url, s.status]), [[DOCS.url, "first-seen"], [INDEX_PAGE.url, "first-seen"], [FEED.url, "first-seen"]]);
  assert.deepEqual(changes.citedPages.map((p) => p.status), ["first-seen"]);
  assert.deepEqual(changes.summary, { newEntries: FIRST_RUN_ENTRY_LIMIT, changedSources: 0, changedCitedPages: 0, firstSeenSources: 3, firstSeenCitedPages: 1, failed: 0 });
});

test("with a previous index only new entries are listed, each once with every source that lists it, and changed pages and cited pages are named", () => {
  const before = current({
    feed: [entry("old")],
    index: [entry("old")],
    docsText: "v1",
    docsLinks: [{ url: "https://docs.github.com/en/admin/a", title: "A", date: null }],
    cited: [
      { url: "https://docs.github.com/en/x", state: "ok", textSha256: "1" },
      { url: "https://docs.github.com/en/y", state: "ok", textSha256: "2" },
      { url: "https://docs.github.com/en/z", state: "ok", textSha256: "3" },
    ],
  });
  const previous = buildIndex(before);
  const now = current({
    feed: [entry("new", { date: "2026-11-13", excerpt: "From the feed." }), entry("old")],
    index: [entry("new", { title: "Index title" }), entry("other"), entry("old")],
    docsText: "v2",
    docsLinks: [{ url: "https://docs.github.com/en/admin/a", title: "A", date: null }, { url: "https://docs.github.com/en/admin/b", title: "B", date: null }],
    cited: [
      { url: "https://docs.github.com/en/x", state: "ok", textSha256: "1-changed", citations: 3, citedBy: ["docs/02.md", "labs/lab01.md"], snapshot: "sources/cited/x.txt" },
      { url: "https://docs.github.com/en/y", state: "ok", textSha256: "2", citations: 1, citedBy: ["labs/lab03.md"], snapshot: "sources/cited/y.txt" },
      { url: "https://docs.github.com/en/z", state: "failed", error: "HTTP 404", citations: 1, citedBy: ["labs/lab04.md"], snapshot: null },
    ],
  });
  const changes = compareWithPrevious({ current: now, previous, baseline: { found: true, runId: 42, runUrl: "https://github.com/o/r/actions/runs/42", createdAt: "2026-11-09T22:47:51Z" } });
  assert.deepEqual(
    changes.newEntries.map((e) => [e.url.split("/").pop(), e.title, e.date, e.excerpt ?? null, e.sources]),
    [
      ["new", "Index title", "2026-11-13", "From the feed.", ["Changelog", "Changelog feed"]],
      ["other", "Title other", null, null, ["Changelog"]],
    ],
    "sources are walked in URL order; a later source fills the date and the excerpt that an earlier one lacked",
  );
  const docs = changes.sources.find((s) => s.url === DOCS.url);
  assert.deepEqual([docs.status, docs.textChanged, docs.newLinks], ["changed", true, [{ url: "https://docs.github.com/en/admin/b", title: "B" }]]);
  assert.deepEqual(changes.citedPages.map((p) => [p.url.split("/").pop(), p.status]), [["x", "changed"], ["y", "unchanged"], ["z", "failed"]]);
  assert.deepEqual(changes.summary, { newEntries: 2, changedSources: 3, changedCitedPages: 1, firstSeenSources: 0, firstSeenCitedPages: 0, failed: 1 });
});

test("a source that failed in the previous run is first seen when it answers again, and a source that fails now is reported, not compared", () => {
  const before = current({ index: [entry("a")] });
  before.sources[1] = { ...INDEX_PAGE, state: "failed", error: "HTTP 503" };
  const now = current({ index: [entry("a")] });
  now.sources[0] = { ...FEED, state: "failed", error: "timed out after 30000 ms" };
  const changes = compareWithPrevious({ current: now, previous: buildIndex(before), baseline: { found: true, runId: 1, runUrl: "u", createdAt: "t" } });
  assert.deepEqual(changes.sources.map((s) => [s.url, s.status]), [[DOCS.url, "unchanged"], [INDEX_PAGE.url, "first-seen"], [FEED.url, "failed"]]);
  assert.deepEqual(changes.failed, [{ url: FEED.url, label: "Changelog feed", error: "timed out after 30000 ms" }]);
  assert.deepEqual(changes.newEntries.map((e) => e.url.split("/").pop()), ["a"]);
});

test("the watch index is sorted, holds only what the next run compares, and is the same value for the same input", () => {
  const now = current({ feed: [entry("b"), entry("a"), entry("b")], cited: [{ url: "https://d.test/2", state: "ok", textSha256: "x", citations: 1, citedBy: ["f"] }, { url: "https://d.test/1", state: "failed", error: "e" }] });
  const index = buildIndex(now);
  assert.deepEqual(Object.keys(index), ["version", "project", "sources", "citedPages"]);
  assert.deepEqual(index.sources.map((s) => s.url), [DOCS.url, INDEX_PAGE.url, FEED.url]);
  assert.deepEqual(index.sources[2], { url: FEED.url, kind: "feed", state: "ok", textSha256: now.sources[0].textSha256, entries: [entry("a").url, entry("b").url] });
  assert.deepEqual(index.citedPages, [{ url: "https://d.test/1", state: "failed", textSha256: null }, { url: "https://d.test/2", state: "ok", textSha256: "x" }]);
  assert.deepEqual(buildIndex(structuredClone(now)), index);
});

test("changes.md is the agent's work list: the baseline, the new entries, the changed pages, the failures and the counts, capped and deterministic", () => {
  const before = current({ index: [entry("old")], docsText: "v1", cited: [{ url: "https://docs.github.com/en/x", state: "ok", textSha256: "1" }] });
  const newLinks = Array.from({ length: 45 }, (_, i) => ({ url: `https://docs.github.com/en/admin/n${String(i).padStart(2, "0")}`, title: `N${i}`, date: null }));
  const now = current({
    feed: [entry("new", { date: "2026-11-13", excerpt: "Excerpt text." })],
    index: [entry("new"), entry("old")],
    docsText: "v2",
    docsLinks: newLinks,
    cited: [{ url: "https://docs.github.com/en/x", state: "ok", textSha256: "2", citations: 12, citedBy: ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"], citedByCount: 6, snapshot: "sources/cited/x.txt" }],
  });
  now.sources[0] = { ...now.sources[0] };
  const changes = compareWithPrevious({ current: now, previous: buildIndex(before), baseline: { found: true, runId: 7, runUrl: "https://github.com/o/r/actions/runs/7", createdAt: "2026-11-09T22:47:51Z" } });
  const markdown = renderChangesMarkdown(changes);
  assert.equal(renderChangesMarkdown(structuredClone(changes)), markdown, "deterministic");
  assert.ok(markdown.startsWith("# Watched-source changes: p\n"), markdown.slice(0, 80));
  assert.match(markdown, /Baseline: the watch index of run 7 \(https:\/\/github\.com\/o\/r\/actions\/runs\/7\), created 2026-11-09T22:47:51Z\./);
  assert.match(markdown, /## New entries \(1\)\n\n1\. \[Title new\]\(https:\/\/github\.blog\/changelog\/new\) — 2026-11-13 — Changelog, Changelog feed\n {3}> Excerpt text\./);
  assert.match(markdown, /## Changed pages \(1\)/, "entry sources are represented by their new entries, not listed again as changed pages");
  assert.match(markdown, /- \[Admin docs\]\(https:\/\/docs\.github\.com\/en\/admin\) \(docs\): the text changed; 45 new links: \[N0\]/);
  assert.match(markdown, /\(\+5 more in changes\.json\)/);
  assert.match(markdown, /## Changed cited pages \(1\)\n\n- https:\/\/docs\.github\.com\/en\/x — cited 12 times by a\.md, b\.md, c\.md, d\.md, e\.md \(\+1 more file\); text in `sources\/cited\/x\.txt`/);
  assert.match(markdown, /## Unchanged\n\n0 watched sources and 0 cited pages are unchanged\./);
  const firstRun = renderChangesMarkdown(compareWithPrevious({ current: now, previous: null, baseline: { found: false, reason: "no successful earlier run has a watch index" } }));
  assert.match(firstRun, /Baseline: none \(no successful earlier run has a watch index\)\. This run records the first watch index: each changelog, feed, release-notes and blog source lists at most its 15 most recent entries, and pages are compared from the next run on\./);
});
