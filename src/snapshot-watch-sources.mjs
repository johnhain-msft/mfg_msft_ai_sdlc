#!/usr/bin/env node
// Fourth pre-agent step of every drift workflow: snapshots of the watched sources (SPEC-02 AC11, AC12, AC37, AC38, AC42, AC43).
//
//   node src/snapshot-watch-sources.mjs --out /tmp/gh-aw/agent --project <projectKey> --checkout <directory> [--previous <directory>]
//
// The project's knowledgeSources come from the fleet manifest (--manifest, default <orchestrator checkout>/sdlc.yaml):
//  - every watchUrls entry is fetched, without an AI step, and saved as one file under <out>/sources/;
//  - every file of the target checkout that matches a packageManifests pattern is copied under
//    <out>/sources/manifests/ together with the dependency names and versions it declares;
//  - with a citedPages block, the files of the target checkout that match its include patterns are read for the URLs on its hosts that
//    they cite; the most cited pages (at most maxPages) are fetched and their text is saved under <out>/sources/cited/.
// <out>/sources/manifest.json records every attempt: url, label, kind, HTTP status and snapshot path, and the failed ones
// (an entry that cannot be fetched, a pattern that matches no file) with the reason, as limitations for the report.
// Nothing is dropped and nothing is guessed. The output holds no timestamp, entries are ordered by url and then by manifest
// path, and a second run on the same inputs writes the same bytes.
// Each saved source is then reduced to its text and its entries (drift/lib/watch-digest.mjs): <out>/sources/watch-index.json is what the next
// run compares with, and <out>/sources/changes.json and changes.md say what changed since the watch index under --previous (the one that
// drift/previous-watch-index.mjs fetched from the last successful run, with its baseline.json): the new entries, the changed pages and cited
// pages, and the sources that could not be fetched. Without a previous index every source is seen for the first time.
// A changelog, feed, release-notes or blog source whose first page lists none of the entries that the previous run listed is read back through
// the older pages that it names (a rel="next" link, or ?paged=N+1 for a WordPress feed), on its own origin and keeping the query of the watched
// URL, until a page lists one of them or nothing new, at most --max-older-pages pages (default 10); each is saved and recorded under its watched
// URL as olderPages, and a source that still does not reach the previous run is a possible gap of the work list.
// The target checkout is only read; every file is written atomically, and a failed run leaves nothing behind.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags, repoName, UsageError } from "./drift/lib/args.mjs";
import { writeFilesAtomically } from "./drift/lib/atomic.mjs";
import { outDirectory, resolveIo, runAsMain, stableJson } from "./drift/lib/cli.mjs";
import { parseManifestFile } from "./drift/lib/dependencies.mjs";
import { listFiles, matchesGlob } from "./drift/lib/glob.mjs";
import { readProjectSources } from "./drift/lib/manifest.mjs";
import { buildIndex, compareWithPrevious, digestSnapshot, ENTRY_KINDS, extractCitations, rankCitations, renderChangesMarkdown, usableIndex } from "./drift/lib/watch-digest.mjs";

const OPTIONS = {
  out: { type: "string" },
  project: { type: "string" },
  checkout: { type: "string" },
  manifest: { type: "string" },
  previous: { type: "string" },
  "timeout-ms": { type: "string" },
  "max-bytes": { type: "string" },
  "cited-budget-ms": { type: "string" },
  "max-older-pages": { type: "string" },
};

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** The cited pages share one time budget, so that a slow documentation site cannot hold the job for maxPages times the timeout. */
const DEFAULT_CITED_BUDGET_MS = 8 * 60 * 1000;
/**
 * How many older pages of one source a run reads to reach back to the previous run. On 2026-11-13 a page held 11 days of github.blog's changelog,
 * 12 of the github/gh-aw releases and 3.5 of the github/copilot-cli releases, so ten older pages cover a monthly schedule, or a weekly one after
 * a failed run (a failed run is never a baseline).
 */
const DEFAULT_MAX_OLDER_PAGES = 10;
const MAX_CITING_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_CITING_FILES = 10;
const MAX_MATCHES_PER_PATTERN = 500;
const ORCHESTRATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

class SnapshotFailure extends Error {}

