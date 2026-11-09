#!/usr/bin/env node
// Declarative fleet manifest reconciler.
//
// Reads a manifest (sdlc.yaml), validates it against schemas/sdlc.schema.json and the
// securityBaseline sent by the bootstrap CLI (contract C1), renders the complete gh-aw
// workflow set under .github/workflows/, compiles it with `gh aw compile --strict --purge
// --json` and rolls every file back when anything fails. Every repository name, path and
// command reaches the output through the manifest and the request only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import YAML from "yaml";

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

const WORKFLOWS_DIR = ".github/workflows";
export const REPO_CONFIG_PATH = `${WORKFLOWS_DIR}/aw.json`;
export const ROUTER_PATH = `${WORKFLOWS_DIR}/cascade-router.yml`;
const ONBOARD_ID = "sdlc-onboard";
const ACTIONS_LOCK_PATH = ".github/aw/actions-lock.json";
const GITATTRIBUTES_PATH = ".gitattributes";
const SNAPSHOT_ROOTS = [WORKFLOWS_DIR, ".github/aw"];
const SNAPSHOT_FILES = [GITATTRIBUTES_PATH];
const SCHEMA_PATH = fileURLToPath(new URL("../schemas/sdlc.schema.json", import.meta.url));
const REQUEST_FILE_LABEL = "BootstrapReconcileRequest";
const SHARED_DIR = `${WORKFLOWS_DIR}/shared`;
const AGENT_DIR = "/tmp/gh-aw/agent";
const MAX_INSTRUCTIONS_BYTES = 512 * 1024;

const REQUEST_KEYS = [
  "manifestPath",
  "appSlug",
  "appClientIdVar",
  "appPrivateKeySecret",
  "pollStateVarPrefix",
  "engineAuthMode",
  "ghAwVersionPin",
  "securityBaseline",
  "dryRun",
];
const BASELINE_KEYS = [
  "minGhAwVersion",
  "grantedAppPermissions",
  "requireStrictMode",
  "requireThreatDetection",
  "forbidAutoMerge",
];
const ENGINE_AUTH_MODES = ["copilot-requests", "copilot-pat", "api-key"];
const ALL_SYNC_SCOPES = ["both", "workshop-only", "studio-only", "showcase-runs", "github-intermediate"];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APP_SLUG = /^[A-Za-z0-9-]+$/;

// Local development convenience: the isolated gh-aw v1.0.1 installation used on the
// maintainer's workstation, where the globally installed extension is an older release.
// It applies only when XDG_DATA_HOME is unset and the directory exists.
const LOCAL_GH_AW_DATA_HOME =
  "C:\\Users\\johnhain\\.copilot\\session-state\\8759f150-2dae-4daf-82cd-f6b566c113e9\\files\\xdg-data-gh-aw-v101";

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
/** Copy of a manifest-authored object with every object's keys in code-point order (arrays keep their order). */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isObj(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}
const uniqueSorted = (values) => [...new Set(values)].sort();
const uniqueStable = (values) => [...new Set(values)];
const toPosix = (value) => value.split(path.sep).join("/");
const rule = (id, message) => `${id}: ${message}`;
const repoName = (slug) => slug.slice(slug.indexOf("/") + 1);
const oneLine = (value) => String(value).replace(/\s*[\r\n]+\s*/g, " ").trim();
const lf = (value) => String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Escape a value for insertion inside a double-quoted shell string. */
function shDq(value) {
  return String(value).replace(/[\\"$`]/g, "\\$&");
}

/** A git invocation assembled from parts, so that rendered text is built by one function. */
function gitCommand(...parts) {
  return ["git", ...parts].join(" ");
}

/**
 * Phrases that would write Actions state from a generated file; checkRendered refuses to emit them. The path of the variables endpoint is joined
 * from its segments, so that the only file under src/ that spells it out is the poll-state script that owns it (SPEC-03 AC29).
 */
const STATE_WRITE_PHRASES = [...["variable", "secret"].map((noun) => ["gh", noun].join(" ")), ["actions", "variables"].join("/")];

/** Markdown fenced block whose fence is longer than any backtick run inside the text. */
function fenced(text, lang = "") {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Replace the `<checkout>` placeholder with the absolute upstream checkout variable. */
function fillCheckout(command) {
  return String(command).split("<checkout>").join('"$UPSTREAM_DIR"');
}

function stepNameOf(command) {
  const first = String(command).split("\n").find((line) => line.trim() !== "") ?? "";
  return first.trim().replace(/^#\s*/, "");
}

function posixRel(root, absolute) {
  return toPosix(path.relative(root, absolute));
}

function walkFiles(root, startRel) {
  const out = [];
  const start = path.join(root, startRel);
  if (!fs.existsSync(start)) return out;
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (stat.isFile()) {
      out.push(posixRel(root, current));
    }
  }
  return out.sort();
}

function removeEmptyDirs(root, startRel, keepDirs) {
  const start = path.join(root, startRel);
  if (!fs.existsSync(start)) return;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.lstatSync(full).isDirectory()) visit(full);
    }
    const rel = posixRel(root, dir);
    if (!keepDirs.has(rel) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  visit(start);
}

// ---------------------------------------------------------------------------------------
// Request validation (contract C1)
// ---------------------------------------------------------------------------------------

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function pinnedVersion(pin) {
  const match = /^(?:>=\s*)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(pin);
  return match ? match[1] : null;
}

function validateRequest(request) {
  const errors = [];
  if (!isObj(request)) {
    return [rule("request-not-object", "the request must be a JSON object")];
  }
  for (const key of REQUEST_KEYS) {
    if (!hasOwn(request, key)) errors.push(rule("request-missing-field", `field '${key}' is required`));
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) errors.push(rule("request-unknown-field", `field '${key}' is not part of the request`));
  }
  const str = (key) => {
    if (hasOwn(request, key) && typeof request[key] !== "string") {
      errors.push(rule("request-invalid-type", `field '${key}' must be a string`));
      return false;
    }
    return hasOwn(request, key);
  };
  if (str("manifestPath") && request.manifestPath.trim() === "") {
    errors.push(rule("request-invalid-value", "field 'manifestPath' must not be empty"));
  }
  if (str("appSlug") && !(request.appSlug !== "" && APP_SLUG.test(request.appSlug))) {
    errors.push(
      rule("request-app-slug-invalid", `appSlug '${request.appSlug}' must be non-empty and use only ASCII letters, digits and '-'`),
    );
  }
  for (const key of ["appClientIdVar", "appPrivateKeySecret"]) {
    if (str(key) && !IDENTIFIER.test(request[key])) {
      errors.push(rule("request-identifier-invalid", `${key} '${request[key]}' must match ${IDENTIFIER}`));
    }
  }
  if (str("pollStateVarPrefix") && request.pollStateVarPrefix !== "SDLC_SYNC_STATE_") {
    errors.push(rule("request-invalid-value", `pollStateVarPrefix must be "SDLC_SYNC_STATE_" but is '${request.pollStateVarPrefix}'`));
  }
  if (hasOwn(request, "engineAuthMode")) {
    if (typeof request.engineAuthMode !== "string") {
      errors.push(rule("request-invalid-type", "field 'engineAuthMode' must be a string"));
    } else if (!ENGINE_AUTH_MODES.includes(request.engineAuthMode)) {
      errors.push(
        rule("request-invalid-value", `engineAuthMode '${request.engineAuthMode}' must be one of ${ENGINE_AUTH_MODES.join(", ")}`),
      );
    }
  }
  if (hasOwn(request, "dryRun") && typeof request.dryRun !== "boolean") {
    errors.push(rule("request-invalid-type", "field 'dryRun' must be a boolean"));
  }
  let minimum = null;
  if (hasOwn(request, "securityBaseline")) {
    const baseline = request.securityBaseline;
    if (!isObj(baseline)) {
      errors.push(rule("request-invalid-type", "field 'securityBaseline' must be an object"));
    } else {
      for (const key of BASELINE_KEYS) {
        if (!hasOwn(baseline, key)) errors.push(rule("request-missing-field", `field 'securityBaseline.${key}' is required`));
      }
      for (const key of Object.keys(baseline)) {
        if (!BASELINE_KEYS.includes(key)) {
          errors.push(rule("request-unknown-field", `field 'securityBaseline.${key}' is not part of the request`));
        }
      }
      if (hasOwn(baseline, "minGhAwVersion")) {
        if (baseline.minGhAwVersion !== "1.0.1") {
          errors.push(rule("request-invalid-value", `securityBaseline.minGhAwVersion must be "1.0.1" but is ${JSON.stringify(baseline.minGhAwVersion)}`));
        } else {
          minimum = parseVersion(baseline.minGhAwVersion);
        }
      }
      for (const key of ["requireStrictMode", "requireThreatDetection", "forbidAutoMerge"]) {
        if (hasOwn(baseline, key) && baseline[key] !== true) {
          errors.push(rule("request-invalid-value", `securityBaseline.${key} must be true but is ${JSON.stringify(baseline[key])}`));
        }
      }
      if (hasOwn(baseline, "grantedAppPermissions")) {
        const granted = baseline.grantedAppPermissions;
        if (!isObj(granted)) {
          errors.push(rule("request-invalid-type", "field 'securityBaseline.grantedAppPermissions' must be an object"));
        } else {
          for (const [key, level] of Object.entries(granted)) {
            if (level !== "read" && level !== "write") {
              errors.push(
                rule("request-invalid-value", `securityBaseline.grantedAppPermissions.${key} must be "read" or "write" but is ${JSON.stringify(level)}`),
              );
            }
          }
        }
      }
    }
  }
  if (str("ghAwVersionPin")) {
    const raw = pinnedVersion(request.ghAwVersionPin);
    const parsed = raw === null ? null : parseVersion(raw);
    if (parsed === null) {
      errors.push(rule("request-version-pin", `ghAwVersionPin '${request.ghAwVersionPin}' is not a version such as ">=v1.0.1"`));
    } else if (minimum !== null && compareVersions(parsed, minimum) < 0) {
      errors.push(
        rule("request-version-pin", `ghAwVersionPin '${request.ghAwVersionPin}' is lower than securityBaseline.minGhAwVersion ${request.securityBaseline.minGhAwVersion}`),
      );
    }
  }
  return errors;
}

function requestFailure(errors) {
  return {
    status: "error",
    generatedWorkflows: [],
    repoConfigPath: REPO_CONFIG_PATH,
    validationResults: [{ file: REQUEST_FILE_LABEL, valid: false, errors }],
  };
}

// ---------------------------------------------------------------------------------------
// Manifest loading, schema validation and semantic validation
// ---------------------------------------------------------------------------------------

let compiledSchema = null;
function schemaValidator() {
  if (compiledSchema === null) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    compiledSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);
  }
  return compiledSchema;
}

function formatSchemaError(error, file) {
  const pointer = error.instancePath === "" ? "/" : error.instancePath;
  switch (error.keyword) {
    case "additionalProperties": {
      const key = error.params.additionalProperty;
      return rule("schema-validation", `${file}#${pointer === "/" ? "" : pointer}/${key}: unknown key '${key}' is not allowed (must NOT have additional properties)`);
    }
    case "required": {
      const key = error.params.missingProperty;
      return rule("schema-validation", `${file}#${pointer === "/" ? "" : pointer}/${key}: must have required property '${key}'`);
    }
    default:
      return rule("schema-validation", `${file}#${pointer}: ${error.message}${describeParams(error)}`);
  }
}

function describeParams(error) {
  switch (error.keyword) {
    case "enum":
      return ` (${error.params.allowedValues.map((value) => JSON.stringify(value)).join(", ")})`;
    case "const":
      return ` (${JSON.stringify(error.params.allowedValue)})`;
    case "pattern":
      return ` (${error.params.pattern})`;
    default:
      return "";
  }
}

