// What the agent step leaves behind that a pull request can be made of (SPEC-02 AC22, AC23).
//
// The agent has `git` with any arguments and the `write` tool, in the target checkout and under /tmp/gh-aw, so the state in which it leaves
// the checkout (HEAD, the index, the working tree) is not what the pull request carries. `create_pull_request` (gh-aw v1.0.1) writes
// /tmp/gh-aw/aw-<branch>.patch (the output of `git format-patch`) and, when a bundle is wanted, /tmp/gh-aw/aw-<branch>.bundle during the agent
// step; the safe_outputs job applies those files (`git am --3way`, or a fetch from the bundle) whatever HEAD is by then. An agent that
// commits a forbidden change on a branch, calls the tool and runs `git switch <base branch>` leaves a HEAD that equals the base commit and a
// patch that still carries the change.
//
// This module finds every revision that could be turned into a pull request, and reads each one as git objects:
//  - the commits of the checkout that are not reachable from the base commit, from any ref and from HEAD (not only from HEAD);
//  - the patch files, by applying each message of a file in turn to the base commit in a scratch repository, the way `git am` does it
//    (`git mailsplit`, `git mailinfo`, `git apply`), which gives one tree per message;
//  - the bundle files, by unbundling them into the same scratch repository, which gives the commits that they carry.
// The scratch repository lives in a temporary directory, borrows the objects of the checkout (an alternates file) and is removed afterwards; the
// checkout itself is only read. Nothing here knows what the lab validator looks for: callers decide what a revision may or may not contain.
//
// Every git call runs with --no-replace-objects, so that a replace ref (which the agent can create) never changes what an object is.

import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** More commits than this ahead of the base commit are refused: they cannot be read one by one in a reasonable time. */
export const COMMIT_LIMIT = 2000;
/** A patch or a bundle larger than this is refused (gh-aw itself limits a patch to 4 MiB by default). */
export const FILE_LIMIT_BYTES = 64 * 1024 * 1024;
/** The names that the artifact upload of the agent job collects from the directory above the artifact directory (aw-*.patch, aw-*.bundle). */
export const TRANSPORT_FILE = /^aw-.*\.(patch|bundle)$/;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

/**
 * git, as every check of the validator uses it. The checkout is the agent's workspace and the agent can write its .git directory, so no call
 * trusts a replace ref: --no-replace-objects (and GIT_NO_REPLACE_OBJECTS, for a git that git itself starts) makes a read of an object return
 * that object, where `git replace <base> HEAD` would make a read of the base commit return the agent's own commit.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string | Buffer }} [options]
 */
export function git(args, { cwd, env, input } = {}) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

/** The first line of what git said, for a message that names what failed: its error output, else what it printed, else the error itself. */
export const gitMessage = (error) =>
  String([error?.stderr, error?.stdout, error?.message].map((text) => String(text ?? "").trim()).find((text) => text !== "") ?? error)
    .trim()
    .split("\n")[0]
    .trim();

/** The refs that point at each commit (an annotated tag counts for the commit that it names), as { commit: [refname, ...] }. */
export function refsByCommit(options) {
  const byCommit = new Map();
  const listed = git(["for-each-ref", "--format=%(objecttype) %(objectname) %(*objectname) %(refname)"], options);
  for (const line of listed.split(/\r?\n/)) {
    if (line === "") continue;
    const [type, name, peeled, ...rest] = line.split(" ");
    const commit = type === "commit" ? name : type === "tag" && peeled !== "" ? peeled : null;
    if (commit === null) continue;
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), rest.join(" ")]);
  }
  return byCommit;
}

/** The local branches (refs/heads/) and the commit that each points at. */
export function branchTips(options) {
  const tips = new Map();
  for (const line of git(["for-each-ref", "--format=%(objecttype) %(objectname) %(refname)", "refs/heads/"], options).split(/\r?\n/)) {
    const [type, name, ...rest] = line.split(" ");
    if (type === "commit") tips.set(rest.join(" "), name);
  }
  return tips;
}

/**
 * The commits that are not reachable from the base commit but are reachable from any ref or from HEAD, or from the given tips only.
 * `rev-list` ignores a ref that names a blob or a tree, and lists a commit that only a ref other than a branch (a tag, the stash, a
 * remote-tracking ref, a replace ref) reaches, which is what a check of "every commit that is ahead of the base commit" needs.
 */
export function commitsAhead(options, baseSha, tips) {
  if (!COMMIT.test(baseSha)) throw new Error("the base commit is not a full commit id");
  if (tips !== undefined && tips.length === 0) return [];
  if (tips !== undefined && !tips.every((tip) => COMMIT.test(tip))) throw new Error("a tip is not a full commit id");
  const args = tips === undefined ? ["rev-list", "--all", "--not", baseSha] : ["rev-list", ...tips, "--not", baseSha];
  return git(args, options).split(/\r?\n/).filter((line) => line !== "");
}

