#!/usr/bin/env node
// Lab Studio drift (contract C7 (2)(a), SPEC-04 AC31-AC34).
//
//   node scripts/lab-studio-drift.mjs --portfolio <abs-path> --upstream <abs-path> --commit <40-hex-sha> [--accept]
//
// The studio manifest of the downstream checkout records one revision of the upstream repository and, for each of its twenty lessons, the first sixteen
// hexadecimal characters of the SHA-256 of the lesson's source file with its line ends normalised to LF. This command recomputes those hashes from the
// upstream checkout and compares them with the recorded ones.
//
//   exit 0  every hash matches (status "in-sync", even when the recorded commit is not --commit), or --accept recorded the new state ("accepted")
//   exit 1  at least one hash differs and --accept was not given ("drift")
//   exit 2  a fatal error: nothing is written and standard output carries no JSON
//
// Standard output is one JSON line, { status, previousCommit, targetCommit, changedLabs }, where changedLabs lists the lessons whose recomputed hash
// differs from the recorded one. Without --accept the command writes nothing. With --accept it changes the manifest by those values only: the recorded
// commit and each changed hash, in place, so that the key order, the field order, the indentation, the line ends and everything else stay as they were.
//
// The path of the manifest is data of the fleet manifest (sdlc.yaml, adaptation.helpers.labStudioDrift.manifest): this file names no repository and no path.
//
// This script belongs to the orchestrator repository, not to the engine. It imports the engine only through its public API, ai-sdlc-factory/script-kit.

import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { helperSection, isInside, ManifestError, parseFlags, readManifest, relativePath, resolveIo, runAsMain, UsageError, writeFilesAtomically } from "ai-sdlc-factory/script-kit";

const OPTIONS = { portfolio: { type: "string" }, upstream: { type: "string" }, commit: { type: "string" }, accept: { type: "boolean" } };
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{16}$/;
const LAB_KEYS = Array.from({ length: 20 }, (_, index) => `lab${String(index + 1).padStart(2, "0")}`);
const ENTRY_KEYS = ["source", "sourceHash", "studio", "studioExists"];

