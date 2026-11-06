// Read-only inspection of an onboarding target (AC45): a local path or <owner>/<repo> through GET requests only.
// The target is never modified and no script of it is ever run. The inspection collects the language manifests,
// the workflow files (which of them declare a schedule trigger), the test and build scripts of the root package.json,
// the provenance files and the owners of .github/CODEOWNERS.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { individualOwners, parseCodeowners } from "./codeowners.mjs";
import { SdlcError } from "./errors.mjs";
import { parseRemoteUrl } from "./central-repo.mjs";
import { isRepoSlug, splitSlug } from "./validators.mjs";

export const PROVENANCE_NAMES = Object.freeze(["source.json", "lab-sources.json", "provenance.json", "registry.yaml"]);
export const MANIFEST_NAMES = Object.freeze([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
]);
const MANIFEST_EXTENSIONS = [".csproj", ".fsproj", ".vbproj"];
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox"]);
const MAX_FILES = 20000;
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const NPM_PLACEHOLDER_TEST = /no test specified/i;

const basename = (file) => file.slice(file.lastIndexOf("/") + 1);

/** A reader over a local directory: { list(): string[], read(path): Promise<string|null> }. Files are read, never written. */
export function localReader(directory) {
  const files = [];
  const walk = (relative, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(next, depth + 1);
      } else if (entry.isFile()) {
        files.push(next);
      }
    }
  };
  walk("", 0);
  return {
    list: () => files,
    async read(file) {
      try {
        const absolute = path.join(directory, ...file.split("/"));
        if (fs.statSync(absolute).size > MAX_FILE_BYTES) return null;
        return fs.readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** A reader over a repository on GitHub through read-only GET requests. */
export async function remoteReader({ api, slug, ref }) {
  const { owner, repo } = splitSlug(slug);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const tree = await api.request("GET", `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.status !== 200 || !Array.isArray(tree.json?.tree)) {
    throw new SdlcError(`GET ${base}/git/trees/${ref} answered ${tree.status}: the file list of ${slug} could not be read`, { code: "inspect" });
  }
  const files = tree.json.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
  return {
    truncated: tree.json.truncated === true,
    list: () => files,
    async read(file) {
      const encoded = file.split("/").map(encodeURIComponent).join("/");
      const response = await api.request("GET", `${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { accept: "application/vnd.github.raw+json" });
      if (response.status !== 200) return null;
      return response.text.length > MAX_FILE_BYTES ? null : response.text;
    },
  };
}

/** { repo, defaultBranch, headSha } of a remote repository (GET /repos/{owner}/{repo} and its default-branch commit). */
export async function remoteIdentity({ api, slug }) {
  const { owner, repo } = splitSlug(slug);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const info = await api.request("GET", base);
  if (info.status === 404) throw new SdlcError(`the repository ${slug} was not found or is not readable with the current credentials`, { code: "inspect" });
  if (info.status !== 200 || typeof info.json?.default_branch !== "string") {
    throw new SdlcError(`GET ${base} answered ${info.status}${typeof info.json?.message === "string" ? ` (${info.json.message})` : ""}`, { code: "inspect" });
  }
  const defaultBranch = info.json.default_branch;
  const commit = await api.request("GET", `${base}/commits/${encodeURIComponent(defaultBranch)}`);
  const headSha = commit.status === 200 && SHA.test(String(commit.json?.sha ?? "")) ? commit.json.sha : null;
  return { repo: typeof info.json.full_name === "string" ? info.json.full_name : slug, defaultBranch, headSha };
}

function git(directory, args) {
  const outcome = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return outcome.status === 0 ? outcome.stdout.trim() : null;
}

/** { repo, defaultBranch, headSha } of a local checkout, from its origin remote and its default branch. */
export function localIdentity(directory) {
  const origin = git(directory, ["remote", "get-url", "origin"]);
  const repo = origin === null ? null : parseRemoteUrl(origin);
  if (repo === null) {
    throw new SdlcError(
      `${directory} has no origin remote that names an <owner>/<repo> repository, so its repository cannot be determined; pass <owner/repo> instead of the path`,
      { code: "inspect" },
    );
  }
  const remoteHead = git(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = remoteHead?.replace(/^origin\//, "") ?? git(directory, ["symbolic-ref", "--short", "HEAD"]);
  if (!defaultBranch) throw new SdlcError(`the default branch of ${directory} cannot be determined`, { code: "inspect" });
  const headSha = [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`, "HEAD"].map((ref) => git(directory, ["rev-parse", "--verify", "-q", ref])).find((sha) => sha && SHA.test(sha)) ?? null;
  return { repo, defaultBranch, headSha };
}

/** The first 40-hex `commit` value of a JSON document and its JSON Pointer, shallowest first; null when there is none. */
export function findCommitPointer(value) {
  const queue = [{ node: value, pointer: "" }];
  while (queue.length > 0) {
    const { node, pointer } = queue.shift();
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    if (typeof node.commit === "string" && SHA.test(node.commit)) return { commit: node.commit, pointer: `${pointer}/commit` };
    for (const [key, child] of Object.entries(node)) {
      queue.push({ node: child, pointer: `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` });
    }
  }
  return null;
}

function declaresSchedule(text, file) {
  let document;
  try {
    const source = file.endsWith(".md") ? (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "") : text;
    document = YAML.parse(source, { maxAliasCount: 100 });
  } catch {
    return false;
  }
  const on = document?.on ?? document?.true;
  if (typeof on === "string") return on === "schedule";
  if (Array.isArray(on)) return on.includes("schedule");
  return on !== null && typeof on === "object" && "schedule" in on;
}

/**
 * @param {{ list(): string[], read(path: string): Promise<string|null> }} reader
 * @param {{ repo: string, defaultBranch: string, headSha: string|null }} identity
 */
export async function inspectRepository(reader, identity) {
  const files = reader.list();
  const warnings = [];
  const packageManifests = files
    .filter((file) => MANIFEST_NAMES.includes(basename(file)) || MANIFEST_EXTENSIONS.some((extension) => file.endsWith(extension)))
    .sort();

  let scriptNames = [];
  const rootPackage = files.includes("package.json") ? await reader.read("package.json") : null;
  if (rootPackage !== null) {
    try {
      const parsed = JSON.parse(rootPackage);
      if (parsed?.scripts && typeof parsed.scripts === "object") {
        scriptNames = Object.keys(parsed.scripts).filter((name) => typeof parsed.scripts[name] === "string" && !(name === "test" && NPM_PLACEHOLDER_TEST.test(parsed.scripts[name])));
        if (typeof parsed.scripts.test === "string" && NPM_PLACEHOLDER_TEST.test(parsed.scripts.test)) warnings.push("package.json has only the placeholder test script of npm init, which is not treated as a test script");
      }
    } catch {
      warnings.push("package.json is not valid JSON; no script was read from it");
    }
  }
  const buildCommands = scriptNames.includes("build") ? ["npm run build"] : [];
  const verifyCommands = scriptNames.includes("test") ? ["npm test"] : [];
  if (verifyCommands.length === 0) {
    warnings.push(
      rootPackage === null
        ? "the repository has no package.json at its root, so verifyCommands is empty (S5 never invents a command); a drift-enabled project needs at least one verify command in sdlc.yaml"
        : "package.json has no test script, so verifyCommands is empty (S5 never invents a command); a drift-enabled project needs at least one verify command in sdlc.yaml",
    );
  }

  const workflows = [];
  for (const file of files.filter((candidate) => /^\.github\/workflows\/[^/]+\.(?:ya?ml|md)$/.test(candidate)).sort()) {
    const text = await reader.read(file);
    workflows.push({ path: file, scheduled: text !== null && declaresSchedule(text, file) });
  }

  const provenanceFiles = [];
  for (const file of files.filter((candidate) => PROVENANCE_NAMES.includes(basename(candidate))).sort()) {
    let pointer = null;
    let commit = null;
    if (file.endsWith(".json")) {
      const text = await reader.read(file);
      try {
        const found = text === null ? null : findCommitPointer(JSON.parse(text));
        if (found) {
          commit = found.commit;
          pointer = found.pointer;
        }
      } catch {
        warnings.push(`${file} is not valid JSON`);
      }
    }
    provenanceFiles.push({ path: file, commit, pointer });
  }

  const codeownersText = files.includes(".github/CODEOWNERS") ? await reader.read(".github/CODEOWNERS") : null;
  const codeowners =
    codeownersText === null
      ? { present: false, individuals: [], teams: [] }
      : { present: true, individuals: individualOwners(codeownersText), teams: parseCodeowners(codeownersText).teams };

  return {
    repo: identity.repo,
    defaultBranch: identity.defaultBranch,
    headSha: identity.headSha ?? null,
    packageManifests,
    scriptNames,
    buildCommands,
    verifyCommands,
    importScripts: scriptNames.filter((name) => name.startsWith("import:")),
    workflows,
    provenanceFiles,
    codeowners,
    warnings,
  };
}

/** Whether a --repo value names a repository (<owner>/<repo>) rather than an existing local path. */
export function classifyTarget(value, cwd) {
  const asPath = path.resolve(cwd, value);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return { kind: "local", directory: asPath };
  if (isRepoSlug(value)) return { kind: "remote", slug: value };
  throw new SdlcError(`--repo '${value}' is neither an existing directory nor an <owner>/<repo> repository`, { code: "inspect" });
}
