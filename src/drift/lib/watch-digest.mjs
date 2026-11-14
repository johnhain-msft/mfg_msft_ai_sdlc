// What a watched source says, reduced to what the next run compares (SPEC-02 AC11, AC41-AC43).
//
// The snapshot script saves every watched URL as fetched. This module reads those bytes again and keeps two things:
//  - the text of the page: the main content of an HTML page (its <main>, else its <body>) without scripts, styles, SVG and the site's
//    navigation, header and footer, or every entry of a feed, so that a new build id, a tracking script or a changed product menu is not a
//    change of the page, and its SHA-256;
//  - its entries: one per <article> of a changelog index (the permalink, its title and the date of its <time>), one per release section of a GitHub
//    release page (the link of its tag, its name, its date and an excerpt of its notes: the page lists releases only, where its Atom feed also
//    lists bare tags), one per item of an RSS or Atom feed (the link, the title, the date and an excerpt of the content), else the same-host links
//    of the main content; and the older page that a page names with rel="next", which the snapshot step reads when the first page no longer
//    reaches the previous run. A URL that carries credentials is never an entry, a citation or an older page.
// buildIndex() keeps of those the hashes and the entry URLs (watch-index.json), and compareWithPrevious() compares them with the index of the
// previous run: the new entries, each once with every source that lists it, the possible gaps (a stream of sources that no longer reaches any
// entry the previous run knew), the documentation pages whose text changed and the links that appeared on them, the cited pages that changed,
// and the sources that could not be fetched. renderChangesMarkdown() writes that comparison as
// the agent's work list (changes.md). Every function is pure and every output is ordered, so the same input always gives the same bytes.

import crypto from "node:crypto";

export const INDEX_VERSION = 1;
/** How many of its entries a source offers when nothing earlier is known of it: its most recent ones, in page order. */
export const FIRST_RUN_ENTRY_LIMIT = 15;
/** Kinds whose entries are dated announcements; a documentation page changes in place instead. */
export const ENTRY_KINDS = new Set(["changelog", "feed", "release-notes", "blog"]);

const EXCERPT_LIMIT = 360;
const LISTED_LINK_LIMIT = 40;
const LISTED_FILE_LIMIT = 5;
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", middot: "\u00b7" };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

const DROPPED_ELEMENTS = ["script", "style", "noscript", "svg", "template", "iframe", "object", "canvas"];
const CHROME_ELEMENTS = ["nav", "header", "footer", "aside", "form"];
const BLOCK_TAG = /<\/?(?:p|div|li|ul|ol|h[1-6]|br|hr|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|pre|dd|dt|dl|figure|figcaption|details|summary)\b[^>]*>/gi;

function dropElements(html, names) {
  let out = String(html).replace(/<!--[\s\S]*?-->/g, " ");
  for (const name of names) out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), " ").replace(new RegExp(`<${name}\\b[^>]*\\/>`, "gi"), " ");
  return out;
}

