// instructions/<projectKey>.md (AC50): the operator's --instructions text verbatim (the content of the file when the
// value is an existing file path of the central repository's working copy), followed by a generated section that lists
// what the inspection found. The file is UTF-8 with a trailing newline and never holds a credential or the content of a
// secret file: a file outside the working copy, a file whose name or directory says it holds secrets, a file that is not
// UTF-8 text and a text that looks like a credential are refused, and the diagnostic never echoes what was read.

import fs from "node:fs";
import path from "node:path";
import { SdlcError } from "./errors.mjs";

export const GENERATED_MARKER = "<!-- sdlc-onboard:generated -->";
const GENERATED_HEADING = "## Detected repository facts";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Where the generated section of a file written by composeInstructions begins: the marker on a line of its own (or at the very start
// of the file), directly followed by the heading of the section; the letter case of the two is not significant. The line break may be
// \r\n, because a checkout with core.autocrlf turns the \n of the file into one.
const GENERATED_BOUNDARY = new RegExp(`(?<![^\\n])${escapeRegExp(GENERATED_MARKER)}\\r?\\n${escapeRegExp(GENERATED_HEADING)}(?![^\\r\\n])`, "gi");

// Credential formats that are recognisable on sight. A text that holds one is refused, wherever the credential stands: alone, in a sentence or in the middle of a name
// (`packages/backup_ghp_...` and `AKIA..._old` are paths that the inspection reads, and they are held to this scanner too). Where a pattern needs a boundary to stay
// precise (`sk-` would otherwise find an API key in `task-description-for-the-long-running-job`), the boundary is a character that is not a letter or a digit:
// `(?<![A-Za-z0-9])` before the credential, and `(?![A-Za-z0-9])` after a credential of a fixed length. It is not `\b`, which counts `_` as a part of a word and so
// misses a credential after a file-name prefix (`backup_`) or before a suffix (`_old`) that it sees when the same credential stands alone. The GitHub prefixes are
// specific enough to need no boundary, as `gho_` never did.
const CREDENTIAL_PATTERNS = [
  // private keys: PEM, OpenSSH and PGP blocks
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  // GitHub: personal access tokens (classic and fine-grained), OAuth, user-to-server, server-to-server and refresh tokens
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gho_/,
  // AWS access key IDs and secret access keys
  /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  /aws_secret_access_key["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9/+]{40}/i,
  // engine and model-provider API keys: Anthropic, OpenAI, Google
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{20,}/,
  // other widely used formats: Slack, Stripe, npm, Hugging Face, SendGrid and JSON Web Tokens
  /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/,
  /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // GitLab, DigitalOcean, Databricks, Docker Hub, PyPI, Twilio, Shopify and Telegram
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])dop_v1_[a-f0-9]{64}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])dapi[0-9a-f]{32}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])dckr_pat_[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])shp(?:at|ca|pa|ss)_[a-f0-9]{32}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9])/,
  // the credential files of tools: netrc, the key data of a kubeconfig, a PuTTY key and the auth of a Docker config
  /(?<![A-Za-z0-9])machine[ \t]+\S+[ \t]+login[ \t]+\S+[ \t]+password[ \t]+\S+/i,
  /(?<![A-Za-z0-9])client-key-data[ \t]*:[ \t]*[A-Za-z0-9+/=]{20,}/,
  /(?<![A-Za-z0-9])PuTTY-User-Key-File-\d+:/,
  /"auth"[ \t]*:[ \t]*"[A-Za-z0-9+/=]{16,}"/,
  // Azure storage and Service Bus connection strings
  /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/i,
  // a password or token inside a URL (a `$VAR`, `{...}` or `<...>` reference is not one), and an Authorization header
  /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?![$<{%])[^\s/@]+@/i,
  /(?<![A-Za-z0-9])Authorization[ \t]*:[ \t]*(?:Bearer|Basic|Token)[ \t]+[A-Za-z0-9._~+/=-]{16,}/i,
];

