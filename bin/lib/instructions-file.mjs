// instructions/<projectKey>.md (AC50): the operator's --instructions text verbatim (the content of the file when the
// value is an existing file path), followed by a generated section that lists what the inspection found. The file is
// UTF-8 with a trailing newline and never holds a credential.

import fs from "node:fs";
import path from "node:path";
import { SdlcError } from "./errors.mjs";

export const GENERATED_MARKER = "<!-- sdlc-onboard:generated -->";

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /gho_/,
];

/** Refuses text that looks like a credential or the content of a secret file; the diagnostic never echoes the text. */
export function assertNoCredentials(text, label) {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new SdlcError(`${label} appears to contain a credential (a private key or an access token); instructions are written to the repository, so they must not hold one`, {
      code: "instructions-credential",
    });
  }
}

/**
 * Reads --instructions: an existing file path is read (and its text is not stored in the project entry), anything else is literal text.
 * @returns {{ text: string, literal: string } | null} null when the flag was not given
 */
export function readOperatorInstructions(value, cwd) {
  if (value === undefined) return null;
  const looksLikePath = !value.includes("\n") && value.length < 1024;
  if (looksLikePath) {
    const absolute = path.resolve(cwd, value);
    try {
      if (fs.statSync(absolute).isFile()) {
        const text = fs.readFileSync(absolute, "utf8");
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
    "## Detected repository facts",
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

/** The operator's text of an instructions file written by composeInstructions (the part before the generated marker). */
export function operatorTextOf(existing) {
  const index = existing.indexOf(GENERATED_MARKER);
  if (index === -1) return existing;
  const before = existing.slice(0, index);
  if (before === "") return "";
  if (before.endsWith("\n\n")) {
    const shorter = before.slice(0, -2);
    if (!shorter.endsWith("\n")) return shorter;
  }
  return before.endsWith("\n") ? before.slice(0, -1) : before;
}
