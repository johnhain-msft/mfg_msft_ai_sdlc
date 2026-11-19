#!/usr/bin/env node
// Studio revision pins (contract C7 (2)(b), SPEC-04 AC35-AC39).
//
//   node scripts/bump-studio-revision-pins.mjs --portfolio <abs-path> --new-sha <40-hex-sha>
//
// The downstream checkout names the upstream revision it was adapted to in a handful of places: a constant of a source module, assertions of its tests,
// links in a README, a notice and a page. When the revision moves, those literals move with it. This command reads the revision that the checkout
// records now (the prior revisions, from the provenance files that the manifest names, never from anything that the poll cursor holds) and replaces them
// with --new-sha in the target files that the manifest names, and in those files only:
//
//   - every occurrence of a prior 40-hex revision becomes --new-sha, except inside a `//` or `/* */` comment of a TypeScript file (the scanner of
//     ts-scan.mjs tells a comment from the `//` of a URL in a string);
//   - the 7-hex short form of a prior revision becomes the first seven characters of --new-sha only inside a code-level `expect(...)` call or an
//     assignment expression of a TypeScript file; any other short form outside a comment is left and reported on standard error as
//     `unreplaced-short-sha: <file>:<line>`, for the agent (or a person) to look at.
//
// After the replacement the pin constant must equal --new-sha: when it does not (the bump ran after the accept commands, which had already moved the
// prior revisions to --new-sha) the command exits 2 and writes nothing. It never writes a provenance file: only the accept commands do. A second run with
// the same --new-sha finds no prior revision left and changes nothing.
//
//   exit 0  done (also when no literal needed replacing)     exit 2  a fatal error: every file is as it was
//
// The provenance files, the target files and the pin constant are data of the fleet manifest (sdlc.yaml, adaptation.helpers.revisionPins): this file names no
// repository and no path. Standard output is one JSON line: { newSha, priorShas, updatedFiles }.
//
// This script belongs to the orchestrator repository, not to the engine. It imports the engine only through its public API, ai-sdlc-factory/script-kit.

import path from "node:path";
import { helperSection, inComment, isInside, ManifestError, matchingBracket, parseFlags, readManifest, relativePath, resolveIo, resolvePointer, runAsMain, scan, UsageError, writeFilesAtomically } from "ai-sdlc-factory/script-kit";

const OPTIONS = { portfolio: { type: "string" }, "new-sha": { type: "string" } };
const SHA = /^[0-9a-f]{40}$/;
const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/i;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A fatal error of this command: exit 2, every file as it was. */
class PinError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinError";
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ASSIGNMENT = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);
const CONTINUES_LINE = new Set([".", "?.", "(", "[", ",", "?", ":", "+", "-", "*", "/", "%", "**", "&", "|", "^", "&&", "||", "??", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "=>"]);

/** The source ranges of every `expect(...)` call chain (`expect(a).not.toBe(b)`) and of the right-hand side of every assignment, in a scan. */
function codeSpans(scanned) {
  const { tokens, lineOf } = scanned;
  const spans = [];
  tokens.forEach((token, i) => {
    if (token.type !== "ident" || token.value !== "expect" || tokens[i + 1]?.value !== "(" || tokens[i + 1].type !== "punct") return;
    if (i > 0 && (tokens[i - 1].value === "." || tokens[i - 1].value === "?.")) return;
    let close = matchingBracket(tokens, i + 1);
    if (close === -1) return;
    let end = tokens[close].end;
    let j = close + 1;
    while ((tokens[j]?.value === "." || tokens[j]?.value === "?.") && tokens[j].type === "punct" && tokens[j + 1]?.type === "ident") {
      end = tokens[j + 1].end;
      j += 2;
      if (tokens[j]?.value === "(" && tokens[j].type === "punct") {
        close = matchingBracket(tokens, j);
        if (close === -1) break;
        end = tokens[close].end;
        j = close + 1;
      }
    }
    spans.push({ start: token.start, end });
  });
  tokens.forEach((token, k) => {
    if (token.type !== "punct" || !ASSIGNMENT.has(token.value)) return;
    const first = tokens[k + 1];
    if (first === undefined) return;
    const baseDepth = first.templateDepth;
    let depth = 0;
    let end = first.end;
    let previous = token;
    for (let j = k + 1; j < tokens.length; j += 1) {
      const current = tokens[j];
      if (current.templateDepth > baseDepth) {
        end = Math.max(end, current.end);
        continue;
      }
      if (current.templateDepth < baseDepth) break;
      if (current.type === "punct") {
        if (current.value === "(" || current.value === "[" || current.value === "{") depth += 1;
        else if (current.value === ")" || current.value === "]" || current.value === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && (current.value === ";" || current.value === ",")) break;
      }
      // a line that ends a value and is followed by a line that cannot continue it ends the expression (automatic semicolon insertion)
      if (depth === 0 && j > k + 1 && lineOf(current.start) > lineOf(previous.end - 1)) {
        const endsValue = ["ident", "number", "string", "template", "regex"].includes(previous.type) || [")", "]", "}"].includes(previous.value);
        const continues = (current.type === "punct" && CONTINUES_LINE.has(current.value)) || current.type === "template" || (current.type === "ident" && ["instanceof", "in", "as", "satisfies"].includes(current.value));
        if (endsValue && !continues) break;
      }
      end = Math.max(end, current.end);
      previous = current;
    }
    spans.push({ start: first.start, end });
  });
  return spans;
}

