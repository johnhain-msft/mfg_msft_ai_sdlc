// The part of the fleet manifest that the snapshot script needs: the watched URLs and the package manifest patterns of one
// project's driftAudit.knowledgeSources. The manifest was validated against schemas/sdlc.schema.json when it was
// reconciled; this reader checks again what it relies on, so that a damaged file stops the run instead of changing it.

import nodeFs from "node:fs";
import { assertRelativePattern } from "./glob.mjs";
import { loadYaml } from "./yaml-load.mjs";

const KINDS = new Set(["changelog", "blog", "docs", "release-notes", "feed"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A watched URL: http(s), a literal host (no wildcard) and no credentials. */
export function assertWatchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the watched URL '${url}' is not a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`the watched URL '${url}' is not an http(s) URL`);
  if (url.includes("*") || parsed.hostname.includes("*")) throw new Error(`the watched URL '${url}' contains a wildcard`);
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`the watched URL '${url}' carries credentials`);
  return parsed.href;
}

/**
 * @returns {Promise<{ projectKey: string, repo: string, watchUrls: { url: string, label: string, kind: string }[], packageManifests: string[] }>}
 */
export async function readProjectSources({ manifestPath, projectKey, fs = nodeFs, parser = "auto" }) {
  let text;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`the manifest '${manifestPath}' cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = await loadYaml(text, { parser });
  } catch (error) {
    throw new Error(`the manifest '${manifestPath}' cannot be parsed: ${error.message}`);
  }
  if (!isObject(document) || !Array.isArray(document.projects)) throw new Error(`the manifest '${manifestPath}' has no projects list`);
  const matches = document.projects.filter((project) => isObject(project) && project.projectKey === projectKey);
  if (matches.length === 0) throw new Error(`the manifest '${manifestPath}' has no project '${projectKey}'`);
  if (matches.length > 1) throw new Error(`the manifest '${manifestPath}' lists the project '${projectKey}' more than once`);
  const project = matches[0];
  const audit = project.driftAudit;
  if (!isObject(audit)) throw new Error(`the project '${projectKey}' has no driftAudit block`);
  const sources = isObject(audit.knowledgeSources) ? audit.knowledgeSources : {};
  const urls = sources.watchUrls ?? [];
  const patterns = sources.packageManifests ?? [];
  if (!Array.isArray(urls)) throw new Error(`knowledgeSources.watchUrls of '${projectKey}' is not a list`);
  if (!Array.isArray(patterns)) throw new Error(`knowledgeSources.packageManifests of '${projectKey}' is not a list`);
  const watchUrls = urls.map((entry, position) => {
    if (!isObject(entry) || typeof entry.url !== "string") throw new Error(`watchUrls[${position}] of '${projectKey}' has no url`);
    assertWatchUrl(entry.url);
    const label = typeof entry.label === "string" ? entry.label : entry.url;
    const kind = typeof entry.kind === "string" ? entry.kind : "docs";
    if (!KINDS.has(kind)) throw new Error(`watchUrls[${position}] of '${projectKey}' has the unknown kind '${kind}'`);
    return { url: entry.url, label, kind };
  });
  const packageManifests = patterns.map((pattern) => {
    if (typeof pattern !== "string") throw new Error(`a packageManifests entry of '${projectKey}' is not a string`);
    return assertRelativePattern(pattern);
  });
  return { projectKey, repo: typeof project.repo === "string" ? project.repo : "", watchUrls, packageManifests };
}
