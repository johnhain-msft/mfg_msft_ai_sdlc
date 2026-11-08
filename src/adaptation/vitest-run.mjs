// Vitest as the immutable-gate check uses it (SPEC-04 AC50): run the companion test files with the JSON reporter and require that every locked test
// executed and passed. The field names are those of a real `vitest run --reporter=json` output (tests/s4/fixtures/vitest-json/): `testResults[]` with the
// `name` of a file and its `assertionResults[]`, each with a `title`, its `ancestorTitles` and a `status`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** The environment cannot run the check (no Vitest, no loader): the helper exits 2, because nothing can be said about the change. */
export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarnessError";
  }
}

/** The script that starts Vitest in the downstream checkout, resolved from that checkout's own dependencies. */
export function resolveVitest(portfolio) {
  const require = createRequire(path.join(portfolio, "package.json"));
  let manifest;
  try {
    manifest = require.resolve("vitest/package.json");
  } catch {
    throw new HarnessError(`vitest is not installed in ${portfolio} (npm ci has not run there)`);
  }
  const { bin } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const relative = typeof bin === "string" ? bin : bin?.vitest;
  if (typeof relative !== "string") throw new HarnessError("the vitest package of the downstream checkout declares no vitest command");
  return path.resolve(path.dirname(manifest), relative);
}

/** NODE_OPTIONS without `--frozen-intrinsics`: Vitest patches the built-ins that this process froze, so its child must not inherit the flag. */
function childOptions(value) {
  return String(value ?? "").split(/\s+/).filter((option) => option !== "" && option !== "--frozen-intrinsics").join(" ");
}

/**
 * Runs `vitest run --reporter=json` over the given files and returns the parsed report, whatever Vitest's own exit code was (failing tests outside the
 * locked set are the business of the check commands that follow). No report at all is a failure of the run.
 * @param {{ portfolio: string, files: string[], timeoutMs?: number }} input
 * @returns {{ report: object | null, detail: string }}
 */
export function runVitest({ portfolio, files, timeoutMs = 20 * 60 * 1000 }) {
  const script = resolveVitest(portfolio);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-vitest-"));
  const outputFile = path.join(directory, "report.json");
  try {
    const result = spawnSync(process.execPath, [script, "run", "--reporter=json", `--outputFile=${outputFile}`, ...files], {
      cwd: portfolio,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: childOptions(process.env.NODE_OPTIONS), CI: "1", FORCE_COLOR: "0" },
    });
    if (result.error) throw new HarnessError(`vitest could not run: ${result.error.message}`);
    let text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
    if (text.trim() === "") text = result.stdout ?? "";
    let report = null;
    try {
      report = JSON.parse(text);
    } catch {
      const start = text.indexOf('{"numTotalTestSuites"');
      if (start !== -1) {
        try {
          report = JSON.parse(text.slice(start));
        } catch {
          report = null;
        }
      }
    }
    return { report, detail: `vitest exited ${result.status}${report === null ? `: ${String(result.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}` : ""}` };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const comparable = (file) => String(file).replace(/\\/g, "/");

/**
 * Whether every locked test of every companion file is in the report and passed.
 * @param {object | null} report the parsed `vitest run --reporter=json` output
 * @param {{ file: string, blocks: { kind: string, title: string }[] }[]} locked
 * @returns {{ file: string, message: string }[]} one entry per locked test that is skipped, pending, todo, failed or absent
 */
export function evaluateLockedTests(report, locked) {
  const violations = [];
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  for (const { file, blocks } of locked) {
    const suffix = `/${comparable(file)}`;
    const assertions = results
      .filter((result) => typeof result?.name === "string" && (comparable(result.name) === comparable(file) || comparable(result.name).endsWith(suffix)))
      .flatMap((result) => (Array.isArray(result.assertionResults) ? result.assertionResults : []));
    for (const { kind, title } of blocks) {
      const matching = assertions.filter((assertion) => (kind === "it" ? assertion?.title === title : Array.isArray(assertion?.ancestorTitles) && assertion.ancestorTitles.includes(title)));
      const label = `${kind}(${JSON.stringify(title)})`;
      if (matching.length === 0) {
        violations.push({ file, message: `${label} did not appear in the Vitest report` });
        continue;
      }
      for (const assertion of matching) {
        if (assertion.status !== "passed") violations.push({ file, message: `${label}${kind === "describe" ? ` > ${assertion.title}` : ""} did not pass: its status is ${JSON.stringify(assertion.status)}` });
      }
    }
  }
  return violations;
}
