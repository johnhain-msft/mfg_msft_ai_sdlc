#!/usr/bin/env node
// Stand-in for the `gh` executable (AC55). installFakeGh() writes a launcher into a scratch directory that a test
// puts first on PATH; the launcher runs this file, which logs every invocation to a JSONL file and answers from a
// JSON configuration:
//
//   gh aw version | --version   prints "gh aw version v<version>" (or the raw text `versionOutput`)
//   gh aw validate | doctor     exit code `validateExit` / `doctorExit`
//   gh aw compile ...           a stub compiler (mode "ok" writes one lock file per workflow source, "error" fails)
//   gh workflow disable <id> --repo <o/r>   PUT .../actions/workflows/<id>/disable on the fake GitHub (`apiUrl`)
//   gh auth token               prints `authToken`
//
// Anything else fails with exit code 3, so a CLI that calls something unexpected cannot go unnoticed.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(import.meta.url);
const WINDOWS = process.platform === "win32";

/** What the stub compiler writes for a workflow source: a pure function of its name and bytes. */
export function stubLock(sourceName, bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return `# stub compiler output (tests/s5/helpers/fake-gh.mjs)\n# source: ${sourceName}\n# sha256: ${digest}\n`;
}

export function installFakeGh(directory, initial = {}) {
  const binDirectory = path.join(directory, "gh-bin");
  fs.mkdirSync(binDirectory, { recursive: true });
  const logPath = path.join(directory, "gh-log.jsonl");
  const configPath = path.join(directory, "gh-config.json");
  fs.writeFileSync(logPath, "");
  const config = { version: "1.0.1", validateExit: 0, doctorExit: 0, authToken: "operator-token-fixture", compile: { mode: "ok" }, ...initial, logPath };
  const save = () => fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  save();
  if (WINDOWS) {
    fs.writeFileSync(path.join(binDirectory, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${RUNNER}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  } else {
    const launcher = path.join(binDirectory, "gh");
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${RUNNER}" "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }
  const hostPath = process.env.PATH ?? process.env.Path ?? "";
  const searchPath = `${binDirectory}${path.delimiter}${hostPath}`;
  const readLog = () => {
    const text = fs.readFileSync(logPath, "utf8");
    return text === "" ? [] : text.trimEnd().split("\n").map((line) => JSON.parse(line));
  };
  return {
    directory: binDirectory,
    logPath,
    config,
    /** Merges settings into the configuration used by the next invocation. */
    set(patch) {
      Object.assign(config, patch);
      save();
    },
    /** Environment entries that put the fake first on PATH (both spellings, for Windows). */
    env(extra = {}) {
      return { PATH: searchPath, Path: searchPath, SDLC_FAKE_GH_CONFIG: configPath, ...extra };
    },
    log: readLog,
    /** The recorded invocations whose argument list starts with the given words. */
    calls: (...words) => readLog().filter((entry) => words.every((word, index) => entry.args[index] === word)),
    reset: () => fs.writeFileSync(logPath, ""),
  };
}

function request(method, url, headers) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const outgoing = http.request({ method, hostname: target.hostname, port: target.port, path: target.pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let message = "";
        try {
          message = JSON.parse(text).message ?? "";
        } catch {
          message = text;
        }
        resolve({ status: response.statusCode, message });
      });
    });
    outgoing.on("error", (error) => resolve({ status: 0, message: error.message }));
    outgoing.end();
  });
}

function stubCompile(args, settings, cwd) {
  const mode = settings.mode ?? "ok";
  const workflows = path.join(cwd, ".github", "workflows");
  const sources = fs.existsSync(workflows) ? fs.readdirSync(workflows).filter((name) => name.endsWith(".md")).sort() : [];
  const noEmit = args.includes("--no-emit");
  for (const flag of ["--strict", "--json"]) {
    if (!args.includes(flag)) {
      process.stderr.write(`stub compiler: the required flag ${flag} is missing\n`);
      return 4;
    }
  }
  if (mode === "crash") {
    process.stderr.write("panic: stub compiler crashed\n");
    return 2;
  }
  if (mode === "error") {
    process.stdout.write(
      `${JSON.stringify([{ workflow: sources[0] ?? "unknown.md", valid: false, errors: [settings.error ?? "stub compile error: network configuration is missing"], warnings: [] }])}\n`,
    );
    return 1;
  }
  if (!noEmit) {
    for (const name of sources) fs.writeFileSync(path.join(workflows, name.replace(/\.md$/, ".lock.yml")), stubLock(name, fs.readFileSync(path.join(workflows, name))));
    for (const entry of fs.existsSync(workflows) ? fs.readdirSync(workflows) : []) {
      if (entry.endsWith(".lock.yml") && !sources.includes(entry.replace(/\.lock\.yml$/, ".md"))) fs.rmSync(path.join(workflows, entry), { force: true });
    }
  }
  process.stdout.write(`${JSON.stringify(sources.map((name) => ({ workflow: name, valid: true, errors: [], warnings: [], labels: [] })))}\n`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(process.env.SDLC_FAKE_GH_CONFIG, "utf8"));
  fs.appendFileSync(config.logPath, `${JSON.stringify({ time: Date.now(), args, cwd: process.cwd(), ghToken: process.env.GH_TOKEN ?? null })}\n`);
  const [first, second] = args;
  if (first === "aw" && (second === "version" || second === "--version")) {
    process.stdout.write(config.versionOutput !== undefined ? `${config.versionOutput}\n` : `gh aw version v${config.version}\n`);
    return;
  }
  if (first === "aw" && second === "validate") {
    process.stdout.write("fake gh aw validate\n");
    process.exitCode = config.validateExit;
    return;
  }
  if (first === "aw" && second === "doctor") {
    process.stdout.write("fake gh aw doctor\n");
    process.exitCode = config.doctorExit;
    return;
  }
  if (first === "aw" && second === "compile") {
    process.exitCode = stubCompile(args, config.compile ?? {}, process.cwd());
    return;
  }
  if (first === "auth" && second === "token") {
    process.stdout.write(`${config.authToken}\n`);
    return;
  }
  if (first === "workflow" && second === "disable") {
    const workflow = args[2];
    const repo = args[args.indexOf("--repo") + 1];
    const outcome = await request("PUT", `${config.apiUrl}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/disable`, { Authorization: "Bearer operator-token-fixture" });
    if (outcome.status >= 200 && outcome.status < 300) return;
    process.stderr.write(`HTTP ${outcome.status}: ${outcome.message} (${config.apiUrl}/repos/${repo}/actions/workflows/${workflow}/disable)\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`fake gh: unexpected invocation: gh ${args.join(" ")}\n`);
  process.exitCode = 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER) await main();
