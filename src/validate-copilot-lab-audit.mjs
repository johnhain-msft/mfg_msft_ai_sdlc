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
//  4. the checkout differs from the base commit neither in `gh_aw_schema_version` nor in any file under .github/workflows/ (the
//     version and the compiled workflows are report-only). The base commit is --base-sha, else SDLC_BASE_SHA, which prepare-run
//     appended to GITHUB_ENV in the first step of the job, so that the runner and not a file that the agent can edit supplies it.
// Anything else exits 1 and names each missing key or section, or the changed value or path, on stderr.
// The script only reads the checkout; it writes nothing.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseFlags, UsageError } from "./drift/lib/args.mjs";
import { BASE_SHA_VARIABLE, outDirectory, resolveIo, runAsMain } from "./drift/lib/cli.mjs";

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

function git(args, { cwd, env }) {
  return execFileSync("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

const gitMessage = (error) => String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0];

/** Every path that differs from the base commit: committed, staged, modified, deleted or untracked. */
export function changedPaths(checkout, baseSha, env) {
  const tracked = git(["diff", "--name-only", "-z", "--no-renames", baseSha], { cwd: checkout, env });
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: checkout, env });
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter((entry) => entry !== ""))].sort();
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

function reportOnlyProblems({ checkout, baseSha, headRegistry, io }) {
  const problems = [];
  try {
    git(["rev-parse", "--verify", `${baseSha}^{commit}`], { cwd: checkout, env: io.env });
  } catch (error) {
    return [`the base commit ${baseSha} is not in the target checkout: ${gitMessage(error)}`];
  }
  try {
    for (const entry of changedPaths(checkout, baseSha, io.env)) {
      const lower = entry.toLowerCase();
      if (lower === ".github/workflows" || lower.startsWith(PROTECTED_DIRECTORY)) {
        problems.push(`${entry} differs from the base commit ${baseSha.slice(0, 12)}; nothing under .github/workflows/ may be edited, recompiled or deleted`);
      }
    }
  } catch (error) {
    problems.push(`the changes against the base commit ${baseSha.slice(0, 12)} cannot be listed: ${gitMessage(error)}`);
  }
  if (headRegistry !== null) {
    let baseValue = null;
    try {
      const entry = scanTopLevelKeys(git(["show", `${baseSha}:${REGISTRY_FILE}`], { cwd: checkout, env: io.env })).find((candidate) => candidate.key === PINNED_KEY);
      baseValue = entry === undefined ? null : scalarOf(entry.rest);
    } catch {
      baseValue = null;
    }
    const headEntry = scanTopLevelKeys(headRegistry).find((candidate) => candidate.key === PINNED_KEY);
    const headValue = headEntry === undefined ? null : scalarOf(headEntry.rest);
    if (headValue !== baseValue && !(headEntry === undefined && baseValue === null)) {
      problems.push(`${PINNED_KEY} changed from ${baseValue === null ? "(absent)" : `'${baseValue}'`} to ${headValue === null ? "(absent)" : `'${headValue}'`}; it is report-only`);
    }
  }
  return problems;
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

    const registry = read(REGISTRY_FILE);
    if (registry === null) problems.push(`${REGISTRY_FILE} is missing`);
    else {
      const present = new Set(scanTopLevelKeys(registry).map((entry) => entry.key));
      for (const key of REGISTRY_KEYS) if (!present.has(key)) problems.push(`${REGISTRY_FILE} is missing the top-level key '${key}'`);
    }

    if (selfImprove) {
      // A self-improve run produces the self-improvement report and nothing else of the lab's reports: the audit report is generated by the
      // weekly audit inside its own pull request, so the default branch holds only its template, and this run never writes it.
      const candidates = [...SELF_IMPROVEMENT_CANDIDATES.map((relative) => ({ label: relative, text: read(relative) })), { label: "self-improvement-report.md (in --out)", text: io.fs.existsSync(path.join(out, "self-improvement-report.md")) ? io.fs.readFileSync(path.join(out, "self-improvement-report.md"), "utf8") : null }];
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

    const base = baseCommitOf(flags["base-sha"], io.env);
    if (base === null) {
      problems.push(`the base commit is unknown: ${BASE_SHA_VARIABLE} is not set and --base-sha was not given, so the report-only rule cannot be checked (the run context under ${out} is not a source for it: the agent can edit that directory)`);
    } else if (!COMMIT.test(base.sha)) {
      problems.push(`the base commit '${base.sha.slice(0, 80)}' (${base.source}) is not a full commit id`);
    } else {
      problems.push(...reportOnlyProblems({ checkout, baseSha: base.sha, headRegistry: registry, io }));
      if (base.source === BASE_SHA_VARIABLE) problems.push(...runContextProblems(out, base, io));
    }

    if (problems.length > 0) {
      for (const problem of problems) io.stderr(`validate-copilot-lab-audit: ${problem}\n`);
      return 1;
    }
    io.stdout(
      `validate-copilot-lab-audit: ok (${REGISTRY_KEYS.length} registry keys, the ${selfImprove ? "self-improvement" : "audit"} report complete, ${PINNED_KEY} and .github/workflows/ unchanged since ${base.sha.slice(0, 12)})\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`validate-copilot-lab-audit: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
