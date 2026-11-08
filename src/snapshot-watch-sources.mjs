#!/usr/bin/env node
// Third pre-agent step of every drift workflow: snapshots of the watched sources (SPEC-02 AC11, AC12, AC37, AC38).
//
//   node src/snapshot-watch-sources.mjs --out /tmp/gh-aw/agent --project <projectKey> --checkout <directory>
//
// The project's knowledgeSources come from the fleet manifest (--manifest, default <orchestrator checkout>/sdlc.yaml):
//  - every watchUrls entry is fetched, without an AI step, and saved as one file under <out>/sources/;
//  - every file of the target checkout that matches a packageManifests pattern is copied under
//    <out>/sources/manifests/ together with the dependency names and versions it declares.
// <out>/sources/manifest.json records every attempt: url, label, kind, HTTP status and snapshot path, and the failed ones
// (an entry that cannot be fetched, a pattern that matches no file) with the reason, as limitations for the report.
// Nothing is dropped and nothing is guessed. The output holds no timestamp, entries are ordered by url and then by manifest
// path, and a second run on the same inputs writes the same bytes.
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

const OPTIONS = {
  out: { type: "string" },
  project: { type: "string" },
  checkout: { type: "string" },
  manifest: { type: "string" },
  "timeout-ms": { type: "string" },
  "max-bytes": { type: "string" },
};

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
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

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const project = String(flags.project ?? "").trim();
    if (project === "") throw new UsageError("--project is required");
    const timeoutMs = flags["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(flags["timeout-ms"]);
    const maxBytes = flags["max-bytes"] === undefined ? DEFAULT_MAX_BYTES : Number(flags["max-bytes"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new UsageError("--timeout-ms must be a positive whole number");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new UsageError("--max-bytes must be a positive whole number");

    const workspace = io.env.GITHUB_WORKSPACE ? path.resolve(io.env.GITHUB_WORKSPACE) : io.cwd;
    const manifestPath = path.resolve(io.cwd, flags.manifest ?? path.join(io.env.GITHUB_WORKSPACE ? workspace : ORCHESTRATOR_ROOT, "sdlc.yaml"));
    const config = await readProjectSources({ manifestPath, projectKey: project, fs: io.fs });
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));

    let checkout = null;
    if (config.packageManifests.length > 0) {
      const name = flags.checkout ?? (config.repo !== "" ? repoName(config.repo) : "");
      if (name === "") throw new SnapshotFailure("--checkout is required to snapshot package manifests");
      checkout = path.resolve(workspace, name);
      if (!io.fs.existsSync(checkout) || !io.fs.statSync(checkout).isDirectory()) throw new SnapshotFailure(`the target checkout '${checkout}' does not exist`);
    }

    const writes = new Map();
    const urlRecords = [];
    const limitations = [];
    const ordered = [...config.watchUrls].sort((a, b) => compare(a.url, b.url) || compare(a.label, b.label));
    for (const entry of ordered) {
      const { record, file } = await snapshotUrl(entry, { fetch: io.fetch, timeoutMs, maxBytes });
      urlRecords.push(record);
      if (file) writes.set(file.relative, file.data);
      else limitations.push(`${entry.url}: ${record.error}`);
    }
    let patternRecords = [];
    if (checkout !== null) {
      const result = snapshotPatterns(config.packageManifests, checkout, io.fs);
      patternRecords = result.records;
      for (const [relative, data] of result.files) writes.set(relative, data);
      limitations.push(...result.limitations);
    }
    const manifest = { version: 1, project, watchUrls: urlRecords, packageManifests: patternRecords, limitations };
    const files = [...writes.entries()].sort(([a], [b]) => compare(a, b)).map(([relative, data]) => ({ path: path.join(out, ...relative.split("/")), data }));
    files.push({ path: path.join(out, "sources", "manifest.json"), data: stableJson(manifest) });
    writeFilesAtomically(files, { fs: io.fs });

    const failed = urlRecords.filter((record) => record.state === "failed").length;
    io.stdout(
      `snapshot-watch-sources: ${urlRecords.length - failed} of ${urlRecords.length} watched URL(s) saved, ${patternRecords.reduce((total, record) => total + record.files.length, 0)} package manifest file(s) saved, ${limitations.length} limitation(s), record in ${path.join(out, "sources", "manifest.json")}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`snapshot-watch-sources: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
