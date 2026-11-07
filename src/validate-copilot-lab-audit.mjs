#!/usr/bin/env node
// Post-step validator of the lab audit (SPEC-02 AC22, AC23, AC33).
//
//   node "$GITHUB_WORKSPACE/src/validate-copilot-lab-audit.mjs" [--self-improve]
//
// It runs with the target checkout as its working directory (or --checkout) and exits 0 only when
//  1. docs/_meta/registry.yaml has all 11 top-level keys;
//  2. for an audit run: docs/_meta/audit-report.md has the four required sections, in order, and every `##` section of
//     docs/_meta/audit-report.template.md (the report is generated from that template);
//  3. for a self-improve run (--self-improve): self-improvement-report.md has its four required sections, in order. That run does not
//     check the audit report: the weekly audit generates it in its own pull request, so the default branch of the lab holds only the
//     template, and a self-improve run neither writes nor needs it;
//  4. nothing that a pull request could be made of differs from the base commit in `gh_aw_schema_version` or in any file under
//     .github/workflows/ (the version and the compiled workflows are report-only). "Anything that a pull request could be made of" is the
//     HEAD commit, the index and the working tree, every other commit that is not reachable from the base commit but is reachable from a
//     ref, and every patch (aw-*.patch) and bundle (aw-*.bundle) file next to the artifact directory, which are what `create_pull_request`
//     wrote during the agent step and what the safe_outputs job applies later (see drift/lib/git-artifacts.mjs). The base commit is
//     --base-sha, else SDLC_BASE_SHA, which prepare-run appended to GITHUB_ENV in the first step of the job, so that the runner and not a
//     file that the agent can edit supplies it.
// Rules 1 to 3 are checked on the working tree and on the tip of everything that a pull request could be made of (HEAD when it is ahead of the
// base commit, every other local branch that is ahead of it, the last message of each patch, every tip of each bundle), so that the agent
// cannot commit a registry or a report that is wrong, call `create_pull_request` and leave a working tree that is right.
// Anything else exits 1 and names each missing key or section, or the changed value or path, and where it is, on stderr. A patch or a bundle
// that cannot be read, or that does not apply to the base commit, exits 1 as well: a file that cannot be inspected is not a file that is fine.
// The script only reads the checkout. It writes nothing there: everything that it asks git is asked in a scratch repository in a temporary
// directory that it removes afterwards.
//
// The agent has just worked in that checkout and can write all of it, its .git directory included (its `git` tool takes any arguments),
// so the checks ask git for what the objects say and for nothing else that the agent can bend. Every git call runs with --no-replace-objects:
// `git replace <base> HEAD` would otherwise make git return the agent's own commit wherever it reads the base. A checkout that carries a
// replace ref or a graft file is refused: the runner's checkout has neither, and each is the mark of an agent that made it (the scratch
// repository below reads no graft file and ignores replace refs, so neither can change an answer here). What a
// commit changes is taken from the commit objects (`git diff-tree <base> <commit>`) and not from the index and the working tree, which the
// agent can put back after it has committed, and `gh_aw_schema_version` is read from every revision as well as from the working tree.
// Nor does the checkout's configuration get to run anything here. `.git/config` (`core.fsmonitor`, `filter.<name>.clean` with an attribute from
// `.git/info/attributes` or `.gitattributes`, a partial clone's remote), `.git/hooks` and the index make git start a program of the agent's choosing
// when it reads the index or the working tree or misses an object, and such a program could move the patch away before this script has read it and put
// it back afterwards. So no git process of this script runs in the checkout's repository: every one runs in the scratch repository of
// drift/lib/git-artifacts.mjs, which has a configuration of its own and takes from the checkout only files: its objects (an alternates file), a copy of
// its refs, HEAD and shallow file, its index file (as data) and its directory as the working tree. The patch and bundle files are copied into the
// scratch directory before anything else is read. A checkout whose own configuration sets one of those programs is refused too, as the mark of an
// agent that did it.
// The script does not protect its own file: it runs from the orchestrator checkout, the working directory of the agent step, and the agent can
// write there. The workflow protects it: prepare-run stages a copy of this file and of drift/lib/ under ${RUNNER_TEMP}/gh-aw/sdlc-validator/
// before the agent starts (the compiled agent step mounts ${RUNNER_TEMP}/gh-aw read-only), and the verifyCommands entry that runs this script
// first compares the two and fails when they differ (SPEC-02 AC22 and §4, item 6, say what that closes and what it leaves open).