/** The visible text of an HTML fragment: one line per block element, entities decoded, whitespace collapsed, empty lines dropped. */
export function textFromHtml(html) {
  return decodeEntities(dropElements(html, DROPPED_ELEMENTS).replace(BLOCK_TAG, "\n").replace(/<[^>]*>/g, ""))
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** The main content of a page: its <main>, else its <body>, else all of it. */
function mainOf(html) {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
  if (main) return main[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return body ? body[1] : html;
}

/** An absolute http(s) URL without its fragment and without a trailing slash on a path other than the root; null for anything else, and for a URL that carries credentials. */
export function normalizeUrl(href, base) {
  let parsed;
  try {
    parsed = new URL(decodeEntities(String(href).trim()), base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const hrefOf = (attributes) => /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);

function anchorsOf(html, base) {
  const anchors = [];
  for (const match of html.matchAll(ANCHOR)) {
    const href = hrefOf(match[1]);
    if (!href) continue;
    const url = normalizeUrl(href[1] ?? href[2] ?? href[3], base);
    if (url !== null) anchors.push({ url, title: textFromHtml(match[2]).replace(/\n/g, " ") });
  }
  return anchors;
}

/** A date as YYYY-MM-DD, or null when the text is not one. */
function isoDate(text) {
  const value = String(text ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

function excerptOf(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  const cut = flat.slice(0, EXCERPT_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}\u2026`;
}

/** The content of the `name` element whose start tag begins at `start`, up to its matching end tag (elements of the same name nest), or to the end. */
function contentOf(html, start, name) {
  const tags = new RegExp(`<(\\/?)${name}\\b[^>]*>`, "gi");
  tags.lastIndex = start;
  let depth = 0;
  let from = -1;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[1] === "") {
      depth += 1;
      if (from === -1) from = tags.lastIndex;
    } else if (from !== -1 && (depth -= 1) === 0) {
      return html.slice(from, match.index);
    }
  }
  return from === -1 ? "" : html.slice(from);
}

const attributeOf = (attributes, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
};

/** An older-page link as an absolute URL without its fragment, kept as written otherwise; null when it is not http(s) or carries credentials. */
function olderPageUrl(href, base) {
  let url;
  try {
    url = new URL(decodeEntities(String(href).trim()), base);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  url.hash = "";
  return url.href;
}

/** The href of the first rel="next" <a>, <link> or <atom:link> of `html` that is a usable older page, or null. */
function relNextOf(html, base) {
  for (const match of html.matchAll(/<(?:a|link|atom:link)\b([^>]*)>/gi)) {
    const rel = attributeOf(match[1], "rel");
    const href = attributeOf(match[1], "href");
    if (rel === null || href === null || !rel.toLowerCase().split(/\s+/).includes("next")) continue;
    const url = olderPageUrl(href, base);
    if (url !== null) return url;
  }
  return null;
}

/** The older page that a page names with a rel="next" <link> (github.blog's changelog) or <a> (a GitHub release page), or null. */
const nextPageOf = (html, pageUrl) => relNextOf(html, pageUrl);

const RELEASE_SECTION = /<section\b[^>]*\bdata-release-anchor\b[^>]*>([\s\S]*?)<\/section\s*>/gi;
const MARKDOWN_BODY = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bmarkdown-body\b[^"']*["'][^>]*>/i;

/** One entry per release section of a GitHub release page: the link of its tag, its name, the date of its first <relative-time> and its notes. */
function releaseEntryOf(section, pageUrl) {
  const tag = anchorsOf(dropElements(section, DROPPED_ELEMENTS), pageUrl).find((anchor) => anchor.title !== "" && new URL(anchor.url).pathname.includes("/releases/tag/"));
  if (!tag) return null;
  const time = /<(?:relative-time|time)\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(section);
  const entry = { url: tag.url, title: tag.title, date: time ? isoDate(time[1]) : null };
  const notes = MARKDOWN_BODY.exec(section);
  if (notes) {
    const excerpt = excerptOf(textFromHtml(contentOf(section, notes.index, "div")));
    if (excerpt !== "") entry.excerpt = excerpt;
  }
  return entry;
}

function digestHtml(html, pageUrl) {
  const page = normalizeUrl(pageUrl, pageUrl);
  const text = textFromHtml(dropElements(mainOf(html), CHROME_ELEMENTS));
  const entries = [];
  const seen = new Set();
  const push = (entry) => {
    if (entry.url === page || seen.has(entry.url)) return;
    seen.add(entry.url);
    entries.push(entry);
  };
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((match) => match[1]);
  const releases = articles.length > 0 ? [] : [...html.matchAll(RELEASE_SECTION)].map((match) => match[1]);
  if (articles.length > 0) {
    for (const article of articles) {
      const first = anchorsOf(dropElements(article, DROPPED_ELEMENTS), pageUrl).find((anchor) => anchor.title !== "" && anchor.url !== page);
      if (!first) continue;
      const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(article);
      push({ url: first.url, title: first.title, date: time ? isoDate(time[1]) : null });
    }
  } else if (releases.length > 0) {
    // a release page lists releases only; its Atom feed (releases.atom) also lists the bare tags of the repository
    for (const section of releases) {
      const entry = releaseEntryOf(section, pageUrl);
      if (entry !== null) push(entry);
    }
  } else {
    const host = new URL(pageUrl).host;
    for (const anchor of anchorsOf(dropElements(mainOf(html), [...DROPPED_ELEMENTS, ...CHROME_ELEMENTS]), pageUrl)) {
      if (new URL(anchor.url).host === host) push({ url: anchor.url, title: anchor.title, date: null });
    }
  }
  return { text, entries, nextPage: nextPageOf(html, pageUrl) };
}

const cdata = (value) => String(value ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
const field = (xml, name) => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "i").exec(xml);
  return match ? cdata(match[1]) : null;
};
/** The text of a feed field that holds HTML, escaped (Atom type="html", RSS description) or in CDATA (content:encoded). */
const feedText = (value) => textFromHtml(/<[a-z!]/i.test(value) ? value : decodeEntities(value));

/**
 * The older page of a feed: the URL of a feed-level rel="next" link (RFC 5005), else, for a WordPress feed (its <generator> names wordpress.org),
 * the same URL with `paged` one higher, which is where WordPress serves the older items of a feed (github.blog's changelog: ten items a page).
 */
function nextFeedPageOf(xml, pageUrl) {
  const first = xml.search(/<(?:item|entry)\b/i);
  const head = first === -1 ? xml : xml.slice(0, first);
  const linked = relNextOf(head, pageUrl);
  if (linked !== null) return linked;
  if (!/wordpress\.org/i.test(field(head, "generator") ?? "")) return null;
  const url = new URL(pageUrl);
  const page = Number.parseInt(url.searchParams.get("paged") ?? "1", 10);
  url.searchParams.set("paged", String((Number.isInteger(page) && page > 0 ? page : 1) + 1));
  url.hash = "";
  return url.href;
}

function digestFeed(xml, pageUrl) {
  const entries = [];
  const seen = new Set();
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((match) => match[2]);
  for (const item of items) {
    let link = null;
    for (const tag of item.matchAll(/<link\b([^>]*?)\/?>(?:([^<]*)<\/link\s*>)?/gi)) {
      const attributes = tag[1];
      const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? "alternate";
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? tag[2];
      if (rel === "alternate" && href && href.trim() !== "") {
        link = href;
        break;
      }
    }
    const url = normalizeUrl(link ?? cdata(field(item, "guid") ?? ""), pageUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const title = textFromHtml(decodeEntities(field(item, "title") ?? "")).replace(/\n/g, " ");
    const date = isoDate(field(item, "pubDate") ?? field(item, "published") ?? field(item, "updated") ?? field(item, "dc:date"));
    const body = field(item, "content:encoded") ?? field(item, "content") ?? field(item, "description") ?? field(item, "summary") ?? "";
    entries.push({ url, title, date, excerpt: excerptOf(feedText(body)) });
  }
  const text = entries.map((entry) => [entry.url, entry.title, entry.date ?? "", entry.excerpt].join("\t")).join("\n");
  return { text, entries, nextPage: nextFeedPageOf(xml, pageUrl) };
}

/** True when the bytes are an RSS, RDF or Atom document, whatever content type the server named. */
export function isFeed(contentType, text) {
  const head = String(text).slice(0, 2048);
  return /<(?:rss|feed|rdf:RDF)\b/i.test(head) && (/xml/i.test(String(contentType ?? "")) || /^\s*(?:<\?xml|<rss|<feed|<rdf:RDF)/i.test(head));
}

/**
 * The digest of one saved snapshot.
 * @returns {{ text: string, textSha256: string, entries: { url: string, title: string, date: string|null, excerpt?: string }[], nextPage: string|null }}
 */
export function digestSnapshot({ url, contentType, bytes }) {
  const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
  let digest;
  if (isFeed(contentType, text)) digest = digestFeed(text, url);
  else if (/html/i.test(String(contentType ?? "")) || /<html\b|<body\b|<main\b/i.test(text.slice(0, 4096))) digest = digestHtml(text, url);
  else digest = { text: text.replace(/\r\n?/g, "\n").trim(), entries: [] };
  return { text: digest.text, textSha256: sha256(digest.text), entries: digest.entries, nextPage: digest.nextPage ?? null };
}

const CITATION = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi;

/** Every URL on one of `hosts` that `text` cites, normalized (no fragment, no trailing slash or punctuation), in order, repeats included. */
export function extractCitations(text, hosts) {
  const wanted = new Set(hosts.map((host) => host.toLowerCase()));
  const found = [];
  for (const match of String(text).matchAll(CITATION)) {
    const url = normalizeUrl(match[0].replace(/[.,;:!?*'"]+$/, ""));
    if (url !== null && wanted.has(new URL(url).hostname)) found.push(url);
  }
  return found;
}

/**
 * The cited pages to snapshot: most cited first, then by URL, at most `maxPages`.
 * @param {Map<string, string[]>} citationsByFile the citations of each file (repeats count)
 */
export function rankCitations(citationsByFile, maxPages) {
  const pages = new Map();
  for (const [file, urls] of citationsByFile) {
    for (const url of urls) {
      const page = pages.get(url) ?? { url, citations: 0, citedBy: new Set() };
      page.citations += 1;
      page.citedBy.add(file);
      pages.set(url, page);
    }
  }
  return [...pages.values()]
    .sort((a, b) => b.citations - a.citations || compare(a.url, b.url))
    .slice(0, maxPages)
    .map((page) => ({ url: page.url, citations: page.citations, citedBy: [...page.citedBy].sort(compare) }));
}

/** What the next run compares: per source its hash and its entry URLs, per cited page its hash; sorted. */
export function buildIndex({ project, sources, citedPages = [] }) {
  return {
    version: INDEX_VERSION,
    project,
    sources: [...sources]
      .sort((a, b) => compare(a.url, b.url))
      .map((source) => ({
        url: source.url,
        kind: source.kind,
        state: source.state,
        textSha256: source.state === "ok" ? source.textSha256 : null,
        entries: source.state === "ok" ? [...new Set(source.entries.map((entry) => entry.url))].sort(compare) : [],
      })),
    citedPages: [...citedPages].sort((a, b) => compare(a.url, b.url)).map((page) => ({ url: page.url, state: page.state, textSha256: page.state === "ok" ? page.textSha256 : null })),
  };
}

/** A previous index that this version can compare with, or null. */
export function usableIndex(value) {
  if (value === null || typeof value !== "object" || value.version !== INDEX_VERSION || !Array.isArray(value.sources)) return null;
  const sources = value.sources.filter((source) => source && typeof source.url === "string" && Array.isArray(source.entries));
  const citedPages = Array.isArray(value.citedPages) ? value.citedPages.filter((page) => page && typeof page.url === "string") : [];
  return { ...value, sources, citedPages };
}

/**
 * The possible gaps of a comparison. Sources that list the same entries are one stream (the changelog index and its feed); a stream whose sources
 * listed entries in the baseline and list none of them now no longer reaches the baseline, so entries published after the baseline run and before
 * the oldest entry listed now may have been seen by neither run. A stream with no entry known to the baseline (first seen, or failed then) has
 * nothing to reach back to. A stream that does reach the baseline is still a possible gap when one of its sources stopped reading older pages at
 * the limit or on a page that failed (`stoppedShort`) before it reached the baseline: the source that reaches it may be a narrower view of the
 * same list (github.blog's ?label= view lists part of the changelog), and only a source whose older page added nothing has nothing more to give.
 */
function possibleGapsOf(sources, priorSource, baseline) {
  const listing = sources.filter((source) => source.state === "ok" && ENTRY_KINDS.has(source.kind));
  const parent = listing.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]];
    return index;
  };
  const listedBy = new Map();
  listing.forEach((source, index) => {
    for (const item of source.entries) {
      if (listedBy.has(item.url)) parent[root(index)] = root(listedBy.get(item.url));
      else listedBy.set(item.url, index);
    }
  });
  const streams = new Map();
  listing.forEach((source, index) => streams.set(root(index), [...(streams.get(root(index)) ?? []), source]));
  const gaps = [];
  for (const members of streams.values()) {
    const known = new Set();
    for (const source of members) {
      const prior = priorSource.get(source.url);
      if (prior && prior.state === "ok") for (const url of prior.entries) known.add(url);
    }
    if (known.size === 0) continue;
    const listed = new Set(members.flatMap((source) => source.entries.map((item) => item.url)));
    const reached = [...listed].some((url) => known.has(url));
    const short = members.filter((source) => source.stoppedShort === "limit" || source.stoppedShort === "failed");
    if (reached && short.length === 0) continue;
    const dates = (reached ? short : members).flatMap((source) => source.entries.map((item) => item.date)).filter((date) => typeof date === "string" && date !== "").sort(compare);
    gaps.push({
      sources: members.map((source) => ({ url: source.url, label: source.label, pagesRead: source.pagesRead ?? 1 })),
      cause: reached ? "stopped-short" : "none-reached",
      listed: listed.size,
      known: known.size,
      since: baseline?.found && baseline.createdAt ? baseline.createdAt : null,
      oldestListed: dates[0] ?? null,
      stoppedShort: short.map((source) => ({ url: source.url, label: source.label, stop: source.stoppedShort })),
    });
  }
  return gaps;
}

/**
 * The comparison of this run's sources and cited pages with the previous watch index.
 * @param {{ current: { project: string, sources: object[], citedPages?: object[] }, previous: object|null, baseline: object }} input
 */
export function compareWithPrevious({ current, previous, baseline }) {
  const before = usableIndex(previous);
  const priorSource = new Map((before?.sources ?? []).map((source) => [source.url, source]));
  const priorPage = new Map((before?.citedPages ?? []).map((page) => [page.url, page]));
  const sources = [...current.sources].sort((a, b) => compare(a.url, b.url));
  const newEntries = [];
  const byUrl = new Map();
  const outSources = [];
  const failed = [];
  for (const source of sources) {
    const base = { url: source.url, label: source.label, kind: source.kind };
    if (source.state !== "ok") {
      failed.push({ url: source.url, label: source.label, error: source.error ?? "not fetched" });
      outSources.push({ ...base, status: "failed", textChanged: false, newEntryCount: 0, newLinks: [] });
      continue;
    }
    const prior = priorSource.get(source.url);
    const entryKind = ENTRY_KINDS.has(source.kind);
    let status;
    let fresh;
    let textChanged = false;
    if (!prior || prior.state !== "ok") {
      status = "first-seen";
      fresh = entryKind ? source.entries.slice(0, FIRST_RUN_ENTRY_LIMIT) : [];
    } else {
      const known = new Set(prior.entries);
      fresh = source.entries.filter((entry) => !known.has(entry.url));
      textChanged = prior.textSha256 !== source.textSha256;
      status = textChanged || fresh.length > 0 ? "changed" : "unchanged";
    }
    if (entryKind) {
      for (const entry of fresh) {
        const listed = byUrl.get(entry.url);
        if (listed) {
          if (!listed.sources.includes(source.label)) listed.sources.push(source.label);
          if (listed.date === null && entry.date) listed.date = entry.date;
          if (listed.excerpt === undefined && entry.excerpt) listed.excerpt = entry.excerpt;
          if (listed.title === "" && entry.title) listed.title = entry.title;
          continue;
        }
        const item = { url: entry.url, title: entry.title, date: entry.date ?? null, sources: [source.label] };
        if (entry.excerpt) item.excerpt = entry.excerpt;
        byUrl.set(entry.url, item);
        newEntries.push(item);
      }
    }
    outSources.push({ ...base, status, textChanged, newEntryCount: entryKind ? fresh.length : 0, newLinks: entryKind || status !== "changed" ? [] : fresh.map((entry) => ({ url: entry.url, title: entry.title })) });
    for (const page of source.olderPageFailures ?? []) failed.push({ url: page.url, label: `${source.label} (older page)`, error: page.error });
  }
  const citedPages = [...(current.citedPages ?? [])]
    .sort((a, b) => compare(a.url, b.url))
    .map((page) => {
      const prior = priorPage.get(page.url);
      let status;
      if (page.state !== "ok") status = "failed";
      else if (!prior || prior.state !== "ok") status = "first-seen";
      else status = prior.textSha256 === page.textSha256 ? "unchanged" : "changed";
      const item = { url: page.url, status, citations: page.citations ?? 0, citedBy: [...(page.citedBy ?? [])], citedByCount: page.citedByCount ?? (page.citedBy ?? []).length, snapshot: page.snapshot ?? null };
      if (page.state !== "ok") {
        item.error = page.error ?? "not fetched";
        failed.push({ url: page.url, label: "cited page", error: item.error });
      }
      return item;
    });
  const count = (list, status) => list.filter((item) => item.status === status).length;
  const possibleGaps = possibleGapsOf(sources, priorSource, baseline);
  return {
    version: INDEX_VERSION,
    project: current.project,
    baseline,
    summary: {
      newEntries: newEntries.length,
      changedSources: count(outSources, "changed"),
      changedCitedPages: count(citedPages, "changed"),
      firstSeenSources: count(outSources, "first-seen"),
      firstSeenCitedPages: count(citedPages, "first-seen"),
      failed: failed.length,
      possibleGaps: possibleGaps.length,
    },
    newEntries,
    possibleGaps,
    sources: outSources,
    citedPages,
    failed,
  };
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const linkText = (text) => String(text).replace(/[[\]]/g, (char) => `\\${char}`);

/** The comparison as the agent's work list. */
export function renderChangesMarkdown(changes) {
  const lines = [`# Watched-source changes: ${changes.project}`, ""];
  const baseline = changes.baseline ?? { found: false, reason: "unknown" };
  if (baseline.found) {
    lines.push(`Baseline: the watch index of run ${baseline.runId} (${baseline.runUrl}), created ${baseline.createdAt}.`);
  } else {
    lines.push(
      `Baseline: none (${baseline.reason}). This run records the first watch index: each changelog, feed, release-notes and blog source lists at most its ${FIRST_RUN_ENTRY_LIMIT} most recent entries, and pages are compared from the next run on.`,
    );
  }
  lines.push("", `## New entries (${changes.newEntries.length})`, "");
  if (changes.newEntries.length === 0) lines.push("None.");
  changes.newEntries.forEach((entry, index) => {
    const title = entry.title === "" ? entry.url : entry.title;
    lines.push(`${index + 1}. [${linkText(title)}](${entry.url})${entry.date ? ` — ${entry.date}` : ""} — ${entry.sources.join(", ")}`);
    if (entry.excerpt) lines.push(`   > ${entry.excerpt}`);
  });
  const gaps = changes.possibleGaps ?? [];
  const STOP_TEXT = { limit: "at the limit of older pages", failed: "at an older page that could not be fetched" };
  const joined = (items) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  lines.push("", `## Possible gaps (${gaps.length})`, "");
  if (gaps.length === 0) lines.push("None.");
  for (const gap of gaps) {
    const names = gap.sources.map((source) => `[${linkText(source.label)}](${source.url})${source.pagesRead > 1 ? ` (${source.pagesRead} pages read)` : ""}`);
    const stopped = (gap.stoppedShort ?? []).map((source) => `${source.label} stopped ${STOP_TEXT[source.stop] ?? source.stop}`);
    const from = `${gap.since ?? "the baseline run"} (the baseline run)`;
    const period = gap.oldestListed ? `between ${from} and ${gap.oldestListed} (the oldest entry listed now)` : `since ${from}`;
    const why =
      gap.cause === "stopped-short"
        ? `${joined(stopped)} before ${stopped.length === 1 ? "it" : "they"} reached an entry that the baseline listed, and the sources of this stream that reach it may list only part of ${stopped.length === 1 ? "its" : "their"} entries`
        : `none of the ${plural(gap.listed, "entry", "entries")} listed now is one of the ${gap.known} that the baseline listed${stopped.length > 0 ? ` (${stopped.join("; ")})` : ""}`;
    lines.push(`- ${joined(names)}: ${why}, so entries published ${period} may be missing above. Open the older pages of this source for that period, decide those entries too, and name the gap under Limitations if you cannot.`);
  }
  const changedPages = changes.sources.filter((source) => !ENTRY_KINDS.has(source.kind) && source.status === "changed");
  lines.push("", `## Changed pages (${changedPages.length})`, "");
  if (changedPages.length === 0) lines.push("None.");
  for (const source of changedPages) {
    const parts = [];
    if (source.textChanged) parts.push("the text changed");
    if (source.newLinks.length > 0) {
      const shown = source.newLinks.slice(0, LISTED_LINK_LIMIT).map((link) => `[${linkText(link.title || link.url)}](${link.url})`);
      const more = source.newLinks.length - shown.length;
      parts.push(`${plural(source.newLinks.length, "new link")}: ${shown.join(", ")}${more > 0 ? ` (+${more} more in changes.json)` : ""}`);
    }
    lines.push(`- [${linkText(source.label)}](${source.url}) (${source.kind}): ${parts.join("; ")}`);
  }
  const changedCited = changes.citedPages.filter((page) => page.status === "changed");
  lines.push("", `## Changed cited pages (${changedCited.length})`, "");
  if (changedCited.length === 0) lines.push("None.");
  for (const page of changedCited) {
    const shown = page.citedBy.slice(0, LISTED_FILE_LIMIT);
    const more = page.citedByCount - shown.length;
    const where = page.snapshot ? `; text in \`${page.snapshot}\`` : "";
    lines.push(`- ${page.url} — cited ${plural(page.citations, "time")} by ${shown.join(", ")}${more > 0 ? ` (+${plural(more, "more file", "more files")})` : ""}${where}`);
  }
  lines.push("", `## Could not fetch (${changes.failed.length})`, "");
  if (changes.failed.length === 0) lines.push("None.");
  for (const item of changes.failed) lines.push(`- ${item.url} (${item.label}): ${item.error}`);
  const unchangedSources = changes.sources.filter((source) => source.status === "unchanged").length;
  const unchangedCited = changes.citedPages.filter((page) => page.status === "unchanged").length;
  lines.push("", "## Unchanged", "", `${plural(unchangedSources, "watched source")} and ${plural(unchangedCited, "cited page")} are unchanged.`);
  const firstSeen = changes.summary.firstSeenSources + changes.summary.firstSeenCitedPages;
  if (firstSeen > 0) {
    lines.push(`${plural(changes.summary.firstSeenSources, "watched source")} and ${plural(changes.summary.firstSeenCitedPages, "cited page")} are seen for the first time: there is nothing to compare them with yet.`);
  }
  return `${lines.join("\n")}\n`;
}
