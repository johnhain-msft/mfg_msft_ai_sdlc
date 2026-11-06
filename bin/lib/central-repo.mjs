// The central orchestrator repository is never a literal in the code: it is `<owner>/<repo>` of the
// `origin` remote of the working copy that holds --manifest (AC4).
//
//   node bin/lib/central-repo.mjs [manifest]   prints <owner>/<repo>, exits non-zero without an origin

import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SdlcError } from "./errors.mjs";
import { REPO_SLUG, splitSlug } from "./validators.mjs";

/** Removes credentials from a remote URL so that it can appear in a diagnostic. */
export const redactUrl = (url) => String(url).replace(/\/\/[^/@\s]*@/, "//");

/** `owner/repo` of a git remote URL (https, ssh, scp-like); null when it names no GitHub-style repository. */
export function parseRemoteUrl(url) {
  const text = String(url).trim();
  let repoPath = null;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(text);
  if (scp) {
    repoPath = scp[1];
  } else {
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "file:") repoPath = decodeURIComponent(parsed.pathname);
    } catch {
      repoPath = null;
    }
  }
  if (repoPath === null) return null;
  const segments = repoPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (segments.length < 2) return null;
  const slug = segments.slice(-2).join("/");
  return REPO_SLUG.test(slug) ? slug : null;
}

function git(directory, args, env) {
  return spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * @param {string} manifestPath path of --manifest (absolute or relative to `cwd`)
 * @param {{ cwd?: string, env?: object }} [options]
 * @returns {{ slug: string, owner: string, repo: string, workingCopy: string, manifestPath: string }}
 * @throws {SdlcError} when the manifest is not in a git working copy or the working copy has no origin
 */
export function resolveCentralRepo(manifestPath, options = {}) {
  const absolute = path.resolve(options.cwd ?? process.cwd(), manifestPath);
  const directory = path.dirname(absolute);
  const top = git(directory, ["rev-parse", "--show-toplevel"], options.env);
  if (top.error || top.status !== 0) {
    throw new SdlcError(
      `${manifestPath} is not inside a git working copy, so the central orchestrator repository cannot be resolved from its origin remote`,
      { code: "central-repo" },
    );
  }
  const origin = git(directory, ["remote", "get-url", "origin"], options.env);
  if (origin.error || origin.status !== 0 || origin.stdout.trim() === "") {
    throw new SdlcError(
      `the working copy that holds ${manifestPath} has no 'origin' remote; the central orchestrator repository is resolved as <owner>/<repo> from it`,
      { code: "central-repo" },
    );
  }
  const url = origin.stdout.trim();
  const slug = parseRemoteUrl(url);
  if (slug === null) {
    throw new SdlcError(`the origin remote (${redactUrl(url)}) does not name an <owner>/<repo> repository`, { code: "central-repo" });
  }
  return { slug, ...splitSlug(slug), workingCopy: path.resolve(top.stdout.trim()), manifestPath: absolute };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${resolveCentralRepo(process.argv[2] ?? "sdlc.yaml").slug}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