/** The aw-*.patch and aw-*.bundle entries of a directory, in name order: { name, file, kind } (kind is "patch" or "bundle"). */
export function transportFiles(directory, fs) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  return names
    .filter((name) => TRANSPORT_FILE.test(name))
    .sort()
    .map((name) => ({ name, file: path.join(directory, name), kind: name.endsWith(".bundle") ? "bundle" : "patch" }));
}

/**
 * A scratch repository: a bare repository in a temporary directory whose object store is the checkout's (an alternates file), so that the base
 * commit and everything below it is readable and everything that is written (the trees of an applied patch, the objects of a bundle) lands in the
 * temporary directory and not in the checkout.
 * @returns {{ directory: string, options: { cwd: string, env: NodeJS.ProcessEnv }, indexOptions: { cwd: string, env: NodeJS.ProcessEnv }, dispose: () => void }}
 */
export function openScratch({ checkout, env, fs }) {
  const clean = { ...env };
  for (const name of REPOSITORY_VARIABLES) delete clean[name];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-inspect-"));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const gitDir = path.join(directory, "repository.git");
    git(["init", "--bare", "--quiet", "--template=", gitDir], { cwd: directory, env: clean });
    const objects = path.resolve(checkout, git(["rev-parse", "--git-path", "objects"], { cwd: checkout, env: clean }).trim());
    fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${objects}\n`);
    const options = { cwd: directory, env: { ...clean, GIT_DIR: gitDir } };
    return { directory, options, indexOptions: { cwd: directory, env: { ...options.env, GIT_INDEX_FILE: path.join(directory, "index") } }, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function readTransportFile(file, fs) {
  const size = fs.statSync(file).size;
  if (size > FILE_LIMIT_BYTES) throw new Error(`it is ${size} bytes, more than the ${FILE_LIMIT_BYTES} that are read`);
  return fs.readFileSync(file);
}

/**
 * The tree that each message of a patch file produces when the messages are applied in turn to the base commit: [{ position, count, tree }].
 * A message is what `git am` would apply: the file is split into mails (`git mailsplit`), the diff of each mail is taken out (`git mailinfo`),
 * and the diffs are applied to an index that starts as the base commit's (`git apply --cached`, which needs no working tree). A mail without a
 * diff adds nothing, and a file that is not a mailbox, or a diff that does not apply to the base commit, throws: it cannot be inspected.
 */
export function patchTrees(scratch, { file, baseSha, fs }) {
  const bytes = readTransportFile(file, fs);
  if (bytes.length === 0) throw new Error("it is empty");
  const split = fs.mkdtempSync(path.join(scratch.directory, "split-"));
  git(["mailsplit", `-o${split}`, file], scratch.options);
  const messages = fs
    .readdirSync(split)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  if (messages.length === 0) throw new Error("it holds no message");
  git(["read-tree", baseSha], scratch.indexOptions);
  const messageFile = path.join(scratch.directory, "message.txt");
  const patchFile = path.join(scratch.directory, "patch.diff");
  const trees = [];
  let tree = git(["write-tree"], scratch.indexOptions).trim();
  messages.forEach((name, index) => {
    const position = index + 1;
    try {
      git(["mailinfo", messageFile, patchFile], { ...scratch.options, input: fs.readFileSync(path.join(split, name)) });
      if (fs.statSync(patchFile).size > 0) {
        git(["apply", "--cached", "--whitespace=nowarn", patchFile], scratch.indexOptions);
        tree = git(["write-tree"], scratch.indexOptions).trim();
      }
    } catch (error) {
      throw new Error(`its message ${position} of ${messages.length} does not apply to the base commit: ${gitMessage(error)}`, { cause: error });
    }
    trees.push({ position, count: messages.length, tree });
  });
  return trees;
}

/**
 * The commits that a bundle file names as its tips, and the commits that it carries beyond the base commit: { tips, commits }. The bundle is
 * unbundled into the scratch repository (`git bundle unbundle` verifies that the commits it builds on are in the checkout), so that
 * nothing is written to the checkout.
 */
export function bundleCommits(scratch, { file, baseSha, fs }) {
  readTransportFile(file, fs);
  const listed = git(["bundle", "unbundle", file], scratch.options);
  const tips = [
    ...new Set(
      listed
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map((line) => line.split(" ")[0]),
    ),
  ];
  if (tips.length === 0 || !tips.every((tip) => COMMIT.test(tip))) throw new Error("it names no commit");
  return { tips, commits: commitsAhead(scratch.options, baseSha, tips) };
}