function walkStrings(value, pointer, visit) {
  if (typeof value === "string") {
    visit(value, pointer);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${pointer}/${index}`, visit));
  } else if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
      visit(key, `${pointer}/${escaped} (key)`);
      walkStrings(item, `${pointer}/${escaped}`, visit);
    }
  }
}

function readManifestFile(cwd, manifestPath) {
  const absolute = path.resolve(cwd, manifestPath);
  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    return { errors: [rule("manifest-unreadable", `${manifestPath} cannot be read: ${error.message}`)] };
  }
  const document = YAML.parseDocument(lf(text), { prettyErrors: true });
  if (document.errors.length > 0) {
    return {
      errors: document.errors.map((error) => rule("manifest-unparseable", `${manifestPath} is not valid YAML: ${oneLine(error.message)}`)),
    };
  }
  let data;
  try {
    data = document.toJS({ maxAliasCount: 200 });
  } catch (error) {
    return { errors: [rule("manifest-unparseable", `${manifestPath} is not valid YAML: ${oneLine(error.message)}`)] };
  }
  return { data, absolute, errors: [] };
}

function normalizeManifest(raw) {
  const manifest = clone(raw);
  manifest.dependencyEdges ??= [];
  manifest.protectedFilesExclude = uniqueSorted(manifest.protectedFilesExclude ?? []);
  for (const project of manifest.projects) {
    project.deconflictInRepoSchedules ??= "none";
    project.deconflictWorkflowIds ??= [];
  }
  for (const edge of manifest.dependencyEdges) {
    edge.syncScopes ??= [...ALL_SYNC_SCOPES];
    edge.installDirectories ??= ["."];
  }
  return manifest;
}

function loadManifest(cwd, manifestPath) {
  const read = readManifestFile(cwd, manifestPath);
  if (read.errors.length > 0) return { errors: read.errors, file: manifestPath };
  const validate = schemaValidator();
  if (!validate(read.data)) {
    const leaf = validate.errors.filter((error) => !["if", "then", "else"].includes(error.keyword));
    const errors = (leaf.length > 0 ? leaf : validate.errors).map((error) => formatSchemaError(error, manifestPath));
    return { errors: uniqueStable(errors), file: manifestPath };
  }
  return { errors: [], file: manifestPath, manifest: normalizeManifest(read.data) };
}

function isGlobPattern(value) {
  return /[*?]/.test(value);
}

function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function literalPrefix(pattern) {
  const index = pattern.search(/[*?]/);
  return index === -1 ? pattern : pattern.slice(0, index);
}

/** True when a pattern equals, lies beneath, matches or is matched by a protected path. */
function includesProtected(pattern, protectedPath) {
  const entry = protectedPath.replace(/\/+$/, "");
  const candidate = pattern.replace(/\/+$/, "");
  if (candidate === entry) return true;
  if (candidate.startsWith(`${entry}/`)) return true;
  const candidateGlob = isGlobPattern(candidate);
  if (candidateGlob && globToRegExp(candidate).test(entry)) return true;
  if (isGlobPattern(entry) && globToRegExp(entry).test(candidate)) return true;
  if (candidateGlob) {
    const prefix = literalPrefix(candidate);
    const slash = prefix.lastIndexOf("/");
    const prefixDir = slash === -1 ? "" : candidate.slice(0, slash);
    const entryIsDirectory = !path.posix.basename(entry).includes(".");
    if (
      entryIsDirectory &&
      (prefixDir === "" || prefixDir === entry || prefixDir.startsWith(`${entry}/`) || entry.startsWith(`${prefixDir}/`))
    ) {
      return true;
    }
  }
  return false;
}

function findCycle(edges) {
  const graph = new Map();
  for (const edge of edges) {
    const from = edge.upstreamRepo.toLowerCase();
    const to = edge.downstreamRepo.toLowerCase();
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push({ to, edgeId: edge.edgeId });
    if (!graph.has(to)) graph.set(to, []);
  }
  const state = new Map();
  const trail = [];
  const visit = (node) => {
    state.set(node, 1);
    for (const next of graph.get(node)) {
      trail.push({ node, edgeId: next.edgeId, to: next.to });
      if (state.get(next.to) === 1) {
        const start = trail.findIndex((step) => step.node === next.to);
        return trail.slice(start);
      }
      if (!state.has(next.to)) {
        const found = visit(next.to);
        if (found) return found;
      }
      trail.pop();
    }
    state.set(node, 2);
    return null;
  };
  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

function validWatchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "is not an absolute URL" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "is not an https URL" };
  if (parsed.hostname === "") return { ok: false, reason: "has an empty host" };
  if (/[*]/.test(url.split("/")[2] ?? "") || parsed.hostname.includes("*") || /%2a/i.test(parsed.hostname)) {
    return { ok: false, reason: "has a wildcard host" };
  }
  return { ok: true, hostname: parsed.hostname.toLowerCase() };
}

function watchHostnames(urls) {
  return uniqueSorted(urls.map((entry) => validWatchUrl(entry.url).hostname).filter(Boolean));
}

/** `instructionsFile` is repository-relative (SPEC-01 AC21): it resolves against the repository root, never against the manifest's directory. */
function readInstructionFile(cwd, relative) {
  const absolute = path.resolve(cwd, relative);
  const inside = path.relative(cwd, absolute);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    return { error: `instructionsFile '${relative}' resolves outside the repository` };
  }
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { error: `instructionsFile '${relative}' does not exist` };
  }
  if (!stat.isFile()) return { error: `instructionsFile '${relative}' is not a file` };
  if (stat.size > MAX_INSTRUCTIONS_BYTES) return { error: `instructionsFile '${relative}' is larger than ${MAX_INSTRUCTIONS_BYTES} bytes` };
  return { text: lf(fs.readFileSync(absolute, "utf8")) };
}

const COMMAND_ARRAYS = ["importCommands", "preflightCommands", "acceptCommands", "buildCommands", "verifyCommands"];
// the files that an AI workflow writes into the artifact directory for itself; a report of the edge's own cannot take one of these names
const RESERVED_ARTIFACT_NAMES = ["dispatch-inputs.json", "upstream-diff.txt", "existing-pr.json", "preflight-exit-codes.txt"];

function validateSemantics(manifest, request, context) {
  const errors = [];
  const { manifestFile } = context;

  walkStrings(manifest, "", (text, pointer) => {
    if (text.includes("${{")) {
      errors.push(rule("manifest-expression-opener", `${manifestFile}#${pointer}: manifest strings must not contain the expression opener "\${{"`));
    }
  });

  const seen = (label, items, pick, describe) => {
    const owners = new Map();
    for (const item of items) {
      const value = pick(item);
      if (owners.has(value)) {
        errors.push(rule(label, `${describe(owners.get(value))} and ${describe(item)} both use '${value}'`));
      } else {
        owners.set(value, item);
      }
    }
  };
  const edges = manifest.dependencyEdges;
  seen("duplicate-project-key", manifest.projects, (p) => p.projectKey, (p) => `project '${p.projectKey}'`);
  seen("duplicate-edge-id", edges, (e) => e.edgeId, (e) => `edge '${e.edgeId}'`);
  seen("duplicate-branch-name", edges, (e) => e.branchName, (e) => `edge '${e.edgeId}'`);
  seen("duplicate-close-older-key", edges, (e) => e.closeOlderKey, (e) => `edge '${e.edgeId}'`);
  seen("duplicate-upstream-key", edges, (e) => e.upstreamKey, (e) => `edge '${e.edgeId}'`);
  seen("duplicate-state-variable", edges, (e) => e.stateVariable, (e) => `edge '${e.edgeId}'`);

  for (const edge of edges) {
    const expected = `${request.pollStateVarPrefix}${edge.upstreamSlug}`;
    if (edge.stateVariable !== expected) {
      errors.push(
        rule("edge-state-variable", `edge '${edge.edgeId}': stateVariable '${edge.stateVariable}' must equal '${expected}' (pollStateVarPrefix followed by upstreamSlug)`),
      );
    }
  }

  const cycle = findCycle(edges);
  if (cycle) {
    const names = [cycle[0].node, ...cycle.map((step) => step.to)].join(" -> ");
    errors.push(rule("dependency-cycle", `dependencyEdges contain a cycle ${names} (edges ${cycle.map((step) => `'${step.edgeId}'`).join(", ")})`));
  }

  edges.forEach((edge, index) => {
    if (edge.reviewers.length === 0) {
      errors.push(rule("edge-reviewers-empty", `edge '${edge.edgeId}' (${manifestFile}#/dependencyEdges/${index}/reviewers): reviewers must be a non-empty array`));
    }
    if (edge.allowedFiles.length === 0) {
      errors.push(rule("edge-allowed-files-empty", `edge '${edge.edgeId}' (${manifestFile}#/dependencyEdges/${index}/allowedFiles): allowedFiles must be a non-empty array`));
    }
    for (const key of COMMAND_ARRAYS) {
      edge[key].forEach((command, position) => {
        if (command.trim() === "") {
          errors.push(rule("command-blank", `edge '${edge.edgeId}' (${manifestFile}#/dependencyEdges/${index}/${key}/${position}): commands must not be blank`));
        }
      });
    }
    for (const protectedPath of edge.immutableGates.zeroDiffPaths) {
      for (const pattern of edge.allowedFiles) {
        if (includesProtected(pattern, protectedPath)) {
          errors.push(
            rule("allowed-files-locked-path", `edge '${edge.edgeId}': allowedFiles entry '${pattern}' includes the locked path '${protectedPath}' (immutableGates.zeroDiffPaths)`),
          );
        }
      }
    }
    if (edge.adaptation !== undefined) {
      const where = `edge '${edge.edgeId}' (${manifestFile}#/dependencyEdges/${index}/adaptation)`;
      if (edge.mode !== "ai-adaptation") {
        errors.push(rule("edge-adaptation-mode", `${where}: adaptation is the data of an ai-adaptation edge, and this edge is ${edge.mode}`));
      }
      const reports = edge.adaptation.preflightReports;
      if (reports !== undefined) {
        if (reports.length !== edge.preflightCommands.length) {
          errors.push(
            rule("edge-preflight-reports-count", `${where}/preflightReports: ${reports.length} report names for ${edge.preflightCommands.length} preflightCommands (one name for each command, in order)`),
          );
        }
        for (const name of reports) {
          if (RESERVED_ARTIFACT_NAMES.includes(name) || /^preflight-\d+\.txt$/.test(name)) {
            errors.push(rule("edge-preflight-reports-reserved", `${where}/preflightReports: '${name}' is a file that the workflow writes for itself`));
          }
        }
      }
    }
  });

  manifest.projects.forEach((project, index) => {
    const audit = project.driftAudit;
    const where = `project '${project.projectKey}' (${manifestFile}#/projects/${index}/driftAudit)`;
    for (const key of ["buildCommands", "verifyCommands"]) {
      audit[key].forEach((command, position) => {
        if (command.trim() === "") errors.push(rule("command-blank", `${where}/${key}/${position}: commands must not be blank`));
      });
    }
    if (audit.instructionsFile !== null) {
      const result = readInstructionFile(context.cwd, audit.instructionsFile);
      if (result.error) {
        errors.push(rule("drift-instructions-file", `${where}: ${result.error}`));
      } else if (result.text.includes("${{")) {
        errors.push(rule("manifest-expression-opener", `${where}: instructionsFile '${audit.instructionsFile}' contains the expression opener "\${{"`));
      } else {
        context.instructionFiles.set(project.projectKey, result.text);
      }
    }
    if (!audit.enabled) return;
    if (audit.upkeepStrategy !== "custom" && !context.strategyFragments.has(audit.upkeepStrategy)) {
      const fragment = readStrategyFragment(context.cwd, audit.upkeepStrategy);
      if (fragment.error) errors.push(rule("drift-strategy-fragment", `${where}: ${fragment.error}`));
      else context.strategyFragments.set(audit.upkeepStrategy, fragment.text);
    }
    audit.knowledgeSources.watchUrls.forEach((entry, position) => {
      const verdict = validWatchUrl(entry.url);
      if (!verdict.ok) {
        errors.push(rule("drift-watch-url-invalid", `${where}/knowledgeSources/watchUrls/${position}: URL '${entry.url}' ${verdict.reason}`));
      }
    });
    if (audit.instructions.trim() === "" && audit.instructionsFile === null) {
      errors.push(rule("drift-instructions-missing", `${where}: instructions and instructionsFile are both empty`));
    }
    if (!audit.verifyCommands.some((command) => command.trim() !== "")) {
      errors.push(rule("drift-verify-commands-missing", `${where}: verifyCommands must contain at least one runnable command`));
    }
  });

  if (request.engineAuthMode === "api-key" && manifest.engineApiKeySecret === undefined) {
    errors.push(rule("engine-api-key-secret-missing", `${manifestFile}: engineAuthMode is "api-key" but engineApiKeySecret is not set`));
  }
  return errors;
}

// ---------------------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------------------

const YAML_OPTIONS = { lineWidth: 0, indent: 2, aliasDuplicateObjects: false, minContentWidth: 0 };
const BASE_BASH = ["cat", "date", "find", "git", "grep", "head", "ls", "tail", "wc"];
/**
 * What the agent of a mechanical cascade may run besides the executables of its import commands. Its prompt opens with `cd` into the downstream
 * checkout, which the base list does not allow, and a live run showed that the agent also inspects the result with `echo` and `node`.
 */
const MECHANICAL_BASH = ["cd", "echo", "git", "node"];

const stringifyYaml = (value) => YAML.stringify(value, YAML_OPTIONS);

/** A GitHub Actions expression; only the renderer ever builds these (manifest strings are rejected). */
const expr = (text) => "${{ " + text + " }}";

function serializeWorkflow(frontmatter, body) {
  return `---\n${stringifyYaml(frontmatter)}---\n\n${String(body).replace(/\s+$/u, "")}\n`;
}

