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
// The scratch repository lives in a temporary directory, borrows the objects of the checkout (an alternates file), takes copies of its refs, HEAD and
// shallow file, and is removed afterwards; the checkout itself is only read. Nothing here knows what the lab validator looks for: callers decide what a
// revision may or may not contain.
//
// The agent can also write what git reads from the checkout besides its objects: .git/config, .git/info/attributes, .git/hooks and the index. Each
// of them can name a program that git then runs on the host, inside the validator: `core.fsmonitor`, or a `filter.<name>.clean` that an attribute
// selects, run by a `git diff`, a `git ls-files` and even a `git diff-tree` in that checkout, and a post-index-change hook, run by a `git diff` that
// refreshes the index; and a repository that is set up as a partial clone starts `git fetch`, with the remote's `uploadpack` program or the ssh
// command of the configuration, for any object that is missing. A program that runs there can move the patch that the validator has yet to read out of
// the way and put it back after the check. So no git process of the validator ever runs in the checkout's repository or under its configuration.
// Everything runs in the scratch repository, which has a configuration of its own (no system or global file, no global attributes, no hooks, no
// remote, an index of its own): it reads the objects of the checkout through the alternates file, its refs, HEAD and shallow file as copies, the index
// file of the checkout as data (GIT_INDEX_FILE), and the checkout directory as its working tree (GIT_WORK_TREE), so that the checkout's `.git/config`
// and `.git/info/attributes` are never consulted. What the scratch repository takes from the checkout is bytes: objects, refs, an index file and the
// files of the working tree. (The checkout's configuration file is read as data too, by `git config --file`, to name what it sets: commandConfiguration.)
// One git process would still start in the checkout's repository without a setting of the scratch repository: while `git bundle unbundle` checks what a
// bundle builds on, git itself runs `git --git-dir=<alternate> for-each-ref` for every alternate, and the alternate is the checkout. It only lists refs,
// but the rule is that no git process runs there, so the configuration of the scratch repository replaces that command (core.alternateRefsCommand, set
// in openScratch) with one that lists nothing; the scratch repository holds copies of the same refs, which `--all` reads.
//
// Every git call also runs with --no-replace-objects, so that a replace ref (which the agent can create) never changes what an object is, and with
// core.fsmonitor and core.hooksPath switched off, so that a call that does read an index starts neither the fsmonitor program nor a hook.

import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** More commits than this ahead of the base commit are refused: they cannot be read one by one in a reasonable time. */
export const COMMIT_LIMIT = 2000;
/** A patch or a bundle larger than this is refused (gh-aw itself limits a patch to 4 MiB by default). */
export const FILE_LIMIT_BYTES = 64 * 1024 * 1024;
/** The names that the artifact upload of the agent job collects from the directory above the artifact directory (aw-*.patch, aw-*.bundle). */
export const TRANSPORT_FILE = /^aw-.*\.(patch|bundle)$/;
/**
 * What every git call carries before its own arguments: the objects as they are (--no-replace-objects must stay first), no pager, and none of the two
 * programs that a read of an index starts, the fsmonitor hook and a hook of the hooks directory (a path that is no directory). The scratch repository
 * has no such setting of its own, so this only matters if one reaches it from outside (a `GIT_CONFIG_*` variable of the step, a later change of this code).
 */
export const GIT_OPTIONS = ["--no-replace-objects", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

/**
 * git, as every check of the validator uses it. The checkout is the agent's workspace and the agent can write its .git directory, so no call
 * trusts a replace ref: --no-replace-objects (and GIT_NO_REPLACE_OBJECTS, for a git that git itself starts) makes a read of an object return
 * that object, where `git replace <base> HEAD` would make a read of the base commit return the agent's own commit. See GIT_OPTIONS for the rest.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string | Buffer }} [options]
 */
export function git(args, { cwd, env, input } = {}) {
  return execFileSync("git", [...GIT_OPTIONS, ...args], {
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

/** Every ref of the repository that `options` names, as [{ type, name, peeled, refname }] (`peeled` is the commit that an annotated tag names, else ""). */
export function listRefs(options) {
  return git(["for-each-ref", "--format=%(objecttype) %(objectname) %(*objectname) %(refname)"], options)
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      const [type, name, peeled, ...rest] = line.split(" ");
      return { type, name, peeled, refname: rest.join(" ") };
    });
}

/** The refs that point at each commit (an annotated tag counts for the commit that it names), as { commit: [refname, ...] }. */
export function refsByCommit(refs) {
  const byCommit = new Map();
  for (const { type, name, peeled, refname } of refs) {
    const commit = type === "commit" ? name : type === "tag" && peeled !== "" ? peeled : null;
    if (commit === null) continue;
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), refname]);
  }
  return byCommit;
}

