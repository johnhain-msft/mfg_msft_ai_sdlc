#!/usr/bin/env node
// Immutable gates (contract C7 (2)(c), SPEC-04 AC40-AC50).
//
//   node --frozen-intrinsics src/verify-immutable-gates.mjs --portfolio <abs-path> --base <40-hex-sha> --workflow <workflow-id>
//
// After the agent of an AI adaptation workflow has finished, this command decides whether its commits left the downstream checkout's own guard rails
// as they were. Everything that it enforces is data of the fleet manifest (sdlc.yaml, the immutableGates of the workflow's edge): this file names no
// repository, no path and no test title.
//
//   (i)   zero diff between --base and HEAD (and in the work tree) on the edge's zeroDiffPaths: the locked rule, runtime, authentication and sandbox files;
//   (ii)  zero diff on the companion test files of the sibling workflows (the other AI edges into the same downstream repository);
//   (iii) in the workflow's own companion test files, the lines before the first describe(, every describe( header line and the named locked blocks are
//         byte for byte what they were at --base (a block missing at --base or at HEAD is a violation), and neither the companion test files nor the
//         changed editable modules add a skip, only, todo, vi.mock, Object.assign, Object.defineProperty, Reflect use, a mutation of an identifier
//         imported from a locked module, a new import of one, or a local binding of an imported name;
//   (iv)  in this process, under frozen intrinsics: the locked modules are loaded and deeply frozen before any editable module is imported, the pinned
//         constants hold, the rule checker finds nothing in the course, the sanitiser finds nothing in the changed files; and Vitest runs the companion
//         test files, and every locked test passed. Check (iv) runs only when (i) to (iii) found nothing: it executes the downstream's code.
//
// Standard output is one JSON line, { status: "ok" | "violation", violatingFiles }, where violatingFiles holds the sorted repository-relative paths of
// every implicated file; every violation is also explained on standard error.
//
//   exit 0  status "ok"        exit 1  status "violation"        exit 2  a usage or fatal error: no JSON, nothing was decided

import fs from "node:fs";
import path from "node:path";
import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { resolveIo, runAsMain } from "./drift/lib/cli.mjs";
import { HarnessError, evaluateLockedTests, runVitest } from "./adaptation/vitest-run.mjs";
import { intrinsicsAreFrozen, readInvariants, runInProcessChecks } from "./adaptation/frozen-harness.mjs";
import { GitError, changedBetween, changedInWorkTree, isCommit, isWorkTree, showFile, topLevel, untrackedPaths } from "./adaptation/git.mjs";
import { ManifestError, gatePolicyFor, isInside, readManifest } from "./adaptation/manifest.mjs";
import { allowedBy, covers } from "./adaptation/paths.mjs";
import { CONSTRUCTS, addedConstructs, compareStructure, countConstructs } from "./adaptation/ts-structure.mjs";

const OPTIONS = { portfolio: { type: "string" }, base: { type: "string" }, workflow: { type: "string" } };
const SHA = /^[0-9a-f]{40}$/;
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const ZERO_COUNTS = Object.fromEntries(CONSTRUCTS.map((name) => [name, 0]));