function extensionOf(contentType) {
  const type = String(contentType ?? "");
  if (/^(?:text\/html|application\/xhtml\+xml)$/.test(type)) return ".html";
  if (/^application\/(?:[\w.+-]+\+)?json$/.test(type)) return ".json";
  if (/^(?:application|text)\/(?:[\w.+-]+\+)?xml$/.test(type)) return ".xml";
  if (type === "text/markdown") return ".md";
  return type.startsWith("text/") || type === "" ? ".txt" : ".bin";
}

/** The file of a watched URL: its host and a short hash of the URL, so that the name never depends on the order. */
function snapshotName(url, contentType) {
  const host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return `${host}-${sha256(url).slice(0, 12)}${extensionOf(contentType)}`;
}

async function readCapped(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new SnapshotFailure(`the response is larger than ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SnapshotFailure(`the response is larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function describeError(error, timeoutMs) {
  if (error instanceof SnapshotFailure) return error.message;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `timed out after ${timeoutMs} ms`;
  const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
  return `${error?.message ?? error}${cause}`;
}

/** One attempt: the manifest record and, when the fetch worked, the snapshot file to write. */
async function snapshotUrl(entry, { fetch, timeoutMs, maxBytes }) {
  const record = { url: entry.url, label: entry.label, kind: entry.kind, state: "failed", status: null, snapshot: null, contentType: null, bytes: null, sha256: null, error: null };
  try {
    const response = await fetch(entry.url, { method: "GET", redirect: "follow", headers: { Accept: ACCEPT, "User-Agent": "sdlc-orchestrator-drift-snapshot" }, signal: AbortSignal.timeout(timeoutMs) });
    record.status = response.status;
    record.contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || null;
    if (response.url && response.url !== entry.url && response.url !== new URL(entry.url).href) record.finalUrl = response.url;
    if (!response.ok) {
      await response.body?.cancel?.();
      record.error = `HTTP ${response.status}`;
      return { record };
    }
    const bytes = await readCapped(response, maxBytes);
    if (bytes.length === 0) {
      record.error = "the response body is empty";
      return { record };
    }
    const name = snapshotName(entry.url, record.contentType);
    record.state = "ok";
    record.snapshot = `sources/${name}`;
    record.bytes = bytes.length;
    record.sha256 = sha256(bytes);
    return { record, file: { relative: record.snapshot, data: bytes } };
  } catch (error) {
    record.error = describeError(error, timeoutMs);
    return { record };
  }
}

function snapshotPatterns(patterns, checkout, fs) {
  const records = [];
  const files = new Map();
  const limitations = [];
  let listing = null;
  for (const pattern of [...patterns].sort(compare)) {
    if (listing === null) listing = listFiles(checkout, { fs });
    let matched = listing.filter((relative) => matchesGlob(pattern, relative));
    const record = { pattern, state: matched.length > 0 ? "matched" : "unmatched", files: [] };
    if (matched.length === 0) limitations.push(`the package manifest pattern '${pattern}' matches no file in the target checkout`);
    if (matched.length > MAX_MATCHES_PER_PATTERN) {
      limitations.push(`the package manifest pattern '${pattern}' matches ${matched.length} files; the first ${MAX_MATCHES_PER_PATTERN} are snapshotted`);
      matched = matched.slice(0, MAX_MATCHES_PER_PATTERN);
    }
    for (const relative of matched) {
      const bytes = fs.readFileSync(path.join(checkout, relative));
      const parsed = parseManifestFile(relative, bytes);
      const snapshot = `sources/manifests/${relative}`;
      files.set(snapshot, bytes);
      const entry = { path: relative, snapshot, bytes: bytes.length, sha256: sha256(bytes), parser: parsed.parser, dependencies: parsed.dependencies };
      if (parsed.engines) entry.engines = parsed.engines;
      if (parsed.frameworks) entry.frameworks = parsed.frameworks;
      if (parsed.error) {
        entry.error = parsed.error;
        limitations.push(`${relative}: ${parsed.error}`);
      }
      record.files.push(entry);
    }
    records.push(record);
  }
  return { records, files, limitations };
}

/**
 * The cited pages of the target: every URL on one of `cited.hosts` that a file matching `cited.include` cites, the most cited first (at most
 * `cited.maxPages`), fetched one after the other within one time budget and saved as their text under sources/cited/.
 */
async function snapshotCitedPages(cited, checkout, { fetch, fs, now, timeoutMs, maxBytes, budgetMs }) {
  const citations = new Map();
  let scannedFiles = 0;
  for (const relative of listFiles(checkout, { fs })) {
    if (!cited.include.some((pattern) => matchesGlob(pattern, relative))) continue;
    const absolute = path.join(checkout, relative);
    if (fs.statSync(absolute).size > MAX_CITING_FILE_BYTES) continue;
    scannedFiles += 1;
    const urls = extractCitations(fs.readFileSync(absolute, "utf8"), cited.hosts);
    if (urls.length > 0) citations.set(relative, urls);
  }
  const citedUrls = new Set([...citations.values()].flat()).size;
  const records = [];
  const files = new Map();
  const limitations = [];
  const deadline = now() + budgetMs;
  let skipped = 0;
  for (const page of rankCitations(citations, cited.maxPages)) {
    const base = { url: page.url, citations: page.citations, citedBy: page.citedBy.slice(0, MAX_LISTED_CITING_FILES), citedByCount: page.citedBy.length };
    if (now() >= deadline) {
      skipped += 1;
      records.push({ ...base, state: "skipped", status: null, snapshot: null, textSha256: null, error: `not fetched: the ${Math.round(budgetMs / 1000)} s budget for cited pages ran out` });
      continue;
    }
    const { record, file } = await snapshotUrl({ url: page.url, label: page.url, kind: "docs" }, { fetch, timeoutMs, maxBytes });
    if (!file) {
      records.push({ ...base, state: "failed", status: record.status, snapshot: null, textSha256: null, error: record.error });
      limitations.push(`${page.url} (cited page): ${record.error}`);
      continue;
    }
    const digest = digestSnapshot({ url: page.url, kind: "docs", contentType: record.contentType, bytes: file.data });
    const snapshot = `sources/cited/${snapshotName(page.url, "text/plain")}`;
    files.set(snapshot, Buffer.from(`${digest.text}\n`, "utf8"));
    records.push({ ...base, state: "ok", status: record.status, snapshot, textSha256: digest.textSha256, error: null });
  }
  if (skipped > 0) limitations.push(`${skipped} cited page(s) were not fetched: the ${Math.round(budgetMs / 1000)} s budget for cited pages ran out`);
  return { scannedFiles, citedUrls, records, files, limitations };
}

/**
 * The URL of the older page `next` when the run may read it: on the origin of the watched URL, without credentials, and keeping every query
 * parameter of the watched URL (the next link of github.blog's ?label= view drops the label and leads to the whole changelog); else null.
 */
function followable(next, watched) {
  if (typeof next !== "string") return null;
  let candidate;
  try {
    candidate = new URL(next);
  } catch {
    return null;
  }
  if (candidate.origin !== watched.origin || candidate.username !== "" || candidate.password !== "") return null;
  for (const [key, value] of watched.searchParams) if (!candidate.searchParams.getAll(key).includes(value)) return null;
  return candidate.href;
}

/**
 * The older pages of an entry source whose first page lists none of the entries `known` to the previous run: read one after the other through
 * the older page that each names (followable() decides) until a page lists a known entry, there is no older page, a page lists nothing new, one
 * cannot be fetched, or `maxPages` were read (SPEC-02 AC42). What still does not reach the previous run is a possible gap of the comparison,
 * never a silent one.
 */
async function readOlderPages(entry, first, known, { fetch, timeoutMs, maxBytes, maxPages }) {
  const entries = [...first.entries];
  const listed = new Set(entries.map((item) => item.url));
  const pages = [];
  const files = [];
  const limitations = [];
  const watched = new URL(entry.url);
  const visited = new Set([watched.href]);
  let reached = entries.some((item) => known.has(item.url));
  let next = first.nextPage;
  while (!reached && pages.length < maxPages) {
    const url = followable(next, watched);
    if (url === null || visited.has(url)) break;
    visited.add(url);
    const { record, file } = await snapshotUrl({ url, label: entry.label, kind: entry.kind }, { fetch, timeoutMs, maxBytes });
    if (!file) {
      pages.push({ url, state: "failed", status: record.status, snapshot: null, entries: 0, error: record.error });
      limitations.push(`${url} (older page of ${entry.url}): ${record.error}`);
      break;
    }
    files.push(file);
    const digest = digestSnapshot({ url, kind: entry.kind, contentType: record.contentType, bytes: file.data });
    pages.push({ url, state: "ok", status: record.status, snapshot: record.snapshot, entries: digest.entries.length, error: null });
    let added = 0;
    for (const item of digest.entries) {
      if (listed.has(item.url)) continue;
      listed.add(item.url);
      entries.push(item);
      added += 1;
    }
    reached = digest.entries.some((item) => known.has(item.url));
    // a page that lists nothing new is the end: github.blog serves its first changelog page at every /changelog/page/N/
    if (added === 0) break;
    next = digest.nextPage;
  }
  return { entries, pages, files, limitations };
}

/** What --previous holds: the baseline that drift/previous-watch-index.mjs found (or why there is none) and, when found, its watch index. */
function readPrevious(directory, fs) {
  if (directory === null) return { baseline: { found: false, reason: "no previous watch index was given (--previous)" }, index: null };
  const read = (name) => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const baseline = read("baseline.json");
  if (baseline === null || typeof baseline !== "object" || typeof baseline.found !== "boolean") {
    return { baseline: { found: false, reason: `${directory} holds no baseline.json of the previous-run lookup` }, index: null };
  }
  if (!baseline.found) return { baseline: { found: false, reason: String(baseline.reason ?? "unknown") }, index: null };
  const index = read("watch-index.json");
  if (index === null || index.version !== 1 || !Array.isArray(index.sources)) {
    return { baseline: { found: false, reason: `the watch index of run ${baseline.runId} is missing or unreadable` }, index: null };
  }
  return { baseline: { found: true, runId: baseline.runId, runUrl: String(baseline.runUrl ?? ""), createdAt: String(baseline.createdAt ?? "") }, index };
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const project = String(flags.project ?? "").trim();
    if (project === "") throw new UsageError("--project is required");
    const timeoutMs = flags["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(flags["timeout-ms"]);
    const maxBytes = flags["max-bytes"] === undefined ? DEFAULT_MAX_BYTES : Number(flags["max-bytes"]);
    const citedBudgetMs = flags["cited-budget-ms"] === undefined ? DEFAULT_CITED_BUDGET_MS : Number(flags["cited-budget-ms"]);
    const maxOlderPages = flags["max-older-pages"] === undefined ? DEFAULT_MAX_OLDER_PAGES : Number(flags["max-older-pages"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new UsageError("--timeout-ms must be a positive whole number");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new UsageError("--max-bytes must be a positive whole number");
    if (!Number.isInteger(citedBudgetMs) || citedBudgetMs < 0) throw new UsageError("--cited-budget-ms must be a whole number of milliseconds");
    if (!Number.isInteger(maxOlderPages) || maxOlderPages < 0) throw new UsageError("--max-older-pages must be a whole number");

    const workspace = io.env.GITHUB_WORKSPACE ? path.resolve(io.env.GITHUB_WORKSPACE) : io.cwd;
    const manifestPath = path.resolve(io.cwd, flags.manifest ?? path.join(io.env.GITHUB_WORKSPACE ? workspace : ORCHESTRATOR_ROOT, "sdlc.yaml"));
    const config = await readProjectSources({ manifestPath, projectKey: project, fs: io.fs });
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));

    let checkout = null;
    if (config.packageManifests.length > 0 || config.citedPages !== null) {
      const name = flags.checkout ?? (config.repo !== "" ? repoName(config.repo) : "");
      if (name === "") throw new SnapshotFailure("--checkout is required to snapshot package manifests and cited pages");
      checkout = path.resolve(workspace, name);
      if (!io.fs.existsSync(checkout) || !io.fs.statSync(checkout).isDirectory()) throw new SnapshotFailure(`the target checkout '${checkout}' does not exist`);
    }

    const previous = readPrevious(flags.previous === undefined ? null : path.resolve(io.cwd, flags.previous), io.fs);
    /** The entries that the previous run listed, per watched URL: what an older page has to reach. */
    const knownEntries = new Map((usableIndex(previous.index)?.sources ?? []).filter((source) => source.state === "ok").map((source) => [source.url, new Set(source.entries)]));

    const writes = new Map();
    const urlRecords = [];
    const limitations = [];
    const sources = [];
    const ordered = [...config.watchUrls].sort((a, b) => compare(a.url, b.url) || compare(a.label, b.label));
    for (const entry of ordered) {
      const { record, file } = await snapshotUrl(entry, { fetch: io.fetch, timeoutMs, maxBytes });
      urlRecords.push(record);
      if (file) {
        writes.set(file.relative, file.data);
        const digest = digestSnapshot({ url: entry.url, kind: entry.kind, contentType: record.contentType, bytes: file.data });
        let entries = digest.entries;
        let pagesRead = 1;
        const known = knownEntries.get(entry.url);
        if (ENTRY_KINDS.has(entry.kind) && known !== undefined && known.size > 0) {
          const older = await readOlderPages(entry, digest, known, { fetch: io.fetch, timeoutMs, maxBytes, maxPages: maxOlderPages });
          entries = older.entries;
          pagesRead += older.pages.filter((page) => page.state === "ok").length;
          for (const page of older.files) writes.set(page.relative, page.data);
          limitations.push(...older.limitations);
          if (older.pages.length > 0) record.olderPages = older.pages;
        }
        sources.push({ url: entry.url, label: entry.label, kind: entry.kind, state: "ok", textSha256: digest.textSha256, entries, pagesRead });
      } else {
        limitations.push(`${entry.url}: ${record.error}`);
        sources.push({ url: entry.url, label: entry.label, kind: entry.kind, state: "failed", error: record.error });
      }
    }
    let patternRecords = [];
    if (checkout !== null && config.packageManifests.length > 0) {
      const result = snapshotPatterns(config.packageManifests, checkout, io.fs);
      patternRecords = result.records;
      for (const [relative, data] of result.files) writes.set(relative, data);
      limitations.push(...result.limitations);
    }
    let cited = null;
    if (config.citedPages !== null) {
      cited = await snapshotCitedPages(config.citedPages, checkout, { fetch: io.fetch, fs: io.fs, now: io.now, timeoutMs, maxBytes, budgetMs: citedBudgetMs });
      for (const [relative, data] of cited.files) writes.set(relative, data);
      limitations.push(...cited.limitations);
    }
    const manifest = { version: 1, project, watchUrls: urlRecords, packageManifests: patternRecords, limitations };
    if (cited !== null) {
      manifest.citedPages = { include: config.citedPages.include, hosts: config.citedPages.hosts, maxPages: config.citedPages.maxPages, scannedFiles: cited.scannedFiles, citedUrls: cited.citedUrls, pages: cited.records };
    }

    const current = { project, sources, citedPages: cited?.records ?? [] };
    const changes = compareWithPrevious({ current, previous: previous.index, baseline: previous.baseline });
    writes.set("sources/watch-index.json", stableJson(buildIndex(current)));
    writes.set("sources/changes.json", stableJson(changes));
    writes.set("sources/changes.md", renderChangesMarkdown(changes));

    const files = [...writes.entries()].sort(([a], [b]) => compare(a, b)).map(([relative, data]) => ({ path: path.join(out, ...relative.split("/")), data }));
    files.push({ path: path.join(out, "sources", "manifest.json"), data: stableJson(manifest) });
    writeFilesAtomically(files, { fs: io.fs });

    const failed = urlRecords.filter((record) => record.state === "failed").length;
    const citedLine = cited === null ? "" : `, ${cited.records.filter((record) => record.state === "ok").length} of ${cited.records.length} cited page(s) saved`;
    const olderPages = urlRecords.reduce((total, record) => total + (record.olderPages ?? []).filter((page) => page.state === "ok").length, 0);
    const olderLine = olderPages > 0 ? `, ${olderPages} older page(s) read to reach the previous run` : "";
    const since = previous.baseline.found ? `run ${previous.baseline.runId}` : "no previous watch index";
    io.stdout(
      `snapshot-watch-sources: ${urlRecords.length - failed} of ${urlRecords.length} watched URL(s) saved${olderLine}, ${patternRecords.reduce((total, record) => total + record.files.length, 0)} package manifest file(s) saved${citedLine}, ${limitations.length} limitation(s), record in ${path.join(out, "sources", "manifest.json")}\n`,
    );
    io.stdout(
      `snapshot-watch-sources: since ${since}: ${changes.summary.newEntries} new entr${changes.summary.newEntries === 1 ? "y" : "ies"}, ${changes.summary.changedSources} changed source(s), ${changes.summary.changedCitedPages} changed cited page(s), ${changes.summary.possibleGaps} possible gap(s); work list in ${path.join(out, "sources", "changes.md")}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`snapshot-watch-sources: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