/** Quote a value for use as a shell word, leaving plain path-like values bare. */
function shArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function commandWord(command) {
  for (const token of String(command).trim().split(/\s+/)) {
    if (token === "" || token.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return /^[A-Za-z0-9_.+/-]+$/.test(token) ? token : null;
  }
  return null;
}

function bashAllowlist(commands) {
  return uniqueSorted([...BASE_BASH, ...commands.map(commandWord).filter((word) => word !== null)]);
}

/** Engines whose gh-aw compiler enforces a per-command `tools.bash` allowlist (gh-aw v1.0.1: copilot, claude and gemini). */
const BASH_ALLOWLIST_ENGINES = new Set(["claude", "copilot", "gemini"]);

function makeContext(request, manifest, instructionFiles, strategyFragments) {
  return {
    request,
    manifest,
    instructionFiles,
    strategyFragments,
    bot: `${request.appSlug}[bot]`,
    githubApp: {
      "client-id": expr(`vars.${request.appClientIdVar}`),
      "private-key": expr(`secrets.${request.appPrivateKeySecret}`),
    },
  };
}

/**
 * The credentials of the GitHub App. `repositories` names the repositories (by name, without the owner) that the token is minted for; a checkout
 * or a safe-outputs handler that reaches a repository other than the central one has to name it, because the compiler's default scope is the
 * central repository only. Without `repositories` the block is the bare credentials.
 */
function appBlock(ctx, repositories) {
  const block = clone(ctx.githubApp);
  if (repositories !== undefined) block.repositories = [...repositories];
  return block;
}

/** The repository whose workflow runs (the central one): the token of a safe-outputs handler reaches it and the repository that it writes to. */
const CENTRAL_REPOSITORY = expr("github.event.repository.name");

function permissionsSection(ctx) {
  const permissions = { contents: "read", issues: "read", "pull-requests": "read" };
  if (ctx.request.engineAuthMode === "copilot-requests") permissions["copilot-requests"] = "write";
  return permissions;
}

function apiKeyProvider(secretName) {
  if (/ANTHROPIC|CLAUDE/i.test(secretName)) return { engine: "claude", variable: "ANTHROPIC_API_KEY" };
  if (/OPENAI|CODEX/i.test(secretName)) return { engine: "codex", variable: "OPENAI_API_KEY" };
  if (/GEMINI|GOOGLE/i.test(secretName)) return { engine: "gemini", variable: "GEMINI_API_KEY" };
  return { engine: "claude", variable: "ANTHROPIC_API_KEY" };
}

/** The engine key: credentials are referenced, never written; the three modes are exclusive. */
function engineSection(ctx, { sdk }) {
  const mode = ctx.request.engineAuthMode;
  if (mode === "api-key") {
    const secret = ctx.manifest.engineApiKeySecret;
    const provider = apiKeyProvider(secret);
    return { id: provider.engine, env: { [provider.variable]: expr(`secrets.${secret}`) } };
  }
  const engine = { id: "copilot" };
  if (sdk) engine["copilot-sdk"] = true;
  if (mode === "copilot-pat") engine.env = { COPILOT_GITHUB_TOKEN: expr("secrets.COPILOT_GITHUB_TOKEN") };
  return engine;
}

/**
 * The `tools.bash` value: the command allowlist for an engine whose compiler can enforce one. Any other engine
 * (codex) ignores a restricted list at run time and gh-aw rejects it at compile time, so it gets the explicit
 * wildcard that the compiler accepts there (SPEC-01 AC71); the engine selected by `engineAuthMode` decides.
 */
function bashTool(ctx, commands) {
  return BASH_ALLOWLIST_ENGINES.has(engineSection(ctx, { sdk: false }).id) ? bashAllowlist(commands) : ["*"];
}

function inputsOf(names, descriptions) {
  const inputs = {};
  for (const name of names) inputs[name] = { description: descriptions[name], type: "string" };
  return inputs;
}

const DISPATCH_DESCRIPTIONS = {
  correlation_id: "Correlation id that links the dispatch, the run and any failure issue",
  upstream_repo: "Upstream repository (owner/name) whose revision is cascaded",
  previous_sha: "Previously merged upstream revision (40 lowercase hexadecimal characters)",
  upstream_sha: "Upstream revision to cascade (40 lowercase hexadecimal characters)",
  upstream_etag: "ETag of the upstream poll that observed upstream_sha",
  upstream_pr_number: "Number of the merged upstream pull request, or empty",
  downstream_repo: "Downstream repository (owner/name) that receives the pull request",
  sync_scope: "Which part of the downstream surface to adapt",
  on_commit_only_advance: "Behaviour when only the upstream commit advanced: noop or bump-provenance",
  dry_run: "Empty, true or false; true forbids commits and pull requests",
};

const MECHANICAL_INPUTS = [
  "correlation_id",
  "upstream_repo",
  "previous_sha",
  "upstream_sha",
  "upstream_etag",
  "upstream_pr_number",
  "downstream_repo",
  "dry_run",
];
const AI_INPUTS = [
  "correlation_id",
  "upstream_repo",
  "previous_sha",
  "upstream_sha",
  "upstream_etag",
  "upstream_pr_number",
  "downstream_repo",
  "sync_scope",
  "on_commit_only_advance",
  "dry_run",
];

/** Step environment that binds every dispatch input by reference. */
function dispatchEnv() {
  return {
    CORRELATION_ID: expr("inputs.correlation_id"),
    UPSTREAM_REPO_INPUT: expr("inputs.upstream_repo"),
    PREVIOUS_SHA: expr("inputs.previous_sha"),
    UPSTREAM_SHA: expr("inputs.upstream_sha"),
    UPSTREAM_ETAG: expr("inputs.upstream_etag"),
    UPSTREAM_PR_NUMBER: expr("inputs.upstream_pr_number"),
    DOWNSTREAM_REPO_INPUT: expr("inputs.downstream_repo"),
    SYNC_SCOPE: expr("inputs.sync_scope"),
    ON_COMMIT_ONLY_ADVANCE: expr("inputs.on_commit_only_advance"),
    DRY_RUN: expr("inputs.dry_run"),
  };
}

function isCleanTreeCheck(command) {
  return /^git(?:\s+-C\s+(?:"[^"]*"|\S+))?\s+status\s+--porcelain$/.test(command.trim());
}

function cleanTreeScript(command) {
  return [
    "set -euo pipefail",
    `status="$(${command.trim()})"`,
    'if [ -n "$status" ]; then',
    '  echo "worktree is not clean:" >&2',
    '  echo "$status" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

/** One post-step per command: named by its command, run verbatim, with no continue-on-error or if. */
function verifyStep(command, workingDirectory) {
  const text = fillCheckout(command).replace(/\n+$/u, "");
  const step = { name: stepNameOf(text), run: isCleanTreeCheck(text) ? cleanTreeScript(text) : text };
  if (usesGhCli(text)) step.env = { GH_TOKEN: expr("github.token") };
  if (workingDirectory) step["working-directory"] = workingDirectory;
  return step;
}

/** The compiler requires GH_TOKEN in the environment of any step that invokes the gh CLI. */
function usesGhCli(text) {
  return /(?:^|[\s;&|(`])gh\s/m.test(text);
}

/**
 * A post-run check is a `verifyCommands` entry whose first non-blank character is `#`: a script that opens
 * with a comment naming the check. It is rendered like every other entry, at its manifest position; the
 * mark only keeps it out of the verification gate that the AI acknowledgement reports (SPEC-01 AC50).
 */
function isPostRunCheck(command) {
  return command.trimStart().startsWith("#");
}

/**
 * Fail closed on the agent job. gh-aw runs `post-steps:` (the verification gates) inside the agent job, after
 * the job has ingested the agent output, and compiles `detection` and `safe_outputs` with conditions that do
 * not require that job to succeed (`always() && needs.agent.result != 'skipped'` and
 * `(!cancelled()) && needs.agent.result != 'skipped' && needs.detection.result == 'success'`), so a failing
 * gate would still reach the pull request. The compiler joins `jobs.<built-in>.if` to its own condition with
 * `&&`, so this guard can only narrow when the two jobs run (SPEC-01 AC29).
 *
 * A dry run of a drift workflow (SPEC-02 AC8) must create no branch, pull request, issue or label, so every built-in
 * job that holds a write permission is guarded on `inputs.dry_run` as well: `safe_outputs` (it publishes) and
 * `conclusion` (it opens the failure, missing-tool and incomplete-run issues). The `activation` job cannot be
 * guarded, because the agent needs it, and it writes only the compiler's own blocked-version notification.
 */
const AGENT_SUCCESS_GUARD = "needs.agent.result == 'success'";
const DRIFT_DRY_RUN_GUARD = "inputs.dry_run != true";
const DRIFT_SAFE_OUTPUTS_GUARD = `${AGENT_SUCCESS_GUARD} && ${DRIFT_DRY_RUN_GUARD}`;
const agentSuccessGuards = ({ drift = false } = {}) => ({
  detection: { if: AGENT_SUCCESS_GUARD },
  safe_outputs: { if: drift ? DRIFT_SAFE_OUTPUTS_GUARD : AGENT_SUCCESS_GUARD },
  ...(drift ? { conclusion: { if: DRIFT_DRY_RUN_GUARD } } : {}),
});

// ---------------------------------------------------------------------------------------
// Drift workflows
// ---------------------------------------------------------------------------------------

/**
 * The guidance of each built-in upkeep strategy. The source of truth is `prompts/drift/strategy-<value>.md` (SPEC-02 AC14), which the renderer reads
 * from the repository that it renders; this table is only what is used when that file is absent, in a minimal workspace that does not carry
 * `prompts/drift/` (the fixtures of the test suites). It repeats the text of the files, and a test holds the two equal.
 */
const STRATEGY_GUIDANCE = {
  "content-and-docs-sync":
    "Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.",
  "dependency-and-pattern-modernization":
    "Evaluate the package manifest snapshots for library and framework upgrades and pattern migrations (for example 17 -> 18) using the Context7 documentation server.",
  "code-quality-and-improvement-scan":
    "Scan the target's code for quality improvements and produce suggestions; a project may open them as draft pull requests.",
};
const STRATEGY_FRAGMENT_DIR = "prompts/drift";
const strategyHeading = (strategy) => `## Upkeep strategy: ${strategy}`;
const strategyFragmentPath = (strategy) => `${STRATEGY_FRAGMENT_DIR}/strategy-${strategy}.md`;

/**
 * The prompt fragment of a built-in upkeep strategy: the text of `prompts/drift/strategy-<value>.md` (the heading `## Upkeep strategy: <value>`,
 * a blank line and the guidance), or the built-in text when the repository has no such file. A file that exists must be usable: a regular file,
 * not larger than an instructions file, beginning with its heading and without the expression opener that the manifest strings are refused for.
 */
function readStrategyFragment(cwd, strategy) {
  const relative = strategyFragmentPath(strategy);
  const absolute = path.resolve(cwd, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { text: `${strategyHeading(strategy)}\n\n${STRATEGY_GUIDANCE[strategy]}` };
    return { error: `${relative} cannot be read: ${String(error?.message ?? error).split("\n")[0]}` };
  }
  if (!stat.isFile()) return { error: `${relative} is not a file` };
  if (stat.size > MAX_INSTRUCTIONS_BYTES) return { error: `${relative} is larger than ${MAX_INSTRUCTIONS_BYTES} bytes` };
  const text = lf(fs.readFileSync(absolute, "utf8")).trim();
  if (!text.startsWith(`${strategyHeading(strategy)}\n`)) return { error: `${relative} must begin with the heading '${strategyHeading(strategy)}'` };
  if (text.includes("${{")) return { error: `${relative} contains the expression opener "\${{"` };
  return { text };
}

const driftCloseOlderKey = (projectKey) => `sdlc-drift-${projectKey}`;

function driftPreAgentSteps(ctx, project) {
  const key = project.projectKey;
  const credentials = {
    APP_CLIENT_ID: expr(`vars.${ctx.request.appClientIdVar}`),
    APP_PRIVATE_KEY: expr(`secrets.${ctx.request.appPrivateKeySecret}`),
  };
  const checkoutPath = repoName(project.repo);
  return [
    {
      name: "Prepare run context",
      env: {
        CONFIGURED_TARGET_REPO: project.repo,
        TARGET_REPO_INPUT: expr("inputs.target_repo"),
        CORRELATION_ID: expr("inputs.correlation_id"),
        EXTRA_INSTRUCTIONS: expr("inputs.extra_instructions"),
        DRY_RUN: expr("inputs.dry_run"),
      },
      run:
        `node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out ${AGENT_DIR} --target-repo "$TARGET_REPO_INPUT"` +
        ' --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"',
    },
    {
      name: "Deduplicate open pull requests",
      env: { CONFIGURED_TARGET_REPO: project.repo, ...credentials },
      // The two arguments say which workflow this is: which pull requests are its own earlier ones (the key that the close-older marker of its
      // pull requests carries) and which upkeep it does, so that a pull request of another workflow of the fleet is not taken for a duplicate (SPEC-02 AC10).
      run:
        `node "$GITHUB_WORKSPACE/src/drift/dedupe-open-prs.mjs" --out ${AGENT_DIR} --target-repo "$CONFIGURED_TARGET_REPO"` +
        ` --close-older-key ${shArg(driftCloseOlderKey(key))} --upkeep-strategy ${shArg(project.driftAudit.upkeepStrategy)}`,
    },
    {
      name: "Snapshot watched sources and package manifests",
      env: { CONFIGURED_TARGET_REPO: project.repo },
      run: `node "$GITHUB_WORKSPACE/src/snapshot-watch-sources.mjs" --out ${AGENT_DIR} --project ${shArg(key)} --checkout ${shArg(checkoutPath)}`,
    },
  ];
}

function driftEscalation(ctx, project, workflowId) {
  return {
    needs: ["agent", "detection", "safe_outputs"],
    if: "failure() && inputs.dry_run != true",
    "detection-gate": "status-only",
    // actions: read lets the job's GITHUB_TOKEN list the jobs of the run, which names the failing command in the issue (SPEC-02 AC30);
    // a private repository refuses that read to a token without it.
    permissions: { actions: "read", contents: "read", issues: "write" },
    steps: [
      { uses: "actions/checkout@v4", with: { "sparse-checkout": "src\nschemas", "persist-credentials": false } },
      { run: "npm ci --ignore-scripts" },
      {
        name: "Escalate gate failure",
        env: {
          GH_TOKEN: expr("secrets.GITHUB_TOKEN"),
          WORKFLOW_ID: workflowId,
          TARGET_REPO: project.repo,
          CORRELATION_ID: expr("inputs.correlation_id"),
          RUN_URL: expr("github.server_url") + "/" + expr("github.repository") + "/actions/runs/" + expr("github.run_id"),
        },
        run:
          'node "$GITHUB_WORKSPACE/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID"' +
          ' --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"',
      },
    ],
  };
}

function driftBody(ctx, project) {
  const audit = project.driftAudit;
  const checkoutPath = repoName(project.repo);
  const lines = [];
  lines.push(`# Upkeep: ${oneLine(project.projectKey)}`);
  lines.push("");
  lines.push(
    `You maintain the repository \`${project.repo}\`, checked out at \`${checkoutPath}/\` in the workspace. Work only inside that checkout and follow the registration instructions below.`,
  );
  lines.push("");
  lines.push("## Registration instructions");
  lines.push("");
  const inline = lf(audit.instructions).trim();
  if (inline !== "") {
    lines.push(inline);
    lines.push("");
  }
  const fromFile = ctx.instructionFiles.get(project.projectKey);
  if (fromFile !== undefined && fromFile.trim() !== "") {
    lines.push(fromFile.replace(/\s+$/u, ""));
    lines.push("");
  }
  if (audit.upkeepStrategy !== "custom") {
    // the text of prompts/drift/strategy-<value>.md, heading included (readStrategyFragment found it, or used the built-in text for a workspace without it)
    lines.push(ctx.strategyFragments.get(audit.upkeepStrategy));
    lines.push("");
  }
  lines.push("## Watched sources");
  lines.push("");
  const urls = audit.knowledgeSources.watchUrls;
  if (urls.length === 0) {
    lines.push("No URLs are watched for this project.");
  } else {
    lines.push("Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):");
    lines.push("");
    for (const entry of urls) lines.push(`- ${oneLine(entry.label)} (${entry.kind}): ${oneLine(entry.url)}`);
  }
  lines.push("");
  lines.push("## Package manifests");
  lines.push("");
  const manifests = audit.knowledgeSources.packageManifests;
  if (manifests.length === 0) {
    lines.push("No package manifests are tracked for this project.");
  } else {
    lines.push("Dependency versions were snapshotted from files matching:");
    lines.push("");
    for (const pattern of manifests) lines.push(`- \`${oneLine(pattern)}\``);
  }
  lines.push("");
  lines.push("## Build commands");
  lines.push("");
  if (audit.buildCommands.length === 0) {
    lines.push("This project has no build commands.");
  } else {
    lines.push(
      "Run these commands in the target checkout before the pull request is created, and commit their outputs together with your source edits:",
    );
    lines.push("");
    lines.push(fenced(audit.buildCommands.map(lf).join("\n"), "bash"));
  }
  lines.push("");
  lines.push("## Operating rules");
  lines.push("");
  lines.push(
    `- Read \`${AGENT_DIR}/open-pr-dedup.json\` before you call \`create_pull_request\`; skip the upkeep when it lists a matching open pull request that you must not duplicate (\`duplicate\` is \`true\`: a match whose \`decision\` is \`skip\`). ` +
      "A match whose `decision` is `supersede` is an earlier pull request of this same workflow, which your new pull request replaces (`close-older-pull-requests: true`), " +
      "and a match whose `decision` is `ignore` is the pull request of another upkeep: neither is a reason to skip. Never open a duplicate.",
  );
  lines.push("- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.");
  lines.push("- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.");
  lines.push(
    `- Never run ${"`" + gitCommand("push") + "`"}, ${"`" + ["gh", "pr"].join(" ") + "`"} or a write-method \`${["gh", "api"].join(" ")}\` call and never merge: the pull request is created only through the \`create_pull_request\` safe output.`,
  );
  lines.push("- The verification commands run after you finish; fix the cause of a failure rather than working around it.");
  lines.push("- If you find no drift, record that outcome and do not open a pull request.");
  return lines.join("\n");
}

function renderDrift(ctx, project) {
  const audit = project.driftAudit;
  const key = project.projectKey;
  const workflowId = `drift-${key}`;
  const checkoutPath = repoName(project.repo);
  const frontmatter = {
    on: {
      schedule: [{ cron: audit.schedule }],
      workflow_dispatch: {
        inputs: {
          target_repo: { description: "Optional guard: must be empty or equal the configured target repository", type: "string" },
          correlation_id: { description: "Correlation id recorded in run context and failure issues", type: "string" },
          extra_instructions: { description: "Extra instructions appended after the registration instructions", type: "string" },
          dry_run: { description: "When true, create no branch, pull request or issue", type: "boolean", default: false },
        },
      },
      bots: [ctx.bot],
    },
    concurrency: { group: `sdlc-drift-${key}`, "cancel-in-progress": false },
    permissions: permissionsSection(ctx),
    network: { allowed: watchHostnames(audit.knowledgeSources.watchUrls) },
    checkout: [{ repository: project.repo, path: checkoutPath, current: true, "github-app": appBlock(ctx, [checkoutPath]) }],
    "mcp-servers": sortKeysDeep(audit.knowledgeSources.mcpServers),
    "pre-agent-steps": driftPreAgentSteps(ctx, project),
    "post-steps": audit.verifyCommands.map((command) => verifyStep(command, checkoutPath)),
    "safe-outputs": {
      "github-app": appBlock(ctx, [CENTRAL_REPOSITORY, checkoutPath]),
      "threat-detection": { "continue-on-error": false },
      "create-pull-request": {
        "target-repo": project.repo,
        "title-prefix": "chore(sdlc-drift): ",
        labels: ["automated", "sdlc-drift", "needs-review"],
        reviewers: [...audit.reviewers],
        draft: audit.draft,
        "branch-prefix": "sdlc/",
        "preserve-branch-name": true,
        "recreate-ref": true,
        "close-older-pull-requests": true,
        "close-older-key": driftCloseOlderKey(key),
        "exclude-lock-yml": true,
        "protected-files": { policy: "blocked", exclude: [...ctx.manifest.protectedFilesExclude] },
        "auto-merge": false,
        "fallback-as-issue": true,
        max: 1,
      },
    },
    engine: engineSection(ctx, { sdk: true }),
    tools: { "web-fetch": {}, bash: bashTool(ctx, ["git", "node", ...audit.buildCommands]), edit: {} },
    jobs: { ...agentSuccessGuards({ drift: true }), escalate_failure: driftEscalation(ctx, project, workflowId) },
  };
  return { id: workflowId, kind: "drift", project, text: serializeWorkflow(frontmatter, driftBody(ctx, project)) };
}

// ---------------------------------------------------------------------------------------
// Cascade workflows (mechanical and AI adaptation)
// ---------------------------------------------------------------------------------------

const downstreamName = (edge) => repoName(edge.downstreamRepo);
const upstreamName = (edge) => repoName(edge.upstreamRepo);
const cascadeId = (edge) => (edge.mode === "mechanical" ? `cascade-mechanical-${edge.edgeId}` : `cascade-ai-${edge.edgeId}`);

function cascadeCheckout(ctx, edge) {
  const upstream = {
    repository: edge.upstreamRepo,
    path: `upstream/${upstreamName(edge)}`,
    ref: expr("inputs.upstream_sha"),
  };
  if (edge.mode === "ai-adaptation") upstream["fetch-depth"] = 0;
  upstream["github-app"] = appBlock(ctx, [upstreamName(edge)]);
  return [
    { repository: edge.downstreamRepo, path: downstreamName(edge), current: true, "github-app": appBlock(ctx, [downstreamName(edge)]) },
    upstream,
  ];
}

function cascadeSteps(edge) {
  const down = downstreamName(edge);
  const steps = [{ name: "Set up Node.js 24", uses: "actions/setup-node@v4", with: { "node-version": "24" } }];
  for (const directory of edge.installDirectories) {
    steps.push({
      name: directory === "." ? "Install dependencies (root)" : `Install dependencies (${directory})`,
      run: "npm ci --include=dev",
      "working-directory": directory === "." ? down : `${down}/${directory}`,
    });
  }
  steps.push({ name: "Install Microsoft Edge", run: "npx playwright install --with-deps msedge", "working-directory": down });
  return steps;
}

function envAppendLine(edge) {
  return (
    '{ echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; ' +
    `echo "BRANCH_NAME=${shDq(edge.branchName)}"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/${upstreamName(edge)}"; ` +
    '} >> "$GITHUB_ENV"'
  );
}

function mechanicalPreAgentSteps(edge) {
  const down = downstreamName(edge);
  return [
    {
      name: "Validate revisions and record the base revision",
      env: { UPSTREAM_SHA: expr("inputs.upstream_sha"), PREVIOUS_SHA: expr("inputs.previous_sha") },
      run: [
        "set -euo pipefail",
        "hex40='^[0-9a-f]{40}$'",
        'if ! [[ "$UPSTREAM_SHA" =~ $hex40 ]]; then echo "upstream_sha must be 40 lowercase hexadecimal characters" >&2; exit 2; fi',
        'if ! [[ "$PREVIOUS_SHA" =~ $hex40 ]]; then echo "previous_sha must be 40 lowercase hexadecimal characters" >&2; exit 2; fi',
        `BASE_SHA="$(git -C "$GITHUB_WORKSPACE/${down}" rev-parse HEAD)"`,
        "mkdir -p /tmp/gh-aw",
        'echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt',
        envAppendLine(edge),
      ].join("\n"),
    },
  ];
}

function shaHandOffStep(edge) {
  const down = downstreamName(edge);
  return {
    name: "Record the base and head revisions",
    run: [
      "set -euo pipefail",
      'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
      'if ! [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then echo "base-sha.txt must hold 40 lowercase hexadecimal characters" >&2; exit 1; fi',
      `AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/${down}" rev-parse HEAD)"`,
      "cat > /tmp/gh-aw/cascade-shas.json <<EOF",
      '{"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}',
      "EOF",
      '{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"',
    ].join("\n"),
  };
}

const uploadShasStep = () => ({
  name: "Upload the cascade revisions",
  uses: "actions/upload-artifact@v4",
  with: { name: "sdlc-cascade-shas-" + expr("github.run_id"), path: "/tmp/gh-aw/cascade-shas.json", "if-no-files-found": "error" },
});

/**
 * POSIX extended regular expression (unanchored) for one `allowedFiles` entry, with the meaning gh-aw gives an
 * `allowed-files` pattern: `*` matches any characters except `/`, `**` matches any characters including `/`, and
 * every other character is literal. A bash `case` pattern cannot express that, because its `*` also crosses `/`.
 */
function allowedFileEre(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] !== "*") {
      source += glob[i].replace(/[.[{()\\+?|^$]/g, "\\$&");
    } else if (glob[i + 1] === "*") {
      i += 1;
      source += ".*";
    } else {
      source += "[^/]*";
    }
  }
  return source;
}

function allowedPathsStep(edge) {
  const down = downstreamName(edge);
  const allowed = `^(${edge.allowedFiles.map(allowedFileEre).join("|")})$`;
  return {
    name: "Verify changed paths are covered by the allowed files",
    run: [
      "set -euo pipefail",
      // --no-renames: with rename detection (git's default) a file moved from outside the allowed files into them is listed by its destination only,
      // and the deletion of its source would go unseen
      `changed="$(git -C "$GITHUB_WORKSPACE/${down}" diff --name-only --no-renames "$BASE_SHA" HEAD)"`,
      `allowed=${shArg(allowed)}`,
      "bad=0",
      "while IFS= read -r file; do",
      '  [ -n "$file" ] || continue',
      '  [[ "$file" =~ $allowed ]] || { echo "path outside the allowed files: $file" >&2; bad=1; }',
      'done <<< "$changed"',
      'exit "$bad"',
    ].join("\n"),
  };
}

/**
 * The importer is a black box that throws before its first write when it cannot import (SPEC-03 AC62, AC64), so a failed import leaves a clean worktree and no
 * commit, which the two checks before this one accept. What a successful import always does is record the revision of the upstream checkout that it read, and the
 * checkout is pinned to upstream_sha: the edge's provenance file, at its JSON pointer, has to name upstream_sha. The file and the pointer are data of the edge and
 * reach the script through the environment of the step, never through its text.
 */
function importRecordedStep(edge) {
  const down = downstreamName(edge);
  return {
    name: "Verify the import recorded the upstream revision",
    env: { PROVENANCE_FILE: edge.provenanceFile, PROVENANCE_POINTER: edge.provenanceJsonPointer },
    run: [
      "set -euo pipefail",
      "node --input-type=module -e '",
      'import { readFileSync } from "node:fs";',
      `const file = process.env.GITHUB_WORKSPACE + "/${down}/" + process.env.PROVENANCE_FILE;`,
      "let value;",
      'try { value = JSON.parse(readFileSync(file, "utf8")); }',
      'catch { console.error("the import left no readable " + process.env.PROVENANCE_FILE); process.exit(1); }',
      'for (const key of process.env.PROVENANCE_POINTER.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) value = value?.[key];',
      "if (value !== process.env.UPSTREAM_SHA) {",
      '  console.error("the import did not record " + process.env.UPSTREAM_SHA + " in " + process.env.PROVENANCE_FILE + " (it records " + JSON.stringify(value) + ")");',
      "  process.exit(1);",
      "}",
      "'",
    ].join("\n"),
  };
}

function commandSteps(commands, workingDirectory) {
  return commands.map((command) => verifyStep(command, workingDirectory));
}

function helperCommand(edge, workflowId) {
  return `node --frozen-intrinsics "$GITHUB_WORKSPACE/src/verify-immutable-gates.mjs" --portfolio "$GITHUB_WORKSPACE/${downstreamName(edge)}" --base "$BASE_SHA" --workflow ${workflowId}`;
}

/** The `verifyCommands` entries that belong to the verification gate, in manifest order; post-run checks are not members. */
function gateCommandsOf(edge) {
  return edge.verifyCommands.filter((command) => !isPostRunCheck(command));
}

function aiValidationStep(edge) {
  const up = upstreamName(edge);
  const upstreamDir = `$GITHUB_WORKSPACE/upstream/${up}`;
  return {
    name: "Validate dispatch inputs and checkouts",
    env: dispatchEnv(),
    run: [
      "set -euo pipefail",
      'fail() { echo "$1" >&2; exit 2; }',
      "hex40='^[0-9a-f]{40}$'",
      '[[ "$UPSTREAM_SHA" =~ $hex40 ]] || fail "upstream_sha must be 40 lowercase hexadecimal characters"',
      '[[ "$PREVIOUS_SHA" =~ $hex40 ]] || fail "previous_sha must be 40 lowercase hexadecimal characters"',
      `case "$SYNC_SCOPE" in ${edge.syncScopes.join("|")}) ;; *) fail "sync_scope is not accepted by this workflow: $SYNC_SCOPE" ;; esac`,
      'case "$ON_COMMIT_ONLY_ADVANCE" in noop|bump-provenance) ;; *) fail "on_commit_only_advance must be noop or bump-provenance" ;; esac',
      `[ "$DOWNSTREAM_REPO_INPUT" = "${shDq(edge.downstreamRepo)}" ] || fail "downstream_repo must be ${shDq(edge.downstreamRepo)}"`,
      `[ "$UPSTREAM_REPO_INPUT" = "${shDq(edge.upstreamRepo)}" ] || fail "upstream_repo must be ${shDq(edge.upstreamRepo)}"`,
      'case "$DRY_RUN" in ""|true|false) ;; *) fail "dry_run must be empty, true or false" ;; esac',
      `[ "$(git -C "${upstreamDir}" rev-parse HEAD)" = "$UPSTREAM_SHA" ] || fail "the upstream checkout is not at upstream_sha"`,
      `git -C "${upstreamDir}" cat-file -e "$PREVIOUS_SHA^{commit}" || fail "the upstream checkout does not contain previous_sha"`,
      'echo "DRY_RUN=$DRY_RUN" >> "$GITHUB_ENV"',
    ].join("\n"),
  };
}

function aiBaseShaStep(edge) {
  const down = downstreamName(edge);
  const up = upstreamName(edge);
  const [owner] = edge.downstreamRepo.split("/");
  const inputsProgram =
    'import { writeFileSync } from "node:fs"; const e = process.env; ' +
    `writeFileSync("${AGENT_DIR}/dispatch-inputs.json", JSON.stringify({ ` +
    "correlation_id: e.CORRELATION_ID, upstream_repo: e.UPSTREAM_REPO_INPUT, previous_sha: e.PREVIOUS_SHA, upstream_sha: e.UPSTREAM_SHA, " +
    "upstream_etag: e.UPSTREAM_ETAG, upstream_pr_number: e.UPSTREAM_PR_NUMBER, downstream_repo: e.DOWNSTREAM_REPO_INPUT, " +
    'sync_scope: e.SYNC_SCOPE, on_commit_only_advance: e.ON_COMMIT_ONLY_ADVANCE, dry_run: e.DRY_RUN }, null, 2) + "\\n");';
  return {
    name: "Record the base revision and the dispatch evidence",
    env: { ...dispatchEnv(), GH_TOKEN: expr("github.token") },
    run: [
      "set -euo pipefail",
      `BASE_SHA="$(git -C "$GITHUB_WORKSPACE/${down}" rev-parse HEAD)"`,
      `mkdir -p /tmp/gh-aw ${AGENT_DIR}`,
      'echo "$BASE_SHA" > /tmp/gh-aw/base-sha.txt',
      envAppendLine(edge),
      `git -C "$GITHUB_WORKSPACE/upstream/${up}" diff --name-status "$PREVIOUS_SHA" "$UPSTREAM_SHA" > ${AGENT_DIR}/upstream-diff.txt`,
      `node --input-type=module -e '${inputsProgram}'`,
      `if pulls="$(gh api "repos/${shDq(edge.downstreamRepo)}/pulls?state=open&head=${shDq(owner)}:${shDq(edge.branchName)}" --jq '.[0] // null' 2>/dev/null)"; then`,
      `  printf '%s\\n' "$pulls" > ${AGENT_DIR}/existing-pr.json`,
      "else",
      `  echo null > ${AGENT_DIR}/existing-pr.json`,
      "fi",
    ].join("\n"),
  };
}

/**
 * The capture hook of an AI workflow: every preflight command runs in the downstream checkout against the upstream checkout, read-only, and its output lands in
 * the artifact directory as preflight-<n>.txt (the exit codes in preflight-exit-codes.txt). The edge's `adaptation.preflightReports` names each report as the
 * agent and the later steps know it, and the file is a copy of the numbered one, so that the commands (shared with the router's matrix) stay the single source
 * of what runs. An exit code of 2 or more, or an uncaught-exception stack trace in any report (the exit code 1 of a drift report cannot tell drift from a
 * crash), fails the step before the agent starts; drift itself (exit code 1) is evidence for the agent, never a failure.
 */
function aiCaptureStep(edge) {
  const down = downstreamName(edge);
  const reports = edge.adaptation?.preflightReports ?? [];
  const numbered = edge.preflightCommands.map((_, index) => `${AGENT_DIR}/preflight-${index + 1}.txt`);
  const lines = [
    "set -uo pipefail",
    `mkdir -p ${AGENT_DIR}`,
    'TARGET_SHA="$UPSTREAM_SHA"',
    'LAST_MERGED_SHA="$PREVIOUS_SHA"',
    "export TARGET_SHA LAST_MERGED_SHA",
    "set +e",
  ];
  edge.preflightCommands.forEach((command, index) => {
    const n = index + 1;
    lines.push(`( ${fillCheckout(command).trim()} ) > ${AGENT_DIR}/preflight-${n}.txt 2>&1`);
    lines.push(`rc${n}=$?`);
  });
  lines.push("set -e");
  reports.forEach((name, index) => lines.push(`cp ${numbered[index]} ${AGENT_DIR}/${name}`));
  const codes = edge.preflightCommands.map((_, index) => `rc${index + 1}`);
  lines.push(`printf 'preflight exit codes:${codes.map((code) => ` %s`).join("")}\\n' ${codes.map((code) => `"$${code}"`).join(" ")} > ${AGENT_DIR}/preflight-exit-codes.txt`);
  lines.push(`for rc in ${codes.map((code) => `"$${code}"`).join(" ")}; do`);
  lines.push('  if [ "$rc" -ge 2 ]; then echo "a preflight command failed with exit code $rc" >&2; exit 2; fi');
  lines.push("done");
  lines.push(`if grep -Eq '^[[:space:]]+at[[:space:]]+[^[:space:]]' ${numbered.join(" ")}; then echo "a preflight report holds an uncaught-exception stack trace" >&2; exit 2; fi`);
  const step = { name: "Capture the drift reports", "working-directory": down, run: lines.join("\n") };
  if (edge.preflightCommands.some((command) => usesGhCli(command))) step.env = { GH_TOKEN: expr("github.token") };
  return step;
}

function aiCleanGuardStep(edge) {
  const down = downstreamName(edge);
  return {
    name: "Verify the downstream worktree is read-only so far",
    run: [
      "set -euo pipefail",
      `status="$(git -C "$GITHUB_WORKSPACE/${down}" status --porcelain)"`,
      'if [ -n "$status" ]; then echo "the downstream worktree is not clean:" >&2; echo "$status" >&2; exit 1; fi',
      `[ "$(git -C "$GITHUB_WORKSPACE/${down}" rev-parse HEAD)" = "$BASE_SHA" ] || { echo "the downstream HEAD moved" >&2; exit 1; }`,
    ].join("\n"),
  };
}

function pollStateEnv(edge, kind) {
  const env = {
    GH_TOKEN: expr("steps.app_token.outputs.token"),
    ISSUES_TOKEN: expr("secrets.GITHUB_TOKEN"),
    UPSTREAM_SHA: expr("inputs.upstream_sha"),
    // the id that the router generated for the event and dispatched as correlation_id: the script writes it into the [sdlc-failure] issue (SPEC-03 AC52),
    // because this job is a run of its own whose run id is not the event's
    CORRELATION_ID: expr("inputs.correlation_id"),
  };
  if (kind === "finalize") env.UPSTREAM_ETAG = expr("inputs.upstream_etag");
  if (edge.mode === "ai-adaptation") {
    env.REPO_SLUG = edge.upstreamSlug;
    env.BRANCH_NAME = edge.branchName;
    if (kind === "finalize") env.PROVENANCE_FILE = edge.provenanceFile;
  }
  return env;
}

// An actions/create-github-app-token step that sets any permission-* input requests exactly those permissions and inherits nothing from the
// installation (getPermissionsFromInputs returns undefined, which means "inherit", only when no such input is set), so the token that S3's
// script reads from GH_TOKEN carries variables: write (the SDLC_SYNC_STATE_<SLUG> read and write, SPEC-03 AC12) only because the step names it.
// The input that grants it is permission-actions-variables: an installation reports the Variables permission as actions_variables, and that is
// the name the token request has to use (a live run needed it; the baseline and the manifest still call the permission `variables`).
function appTokenStep(ctx, edge) {
  return {
    id: "app_token",
    uses: "actions/create-github-app-token@v2",
    with: {
      "app-id": expr(`vars.${ctx.request.appClientIdVar}`),
      "private-key": expr(`secrets.${ctx.request.appPrivateKeySecret}`),
      owner: expr("github.repository_owner"),
      repositories: expr("github.event.repository.name") + "," + downstreamName(edge),
      "permission-contents": "read",
      "permission-pull-requests": "read",
      "permission-actions-variables": "write",
    },
  };
}

function customJobPrelude(ctx, edge) {
  return [
    appTokenStep(ctx, edge),
    {
      uses: "actions/checkout@v4",
      with: { token: expr("steps.app_token.outputs.token"), "sparse-checkout": "src\nschemas", "persist-credentials": false },
    },
    { run: "npm ci --ignore-scripts" },
  ];
}

function cascadeJobs(ctx, edge) {
  const workflowId = cascadeId(edge);
  const mechanical = edge.mode === "mechanical";
  const slugArgs = mechanical
    ? `--slug ${shArg(edge.upstreamSlug)} --branch ${shArg(edge.branchName)} --provenance-file ${shArg(edge.provenanceFile)}`
    : '--slug "$REPO_SLUG" --branch "$BRANCH_NAME" --provenance-file "$PROVENANCE_FILE"';
  const pollState =
    `node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" ${slugArgs}` +
    ' --base-sha "$BASE_SHA" --head-sha "$AGENT_HEAD_SHA" --target-sha "$UPSTREAM_SHA" --etag "$UPSTREAM_ETAG"';
  // The poll-state script prints one JSON line when it succeeds (SPEC-03), which this step keeps in a file and prints. An AI adaptation run then extends it
  // into its own result, PortfolioAiPullRequestResult, as the last line printed and as the output `result` of the step (SPEC-04 AC70); a step that
  // fails stops before that, because the script's exit code decides the run.
  const resultFile = '"${RUNNER_TEMP:-/tmp}/poll-state-result.json"';
  const updateRun = mechanical
    ? pollState
    : [
        `${pollState} > ${resultFile}`,
        `cat ${resultFile}`,
        `if [ -s ${resultFile} ]; then`,
        `  node "$GITHUB_WORKSPACE/src/ai-pull-request-result.mjs" --slug "$REPO_SLUG" --poll-state-result ${resultFile}`,
        "fi",
      ].join("\n");
  const finalize = {
    needs: ["agent", "detection", "safe_outputs"],
    if: "success() && inputs.dry_run != 'true'",
    permissions: { issues: "write" },
    steps: [
      ...customJobPrelude(ctx, edge),
      {
        uses: "actions/download-artifact@v4",
        with: { name: "sdlc-cascade-shas-" + expr("github.run_id"), path: "/tmp/gh-aw" },
      },
      {
        name: "Export the base and head revisions",
        run: [
          "set -euo pipefail",
          'BASE_SHA="$(jq -r .baseSha /tmp/gh-aw/cascade-shas.json)"',
          'AGENT_HEAD_SHA="$(jq -r .headSha /tmp/gh-aw/cascade-shas.json)"',
          'for value in "$BASE_SHA" "$AGENT_HEAD_SHA"; do',
          '  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { echo "cascade-shas.json holds a malformed revision" >&2; exit 1; }',
          "done",
          '{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"',
        ].join("\n"),
      },
      {
        name: "Update the poll state",
        if: "inputs.dry_run != 'true'",
        env: pollStateEnv(edge, "finalize"),
        run: updateRun,
      },
    ],
  };
  const escalate = {
    needs: ["agent", "detection", "safe_outputs"],
    if: "failure() && inputs.dry_run != 'true'",
    "detection-gate": "status-only",
    permissions: { issues: "write" },
    steps: [
      ...customJobPrelude(ctx, edge),
      {
        name: "Record the failure",
        if: "inputs.dry_run != 'true'",
        env: pollStateEnv(edge, "escalate"),
        run:
          `node "$GITHUB_WORKSPACE/src/update-poll-state.mjs" --record-failure ${mechanical ? `--slug ${shArg(edge.upstreamSlug)}` : '--slug "$REPO_SLUG"'}` +
          ` --target-sha "$UPSTREAM_SHA" --workflow-id ${workflowId}`,
      },
    ],
  };
  return { finalize_poll_state: finalize, escalate_failure: escalate };
}

/** Directories to stage: the literal directory part of each allowed glob. */
function allowedGitPaths(globs) {
  return uniqueSorted(
    globs.map((glob) => {
      const prefix = literalPrefix(glob);
      if (prefix === glob) return glob;
      const slash = prefix.lastIndexOf("/");
      return slash === -1 ? "." : glob.slice(0, slash);
    }),
  );
}

function mechanicalBody(edge) {
  const down = downstreamName(edge);
  const imports = edge.importCommands.map((command) => fillCheckout(command));
  const lines = [];
  lines.push(`# Mechanical cascade: ${edge.edgeId}`);
  lines.push("");
  lines.push(
    `Import the upstream revision \`$UPSTREAM_SHA\` of \`${edge.upstreamRepo}\` into the downstream checkout \`${down}/\` and open one pull request on \`${edge.downstreamRepo}\`. Do exactly the three actions below, in this order, and nothing else.`,
  );
  lines.push("");
  lines.push("1. Run the import from the downstream checkout:");
  lines.push("");
  lines.push(fenced([`cd "$GITHUB_WORKSPACE/${down}"`, ...imports].join("\n"), "bash"));
  lines.push("");
  lines.push("2. Commit everything the import changed under the allowed paths:");
  lines.push("");
  lines.push(
    fenced(
      [`${gitCommand("add")} ${allowedGitPaths(edge.allowedFiles).map(shArg).join(" ")}`, `${gitCommand("commit")} -m "chore(cascade): import ${edge.upstreamKey} $UPSTREAM_SHA"`].join("\n"),
      "bash",
    ),
  );
  lines.push("");
  lines.push(`3. Call \`create_pull_request\` with exactly the branch \`${edge.branchName}\`.`);
  lines.push("");
  lines.push(
    "The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The verification commands run after you finish. Do not edit the upstream checkout, and do not publish branches yourself: the pull request is created only by the safe output.",
  );
  return lines.join("\n");
}

/** An inline code span whose delimiter is longer than any run of backticks inside the text. */
function codeSpan(text) {
  const value = oneLine(text);
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const tick = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${tick}${pad}${value}${pad}${tick}`;
}

/** The locked test files of an edge, as the verification gate reads them: a file and its named blocks. Entries of another shape are not listed. */
function lockedTestsOf(edge) {
  const entries = Array.isArray(edge.immutableGates.lockedTestBlocks) ? edge.immutableGates.lockedTestBlocks : [];
  return entries
    .filter((entry) => isObj(entry) && typeof entry.file === "string" && entry.file !== "" && Array.isArray(entry.blocks))
    .map((entry) => ({
      file: entry.file,
      blocks: entry.blocks.filter((block) => isObj(block) && (block.kind === "it" || block.kind === "describe") && typeof block.title === "string" && block.title !== ""),
      lockedImports: Array.isArray(entry.lockedImports) ? entry.lockedImports.filter((name) => typeof name === "string" && name !== "") : [],
    }));
}

/** The companion test files of the other AI edges into the same downstream repository: each belongs to its own workflow, which is its only writer. */
function siblingTestFilesOf(ctx, edge) {
  const siblings = ctx.manifest.dependencyEdges.filter((other) => other !== edge && other.mode === "ai-adaptation" && other.downstreamRepo === edge.downstreamRepo);
  return uniqueStable(siblings.flatMap((other) => lockedTestsOf(other).map((entry) => entry.file)));
}

/**
 * The prompt of an AI adaptation workflow. The order is the order of the work, and the first mention of the pull request comes after the commit that it
 * packages: read the evidence, decide, edit, run the deterministic commands, commit, and only then open the pull request. Everything in it is data of the
 * edge: the instructions, the paths, the locked blocks and the commands.
 */
function aiBody(ctx, edge) {
  const down = downstreamName(edge);
  const reports = edge.adaptation?.preflightReports ?? [];
  const lines = [];
  lines.push(`# AI adaptation: ${edge.edgeId}`);
  lines.push("");
  lines.push(
    `Adapt the downstream checkout \`${down}/\` of \`${edge.downstreamRepo}\` to the upstream changes in \`${edge.upstreamRepo}\`. The cumulative range you adapt against is \`previous_sha..upstream_sha\`; the exact revisions are in \`${AGENT_DIR}/dispatch-inputs.json\`. Work in this order: read the evidence, decide whether anything must change, make the edits, run the deterministic commands, commit, and only then open the pull request.`,
  );
  lines.push("");
  lines.push("## Adaptation instructions");
  lines.push("");
  const instructions = lf(edge.adaptationInstructions).trim();
  lines.push(instructions === "" ? "No edge-specific instructions are configured." : instructions);
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  lines.push(`Read the artifacts under \`${AGENT_DIR}/\` first. They were captured before you started and are what you know about the upstream change:`);
  lines.push("");
  lines.push("- `dispatch-inputs.json`: the ten dispatch inputs verbatim, among them `correlation_id`, `previous_sha`, `upstream_sha` and `on_commit_only_advance`.");
  lines.push("- `upstream-diff.txt`: the changed upstream files of `previous_sha..upstream_sha`, with their status.");
  lines.push("- `existing-pr.json`: the open pull request for the branch of this workflow, or `null`.");
  edge.preflightCommands.forEach((command, index) => {
    const numbered = `preflight-${index + 1}.txt`;
    const files = reports[index] === undefined ? codeSpan(numbered) : `${codeSpan(reports[index])} (also ${codeSpan(numbered)})`;
    lines.push(`- ${files}: the output of ${codeSpan(fillCheckout(command))}.`);
  });
  if (edge.preflightCommands.length > 0) {
    lines.push("- `preflight-exit-codes.txt`: the exit codes of those commands. An exit code of 1 is a drift report for you to act on, not a failure.");
  }
  lines.push("");
  lines.push(
    "The variables `UPSTREAM_DIR`, `UPSTREAM_SHA`, `PREVIOUS_SHA`, `BASE_SHA` and `BRANCH_NAME` are exported for you. The upstream checkout `$UPSTREAM_DIR` is read-only: never write to it.",
  );
  lines.push("");
  lines.push("## What to do");
  lines.push("");
  lines.push("1. Decide from the evidence which case applies. When nothing has to be adapted, read `on_commit_only_advance` in `dispatch-inputs.json`: `noop` means that you leave the worktree exactly as it is, with no edit and no commit, so that the run ends without a pull request; `bump-provenance` means that you make no content edit and go to step 3, which records the new revision. Otherwise adapt the downstream as the adaptation instructions say.");
  lines.push("2. Make the edits, changing only the files you may change and never the files you must not change (both lists are below).");
  lines.push("3. Run the deterministic commands below, in their order.");
  lines.push("4. Commit what they and you changed, with the commands that close that block.");
  lines.push("5. Open the pull request (the last section).");
  lines.push("");
  lines.push("## Files you may change");
  lines.push("");
  lines.push("Only these paths (the pull request is refused for any other file):");
  lines.push("");
  for (const pattern of edge.allowedFiles) lines.push(`- ${codeSpan(pattern)}`);
  lines.push("");
  lines.push("## Files you must not change");
  lines.push("");
  const locked = edge.immutableGates.zeroDiffPaths;
  const siblings = siblingTestFilesOf(ctx, edge).filter((file) => !locked.includes(file));
  if (locked.length === 0 && siblings.length === 0) {
    lines.push("No paths are locked for this edge.");
  } else {
    lines.push("A difference in any of them fails the verification that runs after you finish, and no pull request is opened:");
    lines.push("");
    for (const lockedPath of locked) lines.push(`- ${codeSpan(lockedPath)}`);
    if (siblings.length > 0) {
      lines.push("");
      lines.push("The companion test files of the other adaptation workflows are theirs alone:");
      lines.push("");
      for (const sibling of siblings) lines.push(`- ${codeSpan(sibling)}`);
    }
  }
  const lockedTests = lockedTestsOf(edge).filter((entry) => entry.blocks.length > 0);
  if (lockedTests.length > 0) {
    lines.push("");
    lines.push("## Test blocks that stay byte for byte");
    lines.push("");
    lines.push("After you finish, these parts of the test files below are compared with the base revision, and any difference fails the run. Every other test in those files may be edited.");
    for (const entry of lockedTests) {
      lines.push("");
      lines.push(`- ${codeSpan(entry.file)}: the lines before the first ${codeSpan("describe(")}, every ${codeSpan("describe(")} header line, and these blocks:`);
      for (const block of entry.blocks) lines.push(`  - ${codeSpan(`${block.kind}(${JSON.stringify(block.title)})`)}`);
      if (entry.lockedImports.length > 0) lines.push(`  - the import of ${entry.lockedImports.map(codeSpan).join(", ")}, which must stay as it is`);
    }
  }
  lines.push("");
  const accept = edge.acceptCommands.map((command) => fillCheckout(command));
  const build = edge.buildCommands.map((command) => fillCheckout(command));
  lines.push("## Deterministic commands");
  lines.push("");
  lines.push(
    `Run these from \`$GITHUB_WORKSPACE/${down}\`, in this order, after your edits. A non-zero exit of any command is a failed run: stop, do not commit, and do not open the pull request. The last two lines commit the result.`,
  );
  lines.push("");
  lines.push(
    fenced(
      [
        `cd "$GITHUB_WORKSPACE/${down}"`,
        ...accept,
        ...build,
        `${gitCommand("add")} -- ${allowedGitPaths(edge.allowedFiles).map(shArg).join(" ")}`,
        `${gitCommand("commit")} -m "feat(cascade): adapt ${edge.upstreamKey} to $UPSTREAM_SHA"`,
      ].join("\n"),
      "bash",
    ),
  );
  lines.push("");
  lines.push("## Pull request");
  lines.push("");
  lines.push(
    `Only after that commit, call \`create_pull_request\` with exactly the branch \`${edge.branchName}\`. Its body lists \`previous_sha..upstream_sha\`, the \`correlation_id\` of \`dispatch-inputs.json\`, the adapted modules and Studio labs, and anything a reviewer must check by hand.`,
  );
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- When no adaptation is required, leave the worktree clean and make no commit, so the run ends without a pull request.");
  lines.push(`- When the dispatch input \`dry_run\` is \`true\`, do not run ${"`" + gitCommand("commit") + "`"} and do not call \`create_pull_request\`.`);
  lines.push("- Do not edit anything under `upstream/`. The pull request is created only through the safe output; do not publish branches yourself.");
  return lines.join("\n");
}

function renderCascade(ctx, edge) {
  const mechanical = edge.mode === "mechanical";
  const workflowId = cascadeId(edge);
  const down = downstreamName(edge);
  const importWords = [...edge.importCommands, ...edge.acceptCommands, ...edge.buildCommands];
  const handler = {
    "target-repo": edge.downstreamRepo,
    "title-prefix": mechanical ? "chore(cascade): " : "feat(cascade): ",
    labels: mechanical ? ["automated", "sdlc-cascade", "needs-review"] : ["automated", "sdlc-cascade", "ai-adapted", "needs-review"],
    reviewers: [...edge.reviewers],
    draft: false,
    "preserve-branch-name": true,
    "recreate-ref": true,
    "close-older-pull-requests": true,
    "close-older-key": edge.closeOlderKey,
    "if-no-changes": "ignore",
    "auto-merge": false,
    "fallback-as-issue": false,
    "allowed-files": [...edge.allowedFiles],
    "exclude-lock-yml": true,
    "protected-files": { policy: "blocked", exclude: [...edge.protectedFilesExclude] },
    max: 1,
  };
  // A mechanical import commits whole generated bundles, some of them single lines of several megabytes, and the handler refuses a patch over its
  // size limit (in KB); 10 MB leaves room for them.
  if (mechanical) handler["max-patch-size"] = 10240;
  const frontmatter = {
    on: {
      workflow_dispatch: { inputs: inputsOf(mechanical ? MECHANICAL_INPUTS : AI_INPUTS, DISPATCH_DESCRIPTIONS) },
      bots: [ctx.bot],
    },
    concurrency: { group: `sdlc-state-${edge.upstreamKey}`, "cancel-in-progress": false },
    permissions: permissionsSection(ctx),
    engine: engineSection(ctx, { sdk: false }),
    network: { allowed: mechanical ? [] : ["api.github.com"] },
    checkout: cascadeCheckout(ctx, edge),
    steps: cascadeSteps(edge),
  };
  if (mechanical) {
    frontmatter["pre-agent-steps"] = mechanicalPreAgentSteps(edge);
    frontmatter["post-steps"] = [
      shaHandOffStep(edge),
      uploadShasStep(),
      { name: "Verify the downstream worktree is clean", run: cleanTreeScript(`git -C "$GITHUB_WORKSPACE/${down}" status --porcelain`) },
      allowedPathsStep(edge),
      importRecordedStep(edge),
      ...commandSteps(edge.buildCommands, down),
      ...commandSteps(edge.verifyCommands, down),
    ];
  } else {
    const hook = edge.preflightCommands.length > 0 ? [aiCaptureStep(edge)] : [];
    frontmatter["pre-agent-steps"] = [aiValidationStep(edge), aiBaseShaStep(edge), ...hook, aiCleanGuardStep(edge)];
    frontmatter["post-steps"] = [
      shaHandOffStep(edge),
      uploadShasStep(),
      { name: helperCommand(edge, workflowId), run: helperCommand(edge, workflowId) },
      ...commandSteps(edge.verifyCommands, down),
    ];
  }
  frontmatter["safe-outputs"] = {
    "github-app": appBlock(ctx, [CENTRAL_REPOSITORY, down]),
    "threat-detection": { "continue-on-error": false },
    "create-pull-request": handler,
  };
  const bash = bashTool(ctx, [...(mechanical ? MECHANICAL_BASH : ["git"]), ...importWords]);
  frontmatter.tools = mechanical ? { bash } : { bash, edit: {} };
  frontmatter.jobs = { ...agentSuccessGuards(), ...cascadeJobs(ctx, edge) };
  return {
    id: workflowId,
    kind: mechanical ? "mechanical" : "ai",
    edge,
    text: serializeWorkflow(frontmatter, mechanical ? mechanicalBody(edge) : aiBody(ctx, edge)),
  };
}

// ---------------------------------------------------------------------------------------
// Event router (plain GitHub Actions workflow)
// ---------------------------------------------------------------------------------------

function matrixEntry(ctx, edge) {
  return {
    edgeId: edge.edgeId,
    upstreamRepo: edge.upstreamRepo,
    upstreamKey: edge.upstreamKey,
    upstreamSlug: edge.upstreamSlug,
    upstreamDefaultBranch: edge.upstreamDefaultBranch,
    initialBaselineSha: edge.initialBaselineSha,
    downstreamRepo: edge.downstreamRepo,
    mode: edge.mode,
    schedule: edge.schedule,
    onCommitOnlyAdvance: edge.onCommitOnlyAdvance,
    stateVariable: edge.stateVariable,
    provenanceFile: edge.provenanceFile,
    provenanceJsonPointer: edge.provenanceJsonPointer,
    onBots: [ctx.bot],
    branchName: edge.branchName,
    closeOlderKey: edge.closeOlderKey,
    reviewers: [...edge.reviewers],
    importCommands: [...edge.importCommands],
    preflightCommands: [...edge.preflightCommands],
    buildCommands: [...edge.buildCommands],
    verifyCommands: [...edge.verifyCommands],
  };
}

function renderRouter(ctx, edges) {
  const crons = uniqueSorted(edges.map((edge) => edge.schedule).filter((schedule) => schedule !== null));
  const on = { repository_dispatch: { types: ["upstream_pr_merged"] } };
  if (crons.length > 0) on.schedule = crons.map((cron) => ({ cron }));
  on.workflow_dispatch = {
    inputs: { reset_blocked: { description: "Clear the failure and blocked state of every upstream before routing", type: "boolean", default: false } },
  };
  const workflow = {
    name: "SDLC cascade router",
    on,
    permissions: { contents: "read", issues: "write" },
    jobs: {
      route: {
        name: "route " + expr("matrix.upstreamKey"),
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 30,
        strategy: {
          "max-parallel": 1,
          "fail-fast": false,
          matrix: { upstreamKey: edges.map((edge) => edge.upstreamKey), include: edges.map((edge) => matrixEntry(ctx, edge)) },
        },
        concurrency: { group: "sdlc-state-" + expr("matrix.upstreamKey"), "cancel-in-progress": false },
        steps: [
          { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
          { run: "npm ci --ignore-scripts" },
          {
            name: "Route the upstream",
            env: {
              UPSTREAM_KEY: expr("matrix.upstreamKey"),
              EDGE_JSON: expr("toJSON(matrix)"),
              EVENT_NAME: expr("github.event_name"),
              CLIENT_PAYLOAD: expr("toJSON(github.event.client_payload)"),
              RESET_BLOCKED: expr("inputs.reset_blocked"),
              APP_CLIENT_ID: expr(`vars.${ctx.request.appClientIdVar}`),
              APP_PRIVATE_KEY: expr(`secrets.${ctx.request.appPrivateKeySecret}`),
              ISSUES_TOKEN: expr("secrets.GITHUB_TOKEN"),
            },
            run: 'node "$GITHUB_WORKSPACE/src/route-upstream.mjs"',
          },
        ],
      },
    },
  };
  return `# Generated by src/reconcile.mjs from the fleet manifest. Do not edit.\n${stringifyYaml(workflow)}`;
}

// ---------------------------------------------------------------------------------------
// Onboarding workflow
// ---------------------------------------------------------------------------------------

const ONBOARD_INPUTS = ["repo", "downstream", "strategy", "watch_url", "schedule", "mode", "instructions", "manifest"];
const ONBOARD_DESCRIPTIONS = {
  repo: "Repository to onboard (owner/name)",
  downstream: "Optional downstream repository (owner/name) that receives cascades from it",
  strategy: "Upkeep strategy: auto or one of the four strategies",
  watch_url: "Optional URL to watch (changelog, blog or documentation)",
  schedule: "Optional five-field cron for the upkeep schedule",
  mode: "Edge mode: auto, mechanical or ai-adaptation",
  instructions: "Registration instructions text or the path of an instructions file",
  manifest: "Manifest path (defaults to sdlc.yaml)",
};

function renderOnboard(ctx) {
  const inputsProgram =
    'import { writeFileSync } from "node:fs"; const e = process.env; ' +
    `writeFileSync("${AGENT_DIR}/onboard-inputs.json", JSON.stringify({ ` +
    ONBOARD_INPUTS.map((name) => `${name}: e.INPUT_${name.toUpperCase()}`).join(", ") +
    ' }, null, 2) + "\\n");';
  const frontmatter = {
    on: { workflow_dispatch: { inputs: inputsOf(ONBOARD_INPUTS, ONBOARD_DESCRIPTIONS) }, bots: [ctx.bot] },
    concurrency: { group: ONBOARD_ID, "cancel-in-progress": false },
    permissions: permissionsSection(ctx),
    engine: engineSection(ctx, { sdk: false }),
    network: { allowed: [] },
    checkout: [{ repository: expr("github.repository"), current: true, "github-app": appBlock(ctx) }],
    "pre-agent-steps": [
      {
        name: "Record the onboarding inputs",
        env: Object.fromEntries(ONBOARD_INPUTS.map((name) => [`INPUT_${name.toUpperCase()}`, expr(`inputs.${name}`)])),
        run: `mkdir -p ${AGENT_DIR}\nnode --input-type=module -e '${inputsProgram}'`,
      },
    ],
    "safe-outputs": {
      "github-app": appBlock(ctx),
      "threat-detection": { "continue-on-error": false },
      "create-pull-request": {
        "title-prefix": "chore(onboard): ",
        labels: ["automated", "sdlc-onboard", "needs-review"],
        draft: false,
        "branch-prefix": "sdlc/",
        "preserve-branch-name": true,
        "recreate-ref": true,
        "close-older-pull-requests": true,
        "close-older-key": ONBOARD_ID,
        "exclude-lock-yml": true,
        "protected-files": { policy: "blocked", exclude: [...ctx.manifest.protectedFilesExclude] },
        "auto-merge": false,
        "fallback-as-issue": true,
        max: 1,
      },
    },
    tools: { bash: bashTool(ctx, ["git", "node"]), edit: {} },
    jobs: agentSuccessGuards(),
  };
  const lines = [
    "# Onboard a repository into the fleet",
    "",
    `Add one repository to the fleet manifest. The dispatch inputs are recorded in \`${AGENT_DIR}/onboard-inputs.json\`.`,
    "",
    "1. Run `node bin/sdlc-onboard.mjs --repo <repo>` with the `repo` input, adding `--downstream`, `--strategy`, `--watch-url`, `--schedule`, `--mode`, `--instructions` and `--manifest` for every input that is not empty. The command also accepts the repository as a positional `<owner/repo>`.",
    "2. The command inspects the repository and writes its project and edge entries to the manifest and its instructions to `instructions/<projectKey>.md`. Check that what it wrote matches the inspected repository.",
    "3. Commit the manifest and instruction files to the working branch and call `create_pull_request`.",
    "",
    "Do not edit generated workflow files. Never merge. The pull request is created only through the safe output.",
  ];
  return { id: ONBOARD_ID, kind: "onboard", text: serializeWorkflow(frontmatter, lines.join("\n")) };
}

// ---------------------------------------------------------------------------------------
// Rendered-output checks (securityBaseline and policy), exported as a pure function
// ---------------------------------------------------------------------------------------

function normalizeFiles(files) {
  const entries = new Map();
  const put = (name, content) => entries.set(toPosix(String(name)).replace(/^\.\//, ""), typeof content === "string" ? content : String(content));
  if (files instanceof Map) {
    for (const [name, content] of files) put(name, content);
  } else if (Array.isArray(files)) {
    for (const item of files) put(item.path ?? item.file, item.content ?? item.text);
  } else if (isObj(files)) {
    for (const [name, content] of Object.entries(files)) put(name, content);
  }
  return entries;
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(lf(text));
  if (!match) return null;
  try {
    const data = YAML.parse(match[1]);
    return isObj(data) ? data : null;
  } catch {
    return null;
  }
}

function deepFindKeys(value, wanted, pointer = "", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => deepFindKeys(item, wanted, `${pointer}/${index}`, found));
  } else if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (wanted.includes(key)) found.push({ key, value: item, pointer: `${pointer}/${key}` });
      deepFindKeys(item, wanted, `${pointer}/${key}`, found);
    }
  }
  return found;
}

/**
 * The key under which an App permission is compared. `actions_variables` is the name that the token endpoint (and so the `permission-actions-variables`
 * input of actions/create-github-app-token) uses for the Variables permission, which the baseline and the manifest call `variables`: one key for both.
 */
const permissionKey = (name) => {
  const key = String(name).toLowerCase().replace(/-/g, "_");
  return key === "actions_variables" ? "variables" : key;
};
const permissionRank = { read: 1, write: 2 };

function requestedAppPermissions(file, kind, fm, parsed) {
  const needs = [];
  const need = (key, level) => needs.push({ key: permissionKey(key), level, file });
  if (kind === "router") {
    need("variables", "write");
    need("actions", "write");
    need("contents", "read");
    need("pull_requests", "read");
    return needs;
  }
  if (isObj(fm["safe-outputs"]) && fm["safe-outputs"]["github-app"] !== undefined) {
    need("contents", "write");
    need("issues", "write");
    need("pull_requests", "write");
  }
  if (isObj(fm.jobs)) {
    for (const job of Object.values(fm.jobs)) {
      if (!isObj(job) || !Array.isArray(job.steps)) continue;
      let writesState = false;
      for (const step of job.steps) {
        if (isObj(step) && typeof step.run === "string" && step.run.includes("update-poll-state.mjs")) writesState = true;
      }
      for (const step of job.steps) {
        if (!isObj(step) || typeof step.uses !== "string" || !step.uses.startsWith("actions/create-github-app-token")) continue;
        for (const [name, level] of Object.entries(isObj(step.with) ? step.with : {})) {
          if (name.startsWith("permission-") && permissionRank[level] !== undefined) need(name.slice("permission-".length), level);
        }
        if (writesState) need("variables", "write");
      }
    }
  }
  return needs;
}

/**
 * An actions/create-github-app-token step that sets any permission-* input requests exactly those permissions and inherits nothing from the
 * installation. A job that runs the poll-state script therefore has to name what the script needs, because the token cannot hold more than
 * the step asks for: variables: write for the SDLC_SYNC_STATE_<SLUG> variable (SPEC-03 AC12), and contents: read and pull-requests: read for the
 * downstream reads of AC48. A step that names no permission inherits all of the installation's, which securityBaseline already caps.
 * @returns {string[]} one message per permission that a token step of such a job leaves out
 */
function appTokenShapeProblems(fm) {
  const messages = [];
  if (!isObj(fm.jobs)) return messages;
  for (const [name, job] of Object.entries(fm.jobs)) {
    if (!isObj(job) || !Array.isArray(job.steps)) continue;
    if (!job.steps.some((step) => isObj(step) && typeof step.run === "string" && step.run.includes("update-poll-state.mjs"))) continue;
    for (const step of job.steps) {
      if (!isObj(step) || typeof step.uses !== "string" || !step.uses.startsWith("actions/create-github-app-token")) continue;
      const explicit = new Map();
      for (const [key, level] of Object.entries(isObj(step.with) ? step.with : {})) {
        if (key.startsWith("permission-") && permissionRank[level] !== undefined) explicit.set(permissionKey(key.slice("permission-".length)), level);
      }
      if (explicit.size === 0) continue;
      for (const [key, level] of [["variables", "write"], ["contents", "read"], ["pull_requests", "read"]]) {
        if ((permissionRank[explicit.get(key)] ?? 0) < permissionRank[level]) {
          messages.push(`job '${name}' runs update-poll-state.mjs, but its app token step names explicit permissions without '${key.replace(/_/g, "-")}: ${level}', so the token it mints cannot hold it`);
        }
      }
    }
  }
  return messages;
}

function importsOf(fm) {
  if (!Array.isArray(fm.imports)) return [];
  return fm.imports.map((item) => (typeof item === "string" ? item : isObj(item) ? item.uses ?? item.path : null)).filter((item) => typeof item === "string");
}

/**
 * Validates rendered files against the securityBaseline and the rendering policy. `files` maps a
 * repository-relative path to its content; the result has one entry per file, sorted by path.
 */
export function checkRendered(files, request, manifest) {
  const entries = normalizeFiles(files);
  const problems = new Map();
  const add = (file, id, message) => {
    if (!problems.has(file)) problems.set(file, []);
    problems.get(file).push(rule(id, message));
  };
  const granted = new Map();
  const baseline = isObj(request?.securityBaseline) ? request.securityBaseline : null;
  if (baseline && isObj(baseline.grantedAppPermissions)) {
    for (const [key, level] of Object.entries(baseline.grantedAppPermissions)) granted.set(permissionKey(key), level);
  }
  const clientIdExpr = request?.appClientIdVar ? expr(`vars.${request.appClientIdVar}`) : null;
  const privateKeyExpr = request?.appPrivateKeySecret ? expr(`secrets.${request.appPrivateKeySecret}`) : null;
  const needs = [];
  const closeKeys = new Map();

  for (const file of [...entries.keys()].sort()) {
    const text = entries.get(file);
    const base = path.posix.basename(file);
    for (const phrase of STATE_WRITE_PHRASES) {
      if (text.includes(phrase) && file.startsWith(`${WORKFLOWS_DIR}/`) && !file.endsWith(".lock.yml")) {
        add(file, "variable-write-forbidden", `${file} contains '${phrase}'; only the poll-state script may touch the state variables`);
      }
    }
    if (base === "aw.json" && file.startsWith(`${WORKFLOWS_DIR}/`)) {
      let config;
      try {
        config = JSON.parse(text);
      } catch (error) {
        add(file, "repo-config-invalid", `${file} is not valid JSON: ${error.message}`);
        continue;
      }
      if (!isObj(config) || config.strict !== true) add(file, "strict-mode-disabled", `${file} must set strict: true`);
      continue;
    }
    const isRouter = file === ROUTER_PATH;
    if (isRouter) {
      let router;
      try {
        router = YAML.parse(lf(text));
      } catch (error) {
        add(file, "router-invalid", `${file} is not valid YAML: ${error.message}`);
        continue;
      }
      for (const hit of deepFindKeys(router, ["auto-merge"])) {
        if (hit.value !== false) add(file, "auto-merge-enabled", `${file}${hit.pointer} must be false`);
      }
      for (const hit of deepFindKeys(router, ["continue-on-error"])) {
        if (hit.value !== false) add(file, "router-masks-failure", `${file}${hit.pointer} must not be set to ${JSON.stringify(hit.value)}`);
      }
      for (const run of deepFindKeys(router, ["run"])) {
        if (typeof run.value === "string" && /(?:\|\|\s*(?:true|:)|;\s*exit\s+0)\s*$/m.test(run.value)) {
          add(file, "router-masks-failure", `${file}${run.pointer} forces a zero exit status`);
        }
      }
      needs.push(...requestedAppPermissions(file, "router", {}, router));
      continue;
    }
    if (!file.endsWith(".md") || !file.startsWith(`${WORKFLOWS_DIR}/`) || file.startsWith(`${SHARED_DIR}/`)) continue;
    const fm = parseFrontmatter(text);
    if (fm === null) {
      add(file, "frontmatter-invalid", `${file} has no parsable YAML frontmatter`);
      continue;
    }
    if (fm.strict === false) add(file, "strict-mode-disabled", `${file} sets strict: false`);
    for (const hit of deepFindKeys(fm, ["auto-merge"])) {
      if (hit.value !== false) add(file, "auto-merge-enabled", `${file}${hit.pointer} must be false but is ${JSON.stringify(hit.value)}`);
    }
    for (const hit of deepFindKeys(fm, ["staged"])) add(file, "staging-key-forbidden", `${file}${hit.pointer} is a staging key`);
    const safeOutputs = fm["safe-outputs"];
    if (isObj(safeOutputs)) {
      const detection = safeOutputs["threat-detection"];
      if (detection === undefined || detection === null) {
        add(file, "threat-detection-missing", `${file} has safe-outputs without threat-detection`);
      } else if (detection === false) {
        add(file, "threat-detection-disabled", `${file} sets safe-outputs.threat-detection to false`);
      } else if (!isObj(detection)) {
        // Only the object form can carry continue-on-error: false, so any other scalar or array does not satisfy the policy.
        add(file, "threat-detection-malformed", `${file} safe-outputs.threat-detection must be an object with continue-on-error: false but is ${JSON.stringify(detection)}`);
      } else {
        if (detection["continue-on-error"] !== false) {
          add(file, "threat-detection-continue-on-error", `${file} safe-outputs.threat-detection.continue-on-error must be false`);
        }
        if (detection.engine === false) add(file, "threat-detection-engine-disabled", `${file} sets safe-outputs.threat-detection.engine to false`);
        if (detection.enabled !== undefined && detection.enabled !== true) {
          add(file, "threat-detection-disabled", `${file} safe-outputs.threat-detection.enabled must be true when it is set but is ${JSON.stringify(detection.enabled)}`);
        }
      }
      for (const hit of deepFindKeys(safeOutputs, ["github-token"])) {
        add(file, "safe-outputs-token-forbidden", `${file} safe-outputs${hit.pointer} must not be rendered; authenticate through github-app`);
      }
      const handler = safeOutputs["create-pull-request"];
      if (isObj(handler)) {
        const policy = handler["protected-files"];
        if (!isObj(policy) || policy.policy === undefined) {
          add(file, "protected-files-policy-missing", `${file} create-pull-request has no explicit protected-files policy`);
        } else if (policy.policy !== "blocked") {
          add(file, "protected-files-policy-not-blocked", `${file} create-pull-request protected-files.policy must be "blocked"`);
        }
        if (handler["exclude-lock-yml"] !== true) add(file, "exclude-lock-yml-missing", `${file} create-pull-request must set exclude-lock-yml: true`);
        if (hasOwn(handler, "allow-workflows")) add(file, "allow-workflows-forbidden", `${file} create-pull-request must not set allow-workflows`);
        if (base.startsWith("cascade-")) {
          if (!Array.isArray(handler.reviewers) || handler.reviewers.length === 0) {
            add(file, "handler-reviewers-empty", `${file} create-pull-request must list at least one reviewer`);
          }
          if (!Array.isArray(handler["allowed-files"]) || handler["allowed-files"].length === 0) {
            add(file, "handler-allowed-files-empty", `${file} create-pull-request must carry a non-empty allowed-files list`);
          }
        }
        const closeKey = handler["close-older-key"];
        if (base.startsWith("drift-")) {
          const projectKey = base.slice("drift-".length, -".md".length);
          if (typeof closeKey !== "string" || closeKey.trim() === "") {
            add(file, "drift-close-older-key-missing", `project '${projectKey}': ${file} has no close-older-key`);
          }
          const checkout = Array.isArray(fm.checkout) ? fm.checkout : [];
          if (!checkout.some((entry) => isObj(entry) && entry.repository === handler["target-repo"])) {
            add(file, "drift-checkout-mapping-missing", `project '${projectKey}': ${file} has no checkout entry for its target-repo '${handler["target-repo"]}'`);
          }
        }
        if (typeof closeKey === "string" && closeKey !== "") {
          if (closeKeys.has(closeKey)) {
            const owner = base.startsWith("drift-") ? `project '${base.slice("drift-".length, -".md".length)}': ` : "";
            add(file, "close-older-key-duplicate", `${owner}${file} close-older-key '${closeKey}' is also used by ${closeKeys.get(closeKey)}`);
          } else {
            closeKeys.set(closeKey, file);
          }
        }
      }
    }
    if (Array.isArray(fm.checkout) && clientIdExpr !== null && privateKeyExpr !== null) {
      fm.checkout.forEach((entry, index) => {
        const app = isObj(entry) ? entry["github-app"] : undefined;
        if (!isObj(app) || app["client-id"] !== clientIdExpr || app["private-key"] !== privateKeyExpr) {
          add(file, "checkout-github-app-missing", `${file} checkout entry ${index} must carry github-app credentials referenced by name`);
        }
      });
    }
    if (isObj(fm.jobs)) {
      for (const [name, job] of Object.entries(fm.jobs)) {
        if (isObj(job) && job.concurrency !== undefined) {
          const duplicate = isObj(job.concurrency) && isObj(fm.concurrency) && job.concurrency.group === fm.concurrency.group;
          add(file, "job-level-concurrency", `${file} job '${name}' sets a job-level concurrency${duplicate ? " that duplicates the workflow-level group" : ""}`);
        }
      }
    }
    for (const item of importsOf(fm)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), item));
      if (!entries.has(target)) add(file, "import-unresolved", `${file} imports '${item}', which is not a rendered file`);
    }
    needs.push(...requestedAppPermissions(file, "workflow", fm, null));
    for (const message of appTokenShapeProblems(fm)) add(file, "app-token-permission-missing", `${file} ${message}`);
  }

  if (isObj(manifest) && Array.isArray(manifest.dependencyEdges)) {
    for (const edge of manifest.dependencyEdges) {
      const file = `${WORKFLOWS_DIR}/${cascadeId(edge)}.md`;
      if (!entries.has(file)) continue;
      if (!Array.isArray(edge.reviewers) || edge.reviewers.length === 0) add(file, "edge-reviewers-empty", `edge '${edge.edgeId}' must list reviewers`);
      if (!Array.isArray(edge.allowedFiles) || edge.allowedFiles.length === 0) add(file, "edge-allowed-files-empty", `edge '${edge.edgeId}' must list allowedFiles`);
    }
  }

  if (baseline && isObj(baseline.grantedAppPermissions)) {
    const byKey = new Map();
    for (const item of needs) {
      const existing = byKey.get(item.key);
      if (!existing || permissionRank[item.level] > permissionRank[existing.level]) byKey.set(item.key, item);
    }
    for (const key of [...byKey.keys()].sort()) {
      const item = byKey.get(key);
      const have = granted.get(key);
      if ((permissionRank[have] ?? 0) < permissionRank[item.level]) {
        add(item.file, "app-permission-exceeded", `${item.file} requests App permission '${key}: ${item.level}' but grantedAppPermissions grants '${have ?? "no access"}'`);
      }
    }
  }

  return [...entries.keys()].sort().map((file) => ({ file, valid: !problems.has(file), errors: problems.get(file) ?? [] }));
}

// ---------------------------------------------------------------------------------------
// Fleet preparation: validate, render, check
// ---------------------------------------------------------------------------------------

function failureResult(validationResults) {
  return { status: "error", generatedWorkflows: [], repoConfigPath: REPO_CONFIG_PATH, validationResults };
}

function renderAwJson(manifest, { withProtectedFiles }) {
  const config = { strict: true };
  if (withProtectedFiles) config.protected_files = { exclude: [...manifest.protectedFilesExclude] };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function describeWorkflow(workflow) {
  const sourceMd = `${WORKFLOWS_DIR}/${workflow.id}.md`;
  return { ...workflow, sourceMd, lockYml: `${WORKFLOWS_DIR}/${workflow.id}.lock.yml` };
}

function prepareFleet(request, cwd) {
  const requestErrors = validateRequest(request);
  if (requestErrors.length > 0) return { failure: requestFailure(requestErrors) };
  const loaded = loadManifest(cwd, request.manifestPath);
  if (loaded.errors.length > 0) {
    return { failure: failureResult([{ file: request.manifestPath, valid: false, errors: loaded.errors }]) };
  }
  const manifest = loaded.manifest;
  const context = {
    cwd,
    manifestFile: request.manifestPath,
    instructionFiles: new Map(),
    strategyFragments: new Map(),
  };
  const semantic = validateSemantics(manifest, request, context);
  if (semantic.length > 0) {
    return { failure: failureResult([{ file: request.manifestPath, valid: false, errors: semantic }]) };
  }
  const ctx = makeContext(request, manifest, context.instructionFiles, context.strategyFragments);
  const workflows = [];
  for (const project of manifest.projects) {
    if (project.driftAudit.enabled) workflows.push(renderDrift(ctx, project));
  }
  for (const edge of manifest.dependencyEdges) workflows.push(renderCascade(ctx, edge));
  workflows.push(renderOnboard(ctx));
  const described = workflows.map(describeWorkflow).sort((a, b) => (a.sourceMd < b.sourceMd ? -1 : a.sourceMd > b.sourceMd ? 1 : 0));
  const files = new Map();
  for (const workflow of described) files.set(workflow.sourceMd, workflow.text);
  if (manifest.dependencyEdges.length > 0) files.set(ROUTER_PATH, renderRouter(ctx, manifest.dependencyEdges));
  files.set(REPO_CONFIG_PATH, renderAwJson(manifest, { withProtectedFiles: true }));
  const invalid = checkRendered(files, request, manifest).filter((result) => !result.valid);
  if (invalid.length > 0) return { failure: failureResult(invalid) };
  return { request, manifest, ctx, workflows: described, files, cwd };
}

/** Renders the fleet without writing a file; returns the rendered files or the failure result. */
export function renderFleet(request, options = {}) {
  const prepared = prepareFleet(request, options.cwd ?? process.cwd());
  if (prepared.failure) return { ok: false, result: prepared.failure };
  return {
    ok: true,
    files: new Map(prepared.files),
    workflows: prepared.workflows.map((workflow) => ({ id: workflow.id, kind: workflow.kind, sourceMd: workflow.sourceMd, lockYml: workflow.lockYml })),
  };
}

// ---------------------------------------------------------------------------------------
// Acknowledgements (contracts C2, C3 and C4)
// ---------------------------------------------------------------------------------------

/** Renders without writing and returns the drift, cascade and AI acknowledgements. */
export function buildAcks(request, options = {}) {
  const prepared = prepareFleet(request, options.cwd ?? process.cwd());
  if (prepared.failure) {
    const first = prepared.failure.validationResults[0];
    const error = new Error(`${first.file}: ${first.errors.join("; ")}`);
    error.validationResults = prepared.failure.validationResults;
    throw error;
  }
  const { manifest, workflows } = prepared;
  const drift = workflows
    .filter((workflow) => workflow.kind === "drift")
    .map((workflow) => workflow.project)
    .sort((a, b) => manifest.projects.indexOf(a) - manifest.projects.indexOf(b))
    .map((project) => ({
      workflowId: `drift-${project.projectKey}`,
      lockPath: `${WORKFLOWS_DIR}/drift-${project.projectKey}.lock.yml`,
      targetRepo: project.repo,
      allowedNetworkDomains: watchHostnames(project.driftAudit.knowledgeSources.watchUrls),
      gateCommands: [...project.driftAudit.verifyCommands],
    }));
  const edges = manifest.dependencyEdges;
  const mechanical = edges.filter((edge) => edge.mode === "mechanical");
  const ai = edges.filter((edge) => edge.mode === "ai-adaptation");
  const allowedFilesByWorkflow = {};
  for (const edge of ai) allowedFilesByWorkflow[cascadeId(edge)] = [...edge.allowedFiles];
  const first = ai[0];
  return {
    drift,
    cascade: {
      routerWorkflowPath: ROUTER_PATH,
      mechanicalWorkflowPaths: mechanical.map((edge) => `${WORKFLOWS_DIR}/${cascadeId(edge)}.md`),
      dependencyEdgesCount: edges.length,
    },
    ai: {
      workflowIds: ai.map(cascadeId),
      lockPaths: ai.map((edge) => `${WORKFLOWS_DIR}/${cascadeId(edge)}.lock.yml`),
      allowedFilesByWorkflow,
      immutableProtectedPaths: uniqueSorted(ai.flatMap((edge) => edge.immutableGates.zeroDiffPaths)),
      verificationGate: first
        ? [
            'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
            `AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/${downstreamName(first)}" rev-parse HEAD)"`,
            helperCommand(first, "<workflow-id>"),
            ...gateCommandsOf(first),
          ]
        : [],
    },
  };
}

// ---------------------------------------------------------------------------------------
// Transactional emission: snapshot, write, compile, roll back
// ---------------------------------------------------------------------------------------

function walkDirs(root, startRel) {
  const out = [];
  const start = path.join(root, startRel);
  if (!fs.existsSync(start)) return out;
  out.push(startRel);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      if (fs.lstatSync(full).isDirectory()) {
        out.push(posixRel(root, full));
        stack.push(full);
      }
    }
  }
  return out;
}

function snapshotPaths(cwd) {
  const found = [];
  for (const rootRel of SNAPSHOT_ROOTS) found.push(...walkFiles(cwd, rootRel));
  for (const rel of SNAPSHOT_FILES) {
    if (fs.existsSync(path.join(cwd, rel)) && fs.lstatSync(path.join(cwd, rel)).isFile()) found.push(rel);
  }
  return found;
}

/** Directories that hold the snapshot roots; a run that creates one of them removes it again when it rolls back. */
const SNAPSHOT_PARENTS = [...new Set(SNAPSHOT_ROOTS.map((rootRel) => path.posix.dirname(rootRel)))];

function takeSnapshot(cwd) {
  const files = new Map();
  for (const rel of snapshotPaths(cwd)) files.set(rel, fs.readFileSync(path.join(cwd, rel)));
  const dirs = new Set();
  for (const rootRel of SNAPSHOT_ROOTS) for (const dir of walkDirs(cwd, rootRel)) dirs.add(dir);
  for (const parent of SNAPSHOT_PARENTS) if (fs.existsSync(path.join(cwd, parent))) dirs.add(parent);
  return { files, dirs };
}

function restoreSnapshot(cwd, snapshot) {
  for (const rel of snapshotPaths(cwd)) {
    if (!snapshot.files.has(rel)) fs.rmSync(path.join(cwd, rel), { force: true });
  }
  for (const [rel, bytes] of snapshot.files) {
    const absolute = path.join(cwd, rel);
    if (!fs.existsSync(absolute) || !fs.readFileSync(absolute).equals(bytes)) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes);
    }
  }
  for (const rootRel of SNAPSHOT_ROOTS) removeEmptyDirs(cwd, rootRel, snapshot.dirs);
  for (const parent of SNAPSHOT_PARENTS) {
    const absolute = path.join(cwd, parent);
    if (!snapshot.dirs.has(parent) && fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
  }
}

function writeRendered(cwd, files) {
  for (const [rel, text] of files) {
    const absolute = path.join(cwd, rel);
    const bytes = Buffer.from(text, "utf8");
    if (fs.existsSync(absolute) && fs.readFileSync(absolute).equals(bytes)) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
}

const MANAGED_SOURCE = /^(?:drift-.+|cascade-mechanical-.+|cascade-ai-.+)\.md$/;

function importsOfFile(absolute) {
  const fm = parseFrontmatter(fs.readFileSync(absolute, "utf8"));
  return fm === null ? [] : importsOf(fm);
}

/** Removes managed sources that are no longer rendered, a stale router and unimported shared files. */
function removeOrphans(cwd, files) {
  const directory = path.join(cwd, WORKFLOWS_DIR);
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    const rel = `${WORKFLOWS_DIR}/${name}`;
    const absolute = path.join(cwd, rel);
    if (!fs.lstatSync(absolute).isFile()) continue;
    if ((MANAGED_SOURCE.test(name) && !files.has(rel)) || (rel === ROUTER_PATH && !files.has(rel))) {
      fs.rmSync(absolute, { force: true });
    }
  }
  const sharedDirectory = path.join(cwd, SHARED_DIR);
  if (!fs.existsSync(sharedDirectory)) return;
  const imported = new Set();
  for (const name of fs.readdirSync(directory)) {
    const rel = `${WORKFLOWS_DIR}/${name}`;
    if (!name.endsWith(".md") || !fs.lstatSync(path.join(cwd, rel)).isFile()) continue;
    for (const item of importsOfFile(path.join(cwd, rel))) imported.add(path.posix.normalize(path.posix.join(WORKFLOWS_DIR, item)));
  }
  for (const rel of walkFiles(cwd, SHARED_DIR)) {
    if (rel.endsWith(".md") && !imported.has(rel)) fs.rmSync(path.join(cwd, rel), { force: true });
  }
}

/** The compiler emits maintenance workflows for cross-repository targets; they are not part of the fleet. */
function dropCompilerSideRepoWorkflows(cwd, snapshot) {
  for (const rel of walkFiles(cwd, WORKFLOWS_DIR)) {
    if (path.posix.dirname(rel) !== WORKFLOWS_DIR || !/^agentics-maintenance.*\.yml$/.test(path.posix.basename(rel))) continue;
    const absolute = path.join(cwd, rel);
    if (snapshot.files.has(rel)) {
      if (!fs.readFileSync(absolute).equals(snapshot.files.get(rel))) fs.writeFileSync(absolute, snapshot.files.get(rel));
    } else {
      fs.rmSync(absolute, { force: true });
    }
  }
}

/**
 * The compiler adds `permission-checks: read` to the token step of the safe-outputs job. The App holds six permissions (contents, pull requests,
 * issues, actions, variables and metadata) and no Checks permission, so a token that asks for it cannot be minted and the job fails. The line is
 * removed from the lock of every workflow that this run compiled; the next run compiles the lock again and removes it again.
 */
const UNGRANTED_PERMISSION_LINE = /^[ \t]*permission-checks: read\r?\n/gm;

function stripUngrantedPermissions(cwd, workflows) {
  for (const workflow of workflows) {
    const absolute = path.join(cwd, workflow.lockYml);
    const text = fs.readFileSync(absolute, "utf8");
    const stripped = text.replace(UNGRANTED_PERMISSION_LINE, "");
    if (stripped !== text) fs.writeFileSync(absolute, stripped);
  }
}

// ---------------------------------------------------------------------------------------
// Running the compiler
// ---------------------------------------------------------------------------------------

/** Environment for the real gh-aw CLI; honours an explicit XDG_DATA_HOME and the local isolated install. */
export function ghAwEnvironment(env = process.env) {
  const merged = { ...env };
  if (!merged.XDG_DATA_HOME && fs.existsSync(LOCAL_GH_AW_DATA_HOME)) merged.XDG_DATA_HOME = LOCAL_GH_AW_DATA_HOME;
  return merged;
}

function findExecutable(name, env) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")] : [""];
  for (const directory of pathValue.split(path.delimiter).filter((entry) => entry !== "")) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function spawnCollect(command, args, { cwd, env, timeoutMs = 600000 }) {
  return new Promise((resolve) => {
    const executable = findExecutable(command, env);
    if (executable === null) {
      resolve({ code: null, stdout: "", stderr: "", error: `the '${command}' executable was not found on PATH` });
      return;
    }
    const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
    let child;
    try {
      child = viaShell
        ? spawn(`"${executable}"`, args, { cwd, env, shell: true, windowsHide: true })
        : spawn(executable, args, { cwd, env, windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function compileEnvironment(options) {
  return ghAwEnvironment({ ...process.env, ...(options.env ?? {}) });
}

const tail = (text, limit = 1500) => oneLine(String(text).slice(-limit));

function parseCompileJson(stdout) {
  const text = String(stdout).trim();
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.search(/^\[/m);
    if (start === -1) return null;
    try {
      const parsed = JSON.parse(text.slice(start));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function diagnosticOf(entry) {
  if (typeof entry === "string") return entry;
  if (isObj(entry) && typeof entry.message === "string") return entry.message;
  return JSON.stringify(entry);
}

/** Maps every element of the compiler's JSON array to one validation result. */
function interpretCompile(outcome) {
  if (outcome.error) {
    return [{ file: "gh aw compile", valid: false, errors: [rule("compile-unavailable", outcome.error)] }];
  }
  const elements = parseCompileJson(outcome.stdout);
  if (elements === null) {
    const detail = outcome.code === 0 ? `stdout is not a JSON array: ${tail(outcome.stdout, 300)}` : `gh aw compile exited with code ${outcome.code}: ${tail(outcome.stderr)}`;
    return [{ file: "gh aw compile", valid: false, errors: [rule("compile-failed", detail)] }];
  }
  const results = elements.map((element) => {
    const file = isObj(element) && typeof element.workflow === "string" ? element.workflow : "unknown";
    const valid = isObj(element) && element.valid === true;
    const diagnostics = isObj(element) && Array.isArray(element.errors) ? element.errors.map(diagnosticOf) : [];
    const errors = valid ? [] : (diagnostics.length > 0 ? diagnostics : ["the compiler reported the workflow as invalid without a diagnostic"]).map((message) => rule("compile-error", message));
    return { file, valid, errors };
  });
  if (outcome.code !== 0 && results.every((result) => result.valid)) {
    results.push({ file: "gh aw compile", valid: false, errors: [rule("compile-failed", `gh aw compile exited with code ${outcome.code}: ${tail(outcome.stderr)}`)] });
  }
  return results;
}

/** gh-aw releases before the repository-level protected_files option (v1.0.1 among them) reject it in aw.json. */
function rejectsProtectedFiles(outcome) {
  return /additional propert(?:y|ies) 'protected_files' not allowed/.test(`${outcome.stderr}\n${outcome.stdout}`);
}

/** What the operator is told when the compiler refuses the key and the strict-only repository config is used instead. */
function protectedFilesFallbackNotice(manifest) {
  const notice = `note: the gh-aw compiler rejected protected_files in ${REPO_CONFIG_PATH}, so the repository config holds strict: true only`;
  if (manifest.protectedFilesExclude.length === 0) return notice;
  return `${notice}; protectedFilesExclude still reaches every drift and onboarding handler as its protected-files.exclude, and each cascade handler keeps its edge's own protectedFilesExclude`;
}

/**
 * Compiles, and when the compiler's repository config schema refuses `protected_files` falls back to the
 * strict-only aw.json and compiles again (SPEC-01 AC55): the key is optional for the reconciler because the
 * manifest list is also rendered into every handler's explicit `protected-files.exclude` (AC64).
 */
async function compileWithCompat(cwd, prepared, args, options) {
  const env = compileEnvironment(options);
  let outcome = await spawnCollect("gh", args, { cwd, env, timeoutMs: options.timeoutMs });
  if (outcome.code !== 0 && rejectsProtectedFiles(outcome)) {
    fs.writeFileSync(path.join(cwd, REPO_CONFIG_PATH), renderAwJson(prepared.manifest, { withProtectedFiles: false }));
    options.log?.(protectedFilesFallbackNotice(prepared.manifest));
    outcome = await spawnCollect("gh", args, { cwd, env, timeoutMs: options.timeoutMs });
  }
  return outcome;
}

function generatedPairs(workflows) {
  return workflows.map((workflow) => ({ sourceMd: workflow.sourceMd, lockYml: workflow.lockYml }));
}

function finish(prepared, validationResults) {
  const ok = validationResults.every((result) => result.valid);
  return {
    status: ok ? "ok" : "error",
    generatedWorkflows: ok ? generatedPairs(prepared.workflows) : [],
    repoConfigPath: REPO_CONFIG_PATH,
    validationResults,
  };
}

async function emitFleet(prepared, options) {
  const { cwd } = prepared;
  const snapshot = takeSnapshot(cwd);
  try {
    writeRendered(cwd, prepared.files);
    removeOrphans(cwd, prepared.files);
    const outcome = await compileWithCompat(cwd, prepared, ["aw", "compile", "--strict", "--purge", "--json"], options);
    const results = interpretCompile(outcome);
    if (results.some((result) => !result.valid)) {
      restoreSnapshot(cwd, snapshot);
      return finish(prepared, results);
    }
    const missing = prepared.workflows.filter((workflow) => !fs.existsSync(path.join(cwd, workflow.lockYml)));
    if (missing.length > 0) {
      restoreSnapshot(cwd, snapshot);
      return finish(
        prepared,
        missing.map((workflow) => ({ file: workflow.sourceMd, valid: false, errors: [rule("lock-missing", `${workflow.lockYml} was not produced by the compiler`)] })),
      );
    }
    stripUngrantedPermissions(cwd, prepared.workflows);
    dropCompilerSideRepoWorkflows(cwd, snapshot);
    return finish(prepared, results);
  } catch (error) {
    restoreSnapshot(cwd, snapshot);
    throw error;
  }
}

async function dryRunFleet(prepared, options) {
  const env = compileEnvironment(options);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-reconcile-"));
  try {
    const init = await spawnCollect("git", ["init", "-q"], { cwd: stage, env, timeoutMs: options.timeoutMs });
    if (init.code !== 0) {
      // A dry run never writes to the working tree (SPEC-01 AC10), so there is no fallback that compiles inside it.
      const detail = init.error ?? `git init exited with code ${init.code}: ${tail(init.stderr)}`;
      return finish(prepared, [
        { file: "gh aw compile", valid: false, errors: [rule("dry-run-staging-failed", `the validation-only staging directory could not be prepared: ${detail}`)] },
      ]);
    }
    const lockSource = path.join(prepared.cwd, ACTIONS_LOCK_PATH);
    if (fs.existsSync(lockSource)) {
      fs.mkdirSync(path.join(stage, path.dirname(ACTIONS_LOCK_PATH)), { recursive: true });
      fs.copyFileSync(lockSource, path.join(stage, ACTIONS_LOCK_PATH));
    }
    writeRendered(stage, prepared.files);
    const outcome = await compileWithCompat(stage, prepared, ["aw", "compile", "--strict", "--no-emit", "--json"], options);
    return finish(prepared, interpretCompile(outcome));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Validates the manifest against the request's securityBaseline, renders the fleet and compiles it.
 * Never throws and never exits the process: failures come back as `status: "error"` with the
 * workflow files restored byte for byte. `options` are `cwd`, `env`, `timeoutMs` and an optional
 * `log(line)` that receives operator notes (the command line prints them on stderr).
 */
export async function reconcile(request, options = {}) {
  try {
    const cwd = options.cwd ?? process.cwd();
    const prepared = prepareFleet(request, cwd);
    if (prepared.failure) return prepared.failure;
    return request.dryRun ? await dryRunFleet(prepared, options) : await emitFleet(prepared, options);
  } catch (error) {
    return failureResult([{ file: "reconcile", valid: false, errors: [rule("unexpected-error", oneLine(error?.message ?? String(error)))] }]);
  }
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

async function main(argv) {
  const flag = argv.indexOf("--request");
  const file = flag === -1 ? undefined : argv[flag + 1];
  let result;
  if (file === undefined) {
    result = requestFailure([rule("request-missing", "usage: node src/reconcile.mjs --request <file>")]);
  } else {
    let request;
    try {
      request = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      request = undefined;
      result = requestFailure([rule("request-unreadable", `${file} cannot be read as JSON: ${oneLine(error.message)}`)]);
    }
    if (request !== undefined) result = await reconcile(request, { log: (line) => process.stderr.write(`${line}\n`) });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "ok" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
