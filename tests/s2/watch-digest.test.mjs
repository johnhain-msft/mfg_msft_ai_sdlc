// The digest of a watched source and the comparison with the previous run's watch index (SPEC-02 AC11, AC41-AC43).
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndex,
  compareWithPrevious,
  digestSnapshot,
  extractCitations,
  FIRST_RUN_ENTRY_LIMIT,
  textFromHtml,
  rankCitations,
  renderChangesMarkdown,
} from "../../src/drift/lib/watch-digest.mjs";

const bytes = (text) => Buffer.from(text, "utf8");
const html = (contentType = "text/html") => contentType;

/** A changelog index the way github.blog serves it: site chrome, then one <article> per entry with a permalink, label links and a <time>. */
function changelogPage(entries, { chrome = "Blog home", next = null } = {}) {
  const articles = entries
    .map(
      ([slug, title, date]) =>
        `<article class="post"><h3><a href="https://github.blog/changelog/${slug}">${title}</a></h3>` +
        `<a href="https://github.blog/changelog/2026/?label=copilot">copilot</a><time datetime="${date}">${date}</time><p>Summary of ${title}.</p></article>`,
    )
    .join("\n");
  const older = next === null ? "" : `<link rel="next" href="${next}" />`;
  return `<!doctype html><html><head><title>Changelog</title>${older}<script>var build = "${chrome}";</script></head><body>` +
    `<header><a href="https://github.blog">${chrome}</a></header><nav><a href="/changelog/feed/">Feed</a></nav><main>${articles}</main>` +
    `<footer><a href="https://github.com/about">About</a></footer></body></html>`;
}

/**
 * A release page the way github.com serves it (github/gh-aw/releases, 2026-11-13): one <section data-release-anchor> per release with the
 * link of its tag, a compare menu, its date in a <relative-time>, a commit link, its notes in a markdown-body (whose own <div>s nest), a
 * "Read more" link and a footer with the assets and another <relative-time>; then the pagination.
 */