/** The local branches (refs/heads/) and the commit that each points at. */
export function branchTips(refs) {
  return new Map(refs.filter(({ type, refname }) => type === "commit" && refname.startsWith("refs/heads/")).map(({ refname, name }) => [refname, name]));
}

/** The names of the replace refs (refs/replace/, whatever they point at). */
export const replaceRefs = (refs) => refs.map(({ refname }) => refname).filter((refname) => refname.startsWith("refs/replace/"));

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
 * The environment of a git call that must read no configuration and no attributes but those of the scratch repository: no system file, no global
 * file, no home directory, no global attributes file or ignore file (the three paths that git derives from HOME and XDG_CONFIG_HOME). The runner
 * does not let the agent write the system configuration; whether it lets the agent write the home directory of the runner (the agent step mounts
 * some of it) was not observed, so the global files are cut off as well. `GIT_CONFIG_*` variables and the trace variables are the runner's own and stay.
 */
function isolatedEnvironment(env, directory) {
  const home = path.join(directory, "home");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(directory, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(directory, "no-global-config"),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * The directories of the repository that a checkout holds, found as files and without a git process: `gitDir` (the `.git` directory, or the one that a
 * `.git` file names, with the HEAD and the index of this working tree) and `commonDir` (the same, or the main repository's for a linked working tree:
 * the refs, the objects and the configuration). The agent can write a `.git` file, which only says where to read from: the objects are content-addressed.
 */
export function repositoryDirectories(checkout, fs) {
  const dotGit = path.join(path.resolve(checkout), ".git");
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch (error) {
    throw new Error(`${dotGit} cannot be read (${error?.code ?? error}); the target checkout is not a git repository`, { cause: error });
  }
  let gitDir = dotGit;
  if (stat.isFile()) {
    const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (pointer === null) throw new Error(`${dotGit} is a file that names no git directory`);
    gitDir = path.resolve(path.dirname(dotGit), pointer[1]);
  } else if (!stat.isDirectory()) {
    throw new Error(`${dotGit} is neither a directory nor a file`);
  }
  const common = path.join(gitDir, "commondir");
  return { gitDir, commonDir: fs.existsSync(common) ? path.resolve(gitDir, fs.readFileSync(common, "utf8").trim()) : gitDir };
}

/**
 * A scratch repository: a bare repository in a temporary directory with a configuration of its own, whose object store is the checkout's (an
 * alternates file) and whose refs, HEAD and shallow file are copies of the checkout's (plain files, which git reads here as it would there), so that the
 * base commit and everything below it is readable, the refs and HEAD of the checkout can be listed, and everything that is written (the trees of an
 * applied patch, the objects of a bundle) lands in the temporary directory and not in the checkout. No git process ever runs in the checkout's own
 * repository: what the scratch takes from it is files. It has four ways to be used:
 *  - `options`: the repository alone (refs, objects: `for-each-ref`, `rev-list`, `diff-tree`, `cat-file`, the application of patches, the unbundling of bundles);
 *  - `indexOptions`: with an index file of its own (the application of patches);
 *  - `workTreeOptions`: with the checkout directory as its working tree (`GIT_WORK_TREE`; the process itself starts in the scratch directory) and an
 *    index file of its own, so that a `git diff` or `git ls-files` there reads the files of the checkout and nothing of the checkout's `.git` directory
 *    except its objects;
 *  - `checkoutIndexOptions`: with the index file of the checkout, which git reads as data for `diff-index --cached` and for the files that the index holds (`indexFileText`), and does not write.
 * A checkout that keeps its refs in the reftable format cannot be read this way and is refused.
 * @returns {{ directory: string, directories: { gitDir: string, commonDir: string }, configuration: { objectFormat: string, commandKeys: { scope: string, key: string }[], error: Error | null }, options: { cwd: string, env: NodeJS.ProcessEnv }, indexOptions: { cwd: string, env: NodeJS.ProcessEnv }, workTreeOptions: { cwd: string, env: NodeJS.ProcessEnv }, checkoutIndexOptions: { cwd: string, env: NodeJS.ProcessEnv, file: string }, dispose: () => void }}
 */
export function openScratch({ checkout, env, fs }) {
  const directories = repositoryDirectories(checkout, fs);
  const { gitDir: checkoutGitDir, commonDir } = directories;
  if (fs.existsSync(path.join(commonDir, "reftable"))) throw new Error(`the refs of the target checkout are stored in the reftable format (${path.join(commonDir, "reftable")}), which is not read here`);
  const clean = { ...env };
  for (const name of REPOSITORY_VARIABLES) delete clean[name];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-inspect-"));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const isolated = isolatedEnvironment(clean, directory);
    const gitDir = path.join(directory, "repository.git");
    // the configuration of the checkout, read as data first: the scratch repository has to have the object format of the checkout to borrow its objects
    const configuration = readConfiguration(directories, { cwd: directory, env: isolated }, fs);
    if (!/^(?:sha1|sha256)$/.test(configuration.objectFormat)) throw new Error(`the object format '${configuration.objectFormat}' of the target checkout is not read here`);
    git(["init", "--bare", "--quiet", "--template=", ...(configuration.objectFormat === "sha1" ? [] : [`--object-format=${configuration.objectFormat}`]), gitDir], { cwd: directory, env: isolated });
    // The alternate of this repository is the checkout, and git itself runs `git --git-dir=<alternate> for-each-ref` for it while `git bundle unbundle`
    // checks what a bundle builds on (`rev-list --alternate-refs`): a git process in the checkout's repository, under its configuration. This repository
    // holds copies of the same refs, which `--all` reads, so its own configuration replaces that command with one that lists nothing (the `#` ends the
    // command before the path that git appends to it).
    git(["config", "--file", path.join(gitDir, "config"), "core.alternateRefsCommand", ": #"], { cwd: directory, env: isolated });
    fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${path.join(commonDir, "objects")}\n`);
    for (const relative of ["refs", "packed-refs", "shallow"]) {
      if (fs.existsSync(path.join(commonDir, relative))) fs.cpSync(path.join(commonDir, relative), path.join(gitDir, relative), { recursive: true, force: true });
    }
    fs.copyFileSync(path.join(checkoutGitDir, "HEAD"), path.join(gitDir, "HEAD"));
    const options = { cwd: directory, env: { ...isolated, GIT_DIR: gitDir } };
    const indexFile = path.join(checkoutGitDir, "index");
    return {
      directory,
      directories,
      configuration,
      options,
      indexOptions: { cwd: directory, env: { ...options.env, GIT_INDEX_FILE: path.join(directory, "index") } },
      workTreeOptions: { cwd: directory, env: { ...options.env, GIT_WORK_TREE: path.resolve(checkout), GIT_INDEX_FILE: path.join(directory, "worktree-index") } },
      checkoutIndexOptions: { cwd: directory, env: { ...options.env, GIT_INDEX_FILE: indexFile }, file: indexFile },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

const unique = (...outputs) => [...new Set(outputs.flatMap((output) => output.split("\0")).filter((entry) => entry !== ""))];

/**
 * Every path whose file in the working tree of the checkout differs from the base commit: a tracked file that is modified or missing, and a file that
 * the base commit does not have and `.gitignore` does not ignore. The comparison runs in the scratch repository, whose index starts as the base
 * commit's tree (so that the index of the checkout, with its assume-unchanged and skip-worktree bits, decides nothing) and whose configuration has
 * no filter, no fsmonitor, no hooks and no attributes of its own: a file is compared as git itself reads it, and no program of the checkout runs.
 * A nested repository is not entered, and a submodule is not compared (`--ignore-submodules=all` starts no `git status` in a directory that the agent controls).
 */
export function workTreePaths(scratch, baseSha) {
  if (!COMMIT.test(baseSha)) throw new Error("the base commit is not a full commit id");
  git(["read-tree", baseSha], scratch.workTreeOptions);
  const tracked = git(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", baseSha, "--"], scratch.workTreeOptions);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], scratch.workTreeOptions);
  return unique(tracked, untracked);
}

/**
 * Every path that the index of the checkout (the file that `git add` writes) differs from the base commit in. The scratch repository reads that file
 * as data, under its own configuration: it neither refreshes nor writes it, and the checkout's fsmonitor setting and hooks are not consulted.
 */
export function indexPaths(scratch, baseSha, fs) {
  if (!COMMIT.test(baseSha)) throw new Error("the base commit is not a full commit id");
  const { file } = scratch.checkoutIndexOptions;
  if (!fs.existsSync(file)) throw new Error(`the index file ${file} does not exist`);
  return unique(git(["diff-index", "--cached", "--name-only", "-z", "--no-renames", baseSha, "--"], scratch.checkoutIndexOptions));
}

/**
 * The text of a file as the index of the checkout holds it (the stage-0 entry of `relative`), read as data the way `indexPaths` reads it: null when the
 * index has no such entry or the object that it names cannot be read. A change that is staged and then put back in the working tree shows in neither
 * HEAD nor the working tree, and a pull request can still be made of the index, so a value that matters is read here and not taken from either.
 */
export function indexFileText(scratch, relative) {
  try {
    return git(["cat-file", "blob", `:${relative}`], scratch.checkoutIndexOptions);
  } catch {
    return null;
  }
}

const COMMAND_KEY = /^(?:core\.fsmonitor|filter\..+\.(?:clean|smudge|process)|diff\.external|diff\..+\.(?:command|textconv))$/i;

/**
 * What the configuration files of the checkout say that matters here: the object format, and the keys that name a program for git to run while it reads
 * an index or the files of a working tree (`core.fsmonitor`, which is a hook, or the built-in daemon when it is `true`; `filter.<name>.clean`, `.smudge` and
 * `.process`, which an attributes file written in the same checkout selects for a path; `diff.external`; `diff.<name>.command` and `.textconv`).
 * The files (.git/config with what it includes, and the per-worktree file) are read as data, by `git config --file` in the scratch repository's
 * environment, so that the configuration of the runner (system and global files, `GIT_CONFIG_*` variables: the system file of a runner image defines
 * `filter.lfs`, for one) is not taken for the agent's. `core.fsmonitor` set to a false value switches the program off and is listed as nothing.
 * @returns {{ objectFormat: string, commandKeys: { scope: "local" | "worktree", key: string }[], error: Error | null }}
 */
function readConfiguration(directories, options, fs) {
  const configuration = { objectFormat: "sha1", commandKeys: [], error: null };
  for (const [scope, file] of [
    ["local", path.join(directories.commonDir, "config")],
    ["worktree", path.join(directories.gitDir, "config.worktree")],
  ]) {
    if (!fs.existsSync(file)) continue;
    try {
      for (const entry of git(["config", "--file", file, "--includes", "--list", "-z"], options).split("\0")) {
        const newline = entry.indexOf("\n");
        const key = newline === -1 ? entry : entry.slice(0, newline);
        const value = newline === -1 ? null : entry.slice(newline + 1);
        if (scope === "local" && /^extensions\.objectformat$/i.test(key) && value !== null && value.trim() !== "") configuration.objectFormat = value.trim().toLowerCase();
        if (!COMMAND_KEY.test(key)) continue;
        if (/^core\.fsmonitor$/i.test(key) && value !== null && /^(?:false|no|off|0)?$/i.test(value.trim())) continue;
        configuration.commandKeys.push({ scope, key });
      }
    } catch (error) {
      configuration.error ??= error;
    }
  }
  return configuration;
}

/**
 * The aw-*.patch and aw-*.bundle files of a directory, copied into the scratch directory before their contents are read: { name, file, kind, error? }.
 * What comes before the copy is the caller's: the validator sets the scratch repository up and checks its refs, the configuration of the checkout and
 * the commit ids first, and none of that reads these files. `file` is the copy, which is what the inspection reads, so that what the validator inspects
 * is what the directory held when it looked, whatever happens to the directory afterwards. A file that is not a regular file (a pipe would block the read
 * for good) or is too large is listed with `error` and no copy; so is one that cannot be copied.
 */
export function snapshotTransportFiles(directory, scratch, fs) {
  const copies = path.join(scratch.directory, "transport");
  const entries = transportFiles(directory, fs);
  if (entries.length > 0) fs.mkdirSync(copies, { recursive: true });
  return entries.map((entry) => {
    try {
      const stat = fs.statSync(entry.file);
      if (!stat.isFile()) throw new Error("it is not a regular file");
      if (stat.size > FILE_LIMIT_BYTES) throw new Error(`it is ${stat.size} bytes, more than the ${FILE_LIMIT_BYTES} that are read`);
      const copy = path.join(copies, entry.name);
      fs.copyFileSync(entry.file, copy);
      return { ...entry, file: copy };
    } catch (error) {
      return { ...entry, error };
    }
  });
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