/**
 * The text of one target file with the prior revisions replaced.
 * @param {string} text
 * @param {{ typescript: boolean, priors: string[], newSha: string }} options
 * @returns {{ text: string, unreplacedShort: number[] }} the new text, and the lines of the short forms that were found and left
 */
export function bumpText(text, { typescript, priors, newSha }) {
  const scanned = typescript ? scan(text) : null;
  const comments = scanned?.comments ?? [];
  const spans = scanned === null ? [] : codeSpans(scanned);
  const edits = [];
  const unreplaced = [];
  for (const prior of priors) {
    if (prior === newSha) continue;
    const full = new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(prior)}(?![0-9A-Za-z])`, "g");
    for (const match of text.matchAll(full)) {
      if (!inComment(comments, match.index)) edits.push({ start: match.index, end: match.index + prior.length, text: newSha });
    }
    const short = prior.slice(0, 7);
    const pattern = new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(short)}(?![0-9A-Za-z])`, "g");
    for (const match of text.matchAll(pattern)) {
      if (inComment(comments, match.index)) continue;
      const inCode = typescript && spans.some((span) => match.index >= span.start && match.index + short.length <= span.end);
      if (inCode) edits.push({ start: match.index, end: match.index + short.length, text: newSha.slice(0, 7) });
      else unreplaced.push(match.index);
    }
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  return { text: out, unreplacedShort: unreplaced.sort((a, b) => a - b).map(lineOf) };
}

/** The values assigned to `name` in a TypeScript source: `NAME = "..."`, `NAME: string = "..."`. */
export function assignedLiterals(text, name) {
  const { tokens } = scan(text);
  const values = [];
  tokens.forEach((token, i) => {
    if (token.type !== "ident" || token.value !== name || tokens[i - 1]?.value === "." || tokens[i - 1]?.value === "?.") return;
    let j = i + 1;
    if (tokens[j]?.value === ":") {
      // a type annotation: skip to the `=` of the same declaration
      while (j < tokens.length && j < i + 16 && tokens[j].value !== "=" && tokens[j].value !== ";") j += 1;
    }
    if (tokens[j]?.value === "=" && tokens[j].type === "punct" && typeof tokens[j + 1]?.text === "string") values.push(tokens[j + 1].text);
  });
  return values;
}

/** The pin data of the manifest, checked. @throws {ManifestError} */
function readPinData(section) {
  if (!isObject(section)) throw new ManifestError("adaptation.helpers.revisionPins must be a mapping");
  const { provenance, files, constant } = section;
  if (!Array.isArray(provenance) || provenance.length === 0) throw new ManifestError("adaptation.helpers.revisionPins.provenance must be a non-empty list");
  if (!Array.isArray(files) || files.length === 0) throw new ManifestError("adaptation.helpers.revisionPins.files must be a non-empty list");
  if (!isObject(constant) || typeof constant.name !== "string" || !NAME.test(constant.name)) throw new ManifestError("adaptation.helpers.revisionPins.constant needs a file and a name");
  const provenanceFiles = provenance.map((entry, index) => {
    if (!isObject(entry) || typeof entry.pointer !== "string") throw new ManifestError(`adaptation.helpers.revisionPins.provenance[${index}] needs a file and a pointer`);
    return { file: relativePath(entry.file, `adaptation.helpers.revisionPins.provenance[${index}].file`), pointer: entry.pointer };
  });
  const targets = [...new Set(files.map((file, index) => relativePath(file, `adaptation.helpers.revisionPins.files[${index}]`)))];
  const constantFile = relativePath(constant.file, "adaptation.helpers.revisionPins.constant.file");
  if (!targets.includes(constantFile)) throw new ManifestError("the file of adaptation.helpers.revisionPins.constant must be one of adaptation.helpers.revisionPins.files");
  for (const { file } of provenanceFiles) {
    if (targets.includes(file)) throw new ManifestError(`${file} is a provenance file and cannot be a pin target: only the accept commands write it`);
  }
  return { provenanceFiles, targets, constant: { file: constantFile, name: constant.name } };
}

