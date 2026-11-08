// The gh-aw version gate (AC6, AC7): both entry points call assertGhAwVersion() before anything else,
// so nothing is read, written, bound or sent while the local gh-aw is older than 1.0.1, the release
// after the 0.85.4 fix for GHSA-8h78-hpm7-29gg.
//
// The version is reported by `gh aw version` (the "version" subcommand of `gh aw --help`, which prints
// "gh aw version v1.0.1" on gh-aw v1.0.1); `gh aw --version` (the flag of the same help text) is the
// fallback for a CLI that rejects the subcommand.

import { SdlcError } from "./errors.mjs";

export const MIN_GH_AW_VERSION = "1.0.1";
export const ADVISORY_ID = "GHSA-8h78-hpm7-29gg";
export const VERSION_COMMANDS = Object.freeze([Object.freeze(["aw", "version"]), Object.freeze(["aw", "--version"])]);

const VERSION_TEXT = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?/;

/** Parses the first semantic version in a text ("gh aw version v1.0.1", "1.0.10", "1.0.1-rc.1"); null when there is none. */
export function parseVersion(text) {
  const match = VERSION_TEXT.exec(String(text ?? ""));
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  const pre = match[4] ?? null;
  return { core, pre, text: `${core.join(".")}${pre === null ? "" : `-${pre}`}` };
}

/** Semantic-version precedence: -1, 0 or 1. A pre-release is lower than its release. */
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const left = a.pre.split(".");
  const right = b.pre.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/** True when the version text is a parseable version that is at least MIN_GH_AW_VERSION. */
export function isAcceptableVersion(text) {
  const parsed = parseVersion(text);
  return parsed !== null && compareVersions(parsed, parseVersion(MIN_GH_AW_VERSION)) >= 0;
}

/** Reads the local gh-aw version through `runGh`; returns { version, raw } with version null when it cannot be read. */
export async function readGhAwVersion(runGh) {
  let raw = "";
  for (const args of VERSION_COMMANDS) {
    const outcome = await runGh([...args], { timeoutMs: 60000 });
    const output = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`.trim();
    if (outcome.code === 0) {
      const parsed = parseVersion(outcome.stdout);
      if (parsed !== null) return { version: parsed, raw: output };
    }
    raw = outcome.error ? outcome.error : output;
  }
  return { version: null, raw };
}

function remediation() {
  return (
    "Remediation: install or upgrade the CLI (gh extension install github/gh-aw, or gh extension upgrade gh-aw), " +
    "run `gh aw upgrade` and commit the regenerated .lock.yml files, because upgrading the CLI alone does not replace " +
    "the SHA-pinned action references in existing lock files."
  );
}

/**
 * Aborts unless the local gh-aw is >= 1.0.1. Returns the accepted version without a leading "v";
 * that string is the ghAwVersionPin that S5 sends to S1 (AC7, AC34).
 */
export async function assertGhAwVersion(runGh) {
  const { version, raw } = await readGhAwVersion(runGh);
  const shown = version === null ? `unreadable (${raw === "" ? "no output" : JSON.stringify(raw.slice(0, 200))})` : version.text;
  if (version === null || compareVersions(version, parseVersion(MIN_GH_AW_VERSION)) < 0) {
    throw new SdlcError(
      `gh-aw >= ${MIN_GH_AW_VERSION} is required because of ${ADVISORY_ID} ` +
        "(gh-aw >= 0.83.3 and < 0.85.4 wrote raw process output into the safe-outputs-items artifact, which can expose CI trigger tokens). " +
        `Detected version: ${shown}. ${remediation()}`,
      { code: "gh-aw-version" },
    );
  }
  return version.text;
}