import nodeFs from "node:fs";
import path from "node:path";
import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { BASE_SHA_VARIABLE, outDirectory, resolveIo, runAsMain } from "./drift/lib/cli.mjs";
import {
  branchTips,
  bundleCommits,
  COMMIT_LIMIT,
  commitsAhead,
  git,
  gitMessage,
  indexPaths,
  listRefs,
  openScratch,
  patchTrees,
  refsByCommit,
  replaceRefs,
  snapshotTransportFiles,
  workTreePaths,
} from "./drift/lib/git-artifacts.mjs";

const OPTIONS = {
  out: { type: "string" },
  checkout: { type: "string" },
  "base-sha": { type: "string" },
  "self-improve": { type: "boolean" },
};

export const REGISTRY_FILE = "docs/_meta/registry.yaml";
export const AUDIT_REPORT_FILE = "docs/_meta/audit-report.md";
export const AUDIT_TEMPLATE_FILE = "docs/_meta/audit-report.template.md";
export const SELF_IMPROVEMENT_CANDIDATES = ["docs/_meta/self-improvement-report.md", "self-improvement-report.md"];
export const PINNED_KEY = "gh_aw_schema_version";
export const REGISTRY_KEYS = [
  "schema_version",
  "copilot_cli_version_floor",
  "gh_aw_schema_version",
  "mcp_protocol_spec_version",
  "mcp_servers",
  "prepared_core",
  "models",
  "model_default_availability_policy",
  "enterprise_managed_settings",
  "labs",
  "audit",
];
export const AUDIT_SECTIONS = ["Summary", "Checks", "Suggestions for Additions", "Metadata"];
export const SELF_IMPROVEMENT_SECTIONS = ["Summary", "Findings", "Consolidation Candidates", "Metadata"];
const PROTECTED_DIRECTORY = ".github/workflows/";

/** The top-level keys of a YAML mapping, read line by line: { key, line, rest }. Nothing below the first level is looked at. */
export function scanTopLevelKeys(text) {
  const entries = [];
  String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line === "" || /^[ \t#]/.test(line) || /^(?:---|\.\.\.)(?:\s|$)/.test(line) || /^-(?:\s|$)/.test(line)) return;
      const match = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_.-]*))[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
      if (match === null) return;
      entries.push({ key: match[1] ?? (match[2] === undefined ? match[3] : match[2].replace(/''/g, "'")), line: index + 1, rest: match[4] ?? "" });
    });
  return entries;
}

/** The value written after a key, without a trailing comment and without its quotes. */
export function scalarOf(rest) {
  const text = String(rest).replace(/(^|\s)#.*$/, "").trim();
  const quoted = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text);
  return quoted === null ? text : quoted[1];
}

/** The `##` headings of a Markdown document, outside fenced code blocks and HTML comments. */
export function secondLevelHeadings(markdown) {
  const headings = [];
  let fence = null;
  let comment = false;
  for (const line of String(markdown).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    if (/^\s*<!--/.test(line) && !line.includes("-->")) {
      comment = true;
      continue;
    }
    const heading = /^ {0,3}##(?!#)[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/.exec(line);
    if (heading) headings.push(heading[1].trim());
  }
  return headings;
}