const unique = (values) => [...new Set(values)];
const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * @param {string[]} argv
 * @param {object} [ioInput] `env`, `cwd`, `fs`, `stdout`, `stderr`; a test passes fakes
 * @returns {Promise<number>} the exit code: 0, 1 or 2
 */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    for (const name of ["portfolio", "base", "workflow"]) if (flags[name] === undefined || flags[name] === "") throw new UsageError(`--${name} is required`);
    if (!SHA.test(flags.base)) throw new UsageError("--base must be 40 lowercase hexadecimal characters");
    const portfolio = path.resolve(io.cwd, flags.portfolio);
    if (!io.fs.existsSync(portfolio) || !io.fs.statSync(portfolio).isDirectory()) throw new UsageError(`--portfolio is not a directory: ${portfolio}`);
    if (!isWorkTree(portfolio) || !isInside(portfolio, topLevel(portfolio)) || !isInside(topLevel(portfolio), portfolio)) {
      throw new UsageError(`--portfolio must be the root of a git work tree: ${portfolio}`);
    }
    if (!isCommit(portfolio, flags.base)) throw new UsageError(`--base is not a commit of ${portfolio}: ${flags.base}`);

    const { document } = await readManifest({ cwd: io.cwd, env: io.env, avoid: [portfolio] });
    const policy = gatePolicyFor(document, flags.workflow);
    if (policy === null) throw new UsageError(`unknown workflow '${flags.workflow}': sdlc.yaml has no ai-adaptation edge with that workflow id`);
    const invariants = readInvariants(policy.inProcessInvariants);

    const violations = [];
    const violate = (file, message) => violations.push({ file, message });
    const base = flags.base;
    const read = (file, committed = null) => {
      const target = path.join(portfolio, ...file.split("/"));
      if (!(isInside(portfolio, target) && io.fs.existsSync(target) && io.fs.statSync(target).isFile())) return null;
      const text = io.fs.readFileSync(target, "utf8");
      // A checkout that git converts to CRLF (core.autocrlf on Windows) holds the content of an LF blob: git reports no change there either. Only the line ends of
      // the work-tree copy are normalised, and only when the committed blob has no carriage return, so that what is committed is always compared as it is.
      return committed !== null && !committed.includes("\r") ? text.replace(/\r\n/g, "\n") : text;
    };

    // what differs from the base: the commits, the work tree and the index, and the files that git does not know yet
    const changed = sorted(unique([...changedBetween(portfolio, base, "HEAD"), ...changedInWorkTree(portfolio, base), ...untrackedPaths(portfolio)]));

    // (i) the locked files and directories
    for (const file of changed) {
      const entry = policy.zeroDiffPaths.find((candidate) => covers(candidate, file));
      if (entry !== undefined) violate(file, `check (i): ${file} differs from ${base.slice(0, 7)}, and ${entry} is locked`);
    }
    // (ii) the test files that another workflow owns
    for (const file of policy.siblingTestFiles) {
      if (changed.includes(file)) violate(file, `check (ii): ${file} belongs to another workflow and differs from ${base.slice(0, 7)}`);
    }

    // (iii) the companion test files and the editable modules
    const lockedModules = unique([
      ...invariants.frozenModules,
      ...(invariants.check ? [invariants.check.module] : []),
      ...(invariants.customerTerms ? [invariants.customerTerms.module] : []),
      ...invariants.constants.map((entry) => entry.module),
    ]);
    const companions = policy.lockedTestBlocks.map((entry) => entry.file);
    const editableChanged = changed.filter((file) => allowedBy(policy.allowedFiles, file) && SCRIPT.test(file) && !allowedBy(["public/**"], file));
    for (const entry of policy.lockedTestBlocks) {
      const baseText = showFile(portfolio, base, entry.file);
      const headBlob = showFile(portfolio, "HEAD", entry.file);
      if (baseText === null) violate(entry.file, `check (iii): ${entry.file} does not exist at ${base.slice(0, 7)}, so its locked blocks are missing there`);
      if (headBlob === null) violate(entry.file, `check (iii): ${entry.file} does not exist at HEAD, so its locked blocks are missing there`);
      if (baseText === null || headBlob === null) continue;
      const workTree = read(entry.file, headBlob);
      const heads = workTree === null || workTree === headBlob ? [headBlob] : [headBlob, workTree];
      for (const head of heads) {
        for (const problem of compareStructure({ baseText, headText: head, blocks: entry.blocks, lockedImports: entry.lockedImports ?? [] })) {
          violate(entry.file, `check (iii): ${entry.file}: ${problem}${head === headBlob ? "" : " (in the work tree)"}`);
        }
      }
    }
    for (const file of unique([...companions, ...editableChanged])) {
      const baseText = showFile(portfolio, base, file);
      const baseCounts = baseText === null ? ZERO_COUNTS : countConstructs(baseText, { filePath: file, lockedModules });
      const headBlob = showFile(portfolio, "HEAD", file);
      const workTree = read(file, headBlob);
      for (const [text, where] of [[headBlob, "HEAD"], [workTree !== headBlob ? workTree : null, "the work tree"]]) {
        if (text === null) continue;
        for (const { construct, base: before, head } of addedConstructs(baseCounts, countConstructs(text, { filePath: file, lockedModules }))) {
          violate(file, `check (iii): ${file} adds ${construct} (${before} at ${base.slice(0, 7)}, ${head} in ${where})`);
        }
      }
    }

    // (iv) only when nothing else was found: it executes the downstream's code
    if (violations.length === 0) {
      const course = invariants.course === null ? null : path.posix.dirname(invariants.course.module);
      const editableModules = editableChanged.filter((file) => /\.(?:[cm]?ts)$/.test(file) && course !== null && path.posix.dirname(file) === course && read(file) !== null);
      const texts = unique([...editableChanged, ...companions.filter((file) => changed.includes(file))]).flatMap((file) => {
        const blob = showFile(portfolio, "HEAD", file);
        const workTree = read(file, blob);
        return [blob, workTree !== blob ? workTree : null].filter((text) => text !== null).map((text) => ({ file, text }));
      });
      if (!intrinsicsAreFrozen() && (invariants.frozenModules.length > 0 || invariants.course !== null || lockedModules.length > 0)) {
        throw new HarnessError("check (iv) must run under node --frozen-intrinsics");
      }
      for (const { file, message } of await runInProcessChecks({ portfolio, invariants, editableModules, texts })) violate(file, `check (iv): ${message}`);
      if (policy.lockedTestBlocks.length > 0) {
        const { report, detail } = runVitest({ portfolio, files: companions });
        if (report === null) for (const file of companions) violate(file, `check (iv): Vitest produced no JSON report (${detail})`);
        else for (const { file, message } of evaluateLockedTests(report, policy.lockedTestBlocks)) violate(file, `check (iv): ${file}: ${message}`);
      }
    }

    const violatingFiles = sorted(unique(violations.map((entry) => entry.file)));
    for (const { message } of violations) io.stderr(`verify-immutable-gates: ${message}\n`);
    io.stdout(`${JSON.stringify({ status: violations.length === 0 ? "ok" : "violation", violatingFiles })}\n`);
    return violations.length === 0 ? 0 : 1;
  } catch (error) {
    const known = [UsageError, ManifestError, GitError, HarnessError].some((type) => error instanceof type);
    io.stderr(`verify-immutable-gates: ${known ? error.message : `unexpected error: ${error?.stack ?? error?.message ?? error}`}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