// `NAME=value` and `NAME: value` where the name says that the value is a secret (API_KEY, client_secret, GH_TOKEN, password, ...)
// and the value is a token-like string of at least 12 characters with a letter in it: the shape of an .env or credentials file
// whatever the provider. A secret is not made harmless by lacking a digit (`PASSWORD=OnlyLettersInThisOne`); a value without a
// letter (`token_count=1234567890123`) is a number, not a secret.
const SECRET_NAME = /(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key|access[_-]?key)/gi;
const ASSIGNED_VALUE = /^["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9/+_=.~-]{12,})/;

function hasSecretAssignment(text) {
  let consumed = 0; // the name run that has been looked at, so that a long run of keywords is scanned once
  for (const match of text.matchAll(SECRET_NAME)) {
    if (match.index < consumed) continue;
    let end = match.index + match[0].length;
    while (end < text.length && /[\w.-]/.test(text[end])) end += 1; // the rest of the name
    consumed = end;
    const assigned = ASSIGNED_VALUE.exec(text.slice(end, end + 400));
    if (assigned && /[A-Za-z]/.test(assigned[1])) return true;
  }
  return false;
}

/** Refuses text that looks like a credential or the content of a secret file; the diagnostic never echoes the text. */
export function assertNoCredentials(text, label) {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) || hasSecretAssignment(text)) {
    throw new SdlcError(
      `${label} appears to contain a credential (a private key, an access token or an API key); instructions are written to the repository, so they must not hold one`,
      { code: "instructions-credential" },
    );
  }
}

/**
 * assertNoCredentials for every string that `value` holds, at any depth of its objects and arrays (the strings of an entry that
 * S5 synthesizes: a path, a branch, a key of a provenance file). Like the diagnostic of assertNoCredentials, that of this function
 * names `label` and never the string.
 */
export function assertNoCredentialsIn(value, label) {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      assertNoCredentials(item, label);
    } else if (item !== null && typeof item === "object") {
      for (const child of Array.isArray(item) ? item : Object.values(item)) pending.push(child);
    }
  }
}

// Files whose name says that they hold secrets, and the directories that hold them; refused even inside the working copy.
const SECRET_FILE_NAMES = [
  /^\.env/i, // .env, .env.production, .envrc, .env-local, .environment, ...
  /^\.(?:npmrc|netrc|pypirc|git-credentials|htpasswd)$/i,
  /^credentials(?:\.json)?$/i,
  /^secrets?\.(?:json|ya?ml|toml|ini|properties)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
];
const SECRET_DIRECTORIES = new Set([".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", "credentials"]);

/** The reason why a repository-relative path is a secret file, or null. */
function secretFileReason(relative) {
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const directory = segments.slice(0, -1).find((segment) => SECRET_DIRECTORIES.has(segment.toLowerCase()));
  if (directory !== undefined) return `it is below ${directory}/, which holds credentials`;
  return SECRET_FILE_NAMES.some((pattern) => pattern.test(segments.at(-1) ?? "")) ? `its name (${segments.at(-1)}) is that of a file that holds secrets` : null;
}

const realPath = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/**
 * The text of the bytes of an --instructions file, or the refusal of a file that is not text: bytes that are not valid UTF-8 (a
 * lenient decoder would turn each of them into U+FFFD, and the copy would no longer be the file) and a NUL byte. A leading byte order
 * mark stays in the text (`ignoreBOM`), so that the copy of a valid UTF-8 file remains byte for byte.
 */
function decodeText(bytes, value) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    text = null;
  }
  if (text === null || text.includes("\u0000")) {
    throw new SdlcError(`the instructions file ${value} is not a text file; nothing was written`, { code: "instructions-binary" });
  }
  return text;
}

/**
 * Reads --instructions: an existing file path is read (and its text is not stored in the project entry), anything else is literal text.
 * A file is only read when it lies inside `root` (after symbolic links are resolved), is not a secret file by name and holds no
 * credential; otherwise the run is refused before anything is written.
 * @param {string|undefined} value the flag value
 * @param {string} cwd the directory that a relative path is resolved against
 * @param {string} [root] the working copy of the central orchestrator repository (default: `cwd`)
 * @returns {{ text: string, literal: string } | null} null when the flag was not given
 */