/** What is wrong with the sections of a report: a missing or misplaced required section, and a missing template section. */
export function sectionProblems(label, markdown, required, templateHeadings = []) {
  const problems = [];
  const headings = secondLevelHeadings(markdown);
  let previous = -1;
  let ordered = true;
  for (const name of required) {
    const position = headings.indexOf(name);
    if (position === -1) problems.push(`${label} is missing the section '## ${name}'`);
    else {
      if (position < previous) ordered = false;
      previous = position;
    }
  }
  if (!ordered && problems.length === 0) problems.push(`${label} has its required sections out of order (expected ${required.map((name) => `## ${name}`).join(", ")})`);
  let from = -1;
  for (const name of templateHeadings) {
    const position = headings.indexOf(name, from + 1);
    if (position === -1) {
      if (!required.includes(name)) problems.push(`${label} does not carry the template section '## ${name}'`);
    } else from = position;
  }
  return problems;
}

/** What a path under .github/workflows/ (any case, the directory itself included) is: a path that the report-only rule protects. */
const isProtectedPath = (entry) => {
  const lower = entry.toLowerCase();
  return lower === ".github/workflows" || lower.startsWith(PROTECTED_DIRECTORY);
};

/** Every path that a commit or a tree differs from the base commit in, read from the objects alone (`diff-tree`), through `options` (the scratch repository). */
function committedPaths(options, baseSha, revision) {
  return git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", baseSha, revision, "--"], options)
    .split("\0")
    .filter((entry) => entry !== "");
}

/**
 * Every path that differs from the base commit. What the commits change comes first and is read from the two commit objects alone
 * (`diff-tree`): an agent that commits a change and then puts the file back in its working tree leaves nothing for a comparison of the working
 * tree to see, and the pull request carries the commit. The index and the working tree add what is staged, modified, deleted or untracked. All of it
 * is read in a scratch repository (see drift/lib/git-artifacts.mjs), under no configuration of the checkout; `headSha` is a commit id, or HEAD.
 */
export function changedPaths(checkout, baseSha, env, headSha = "HEAD", fs = nodeFs) {
  const scratch = openScratch({ checkout, env, fs });
  try {
    const head = headSha === "HEAD" ? git(["rev-parse", "--verify", "HEAD^{commit}"], scratch.options).trim() : headSha;
    return [...new Set([...committedPaths(scratch.options, baseSha, head), ...indexPaths(scratch, baseSha, fs), ...workTreePaths(scratch, baseSha)])].sort();
  } finally {
    scratch.dispose();
  }
}

/** The value of the pinned key in the text of a registry: null when the registry has no such key. */
function pinnedValueOf(registry) {
  const entry = scanTopLevelKeys(registry).find((candidate) => candidate.key === PINNED_KEY);
  return entry === undefined ? null : scalarOf(entry.rest);
}

/** The pinned value as the registry of a revision (a commit or a tree) holds it, read through `options`: null when it has no registry, or no such key. */
function pinnedValueIn(options, revision) {
  try {
    return pinnedValueOf(git(["cat-file", "blob", `${revision}:${REGISTRY_FILE}`], options));
  } catch {
    return null;
  }
}

/** The pinned value as the registry of a commit holds it (`revision` is a commit id): null when the commit has no registry, or its registry has no such key. */
export function pinnedValueAt(checkout, revision, env, fs = nodeFs) {
  const scratch = openScratch({ checkout, env, fs });
  try {
    return pinnedValueIn(scratch.options, revision);
  } finally {
    scratch.dispose();
  }
}

/** A reader of the files of a revision: (relative path) => the text of the file, or null when the revision has none. */
const blobReader = (options, revision) => (relative) => {
  try {
    return git(["cat-file", "blob", `${revision}:${relative}`], options);
  } catch {
    return null;
  }
};

/** The files that rules 1 to 3 read. */
const LAB_FILES = [REGISTRY_FILE, AUDIT_REPORT_FILE, AUDIT_TEMPLATE_FILE, ...SELF_IMPROVEMENT_CANDIDATES];

/**
 * The lab files of a revision, read now: the scratch repository that holds the trees of a patch and the commits of a bundle is removed
 * before the files are checked, so a reader that went back to it later would find nothing and report every file missing.
 */
function labFilesOf(options, revision) {
  const read = blobReader(options, revision);
  const texts = new Map(LAB_FILES.map((relative) => [relative, read(relative)]));
  return (relative) => texts.get(relative) ?? null;
}

/**
 * Evidence that the checkout was set up to answer differently from what its objects say, or to run something while git reads it. Every git process of
 * this script runs in the scratch repository, which borrows the objects, takes copies of the refs and has no grafts, no replace-ref handling (--no-replace-objects)
 * and no configuration of the checkout's, so none of these can change an answer here; but the runner's checkout has none of them either, so each is
 * refused as the mark of an agent that made it: a replace ref (any ref under refs/replace/), a graft file (`info/grafts` of the common directory, or the file
 * that GIT_GRAFT_FILE names), and a configuration file of the checkout that names a program for git to run on the index or the files of the working tree
 * (core.fsmonitor, a clean, smudge or process filter, an external diff or a textconv: see readConfiguration in drift/lib/git-artifacts.mjs).
 */
function tamperProblems(scratch, refs, checkout, io) {
  const problems = [];
  const given = String(io.env.GIT_GRAFT_FILE ?? "").trim();
  const graftFile = given === "" ? path.join(scratch.directories.commonDir, "info", "grafts") : path.resolve(checkout, given);
  if (io.fs.existsSync(graftFile)) {
    problems.push(`the target checkout has a graft file (${graftFile}); the checks do not read it, but a checkout that the runner made has none`);
  }
  const replaced = replaceRefs(refs);
  if (replaced.length > 0) {
    const shown = `${replaced.slice(0, 3).join(", ")}${replaced.length > 3 ? ", ..." : ""}`;
    problems.push(`the target checkout has ${replaced.length === 1 ? "a replace ref" : `${replaced.length} replace refs`} (${shown}); the checks ignore ${replaced.length === 1 ? "it" : "them"}, but a checkout that the runner made has none`);
  }
  const { commandKeys, error } = scratch.configuration;
  for (const { scope, key } of commandKeys) {
    problems.push(`the configuration of the target checkout (${scope}) sets '${key}', a program that git would run while it reads the index or the working tree; nothing here runs it (no git process runs in that repository), but a checkout that the runner made sets none`);
  }
  if (error !== null) problems.push(`the configuration of the target checkout cannot be read: ${gitMessage(error)}`);
  return problems;
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The base commit of the checkout: --base-sha (an operator running the check by hand), else SDLC_BASE_SHA, which prepare-run appended to
 * GITHUB_ENV in the first step of the job. The run context under --out is deliberately not a source: the agent can edit every file there,
 * and an agent that had changed `gh_aw_schema_version` could point a file-based base at its own commit and pass the report-only rule.
 */
function baseCommitOf(flag, env) {
  const given = String(flag ?? "").trim();
  if (given !== "") return { sha: given, source: "--base-sha" };
  const exported = String(env[BASE_SHA_VARIABLE] ?? "").trim();
  return exported === "" ? null : { sha: exported, source: BASE_SHA_VARIABLE };
}

/** A run context whose baseSha differs from the commit that the runner handed over was edited after prepare-run wrote it. */
function runContextProblems(out, base, io) {
  const file = path.join(out, "run-context.json");
  if (!io.fs.existsSync(file)) return [];
  let recorded;
  try {
    recorded = JSON.parse(io.fs.readFileSync(file, "utf8")).baseSha;
  } catch {
    return [];
  }
  if (typeof recorded !== "string" || recorded === base.sha) return [];
  return [`${file} records the base commit ${recorded.slice(0, 12)}, but the first step of the job handed over ${base.sha.slice(0, 12)} (${base.source}); the run context was changed after prepare-run wrote it, and the commit that the runner handed over is the one used`];
}

/** Places for a message: "a", "a and b", "a, b and c". */
const joinPlaces = (places) => (places.length < 3 ? places.join(" and ") : `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`);

/** A commit for a message: the HEAD commit, or its abbreviated id and (up to three of) the refs that name it. */
function describeCommit(commit, headSha, refs) {
  if (commit === headSha) return "the HEAD commit";
  const names = refs.get(commit) ?? [];
  return `commit ${commit.slice(0, 12)}${names.length === 0 ? "" : ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})`}`;
}

/**
 * Rule 4 on everything that a pull request could be made of (see the header and drift/lib/git-artifacts.mjs): the HEAD commit, every other
 * commit that is not reachable from the base commit but is reachable from a ref, the index and the working tree, and each message of every
 * aw-*.patch file and each commit of every aw-*.bundle file in `artifactDirectory`. For each of them the changed paths and the value of the pinned
 * key are read from git objects; a path under .github/workflows/ that differs from the base commit, and a pinned value that differs from the
 * base commit's, are problems, and so is a file that cannot be read.
 * @returns {{ problems: string[], subjects: { place: string, read: (relative: string) => string | null }[], counts: { commits: number, patches: number, bundles: number } }}
 *   `subjects` are the tips, whose files rules 1 to 3 are applied to as well.
 */
function reportOnlyScan({ checkout, baseSha, headRegistry, io, artifactDirectory }) {
  const subjects = [];
  const counts = { commits: 0, patches: 0, bundles: 0 };
  const short = baseSha.slice(0, 12);
  // Every git process of this script runs in the scratch repository (see the header): it takes the objects, the refs, the index file and the files
  // of the working tree from the checkout as data, and nothing of the checkout's configuration.
  let scratch;
  try {
    scratch = openScratch({ checkout, env: io.env, fs: io.fs });
  } catch (error) {
    return { problems: [`the target checkout cannot be inspected: ${gitMessage(error)}`], subjects, counts };
  }
  try {
    const objects = scratch.options;
    // the refs come from one listing; the base commit and HEAD are checked in one call, and one at a time (for the message) only when that fails
    let refs = [];
    let refsProblem = null;
    try {
      refs = listRefs(objects);
    } catch (error) {
      refsProblem = `the refs of the target checkout cannot be listed: ${gitMessage(error)}`;
    }
    const problems = [...(refsProblem === null ? [] : [refsProblem]), ...tamperProblems(scratch, refs, checkout, io)];
    let headSha;
    try {
      [, headSha] = git(["rev-parse", `${baseSha}^{commit}`, "HEAD^{commit}"], objects).trim().split(/\r?\n/);
      if (!COMMIT.test(headSha ?? "")) throw new Error("git did not report the HEAD commit");
    } catch {
      try {
        git(["rev-parse", "--verify", `${baseSha}^{commit}`], objects);
      } catch (error) {
        return { problems: [...problems, `the base commit ${baseSha} is not in the target checkout: ${gitMessage(error)}`], subjects, counts };
      }
      try {
        git(["rev-parse", "--verify", "HEAD^{commit}"], objects);
      } catch (error) {
        return { problems: [...problems, `HEAD of the target checkout is not a commit: ${gitMessage(error)}`], subjects, counts };
      }
      return { problems: [...problems, `the base commit ${baseSha} and HEAD of the target checkout cannot be resolved together`], subjects, counts };
    }

    // The patch and bundle files come first and are copied away before anything else is read, so that what is inspected is what the directory
    // held when the validator looked, whatever happens to the directory (or to the checkout) while the rest is read.
    let files = [];
    try {
      files = snapshotTransportFiles(artifactDirectory, scratch, io.fs);
    } catch (error) {
      problems.push(`${artifactDirectory} cannot be read for the patch and bundle files of create_pull_request: ${gitMessage(error)}`);
    }

    const protectedPaths = new Map();
    const observed = [];
    const flag = (entry, place) => protectedPaths.set(entry, [...new Set([...(protectedPaths.get(entry) ?? []), place])]);
    // What a revision (a commit, or the tree that a patch produces) changes against the base commit is read from the objects alone, and so is
    // the pinned value that its registry holds, in the scratch repository, which reads the objects of the checkout and of the files.
    const examine = (revision, place) => {
      try {
        for (const entry of committedPaths(objects, baseSha, revision)) if (isProtectedPath(entry)) flag(entry, place);
      } catch (error) {
        problems.push(`what ${place} changes against the base commit ${short} cannot be listed: ${gitMessage(error)}`);
      }
      observed.push([place, pinnedValueIn(objects, revision)]);
    };

    examine(headSha, "the HEAD commit");
    try {
      const names = refsByCommit(refs);
      const ahead = commitsAhead(objects, baseSha);
      if (ahead.length > COMMIT_LIMIT) {
        problems.push(`${ahead.length} commits of the target checkout are not reachable from the base commit ${short}; more than ${COMMIT_LIMIT} are not read one by one, so they cannot be inspected`);
      } else {
        const branches = new Set(branchTips(refs).values());
        for (const commit of ahead) {
          counts.commits += 1;
          const place = describeCommit(commit, headSha, names);
          if (commit !== headSha) examine(commit, place);
          if (commit === headSha || branches.has(commit)) subjects.push({ place, read: labFilesOf(objects, commit) });
        }
      }
    } catch (error) {
      problems.push(`the commits of the target checkout that are not reachable from the base commit ${short} cannot be listed: ${gitMessage(error)}`);
    }
    try {
      for (const entry of indexPaths(scratch, baseSha, io.fs)) if (isProtectedPath(entry)) flag(entry, "the index");
    } catch (error) {
      problems.push(`the changes of the index against the base commit ${short} cannot be listed: ${gitMessage(error)}`);
    }
    try {
      for (const entry of workTreePaths(scratch, baseSha)) if (isProtectedPath(entry)) flag(entry, "the working tree");
    } catch (error) {
      problems.push(`the changes of the working tree against the base commit ${short} cannot be listed: ${gitMessage(error)}`);
    }
    // The pinned value is read where the pull request gets it, in the commits, and where the validator already looks at everything else, the
    // working tree. A registry that is missing from the working tree is reported by the caller, so only the commits are read then.
    if (headRegistry !== null) observed.push(["the working tree", pinnedValueOf(headRegistry)]);

    for (const entry of files) {
      try {
        if (entry.error !== undefined) throw entry.error;
        if (entry.kind === "patch") {
          counts.patches += 1;
          for (const { position, count, tree } of patchTrees(scratch, { file: entry.file, baseSha, fs: io.fs })) {
            const place = `${entry.name} (patch ${position} of ${count})`;
            examine(tree, place);
            if (position === count) subjects.push({ place, read: labFilesOf(objects, tree) });
          }
        } else {
          counts.bundles += 1;
          const { tips, commits } = bundleCommits(scratch, { file: entry.file, baseSha, fs: io.fs });
          if (commits.length > COMMIT_LIMIT) throw new Error(`it carries ${commits.length} commits beyond the base commit; more than ${COMMIT_LIMIT} are not read one by one`);
          for (const commit of commits) {
            const place = `${entry.name} (commit ${commit.slice(0, 12)})`;
            examine(commit, place);
            if (tips.includes(commit)) subjects.push({ place, read: labFilesOf(objects, commit) });
          }
        }
      } catch (error) {
        problems.push(`${entry.name} cannot be inspected: ${gitMessage(error)}`);
      }
    }

    for (const entry of [...protectedPaths.keys()].sort()) {
      problems.push(`${entry} differs from the base commit ${short}; nothing under .github/workflows/ may be edited, recompiled or deleted (in ${joinPlaces(protectedPaths.get(entry))})`);
    }
    const baseValue = pinnedValueIn(objects, baseSha);
    const changedTo = new Map();
    for (const [place, value] of observed) if (value !== baseValue) changedTo.set(value, [...new Set([...(changedTo.get(value) ?? []), place])]);
    const shown = (value) => (value === null ? "(absent)" : `'${value}'`);
    for (const [value, places] of changedTo) problems.push(`${PINNED_KEY} changed from ${shown(baseValue)} to ${shown(value)}; it is report-only (in ${joinPlaces(places)})`);
    return { problems, subjects, counts };
  } finally {
    scratch.dispose();
  }
}

/**
 * Rules 1 to 3 on the files of one place: the working tree, or the tip of something that a pull request could be made of. `read` returns
 * the text of a file of that place, or null; `outReport` is the self-improvement report under --out, which a self-improve run accepts too.
 * @returns {{ problems: string[], registry: string | null }}
 */
function labProblems({ read, selfImprove, outReport }) {
  const problems = [];
  const registry = read(REGISTRY_FILE);
  if (registry === null) problems.push(`${REGISTRY_FILE} is missing`);
  else {
    const present = new Set(scanTopLevelKeys(registry).map((entry) => entry.key));
    for (const key of REGISTRY_KEYS) if (!present.has(key)) problems.push(`${REGISTRY_FILE} is missing the top-level key '${key}'`);
  }
  if (selfImprove) {
    // A self-improve run produces the self-improvement report and nothing else of the lab's reports: the audit report is generated by the
    // weekly audit inside its own pull request, so the default branch holds only its template, and this run never writes it.
    const candidates = [...SELF_IMPROVEMENT_CANDIDATES.map((relative) => ({ label: relative, text: read(relative) })), { label: "self-improvement-report.md (in --out)", text: outReport }];
    const found = candidates.find((candidate) => candidate.text !== null);
    if (found === undefined) problems.push(`self-improvement-report.md is missing (looked for ${SELF_IMPROVEMENT_CANDIDATES.join(", ")})`);
    else problems.push(...sectionProblems(found.label, found.text, SELF_IMPROVEMENT_SECTIONS));
  } else {
    const template = read(AUDIT_TEMPLATE_FILE);
    if (template === null) problems.push(`${AUDIT_TEMPLATE_FILE} is missing; the audit report is generated from it`);
    const report = read(AUDIT_REPORT_FILE);
    if (report === null) problems.push(`${AUDIT_REPORT_FILE} is missing`);
    else problems.push(...sectionProblems(AUDIT_REPORT_FILE, report, AUDIT_SECTIONS, template === null ? [] : secondLevelHeadings(template)));
  }
  return { problems, registry };
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const selfImprove = flags["self-improve"] === true;
    const checkout = path.resolve(io.cwd, flags.checkout ?? ".");
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const problems = [];
    const read = (relative) => (io.fs.existsSync(path.join(checkout, relative)) ? io.fs.readFileSync(path.join(checkout, relative), "utf8") : null);
    const outReport = io.fs.existsSync(path.join(out, "self-improvement-report.md")) ? io.fs.readFileSync(path.join(out, "self-improvement-report.md"), "utf8") : null;

    const workingTree = labProblems({ read, selfImprove, outReport });
    problems.push(...workingTree.problems);

    let inspected = "";
    const base = baseCommitOf(flags["base-sha"], io.env);
    if (base === null) {
      problems.push(`the base commit is unknown: ${BASE_SHA_VARIABLE} is not set and --base-sha was not given, so the report-only rule cannot be checked (the run context under ${out} is not a source for it: the agent can edit that directory)`);
    } else if (!COMMIT.test(base.sha)) {
      problems.push(`the base commit '${base.sha.slice(0, 80)}' (${base.source}) is not a full commit id`);
    } else {
      // The patch and bundle files that create_pull_request wrote are in the directory that holds the artifact directory (/tmp/gh-aw for /tmp/gh-aw/agent).
      const scan = reportOnlyScan({ checkout, baseSha: base.sha, headRegistry: workingTree.registry, io, artifactDirectory: path.dirname(out) });
      problems.push(...scan.problems);
      for (const subject of scan.subjects) {
        problems.push(...labProblems({ read: subject.read, selfImprove, outReport }).problems.map((problem) => `${problem} (in ${subject.place})`));
      }
      if (base.source === BASE_SHA_VARIABLE) problems.push(...runContextProblems(out, base, io));
      const parts = [
        [scan.counts.commits, "commit"],
        [scan.counts.patches, "patch file"],
        [scan.counts.bundles, "bundle file"],
      ].filter(([count]) => count > 0);
      if (parts.length > 0) inspected = `; ${parts.map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`).join(", ")} of what a pull request could be made of also inspected`;
    }

    if (problems.length > 0) {
      for (const problem of problems) io.stderr(`validate-copilot-lab-audit: ${problem}\n`);
      return 1;
    }
    io.stdout(
      `validate-copilot-lab-audit: ok (${REGISTRY_KEYS.length} registry keys, the ${selfImprove ? "self-improvement" : "audit"} report complete, ${PINNED_KEY} and .github/workflows/ unchanged since ${base.sha.slice(0, 12)}${inspected})\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`validate-copilot-lab-audit: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