function releasesPage(releases, { next = "/github/gh-aw/releases?page=2" } = {}) {
  const sections = releases
    .map(
      ([tag, date, notes]) =>
        `<section id="release-${tag}" aria-labelledby="hd-${tag}" data-release-anchor="release-${tag}" style="scroll-margin-top: 24px;">` +
        `<h2 class="sr-only" id="hd-${tag}">${tag}</h2><div class="Box"><div class="Box-body">` +
        `<span class="tmp-mr-3 f1 text-bold d-inline"><a href="/github/gh-aw/releases/tag/${tag}" class="Link--primary Link">${tag}</a></span>` +
        `<span class="Label Label--warning">Pre-release</span><select-panel><button type="button"><span>Compare</span></button>` +
        `<a href="/github/gh-aw/compare/${tag}...main">Compare with main</a></select-panel>` +
        `<relative-time class="no-wrap" prefix="" datetime="${date}T04:25:04Z"></relative-time><a href="/github/gh-aw/commit/0123abc">0123abc</a>` +
        `<div data-pjax="true" data-test-selector="body-content" class="markdown-body tmp-my-3">${notes}</div>` +
        `<a href="/github/gh-aw/releases/tag/${tag}" class="Link">Read more</a></div>` +
        `<div class="Box-footer"><details open><summary>Assets 3</summary><a href="/github/gh-aw/archive/refs/tags/${tag}.zip">Source code (zip)</a>` +
        `<relative-time datetime="2026-01-01T00:00:00Z"></relative-time></details></div></div></section>`,
    )
    .join("");
  const pagination = next === null ? "" : `<div class="paginate-container"><a class="next_page" aria-label="Next page" rel="next" href="${next}">Next</a></div>`;
  return `<!doctype html><html><head><title>Releases · github/gh-aw</title></head><body><header><a href="/github">GitHub</a></header>` +
    `<main><section aria-label="Releases results"><div data-pjax>${sections}</div></section>${pagination}</main>` +
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

test("textFromHtml drops scripts, styles and SVG, breaks lines at block elements, decodes entities and collapses whitespace", () => {
  const text = textFromHtml("<div>Fish &amp; chips<script>alert(1)</script><style>p{}</style></div><svg><text>logo</text></svg><p>A&nbsp;&nbsp;b &#8212; c &#x2019;d&#039;</p><br>tail");
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
  assert.equal(digest.nextPage, null, "a page without a rel=next link has no older page");
});

test("an index names its older page with a rel=next <link> or <a>, resolved against the page and kept as written (github.blog's has a trailing slash)", () => {
  const index = digestSnapshot({ url: "https://github.blog/changelog/", kind: "changelog", contentType: html(), bytes: bytes(changelogPage([["2026-11-13-a", "A", "2026-11-13"]], { next: "https://github.blog/changelog/page/2/" })) });
  assert.equal(index.nextPage, "https://github.blog/changelog/page/2/");
  const relative = digestSnapshot({ url: "https://github.com/github/gh-aw/releases", kind: "release-notes", contentType: html(), bytes: bytes(releasesPage([["v1.2.3", "2026-11-12", "<p>Notes.</p>"]], { next: "/github/gh-aw/releases?page=2#top" })) });
  assert.equal(relative.nextPage, "https://github.com/github/gh-aw/releases?page=2", "relative, without its fragment");
  const credentials = digestSnapshot({ url: "https://github.blog/changelog/", kind: "changelog", contentType: html(), bytes: bytes(changelogPage([], { next: "https://user:secret@github.blog/changelog/page/2/" })) });
  assert.equal(credentials.nextPage, null, "a link that carries credentials is never followed");
  assert.equal(digestSnapshot({ url: "https://github.blog/changelog/feed/", kind: "feed", contentType: "application/rss+xml", bytes: bytes(RSS) }).nextPage, null, "a feed that names no older page has none");
});

test("a WordPress feed names its older items at ?paged=N+1 (github.blog's changelog pages its feed and not its index), and an RFC 5005 feed by its rel=next link", () => {
  const wordpress = RSS.replace("<title>Changelog</title>", "<title>Changelog</title><generator>https://wordpress.org/?v=7.1.4</generator>");
  const first = digestSnapshot({ url: "https://github.blog/changelog/feed/", kind: "feed", contentType: "application/rss+xml", bytes: bytes(wordpress) });
  assert.equal(first.nextPage, "https://github.blog/changelog/feed/?paged=2");
  assert.equal(first.entries.length, 2, "the generator changes nothing else");
  assert.equal(digestSnapshot({ url: "https://github.blog/changelog/feed/?paged=2", kind: "feed", contentType: "application/rss+xml", bytes: bytes(wordpress) }).nextPage, "https://github.blog/changelog/feed/?paged=3");
  const paged = ATOM.replace("<title>Release notes</title>", '<title>Release notes</title><link rel="next" href="https://example.test/feed?page=2"/>');
  assert.equal(digestSnapshot({ url: "https://example.test/feed", kind: "feed", contentType: "application/atom+xml", bytes: bytes(paged) }).nextPage, "https://example.test/feed?page=2");
});

test("a release page gives one entry per release section: the link of its tag, its name, the date of its first <relative-time> and an excerpt of its notes, and no other link", () => {
  const notes = '<h2>🌟 Release Highlights</h2><div class="highlight"><p>Safer <code>cancel-work</code> handling.</p></div><ul><li>Cost-aware routing</li></ul>';
  const digest = digestSnapshot({
    url: "https://github.com/github/gh-aw/releases",
    kind: "release-notes",
    contentType: html(),
    bytes: bytes(releasesPage([["v1.2.3", "2026-11-12", notes], ["v1.2.2", "2026-11-10", "<p>Hardened firewall egress.</p>"]])),
  });
  assert.deepEqual(digest.entries, [
    { url: "https://github.com/github/gh-aw/releases/tag/v1.2.3", title: "v1.2.3", date: "2026-11-12", excerpt: "🌟 Release Highlights Safer cancel-work handling. Cost-aware routing" },
    { url: "https://github.com/github/gh-aw/releases/tag/v1.2.2", title: "v1.2.2", date: "2026-11-10", excerpt: "Hardened firewall egress." },
  ]);
  assert.equal(digest.nextPage, "https://github.com/github/gh-aw/releases?page=2");
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

test("a URL that carries credentials is neither a citation nor an entry, so that it is never fetched or written to the work list", () => {
  assert.deepEqual(extractCitations("https://user:pw@docs.github.com/en/i and https://token@docs.github.com/en/j and https://docs.github.com/en/k", ["docs.github.com"]), ["https://docs.github.com/en/k"]);
  const digest = digestSnapshot({ url: "https://docs.github.com/en/admin", kind: "docs", contentType: html(), bytes: bytes(docsPage("x", [["https://user:pw@docs.github.com/en/admin/secret", "Secret"], ["/en/admin/open", "Open"]])) });
  assert.deepEqual(digest.entries.map((entry) => entry.url), ["https://docs.github.com/en/admin/open"]);
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
  assert.deepEqual(changes.summary, { newEntries: FIRST_RUN_ENTRY_LIMIT, changedSources: 0, changedCitedPages: 0, firstSeenSources: 3, firstSeenCitedPages: 1, failed: 0, possibleGaps: 0 });
  assert.deepEqual(changes.possibleGaps, [], "nothing is known of a first run, so nothing can be missing from it");
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
  assert.deepEqual(changes.summary, { newEntries: 2, changedSources: 3, changedCitedPages: 1, firstSeenSources: 0, firstSeenCitedPages: 0, failed: 1, possibleGaps: 0 });
});

test("sources that list the same entries are one stream, and a stream is a possible gap only when none of its sources still lists an entry that the baseline knew", () => {
  const before = current({ feed: [entry("old")], index: [entry("old")] });
  const baseline = { found: true, runId: 5, runUrl: "https://github.com/o/r/actions/runs/5", createdAt: "2026-11-02T13:23:00Z" };
  const covered = compareWithPrevious({ current: current({ feed: [entry("n2")], index: [entry("n2"), entry("n1"), entry("old")] }), previous: buildIndex(before), baseline });
  assert.deepEqual(covered.possibleGaps, [], "the feed no longer reaches 'old', but the index that lists the same entries does: nothing was missed");

  const now = current({ feed: [entry("n3", { date: "2026-11-13" })], index: [entry("n3", { date: "2026-11-13" }), entry("n2", { date: "2026-11-11" })] });
  now.sources[1].pagesRead = 3;
  const gap = compareWithPrevious({ current: now, previous: buildIndex(before), baseline });
  assert.deepEqual(gap.possibleGaps, [
    {
      sources: [
        { url: INDEX_PAGE.url, label: "Changelog", pagesRead: 3 },
        { url: FEED.url, label: "Changelog feed", pagesRead: 1 },
      ],
      listed: 2,
      known: 1,
      since: "2026-11-02T13:23:00Z",
      oldestListed: "2026-11-11",
      stoppedShort: [],
      cause: "none-reached",
    },
  ]);
  assert.equal(gap.summary.possibleGaps, 1);
  assert.deepEqual(gap.newEntries.map((item) => item.url.split("/").pop()), ["n3", "n2"], "what is listed is still new and still listed");

  const empty = current({ index: [] });
  const emptied = compareWithPrevious({ current: empty, previous: buildIndex(before), baseline });
  assert.deepEqual(emptied.possibleGaps.map((item) => [item.sources.map((source) => source.label), item.listed, item.oldestListed]), [[["Changelog"], 0, null], [["Changelog feed"], 0, null]], "a source that lists nothing now, although it listed entries then, is a gap too");
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
  assert.deepEqual(changes.possibleGaps, [], "a source that failed then knew nothing, so nothing can be missing since");
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
  assert.match(markdown, /## New entries \(1\)[\s\S]*## Possible gaps \(0\)\n\nNone\.\n\n## Changed pages/, "the gaps follow the new entries");
  const firstRun = renderChangesMarkdown(compareWithPrevious({ current: now, previous: null, baseline: { found: false, reason: "no successful earlier run has a watch index" } }));
  assert.match(firstRun, /Baseline: none \(no successful earlier run has a watch index\)\. This run records the first watch index: each changelog, feed, release-notes and blog source lists at most its 15 most recent entries, and pages are compared from the next run on\./);
});

test("a possible gap is listed in changes.md with its sources, the pages read and the period that neither run saw, and tells the agent what to do", () => {
  const before = current({ feed: [entry("old")], index: [entry("old")] });
  const now = current({ feed: [entry("n3", { date: "2026-11-13" })], index: [entry("n3", { date: "2026-11-13" }), entry("n2", { date: "2026-11-11" })] });
  now.sources[1].pagesRead = 3;
  const markdown = renderChangesMarkdown(compareWithPrevious({ current: now, previous: buildIndex(before), baseline: { found: true, runId: 5, runUrl: "https://github.com/o/r/actions/runs/5", createdAt: "2026-11-02T13:23:00Z" } }));
  assert.match(
    markdown,
    /## Possible gaps \(1\)\n\n- \[Changelog\]\(https:\/\/github\.blog\/changelog\/\) \(3 pages read\) and \[Changelog feed\]\(https:\/\/github\.blog\/changelog\/feed\/\): none of the 2 entries listed now is one of the 1 that the baseline listed, so entries published between 2026-11-02T13:23:00Z \(the baseline run\) and 2026-11-11 \(the oldest entry listed now\) may be missing above\. Open the older pages of this source for that period, decide those entries too, and name the gap under Limitations if you cannot\.\n/,
  );
});

test("a source that stopped at the page limit or on an older page that failed, short of the baseline, is a possible gap even when a narrower view of its stream still reaches the baseline; one whose older page added nothing is not", () => {
  const LABEL = { url: "https://github.blog/changelog/?label=enterprise", label: "Enterprise label", kind: "changelog" };
  const baseline = { found: true, runId: 5, runUrl: "https://github.com/o/r/actions/runs/5", createdAt: "2026-10-30T13:23:00Z" };
  const before = { project: "p", sources: [{ ...INDEX_PAGE, state: "ok", textSha256: "i", entries: [entry("old")] }, { ...LABEL, state: "ok", textSha256: "l", entries: [entry("old-enterprise")] }], citedPages: [] };
  const now = (stop) => ({
    project: "p",
    sources: [
      { ...INDEX_PAGE, state: "ok", textSha256: "i2", pagesRead: 2, stoppedShort: stop, entries: [entry("n2", { date: "2026-11-13" }), entry("n1-enterprise", { date: "2026-11-03" })] },
      { ...LABEL, state: "ok", textSha256: "l2", entries: [entry("n1-enterprise", { date: "2026-11-03" }), entry("old-enterprise", { date: "2026-10-20" })] },
    ],
    citedPages: [],
  });
  const failed = compareWithPrevious({ current: now("failed"), previous: buildIndex(before), baseline });
  assert.deepEqual(failed.possibleGaps, [
    {
      sources: [
        { url: INDEX_PAGE.url, label: "Changelog", pagesRead: 2 },
        { url: LABEL.url, label: "Enterprise label", pagesRead: 1 },
      ],
      listed: 3,
      known: 2,
      since: "2026-10-30T13:23:00Z",
      oldestListed: "2026-11-03",
      stoppedShort: [{ url: INDEX_PAGE.url, label: "Changelog", stop: "failed" }],
      cause: "stopped-short",
    },
  ], "the label view reaches the baseline, but it lists only part of the changelog");
  assert.deepEqual(compareWithPrevious({ current: now("limit"), previous: buildIndex(before), baseline }).possibleGaps[0].stoppedShort, [{ url: INDEX_PAGE.url, label: "Changelog", stop: "limit" }]);
  assert.deepEqual(compareWithPrevious({ current: now(null), previous: buildIndex(before), baseline }).possibleGaps, [], "an index whose older page added nothing (github.blog's) has no more to give: another source of the stream has to reach back");
  const markdown = renderChangesMarkdown(failed);
  assert.match(
    markdown,
    /- \[Changelog\]\(https:\/\/github\.blog\/changelog\/\) \(2 pages read\) and \[Enterprise label\]\(https:\/\/github\.blog\/changelog\/\?label=enterprise\): Changelog stopped at an older page that could not be fetched before it reached an entry that the baseline listed, and the sources of this stream that reach it may list only part of its entries, so entries published between 2026-10-30T13:23:00Z \(the baseline run\) and 2026-11-03 \(the oldest entry listed now\) may be missing above\./,
  );
});

test("an older page that could not be fetched is listed under Could not fetch with the source that named it", () => {
  const now = current({ index: [entry("a")] });
  now.sources[1].olderPageFailures = [{ url: "https://github.blog/changelog/page/2/", error: "HTTP 503" }];
  const changes = compareWithPrevious({ current: now, previous: null, baseline: { found: false, reason: "none" } });
  assert.deepEqual(changes.failed, [{ url: "https://github.blog/changelog/page/2/", label: "Changelog (older page)", error: "HTTP 503" }]);
  assert.equal(changes.summary.failed, 1);
  assert.match(renderChangesMarkdown(changes), /## Could not fetch \(1\)\n\n- https:\/\/github\.blog\/changelog\/page\/2\/ \(Changelog \(older page\)\): HTTP 503/);
});