/** A fatal error of this command: exit 2, nothing written. */
class DriftError extends Error {
  constructor(message) {
    super(message);
    this.name = "DriftError";
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The hash of one lesson source: sha256, first 16 lowercase hexadecimal characters, over the bytes of the file with CRLF turned into LF. The bytes go
 * through a latin1 string and back (one character per byte), exactly as the studio's own checker does it, so that no byte is ever re-encoded.
 */
export function labDigest(bytes) {
  const normalised = Buffer.from(Buffer.from(bytes).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return crypto.createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

/** The manifest, checked for exactly the shape that this command relies on. @throws {DriftError} */
function validateManifest(text, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new DriftError(`${manifestPath} cannot be parsed as JSON: ${error.message}`);
  }
  if (!isObject(manifest)) throw new DriftError(`${manifestPath} is not a JSON object`);
  const keys = Object.keys(manifest);
  const expected = ["_provenance", ...LAB_KEYS];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new DriftError(`${manifestPath} must have exactly the top-level keys _provenance followed by ${LAB_KEYS[0]} to ${LAB_KEYS.at(-1)}, in that order`);
  }
  if (!isObject(manifest._provenance) || typeof manifest._provenance.commit !== "string") {
    throw new DriftError(`${manifestPath}: _provenance must be an object with a commit string`);
  }
  for (const key of LAB_KEYS) {
    const entry = manifest[key];
    if (!isObject(entry)) throw new DriftError(`${manifestPath}: ${key} is not an object`);
    const fields = Object.keys(entry);
    if (fields.length !== ENTRY_KEYS.length || ENTRY_KEYS.some((field) => !Object.hasOwn(entry, field))) {
      throw new DriftError(`${manifestPath}: ${key} must hold exactly ${ENTRY_KEYS.join(", ")}`);
    }
    if (typeof entry.sourceHash !== "string" || !HASH.test(entry.sourceHash)) {
      throw new DriftError(`${manifestPath}: ${key}.sourceHash must be 16 lowercase hexadecimal characters`);
    }
    if (typeof entry.source !== "string") throw new DriftError(`${manifestPath}: ${key}.source must be a string`);
  }
  return manifest;
}

/** Replaces the one value that the pattern's second group captures; the patched text is checked by the caller. */
function replaceValue(text, pattern, value) {
  let replaced = false;
  const out = text.replace(pattern, (match, before, _old, after) => {
    if (replaced) return match;
    replaced = true;
    return `${before}${value}${after}`;
  });
  if (!replaced) throw new DriftError("the manifest cannot be updated in place");
  return out;
}

/** The manifest text with the new commit and the new hashes in place of the old ones, and nothing else changed. */
function patchManifest(text, manifest, commit, hashes) {
  let out = replaceValue(text, /("_provenance"\s*:\s*\{[^{}]*?"commit"\s*:\s*")([^"\\]*)(")/, commit);
  for (const [key, hash] of Object.entries(hashes)) {
    out = replaceValue(out, new RegExp(`("${key}"\\s*:\\s*\\{[^{}]*?"sourceHash"\\s*:\\s*")([0-9a-f]{16})(")`), hash);
  }
  const expected = structuredClone(manifest);
  expected._provenance.commit = commit;
  for (const [key, hash] of Object.entries(hashes)) expected[key].sourceHash = hash;
  let reread;
  try {
    reread = JSON.parse(out);
  } catch {
    reread = undefined;
  }
  if (!isDeepStrictEqual(reread, expected) || !isDeepStrictEqual(Object.keys(reread), Object.keys(expected))) {
    throw new DriftError("the manifest cannot be updated in place without changing more than the commit and the hashes");
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {object} [ioInput] `env`, `cwd`, `fs`, `stdout`, `stderr`; a test passes fakes
 * @returns {Promise<number>} the exit code: 0, 1 or 2
 */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    for (const name of ["portfolio", "upstream", "commit"]) if (flags[name] === undefined || flags[name] === "") throw new UsageError(`--${name} is required`);
    if (!SHA.test(flags.commit)) throw new UsageError("--commit must be 40 lowercase hexadecimal characters");
    const accept = flags.accept === true;
    const portfolio = path.resolve(io.cwd, flags.portfolio);
    const upstream = path.resolve(io.cwd, flags.upstream);
    for (const [label, directory] of [["--portfolio", portfolio], ["--upstream", upstream]]) {
      const stat = io.fs.existsSync(directory) ? io.fs.statSync(directory) : null;
      if (stat === null || !stat.isDirectory()) throw new UsageError(`${label} is not a directory: ${directory}`);
    }

    const { document } = await readManifest({ cwd: io.cwd, env: io.env, avoid: [portfolio] });
    const section = helperSection(document, "labStudioDrift");
    if (section === null) throw new ManifestError("sdlc.yaml declares no adaptation.helpers.labStudioDrift data (the path of the studio manifest)");
    const manifestRelative = relativePath(isObject(section) ? section.manifest : undefined, "adaptation.helpers.labStudioDrift.manifest");
    const manifestPath = path.join(portfolio, ...manifestRelative.split("/"));
    if (!isInside(portfolio, manifestPath)) throw new DriftError(`${manifestRelative} resolves outside --portfolio`);
    if (!io.fs.existsSync(manifestPath)) throw new DriftError(`${manifestPath} does not exist`);
    const text = io.fs.readFileSync(manifestPath, "utf8");
    const manifest = validateManifest(text, manifestRelative);

    const missing = [];
    const recomputed = {};
    for (const key of LAB_KEYS) {
      const source = relativePath(manifest[key].source, `${manifestRelative}: ${key}.source`);
      const file = path.join(upstream, ...source.split("/"));
      if (!isInside(upstream, file) || !io.fs.existsSync(file) || !io.fs.statSync(file).isFile()) {
        missing.push(`${key}: ${source}`);
        continue;
      }
      recomputed[key] = labDigest(io.fs.readFileSync(file));
    }
    if (missing.length > 0) throw new DriftError(`upstream files named by the manifest are absent under --upstream: ${missing.join(", ")}`);

    const changedLabs = LAB_KEYS.filter((key) => recomputed[key] !== manifest[key].sourceHash);
    const previousCommit = manifest._provenance.commit;
    let status;
    if (accept) {
      const hashes = Object.fromEntries(changedLabs.map((key) => [key, recomputed[key]]));
      const patched = patchManifest(text, manifest, flags.commit, hashes);
      writeFilesAtomically([{ path: manifestPath, data: patched }], { fs: io.fs });
      status = "accepted";
    } else {
      status = changedLabs.length === 0 ? "in-sync" : "drift";
    }
    io.stdout(`${JSON.stringify({ status, previousCommit, targetCommit: flags.commit, changedLabs })}\n`);
    return status === "drift" ? 1 : 0;
  } catch (error) {
    // every failure is a fatal error here: exit 1 is the drift of the contract and must never mean a crash
    const known = error instanceof UsageError || error instanceof ManifestError || error instanceof DriftError;
    io.stderr(`lab-studio-drift: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
