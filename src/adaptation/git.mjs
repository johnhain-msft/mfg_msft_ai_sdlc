// Git, as the verification of the AI adaptation helpers uses it: read-only, without a shell, without a pager and without a prompt.
//
// Every function takes the working directory of the repository (the downstream checkout) and a list of arguments, never a command line, so that a path
// or a revision from the agent's side can only ever be an argument. Nothing here writes to the repository.

import { spawnSync } from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

/** A git command that failed or could not run: the helper that called it exits 2, because the answer it needs is not there. */
export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitError";
  }
}

function git(repository, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repository, "--no-pager", ...args], {
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" },
  });
  if (result.error) throw new GitError(`git ${args[0]} could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new GitError(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.toString("utf8").trim().split("\n")[0]}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lines = (buffer) => buffer.toString("utf8").split("\0").filter((entry) => entry !== "");

/** True when `directory` is inside a git work tree. */
export const isWorkTree = (directory) => git(directory, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true }).status === 0;

/** True when `revision` names a commit of the repository. */
export const isCommit = (repository, revision) => git(repository, ["cat-file", "-e", `${revision}^{commit}`], { allowFailure: true }).status === 0;

/** The full id of HEAD. */
export const headCommit = (repository) => git(repository, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim();

/** The root of the work tree that `directory` is in. */
export const topLevel = (directory) => git(directory, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim();

/** The text of `file` at `revision`, or null when the revision has no such file. The bytes are decoded as UTF-8. */
export function showFile(repository, revision, file) {
  const result = git(repository, ["show", `${revision}:${file}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.toString("utf8") : null;
}

/** The paths that differ between two revisions (renames reported as a deletion and an addition), sorted. */
export const changedBetween = (repository, from, to) => lines(git(repository, ["diff", "--name-only", "-z", "--no-renames", from, to, "--"]).stdout).sort();

/** The tracked paths whose working tree or index differs from `revision`, sorted. */
export const changedInWorkTree = (repository, revision) => lines(git(repository, ["diff", "--name-only", "-z", "--no-renames", revision, "--"]).stdout).sort();

/** The paths that git does not track and does not ignore, sorted. */
export const untrackedPaths = (repository) => lines(git(repository, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout).sort();
