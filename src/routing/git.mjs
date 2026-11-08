// Running commands and checking out repositories for the router's preflights (SPEC-03 AC20-AC23).
//
// A preflight command is code that the downstream and upstream repositories declare, so it never sees a secret of the router: its environment is built
// from an allowlist (the variables that a shell, git and node need) plus what the preflight defines (UPSTREAM_DIR, TARGET_SHA, LAST_MERGED_SHA,
// GITHUB_WORKSPACE) and one token, the read-only token of the App (contents, pull requests and actions: read). The App's private key, the write token and the
// token of the job never reach a child. Git reaches the server with that read token through the environment (GIT_CONFIG_COUNT), so that it is neither
// on a command line nor in the .git/config of a checkout.
//
// A checkout is made only where nothing exists: a directory that already holds files is used when it is a clean checkout of the wanted commit and is
// otherwise an error. Nothing is ever reset, cleaned or overwritten in a tree that somebody else may be working in.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ALLOWED = [
  /^PATH$/i,
  /^PATHEXT$/i,
  /^SYSTEMROOT$/i,
  /^WINDIR$/i,
  /^COMSPEC$/i,
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^APPDATA$/i,
  /^LOCALAPPDATA$/i,
  /^PROGRAM(FILES|DATA)/i,
  /^(TMP|TEMP|TMPDIR)$/i,
  /^LANG$/i,
  /^LC_/i,
  /^TZ$/i,
  /^TERM$/i,
  /^USER(NAME)?$/i,
  /^LOGNAME$/i,
  /^SHELL$/i,
  /^CI$/i,
  /^RUNNER_(OS|ARCH|TEMP|TOOL_CACHE)$/i,
  /^(HTTPS?|NO)_PROXY$/i,
  /^GIT_(EXEC_PATH|CONFIG_NOSYSTEM|CONFIG_GLOBAL|CONFIG_SYSTEM)$/i,
  /^GIT_SSL_/i,
  /^SSL_CERT_(FILE|DIR)$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
  // where a version manager keeps the node that PATH names (a nodist or nvm shim cannot start without them); none of these holds a credential
  /^(NODIST|NVM|VOLTA|FNM|ASDF|MISE)_/i,
  /^N_PREFIX$/i,
  /^npm_config_(cache|registry|userconfig|globalconfig)$/i,
];

/** The environment of a child: the allowlisted variables of `source`, then `extra`. */
export function childEnvironment(source, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.some((pattern) => pattern.test(name))) env[name] = value;
  }
  return { ...env, ...extra };
}

/** The path as the bash of the platform names it: Git for Windows reads C:\x as /c/x. Elsewhere the path is unchanged. */
export function toShellPath(value) {
  if (process.platform !== "win32") return value;
  return String(value).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

const OUTPUT_LIMIT = 16 * 1024 * 1024;

/**
 * Runs a program without a shell. Never throws: a program that cannot be started is a result with `error`.
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, error: string | null }>}
 */
export function execute(command, args, { cwd, env, input, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: error.message });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    const collect = (chunks) => (chunk) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        error: overflow ? `the output of ${command} is larger than ${OUTPUT_LIMIT} bytes` : null,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export class CheckoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** A git invocation; a non-zero exit is an error that names the command and the tail of its output (never a credential: none is on the command line). */
export async function git(args, { cwd, env, timeoutMs, tolerate = false } = {}) {
  const result = await execute("git", args, { cwd, env, timeoutMs });
  if (!tolerate && (result.error !== null || result.code !== 0)) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");
    throw new CheckoutError(`git ${args[0]}${result.error ? ` could not run (${result.error})` : ` exited with ${result.code}`}: ${tail}`);
  }
  return result;
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Makes `dir` a checkout of `sha` of `slug`, unless it already is one.
 * @param {object} input
 * @param {string} input.dir the directory (absolute)
 * @param {string} input.serverUrl the web origin of the server, https://github.com on GitHub
 * @param {string} input.slug <owner>/<repo>
 * @param {string} input.sha the commit to check out
 * @param {string} [input.branch] the branch whose history is fetched when `history` is "full"
 * @param {"shallow" | "full"} [input.history] "shallow" fetches that one commit; "full" fetches the branch and the commits that must be present
 * @param {string[]} [input.mustContain] further commits that a "full" checkout must contain
 * @param {string} [input.token] the read token; sent as the Authorization header of git over https only
 * @param {Record<string, string | undefined>} input.environment the environment to derive the git environment from
 * @returns {Promise<{ dir: string, reused: boolean }>}
 * @throws {CheckoutError}
 */
export async function ensureCheckout({ dir, serverUrl, slug, sha, branch, history = "shallow", mustContain = [], token = "", environment }) {
  if (!HEX40.test(sha)) throw new CheckoutError(`${sha} is not a commit id`);
  const env = childEnvironment(environment, { GIT_TERMINAL_PROMPT: "0" });
  if (token !== "" && /^https:\/\//.test(serverUrl)) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${serverUrl.replace(/\/+$/, "")}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir, env, tolerate: true });
    const head = inside.code === 0 ? (await git(["rev-parse", "HEAD"], { cwd: dir, env, tolerate: true })).stdout.trim() : "";
    const status = inside.code === 0 ? (await git(["status", "--porcelain", "--untracked-files=all"], { cwd: dir, env, tolerate: true })).stdout.trim() : "x";
    if (head !== sha || status !== "") {
      throw new CheckoutError(`${dir} already exists and is not a clean checkout of ${sha}; it is not overwritten`);
    }
    for (const extra of mustContain) {
      const present = await git(["cat-file", "-e", `${extra}^{commit}`], { cwd: dir, env, tolerate: true });
      if (present.code !== 0) throw new CheckoutError(`${dir} does not contain the commit ${extra}`);
    }
    return { dir, reused: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  const url = `${serverUrl.replace(/\/+$/, "")}/${slug}.git`;
  await git(["init", "--quiet"], { cwd: dir, env });
  if (history === "shallow") {
    await git(["fetch", "--quiet", "--no-tags", "--depth", "1", url, sha], { cwd: dir, env });
  } else {
    await git(["fetch", "--quiet", "--no-tags", url, branch ?? "HEAD"], { cwd: dir, env });
    for (const wanted of [sha, ...mustContain]) {
      const present = await git(["cat-file", "-e", `${wanted}^{commit}`], { cwd: dir, env, tolerate: true });
      if (present.code !== 0) await git(["fetch", "--quiet", "--no-tags", url, wanted], { cwd: dir, env });
    }
  }
  await git(["checkout", "--quiet", "--detach", sha], { cwd: dir, env });
  const head = (await git(["rev-parse", "HEAD"], { cwd: dir, env })).stdout.trim();
  if (head !== sha) throw new CheckoutError(`${dir} is at ${head}, not at ${sha}`);
  return { dir, reused: false };
}

/** A fresh local clone of an existing checkout, in a temporary directory: the clone reads the original and changes nothing in it. */
export async function isolatedClone({ source, parent, environment, prefix = "sdlc-isolated-" }) {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  const env = childEnvironment(environment, { GIT_TERMINAL_PROMPT: "0" });
  try {
    await git(["clone", "--quiet", "--no-hardlinks", "--no-tags", source, dir], { env });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