export function readOperatorInstructions(value, cwd, root = cwd) {
  if (value === undefined) return null;
  const looksLikePath = !value.includes("\n") && value.length < 1024;
  if (looksLikePath) {
    const absolute = path.resolve(cwd, value);
    try {
      if (fs.statSync(absolute).isFile()) {
        const real = fs.realpathSync(absolute);
        const relative = path.relative(realPath(root), real);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new SdlcError(
            `--instructions ${value} names a file outside the working copy of the central orchestrator repository (${path.resolve(root)}): its content is copied into instructions/<projectKey>.md, ` +
              "which is committed, so only a file of the repository can be used. Copy the file into the repository or pass its text instead. Nothing was written.",
            { code: "instructions-path" },
          );
        }
        const reason = secretFileReason(relative);
        if (reason !== null) {
          throw new SdlcError(`--instructions ${value} names a file that is not copied because ${reason}; instructions are committed, so a secret file cannot be used. Nothing was written.`, { code: "instructions-secret-file" });
        }
        const text = decodeText(fs.readFileSync(real), value);
        assertNoCredentials(text, `the instructions file ${value}`);
        return { text, literal: "" };
      }
    } catch (error) {
      if (error instanceof SdlcError) throw error;
      // not a readable file: the value is literal text
    }
  }
  assertNoCredentials(value, "--instructions");
  return { text: value, literal: value };
}

const safeItem = (value) => !/[\u0000-\u001f`]/.test(value) && !value.includes("${{");
const list = (items) => (items.length === 0 ? ["None detected."] : items.map((item) => `- \`${item}\``));

/** The generated section (no trailing newline). */
export function generatedSection(inspection) {
  const manifests = inspection.packageManifests.filter(safeItem);
  const commands = [
    ...inspection.buildCommands.filter(safeItem).map((command) => `Build: \`${command}\``),
    ...inspection.verifyCommands.filter(safeItem).map((command) => `Verify: \`${command}\``),
  ];
  const scheduled = inspection.workflows.filter((workflow) => workflow.scheduled && safeItem(workflow.path)).map((workflow) => workflow.path);
  const provenance = inspection.provenanceFiles.map((file) => file.path).filter(safeItem);
  const lines = [
    GENERATED_MARKER,
    GENERATED_HEADING,
    "",
    `Repository \`${inspection.repo}\`, default branch \`${inspection.defaultBranch}\`.`,
    "",
    "### Package manifests",
    "",
    ...list(manifests),
    "",
    "### Commands",
    "",
    ...(commands.length === 0 ? ["None detected."] : commands.map((command) => `- ${command}`)),
    "",
    "### Scheduled workflows",
    "",
    ...list(scheduled),
    "",
    "### Provenance files",
    "",
    ...list(provenance),
  ];
  return lines.join("\n");
}

/** Exactly one blank line between the operator's text and the generated section; the file ends with one newline. */
export function composeInstructions(operatorText, generated) {
  const separator = operatorText === "" ? "" : operatorText.endsWith("\n") ? "\n" : "\n\n";
  return `${operatorText}${separator}${generated}\n`;
}

/**
 * The operator's text of an instructions file written by composeInstructions: the part before its generated section. The section
 * starts at the last line that holds the marker, directly followed by the heading of the section, and not at the first occurrence
 * of the marker: an operator can quote the marker in their own text (`Document this marker: <!-- sdlc-onboard:generated -->`), and
 * the text after that quotation is theirs, not generated. A file without such a boundary is the operator's text as a whole.
 */
export function operatorTextOf(existing) {
  let index = -1;
  for (const match of existing.matchAll(GENERATED_BOUNDARY)) index = match.index;
  if (index === -1) return existing;
  const before = existing.slice(0, index);
  if (before === "") return "";
  if (before.endsWith("\n\n")) {
    const shorter = before.slice(0, -2);
    if (!shorter.endsWith("\n")) return shorter;
  }
  return before.endsWith("\n") ? before.slice(0, -1) : before;
}