/**
 * @param {string[]} argv
 * @param {object} [ioInput] `env`, `cwd`, `fs`, `stdout`, `stderr`; a test passes fakes
 * @returns {Promise<number>} the exit code: 0 or 2
 */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    for (const name of ["portfolio", "new-sha"]) if (flags[name] === undefined || flags[name] === "") throw new UsageError(`--${name} is required`);
    const newSha = flags["new-sha"];
    if (!SHA.test(newSha)) throw new UsageError("--new-sha must be 40 lowercase hexadecimal characters");
    const portfolio = path.resolve(io.cwd, flags.portfolio);
    if (!io.fs.existsSync(portfolio) || !io.fs.statSync(portfolio).isDirectory()) throw new UsageError(`--portfolio is not a directory: ${portfolio}`);

    const { document } = await readManifest({ cwd: io.cwd, env: io.env, avoid: [portfolio] });
    const section = helperSection(document, "revisionPins");
    if (section === null) throw new ManifestError("sdlc.yaml declares no adaptation.helpers.revisionPins data (the provenance files, the target files and the pin constant)");
    const { provenanceFiles, targets, constant } = readPinData(section);
    const inPortfolio = (relative) => {
      const file = path.join(portfolio, ...relative.split("/"));
      if (!isInside(portfolio, file)) throw new PinError(`${relative} resolves outside --portfolio`);
      return file;
    };

    // the prior revisions: what the checkout records now, read from its own provenance files
    const priors = [];
    for (const { file, pointer } of provenanceFiles) {
      let value;
      try {
        value = resolvePointer(JSON.parse(io.fs.readFileSync(inPortfolio(file), "utf8")), pointer);
      } catch (error) {
        if (error instanceof PinError) throw error;
        throw new PinError(`the provenance file ${file} cannot be read as JSON: ${error.message}`);
      }
      if (typeof value !== "string" || !SHA.test(value)) throw new PinError(`${file}${pointer} is not a 40-character lowercase hexadecimal revision`);
      if (!priors.includes(value)) priors.push(value);
    }

    const writes = [];
    const notes = [];
    let constantText = null;
    for (const relative of targets) {
      const file = inPortfolio(relative);
      if (!io.fs.existsSync(file) || !io.fs.statSync(file).isFile()) {
        if (relative === constant.file) throw new PinError(`${relative}, the file of the pin constant, does not exist`);
        notes.push(`skipped-missing-file: ${relative}`);
        continue;
      }
      const before = io.fs.readFileSync(file, "utf8");
      const { text: after, unreplacedShort } = bumpText(before, { typescript: TYPESCRIPT.test(relative), priors, newSha });
      for (const line of unreplacedShort) notes.push(`unreplaced-short-sha: ${relative}:${line}`);
      if (relative === constant.file) constantText = after;
      if (after !== before) writes.push({ relative, path: file, data: after });
    }

    // the pin constant must hold --new-sha now: a bump that ran after the accept commands leaves it at the old revision
    const literals = assignedLiterals(constantText ?? "", constant.name);
    if (literals.length === 0) throw new PinError(`${constant.file} assigns no string to ${constant.name}`);
    if (literals.some((literal) => literal !== newSha)) {
      throw new PinError(`${constant.name} in ${constant.file} is not ${newSha} after the replacement: the prior revisions were ${priors.join(" and ")} (was this command run after the accept commands, which move them?)`);
    }

    writeFilesAtomically(writes.map(({ path: target, data }) => ({ path: target, data })), { fs: io.fs });
    for (const note of notes) io.stderr(`${note}\n`);
    io.stdout(`${JSON.stringify({ newSha, priorShas: priors, updatedFiles: writes.map((entry) => entry.relative) })}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof UsageError || error instanceof ManifestError || error instanceof PinError;
    io.stderr(`bump-studio-revision-pins: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
