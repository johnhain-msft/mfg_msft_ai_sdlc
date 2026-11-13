// What a watched source says, reduced to what the next run compares (SPEC-02 AC11, AC41-AC43).
//
// The snapshot script saves every watched URL as fetched. This module reads those bytes again and keeps two things:
//  - the text of the page: the main content of an HTML page (its <main>, else its <body>) without scripts, styles, SVG and the site's
//    navigation, header and footer, or every entry of a feed, so that a new build id, a tracking script or a changed product menu is not a
//    change of the page, and its SHA-256;
//  - its entries: one per <article> of a changelog index (the permalink, its title and the date of its <time>), one per item of an RSS or Atom
//    feed (the link, the title, the date and an excerpt of the content), else the same-host links of the main content.
// buildIndex() keeps of those the hashes and the entry URLs (watch-index.json), and compareWithPrevious() compares them with the index of the
// previous run: the new entries, each once with every source that lists it, the documentation pages whose text changed and the links that
// appeared on them, the cited pages that changed, and the sources that could not be fetched. renderChangesMarkdown() writes that comparison as
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
export function htmlToText(html) {
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

/** An absolute http(s) URL without its fragment and without a trailing slash on a path other than the root; null for anything else. */
export function normalizeUrl(href, base) {
  let parsed;
  try {
    parsed = new URL(decodeEntities(String(href).trim()), base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
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
    if (url !== null) anchors.push({ url, title: htmlToText(match[2]).replace(/\n/g, " ") });
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

function digestHtml(html, pageUrl) {
  const page = normalizeUrl(pageUrl, pageUrl);
  const text = htmlToText(dropElements(mainOf(html), CHROME_ELEMENTS));
  const entries = [];
  const seen = new Set();
  const push = (entry) => {
    if (entry.url === page || seen.has(entry.url)) return;
    seen.add(entry.url);
    entries.push(entry);
  };
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((match) => match[1]);
  if (articles.length > 0) {
    for (const article of articles) {
      const first = anchorsOf(dropElements(article, DROPPED_ELEMENTS), pageUrl).find((anchor) => anchor.title !== "" && anchor.url !== page);
      if (!first) continue;
      const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(article);
      push({ url: first.url, title: first.title, date: time ? isoDate(time[1]) : null });
    }
  } else {
    const host = new URL(pageUrl).host;
    for (const anchor of anchorsOf(dropElements(mainOf(html), [...DROPPED_ELEMENTS, ...CHROME_ELEMENTS]), pageUrl)) {
      if (new URL(anchor.url).host === host) push({ url: anchor.url, title: anchor.title, date: null });
    }
  }
  return { text, entries };
}

const cdata = (value) => String(value ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
const field = (xml, name) => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "i").exec(xml);
  return match ? cdata(match[1]) : null;
};
/** The text of a feed field that holds HTML, escaped (Atom type="html", RSS description) or in CDATA (content:encoded). */
const feedText = (value) => htmlToText(/<[a-z!]/i.test(value) ? value : decodeEntities(value));

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
    const title = htmlToText(decodeEntities(field(item, "title") ?? "")).replace(/\n/g, " ");
    const date = isoDate(field(item, "pubDate") ?? field(item, "published") ?? field(item, "updated") ?? field(item, "dc:date"));
    const body = field(item, "content:encoded") ?? field(item, "content") ?? field(item, "description") ?? field(item, "summary") ?? "";
    entries.push({ url, title, date, excerpt: excerptOf(feedText(body)) });
  }
  const text = entries.map((entry) => [entry.url, entry.title, entry.date ?? "", entry.excerpt].join("\t")).join("\n");
  return { text, entries };
}

/** True when the bytes are an RSS, RDF or Atom document, whatever content type the server named. */
export function isFeed(contentType, text) {
  const head = String(text).slice(0, 2048);
  return /<(?:rss|feed|rdf:RDF)\b/i.test(head) && (/xml/i.test(String(contentType ?? "")) || /^\s*(?:<\?xml|<rss|<feed|<rdf:RDF)/i.test(head));
}

/**
 * The digest of one saved snapshot.
 * @returns {{ text: string, textSha256: string, entries: { url: string, title: string, date: string|null, excerpt?: string }[] }}
 */
export function digestSnapshot({ url, contentType, bytes }) {
  const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
  let digest;
  if (isFeed(contentType, text)) digest = digestFeed(text, url);
  else if (/html/i.test(String(contentType ?? "")) || /<html\b|<body\b|<main\b/i.test(text.slice(0, 4096))) digest = digestHtml(text, url);
  else digest = { text: text.replace(/\r\n?/g, "\n").trim(), entries: [] };
  return { text: digest.text, textSha256: sha256(digest.text), entries: digest.entries };
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
    },
    newEntries,
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
